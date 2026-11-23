use serde::{Deserialize, Serialize};
use std::net::{IpAddr, SocketAddr, SocketAddrV6};
use tauri::{ipc::Channel, plugin::mobile::PluginInvokeError, AppHandle, Manager, Runtime};

use crate::IosPlatform;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BonjourEndpoint {
    ip: IpAddr,
    port: u16,
    scope_id: u32,
}

impl BonjourEndpoint {
    pub fn socket_addr(&self) -> Option<SocketAddr> {
        if self.port == 0
            || self.ip.is_loopback()
            || self.ip.is_unspecified()
            || self.ip.is_multicast()
        {
            return None;
        }
        Some(match self.ip {
            IpAddr::V4(ip) => (ip, self.port).into(),
            IpAddr::V6(ip) => SocketAddrV6::new(ip, self.port, 0, self.scope_id).into(),
        })
    }
}

#[derive(Deserialize)]
pub struct BonjourPeer {
    /// Unauthenticated until the shared engine verifies the TLS certificate.
    pub id: String,
    pub name: String,
    pub platform: String,
    pub endpoints: Vec<BonjourEndpoint>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BonjourState {
    Starting,
    Ready,
    Disabled,
    Suspended,
    Unavailable,
}

#[derive(Deserialize)]
pub struct BonjourUpdate {
    pub state: BonjourState,
    pub peers: Vec<BonjourPeer>,
}

#[derive(Serialize)]
struct DiscoveryArgs<'a> {
    id: &'a str,
    name: &'a str,
    port: u16,
    events: &'a Channel<BonjourUpdate>,
}

/// Advertise the shared engine's bound listener with system Bonjour. Handle
/// the channel in Rust and use endpoints only for v1 fingerprint-pinned TLS.
pub async fn start_discovery<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    name: &str,
    port: u16,
    events: &Channel<BonjourUpdate>,
) -> Result<(), PluginInvokeError> {
    app.state::<IosPlatform<R>>()
        .0
        .run_mobile_plugin_async(
            "startDiscovery",
            DiscoveryArgs {
                id,
                name,
                port,
                events,
            },
        )
        .await
}

pub async fn stop_discovery<R: Runtime>(app: &AppHandle<R>) -> Result<(), PluginInvokeError> {
    app.state::<IosPlatform<R>>()
        .0
        .run_mobile_plugin_async("stopDiscovery", ())
        .await
}
