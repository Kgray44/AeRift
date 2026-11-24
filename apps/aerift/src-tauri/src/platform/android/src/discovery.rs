use std::{collections::BTreeMap, net::Ipv4Addr};

use aerift_peers::{Device, DiscoveredPeer, Platform};
use aerift_transfer::PeerId;
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, plugin::mobile::PluginInvokeError, AppHandle, Runtime};

use crate::call_empty;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiscoveryState {
    Starting,
    Ready,
    Disabled,
    Suspended,
    Unavailable,
}

#[derive(Deserialize)]
pub struct DiscoveryUpdate {
    pub state: DiscoveryState,
    peers: Vec<ServicePeer>,
}

#[derive(Deserialize)]
struct ServicePeer {
    id: String,
    name: String,
    platform: String,
    endpoints: Vec<Endpoint>,
}

#[derive(Deserialize)]
struct Endpoint {
    ip: String,
    port: u16,
}

impl DiscoveryUpdate {
    /// NSD is routing information, not authentication. TLS still pins PeerId.
    pub fn into_peers(self, own_id: PeerId) -> Vec<DiscoveredPeer> {
        if !matches!(self.state, DiscoveryState::Ready | DiscoveryState::Starting) {
            return Vec::new();
        }
        let mut peers = BTreeMap::new();
        for item in self.peers.into_iter().take(256) {
            let Ok(id) = item.id.parse::<PeerId>() else { continue; };
            if id == own_id || item.name.trim().is_empty() || item.name.len() > 120
                || item.name.chars().any(char::is_control)
            {
                continue;
            }
            let platform = match item.platform.as_str() {
                "windows" => Platform::Windows,
                "ios" => Platform::Ios,
                "android" => Platform::Android,
                "macos" => Platform::Macos,
                "linux" => Platform::Linux,
                _ => continue,
            };
            let endpoints: Vec<_> = item.endpoints.into_iter().take(16)
                .filter_map(|Endpoint { ip, port }| {
                    let ip = ip.parse::<Ipv4Addr>().ok()?;
                    if port == 0 || ip.is_loopback() || ip.is_unspecified()
                        || ip.is_multicast() || ip == Ipv4Addr::BROADCAST
                    {
                        return None;
                    }
                    Some((ip, port).into())
                })
                .collect();
            if endpoints.is_empty() { continue; }
            let peer = peers.entry(id.to_string()).or_insert_with(|| DiscoveredPeer {
                device: Device { id, name: item.name, platform },
                endpoints: Vec::new(),
            });
            for endpoint in endpoints {
                if peer.endpoints.len() < 16 && !peer.endpoints.contains(&endpoint) {
                    peer.endpoints.push(endpoint);
                }
            }
        }
        peers.into_values().collect()
    }
}

#[derive(Serialize)]
struct DiscoveryArgs<'a> {
    id: &'a str,
    name: &'a str,
    port: u16,
    events: &'a Channel<DiscoveryUpdate>,
}

pub async fn start_discovery<R: Runtime>(
    app: &AppHandle<R>,
    device: &Device,
    port: u16,
    events: &Channel<DiscoveryUpdate>,
) -> Result<(), PluginInvokeError> {
    let id = device.id.to_string();
    call_empty(app, "startDiscovery", DiscoveryArgs {
        id: &id,
        name: &device.name,
        port,
        events,
    }).await
}

pub async fn stop_discovery<R: Runtime>(app: &AppHandle<R>) -> Result<(), PluginInvokeError> {
    call_empty(app, "stopDiscovery", ()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn nsd_excludes_self_and_bad_routes_and_merges_duplicates() {
        let own = "00".repeat(32);
        let peer = "ab".repeat(32);
        let snapshot: DiscoveryUpdate = serde_json::from_value(json!({
            "state": "ready",
            "peers": [
                { "id": own, "name": "This device", "platform": "android",
                  "endpoints": [{ "ip": "192.168.1.2", "port": 7001 }] },
                { "id": peer, "name": "Test phone", "platform": "ios",
                  "endpoints": [{ "ip": "127.0.0.1", "port": 7002 },
                                { "ip": "224.0.0.1", "port": 7002 },
                                { "ip": "192.168.1.3", "port": 0 },
                                { "ip": "fe80::1", "port": 7002 },
                                { "ip": "192.168.1.4", "port": 7002 }] },
                { "id": peer, "name": "Duplicate", "platform": "ios",
                  "endpoints": [{ "ip": "192.168.1.4", "port": 7002 }] }
            ]
        })).unwrap();
        let peers = snapshot.into_peers(own.parse().unwrap());
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].device.id.to_string(), peer);
        assert_eq!(peers[0].endpoints, ["192.168.1.4:7002".parse::<std::net::SocketAddr>().unwrap()]);
    }

    #[test]
    fn suspended_discovery_never_exposes_stale_endpoints() {
        let snapshot: DiscoveryUpdate = serde_json::from_value(json!({
            "state": "suspended",
            "peers": [{ "id": "ab".repeat(32), "name": "Stale", "platform": "windows",
                        "endpoints": [{ "ip": "192.168.1.4", "port": 7002 }] }]
        })).unwrap();
        assert!(snapshot.into_peers("00".repeat(32).parse().unwrap()).is_empty());
    }
}
