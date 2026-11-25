//! Native app-host seam. No default service, Wry bridge, discovery, or VPN.
use std::{fs::File, io, net::SocketAddr, path::Path, sync::Arc, time::Duration};

use aerift_peers::{Device, PendingPairing, RemotePeerNode, RemoteRoute};
use aerift_transfer::{ErrorCode, IncomingTransfer, PeerId, Status, TransferError, TransferKey};
use tokio::{
    sync::{Mutex, watch},
    task::{JoinHandle, JoinSet},
};
use tokio_util::sync::CancellationToken;

use crate::{EndpointId, RelayUrl, SecretKey, WanEndpoint, WanRoute, WanStream, valid_relay};

const MAX_SERVING: usize = 24;
const DECISION_TIMEOUT: Duration = Duration::from_secs(120);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(1800);

/// The native application/operator injects this in a trusted release profile.
/// Never construct it from an invitation, request, or ordinary settings form.
pub struct OperatorRelay(RelayUrl);

impl OperatorRelay {
    pub fn from_operator_config(address: &str) -> io::Result<Self> {
        let relay: RelayUrl = address.parse().map_err(|_| io::ErrorKind::InvalidInput)?;
        if !valid_relay(&relay) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        Ok(Self(relay))
    }
}

/// One direct route supplied by the operator out of band for a private pilot.
/// Neither the invitation nor the renderer can supply or change socket addresses.
#[derive(Clone, Copy)]
pub struct OperatorDirect {
    bind: SocketAddr,
    peer: EndpointId,
    address: SocketAddr,
}

impl OperatorDirect {
    pub fn from_operator_config(bind: &str, peer: &str, address: &str) -> io::Result<Self> {
        let invalid = || io::Error::from(io::ErrorKind::InvalidInput);
        let bind: SocketAddr = bind.parse().map_err(|_| invalid())?;
        let peer: EndpointId = peer.parse().map_err(|_| invalid())?;
        let address: SocketAddr = address.parse().map_err(|_| invalid())?;
        if bind.port() == 0
            || bind.ip().is_multicast()
            || bind.is_ipv4() != address.is_ipv4()
            || address.ip().is_loopback() != bind.ip().is_loopback()
        {
            return Err(invalid());
        }
        // Reuse the transport's address validation, with no relay.
        WanRoute::new(peer, &[address], None)?;
        Ok(Self {
            bind,
            peer,
            address,
        })
    }
}

/// Exchange through a deliberate, already trusted channel. A card is routing
/// metadata only; it is not a Remote grant or a discovery result.
#[derive(Clone, Copy)]
pub struct DeviceCard {
    pub identity: PeerId,
    pub endpoint: EndpointId,
}

struct Route {
    endpoint: Arc<WanEndpoint>,
    peer: WanRoute,
}
impl RemoteRoute for Route {
    type Stream = WanStream;
    async fn dial(&self) -> Result<WanStream, TransferError> {
        self.endpoint
            .open(&self.peer)
            .await
            .map_err(|_| ErrorCode::PeerUnavailable.into())
    }
}

struct Session {
    node: Arc<RemotePeerNode>,
    endpoint: Arc<WanEndpoint>,
    stop: CancellationToken,
    direct: Option<OperatorDirect>,
}
impl Session {
    fn check_running(&self) -> Result<(), TransferError> {
        if self.stop.is_cancelled() {
            return Err(ErrorCode::Cancelled.into());
        }
        Ok(())
    }

    fn close_authority(&self) {
        self.stop.cancel();
        self.node.stop_wan_routes();
        self.node.stop_receiving();
    }

