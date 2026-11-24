use std::{convert::Infallible, net::SocketAddr, sync::Arc, time::Duration};

use aerift_transfer::{
    Connector, ErrorCode, PeerId, Receiver, Sender, TransferError, serve_request,
};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{Method, Request, Response, StatusCode, body::Incoming, header, service::service_fn};
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::{
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
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REDEEM_TIMEOUT: Duration = Duration::from_secs(315);
const CONTROL_LIMIT: usize = 16 * 1024;
const PAIR_ROUTE: &str = "/v1/pair";

pub struct PeerNode {
    identity: Identity,
    pairing: Arc<Pairing>,
    receiver: Arc<Receiver>,
    nearby: Arc<Nearby>,
}

impl PeerNode {
    pub fn new(
        identity: Identity,
        name: String,
        platform: Platform,
        store: Arc<dyn TrustStore>,
        receiver: Arc<Receiver>,
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
            nearby: Arc::new(Nearby::new()),
        })
    }

    pub fn pairing(&self) -> &Pairing {
        &self.pairing
    }

    pub fn revoke(&self, peer: PeerId) -> Result<(), TransferError> {
        self.nearby.cancel(Some(peer));
        self.pairing.remove_trust(peer)?;
        self.receiver.expire_offers();
        Ok(())
    }

    pub fn sender(
        &self,
        endpoint: SocketAddr,
        peer: PeerId,
        decision_timeout: Duration,
        upload_timeout: Duration,
    ) -> Result<Sender<PinnedEndpoint>, TransferError> {
        let trust = self.pairing.trust(peer).ok_or(ErrorCode::PeerUntrusted)?;
        let endpoint = self.endpoint(endpoint, peer, Some(trust))?;
        Ok(Sender::new(endpoint, decision_timeout, upload_timeout))
    }

    pub fn invitation_peer(code: &str) -> Result<PeerId, TransferError> {
        Ok(RedeemCode::parse(code)?.peer)
    }

    /// The native host can use a DNS-SD result or a manually supplied LAN address.
    pub async fn redeem(&self, endpoint: SocketAddr, code: &str) -> Result<Device, TransferError> {
        let code = RedeemCode::parse(code)?;
        let connection = self.endpoint(endpoint, code.peer, None)?;
        let device = self.pairing.device();
        let request = PairRequest {
            token: code.token,
            name: device.name.clone(),
            platform: device.platform,
        };
        let request = serde_json::to_vec(&request).map_err(|_| ErrorCode::InternalError)?;
        let reply = pair_remote(connection, request).await?;
        if reply.id != code.peer {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        self.pairing.record_remote(reply.clone())?;
        Ok(reply)
    }

    pub fn subscribe_nearby(&self) -> tokio::sync::watch::Receiver<Option<NearbyPending>> {
        self.nearby.subscribe()
    }

    pub fn confirm_nearby(&self, id: uuid::Uuid, approve: bool) -> Result<(), TransferError> {
        self.nearby.confirm(id, approve)
    }

    pub fn cancel_nearby(&self) {
        self.nearby.cancel(None);
    }

    pub async fn begin_nearby(
        &self,
        endpoint: SocketAddr,
        peer: PeerId,
    ) -> Result<NearbyChallenge, TransferError> {
        if self.pairing.is_trusted(peer) || peer == self.pairing.device().id {
            return Err(ErrorCode::PairingRejected.into());
        }
        let connection = self.endpoint(endpoint, peer, None)?;
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
        Ok(NearbyChallenge::new(started, endpoint, code))
    }

    pub async fn finish_nearby(
        &self,
        challenge: NearbyChallenge,
        accept: bool,
    ) -> Result<Option<Device>, TransferError> {
        if challenge.expires_at <= std::time::SystemTime::now() {
            return Err(ErrorCode::PairingExpired.into());
        }
        let connection = self.endpoint(challenge.endpoint, challenge.device.id, None)?;
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
        self.pairing.record_remote(device.clone())?;
        Ok(Some(device))
    }

    /// Start on an address chosen by the native platform, then publish its bound port
    /// via DNS-SD. A single listener handles both pairing and transfer.
    pub async fn serve(
        &self,
        listener: TcpListener,
        shutdown: CancellationToken,
    ) -> Result<(), TransferError> {
        self.serve_with_nearby(listener, shutdown, |_, _| false)
            .await
    }

    /// Only native, discovered on-link candidates may enter Nearby pairing.
    /// Other transports use `serve`, where Nearby pairing is unavailable.
    pub async fn serve_with_nearby(
        &self,
        listener: TcpListener,
        shutdown: CancellationToken,
        is_nearby: impl Fn(PeerId, SocketAddr) -> bool + Send + Sync + 'static,
    ) -> Result<(), TransferError> {
        let is_nearby = Arc::new(is_nearby);
        let tls = TlsAcceptor::from(Arc::new(self.identity.server_config()?));
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
                    self.nearby.expire();
                }
                _ = tasks.join_next(), if !tasks.is_empty() => {}
                next = listener.accept() => {
                    let (socket, source) = next.map_err(|_| ErrorCode::NetworkError)?;
                    let Ok(permit) = Arc::clone(&connections).try_acquire_owned() else { continue };
                    let tls = tls.clone();
                    let pairing = Arc::clone(&self.pairing);
                    let receiver = Arc::clone(&self.receiver);
                    let unknown = Arc::clone(&unknown);
                    let nearby = Arc::clone(&self.nearby);
                    let is_nearby = Arc::clone(&is_nearby);
                    tasks.spawn(async move {
                        let _permit = permit;
                        let Ok(Ok(stream)) = timeout(CONNECT_TIMEOUT, tls.accept(socket)).await else { return };
                        let session = stream.get_ref().1;
                        if session.alpn_protocol() != Some(&b"http/1.1"[..]) { return; }
                        let Some(leaf) = session.peer_certificates().and_then(|chain| chain.first()) else { return };
                        let peer = PeerId::from_tls_leaf(leaf.as_ref());
                        let _untrusted = if pairing.is_trusted(peer) {
                            None
                        } else {
                            let Ok(permit) = unknown.try_acquire_owned() else { return };
                            Some(permit)
                        };
                        let context = nearby::context(peer, pairing.device().id);
                        let nearby_secret = session.export_keying_material([0; 8], nearby::EXPORTER, Some(&context)).ok();
                        let service = service_fn(|request: Request<Incoming>| {
                            let nearby_request = matches!(request.uri().path(), nearby::START | nearby::FINISH);
                            let nearby_permission = !nearby_request || is_nearby(peer, source);
                            let nearby = Arc::clone(&nearby);
                            let pairing = Arc::clone(&pairing);
                            let receiver = Arc::clone(&receiver);
                            async move {
                                let response = if nearby_request {
                                    if nearby_permission {
                                        nearby_route(request, peer, &pairing, &nearby, nearby_secret).await
                                    } else {
                                        error(ErrorCode::PeerUnavailable.into())
                                    }
                                } else {
                                    route(request, peer, pairing, receiver).await
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

    fn endpoint(
        &self,
        address: SocketAddr,
        peer: PeerId,
        trust: Option<CancellationToken>,
    ) -> Result<PinnedEndpoint, TransferError> {
        if address.port() == 0 || address.ip().is_unspecified() || address.ip().is_multicast() {
            return Err(ErrorCode::InvalidRequest.into());
        }
        Ok(PinnedEndpoint {
            address,
            authority: address.to_string(),
            tls: TlsConnector::from(Arc::new(self.identity.client_config(peer)?)),
            trust,
        })
    }
}

pub struct PinnedEndpoint {
    address: SocketAddr,
    authority: String,
    tls: TlsConnector,
    trust: Option<CancellationToken>,
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
        timeout(CONNECT_TIMEOUT, async {
            let socket = TcpStream::connect(self.address)
                .await
                .map_err(|_| ErrorCode::PeerUnavailable)?;
            // The certificate verifier validates the expected fingerprint.
            let name = ServerName::IpAddress(self.address.ip().into());
            let stream = self
                .tls
                .connect(name, socket)
                .await
                .map_err(|_| ErrorCode::PeerUntrusted)?;
            if stream.get_ref().1.alpn_protocol() != Some(&b"http/1.1"[..]) {
                return Err(ErrorCode::UnsupportedVersion.into());
            }
            Ok(stream)
        })
        .await
        .map_err(|_| ErrorCode::PeerUnavailable)?
    }

    fn authority(&self) -> &str {
        &self.authority
    }

    fn trust_revoked(&self) -> Option<CancellationToken> {
        self.trust.clone()
    }
}

type Reply = Response<Full<Bytes>>;

async fn route(
    request: Request<Incoming>,
    peer: PeerId,
    pairing: Arc<Pairing>,
    receiver: Arc<Receiver>,
) -> Reply {
    if request.uri().path() != PAIR_ROUTE {
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

async fn pair_remote(endpoint: PinnedEndpoint, data: Vec<u8>) -> Result<Device, TransferError> {
    let socket = endpoint.connect().await?;
    pair_call_bytes(socket, &endpoint, PAIR_ROUTE, data, REDEEM_TIMEOUT).await
}

async fn pair_call<T: serde::de::DeserializeOwned>(
    socket: TlsStream<TcpStream>,
    endpoint: &PinnedEndpoint,
    path: &str,
    data: &impl serde::Serialize,
    duration: Duration,
) -> Result<T, TransferError> {
    let data = serde_json::to_vec(data).map_err(|_| ErrorCode::InternalError)?;
    pair_call_bytes(socket, endpoint, path, data, duration).await
}

async fn pair_call_bytes<T: serde::de::DeserializeOwned>(
    socket: TlsStream<TcpStream>,
    endpoint: &PinnedEndpoint,
    path: &str,
    data: Vec<u8>,
    duration: Duration,
) -> Result<T, TransferError> {
    let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(socket))
        .await
        .map_err(|_| ErrorCode::NetworkError)?;
    let request = Request::post(path)
        .header(header::HOST, endpoint.authority())
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

fn error(failure: TransferError) -> Reply {
    let status = match failure.code {
        ErrorCode::PeerUnavailable => StatusCode::NOT_FOUND,
        ErrorCode::PairingExpired => StatusCode::GONE,
        ErrorCode::InvalidRequest => StatusCode::BAD_REQUEST,
        ErrorCode::PairingRejected | ErrorCode::PeerUntrusted => StatusCode::FORBIDDEN,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    reply(status, &failure)
}

fn reply(status: StatusCode, value: &impl serde::Serialize) -> Reply {
    let encoded = serde_json::to_vec(value).expect("serializable pairing response");
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(encoded)))
        .expect("static headers")
}
