//! Opt-in private-Remote tooling, deliberately not registered as an app command.
use std::{collections::HashSet, fs::File, net::SocketAddr, path::Path, sync::Mutex};

use aerift_peers::{Device, Identity, RemoteTrustStore};
use aerift_transfer::{ErrorCode, PeerId, TransferError};
use serde::{Deserialize, Serialize};

use crate::{
    protected_store::ProtectedFile,
    windows_storage::{lock_profile, storage_failed, WindowsIdentity},
};

const STORE_NAME: &str = "remote-trust-v1.dpapi";
const MAX_REMOTE_PEERS: usize = 64;

pub(crate) struct PrivateRemoteProfile {
    pub(crate) identity: WindowsIdentity,
    pub(crate) trust: ProtectedRemoteTrust,
    wan_seed: ProtectedWanSeed,
    _exclusive_profile: File,
}

impl PrivateRemoteProfile {
    pub(crate) fn into_host_parts(
        self,
    ) -> Result<(Identity, ProtectedRemoteTrust, File), TransferError> {
        let identity = Identity::load_or_create(&self.identity)?;
        Ok((identity, self.trust, self._exclusive_profile))
    }

    /// Intentionally not called by today's VPN host or normal app startup.
    /// Loading is an explicit future WAN startup action under this profile lock.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn wan_endpoint_seed(&self) -> Result<[u8; 32], TransferError> {
        let owner = Identity::load_or_create(&self.identity)?;
        aerift_peers::load_wan_endpoint_seed(&self.wan_seed, owner.id())
    }

    pub(crate) fn open(root: &Path) -> Result<Self, TransferError> {
        let root = root.canonicalize().map_err(storage_failed)?;
        if !root.is_dir() {
            return Err(ErrorCode::StorageFailed.into());
        }
        // The installed Nearby runtime takes the same OS-backed profile lock.
        // Never start a private Remote host concurrently with that runtime.
        let exclusive_profile = lock_profile(&root)?;
        Ok(Self {
            identity: WindowsIdentity::new(&root),
            trust: ProtectedRemoteTrust {
                file: ProtectedFile::new(&root, STORE_NAME),
                mutation: Mutex::new(()),
            },
            wan_seed: ProtectedWanSeed(ProtectedFile::new(&root, "remote-wan-endpoint-v1.dpapi")),
            _exclusive_profile: exclusive_profile,
        })
    }
}

// Exact current-user DPAPI, with no plaintext preference fallback.
struct ProtectedWanSeed(ProtectedFile);

impl aerift_peers::SecretStore for ProtectedWanSeed {
    fn load(&self) -> Result<Option<Vec<u8>>, TransferError> {
        self.0.load().map_err(storage_failed)
    }

    fn initialize(&self, candidate: &[u8]) -> Result<Vec<u8>, TransferError> {
        if self.0.create_if_absent(candidate).map_err(storage_failed)? {
            return Ok(candidate.to_vec());
        }
        self.load()?.ok_or_else(|| ErrorCode::StorageFailed.into())
    }
}

pub(crate) struct ProtectedRemoteTrust {
    file: ProtectedFile,
    mutation: Mutex<()>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u8,
    scope: Scope,
    devices: Vec<Device>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Scope {
    Remote,
}

impl ProtectedRemoteTrust {
    fn read(&self) -> Result<Vec<Device>, TransferError> {
        let Some(bytes) = self.file.load().map_err(storage_failed)? else {
            return Ok(Vec::new());
        };
        let envelope: Envelope = serde_json::from_slice(&bytes).map_err(storage_failed)?;
        if envelope.version != 1 || !valid_snapshot(&envelope.devices) {
            return Err(ErrorCode::StorageFailed.into());
        }
        Ok(envelope.devices)
    }

    fn change(&self, update: impl FnOnce(&mut Vec<Device>)) -> Result<(), TransferError> {
        let _guard = self.mutation.lock().map_err(storage_failed)?;
        let mut devices = self.read()?;
        update(&mut devices);
        if !valid_snapshot(&devices) {
            return Err(ErrorCode::StorageFailed.into());
        }
        devices.sort_by_key(|device| device.id.to_string());
        let data = serde_json::to_vec(&Envelope {
            version: 1,
            scope: Scope::Remote,
            devices,
        })
        .map_err(storage_failed)?;
        self.file.replace(&data).map_err(storage_failed)
    }
}

impl RemoteTrustStore for ProtectedRemoteTrust {
    fn load_remote(&self) -> Result<Vec<Device>, TransferError> {
        let _guard = self.mutation.lock().map_err(storage_failed)?;
        self.read()
    }

    fn put_remote(&self, device: &Device) -> Result<(), TransferError> {
        self.change(|devices| {
            if let Some(previous) = devices.iter_mut().find(|item| item.id == device.id) {
                *previous = device.clone();
            } else {
                devices.push(device.clone());
            }
        })
    }

