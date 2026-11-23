use std::{
    collections::{BTreeSet, HashMap},
    net::{SocketAddr, SocketAddrV6},
    time::Duration,
};

use aerift_transfer::{ErrorCode, PeerId, TransferError};
use mdns_sd::{
    Receiver, ResolvedService, ScopedIp, ServiceDaemon, ServiceEvent, ServiceInfo, UnregisterStatus,
};

use crate::{Device, Platform, pairing::valid_name};

pub const SERVICE_TYPE: &str = "_aerift._tcp.local.";
const MAX_INSTANCES: usize = 256;

#[derive(Clone, Debug)]
pub struct DiscoveredPeer {
    /// Unauthenticated discovery metadata. Pairing and sending pin the ID over TLS.
    pub device: Device,
    pub endpoints: Vec<SocketAddr>,
}

pub struct Discovery {
    daemon: ServiceDaemon,
    events: Receiver<ServiceEvent>,
    fullname: String,
    own_id: PeerId,
    instances: HashMap<String, DiscoveredPeer>,
    stopped: bool,
}

impl Discovery {
    /// Bind the TCP listener before advertising its actual port.
    pub fn start(device: &Device, port: u16) -> Result<Self, TransferError> {
        if !valid_name(&device.name) || port == 0 {
            return Err(ErrorCode::InvalidRequest.into());
        }
        let id = device.id.to_string();
        let instance = format!("aerift-{}", &id[..32]);
        let host = format!("{instance}.local.");
        let platform = match device.platform {
            Platform::Windows => "windows",
            Platform::Ios => "ios",
            Platform::Android => "android",
            Platform::Macos => "macos",
            Platform::Linux => "linux",
        };
        let properties = [
            ("v", "1"),
            ("id", id.as_str()),
            ("name", device.name.as_str()),
            ("platform", platform),
        ];
        let info = ServiceInfo::new(SERVICE_TYPE, &instance, &host, "", port, &properties[..])
            .map_err(|_| ErrorCode::NetworkError)?
            .enable_addr_auto();
        let fullname = info.get_fullname().to_owned();
        let daemon = ServiceDaemon::new().map_err(|_| ErrorCode::NetworkError)?;
        let events = match daemon.browse(SERVICE_TYPE).and_then(|events| {
            daemon.register(info)?;
            Ok(events)
        }) {
            Ok(events) => events,
            Err(_) => {
                let _ = daemon.shutdown();
                return Err(ErrorCode::NetworkError.into());
            }
        };
        Ok(Self {
            daemon,
            events,
            fullname,
            own_id: device.id,
            instances: HashMap::new(),
            stopped: false,
        })
    }

    /// Wait for a resolver update. Removal covers both goodbye and record expiry.
    /// Merge this result with saved trust in the native adapter to display offline peers.
    pub async fn changed(&mut self) -> Result<Vec<DiscoveredPeer>, TransferError> {
        loop {
            let event = self
                .events
                .recv_async()
                .await
                .map_err(|_| ErrorCode::NetworkError)?;
            if self.apply(event) {
                return Ok(self.snapshot());
            }
        }
    }

    /// Let the daemon transmit the DNS-SD goodbye, including its repeat, before
    /// stopping it. Drop handles abrupt teardown on a best-effort basis.
    pub async fn stop(mut self) -> Result<(), TransferError> {
        let reply = self
            .daemon
            .unregister(&self.fullname)
            .map_err(|_| ErrorCode::NetworkError)?;
        let status = tokio::time::timeout(Duration::from_secs(2), reply.recv_async())
            .await
            .map_err(|_| ErrorCode::PeerUnavailable)?
            .map_err(|_| ErrorCode::NetworkError)?;
        if matches!(status, UnregisterStatus::OK) {
            // mdns-sd 0.21 schedules one retry 120 ms after unregister.
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        let reply = self
            .daemon
            .shutdown()
            .map_err(|_| ErrorCode::NetworkError)?;
        self.stopped = true;
        tokio::time::timeout(Duration::from_secs(2), reply.recv_async())
            .await
            .map_err(|_| ErrorCode::PeerUnavailable)?
            .map_err(|_| ErrorCode::NetworkError)?;
        Ok(())
    }

    pub fn snapshot(&self) -> Vec<DiscoveredPeer> {
        let mut peers = HashMap::<PeerId, (&Device, BTreeSet<SocketAddr>)>::new();
        for instance in self.instances.values() {
            let (_, addresses) = peers
                .entry(instance.device.id)
                .or_insert_with(|| (&instance.device, BTreeSet::new()));
            addresses.extend(instance.endpoints.iter().copied());
        }
        let mut snapshot: Vec<_> = peers
            .into_values()
            .map(|(device, endpoints)| DiscoveredPeer {
                device: device.clone(),
                endpoints: endpoints.into_iter().collect(),
            })
            .collect();
        snapshot.sort_by_key(|peer| peer.device.id.to_string());
        snapshot
    }

    fn apply(&mut self, event: ServiceEvent) -> bool {
        match event {
            ServiceEvent::ServiceResolved(service) => {
                let fullname = service.get_fullname().to_ascii_lowercase();
                if let Some(peer) = resolved(&service)
                    && peer.device.id != self.own_id
                    && (self.instances.len() < MAX_INSTANCES
                        || self.instances.contains_key(&fullname))
                {
                    self.instances.insert(fullname, peer);
                    return true;
                }
                self.instances.remove(&fullname).is_some()
            }
            ServiceEvent::ServiceRemoved(_, fullname) => self
                .instances
                .remove(&fullname.to_ascii_lowercase())
                .is_some(),
            _ => false,
        }
    }
}

impl Drop for Discovery {
    fn drop(&mut self) {
        if !self.stopped {
            // Shutdown already unregisters active services.
            let _ = self.daemon.shutdown();
        }
    }
}

fn resolved(service: &ResolvedService) -> Option<DiscoveredPeer> {
    if service.get_property_val_str("v")? != "1" || service.get_port() == 0 {
        return None;
    }
    let id = service.get_property_val_str("id")?.parse().ok()?;
    let name = service.get_property_val_str("name")?;
    if !valid_name(name) {
        return None;
    }
    let platform = match service.get_property_val_str("platform")? {
        "windows" => Platform::Windows,
        "ios" => Platform::Ios,
        "android" => Platform::Android,
        "macos" => Platform::Macos,
        "linux" => Platform::Linux,
        _ => return None,
    };
    let endpoints: Vec<_> = service
        .get_addresses()
        .iter()
        .filter_map(|ip| {
            let address = ip.to_ip_addr();
            if address.is_loopback() || address.is_unspecified() || address.is_multicast() {
                return None;
            }
            Some(match ip {
                ScopedIp::V6(ip) => SocketAddr::V6(SocketAddrV6::new(
                    *ip.addr(),
                    service.get_port(),
                    0,
                    ip.scope_id().index,
                )),
                _ => SocketAddr::new(address, service.get_port()),
            })
        })
        .take(16)
        .collect();
    if endpoints.is_empty() {
        return None;
    }
    Some(DiscoveredPeer {
        device: Device {
            id,
            name: name.to_owned(),
            platform,
        },
        endpoints,
    })
}
