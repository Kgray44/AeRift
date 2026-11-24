//! Optional Remote folder ingress. No listener opens and no capability is
//! advertised until a native host deliberately attaches this to Remote.
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use aerift_transfer::{
    ErrorCode, IncomingTransfer, PeerId, ReceiveLimits, Receiver, Status, TransferError,
    TransferKey,
    folder::{
        admission::{AdmittedFolder, FolderCapability, FolderRepresentation},
        admission_store::{FolderAdmissionStore, ProtectedAdmissionStorage},
    },
    serve_admitted_folder_request,
};
use http_body_util::{BodyExt, Limited};
use hyper::{Method, Request, StatusCode, body::Body, body::Incoming};
use tokio_util::sync::CancellationToken;

use crate::network::{Reply, error, reply};

pub(crate) const ALPN: &[u8] = b"aerift-remote-folder/1";
pub(crate) const EXPORTER: &[u8] = b"EXPORTER-AeRift-Remote-Folder-v1";
pub(crate) const CAPABILITY: &str = "/remote/folder/v1/capability";
pub(crate) const OFFER: &str = "/remote/folder/v1/offer";
const MAX_PEERS: usize = 32;
const MAX_ENVELOPE: u64 = 16 * 1024 * 1024 * 1024;

struct LocalStore(Arc<dyn ProtectedAdmissionStorage>);
impl ProtectedAdmissionStorage for LocalStore {
    fn load(&self) -> Result<Option<Vec<u8>>, TransferError> {
        self.0.load()
    }
    fn replace_write_through(&self, content: &[u8]) -> Result<(), TransferError> {
        self.0.replace_write_through(content)
    }
}

struct Slot {
    typed: Arc<AdmittedFolder>,
    grant: CancellationToken,
}

pub struct RemoteFolderIngress {
    receiver: Arc<Receiver>,
    admitted: Mutex<HashMap<PeerId, Slot>>,
    store: FolderAdmissionStore<LocalStore>,
    capability: FolderCapability,
}

impl RemoteFolderIngress {
    /// Only a qualified native configuration supplies a folder-specific
    /// protected receiver destination and protected profile store. The
    /// ordinary file receiver must not be reused as this folder receiver.
    pub fn new(
        folder_envelope_directory: &Path,
        limits: ReceiveLimits,
        protected: Arc<dyn ProtectedAdmissionStorage>,
    ) -> Result<Self, TransferError> {
        if limits.active_bytes == 0 || limits.active_bytes > MAX_ENVELOPE {
            return Err(ErrorCode::InvalidRequest.into());
        }
        Ok(Self {
            receiver: Arc::new(Receiver::new_resumable(folder_envelope_directory, limits)?),
            admitted: Mutex::new(HashMap::new()),
            store: FolderAdmissionStore::new(LocalStore(protected)),
            capability: FolderCapability {
                representation: FolderRepresentation::FolderManifestV1,
                maximum_envelope_bytes: limits.active_bytes,
            },
        })
    }

    pub(crate) fn uses_storage(&self, directory: &Path) -> bool {
        self.receiver.staging_directory() == directory
    }

    /// UI may display only admissions matching the pending receiver receipt.
    pub fn review(
        &self,
        key: TransferKey,
    ) -> Result<(Arc<AdmittedFolder>, IncomingTransfer), TransferError> {
        let typed = self.lookup(key.peer)?;
        if typed.key() != key {
            return Err(ErrorCode::Conflict.into());
        }
        let receipt = self
            .receiver
            .snapshot()
            .into_iter()
            .find(|entry| entry.key == key && entry.offer == *typed.envelope())
            .ok_or(ErrorCode::PeerUnavailable)?;
        Ok((typed, receipt))
    }

