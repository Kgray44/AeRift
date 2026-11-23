use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, File, OpenOptions},
    net::{Ipv4Addr, SocketAddr},
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt},
    path::{Path, PathBuf},
    ptr::null_mut,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, SystemTime},
};

use aerift_peers::{Device, DiscoveredPeer, Discovery, Identity, PeerNode, Platform};
use aerift_transfer::{
    ErrorCode, IncomingTransfer, PeerId, ReceiveLimits, Receiver, State, Status, TransferError,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use tokio::{
    net::TcpListener,
    sync::{watch, OnceCell},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use windows_sys::Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, FILE_SHARE_READ};

use crate::{
    selection::{FileSelection, SelectionRegistry},
    windows_storage::{lock_profile, storage_failed, ReceiveFolder, WindowsIdentity, WindowsTrust},
};

const MAX_RECEIPTS: usize = 256;
const DECISION_TIMEOUT: Duration = Duration::from_secs(300);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);

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
    device_id: PeerId,
    direction: Direction,
    file: FileView,
    #[serde(flatten)]
    status: Status,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppSnapshot {
    version: u8,
    devices: Vec<PeerView>,
    transfers: Vec<TransferView>,
    pending_pairing: Vec<PairingView>,
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum PairRequest {
    Create,
    Redeem { code: String },
    Confirm { request_id: Uuid, accept: bool },
    Revoke { device_id: PeerId },
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
    Cancel {
        transfer_id: String,
    },
}

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
    outgoing: Vec<Outgoing>,
}

pub(crate) struct DesktopRuntime {
    session: OnceCell<Arc<Session>>,
    stop: CancellationToken,
    subscriptions: Arc<Mutex<HashMap<Uuid, CancellationToken>>>,
}

