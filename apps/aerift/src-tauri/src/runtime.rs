use std::{
    collections::{BTreeMap, HashMap},
    fs::File,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, SystemTime},
};

#[cfg(windows)]
use std::{
    fs::{self, OpenOptions},
    net::Ipv4Addr,
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt},
    ptr::null_mut,
};

use aerift_peers::{Device, DiscoveredPeer, NearbyChallenge, NearbyPending, PeerNode};
#[cfg(windows)]
use aerift_peers::{Discovery, Identity, Platform};
#[cfg(windows)]
use aerift_transfer::ambient_inbox::{FrozenDelivery, Inbox};
use aerift_transfer::{
    ErrorCode, IncomingTransfer, PeerId, ReceiveLimits, Receiver, State, Status, TransferError,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
#[cfg(target_os = "android")]
use tauri_plugin_aerift_android::{DiscoveryState, DiscoveryUpdate};
#[cfg(target_os = "ios")]
use tauri_plugin_aerift_ios::{BonjourState as DiscoveryState, BonjourUpdate};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
#[cfg(windows)]
use tokio::net::TcpListener;
use tokio::sync::{watch, OnceCell};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, FILE_SHARE_READ};

use crate::selection::{FileSelection, SelectionRegistry};
#[cfg(windows)]
use crate::windows_storage::{
    lock_profile, storage_failed, ReceiveFolder, WindowsIdentity, WindowsTrust,
};

#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "android")]
use android::{disk_free, storage_failed};
#[cfg(target_os = "ios")]
mod ios;
#[cfg(target_os = "ios")]
use ios::{disk_free, storage_failed};