    fn remove_remote(&self, peer: PeerId) -> Result<(), TransferError> {
        self.change(|devices| devices.retain(|device| device.id != peer))
    }
}

fn valid_snapshot(devices: &[Device]) -> bool {
    let mut fingerprints = HashSet::with_capacity(devices.len().min(MAX_REMOTE_PEERS));
    devices.len() <= MAX_REMOTE_PEERS
        && devices.iter().all(|device| {
            fingerprints.insert(device.id)
                && !device.name.trim().is_empty()
                && device.name.len() <= 120
                && !device.name.chars().any(char::is_control)
        })
}

/// Conservative qualification only: a manually verified, existing Tailscale
/// or private CGNAT route. The IP range is not a claim about the adapter owner.
pub(crate) fn overlay_endpoint(input: &str) -> Result<SocketAddr, TransferError> {
    let SocketAddr::V4(address) = input
        .parse::<SocketAddr>()
        .map_err(|_| ErrorCode::InvalidRequest)?
    else {
        return Err(ErrorCode::InvalidRequest.into());
    };
    let [first, second, ..] = address.ip().octets();
    if first != 100 || !(64..=127).contains(&second) || address.port() < 1024 {
        return Err(ErrorCode::InvalidRequest.into());
    }
    Ok(SocketAddr::V4(address))
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::windows_storage::WindowsTrust;
    use aerift_peers::{Identity, Platform, TrustStore};

    #[test]
    fn nearby_snapshot_cannot_be_loaded_as_protected_remote_grants() {
        let root = tempfile::tempdir().unwrap();
        let profile = PrivateRemoteProfile::open(root.path()).unwrap();
        let identity = Identity::load_or_create(&profile.identity).unwrap().id();
        assert_eq!(
            identity,
            Identity::load_or_create(&WindowsIdentity::new(root.path()))
                .unwrap()
                .id()
        );
        let nearby = WindowsTrust::new(root.path());
        let fixture = Device {
            id: PeerId::from_tls_leaf(b"public fixture id"),
            name: "Synthetic buddy".into(),
            platform: Platform::Windows,
        };
        nearby.put(&fixture).unwrap();
        assert!(profile.trust.load_remote().unwrap().is_empty());
        profile.trust.put_remote(&fixture).unwrap();
        let encrypted = std::fs::read(root.path().join("remote-trust-v1.dpapi")).unwrap();
        assert!(!encrypted
            .windows(fixture.name.len())
            .any(|bytes| bytes == fixture.name.as_bytes()));
        std::fs::copy(
            root.path().join("trust.dpapi"),
            root.path().join("remote-trust-v1.dpapi"),
        )
        .unwrap();
        assert!(profile.trust.load_remote().is_err());
        assert_eq!(nearby.load().unwrap(), [fixture]);
    }

    #[test]
    fn remote_revocation_does_not_change_nearby_grants_and_reloads_separately() {
        let root = tempfile::tempdir().unwrap();
        let nearby = WindowsTrust::new(root.path());
        let device = Device {
            id: PeerId::from_tls_leaf(b"public fixture id"),
            name: "Synthetic buddy".into(),
            platform: Platform::Windows,
        };
        nearby.put(&device).unwrap();
        {
            let profile = PrivateRemoteProfile::open(root.path()).unwrap();
            assert!(lock_profile(root.path()).is_err());
            profile.trust.put_remote(&device).unwrap();
        }
        let profile = PrivateRemoteProfile::open(root.path()).unwrap();
        assert_eq!(profile.trust.load_remote().unwrap(), [device.clone()]);
        profile.trust.remove_remote(device.id).unwrap();
        assert!(profile.trust.load_remote().unwrap().is_empty());
        assert_eq!(nearby.load().unwrap(), [device]);
    }

    #[test]
    fn native_wan_seed_is_protected_profile_bound_and_corruption_fails_closed() {
        let root = tempfile::tempdir().unwrap();
        let record = root.path().join("remote-wan-endpoint-v1.dpapi");
        let seed = {
            let profile = PrivateRemoteProfile::open(root.path()).unwrap();
            assert!(!record.exists());
            let seed = profile.wan_endpoint_seed().unwrap();
            assert!(lock_profile(root.path()).is_err());
            seed
        };
        let blob = std::fs::read(&record).unwrap();
        assert!(!blob.windows(seed.len()).any(|window| window == seed));
        assert_eq!(
            PrivateRemoteProfile::open(root.path())
                .unwrap()
                .wan_endpoint_seed()
                .unwrap(),
            seed
        );
        let other = tempfile::tempdir().unwrap();
        let unrelated = PrivateRemoteProfile::open(other.path()).unwrap();
        let _ = Identity::load_or_create(&unrelated.identity).unwrap();
        std::fs::write(other.path().join("remote-wan-endpoint-v1.dpapi"), blob).unwrap();
        assert!(unrelated.wan_endpoint_seed().is_err());
        let mut corrupted = std::fs::read(&record).unwrap();
        corrupted.truncate(corrupted.len() / 2);
        std::fs::write(&record, &corrupted).unwrap();
        assert!(PrivateRemoteProfile::open(root.path())
            .unwrap()
            .wan_endpoint_seed()
            .is_err());
        assert_eq!(std::fs::read(&record).unwrap(), corrupted);
    }

    #[test]
    fn only_explicit_private_overlay_ipv4_and_fixed_high_port_may_listen() {
        for allowed in ["100.64.0.1:47497", "100.127.255.254:47497"] {
            assert!(overlay_endpoint(allowed).is_ok());
        }
        for denied in [
            "127.0.0.1:47497",
            "0.0.0.0:47497",
            "192.168.1.1:47497",
            "192.0.2.1:47497",
            "100.128.0.1:47497",
            "100.64.0.1:0",
            "100.64.0.1:443",
            "[::1]:47497",
            "name.test:47497",
        ] {
            assert!(overlay_endpoint(denied).is_err(), "{denied}");
        }
    }
}
