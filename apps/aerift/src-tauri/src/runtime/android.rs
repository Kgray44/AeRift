use std::{
    ffi::CString,
    fs,
    mem::MaybeUninit,
    net::Ipv4Addr,
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use aerift_transfer::{ErrorCode, Receiver, State, TransferError};
use tauri::ipc::Channel;
use tauri_plugin_aerift_android::{DiscoveryState, DiscoveryUpdate};
use tokio::{net::TcpListener, sync::watch};
use tokio_util::sync::CancellationToken;

use super::{incoming_id, lock, Session, RECEIVE_LIMITS};

impl Session {
    pub(super) async fn open_android(
        app: &tauri::AppHandle,
        stop: CancellationToken,
    ) -> Result<Arc<Self>, TransferError> {
        let directories = tauri_plugin_aerift_android::storage_directories(app).await?;
        let handle = app.clone();
        let (destination, peer, receiver) = tauri::async_runtime::spawn_blocking(move || {
            clear_interrupted_receives(&directories.partials)?;
            disk_free(&directories.partials)?;
            let receiver = Arc::new(Receiver::with_staging_directory(
                &directories.published,
                &directories.partials,
                RECEIVE_LIMITS,
            )?);
            let peer = Arc::new(tauri_plugin_aerift_android::open_peer_node(
                &handle,
                Arc::clone(&receiver),
            )?);
            Ok::<_, TransferError>((directories.published, peer, receiver))
        })
        .await
        .map_err(|_| ErrorCode::InternalError)??;

        // v1 sessions currently select IPv4 endpoints across Windows/iOS/Android.
        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
            .await
            .map_err(|_| ErrorCode::NetworkError)?;
        let port = listener.local_addr().map_err(|_| ErrorCode::NetworkError)?.port();
        let session = Arc::new(Self {
            port,
            destination,
            discovery_start: tokio::sync::Mutex::new(()),
            discovery_events: std::sync::OnceLock::new(),
            peer,
            receiver,
            receive_approvals: Mutex::new(()),
            state: Mutex::default(),
            changes: watch::channel(0).0,
            stop,
        });
        let active = Arc::clone(&session);
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = active.peer.serve(listener, active.stop.clone()).await;
            let _ = tauri_plugin_aerift_android::stop_discovery(&handle).await;
            active.update_android_discovery(DiscoveryState::Unavailable, Vec::new());
        });
        // Denying an OS permission must not take down the AppPort or hide its explanation.
        let discovery = Arc::clone(&session);
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = discovery.retry_android_discovery(&handle).await;
        });
        Ok(session)
    }

    pub(crate) async fn retry_android_discovery(
        self: &Arc<Self>,
        app: &tauri::AppHandle,
    ) -> Result<(), TransferError> {
        let _start = self.discovery_start.lock().await;
        if matches!(
            lock(&self.state).local_network,
            Some(DiscoveryState::Starting | DiscoveryState::Ready | DiscoveryState::Suspended)
        ) {
            return Ok(());
        }
        let events = self.discovery_events.get_or_init(|| {
            let active = Arc::downgrade(self);
            Channel::new(move |message| {
                if let Some(session) = active.upgrade() {
                    let update = message.deserialize::<DiscoveryUpdate>()?;
                    let state = update.state;
                    let own = session.peer.pairing().device().id;
                    session.update_android_discovery(state, update.into_peers(own));
                }
                Ok(())
            })
        });
        self.update_android_discovery(DiscoveryState::Starting, Vec::new());
        let result = tauri_plugin_aerift_android::start_discovery(
            app,
            self.peer.pairing().device(),
            self.port,
            events,
        ).await;
        if result.is_err() {
            self.update_android_discovery(DiscoveryState::Unavailable, Vec::new());
            return Err(ErrorCode::NetworkError.into());
        }
        Ok(())
    }

    fn update_android_discovery(
        &self,
        discovery: DiscoveryState,
        peers: Vec<aerift_peers::DiscoveredPeer>,
    ) {
        let inactive = matches!(
            discovery,
            DiscoveryState::Suspended | DiscoveryState::Unavailable | DiscoveryState::Disabled
        );
        {
            let mut state = lock(&self.state);
            state.local_network = Some(discovery);
            state.peers = peers;
            if inactive {
                self.receiver.set_ready_until(None);
                for entry in &state.outgoing {
                    if !entry.view.status.state.is_terminal() {
                        entry.cancel.cancel();
                    }
                }
            }
        }
        if inactive {
            for entry in self.receiver.snapshot() {
                if !entry.status.state.is_terminal() {
                    let _ = self.receiver.cancel(entry.key);
                }
            }
        }
        self.changed();
    }

    /// A UI-supplied ID names an authoritative completed incoming receipt, not a path.
    pub(crate) fn android_received(&self, transfer_id: &str) -> Result<(PathBuf, String), TransferError> {
        let receipt = self.receiver.snapshot().into_iter()
            .find(|entry| incoming_id(entry) == transfer_id && entry.status.state == State::Completed)
            .ok_or(ErrorCode::InvalidRequest)?;
        let path = receipt.saved_path.ok_or(ErrorCode::StorageFailed)?;
        let metadata = fs::symlink_metadata(&path).map_err(storage_failed)?;
        let path = path.canonicalize().map_err(storage_failed)?;
        if path.parent() != Some(self.destination.as_path()) || !metadata.is_file() {
            return Err(ErrorCode::StorageFailed.into());
        }
        Ok((path, receipt.offer.name))
    }
}

fn clear_interrupted_receives(staging: &Path) -> Result<(), TransferError> {
    for entry in fs::read_dir(staging).map_err(storage_failed)? {
        let entry = entry.map_err(storage_failed)?;
        if entry.file_name().as_encoded_bytes().starts_with(b".aerift-part-")
            && entry.file_type().map_err(storage_failed)?.is_file()
        {
            fs::remove_file(entry.path()).map_err(storage_failed)?;
        }
    }
    Ok(())
}

pub(super) fn disk_free(path: &Path) -> Result<u64, TransferError> {
    let path = CString::new(path.as_os_str().as_bytes()).map_err(storage_failed)?;
    let mut stats = MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: path is NUL-terminated and statvfs initializes the struct on success.
    if unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return Err(ErrorCode::StorageFailed.into());
    }
    let stats = unsafe { stats.assume_init() };
    Ok((stats.f_bavail as u64).saturating_mul(stats.f_frsize as u64))
}

pub(super) fn storage_failed(_: impl std::fmt::Display) -> TransferError {
    ErrorCode::StorageFailed.into()
}
