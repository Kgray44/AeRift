use std::{convert::Infallible, future::Future, net::SocketAddr, sync::Arc, time::Duration};

use aerift_transfer::{
    Connector, ErrorCode, PeerId, Receiver, Sender, TransferError, serve_request,
};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{Method, Request, Response, StatusCode, body::Incoming, header, service::service_fn};
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    task::JoinSet,
    time::timeout,
};
use tokio_rustls::{TlsAcceptor, TlsConnector, client::TlsStream, rustls::pki_types::ServerName};
use tokio_util::sync::CancellationToken;

use crate::{
    Device, Identity, Pairing, Platform, TrustStore,
    nearby::{self, Nearby, NearbyChallenge, NearbyPending},
    pairing::{PairRequest, RedeemCode},
    remote_folder::{self, RemoteFolderIngress},
};

/// An explicitly installed native Nearby Ambient hook. No generic transfer
/// or Remote listener can supply this callback.
pub type NearbyAmbientHook = Arc<
    dyn Fn() -> Option<(
            Option<Arc<aerift_transfer::ambient::nearby_drop::NearbyDrop>>,
            CancellationToken,
        )> + Send
        + Sync,
>;

struct NearbyAuthority<F>(F);
impl<F: Fn(PeerId) -> bool> aerift_transfer::ambient::session::DropAuthority
    for NearbyAuthority<F>
{
    fn permits(&self, peer: PeerId, lane: aerift_transfer::ambient::session::Lane) -> bool {
        lane == aerift_transfer::ambient::session::Lane::Nearby && (self.0)(peer)
    }
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
// Reserve part of the existing total budget for alternatives. A single LAN
// address still receives the full original timeout.
const ALTERNATE_PROBE_TIMEOUT: Duration = Duration::from_millis(280);
const MAX_ROUTES: usize = 4;
const REDEEM_TIMEOUT: Duration = Duration::from_secs(315);
const CONTROL_LIMIT: usize = 16 * 1024;
const PAIR_ROUTE: &str = "/v1/pair";
const REMOTE_PAIR_ROUTE: &str = "/remote/v1/pair";

#[derive(Clone, Copy)]
pub(crate) enum Lane {
    Nearby,
    Remote,
}

impl Lane {
    fn pair_route(self) -> &'static str {
        match self {
            Self::Nearby => PAIR_ROUTE,
            Self::Remote => REMOTE_PAIR_ROUTE,
        }
    }

    fn alpn(self) -> &'static [u8] {
        match self {
            Self::Nearby => b"http/1.1",
            Self::Remote => b"aerift-remote/1",
        }
    }
}

pub struct PeerNode {
    identity: Identity,
    pairing: Arc<Pairing>,
    receiver: Arc<Receiver>,
    lane: Lane,
    nearby: Option<Arc<Nearby>>,
}

impl PeerNode {
    pub fn new(
        identity: Identity,
        name: String,
        platform: Platform,
        store: Arc<dyn TrustStore>,
        receiver: Arc<Receiver>,
    ) -> Result<Self, TransferError> {
        Self::with_lane(identity, name, platform, store, receiver, Lane::Nearby)
    }

    pub(crate) fn with_lane(
        identity: Identity,
        name: String,
        platform: Platform,
        store: Arc<dyn TrustStore>,
        receiver: Arc<Receiver>,
        lane: Lane,
    ) -> Result<Self, TransferError> {
        let device = Device {
            id: identity.id(),
            name,
            platform,
        };
        Ok(Self {
            identity,
            pairing: Arc::new(Pairing::new(device, store)?),
            receiver,
            lane,
            nearby: matches!(lane, Lane::Nearby).then(|| Arc::new(Nearby::new())),
        })
    }

    pub(crate) fn identity(&self) -> &Identity {
        &self.identity
    }

    pub fn pairing(&self) -> &Pairing {
        &self.pairing
    }

    pub fn revoke(&self, peer: PeerId) -> Result<(), TransferError> {
        if let Some(nearby) = &self.nearby {
            nearby.cancel(Some(peer));
        }
        let result = self.pairing.remove_trust(peer);
        self.receiver.expire_offers();
        result
    }

    pub fn sender(
        &self,
        endpoint: SocketAddr,
        peer: PeerId,
        decision_timeout: Duration,
        upload_timeout: Duration,
    ) -> Result<Sender<PinnedEndpoint>, TransferError> {
        self.sender_with_routes(&[endpoint], peer, decision_timeout, upload_timeout)
    }

    /// Use ordered, locally configured routes for an already trusted identity.
    /// An unavailable socket may fall back; an authentication error may not.
    pub(crate) fn sender_with_routes(
        &self,
        addresses: &[SocketAddr],
        peer: PeerId,
        decision_timeout: Duration,
        upload_timeout: Duration,
    ) -> Result<Sender<PinnedEndpoint>, TransferError> {
        let trust = self.pairing.trust(peer).ok_or(ErrorCode::PeerUntrusted)?;
        let endpoint = self.endpoint(addresses, peer, Some(trust))?;
        Ok(Sender::new(endpoint, decision_timeout, upload_timeout))
    }

