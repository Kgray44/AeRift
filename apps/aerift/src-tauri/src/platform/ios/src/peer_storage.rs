use std::sync::{Arc, Mutex};

use aerift_peers::{Device, Identity, PeerNode, Platform, SecretStore, TrustStore};
use aerift_transfer::{ErrorCode, PeerId, Receiver, TransferError};

use crate::IosKeychain;

// A Keychain update replaces the whole snapshot. Serialize read/modify/write
// even if the host constructs more than one trust store during its lifecycle.
static TRUST_ACCESS: Mutex<()> = Mutex::new(());

impl SecretStore for IosKeychain {
    fn load(&self) -> Result<Option<Vec<u8>>, TransferError> {
        let identity = self.load_identity().map_err(storage_failed)?;
        if identity.is_none() && self.load_trust().map_err(storage_failed)?.is_some() {
            return Err(ErrorCode::StorageFailed.into());
        }
        Ok(identity)
    }

    fn initialize(&self, candidate: &[u8]) -> Result<Vec<u8>, TransferError> {
        let _access = TRUST_ACCESS.lock().map_err(storage_failed)?;
        if let Some(current) = SecretStore::load(self)? {
            return Ok(current);
        }
        if self.insert_identity(candidate).map_err(storage_failed)? {
            return Ok(candidate.to_vec());
        }
        self.load_identity()
            .map_err(storage_failed)?
            .ok_or_else(|| ErrorCode::StorageFailed.into())
    }
}

impl TrustStore for IosKeychain {
    fn load(&self) -> Result<Vec<Device>, TransferError> {
        let _access = TRUST_ACCESS.lock().map_err(storage_failed)?;
        load_devices(self)
    }

    fn put(&self, device: &Device) -> Result<(), TransferError> {
        let _access = TRUST_ACCESS.lock().map_err(storage_failed)?;
        let mut devices = load_devices(self)?;
        devices.retain(|stored| stored.id != device.id);
        devices.push(device.clone());
        write_devices(self, &devices)
    }

    fn remove(&self, peer: PeerId) -> Result<(), TransferError> {
        let _access = TRUST_ACCESS.lock().map_err(storage_failed)?;
        let mut devices = load_devices(self)?;
        let previous = devices.len();
        devices.retain(|stored| stored.id != peer);
        if devices.len() != previous {
            write_devices(self, &devices)?;
        }
        Ok(())
    }
}

fn load_devices(keychain: &IosKeychain) -> Result<Vec<Device>, TransferError> {
    match keychain.load_trust().map_err(storage_failed)? {
        Some(bytes) => serde_json::from_slice(&bytes).map_err(storage_failed),
        None => Ok(Vec::new()),
    }
}

fn write_devices(keychain: &IosKeychain, devices: &[Device]) -> Result<(), TransferError> {
    let bytes = serde_json::to_vec(devices).map_err(storage_failed)?;
    keychain.replace_trust(&bytes).map_err(storage_failed)
}

fn storage_failed(_: impl std::fmt::Display) -> TransferError {
    ErrorCode::StorageFailed.into()
}

pub fn open_peer_node(receiver: Arc<Receiver>) -> Result<PeerNode, TransferError> {
    let keychain = Arc::new(IosKeychain);
    let identity = Identity::load_or_create(keychain.as_ref())?;
    PeerNode::new(
        identity,
        "AeRift on iPhone".into(),
        Platform::Ios,
        keychain,
        receiver,
    )
}

impl TryFrom<crate::BonjourPeer> for aerift_peers::DiscoveredPeer {
    type Error = TransferError;

    fn try_from(peer: crate::BonjourPeer) -> Result<Self, Self::Error> {
        let platform = match peer.platform.as_str() {
            "windows" => Platform::Windows,
            "ios" => Platform::Ios,
            "macos" => Platform::Macos,
            "linux" => Platform::Linux,
            "android" => Platform::Android,
            _ => return Err(ErrorCode::InvalidRequest.into()),
        };
        let endpoints: Vec<_> = peer
            .endpoints
            .iter()
            .filter_map(crate::BonjourEndpoint::socket_addr)
            .collect();
        if endpoints.is_empty() {
            return Err(ErrorCode::PeerUnavailable.into());
        }
        Ok(Self {
            device: Device {
                id: peer.id.parse()?,
                name: peer.name,
                platform,
            },
            endpoints,
        })
    }
}
