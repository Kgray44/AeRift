use std::sync::{Arc, Mutex};

use aerift_peers::{Device, Identity, PeerNode, Platform, SecretStore, TrustStore};
use aerift_transfer::{ErrorCode, PeerId, Receiver, TransferError};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::AndroidPlatform;

const IDENTITY_LIMIT: usize = 16 * 1024;
const TRUST_LIMIT: usize = 512 * 1024;
static TRUST_ACCESS: Mutex<()> = Mutex::new(());

struct AndroidSecrets<R: Runtime>(AppHandle<R>);

#[derive(Deserialize)]
struct Stored {
    value: Option<String>,
}

fn storage_failed(_: impl std::fmt::Display) -> TransferError {
    ErrorCode::StorageFailed.into()
}

fn decode(stored: Stored, max_bytes: usize) -> Result<Option<Vec<u8>>, TransferError> {
    let Some(value) = stored.value else { return Ok(None); };
    if value.len() > max_bytes.div_ceil(3) * 4 {
        return Err(ErrorCode::StorageFailed.into());
    }
    let bytes = STANDARD.decode(value).map_err(storage_failed)?;
    if bytes.len() > max_bytes { return Err(ErrorCode::StorageFailed.into()); }
    Ok(Some(bytes))
}

// The core's storage traits are synchronous. These commands run from its
// Rust worker threads, never the Android UI looper. Kotlin owns AES-GCM and
// atomic protected persistence; the webview cannot call these native methods.
impl<R: Runtime> SecretStore for AndroidSecrets<R> {
    fn load(&self) -> Result<Option<Vec<u8>>, TransferError> {
        let stored = self.0.state::<AndroidPlatform<R>>().0
            .run_mobile_plugin("loadIdentity", ()).map_err(storage_failed)?;
        decode(stored, IDENTITY_LIMIT)
    }

    fn initialize(&self, candidate: &[u8]) -> Result<Vec<u8>, TransferError> {
        if candidate.len() > IDENTITY_LIMIT {
            return Err(ErrorCode::StorageFailed.into());
        }
        let stored = self.0.state::<AndroidPlatform<R>>().0.run_mobile_plugin(
            "initializeIdentity",
            serde_json::json!({ "candidate": STANDARD.encode(candidate) }),
        ).map_err(storage_failed)?;
        decode(stored, IDENTITY_LIMIT)?.ok_or_else(|| ErrorCode::StorageFailed.into())
    }
}

impl<R: Runtime> AndroidSecrets<R> {
    fn read_trust(&self) -> Result<Vec<Device>, TransferError> {
        let stored = self.0.state::<AndroidPlatform<R>>().0
            .run_mobile_plugin("loadTrust", ()).map_err(storage_failed)?;
        match decode(stored, TRUST_LIMIT)? {
            Some(bytes) => serde_json::from_slice(&bytes).map_err(storage_failed),
            None => Ok(Vec::new()),
        }
    }

    fn write_trust(&self, peers: &[Device]) -> Result<(), TransferError> {
        let bytes = serde_json::to_vec(peers).map_err(storage_failed)?;
        if bytes.len() > TRUST_LIMIT { return Err(ErrorCode::StorageFailed.into()); }
        let _: serde_json::Value = self.0.state::<AndroidPlatform<R>>().0.run_mobile_plugin(
            "replaceTrust", serde_json::json!({ "value": STANDARD.encode(bytes) }),
        ).map_err(storage_failed)?;
        Ok(())
    }
}

impl<R: Runtime> TrustStore for AndroidSecrets<R> {
    fn load(&self) -> Result<Vec<Device>, TransferError> {
        let _lock = TRUST_ACCESS.lock().map_err(storage_failed)?;
        self.read_trust()
    }

    fn put(&self, device: &Device) -> Result<(), TransferError> {
        let _lock = TRUST_ACCESS.lock().map_err(storage_failed)?;
        let mut peers = self.read_trust()?;
        peers.retain(|peer| peer.id != device.id);
        peers.push(device.clone());
        self.write_trust(&peers)
    }

    fn remove(&self, peer: PeerId) -> Result<(), TransferError> {
        let _lock = TRUST_ACCESS.lock().map_err(storage_failed)?;
        let mut peers = self.read_trust()?;
        let before = peers.len();
        peers.retain(|device| device.id != peer);
        if before != peers.len() { self.write_trust(&peers)?; }
        Ok(())
    }
}

pub fn open_peer_node<R: Runtime>(
    app: &AppHandle<R>,
    receiver: Arc<Receiver>,
) -> Result<PeerNode, TransferError> {
    let secrets = Arc::new(AndroidSecrets(app.clone()));
    let identity = Identity::load_or_create(secrets.as_ref())?;
    PeerNode::new(identity, "AeRift on Android".into(), Platform::Android, secrets, receiver)
}
