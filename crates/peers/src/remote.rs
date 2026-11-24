//! Opt-in Remote lane. No discovery, shared directory, or nearby grants.
use std::{net::SocketAddr, path::Path, sync::Arc, time::Duration};

use aerift_transfer::{
    ErrorCode, IncomingTransfer, PeerId, ReceiveLimits, Receiver, Sender, Status, TransferError,
    TransferKey,
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpListener,
    sync::{Semaphore, watch},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    Device, Identity, InvitationCode, PeerNode, PendingPairing, PinnedEndpoint, Platform,
    RemoteRoute, RoutedPinnedEndpoint, TrustStore, network::Lane, pairing::RedeemCode,
};

const PREFIX: &str = "aerift-remote:v1:";

/// Back this with platform-protected storage using a namespace distinct from Nearby.
/// Implementations must never load, copy, or update local pairing grants here.
pub trait RemoteTrustStore: Send + Sync {
    fn load_remote(&self) -> Result<Vec<Device>, TransferError>;
    fn put_remote(&self, device: &Device) -> Result<(), TransferError>;
    fn remove_remote(&self, peer: PeerId) -> Result<(), TransferError>;
}

struct RemoteStore(Arc<dyn RemoteTrustStore>);

impl TrustStore for RemoteStore {
    fn load(&self) -> Result<Vec<Device>, TransferError> {
        self.0.load_remote()
    }

    fn put(&self, device: &Device) -> Result<(), TransferError> {
        self.0.put_remote(device)
    }

    fn remove(&self, peer: PeerId) -> Result<(), TransferError> {
        self.0.remove_remote(peer)
    }
}

/// Separate from Nearby, even when using the same device certificate.
/// No remotely callable enumeration, public discovery, or implicit app start.
/// The caller owns route provenance and must choose a distinct destination and
/// network interface. Only explicit private routed TCP is supported here.
pub struct RemotePeerNode {
    peer: PeerNode,
    receiver: Arc<Receiver>,
    routed_connections: Semaphore,
    routed_untrusted: Semaphore,
}

impl RemotePeerNode {
    pub fn new(
        identity: Identity,
        name: String,
        platform: Platform,
        store: Arc<dyn RemoteTrustStore>,
        destination: &Path,
        limits: ReceiveLimits,
    ) -> Result<Self, TransferError> {
        let receiver = Arc::new(Receiver::new(destination, limits)?);
        let peer = PeerNode::with_lane(
            identity,
            name,
            platform,
            Arc::new(RemoteStore(store)),
            receiver.clone(),
            Lane::Remote,
        )?;
        Ok(Self {
            peer,
            receiver,
            routed_connections: Semaphore::new(48),
            routed_untrusted: Semaphore::new(8),
        })
    }

    /// Validate before opening a listener or attempting a routed connection.
    pub fn supports_private_endpoint(address: SocketAddr) -> bool {
        let SocketAddr::V4(address) = address else {
            return false;
        };
        let ip = address.ip();
        let [first, second, ..] = ip.octets();
        let cgnat = first == 100 && (64..=127).contains(&second);
        address.port() != 0 && (ip.is_private() || cgnat || ip.is_loopback())
    }

    pub fn device(&self) -> &Device {
        self.peer.pairing().device()
    }

    pub fn trusted_devices(&self) -> Vec<Device> {
        self.peer.pairing().trusted_devices()
    }

    /// Target a device fingerprint obtained deliberately out of band. Possession
    /// of the invitation alone does not allow a third device to request access.
    pub fn create_invitation(&self, expected: PeerId) -> Result<InvitationCode, TransferError> {
        let mut invitation = self.peer.pairing().create_invitation_for(Some(expected))?;
        invitation.code = invitation.code.replacen("aerift:v1:", PREFIX, 1);
        Ok(invitation)
    }

    pub fn cancel_invitation(&self) {
        self.peer.pairing().cancel_invitation();
    }

    pub fn invitation_peer(code: &str) -> Result<PeerId, TransferError> {
        Ok(parse_invitation(code)?.peer)
    }

    pub fn subscribe_pairing(&self) -> watch::Receiver<Option<PendingPairing>> {
        self.peer.pairing().subscribe()
    }

    /// The host must display the authenticated requester's identity and only
    /// approve when it matches the expected device and the user confirms.
    pub fn confirm_pairing(&self, request: Uuid, approve: bool) -> Result<(), TransferError> {
        self.peer.pairing().confirm(request, approve)
    }

    pub async fn redeem(&self, routes: &[SocketAddr], code: &str) -> Result<Device, TransferError> {
        let invite = parse_invitation(code)?;
        validate_private_routes(routes)?;
        self.peer.redeem_with_routes(routes, invite).await
    }