    pub fn invitation_peer(code: &str) -> Result<PeerId, TransferError> {
        Ok(RedeemCode::parse(code)?.peer)
    }

    /// The native host can use a DNS-SD result or a manually supplied address.
    pub async fn redeem(&self, endpoint: SocketAddr, code: &str) -> Result<Device, TransferError> {
        self.redeem_with_routes(&[endpoint], RedeemCode::parse(code)?)
            .await
    }

    /// Send the invitation only after TLS authenticates its embedded peer identity.
    pub(crate) async fn redeem_with_routes(
        &self,
        addresses: &[SocketAddr],
        code: RedeemCode,
    ) -> Result<Device, TransferError> {
        let connection = self.endpoint(addresses, code.peer, None)?;
        self.redeem_over(connection, code, None).await
    }

    pub(crate) async fn redeem_over(
        &self,
        connection: impl Connector,
        code: RedeemCode,
        wan_key: Option<[u8; 32]>,
    ) -> Result<Device, TransferError> {
        let admission = self.pairing.begin_outbound(code.peer)?;
        let wan_stopped = wan_key
            .map(|key| self.pairing.wan_preflight(code.peer, key))
            .transpose()?;
        let device = self.pairing.device();
        let request = PairRequest {
            token: code.token,
            name: device.name.clone(),
            platform: device.platform,
        };
        let request = serde_json::to_vec(&request).map_err(|_| ErrorCode::InternalError)?;
        let exchange = pair_remote(connection, self.lane.pair_route(), request);
        let reply = if let Some(stopped) = wan_stopped {
            tokio::select! {
                biased;
                _ = stopped.cancelled() => return Err(ErrorCode::PeerUntrusted.into()),
                _ = admission.cancelled() => return Err(ErrorCode::PeerUntrusted.into()),
                response = exchange => response?,
            }
        } else {
            exchange.await?
        };
        if reply.id != code.peer {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        if let Some(key) = wan_key {
            self.pairing
                .record_wan_outbound(reply.clone(), &admission, key)?;
        } else {
            self.pairing.record_outbound(reply.clone(), &admission)?;
        }
        Ok(reply)
    }

    pub fn subscribe_nearby(&self) -> tokio::sync::watch::Receiver<Option<NearbyPending>> {
        self.nearby.as_ref().map_or_else(
            || tokio::sync::watch::channel(None).1,
            |nearby| nearby.subscribe(),
        )
    }

    pub fn confirm_nearby(&self, id: uuid::Uuid, approve: bool) -> Result<(), TransferError> {
        self.nearby
            .as_ref()
            .ok_or(ErrorCode::UnsupportedVersion)?
            .confirm(id, approve)
    }

    pub fn cancel_nearby(&self) {
        if let Some(nearby) = &self.nearby {
            nearby.cancel(None);
        }
    }

    pub async fn begin_nearby(
        &self,
        endpoint: SocketAddr,
        peer: PeerId,
    ) -> Result<NearbyChallenge, TransferError> {
        if self.nearby.is_none() {
            return Err(ErrorCode::UnsupportedVersion.into());
        }
        if self.pairing.is_trusted(peer) || peer == self.pairing.device().id {
            return Err(ErrorCode::PairingRejected.into());
        }
        let admission = self.pairing.begin_outbound(peer)?;
        let connection = self.endpoint(&[endpoint], peer, None)?;
        let socket = connection.connect().await?;
        let mine = self.pairing.device();
        let context = nearby::context(mine.id, peer);
        let code = socket
            .get_ref()
            .1
            .export_keying_material([0; 8], nearby::EXPORTER, Some(&context))
            .map(nearby::digits)
            .map_err(|_| ErrorCode::PeerUntrusted)?;
        let request = nearby::Start {
            name: mine.name.clone(),
            platform: mine.platform,
        };
        let started: nearby::Started = pair_call(
            socket,
            &connection,
            nearby::START,
            &request,
            CONNECT_TIMEOUT,
        )
        .await?;
        if started.device.id != peer {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        if admission.is_cancelled() {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        Ok(NearbyChallenge::new(started, endpoint, code, admission))
    }

    pub async fn finish_nearby(
        &self,
        challenge: NearbyChallenge,
        accept: bool,
    ) -> Result<Option<Device>, TransferError> {
        if self.nearby.is_none() {
            return Err(ErrorCode::UnsupportedVersion.into());
        }
        if challenge.expires_at <= std::time::SystemTime::now() {
            return Err(ErrorCode::PairingExpired.into());
        }
        if challenge.admission.is_cancelled() {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        let connection = self.endpoint(&[challenge.endpoint], challenge.device.id, None)?;
        let socket = connection.connect().await?;
        let request = nearby::Finish {
            id: challenge.id,
            accept,
        };
        let reply: Option<Device> =
            pair_call(socket, &connection, nearby::FINISH, &request, nearby::TTL).await?;
        if !accept {
            return Ok(None);
        }
        let device = reply.ok_or(ErrorCode::PairingRejected)?;
        if device.id != challenge.device.id {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        self.pairing
            .record_outbound(device.clone(), &challenge.admission)?;
        Ok(Some(device))
    }

    /// Start on an address chosen by the native platform, then publish its bound port
    /// via DNS-SD. A single listener handles both pairing and transfer.
    pub async fn serve(
        &self,
        listener: TcpListener,
        shutdown: CancellationToken,
    ) -> Result<(), TransferError> {
        self.serve_scoped(listener, shutdown, None, None, None)
            .await
    }

    /// Explicitly attach native Nearby discovery policy to the legacy LAN lane.
    /// Remote constructs its own scoped listener and cannot attach a Nearby policy.
    pub async fn serve_with_nearby(
        &self,
        listener: TcpListener,
        shutdown: CancellationToken,
        is_nearby: impl Fn(PeerId, SocketAddr) -> bool + Send + Sync + 'static,
    ) -> Result<(), TransferError> {
        if self.nearby.is_none() {
            return Err(ErrorCode::UnsupportedVersion.into());
        }
        self.serve_scoped(listener, shutdown, Some(Arc::new(is_nearby)), None, None)
            .await
    }

    pub async fn serve_with_nearby_ambient(
        &self,
        listener: TcpListener,
        shutdown: CancellationToken,
        is_nearby: impl Fn(PeerId, SocketAddr) -> bool + Send + Sync + 'static,
        ambient: NearbyAmbientHook,
    ) -> Result<(), TransferError> {
        if !matches!(self.lane, Lane::Nearby) || self.nearby.is_none() {
            return Err(ErrorCode::UnsupportedVersion.into());
        }
        self.serve_scoped(
            listener,
            shutdown,
            Some(Arc::new(is_nearby)),
            Some(ambient),
            None,
        )
        .await
    }

    pub(crate) async fn serve_with_folders(
        &self,
        listener: TcpListener,
        shutdown: CancellationToken,
        folders: Arc<RemoteFolderIngress>,
    ) -> Result<(), TransferError> {
        if !matches!(self.lane, Lane::Remote) {
            return Err(ErrorCode::UnsupportedVersion.into());
        }
        self.serve_scoped(listener, shutdown, None, None, Some(folders))
            .await
    }

    async fn serve_scoped(
        &self,
        listener: TcpListener,
        shutdown: CancellationToken,
        is_nearby: Option<Arc<dyn Fn(PeerId, SocketAddr) -> bool + Send + Sync>>,
        ambient: Option<NearbyAmbientHook>,
        folders: Option<Arc<RemoteFolderIngress>>,
    ) -> Result<(), TransferError> {
        let lane = self.lane;
        // Dedicated intake capabilities are never attached across lanes or
        // simultaneously; ordinary file listeners need neither.
        if (is_nearby.is_some() && !matches!(lane, Lane::Nearby))
            || (ambient.is_some() && is_nearby.is_none())
            || (folders.is_some()
                && (!matches!(lane, Lane::Remote) || ambient.is_some() || is_nearby.is_some()))
        {
            return Err(ErrorCode::UnsupportedVersion.into());
        }
        let nearby = is_nearby.zip(self.nearby.clone());
        let mut config = self.identity.server_config()?;
        config.alpn_protocols = vec![lane.alpn().to_vec()];
        if folders.is_some() {
            config.alpn_protocols.push(remote_folder::ALPN.to_vec());
        }
        let tls = TlsAcceptor::from(Arc::new(config));
        let connections = Arc::new(Semaphore::new(48));
        let unknown = Arc::new(Semaphore::new(8));
        let mut tasks = JoinSet::new();
        let mut housekeeping = tokio::time::interval(Duration::from_secs(5));
        loop {
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => break,
                _ = housekeeping.tick() => {
                    self.receiver.expire_offers();
                    self.pairing.expire_invitation();
                    if let Some(nearby) = &self.nearby { nearby.expire(); }
                    if let Some(folders) = &folders { folders.expire(); }
                }
                _ = tasks.join_next(), if !tasks.is_empty() => {}
                next = listener.accept() => {
                    let (socket, source) = next.map_err(|_| ErrorCode::NetworkError)?;
                    let Ok(permit) = Arc::clone(&connections).try_acquire_owned() else { continue };
                    let tls = tls.clone();
                    let pairing = Arc::clone(&self.pairing);
                    let receiver = Arc::clone(&self.receiver);
                    let unknown = Arc::clone(&unknown);
                    let nearby = nearby.clone();
                    let ambient = ambient.clone();
                    let folders = folders.clone();
                    tasks.spawn(async move {
                        let _permit = permit;
                        let Ok(Ok(stream)) = timeout(CONNECT_TIMEOUT, tls.accept(socket)).await else { return };
                        let session = stream.get_ref().1;
                        let folder_protocol = session.alpn_protocol() == Some(remote_folder::ALPN);
                        if !folder_protocol && session.alpn_protocol() != Some(lane.alpn()) { return; }
                        let Some(leaf) = session.peer_certificates().and_then(|chain| chain.first()) else { return };
                        let peer = PeerId::from_tls_leaf(leaf.as_ref());
                        let local = pairing.device().id;
                        let folder_binding = if folder_protocol {
                            if folders.is_none() || !pairing.is_trusted(peer) { return; }
                            match session.export_keying_material([0; 32], remote_folder::EXPORTER, None) {
                                Ok(binding) => Some(binding),
                                Err(_) => return,
                            }
                        } else { None };
                        let trusted = pairing.is_trusted(peer);
                        let _untrusted = if trusted {
                            None
                        } else {
                            let Ok(permit) = unknown.try_acquire_owned() else { return };
                            Some(permit)
                        };
                        let nearby_secret = nearby.as_ref().filter(|_| !trusted).and_then(|_| {
                            let context = nearby::context(peer, pairing.device().id);
                            session.export_keying_material([0; 8], nearby::EXPORTER, Some(&context)).ok()
                        });
                        let service = service_fn(|request: Request<Incoming>| {
                            let nearby_request = matches!(request.uri().path(), nearby::START | nearby::FINISH);
                            let nearby = nearby.clone();
                            let pairing = Arc::clone(&pairing);
                            let ambient = ambient.clone();
                            let receiver = Arc::clone(&receiver);
                            let folders = folders.clone();
                            async move {
                                let response = if let Some(binding) = folder_binding {
                                    match (folders, pairing.trust(peer)) {
                                        (Some(folders), Some(grant)) => folders.route(request, peer, local, binding, grant).await,
                                        _ => error(ErrorCode::PeerUntrusted.into()),
                                    }
                                } else if nearby_request {
                                    match nearby {
                                        Some((is_nearby, state)) if is_nearby(peer, source) =>
                                            nearby_route(request, peer, &pairing, &state, nearby_secret).await,
                                        _ => error(ErrorCode::PeerUnavailable.into()),
                                    }
                                } else if request.uri().path() == aerift_transfer::ambient::nearby_drop::PATH
                                    && ambient.is_some() {
                                    use aerift_transfer::ambient::{nearby_drop::NearbyDrop, session::Lane as DropLane};
                                    let permit = |id| nearby.as_ref().is_some_and(|(scope, _)| scope(id, source))
                                        && pairing.is_trusted(id);
                                    let authority = NearbyAuthority(permit);
                                    if !permit(peer) {
                                        error(ErrorCode::PeerUntrusted.into())
                                    } else if let (Some(grant), Some((pickup, generation))) =
                                        (pairing.trust(peer), ambient.as_ref().and_then(|hook| hook()))
                                    {
                                        tokio::select! {
                                            biased;
                                            _ = grant.cancelled() => error(ErrorCode::PeerUntrusted.into()),
                                            _ = generation.cancelled() => error(ErrorCode::PeerUntrusted.into()),
                                            reply = async {
                                                match pickup {
                                                    Some(pickup) => pickup.handle_authenticated(
                                                        request, peer, DropLane::Nearby, &grant, &authority).await,
                                                    None => NearbyDrop::availability(
                                                        None, request, peer, DropLane::Nearby, &grant, &authority),
                                                }
                                            } => reply,
                                        }
                                    } else {
                                        error(ErrorCode::UnsupportedVersion.into())
                                    }
                                } else {
                                    route(request, peer, pairing, receiver, lane).await
                                };
                                Ok::<_, Infallible>(response)
                            }
                        });
                        let _ = hyper::server::conn::http1::Builder::new()
                            .timer(TokioTimer::new())
                            .header_read_timeout(CONNECT_TIMEOUT)
                            .max_buf_size(32 * 1024)
                            .keep_alive(false)
                            .serve_connection(TokioIo::new(stream), service).await;
                    });
                }
            }
        }
        tasks.shutdown().await;
        Ok(())
    }

    pub(crate) async fn serve_bound_remote<S>(
        &self,
        stream: S,
        expected: PeerId,
        untrusted: &Semaphore,
        pairing_only: bool,
    ) -> Result<(), TransferError>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let lane = Lane::Remote;
        let mut config = self.identity.server_config()?;
        config.alpn_protocols = vec![lane.alpn().to_vec()];
        serve_stream(
            stream,
            TlsAcceptor::from(Arc::new(config)),
            self.pairing.clone(),
            self.receiver.clone(),
            lane,
            expected,
            untrusted,
            pairing_only,
        )
        .await
    }

    pub(crate) fn routed_endpoint<R>(
        &self,
        route: R,
        expected: PeerId,
        require_grant: bool,
    ) -> Result<RoutedPinnedEndpoint<R>, TransferError>
    where
        R: RemoteRoute,
    {
        let trust = if require_grant {
            Some(
                self.pairing
                    .trust(expected)
                    .ok_or(ErrorCode::PeerUntrusted)?,
            )
        } else {
            None
        };
        self.routed_endpoint_with_lease(route, expected, trust)
    }

    pub(crate) fn routed_endpoint_with_lease<R: RemoteRoute>(
        &self,
        route: R,
        expected: PeerId,
        trust: Option<CancellationToken>,
    ) -> Result<RoutedPinnedEndpoint<R>, TransferError> {
        let mut config = self.identity.client_config(expected)?;
        config.alpn_protocols = vec![Lane::Remote.alpn().to_vec()];
        Ok(RoutedPinnedEndpoint {
            route,
            tls: TlsConnector::from(Arc::new(config)),
            trust,
        })
    }

    pub(crate) fn folder_endpoint(
        &self,
        addresses: &[SocketAddr],
        peer: PeerId,
    ) -> Result<PinnedEndpoint, TransferError> {
        if !matches!(self.lane, Lane::Remote) {
            return Err(ErrorCode::UnsupportedVersion.into());
        }
        let grant = self.pairing.trust(peer).ok_or(ErrorCode::PeerUntrusted)?;
        pinned_endpoint(
            &self.identity,
            addresses,
            peer,
            Some(grant),
            remote_folder::ALPN,
        )
    }

    fn endpoint(
        &self,
        addresses: &[SocketAddr],
        peer: PeerId,
        trust: Option<CancellationToken>,
    ) -> Result<PinnedEndpoint, TransferError> {
        pinned_endpoint(&self.identity, addresses, peer, trust, self.lane.alpn())
    }
}

async fn serve_stream<S>(
    socket: S,
    tls: TlsAcceptor,
    pairing: Arc<Pairing>,
    receiver: Arc<Receiver>,
    lane: Lane,
    expected: PeerId,
    untrusted: &Semaphore,
    pairing_only: bool,
) -> Result<(), TransferError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let stream = timeout(CONNECT_TIMEOUT, tls.accept(socket))
        .await
        .map_err(|_| ErrorCode::PeerUnavailable)?
        .map_err(|_| ErrorCode::PeerUntrusted)?;
    let session = stream.get_ref().1;
    if session.alpn_protocol() != Some(lane.alpn()) {
        return Err(ErrorCode::UnsupportedVersion.into());
    }
    let leaf = session
        .peer_certificates()
        .and_then(|chain| chain.first())
        .ok_or(ErrorCode::PeerUntrusted)?;
    let peer = PeerId::from_tls_leaf(leaf.as_ref());
    if expected != peer {
        return Err(ErrorCode::PeerUntrusted.into());
    }
    let _untrusted = if !pairing_only && pairing.is_trusted(peer) {
        None
    } else {
        Some(
            untrusted
                .try_acquire()
                .map_err(|_| ErrorCode::PeerUnavailable)?,
        )
    };
    let service = service_fn(|request| {
        let pairing = Arc::clone(&pairing);
        let receiver = Arc::clone(&receiver);
        async move {
            let response = if pairing_only && request.uri().path() != lane.pair_route() {
                error(ErrorCode::PeerUntrusted.into())
            } else {
                route(request, peer, pairing, receiver, lane).await
            };
            Ok::<_, Infallible>(response)
        }
    });
    hyper::server::conn::http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(CONNECT_TIMEOUT)
        .max_buf_size(32 * 1024)
        .keep_alive(false)
        .serve_connection(TokioIo::new(stream), service)
        .await
        .map_err(|_| ErrorCode::NetworkError.into())
}

/// One explicit, host-authorized byte-stream route. The host must bind the
/// route's outer identity to the inner certificate fingerprint before using it.
pub trait RemoteRoute: Send + Sync {
    type Stream: AsyncRead + AsyncWrite + Unpin + Send + 'static;

    fn dial(&self) -> impl Future<Output = Result<Self::Stream, TransferError>> + Send;
}

/// A non-TCP route with the same Remote-only TLS and grant policy as TCP.
pub struct RoutedPinnedEndpoint<R> {
    route: R,
    tls: TlsConnector,
    trust: Option<CancellationToken>,
}

impl<R: RemoteRoute> Connector for RoutedPinnedEndpoint<R> {
    type Stream = TlsStream<R::Stream>;

    async fn connect(&self) -> Result<Self::Stream, TransferError> {
        let handshake = async {
            let socket = self.route.dial().await?;
            let name = ServerName::try_from("aerift-remote.invalid")
                .map_err(|_| ErrorCode::InternalError)?;
            let stream = self
                .tls
                .connect(name, socket)
                .await
                .map_err(|_| ErrorCode::PeerUntrusted)?;
            if stream.get_ref().1.alpn_protocol() != Some(Lane::Remote.alpn()) {
                return Err(ErrorCode::UnsupportedVersion.into());
            }
            Ok(stream)
        };
        let bounded = timeout(CONNECT_TIMEOUT, handshake);
        if let Some(trust) = &self.trust {
            tokio::select! {
                biased;
                _ = trust.cancelled() => Err(ErrorCode::PeerUntrusted.into()),
                result = bounded => result.map_err(|_| ErrorCode::PeerUnavailable)?,
            }
        } else {
            bounded.await.map_err(|_| ErrorCode::PeerUnavailable)?
        }
    }

    fn authority(&self) -> &str {
        "aerift-remote.invalid"
    }

    fn trust_revoked(&self) -> Option<CancellationToken> {
        self.trust.clone()
    }
}

pub(crate) fn pinned_endpoint(
    identity: &Identity,
    addresses: &[SocketAddr],
    peer: PeerId,
    trust: Option<CancellationToken>,
    alpn: &'static [u8],
) -> Result<PinnedEndpoint, TransferError> {
    let addresses = validate_routes(addresses)?;
    let mut config = identity.client_config(peer)?;
    config.alpn_protocols = vec![alpn.to_vec()];
    Ok(PinnedEndpoint {
        authority: addresses[0].to_string(),
        addresses,
        tls: TlsConnector::from(Arc::new(config)),
        trust,
        alpn,
    })
}

fn validate_routes(addresses: &[SocketAddr]) -> Result<Vec<SocketAddr>, TransferError> {
    if addresses.is_empty() || addresses.len() > MAX_ROUTES {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let mut routes = Vec::with_capacity(addresses.len());
    for &address in addresses {
        if address.port() == 0 || address.ip().is_unspecified() || address.ip().is_multicast() {
            return Err(ErrorCode::InvalidRequest.into());
        }
        if !routes.contains(&address) {
            routes.push(address);
        }
    }
    Ok(routes)
}

pub struct PinnedEndpoint {
    addresses: Vec<SocketAddr>,
    authority: String,
    tls: TlsConnector,
    trust: Option<CancellationToken>,
    alpn: &'static [u8],
}

impl Connector for PinnedEndpoint {
    type Stream = TlsStream<TcpStream>;

    async fn connect(&self) -> Result<Self::Stream, TransferError> {
        if self
            .trust
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        let attempt = async {
            for (index, &address) in self.addresses.iter().enumerate() {
                let last = index + 1 == self.addresses.len();
                let budget = if last {
                    CONNECT_TIMEOUT
                } else {
                    ALTERNATE_PROBE_TIMEOUT
                };
                match timeout(budget, self.connect_address(address)).await {
                    Ok(Err(error)) if !last && error.code == ErrorCode::PeerUnavailable => continue,
                    Ok(result) => return result,
                    Err(_) if !last => continue,
                    Err(_) => return Err(ErrorCode::PeerUnavailable.into()),
                }
            }
            Err(ErrorCode::PeerUnavailable.into())
        };
        let bounded = timeout(CONNECT_TIMEOUT, attempt);
        if let Some(trust) = &self.trust {
            tokio::select! {
                biased;
                _ = trust.cancelled() => Err(ErrorCode::PeerUntrusted.into()),
                result = bounded => result.map_err(|_| ErrorCode::PeerUnavailable)?,
            }
        } else {
            bounded.await.map_err(|_| ErrorCode::PeerUnavailable)?
        }
    }

    fn authority(&self) -> &str {
        &self.authority
    }

    fn trust_revoked(&self) -> Option<CancellationToken> {
        self.trust.clone()
    }
}

impl PinnedEndpoint {
    async fn connect_address(
        &self,
        address: SocketAddr,
    ) -> Result<TlsStream<TcpStream>, TransferError> {
        let socket = TcpStream::connect(address)
            .await
            .map_err(|_| ErrorCode::PeerUnavailable)?;
        // The verifier ignores DNS trust and authenticates the expected pinned leaf.
        let name = ServerName::IpAddress(address.ip().into());
        let stream = self
            .tls
            .connect(name, socket)
            .await
            .map_err(|_| ErrorCode::PeerUntrusted)?;
        if stream.get_ref().1.alpn_protocol() != Some(self.alpn) {
            return Err(ErrorCode::UnsupportedVersion.into());
        }
        Ok(stream)
    }
}

pub(crate) type Reply = Response<Full<Bytes>>;

async fn route(
    request: Request<Incoming>,
    peer: PeerId,
    pairing: Arc<Pairing>,
    receiver: Arc<Receiver>,
    lane: Lane,
) -> Reply {
    if request.uri().path() != lane.pair_route() {
        return if let Some(trust) = pairing.trust(peer) {
            serve_request(request, peer, receiver, trust).await
        } else {
            error(ErrorCode::PeerUntrusted.into())
        };
    }
    if request.method() != Method::POST
        || request.uri().query().is_some()
        || request.version() != hyper::Version::HTTP_11
    {
        return error(ErrorCode::InvalidRequest.into());
    }
    let body = match timeout(
        CONNECT_TIMEOUT,
        Limited::new(request.into_body(), CONTROL_LIMIT).collect(),
    )
    .await
    {
        Ok(Ok(body)) => body.to_bytes(),
        Ok(Err(cause)) if cause.is::<http_body_util::LengthLimitError>() => {
            return reply(
                StatusCode::PAYLOAD_TOO_LARGE,
                &TransferError::from(ErrorCode::InvalidRequest),
            );
        }
        _ => return error(ErrorCode::InvalidRequest.into()),
    };
    let Ok(body) = serde_json::from_slice(&body) else {
        return error(ErrorCode::InvalidRequest.into());
    };
    match pairing.redeem(peer, body).await {
        Ok(device) => reply(StatusCode::OK, &device),
        Err(failure) => error(failure),
    }
}

async fn nearby_route(
    request: Request<Incoming>,
    peer: PeerId,
    pairing: &Pairing,
    nearby: &Nearby,
    secret: Option<[u8; 8]>,
) -> Reply {
    if request.method() != Method::POST
        || request.uri().query().is_some()
        || request.version() != hyper::Version::HTTP_11
    {
        return error(ErrorCode::InvalidRequest.into());
    }
    let start = request.uri().path() == nearby::START;
    let body = match timeout(
        CONNECT_TIMEOUT,
        Limited::new(request.into_body(), CONTROL_LIMIT).collect(),
    )
    .await
    {
        Ok(Ok(body)) => body.to_bytes(),
        _ => return error(ErrorCode::InvalidRequest.into()),
    };
    if start {
        let (Some(secret), Ok(request)) = (secret, serde_json::from_slice(&body)) else {
            return error(ErrorCode::InvalidRequest.into());
        };
        match nearby.start(request, peer, pairing, nearby::digits(secret)) {
            Ok(started) => reply(StatusCode::OK, &started),
            Err(failure) => error(failure),
        }
    } else {
        let Ok(request) = serde_json::from_slice(&body) else {
            return error(ErrorCode::InvalidRequest.into());
        };
        match nearby.finish(peer, request, pairing).await {
            Ok(finished) => reply(StatusCode::OK, &finished),
            Err(failure) => error(failure),
        }
    }
}

async fn pair_remote(
    endpoint: impl Connector,
    route: &str,
    data: Vec<u8>,
) -> Result<Device, TransferError> {
    let socket = endpoint.connect().await?;
    pair_call_bytes(socket, endpoint.authority(), route, data, REDEEM_TIMEOUT).await
}

async fn pair_call<T: serde::de::DeserializeOwned>(
    socket: TlsStream<TcpStream>,
    endpoint: &PinnedEndpoint,
    path: &str,
    data: &impl serde::Serialize,
    duration: Duration,
) -> Result<T, TransferError> {
    let data = serde_json::to_vec(data).map_err(|_| ErrorCode::InternalError)?;
    pair_call_bytes(socket, endpoint.authority(), path, data, duration).await
}

pub(crate) async fn pair_call_bytes<T: serde::de::DeserializeOwned>(
    socket: impl AsyncRead + AsyncWrite + Unpin + Send + 'static,
    authority: &str,
    path: &str,
    data: Vec<u8>,
    duration: Duration,
) -> Result<T, TransferError> {
    let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(socket))
        .await
        .map_err(|_| ErrorCode::NetworkError)?;
    let request = Request::post(path)
        .header(header::HOST, authority)
        .header(header::CONNECTION, "close")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(data)))
        .map_err(|_| ErrorCode::InvalidRequest)?;
    let result = async move {
        let response = sender
            .send_request(request)
            .await
            .map_err(|_| ErrorCode::NetworkError)?;
        let status = response.status();
        let body = Limited::new(response.into_body(), CONTROL_LIMIT)
            .collect()
            .await
            .map_err(|_| ErrorCode::NetworkError)?
            .to_bytes();
        if status != StatusCode::OK {
            return Err(
                serde_json::from_slice(&body).unwrap_or_else(|_| ErrorCode::NetworkError.into())
            );
        }
        serde_json::from_slice(&body).map_err(|_| ErrorCode::NetworkError.into())
    };
    timeout(duration, async {
        tokio::pin!(result);
        tokio::select! {
            biased;
            value = &mut result => value,
            _ = conn => result.await,
        }
    })
    .await
    .map_err(|_| ErrorCode::PairingExpired)?
}