    /// Give a native exporter the exact verified envelope, typed description
    /// and still-live grant. The separate native destination capability and
    /// durable publication defense remain required inside `publish`.
    pub fn with_completed<T>(
        &self,
        key: TransferKey,
        publish: impl FnOnce(
            &AdmittedFolder,
            &IncomingTransfer,
            &CancellationToken,
        ) -> Result<T, TransferError>,
    ) -> Result<T, TransferError> {
        let (typed, grant) = {
            let slots = self.admitted.lock().map_err(|_| ErrorCode::InternalError)?;
            let slot = slots
                .get(&key.peer)
                .filter(|slot| slot.typed.key() == key)
                .ok_or(ErrorCode::Conflict)?;
            self.store.require_same(&slot.typed, &slot.grant)?;
            (slot.typed.clone(), slot.grant.clone())
        };
        let transfer = self
            .receiver
            .snapshot()
            .into_iter()
            .find(|item| {
                item.key == key
                    && item.offer == *typed.envelope()
                    && item.status.state == aerift_transfer::State::Completed
            })
            .ok_or(ErrorCode::Conflict)?;
        if grant.is_cancelled() {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        publish(&typed, &transfer, &grant)
    }

    /// Call only after separate native destination review. This is not a
    /// generic accept permission. UI should retain a checked destination
    /// capability until typed publication or explicit cancellation.
    pub fn respond(&self, key: TransferKey, accept: bool) -> Result<Status, TransferError> {
        let (_, receipt) = self.review(key)?;
        if receipt.status.state != aerift_transfer::State::Pending {
            return Err(ErrorCode::Conflict.into());
        }
        self.receiver.respond(key, accept)
    }

    /// Called only by the native host after publication or explicit local
    /// discard/decline. Keeps the durable commitment for replay/conflict checks.
    pub fn retire(&self, key: TransferKey) -> Result<(), TransferError> {
        let mut slots = self.admitted.lock().map_err(|_| ErrorCode::InternalError)?;
        if slots
            .get(&key.peer)
            .is_none_or(|slot| slot.typed.key() != key)
            || self
                .receiver
                .snapshot()
                .iter()
                .any(|item| item.key == key && !item.status.state.is_terminal())
        {
            return Err(ErrorCode::Conflict.into());
        }
        slots.remove(&key.peer);
        Ok(())
    }

    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<u64> {
        self.receiver.subscribe()
    }

    pub fn snapshot(&self) -> Vec<IncomingTransfer> {
        self.receiver.snapshot()
    }

    pub(crate) fn expire(&self) {
        self.receiver.expire_offers();
        if let Ok(mut entries) = self.admitted.try_lock() {
            entries.retain(|_, slot| !slot.grant.is_cancelled());
        }
    }

    fn lookup(&self, peer: PeerId) -> Result<Arc<AdmittedFolder>, TransferError> {
        let entries = self.admitted.lock().map_err(|_| ErrorCode::InternalError)?;
        let slot = entries.get(&peer).ok_or(ErrorCode::PeerUntrusted)?;
        self.store.require_same(&slot.typed, &slot.grant)?;
        Ok(slot.typed.clone())
    }

    fn admit(
        &self,
        bytes: &[u8],
        peer: PeerId,
        local: PeerId,
        binding: [u8; 32],
        grant: CancellationToken,
    ) -> Result<(), TransferError> {
        let typed = AdmittedFolder::from_remote_control(
            bytes,
            Some(&self.capability),
            peer,
            local,
            binding,
        )?;
        let mut entries = self.admitted.lock().map_err(|_| ErrorCode::InternalError)?;
        entries.retain(|_, slot| !slot.grant.is_cancelled());
        if let Some(prior) = entries.get(&peer) {
            // A completed envelope may still await native export. A later
            // remote offer must not displace that local decision.
            if prior.typed.key() != typed.key() {
                return Err(ErrorCode::Conflict.into());
            }
        } else if entries.len() >= MAX_PEERS {
            return Err(ErrorCode::PeerUnavailable.into());
        }
        self.store.remember(&typed, &grant)?;
        entries.insert(
            peer,
            Slot {
                typed: Arc::new(typed),
                grant,
            },
        );
        Ok(())
    }

    pub(crate) async fn route(
        self: Arc<Self>,
        request: Request<Incoming>,
        peer: PeerId,
        local: PeerId,
        binding: [u8; 32],
        grant: CancellationToken,
    ) -> Reply {
        if grant.is_cancelled() || request.uri().query().is_some() {
            return error(ErrorCode::PeerUntrusted.into());
        }
        match (request.method(), request.uri().path()) {
            (&Method::POST, CAPABILITY) if request.body().size_hint().exact() == Some(0) => {
                reply(StatusCode::OK, &self.capability)
            }
            (&Method::POST, OFFER) => {
                let bytes = tokio::select! {
                    biased;
                    _ = grant.cancelled() => return error(ErrorCode::PeerUntrusted.into()),
                    bytes = tokio::time::timeout(Duration::from_secs(10), Limited::new(request.into_body(), 2048).collect()) => {
                        match bytes {
                            Ok(Ok(bytes)) => bytes.to_bytes(),
                            _ => return error(ErrorCode::InvalidRequest.into()),
                        }
                    }
                };
                match tokio::task::spawn_blocking(move || {
                    self.admit(&bytes, peer, local, binding, grant)
                })
                .await
                {
                    Ok(Ok(())) => reply(StatusCode::OK, &true),
                    Ok(Err(failure)) => error(failure),
                    Err(_) => error(ErrorCode::InternalError.into()),
                }
            }
            _ => {
                let typed = match tokio::task::spawn_blocking({
                    let ingress = Arc::clone(&self);
                    move || ingress.lookup(peer)
                })
                .await
                {
                    Ok(Ok(typed)) => typed,
                    Ok(Err(failure)) => return error(failure),
                    Err(_) => return error(ErrorCode::InternalError.into()),
                };
                serve_admitted_folder_request(request, peer, self.receiver.clone(), grant, &typed)
                    .await
            }
        }
    }
}