    fn check_target(&self, id: EndpointId) -> Result<(), TransferError> {
        if self.direct.is_some_and(|direct| direct.peer != id) {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        Ok(())
    }

    fn route(&self, bytes: [u8; 32]) -> Result<Route, TransferError> {
        let id = EndpointId::from_bytes(&bytes).map_err(|_| ErrorCode::InvalidRequest)?;
        self.check_target(id)?;
        let peer = match self.direct {
            Some(direct) => self.endpoint.configured_route(id, &[direct.address]),
            None => self.endpoint.configured_route(id, &[]),
        }
        .map_err(|_| ErrorCode::PeerUnavailable)?;
        Ok(Route {
            endpoint: self.endpoint.clone(),
            peer,
        })
    }
}

/// Owns one explicitly started WAN session, with a dedicated Remote node and
/// an already-locked native profile file. The file stays locked until closure.
/// Neither resource may concurrently be shared with the Nearby or VPN host.
pub struct WanSession {
    session: Arc<Session>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl WanSession {
    pub async fn start(
        node: RemotePeerNode,
        protected_seed: [u8; 32],
        relay: OperatorRelay,
        profile_lock: File,
    ) -> io::Result<Self> {
        if protected_seed == [0; 32] {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let endpoint =
            WanEndpoint::bind(SecretKey::from_bytes(&protected_seed), None, Some(relay.0)).await?;
        Ok(Self::from_bound(Arc::new(node), endpoint, profile_lock))
    }

    pub(crate) fn from_bound(
        node: Arc<RemotePeerNode>,
        endpoint: WanEndpoint,
        profile_lock: File,
    ) -> Self {
        Self::spawn_bound(node, endpoint, profile_lock, None)
    }

    pub async fn start_direct(
        node: RemotePeerNode,
        protected_seed: [u8; 32],
        direct: OperatorDirect,
        profile_lock: File,
    ) -> io::Result<Self> {
        if protected_seed == [0; 32] {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let key = SecretKey::from_bytes(&protected_seed);
        if key.public() == direct.peer {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let endpoint = WanEndpoint::bind(key, Some(direct.bind), None).await?;
        Ok(Self::spawn_bound(
            Arc::new(node),
            endpoint,
            profile_lock,
            Some(direct),
        ))
    }

    fn spawn_bound(
        node: Arc<RemotePeerNode>,
        endpoint: WanEndpoint,
        profile_lock: File,
        direct: Option<OperatorDirect>,
    ) -> Self {
        let session = Arc::new(Session {
            node,
            endpoint: Arc::new(endpoint),
            stop: CancellationToken::new(),
            direct,
        });
        let worker = tokio::spawn(serve(session.clone(), profile_lock));
        Self {
            session,
            worker: Mutex::new(Some(worker)),
        }
    }

    #[cfg(test)]
    pub(crate) fn from_bound_direct(
        node: Arc<RemotePeerNode>,
        endpoint: WanEndpoint,
        profile_lock: File,
        direct: OperatorDirect,
    ) -> Self {
        assert!(endpoint.relay.is_none());
        assert!(endpoint.bound_addresses().contains(&direct.bind));
        Self::spawn_bound(node, endpoint, profile_lock, Some(direct))
    }

    pub fn card(&self) -> DeviceCard {
        DeviceCard {
            identity: self.session.node.device().id,
            endpoint: self.session.endpoint.id(),
        }
    }

    pub fn invite(&self, target: DeviceCard) -> Result<String, TransferError> {
        self.session.check_running()?;
        self.session.check_target(target.endpoint)?;
        self.session.node.create_wan_invitation(
            target.identity,
            *self.card().endpoint.as_bytes(),
            *target.endpoint.as_bytes(),
        )
    }

    pub fn cancel_invitation(&self) {
        self.session.node.cancel_invitation();
    }

    pub fn subscribe_pairing(&self) -> watch::Receiver<Option<PendingPairing>> {
        self.session.node.subscribe_pairing()
    }

    pub fn confirm_pairing(
        &self,
        request: &PendingPairing,
        approve: bool,
    ) -> Result<(), TransferError> {
        self.session.check_running()?;
        self.session.node.confirm_pairing(request.id, approve)
    }

    pub fn connected_devices(&self) -> Vec<Device> {
        self.session
            .node
            .trusted_devices()
            .into_iter()
            .filter(|device| self.session.node.wan_active_endpoint(device.id).is_ok())
            .collect()
    }

    pub async fn redeem_verified_card(
        &self,
        code: &str,
        verified: DeviceCard,
    ) -> Result<Device, TransferError> {
        self.session.check_running()?;
        self.session.check_target(verified.endpoint)?;
        let issuer = *verified.endpoint.as_bytes();
        self.session
            .node
            .redeem_wan_invitation(
                code,
                verified.identity,
                *self.card().endpoint.as_bytes(),
                |binding| {
                    if binding.issuer_endpoint_key() != issuer {
                        return Err(ErrorCode::PeerUntrusted.into());
                    }
                    self.session.route(issuer)
                },
            )
            .await
    }

    pub async fn send_selected_file(
        &self,
        peer: PeerId,
        selected: std::path::PathBuf,
    ) -> Result<Status, TransferError> {
        use aerift_transfer::ambient::{Candidate, CaptureContext, CaptureLimits, freeze_guarded};
        self.session.check_running()?;
        let key = self.session.node.wan_active_endpoint(peer)?;
        let route = self.session.route(key)?;
        let sender =
            self.session
                .node
                .sender_wan(route, peer, key, DECISION_TIMEOUT, UPLOAD_TIMEOUT)?;
        let stop = self.session.stop.clone();
        let capture = tokio::task::spawn_blocking(move || {
            if !ordinary_file(&selected) {
                return Err(ErrorCode::InvalidRequest.into());
            }
            freeze_guarded(
                CaptureContext {
                    explicit_selection: vec![Candidate::path(selected)],
                    ..Default::default()
                },
                CaptureLimits {
                    entries: 1,
                    depth: 1,
                    inline_bytes: 0,
                    total_bytes: 64 * 1024 * 1024,
                },
                || !stop.is_cancelled(),
            )
            .map(Arc::new)
            .map_err(|_| TransferError::from(ErrorCode::InvalidRequest))
        })
        .await
        .map_err(|_| ErrorCode::InternalError)??;
        sender
            .send_frozen_file_with_id(
                uuid::Uuid::new_v4(),
                capture,
                self.session.stop.clone(),
                |_, _| {},
            )
            .await
    }

    pub async fn redeem(
        &self,
        code: &str,
        verified_issuer: PeerId,
    ) -> Result<Device, TransferError> {
        self.session.check_running()?;
        self.session
            .node
            .redeem_wan_invitation(
                code,
                verified_issuer,
                *self.card().endpoint.as_bytes(),
                |verified| self.session.route(verified.issuer_endpoint_key()),
            )
            .await
    }

    pub fn transfers(&self) -> Vec<IncomingTransfer> {
        self.session.node.transfers()
    }

    pub fn subscribe_transfers(&self) -> watch::Receiver<u64> {
        self.session.node.subscribe_transfers()
    }

    pub fn respond(&self, transfer: TransferKey, accept: bool) -> Result<Status, TransferError> {
        self.session.check_running()?;
        self.session.node.respond(transfer, accept)
    }

    pub fn cancel_transfer(&self, transfer: TransferKey) -> Result<Status, TransferError> {
        self.session.check_running()?;
        self.session.node.cancel(transfer)
    }

    pub fn revoke(&self, peer: PeerId) -> Result<(), TransferError> {
        self.session.check_running()?;
        self.session.node.revoke(peer)
    }

    pub async fn send_file(
        &self,
        peer: PeerId,
        source: &Path,
        name: &str,
        cancel: CancellationToken,
        progress: impl Fn(Status) + Send + Sync + 'static,
    ) -> Result<Status, TransferError> {
        self.session.check_running()?;
        let key = self.session.node.wan_active_endpoint(peer)?;
        let route = self.session.route(key)?;
        self.session
            .node
            .sender_wan(route, peer, key, DECISION_TIMEOUT, UPLOAD_TIMEOUT)?
            .send_file(source, name, cancel, move |_, status| progress(status))
            .await
    }

    /// An explicit awaited stop is required before starting another host.
    pub async fn stop(&self) -> io::Result<()> {
        self.session.close_authority();
        let mut lock = self.worker.lock().await;
        if let Some(worker) = lock.as_mut() {
            let result = worker.await.map_err(io::Error::other);
            *lock = None;
            result?;
        }
        Ok(())
    }
}

impl Drop for WanSession {
    fn drop(&mut self) {
        self.session.close_authority();
    }
}

fn ordinary_file(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        if !path.is_absolute()
            || !matches!(path.components().next(), Some(Component::Prefix(prefix))
                if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
        {
            return false;
        }
    }
    std::fs::symlink_metadata(path).is_ok_and(|meta| {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            const REPARSE_POINT: u32 = 0x400;
            if meta.file_attributes() & REPARSE_POINT != 0 {
                return false;
            }
        }
        meta.is_file() && !meta.file_type().is_symlink()
    })
}

async fn serve(session: Arc<Session>, _profile_lock: File) {
    let mut active = JoinSet::new();
    loop {
        if session.stop.is_cancelled() {
            break;
        }
        while active.try_join_next().is_some() {}
        if active.len() >= MAX_SERVING {
            tokio::select! {
                biased;
                _ = session.stop.cancelled() => break,
                _ = active.join_next() => continue,
            }
        }
        // accept_with owns the selected connection while authenticating it.
        // Cancel it only at the explicit session stop, never to reap a task.
        let arrival = tokio::select! {
            biased;
            _ = session.stop.cancelled() => break,
            result = session.endpoint.accept_with(|peer| {
                session.check_target(peer).is_ok()
                    && session.node.permits_wan_endpoint(*peer.as_bytes())
            }) => result,
        };
        match arrival {
            Ok((peer, stream)) => {
                let node = session.node.clone();
                active.spawn(async move {
                    let _ = node.serve_wan_stream(stream, *peer.as_bytes()).await;
                });
            }
            Err(error) if error.kind() == io::ErrorKind::NotConnected => break,
            Err(_) => tokio::task::yield_now().await,
        }
    }
    session.close_authority();
    active.shutdown().await;
    session.endpoint.close().await;
    // The worker releases the exclusive OS profile lock only here.
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operator_configuration_rejects_non_https_and_credential_bearing_inputs() {
        for value in [
            "",
            "operator.invalid",
            "http://operator.invalid",
            "https://user:secret@operator.invalid",
            "https://operator.invalid/?token=secret",
            "https://operator.invalid/#fragment",
        ] {
            assert!(OperatorRelay::from_operator_config(value).is_err());
        }
        assert!(OperatorRelay::from_operator_config("https://operator.invalid/").is_ok());
    }
}