pub(crate) fn error(failure: TransferError) -> Reply {
    let status = match failure.code {
        ErrorCode::PeerUnavailable => StatusCode::NOT_FOUND,
        ErrorCode::PairingExpired => StatusCode::GONE,
        ErrorCode::InvalidRequest => StatusCode::BAD_REQUEST,
        ErrorCode::PairingRejected | ErrorCode::PeerUntrusted => StatusCode::FORBIDDEN,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    reply(status, &failure)
}

pub(crate) fn reply(status: StatusCode, value: &impl serde::Serialize) -> Reply {
    let encoded = serde_json::to_vec(value).expect("serializable pairing response");
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(encoded)))
        .expect("static headers")
}

#[cfg(test)]
mod route_tests {
    use super::*;
    use crate::SecretStore;

    struct FreshIdentity;
    impl SecretStore for FreshIdentity {
        fn load(&self) -> Result<Option<Vec<u8>>, TransferError> {
            Ok(None)
        }

        fn initialize(&self, candidate: &[u8]) -> Result<Vec<u8>, TransferError> {
            Ok(candidate.to_vec())
        }
    }

    fn endpoint(addresses: &[SocketAddr], expected: PeerId) -> PinnedEndpoint {
        let client = Identity::load_or_create(&FreshIdentity).unwrap();
        pinned_endpoint(&client, addresses, expected, None, Lane::Nearby.alpn()).unwrap()
    }