const MAX_RECEIPTS: usize = 256;
const RECEIVE_HEADROOM_BYTES: u64 = 256 * 1024 * 1024;
const RECEIVE_LIMITS: ReceiveLimits = ReceiveLimits {
    // The host enforces live staging capacity at approval.
    active_bytes: u64::MAX,
    session_offers: MAX_RECEIPTS,
};
const DECISION_TIMEOUT: Duration = Duration::from_secs(300);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const RECEIVER_READY_MILLIS: u64 = 45_000;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PeerView {
    #[serde(flatten)]
    device: Device,
    paired: bool,
    online: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingView {
    request_id: Uuid,
    device: PeerView,
    expires_at: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NearbyPairingView {
    request_id: Uuid,
    device: PeerView,
    expires_at: String,
    verification: String,
    #[serde(skip_serializing_if = "is_false")]
    outgoing: bool,
    approved: bool,
}
fn is_false(value: &bool) -> bool {
    !value
}
fn nearby_pairing_view(pending: &NearbyPending, outgoing: bool) -> Option<NearbyPairingView> {
    Some(NearbyPairingView {
        request_id: pending.id,
        device: PeerView {
            device: pending.device.clone(),
            paired: false,
            online: true,
        },
        expires_at: timestamp(pending.expires_at).ok()?,
        verification: pending.verification.clone(),
        outgoing,
        approved: pending.approved,
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileView {
    name: String,
    size_bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
enum Direction {
    Incoming,
    Outgoing,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransferView {
    id: String,
    interaction_id: Uuid,
    device_id: PeerId,
    direction: Direction,
    file: FileView,
    #[serde(flatten)]
    status: Status,
}

/// The preview may see visual phases only, not file/device/authorization fields.
#[cfg(windows)]
#[derive(Clone, PartialEq, Serialize)]
pub(crate) struct AmbientTransferProjection {
    version: u8,
    interaction: Uuid,
    sequence: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    count: Option<usize>,
    phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    progress: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    verified: Option<bool>,
}
#[cfg(windows)]
impl AmbientTransferProjection {
    fn from_transfer(transfer: &TransferView) -> Option<Self> {
        let incoming = matches!(transfer.direction, Direction::Incoming);
        let state = transfer.status.state;
        let phase = match state {
            State::Pending if incoming => "awaiting-acceptance",
            State::Pending => "offering",
            State::Accepted => "awaiting-acceptance",
            State::Transferring if incoming => "receiving",
            State::Transferring => "transferring",
            State::Completed => "completed",
            State::Cancelled => "cancelled",
            State::Rejected => "rejected",
            State::Failed => "failed",
        };
        // The transport's Completed is set only after the verified publish or
        // authenticated completion acknowledgement. Do not infer it from progress.
        let verified = state == State::Completed;
        let bytes = transfer.status.bytes_transferred;
        let size = transfer.file.size_bytes;
        if bytes > size || (verified && (bytes != size || transfer.status.error.is_some())) {
            return None;
        }
        let progress = (state == State::Transferring).then(|| {
            if size == 0 {
                1.0
            } else {
                bytes as f64 / size as f64
            }
        });
        let sequence = match phase {
            "offering" => 1000,
            "awaiting-acceptance" => 2000,
            "transferring" | "receiving" => 3000 + (progress.unwrap_or(0.0) * 999.0) as u32,
            _ => 4000,
        };
        Some(Self {
            version: 1,
            interaction: transfer.interaction_id,
            sequence,
            count: None,
            phase,
            progress,
            verified: verified.then_some(true),
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppSnapshot {
    version: u8,
    devices: Vec<PeerView>,
    transfers: Vec<TransferView>,
    pending_pairing: Vec<PairingView>,
    nearby_pairing_incoming: Option<NearbyPairingView>,
    nearby_pairing_outgoing: Option<NearbyPairingView>,
    nearby_verification: bool,
    #[cfg(any(target_os = "ios", target_os = "android"))]
    local_network: DiscoveryState,
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum PairRequest {
    StartNearby {
        device_id: PeerId,
    },
    ConfirmNearby {
        request_id: Uuid,
        accept: bool,
        outgoing: bool,
    },
    Create,
    Redeem {
        code: String,
    },
    Confirm {
        request_id: Uuid,
        accept: bool,
    },
    Revoke {
        device_id: PeerId,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InvitationView {
    code: String,
    expires_at: String,
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub(crate) enum PairResult {
    Invitation { invitation: InvitationView },
    Paired { device: PeerView },
    Rejected,
    Revoked,
    NearbyStarted,
    NearbyWaiting,
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum TransferRequest {
    Offer {
        device_id: PeerId,
        selection_id: String,
    },
    Respond {
        transfer_id: String,
        accept: bool,
    },
    #[cfg(windows)]
    RespondToInbox {
        transfer_id: String,
        accept: bool,
    },
    Cancel {
        transfer_id: String,
    },
}

#[cfg(windows)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderView {
    active: Option<String>,
    next: Option<String>,
}

struct Outgoing {
    view: TransferView,
    cancel: CancellationToken,
}

#[derive(Default)]
struct LiveState {
    peers: Vec<DiscoveredPeer>,
    nearby_outgoing: Option<NearbyChallenge>,
    outgoing: Vec<Outgoing>,
    #[cfg(any(target_os = "ios", target_os = "android"))]
    local_network: Option<DiscoveryState>,
}

pub(crate) struct AppRuntime {
    #[cfg(windows)]
    nearby_enabled: std::sync::OnceLock<bool>,
    session: OnceCell<Arc<Session>>,
    stop: CancellationToken,
    subscriptions: Arc<Mutex<HashMap<Uuid, CancellationToken>>>,
    #[cfg(windows)]
    ambient_watch: Mutex<Option<CancellationToken>>,
}

impl Default for AppRuntime {
    fn default() -> Self {
        Self {
            #[cfg(windows)]
            nearby_enabled: std::sync::OnceLock::new(),
            session: OnceCell::new(),
            stop: CancellationToken::new(),
            subscriptions: Arc::new(Mutex::new(HashMap::new())),
            #[cfg(windows)]
            ambient_watch: Mutex::default(),
        }
    }
}

pub(crate) struct Session {
    #[cfg(any(all(test, windows), target_os = "ios", target_os = "android"))]
    port: u16,
    #[cfg(all(test, windows))]
    root: PathBuf,
    destination: PathBuf,
    #[cfg(windows)]
    _profile_lock: File,
    #[cfg(windows)]
    inbox: Option<Arc<Inbox>>,
    #[cfg(windows)]
    a4_ambient: Mutex<Option<crate::ambient_runtime::AmbientRuntime>>,
    #[cfg(windows)]
    a4_projection: watch::Sender<Option<AmbientTransferProjection>>,
    #[cfg(any(target_os = "ios", target_os = "android"))]
    discovery_start: tokio::sync::Mutex<()>,
    #[cfg(target_os = "ios")]
    discovery_events: std::sync::OnceLock<Channel<BonjourUpdate>>,
    #[cfg(target_os = "android")]
    discovery_events: std::sync::OnceLock<Channel<DiscoveryUpdate>>,
    peer: Arc<PeerNode>,
    receiver: Arc<Receiver>,
    state: Mutex<LiveState>,
    receive_approvals: Mutex<()>,
    nearby_initiation: tokio::sync::Mutex<()>,
    changes: watch::Sender<u64>,
    stop: CancellationToken,
}

impl AppRuntime {
    #[cfg(windows)]
    pub(crate) fn configure_nearby(&self, enabled: bool) {
        let _ = self.nearby_enabled.set(enabled);
    }

    #[cfg(windows)]
    pub(crate) fn nearby_enabled(&self) -> bool {
        self.nearby_enabled.get().copied() == Some(true)
    }

    #[cfg(windows)]
    pub(crate) async fn session(&self, root: PathBuf) -> Result<Arc<Session>, TransferError> {
        if !self.nearby_enabled() {
            return Err(ErrorCode::PeerUnavailable.into());
        }
        self.session
            .get_or_try_init(|| Session::open(root, self.stop.child_token(), true))
            .await
            .map(Arc::clone)
    }

    #[cfg(target_os = "ios")]
    pub(crate) async fn ios_session(
        &self,
        app: &tauri::AppHandle,
    ) -> Result<Arc<Session>, TransferError> {
        self.session
            .get_or_try_init(|| Session::open_ios(app, self.stop.child_token()))
            .await
            .map(Arc::clone)
    }

    #[cfg(target_os = "android")]
    pub(crate) async fn android_session(
        &self,
        app: &tauri::AppHandle,
    ) -> Result<Arc<Session>, TransferError> {
        self.session
            .get_or_try_init(|| Session::open_android(app, self.stop.child_token()))
            .await
            .map(Arc::clone)
    }

    pub(crate) fn watch(
        &self,
        session: Arc<Session>,
        updates: Channel<AppSnapshot>,
    ) -> Result<Uuid, TransferError> {
        let mut changed = session.changes.subscribe();
        let mut incoming = session.receiver.subscribe();
        let mut pairing = session.peer.pairing().subscribe();
        let mut nearby = session.peer.subscribe_nearby();
        let id = Uuid::new_v4();
        let stop = session.stop.child_token();
        updates
            .send(session.snapshot())
            .map_err(|_| ErrorCode::InternalError)?;
        lock(&self.subscriptions).insert(id, stop.clone());
        let subscriptions = Arc::clone(&self.subscriptions);
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    _ = stop.cancelled() => break,
                    result = changed.changed() => if result.is_err() { break },
                    result = incoming.changed() => if result.is_err() { break },
                    result = pairing.changed() => if result.is_err() { break },
                    result = nearby.changed() => if result.is_err() { break },
                }
                // Stream several chunks between UI paints. Terminal receipts remain in the snapshot.
                tokio::time::sleep(Duration::from_millis(80)).await;
                if stop.is_cancelled() || updates.send(session.snapshot()).is_err() {
                    break;
                }
            }
            lock(&subscriptions).remove(&id);
        });
        Ok(id)
    }

    pub(crate) fn unwatch(&self, id: Uuid) {
        if let Some(stop) = lock(&self.subscriptions).remove(&id) {
            stop.cancel();
        }
    }

    #[cfg(windows)]
    pub(crate) fn desktop_transfer_projection(
        &self,
        interaction: Option<Uuid>,
    ) -> Option<AmbientTransferProjection> {
        let session = self.session.get()?;
        let source = session.a4_projection.borrow();
        source
            .as_ref()
            .filter(|f| interaction.is_none_or(|id| f.interaction == id))
            .cloned()
            .or_else(|| session.ambient_projection(interaction))
    }

    #[cfg(windows)]
    pub(crate) fn watch_ambient_projection(
        &self,
        window: tauri::WebviewWindow,
        updates: Channel<Option<AmbientTransferProjection>>,
    ) {
        use tauri::WindowEvent;
        let Some(session) = self.session.get().cloned() else {
            let _ = updates.send(None);
            return;
        };
        let stop = session.stop.child_token();
        if let Some(previous) = lock(&self.ambient_watch).replace(stop.clone()) {
            previous.cancel();
        }
        let on_destroy = stop.clone();
        window.on_window_event(move |event| {
            if matches!(event, WindowEvent::Destroyed) {
                on_destroy.cancel();
            }
        });
        let mut changed = session.changes.subscribe();
        let mut incoming = session.receiver.subscribe();
        let mut a4 = session.a4_projection.subscribe();
        tauri::async_runtime::spawn(async move {
            let initial_a4 = a4.borrow_and_update().clone();
            let a4_epoch = initial_a4.as_ref().map(|frame| frame.interaction);
            let mut previous = initial_a4.or_else(|| session.ambient_projection(None));
            if updates.send(previous.clone()).is_err() || previous.is_none() {
                if !stop.is_cancelled() {
                    let _ = window.destroy();
                }
                return;
            }
            let interaction = previous.as_ref().map(|frame| frame.interaction);
            loop {
                tokio::select! {
                    biased;
                    _ = stop.cancelled() => break,
                    result = changed.changed() => if result.is_err() { break },
                    result = incoming.changed() => if result.is_err() { break },
                    result = a4.changed(), if a4_epoch.is_some() => if result.is_err() { break },
                }
                // Coalesce transport chunks without polling or delaying the transfer.
                tokio::time::sleep(Duration::from_millis(80)).await;
                if stop.is_cancelled() {
                    break;
                }
                let current = if let Some(epoch) = a4_epoch {
                    a4.borrow_and_update()
                        .as_ref()
                        .filter(|f| f.interaction == epoch)
                        .cloned()
                } else {
                    session.ambient_projection(interaction)
                };
                if current == previous {
                    continue;
                }
                if updates.send(current.clone()).is_err() {
                    break;
                }
                let terminal = current.as_ref().is_none_or(|f| {
                    matches!(
                        f.phase,
                        "completed"
                            | "cancelled"
                            | "expired"
                            | "rejected"
                            | "disconnected"
                            | "interrupted"
                            | "failed"
                    )
                });
                if terminal {
                    // This tail is visual only. Nothing waits for the observer.
                    tokio::select! {
                        _ = stop.cancelled() => {},
                        _ = tokio::time::sleep(Duration::from_millis(1150)) => {},
                    }
                    break;
                }
                previous = current;
            }
            if !stop.is_cancelled() {
                let _ = window.destroy();
            }
        });
    }

    #[cfg(windows)]
    pub(crate) fn receive_directory(&self) -> Option<PathBuf> {
        self.session
            .get()
            .map(|session| session.destination.clone())
    }

    pub(crate) fn shutdown(&self) {
        self.stop.cancel();
    }
}

impl Session {
    #[cfg(windows)]
    async fn open(
        root: PathBuf,
        stop: CancellationToken,
        lan_discovery: bool,
    ) -> Result<Arc<Self>, TransferError> {
        let prepare_root = root.clone();
        let (profile_lock, destination, peer, receiver, inbox) =
            tauri::async_runtime::spawn_blocking(move || {
                let profile_lock = lock_profile(&prepare_root)?;
                let destination = match ReceiveFolder::new(&prepare_root).load()? {
                    Some(path) => path,
                    None => {
                        let path = prepare_root.join("Received");
                        fs::create_dir_all(&path).map_err(storage_failed)?;
                        path
                    }
                };
                let destination = fs::canonicalize(destination).map_err(storage_failed)?;
                disk_free(&destination)?;
                let receiver = Arc::new(Receiver::new(&destination, RECEIVE_LIMITS)?);
                let identity = Identity::load_or_create(&WindowsIdentity::new(&prepare_root))?;
                let trust = Arc::new(WindowsTrust::new(&prepare_root));
                // A generic label avoids advertising the user's Windows account or machine hostname.
                let peer = Arc::new(PeerNode::new(
                    identity,
                    "AeRift on Windows".into(),
                    Platform::Windows,
                    trust,
                    Arc::clone(&receiver),
                )?);
                let inbox_root = prepare_root.join("AmbientInbox");
                let inbox = fs::create_dir_all(&inbox_root)
                    .map_err(storage_failed)
                    .and_then(|_| {
                        Inbox::open_sealed(
                            &inbox_root,
                            Arc::new(crate::protected_store::InboxReceiptProtection),
                        )
                    })
                    .ok()
                    .map(Arc::new);
                Ok::<_, TransferError>((profile_lock, destination, peer, receiver, inbox))
            })
            .await
            .map_err(|_| ErrorCode::InternalError)??;

        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
            .await
            .map_err(|_| ErrorCode::NetworkError)?;
        let port = listener
            .local_addr()
            .map_err(|_| ErrorCode::NetworkError)?
            .port();
        let discovery = lan_discovery
            .then(|| Discovery::start(peer.pairing().device(), port))
            .transpose()?;
        let session = Arc::new(Self {
            #[cfg(test)]
            port,
            #[cfg(test)]
            root,
            destination,
            _profile_lock: profile_lock,
            inbox,
            peer,
            receiver,
            #[cfg(windows)]
            a4_ambient: Mutex::new(None),
            #[cfg(windows)]
            a4_projection: watch::channel(None).0,
            receive_approvals: Mutex::new(()),
            nearby_initiation: tokio::sync::Mutex::new(()),
            state: Mutex::new(LiveState {
                peers: discovery
                    .as_ref()
                    .map_or_else(Vec::new, Discovery::snapshot),
                ..LiveState::default()
            }),
            changes: watch::channel(0).0,
            stop,
        });
        let active = Arc::clone(&session);
        tauri::async_runtime::spawn(async move {
            let browse = async {
                let Some(mut discovery) = discovery else {
                    return std::future::pending::<()>().await;
                };
                while let Ok(peers) = discovery.changed().await {
                    lock(&active.state).peers = peers;
                    active.changed();
                }
            };
            let discovery_scope = Arc::downgrade(&active);
            let is_nearby = move |id, source| {
                discovery_scope
                    .upgrade()
                    .is_some_and(|session| session.nearby_source(id, source))
            };
            #[cfg(windows)]
            let serving = {
                let ambient_scope = Arc::downgrade(&active);
                active.peer.serve_with_nearby_ambient(
                    listener,
                    active.stop.clone(),
                    is_nearby,
                    Arc::new(move || {
                        let session = ambient_scope.upgrade()?;
                        let runtime = lock(&session.a4_ambient).clone()?;
                        runtime.a4_for_nearby().ok()?.source()
                    }),
                )
            };
            #[cfg(not(windows))]
            let serving = active
                .peer
                .serve_with_nearby(listener, active.stop.clone(), is_nearby);
            tokio::select! {
                _ = serving => {},
                _ = browse => {},
            }
            lock(&active.state).peers.clear();
            active.changed();
        });
        Ok(session)
    }

    #[cfg(windows)]
    fn ambient_projection(&self, interaction: Option<Uuid>) -> Option<AmbientTransferProjection> {
        let transfers = self.snapshot().transfers;
        let mut matching = transfers.iter().filter(|transfer| match interaction {
            Some(id) => transfer.interaction_id == id,
            None => !transfer.status.state.is_terminal(),
        });
        let transfer = matching.next()?;
        // IDs are peer-scoped on the wire. Never resolve an ambiguous epoch.
        if matching.next().is_some() {
            return None;
        }
        AmbientTransferProjection::from_transfer(transfer)
    }

    fn changed(&self) {
        self.changes
            .send_modify(|value| *value = value.wrapping_add(1));
    }

    fn snapshot(&self) -> AppSnapshot {
        let state = lock(&self.state);
        let pairing = self.peer.pairing();
        let mut devices = BTreeMap::new();
        for peer in &state.peers {
            devices.insert(
                peer.device.id.to_string(),
                PeerView {
                    device: peer.device.clone(),
                    paired: false,
                    online: peer.endpoints.iter().any(SocketAddr::is_ipv4),
                },
            );
        }
        for device in pairing.trusted_devices() {
            let id = device.id.to_string();
            let online = devices.get(&id).is_some_and(|peer| peer.online);
            devices.insert(
                id,
                PeerView {
                    device,
                    paired: true,
                    online,
                },
            );
        }

        let pending_pairing = pairing
            .subscribe()
            .borrow()
            .clone()
            .and_then(|pending| {
                Some(PairingView {
                    request_id: pending.id,
                    expires_at: timestamp(pending.expires_at).ok()?,
                    device: PeerView {
                        device: pending.device,
                        paired: false,
                        online: true,
                    },
                })
            })
            .into_iter()
            .collect();
        let mut incoming: Vec<_> = self.receiver.snapshot().iter().map(incoming_view).collect();
        incoming.sort_by(|left, right| left.id.cmp(&right.id));
        let transfers = state
            .outgoing
            .iter()
            .rev()
            .map(|entry| entry.view.clone())
            .chain(incoming)
            .collect();
        AppSnapshot {
            version: 1,
            devices: devices.into_values().collect(),
            transfers,
            pending_pairing,
            nearby_pairing_incoming: self
                .peer
                .subscribe_nearby()
                .borrow()
                .as_ref()
                .and_then(|pending| nearby_pairing_view(pending, false)),
            nearby_pairing_outgoing: state
                .nearby_outgoing
                .as_ref()
                .and_then(|pending| nearby_pairing_view(pending, true)),
            nearby_verification: true,
            #[cfg(any(target_os = "ios", target_os = "android"))]
            local_network: state.local_network.unwrap_or(DiscoveryState::Disabled),
        }
    }

    fn endpoint(&self, id: PeerId) -> Result<SocketAddr, TransferError> {
        lock(&self.state)
            .peers
            .iter()
            .find(|peer| peer.device.id == id)
            .and_then(|peer| peer.endpoints.iter().find(|addr| addr.is_ipv4()).copied())
            .ok_or_else(|| ErrorCode::PeerUnavailable.into())
    }

    fn nearby_source(&self, id: PeerId, source: SocketAddr) -> bool {
        let state = lock(&self.state);
        #[cfg(any(target_os = "ios", target_os = "android"))]
        if !matches!(state.local_network, Some(DiscoveryState::Ready)) {
            return false;
        }
        source.is_ipv4()
            && state.peers.iter().any(|peer| {
                peer.device.id == id
                    && peer
                        .endpoints
                        .iter()
                        .any(|endpoint| endpoint.ip() == source.ip())
            })
    }

    #[cfg(windows)]
    pub(crate) fn publish_a4_projection(&self, frame: aerift_transfer::ambient::session::Frame) {
        let (interaction, sequence, phase, count, progress, verified) = frame.projection();
        self.a4_projection.send_if_modified(|current| {
            if sequence != 1
                && current
                    .as_ref()
                    .is_none_or(|f| f.interaction != interaction || f.sequence >= sequence)
            {
                return false;
            }
            *current = Some(AmbientTransferProjection {
                version: 1,
                interaction,
                sequence,
                count: Some(count),
                phase,
                progress,
                verified,
            });
            true
        });
    }

    #[cfg(windows)]
    pub(crate) fn clear_a4_projection(&self, interaction: Uuid) {
        self.a4_projection.send_if_modified(|current| {
            if current
                .as_ref()
                .is_some_and(|frame| frame.interaction == interaction)
            {
                *current = None;
                true
            } else {
                false
            }
        });
    }

    #[cfg(windows)]
    pub(crate) async fn send_a4(
        self: &Arc<Self>,
        dispatch: aerift_transfer::ambient::nearby_runtime::NativeDispatch,
    ) -> Result<Status, TransferError> {
        let (interaction_id, device_id, name, size_bytes) = dispatch.receipt_source();
        let id = interaction_id.to_string();
        let view = TransferView {
            id: id.clone(),
            interaction_id,
            device_id,
            direction: Direction::Outgoing,
            file: FileView { name, size_bytes },
            status: Status {
                state: State::Pending,
                bytes_transferred: 0,
                error: None,
            },
        };
        {
            let mut state = lock(&self.state);
            if state.outgoing.len() >= MAX_RECEIPTS {
                let oldest = state
                    .outgoing
                    .iter()
                    .position(|entry| entry.view.status.state.is_terminal())
                    .ok_or(ErrorCode::Conflict)?;
                state.outgoing.remove(oldest);
            }
            state.outgoing.push(Outgoing {
                view,
                cancel: dispatch.cancellation(),
            });
        }
        self.changed();
        let visual = self.clone();
        let receipt = self.clone();
        let receipt_id = id.clone();
        let result = dispatch
            .send_observed(
                self.as_ref(),
                |peer, _| self.a4_sender(peer).ok(),
                move |frame| visual.publish_a4_projection(frame),
                move |_, status| receipt.outgoing_update(&receipt_id, Ok(status)),
            )
            .await;
        self.outgoing_update(&id, result);
        result
    }

    #[cfg(windows)]
    pub(crate) fn attach_a4(&self, runtime: crate::ambient_runtime::AmbientRuntime) {
        *lock(&self.a4_ambient) = Some(runtime);
    }

    #[cfg(windows)]
    pub(crate) fn a4_sender(
        &self,
        peer: PeerId,
    ) -> Result<aerift_transfer::Sender<aerift_peers::PinnedEndpoint>, TransferError> {
        self.peer
            .sender(self.endpoint(peer)?, peer, DECISION_TIMEOUT, UPLOAD_TIMEOUT)
    }

    #[cfg(windows)]
    pub(crate) fn a4_roster(
        &self,
    ) -> Result<
        Vec<(
            PeerId,
            aerift_transfer::Sender<aerift_peers::PinnedEndpoint>,
        )>,
        TransferError,
    > {
        let identities: std::collections::BTreeSet<_> = lock(&self.state)
            .peers
            .iter()
            .filter(|entry| entry.endpoints.iter().any(|addr| addr.is_ipv4()))
            .map(|entry| entry.device.id.to_string())
            .collect();
        let mut roster = Vec::new();
        for identity in identities {
            let peer = identity.parse()?;
            match self.a4_sender(peer) {
                Ok(sender) => roster.push((peer, sender)),
                Err(err) if err.code == ErrorCode::PeerUntrusted => continue,
                Err(err) => return Err(err),
            }
            if roster.len() > 16 {
                return Err(ErrorCode::Conflict.into());
            }
        }
        Ok(roster)
    }

    fn paired_view(&self, device: Device) -> PairResult {
        let online = self.endpoint(device.id).is_ok();
        PairResult::Paired {
            device: PeerView {
                device,
                paired: true,
                online,
            },
        }
    }

    pub(crate) async fn pair(
        self: &Arc<Self>,
        request: PairRequest,
    ) -> Result<PairResult, TransferError> {
        let result = match request {
            PairRequest::StartNearby { device_id } => {
                let _start = self
                    .nearby_initiation
                    .try_lock()
                    .map_err(|_| ErrorCode::PairingRejected)?;
                let endpoint = self.endpoint(device_id)?;
                if lock(&self.state).nearby_outgoing.is_some()
                    || !self.nearby_source(device_id, endpoint)
                {
                    return Err(ErrorCode::PairingRejected.into());
                }
                let pending = self.peer.begin_nearby(endpoint, device_id).await?;
                if !self.nearby_source(device_id, endpoint) {
                    let _ = self.peer.finish_nearby(pending, false).await;
                    return Err(ErrorCode::PeerUnavailable.into());
                }
                let id = pending.id;
                let wait = pending
                    .expires_at
                    .duration_since(SystemTime::now())
                    .unwrap_or_default();
                lock(&self.state).nearby_outgoing = Some(pending);
                let session = Arc::downgrade(self);
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(wait).await;
                    if let Some(session) = session.upgrade() {
                        let mut state = lock(&session.state);
                        if state
                            .nearby_outgoing
                            .as_ref()
                            .is_some_and(|pending| pending.id == id)
                        {
                            state.nearby_outgoing = None;
                            drop(state);
                            session.changed();
                        }
                    }
                });
                PairResult::NearbyStarted
            }
            PairRequest::ConfirmNearby {
                request_id,
                accept,
                outgoing,
            } => {
                if outgoing {
                    let _confirm = self
                        .nearby_initiation
                        .try_lock()
                        .map_err(|_| ErrorCode::PairingRejected)?;
                    let pending = lock(&self.state)
                        .nearby_outgoing
                        .as_ref()
                        .filter(|pending| pending.id == request_id)
                        .cloned()
                        .ok_or(ErrorCode::PairingExpired)?;
                    let outcome = async {
                        let endpoint = self.endpoint(pending.device.id)?;
                        if !pending.matches_endpoint(endpoint)
                            || !self.nearby_source(pending.device.id, endpoint)
                        {
                            return Err(ErrorCode::PeerUnavailable.into());
                        }
                        self.peer.finish_nearby(pending, accept).await
                    }
                    .await;
                    {
                        let mut state = lock(&self.state);
                        if state
                            .nearby_outgoing
                            .as_ref()
                            .is_some_and(|pending| pending.id == request_id)
                        {
                            state.nearby_outgoing = None;
                        }
                    }
                    self.changed();
                    match outcome? {
                        Some(device) => self.paired_view(device),
                        None => PairResult::Rejected,
                    }
                } else {
                    if accept {
                        // Serialize approval against native discovery readiness changes;
                        // declining a stale prompt remains safe at any time.
                        let state = lock(&self.state);
                        #[cfg(any(target_os = "ios", target_os = "android"))]
                        if !matches!(state.local_network, Some(DiscoveryState::Ready)) {
                            return Err(ErrorCode::PeerUnavailable.into());
                        }
                        let pending = self
                            .peer
                            .subscribe_nearby()
                            .borrow()
                            .clone()
                            .filter(|entry| entry.id == request_id)
                            .ok_or(ErrorCode::PairingExpired)?;
                        if !state.peers.iter().any(|peer| {
                            peer.device.id == pending.device.id
                                && peer.endpoints.iter().any(|address| address.is_ipv4())
                        }) {
                            return Err(ErrorCode::PeerUnavailable.into());
                        }
                        self.peer.confirm_nearby(request_id, true)?;
                    } else {
                        self.peer.confirm_nearby(request_id, false)?;
                    }
                    if accept {
                        PairResult::NearbyWaiting
                    } else {
                        PairResult::Rejected
                    }
                }
            }
            PairRequest::Create => {
                let invitation = self.peer.pairing().create_invitation()?;
                PairResult::Invitation {
                    invitation: InvitationView {
                        code: invitation.code,
                        expires_at: timestamp(invitation.expires_at)?,
                    },
                }
            }
            PairRequest::Redeem { code } => {
                let id = PeerNode::invitation_peer(&code)?;
                let device = self.peer.redeem(self.endpoint(id)?, &code).await?;
                self.paired_view(device)
            }
            PairRequest::Confirm { request_id, accept } => {
                let peer = Arc::clone(&self.peer);
                let approved = tauri::async_runtime::spawn_blocking(move || {
                    let pairing = peer.pairing();
                    let pending = pairing
                        .subscribe()
                        .borrow()
                        .clone()
                        .filter(|pending| pending.id == request_id)
                        .ok_or(ErrorCode::PairingExpired)?;
                    pairing.confirm(request_id, accept)?;
                    Ok::<_, TransferError>(pending.device)
                })
                .await
                .map_err(|_| ErrorCode::InternalError)??;
                if accept {
                    self.paired_view(approved)
                } else {
                    PairResult::Rejected
                }
            }
            PairRequest::Revoke { device_id } => {
                let peer = Arc::clone(&self.peer);
                tauri::async_runtime::spawn_blocking(move || peer.revoke(device_id))
                    .await
                    .map_err(|_| ErrorCode::InternalError)??;
                PairResult::Revoked
            }
        };
        self.changed();
        Ok(result)
    }

    pub(crate) async fn transfer(
        self: &Arc<Self>,
        selection: &SelectionRegistry,
        request: TransferRequest,
    ) -> Result<TransferView, TransferError> {
        match request {
            TransferRequest::Offer {
                device_id,
                selection_id,
            } => self.offer(selection, device_id, &selection_id).await,
            TransferRequest::Respond {
                transfer_id,
                accept,
            } => self.respond(&transfer_id, accept),
            #[cfg(windows)]
            TransferRequest::RespondToInbox {
                transfer_id,
                accept,
            } => {
                if !accept {
                    return Err(ErrorCode::InvalidRequest.into());
                }
                self.respond_to_inbox(&transfer_id)
            }
            TransferRequest::Cancel { transfer_id } => self.cancel(&transfer_id),
        }
    }

    pub(crate) fn set_receiver_ready(&self, ready: bool) -> Result<u64, TransferError> {
        // Serialize against the native suspension callback so an in-flight
        // webview command cannot reopen a cleared background lease.
        #[cfg(any(target_os = "ios", target_os = "android"))]
        let state = lock(&self.state);
        #[cfg(target_os = "ios")]
        if ready && matches!(state.local_network, Some(DiscoveryState::Suspended)) {
            return Err(ErrorCode::PeerUnavailable.into());
        }
        #[cfg(target_os = "android")]
        if ready && !matches!(state.local_network, Some(DiscoveryState::Ready)) {
            return Err(ErrorCode::PeerUnavailable.into());
        }
        let deadline = ready
            .then(|| tokio::time::Instant::now() + Duration::from_millis(RECEIVER_READY_MILLIS));
        self.receiver.set_ready_until(deadline);
        Ok(if ready { RECEIVER_READY_MILLIS } else { 0 })
    }

    pub(crate) async fn check_receiver(&self, device_id: PeerId) -> Result<bool, TransferError> {
        self.peer
            .sender(
                self.endpoint(device_id)?,
                device_id,
                DECISION_TIMEOUT,
                UPLOAD_TIMEOUT,
            )?
            .receiver_ready()
            .await
    }

    async fn offer(
        self: &Arc<Self>,
        registry: &SelectionRegistry,
        device_id: PeerId,
        selection_id: &str,
    ) -> Result<TransferView, TransferError> {
        let sender = self.peer.sender(
            self.endpoint(device_id)?,
            device_id,
            DECISION_TIMEOUT,
            UPLOAD_TIMEOUT,
        )?;
        let (details, source) = registry
            .lookup(selection_id)
            .ok_or(ErrorCode::InvalidRequest)?;
        let opened_path = source.path.clone();
        let opened =
            tauri::async_runtime::spawn_blocking(move || open_source(&opened_path, details))
                .await
                .map_err(|_| ErrorCode::InternalError)??;
        let (hold, file) = opened;
        let interaction_id = Uuid::new_v4();
        let id = interaction_id.to_string();
        let view = TransferView {
            id: id.clone(),
            interaction_id,
            device_id,
            direction: Direction::Outgoing,
            file,
            status: Status {
                state: State::Pending,
                bytes_transferred: 0,
                error: None,
            },
        };
        let cancel = self.stop.child_token();
        {
            let mut state = lock(&self.state);
            // Hashing/file preparation yields across a native lifecycle change.
            // Check under the same lock the suspension callback uses to cancel.
            #[cfg(target_os = "android")]
            if !matches!(state.local_network, Some(DiscoveryState::Ready)) {
                return Err(ErrorCode::PeerUnavailable.into());
            }
            if state.outgoing.len() == MAX_RECEIPTS {
                let oldest = state
                    .outgoing
                    .iter()
                    .position(|entry| entry.view.status.state.is_terminal())
                    .ok_or(ErrorCode::Conflict)?;
                state.outgoing.remove(oldest);
            }
            if !registry.consume(selection_id)? {
                return Err(ErrorCode::InvalidRequest.into());
            }
            state.outgoing.push(Outgoing {
                view: view.clone(),
                cancel: cancel.clone(),
            });
        }
        self.changed();
        let active = Arc::clone(self);
        let name = view.file.name.clone();
        tauri::async_runtime::spawn(async move {
            let callback = Arc::clone(&active);
            let receipt_id = id.clone();
            let result = sender
                .send_file_with_id(
                    interaction_id,
                    &source.path,
                    &name,
                    cancel,
                    move |_, status| {
                        callback.outgoing_update(&receipt_id, Ok(status));
                    },
                )
                .await;
            active.outgoing_update(&id, result);
            drop(hold);
            drop(source);
        });
        Ok(view)
    }

    #[cfg(windows)]
    pub(crate) fn offer_ambient_file(
        self: &Arc<Self>,
        device_id: PeerId,
        capture: Arc<aerift_transfer::ambient::FrozenCapture>,
    ) -> Result<TransferView, TransferError> {
        let sender = self.peer.sender(
            self.endpoint(device_id)?,
            device_id,
            DECISION_TIMEOUT,
            UPLOAD_TIMEOUT,
        )?;
        let manifest = capture
            .entries()
            .first()
            .ok_or(ErrorCode::InvalidRequest)?
            .manifest();
        let interaction_id = Uuid::new_v4();
        let id = interaction_id.to_string();
        let view = TransferView {
            id: id.clone(),
            interaction_id,
            device_id,
            direction: Direction::Outgoing,
            file: FileView {
                name: manifest.title.clone(),
                size_bytes: manifest.size,
            },
            status: Status {
                state: State::Pending,
                bytes_transferred: 0,
                error: None,
            },
        };
        let cancel = self.stop.child_token();
        {
            let mut state = lock(&self.state);
            if state.outgoing.len() == MAX_RECEIPTS {
                let oldest = state
                    .outgoing
                    .iter()
                    .position(|entry| entry.view.status.state.is_terminal())
                    .ok_or(ErrorCode::Conflict)?;
                state.outgoing.remove(oldest);
            }
            state.outgoing.push(Outgoing {
                view: view.clone(),
                cancel: cancel.clone(),
            });
        }
        self.changed();
        let active = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let callback = Arc::clone(&active);
            let receipt_id = id.clone();
            let result = sender
                .send_frozen_file_with_id(interaction_id, capture, cancel, move |_, status| {
                    callback.outgoing_update(&receipt_id, Ok(status));
                })
                .await;
            active.outgoing_update(&id, result);
        });
        Ok(view)
    }

    fn outgoing_update(&self, id: &str, result: Result<Status, TransferError>) {
        let mut state = lock(&self.state);
        if let Some(entry) = state.outgoing.iter_mut().find(|entry| entry.view.id == id) {
            let current = entry.view.status;
            if current.state.is_terminal() {
                return;
            }
            entry.view.status = match result {
                Ok(status) => status,
                Err(error) if error.code == ErrorCode::Cancelled => Status {
                    state: State::Cancelled,
                    error: None,
                    ..current
                },
                Err(error) => Status {
                    state: State::Failed,
                    error: Some(error),
                    ..current
                },
            };
            self.changed();
        }
    }

    fn respond(&self, id: &str, accept: bool) -> Result<TransferView, TransferError> {
        #[cfg(target_os = "android")]
        let _foreground = if accept {
            let state = lock(&self.state);
            if !matches!(state.local_network, Some(DiscoveryState::Ready)) {
                return Err(ErrorCode::PeerUnavailable.into());
            }
            Some(state)
        } else {
            None
        };
        self.respond_with_capacity(id, accept, disk_free)
    }

    fn respond_with_capacity(
        &self,
        id: &str,
        accept: bool,
        available: impl FnOnce(&Path) -> Result<u64, TransferError>,
    ) -> Result<TransferView, TransferError> {
        self.respond_at(
            id,
            accept,
            self.receiver.staging_directory(),
            available,
            |receiver, key| receiver.respond(key, accept),
        )
    }

    #[cfg(windows)]
    pub(crate) fn inbox(&self) -> Result<Arc<Inbox>, TransferError> {
        self.inbox
            .clone()
            .ok_or_else(|| ErrorCode::StorageFailed.into())
    }

    #[cfg(windows)]
    fn respond_to_inbox(&self, id: &str) -> Result<TransferView, TransferError> {
        let inbox = self.inbox()?;
        self.respond_at(
            id,
            true,
            inbox.storage_directory(),
            disk_free,
            |receiver, key| receiver.respond_to_inbox(key, inbox.clone(), FrozenDelivery::Inbox),
        )
    }

    fn respond_at(
        &self,
        id: &str,
        accept: bool,
        staging: &Path,
        available: impl FnOnce(&Path) -> Result<u64, TransferError>,
        approve: impl FnOnce(&Receiver, aerift_transfer::TransferKey) -> Result<Status, TransferError>,
    ) -> Result<TransferView, TransferError> {
        // Hold the same lock through the capacity check and the receiver reservation.
        let _approval = lock(&self.receive_approvals);
        let transfers = self.receiver.snapshot();
        let entry = transfers
            .iter()
            .find(|entry| incoming_id(entry) == id)
            .ok_or(ErrorCode::PeerUnavailable)?;
        if accept && entry.status.state == State::Pending {
            let remaining = transfers
                .iter()
                .filter(|entry| matches!(entry.status.state, State::Accepted | State::Transferring))
                .map(|entry| {
                    entry
                        .offer
                        .size_bytes
                        .saturating_sub(entry.status.bytes_transferred)
                })
                .fold(0u64, u64::saturating_add);
            let budget = available(staging)?
                .checked_sub(RECEIVE_HEADROOM_BYTES)
                .and_then(|free| free.checked_sub(remaining));
            if !budget.is_some_and(|bytes| entry.offer.size_bytes <= bytes) {
                return Err(ErrorCode::StorageFailed.into());
            }
        }
        let status = approve(&self.receiver, entry.key)?;
        Ok(TransferView {
            status,
            ..incoming_view(entry)
        })
    }

    fn cancel(&self, id: &str) -> Result<TransferView, TransferError> {
        if let Some(entry) = lock(&self.state)
            .outgoing
            .iter()
            .find(|entry| entry.view.id == id)
        {
            entry.cancel.cancel();
            return Ok(entry.view.clone());
        }
        let entry = self
            .receiver
            .snapshot()
            .into_iter()
            .find(|entry| incoming_id(entry) == id)
            .ok_or(ErrorCode::PeerUnavailable)?;
        let status = self.receiver.cancel(entry.key)?;
        Ok(TransferView {
            status,
            ..incoming_view(&entry)
        })
    }
}

#[cfg(windows)]
pub(crate) fn folder_view(root: &Path, active: Option<&Path>) -> Result<FolderView, TransferError> {
    let next = ReceiveFolder::new(root)
        .load()?
        .filter(|path| Some(path.as_path()) != active)
        .map(|path| folder_name(&path));
    Ok(FolderView {
        active: active.map(folder_name),
        next,
    })
}

#[cfg(windows)]
pub(crate) fn change_folder(
    root: &Path,
    active: Option<&Path>,
    destination: &Path,
) -> Result<FolderView, TransferError> {
    let destination = fs::canonicalize(destination).map_err(storage_failed)?;
    if !destination.is_dir() {
        return Err(ErrorCode::InvalidRequest.into());
    }
    disk_free(&destination)?;
    ReceiveFolder::new(root).save(&destination)?;
    folder_view(root, active)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

fn timestamp(instant: SystemTime) -> Result<String, TransferError> {
    OffsetDateTime::from(instant)
        .format(&Rfc3339)
        .map_err(|_| ErrorCode::InternalError.into())
}

#[cfg(windows)]
fn folder_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Drive root".into())
}

fn incoming_id(transfer: &IncomingTransfer) -> String {
    format!("{}:{}", transfer.key.peer, transfer.key.id)
}

fn incoming_view(transfer: &IncomingTransfer) -> TransferView {
    TransferView {
        id: incoming_id(transfer),
        interaction_id: transfer.key.id,
        device_id: transfer.key.peer,
        direction: Direction::Incoming,
        file: FileView {
            name: transfer.offer.name.clone(),
            size_bytes: transfer.offer.size_bytes,
        },
        status: transfer.status,
    }
}

fn open_source(path: &Path, selection: FileSelection) -> Result<(File, FileView), TransferError> {
    // This handle excludes writers and deletion while the engine hashes and reads the same file.
    #[cfg(windows)]
    let handle = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(path)
        .map_err(storage_failed)?;
    // The native picker owns this private copy for the lifetime of the send.
    #[cfg(any(target_os = "ios", target_os = "android"))]
    let handle = File::open(path).map_err(storage_failed)?;
    let metadata = handle.metadata().map_err(storage_failed)?;
    if !metadata.is_file() || metadata.len() > (1 << 53) - 1 {
        return Err(ErrorCode::InvalidRequest.into());
    }
    Ok((
        handle,
        FileView {
            name: selection.name,
            size_bytes: metadata.len(),
        },
    ))
}

#[cfg(windows)]
fn disk_free(path: &Path) -> Result<u64, TransferError> {
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut available = 0;
    // The path is NUL terminated and available points to a live u64.
    let success =
        unsafe { GetDiskFreeSpaceExW(path.as_ptr(), &mut available, null_mut(), null_mut()) };
    if success == 0 {
        Err(ErrorCode::StorageFailed.into())
    } else {
        Ok(available)
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    async fn until<T>(mut read: impl FnMut() -> Option<T>) -> T {
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                if let Some(value) = read() {
                    return value;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("native operation timed out")
    }

    fn supply_loopback_endpoint(app: &Session, remote: &Session) {
        lock(&app.state).peers.push(DiscoveredPeer {
            device: remote.peer.pairing().device().clone(),
            endpoints: vec![SocketAddr::from((Ipv4Addr::LOCALHOST, remote.port))],
        });
    }

    async fn send_and_check(
        sender: &Arc<Session>,
        receiver: &Arc<Session>,
        name: &str,
        bytes: &[u8],
    ) {
        let source = sender.root.join(name);
        fs::write(&source, bytes).unwrap();
        let selection = SelectionRegistry::default();
        let selected = selection
            .select(selection.begin().unwrap(), &source, false)
            .unwrap()
            .unwrap();
        let outgoing = sender
            .transfer(
                &selection,
                TransferRequest::Offer {
                    device_id: receiver.peer.pairing().device().id,
                    selection_id: selected.selection_id.clone(),
                },
            )
            .await
            .unwrap();
        assert_eq!(outgoing.status.state, State::Pending);
        assert!(!receiver.destination.join(name).exists());

        let duplicate = sender
            .transfer(
                &selection,
                TransferRequest::Offer {
                    device_id: receiver.peer.pairing().device().id,
                    selection_id: selected.selection_id,
                },
            )
            .await;
        assert!(matches!(duplicate, Err(error) if error.code == ErrorCode::InvalidRequest));

        let incoming = until(|| {
            receiver.snapshot().transfers.into_iter().find(|entry| {
                matches!(entry.direction, Direction::Incoming)
                    && entry.file.name == name
                    && entry.status.state == State::Pending
            })
        })
        .await;
        assert!(!receiver.destination.join(name).exists());
        assert_eq!(incoming.interaction_id, outgoing.interaction_id);

        receiver
            .transfer(
                &selection,
                TransferRequest::Respond {
                    transfer_id: incoming.id.clone(),
                    accept: true,
                },
            )
            .await
            .unwrap();

        let complete = until(|| {
            sender
                .snapshot()
                .transfers
                .into_iter()
                .find(|entry| entry.id == outgoing.id && entry.status.state.is_terminal())
        })
        .await;
        assert_eq!(complete.status.state, State::Completed);
        assert_eq!(complete.status.bytes_transferred, bytes.len() as u64);
        let received = receiver
            .snapshot()
            .transfers
            .into_iter()
            .find(|entry| entry.id == incoming.id)
            .unwrap();
        assert_eq!(received.status.state, State::Completed);
        assert_eq!(fs::read(receiver.destination.join(name)).unwrap(), bytes);
    }

    async fn paired_sessions(
        left_root: &Path,
        right_root: &Path,
        stop: &CancellationToken,
    ) -> (Arc<Session>, Arc<Session>) {
        // The fixture supplies deterministic loopback peers. A live LAN browse would replace them.
        let left = Session::open(left_root.into(), stop.child_token(), false)
            .await
            .unwrap();
        let right = Session::open(right_root.into(), stop.child_token(), false)
            .await
            .unwrap();
        supply_loopback_endpoint(&left, &right);
        supply_loopback_endpoint(&right, &left);

        let known = right.peer.pairing().device().id;
        let PairResult::Invitation { invitation } = right.pair(PairRequest::Create).await.unwrap()
        else {
            panic!("expected a pairing invitation")
        };
        let redeemer = Arc::clone(&left);
        let redeem = tauri::async_runtime::spawn(async move {
            redeemer
                .pair(PairRequest::Redeem {
                    code: invitation.code,
                })
                .await
        });
        let pending = until(|| right.snapshot().pending_pairing.into_iter().next()).await;
        right
            .pair(PairRequest::Confirm {
                request_id: pending.request_id,
                accept: true,
            })
            .await
            .unwrap();
        assert!(
            matches!(redeem.await.unwrap().unwrap(), PairResult::Paired { device } if device.device.id == known)
        );
        assert!(left.peer.pairing().is_trusted(known));
        (left, right)
    }

    async fn stop_pair(left: Arc<Session>, right: Arc<Session>, stop: &CancellationToken) {
        stop.cancel();
        until(|| (Arc::strong_count(&left) == 1 && Arc::strong_count(&right) == 1).then_some(()))
            .await;
        drop(left);
        drop(right);
    }

    #[test]
    fn windows_adapter_pairs_and_moves_real_files_in_both_directions() {
        tauri::async_runtime::block_on(async {
            let left_storage = tempfile::tempdir().unwrap();

            let right_storage = tempfile::tempdir().unwrap();
            let stop = CancellationToken::new();
            let (left, right) =
                paired_sessions(left_storage.path(), right_storage.path(), &stop).await;
            let known = right.peer.pairing().device().id;
            let recovered =
                Identity::load_or_create(&WindowsIdentity::new(left_storage.path())).unwrap();
            assert_eq!(recovered.id(), left.peer.pairing().device().id);

            assert!(!left.check_receiver(known).await.unwrap());
            assert_eq!(right.set_receiver_ready(true).unwrap(), 45_000);
            assert!(left.check_receiver(known).await.unwrap());

            let binary: Vec<u8> = (0..160_001).map(|index| (index % 251) as u8).collect();
            send_and_check(&left, &right, "from-left.bin", &binary).await;
            send_and_check(
                &right,
                &left,
                "from-right.bin",
                b"AeRift right-to-left fixture",
            )
            .await;
            assert_eq!(right.set_receiver_ready(false).unwrap(), 0);
            assert!(!left.check_receiver(known).await.unwrap());
            left.pair(PairRequest::Revoke { device_id: known })
                .await
                .unwrap();
            assert!(!left.peer.pairing().is_trusted(known));
            stop_pair(left, right, &stop).await;
            left_storage.close().unwrap();
            right_storage.close().unwrap();
        });
    }

    #[test]
    fn concurrent_receive_approvals_share_live_capacity() {
        use std::{sync::mpsc, thread};

        tauri::async_runtime::block_on(async {
            let left_storage = tempfile::tempdir().unwrap();
            let right_storage = tempfile::tempdir().unwrap();
            let stop = CancellationToken::new();
            let (left, right) =
                paired_sessions(left_storage.path(), right_storage.path(), &stop).await;

            for name in ["first.bin", "second.bin"] {
                let source = left.root.join(name);
                fs::write(&source, b"12345678").unwrap();
                let selection = SelectionRegistry::default();
                let selected = selection
                    .select(selection.begin().unwrap(), &source, false)
                    .unwrap()
                    .unwrap();
                left.transfer(
                    &selection,
                    TransferRequest::Offer {
                        device_id: right.peer.pairing().device().id,
                        selection_id: selected.selection_id,
                    },
                )
                .await
                .unwrap();
            }
            let (first, second) = until(|| {
                let snapshot = right.snapshot();
                let pending = |name| {
                    snapshot
                        .transfers
                        .iter()
                        .find(|transfer| {
                            transfer.file.name == name && transfer.status.state == State::Pending
                        })
                        .map(|transfer| transfer.id.clone())
                };
                Some((pending("first.bin")?, pending("second.bin")?))
            })
            .await;

            // Model disk pressure and its recovery without allocating either amount.
            let modeled_headroom = 256 * 1024 * 1024;
            assert!(matches!(
                right.respond_with_capacity(&first, true, |path| {
                    assert_eq!(path, right.receiver.staging_directory());
                    Ok(modeled_headroom + 7)
                }),
                Err(error) if error.code == ErrorCode::StorageFailed
            ));
            assert!(right.snapshot().transfers.iter().any(|transfer| {
                transfer.id == first && transfer.status.state == State::Pending
            }));

            thread::scope(|scope| {
                let (checking_first, first_check) = mpsc::sync_channel(1);
                let (release_first, first_release) = mpsc::sync_channel(1);
                let (starting_second, second_started) = mpsc::sync_channel(1);
                let (checking_second, second_check) = mpsc::sync_channel(1);
                let receiver = &right;

                let approve_first = scope.spawn(move || {
                    receiver.respond_with_capacity(&first, true, |_| {
                        checking_first.send(()).unwrap();
                        first_release.recv_timeout(Duration::from_secs(5)).unwrap();
                        Ok(modeled_headroom + 12)
                    })
                });
                first_check.recv_timeout(Duration::from_secs(5)).unwrap();

                let approve_second = scope.spawn(move || {
                    starting_second.send(()).unwrap();
                    receiver.respond_with_capacity(&second, true, |_| {
                        checking_second.send(()).unwrap();
                        let written = receiver
                            .receiver
                            .snapshot()
                            .iter()
                            .map(|entry| entry.status.bytes_transferred)
                            .sum::<u64>();
                        Ok((modeled_headroom + 12).saturating_sub(written))
                    })
                });
                second_started.recv_timeout(Duration::from_secs(5)).unwrap();
                let checked_before_first_reserved =
                    second_check.recv_timeout(Duration::from_secs(1)).is_ok();
                release_first.send(()).unwrap();
                let first_result = approve_first.join().unwrap();
                let second_result = approve_second.join().unwrap();

                assert!(
                    !checked_before_first_reserved,
                    "second approval checked capacity before the first reserved it"
                );
                assert!(first_result.is_ok());
                assert!(
                    matches!(second_result, Err(error) if error.code == ErrorCode::StorageFailed)
                );
            });

            let unapproved = right
                .snapshot()
                .transfers
                .into_iter()
                .find(|transfer| transfer.file.name == "second.bin")
                .unwrap();
            assert_eq!(unapproved.status.state, State::Pending);
            assert!(!right.destination.join("second.bin").exists());
            until(|| {
                right.snapshot().transfers.into_iter().find(|transfer| {
                    transfer.file.name == "first.bin" && transfer.status.state == State::Completed
                })
            })
            .await;
            assert_eq!(
                right
                    .respond_with_capacity(&unapproved.id, true, |_| Ok(modeled_headroom + 8))
                    .unwrap()
                    .status
                    .state,
                State::Accepted
            );
            until(|| {
                right.snapshot().transfers.into_iter().find(|transfer| {
                    transfer.file.name == "second.bin" && transfer.status.state == State::Completed
                })
            })
            .await;
            stop_pair(left, right, &stop).await;
            left_storage.close().unwrap();
            right_storage.close().unwrap();
        });
    }
}

#[cfg(windows)]
impl aerift_transfer::ambient::session::DropAuthority for Session {
    fn permits(&self, peer: PeerId, lane: aerift_transfer::ambient::session::Lane) -> bool {
        lane == aerift_transfer::ambient::session::Lane::Nearby && self.a4_sender(peer).is_ok()
    }
}
