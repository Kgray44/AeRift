//! Opt-in Remote lane. No discovery, shared directory, or nearby grants.
use std::{
    net::SocketAddr,
    path::Path,
    sync::Arc,
    time::{Duration, SystemTime},
};

use aerift_transfer::{
    Connector, ErrorCode, IncomingTransfer, PeerId, ReceiveLimits, Receiver, Sender, Status,
    TransferError, TransferKey,
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
        Self::with_receiver(
            identity,
            name,
            platform,
            store,
            Arc::new(Receiver::new_resumable(destination, limits)?),
        )
    }

    /// Unix-only development opt-in, never enabled implicitly by the app.
    #[cfg(unix)]
    pub fn with_restart_journal(
        identity: Identity,
        name: String,
        platform: Platform,
        store: Arc<dyn RemoteTrustStore>,
        destination: &Path,
        journal_directory: &Path,
        limits: ReceiveLimits,
    ) -> Result<Self, TransferError> {
        Self::with_receiver(
            identity,
            name,
            platform,
            store,
            Arc::new(Receiver::with_restart_journal(
                destination,
                journal_directory,
                limits,
            )?),
        )
    }

    fn with_receiver(
        identity: Identity,
        name: String,
        platform: Platform,
        store: Arc<dyn RemoteTrustStore>,
        receiver: Arc<Receiver>,
    ) -> Result<Self, TransferError> {
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

    /// Pack a targeted invitation and both outer keys in a single signed
    /// message. Supply the recipient fingerprint and endpoint key obtained
    /// together through an authenticated private exchange. No IPs, URLs or
    /// operator configuration travel in the code.
    pub fn create_wan_invitation(
        &self,
        expected: PeerId,
        issuer_endpoint_key: [u8; 32],
        recipient_endpoint_key: [u8; 32],
    ) -> Result<String, TransferError> {
        crate::wan_invitation::verify_distinct_keys(issuer_endpoint_key, recipient_endpoint_key)?;
        crate::wan_invitation::seal(
            self.peer.identity(),
            expected,
            issuer_endpoint_key,
            recipient_endpoint_key,
            self.create_invitation(expected)?,
        )
    }

    /// Verify before any route selection or dial. Use the separately trusted
    /// issuer fingerprint and the current locally owned WAN endpoint key.
    pub fn inspect_wan_invitation(
        &self,
        code: &str,
        expected_issuer: PeerId,
        local_endpoint_key: [u8; 32],
    ) -> Result<crate::WanInvitationBinding, TransferError> {
        crate::wan_invitation::inspect_at(
            code,
            expected_issuer,
            self.device().id,
            local_endpoint_key,
            SystemTime::now(),
        )
    }

    /// Redeem only through an operator-configured route. The callback
    /// receives a verified binding, not an untrusted endpoint or relay URL.
    /// Existing pinned inner TLS and both consent decisions remain required.
    pub async fn redeem_wan_invitation<R: RemoteRoute>(
        &self,
        code: &str,
        expected_issuer: PeerId,
        local_endpoint_key: [u8; 32],
        route_for: impl FnOnce(&crate::WanInvitationBinding) -> Result<R, TransferError>,
    ) -> Result<Device, TransferError> {
        let invitation = self.inspect_wan_invitation(code, expected_issuer, local_endpoint_key)?;
        let route = route_for(&invitation)?;
        self.redeem_via(route, &invitation.code).await
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
        let result = self.peer.revoke(peer);
        #[cfg(unix)]
        {
            // Attempt partial-data cleanup even if persistence of the trust
            // removal failed. Neither error may be reported as durable success.
            let cleanup = self.receiver.discard_restart_checkpoints_for_peer(peer);
            result.and(cleanup)
        }
        #[cfg(not(unix))]
        result
    }

    /// Close only this session's ordinary file receiver and wait for any
    /// earlier, already-linearized publication. Does not revoke saved peers.
    pub fn stop_receiving(&self) {
        self.receiver.stop_receiving();
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

    /// Attach folder-specific ingress to the same explicitly authorized
    /// Remote listener, but never to Nearby or the ordinary file protocol.
    /// Installed hosts should pass no ingress until native export qualification.
    pub async fn serve_with_folders(
        &self,
        listener: TcpListener,
        shutdown: CancellationToken,
        folders: Arc<crate::RemoteFolderIngress>,
    ) -> Result<(), TransferError> {
        let address = listener.local_addr().map_err(|_| ErrorCode::NetworkError)?;
        validate_private_routes(&[address])?;
        if folders.uses_storage(self.receiver.staging_directory()) {
            return Err(ErrorCode::Conflict.into());
        }
        self.peer
            .serve_with_folders(listener, shutdown, folders)
            .await
    }

    /// Sends an explicitly prepared directory to a pinned Remote device
    /// only on the folder ALPN; no fallback to file or Nearby transport.
    /// Completion here is the authenticated envelope receipt, not export.
    pub async fn send_folder(
        &self,
        routes: &[SocketAddr],
        peer: PeerId,
        folder: &aerift_transfer::folder::PreparedFolder,
        id: Uuid,
        cancel: CancellationToken,
        progress: impl Fn(Uuid, Status) + Send + Sync + 'static,
    ) -> Result<Status, TransferError> {
        use crate::{network::pair_call_bytes, remote_folder};
        use aerift_transfer::{ambient::ReceiverCapabilities, folder::admission::FolderCapability};
        validate_private_routes(routes)?;
        let endpoint = self.peer.folder_endpoint(routes, peer)?;
        let local = self.device().id;
        let grant = endpoint.trust_revoked().ok_or(ErrorCode::PeerUntrusted)?;
        let negotiate = async {
            let cap: FolderCapability = pair_call_bytes(
                endpoint.connect().await?,
                endpoint.authority(),
                remote_folder::CAPABILITY,
                Vec::new(),
                Duration::from_secs(10),
            )
            .await?;
            let stream = endpoint.connect().await?;
            let binding = stream
                .get_ref()
                .1
                .export_keying_material([0; 32], remote_folder::EXPORTER, None)
                .map_err(|_| ErrorCode::PeerUntrusted)?;
            let body = folder.encode_typed_offer(&cap, id, local, peer, binding)?;
            let admitted: bool = pair_call_bytes(
                stream,
                endpoint.authority(),
                remote_folder::OFFER,
                body,
                Duration::from_secs(10),
            )
            .await?;
            if !admitted {
                return Err(ErrorCode::PeerUntrusted.into());
            }
            Ok::<_, TransferError>(())
        };
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(ErrorCode::Cancelled.into()),
            _ = grant.cancelled() => return Err(ErrorCode::PeerUntrusted.into()),
            result = negotiate => result?,
        }
        let sender = Sender::new(
            endpoint,
            Duration::from_secs(120),
            Duration::from_secs(1800),
        );
        folder
            .send_over(
                &sender,
                id,
                ReceiverCapabilities {
                    object_manifest_v1: true,
                },
                cancel,
                progress,
            )
            .await
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

    /// Enter private staging only for a completed Remote v2 receipt. The
    /// host must independently negotiate the admitted folder representation.
    pub fn stage_resumable_folder(
        &self,
        key: TransferKey,
        capability: aerift_transfer::ambient::ReceiverCapabilities,
        scratch: &std::path::Path,
        cancel: &CancellationToken,
    ) -> Result<aerift_transfer::folder::StagedFolder, TransferError> {
        self.receiver
            .stage_resumable_folder(key, capability, scratch, cancel)
    }

    /// Publish a verified Remote folder on a qualified Linux profile only.
    /// Caller must supply the native-selected destination and fixed profile ledger.
    #[cfg(target_os = "linux")]
    pub fn commit_resumable_folder(
        &self,
        key: TransferKey,
        capability: aerift_transfer::ambient::ReceiverCapabilities,
        destination: aerift_transfer::folder::FolderExport<'_>,
        cancel: &CancellationToken,
    ) -> Result<String, TransferError> {
        self.receiver
            .commit_resumable_folder(key, capability, destination, cancel)
    }

    pub fn cancel(&self, key: TransferKey) -> Result<Status, TransferError> {
        self.receiver.cancel(key)
    }
}

pub(crate) fn parse_invitation(code: &str) -> Result<RedeemCode, TransferError> {
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