impl Default for DesktopRuntime {
    fn default() -> Self {
        Self {
            session: OnceCell::new(),
            stop: CancellationToken::new(),
            subscriptions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

pub(crate) struct Session {
    #[cfg(test)]
    port: u16,
    #[cfg(test)]
    root: PathBuf,
    destination: PathBuf,
    _profile_lock: File,
    peer: Arc<PeerNode>,
    receiver: Arc<Receiver>,
    state: Mutex<LiveState>,
    receive_approvals: Mutex<()>,
    changes: watch::Sender<u64>,
    stop: CancellationToken,
}

impl DesktopRuntime {
    pub(crate) async fn session(&self, root: PathBuf) -> Result<Arc<Session>, TransferError> {
        self.session
            .get_or_try_init(|| Session::open(root, self.stop.child_token()))
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
    async fn open(root: PathBuf, stop: CancellationToken) -> Result<Arc<Self>, TransferError> {
        let prepare_root = root.clone();
        let (profile_lock, destination, peer, receiver) =
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
                let available = disk_free(&destination)?;
                let receiver = Arc::new(Receiver::new(
                    &destination,
                    ReceiveLimits {
                        active_bytes: available.min((1 << 53) - 1),
                        session_offers: MAX_RECEIPTS,
                    },
                )?);
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
                Ok::<_, TransferError>((profile_lock, destination, peer, receiver))
            })
            .await
            .map_err(|_| ErrorCode::InternalError)??;

        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
            .await
            .map_err(|_| ErrorCode::NetworkError)?;
        let mut discovery = Discovery::start(
            peer.pairing().device(),
            listener
                .local_addr()
                .map_err(|_| ErrorCode::NetworkError)?
                .port(),
        )?;
        let session = Arc::new(Self {
            #[cfg(test)]
            port: listener
                .local_addr()
                .map_err(|_| ErrorCode::NetworkError)?
                .port(),
            #[cfg(test)]
            root,
            destination,
            _profile_lock: profile_lock,
            peer,
            receiver,
            receive_approvals: Mutex::new(()),
            state: Mutex::new(LiveState {
                peers: discovery.snapshot(),
                ..LiveState::default()
            }),
            changes: watch::channel(0).0,
            stop,
        });
        let active = Arc::clone(&session);
        tauri::async_runtime::spawn(async move {
            let browse = async {
                while let Ok(peers) = discovery.changed().await {
                    lock(&active.state).peers = peers;
                    active.changed();
                }
            };
            tokio::select! {
                _ = active.peer.serve(listener, active.stop.clone()) => {},
                _ = browse => {},
            }
            lock(&active.state).peers.clear();
            active.changed();
        });
        Ok(session)
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
            TransferRequest::Cancel { transfer_id } => self.cancel(&transfer_id),
        }
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
        let (details, path) = registry
            .lookup(selection_id)
            .ok_or(ErrorCode::InvalidRequest)?;
        let opened_path = path.clone();
        let opened =
            tauri::async_runtime::spawn_blocking(move || open_source(&opened_path, details))
                .await
                .map_err(|_| ErrorCode::InternalError)??;
        let (hold, file) = opened;
        let id = Uuid::new_v4().to_string();
        let view = TransferView {
            id: id.clone(),
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
            if state.outgoing.len() == MAX_RECEIPTS {
                let oldest = state
                    .outgoing
                    .iter()
                    .position(|entry| entry.view.status.state.is_terminal())
                    .ok_or(ErrorCode::Conflict)?;
                state.outgoing.remove(oldest);
            }
            if !registry.consume(selection_id) {
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
                .send_file(&path, &name, cancel, move |_, status| {
                    callback.outgoing_update(&receipt_id, Ok(status));
                })
                .await;
            active.outgoing_update(&id, result);
            drop(hold);
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
        self.respond_with_capacity(id, accept, || disk_free(&self.destination))
    }

    fn respond_with_capacity(
        &self,
        id: &str,
        accept: bool,
        available: impl FnOnce() -> Result<u64, TransferError>,
    ) -> Result<TransferView, TransferError> {
        // Hold the same lock through the capacity check and the receiver reservation.
        let _approval = lock(&self.receive_approvals);
        let transfers = self.receiver.snapshot();
        let entry = transfers
            .iter()
            .find(|entry| incoming_id(entry) == id)
            .ok_or(ErrorCode::PeerUnavailable)?;
        if accept {
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
            if entry.offer.size_bytes > available()?.saturating_sub(remaining) {
                return Err(ErrorCode::StorageFailed.into());
            }
        }
        let status = self.receiver.respond(entry.key, accept)?;
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
    let handle = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(path)
        .map_err(storage_failed)?;
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

#[cfg(test)]
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
        let selected = selection.select(&source, false).unwrap();
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
        let left = Session::open(left_root.into(), stop.child_token())
            .await
            .unwrap();
        let right = Session::open(right_root.into(), stop.child_token())
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

            let binary: Vec<u8> = (0..160_001).map(|index| (index % 251) as u8).collect();
            send_and_check(&left, &right, "from-left.bin", &binary).await;
            send_and_check(
                &right,
                &left,
                "from-right.bin",
                b"AeRift right-to-left fixture",
            )
            .await;
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
                let selected = selection.select(&source, false).unwrap();
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

            thread::scope(|scope| {
                let (checking_first, first_check) = mpsc::sync_channel(1);
                let (release_first, first_release) = mpsc::sync_channel(1);
                let (starting_second, second_started) = mpsc::sync_channel(1);
                let (checking_second, second_check) = mpsc::sync_channel(1);
                let receiver = &right;

                let approve_first = scope.spawn(move || {
                    receiver.respond_with_capacity(&first, true, || {
                        checking_first.send(()).unwrap();
                        first_release.recv_timeout(Duration::from_secs(5)).unwrap();
                        Ok(12)
                    })
                });
                first_check.recv_timeout(Duration::from_secs(5)).unwrap();

                let approve_second = scope.spawn(move || {
                    starting_second.send(()).unwrap();
                    receiver.respond_with_capacity(&second, true, || {
                        checking_second.send(()).unwrap();
                        let written = receiver
                            .receiver
                            .snapshot()
                            .iter()
                            .map(|entry| entry.status.bytes_transferred)
                            .sum::<u64>();
                        Ok(12u64.saturating_sub(written))
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
            stop_pair(left, right, &stop).await;
            left_storage.close().unwrap();
            right_storage.close().unwrap();
        });
    }
}