    async fn tls_listener(identity: &Identity) -> (TcpListener, TlsAcceptor) {
        (
            TcpListener::bind("127.0.0.1:0").await.unwrap(),
            TlsAcceptor::from(Arc::new(identity.server_config().unwrap())),
        )
    }

    #[test]
    fn route_validation_preserves_order_and_bounds_input() {
        let a = "127.0.0.1:1234".parse().unwrap();
        let b = "100.64.0.3:1234".parse().unwrap();
        assert_eq!(validate_routes(&[a, a, b, a]).unwrap(), [a, b]);
        for bad in [
            vec![],
            vec![a; MAX_ROUTES + 1],
            vec!["0.0.0.0:1234".parse().unwrap()],
            vec!["224.0.0.1:1234".parse().unwrap()],
            vec!["127.0.0.1:0".parse().unwrap()],
        ] {
            assert_eq!(
                validate_routes(&bad).unwrap_err().code,
                ErrorCode::InvalidRequest
            );
        }
    }

    #[tokio::test]
    async fn unreachable_route_falls_back_to_authenticated_peer() {
        let unavailable = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let missing_addr = unavailable.local_addr().unwrap();
        let identity = Identity::load_or_create(&FreshIdentity).unwrap();
        let (listener, tls) = tls_listener(&identity).await;
        let address = listener.local_addr().unwrap();
        drop(unavailable);
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            tls.accept(socket).await.unwrap()
        });
        let candidate = endpoint(&[missing_addr, address], identity.id());
        let connection = candidate.connect().await;
        assert!(connection.is_ok());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn trust_revocation_interrupts_an_inflight_handshake() {
        let stalled = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = stalled.local_addr().unwrap();
        let identity = Identity::load_or_create(&FreshIdentity).unwrap();
        let trust = CancellationToken::new();
        let mut candidate = endpoint(&[address], identity.id());
        candidate.trust = Some(trust.clone());
        let server = async {
            let (_socket, _) = stalled.accept().await.unwrap();
            trust.cancel();
        };
        let (result, ()) = tokio::join!(candidate.connect(), server);
        assert_eq!(result.err().unwrap().code, ErrorCode::PeerUntrusted);
    }

    #[tokio::test]
    async fn wrong_pin_does_not_fall_back_to_an_alternate_route() {
        let wrong = Identity::load_or_create(&FreshIdentity).unwrap();
        let expected = Identity::load_or_create(&FreshIdentity).unwrap();
        let (first, tls) = tls_listener(&wrong).await;
        let first_addr = first.local_addr().unwrap();
        let (second, _) = tls_listener(&expected).await;
        let second_addr = second.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = first.accept().await.unwrap();
            // Expected fatal alert from the client before app data can be sent.
            assert!(tls.accept(socket).await.is_err());
        });
        let candidate = endpoint(&[first_addr, second_addr], expected.id());
        let result = candidate.connect().await;
        assert_eq!(result.err().unwrap().code, ErrorCode::PeerUntrusted);
        server.await.unwrap();
        assert!(
            timeout(Duration::from_millis(50), second.accept())
                .await
                .is_err()
        );
    }
}

#[cfg(test)]
#[path = "network/remote_folder_qualification.rs"]
mod remote_folder_qualification;