    pub fn sender(
        &self,
        routes: &[SocketAddr],
        peer: PeerId,
        decision_timeout: Duration,
        upload_timeout: Duration,
    ) -> Result<Sender<PinnedEndpoint>, TransferError> {
        validate_private_routes(routes)?;
        self.peer
            .sender_with_routes(routes, peer, decision_timeout, upload_timeout)
    }

    /// Redeem an explicit targeted Remote invitation over a separately
    /// admitted byte stream. Inner TLS validates the invitation's issuer before
    /// submitting its capability. The caller's deliberate action is consent
    /// to request pairing; the issuer still approves the authenticated caller.
    pub async fn redeem_via<R: RemoteRoute>(
        &self,
        route: R,
        code: &str,
    ) -> Result<Device, TransferError> {
        let invite = parse_invitation(code)?;
        let endpoint = self.peer.routed_endpoint(route, invite.peer, false)?;
        self.peer.redeem_over(endpoint, invite).await
    }

    /// A route is not a grant. This fails before dialing if the target has
    /// no active Remote grant, and in-flight transfers respect revocation.
    pub fn sender_via<R: RemoteRoute>(
        &self,
        route: R,
        peer: PeerId,
        decision_timeout: Duration,
        upload_timeout: Duration,
    ) -> Result<Sender<RoutedPinnedEndpoint<R>>, TransferError> {
        let endpoint = self.peer.routed_endpoint(route, peer, true)?;
        Ok(Sender::new(endpoint, decision_timeout, upload_timeout))
    }

    /// Serve exactly one admitted Remote route stream. The host derives
    /// the expected peer from a deliberately bound outer endpoint, never
    /// from the request itself. Both TLS identities are still checked.
    pub async fn serve_routed_stream<S>(
        &self,
        stream: S,
        expected_peer: PeerId,
    ) -> Result<(), TransferError>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let _permit = self
            .routed_connections
            .try_acquire()
            .map_err(|_| ErrorCode::PeerUnavailable)?;
        self.peer
            .serve_bound_remote(stream, expected_peer, &self.routed_untrusted)
            .await
    }

    pub fn revoke(&self, peer: PeerId) -> Result<(), TransferError> {
        self.peer.revoke(peer)
    }

    /// Bind only a dedicated explicit private address, never a wildcard.
    pub async fn serve(
        &self,
        listener: TcpListener,
        shutdown: CancellationToken,
    ) -> Result<(), TransferError> {
        let address = listener.local_addr().map_err(|_| ErrorCode::NetworkError)?;
        validate_private_routes(&[address])?;
        self.peer.serve(listener, shutdown).await
    }

    pub fn subscribe_transfers(&self) -> watch::Receiver<u64> {
        self.receiver.subscribe()
    }

    pub fn transfers(&self) -> Vec<IncomingTransfer> {
        self.receiver.snapshot()
    }

    /// Each incoming Remote offer needs a separate, deliberate decision.
    pub fn respond(&self, key: TransferKey, accept: bool) -> Result<Status, TransferError> {
        self.receiver.respond(key, accept)
    }

    pub fn cancel(&self, key: TransferKey) -> Result<Status, TransferError> {
        self.receiver.cancel(key)
    }
}

fn parse_invitation(code: &str) -> Result<RedeemCode, TransferError> {
    let suffix = code
        .strip_prefix(PREFIX)
        .filter(|value| value.len() == 64 + 1 + 43)
        .ok_or(ErrorCode::InvalidRequest)?;
    RedeemCode::parse(&format!("aerift:v1:{suffix}"))
}

fn validate_private_routes(routes: &[SocketAddr]) -> Result<(), TransferError> {
    if routes.is_empty()
        || routes.len() > 4
        || routes
            .iter()
            .copied()
            .any(|address| !RemotePeerNode::supports_private_endpoint(address))
    {
        return Err(ErrorCode::InvalidRequest.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_explicit_private_ipv4_and_rejects_wildcard_public_or_ipv6() {
        for addr in ["127.0.0.1:7", "10.0.0.1:7", "100.64.0.1:7", "100.127.0.1:7"] {
            assert!(
                validate_private_routes(&[addr.parse().unwrap()]).is_ok(),
                "{addr}"
            );
        }
        for addr in [
            "0.0.0.0:7",
            "192.168.1.1:0",
            "100.128.0.1:7",
            "192.0.2.1:7",
            "[::1]:7",
        ] {
            assert!(
                validate_private_routes(&[addr.parse().unwrap()]).is_err(),
                "{addr}"
            );
        }
    }
}
