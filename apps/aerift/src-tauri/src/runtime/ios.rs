use std::{
    ffi::CString,
    fs,
    mem::MaybeUninit,
    net::Ipv4Addr,
    os::unix::ffi::OsStrExt,
    path::Path,
    sync::{Arc, Mutex},
};

use aerift_transfer::{ErrorCode, Receiver, TransferError};
use tauri::ipc::Channel;
use tauri_plugin_aerift_ios::{BonjourState, BonjourUpdate};
use tokio::{net::TcpListener, sync::watch};
use tokio_util::sync::CancellationToken;

use super::{lock, Session, RECEIVE_LIMITS};

impl Session {
    pub(super) async fn open_ios(
        app: &tauri::AppHandle,
        stop: CancellationToken,
    ) -> Result<Arc<Self>, TransferError> {
        let handle = app.clone();
        let (destination, peer, receiver) = tauri::async_runtime::spawn_blocking(move || {
            let directories =
                tauri_plugin_aerift_ios::receive_directories(&handle).map_err(storage_failed)?;
            clear_interrupted_receives(&directories.partials)?;
            disk_free(&directories.partials)?;
            let receiver = Arc::new(Receiver::with_staging_directory(
                &directories.published,
                &directories.partials,
                RECEIVE_LIMITS,
            )?);
            let peer = Arc::new(tauri_plugin_aerift_ios::open_peer_node(Arc::clone(
                &receiver,
            ))?);
            Ok::<_, TransferError>((directories.published, peer, receiver))
        })
        .await
        .map_err(|_| ErrorCode::InternalError)??;

        // Windows Alpha v1 sessions currently bind IPv4.
        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
            .await
            .map_err(|_| ErrorCode::NetworkError)?;
        let port = listener
            .local_addr()
            .map_err(|_| ErrorCode::NetworkError)?
            .port();
        let session = Arc::new(Self {
            port,
            destination,
            discovery_start: tokio::sync::Mutex::new(()),
            discovery_events: std::sync::OnceLock::new(),
            peer,
            receiver,
            receive_approvals: Mutex::new(()),
            nearby_initiation: tokio::sync::Mutex::new(()),
            state: Mutex::default(),
            changes: watch::channel(0).0,
            stop,
        });
        let active = Arc::clone(&session);
        tauri::async_runtime::spawn(async move {
            let discovery_scope = Arc::downgrade(&active);
            let _ = active
                .peer
                .serve_with_nearby(listener, active.stop.clone(), move |id, source| {
                    discovery_scope
                        .upgrade()
                        .is_some_and(|session| session.nearby_source(id, source))
                })
                .await;
            active.update_discovery(BonjourUpdate {
                state: BonjourState::Unavailable,
                peers: Vec::new(),
            });
        });
        // Keep the AppPort available if discovery is denied so the UI can show
        // permission guidance and retry with the same identity and listener.
        let _ = session.retry_discovery(app).await;
        Ok(session)
    }

    pub(crate) async fn retry_discovery(
        self: &Arc<Self>,
        app: &tauri::AppHandle,
    ) -> Result<(), TransferError> {
        let _start = self.discovery_start.lock().await;
        if matches!(
            lock(&self.state).local_network,
            Some(BonjourState::Starting | BonjourState::Ready | BonjourState::Suspended)
        ) {
            return Ok(());
        }
        let events = self.discovery_events.get_or_init(|| {
            let active = Arc::downgrade(self);
            Channel::new(move |message| {
                if let Some(session) = active.upgrade() {
                    session.update_discovery(message.deserialize::<BonjourUpdate>()?);
                }
                Ok(())
            })
        });
        let device = self.peer.pairing().device();
        let result = tauri_plugin_aerift_ios::start_discovery(
            app,
            &device.id.to_string(),
            &device.name,
            self.port,
            events,
        )
        .await;
        if result.is_err() {
            self.update_discovery(BonjourUpdate {
                state: BonjourState::Unavailable,
                peers: Vec::new(),
            });
            return Err(ErrorCode::NetworkError.into());
        }
        Ok(())
    }

    fn update_discovery(&self, update: BonjourUpdate) {
        let suspended = matches!(update.state, BonjourState::Suspended);
        {
            let mut state = lock(&self.state);
            state.local_network = Some(update.state);
            state.peers = update
                .peers
                .into_iter()
                .filter_map(|peer| peer.try_into().ok())
                .collect();
            if suspended {
                state.nearby_outgoing = None;
                self.receiver.set_ready_until(None);
                for entry in &state.outgoing {
                    if !entry.view.status.state.is_terminal() {
                        entry.cancel.cancel();
                    }
                }
            }
        }
        if suspended {
            self.peer.cancel_nearby();
            for entry in self.receiver.snapshot() {
                if !entry.status.state.is_terminal() {
                    let _ = self.receiver.cancel(entry.key);
                }
            }
        }
        self.changed();
    }
}

// The session is initialized once, before accepting any new transfer.
fn clear_interrupted_receives(staging: &Path) -> Result<(), TransferError> {
    for entry in fs::read_dir(staging).map_err(storage_failed)? {
        let entry = entry.map_err(storage_failed)?;
        if entry
            .file_name()
            .as_encoded_bytes()
            .starts_with(b".aerift-part-")
            && entry.file_type().map_err(storage_failed)?.is_file()
        {
            fs::remove_file(entry.path()).map_err(storage_failed)?;
        }
    }
    Ok(())
}

pub(super) fn disk_free(path: &Path) -> Result<u64, TransferError> {
    let path = CString::new(path.as_os_str().as_bytes()).map_err(storage_failed)?;
    let mut stats = MaybeUninit::<libc::statfs>::uninit();
    // The path is NUL terminated and statfs fully initializes stats on success.
    if unsafe { libc::statfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return Err(ErrorCode::StorageFailed.into());
    }
    let stats = unsafe { stats.assume_init() };
    Ok(stats.f_bavail.saturating_mul(u64::from(stats.f_bsize)))
}

pub(super) fn storage_failed(_: impl std::fmt::Display) -> TransferError {
    ErrorCode::StorageFailed.into()
}
