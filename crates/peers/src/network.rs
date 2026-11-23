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
        })
    }

    pub fn pairing(&self) -> &Pairing {
        &self.pairing
    }

    pub fn revoke(&self, peer: PeerId) -> Result<(), TransferError> {
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

    /// Start on an address chosen by the native platform, then publish its bound port
    /// via DNS-SD. A single listener handles both pairing and transfer.
    pub async fn serve(
        &self,
        listener: TcpListener,
        shutdown: CancellationToken,
    ) -> Result<(), TransferError> {
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
                }
                _ = tasks.join_next(), if !tasks.is_empty() => {}
                next = listener.accept() => {
                    let (socket, _) = next.map_err(|_| ErrorCode::NetworkError)?;
                    let Ok(permit) = Arc::clone(&connections).try_acquire_owned() else { continue };
                    let tls = tls.clone();
                    let pairing = Arc::clone(&self.pairing);
                    let receiver = Arc::clone(&self.receiver);
                    let unknown = Arc::clone(&unknown);
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
                        let service = service_fn(|request| {
                            let pairing = Arc::clone(&pairing);
                            let receiver = Arc::clone(&receiver);
                            async move { Ok::<_, Infallible>(route(request, peer, pairing, receiver).await) }
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

async fn pair_remote(endpoint: PinnedEndpoint, data: Vec<u8>) -> Result<Device, TransferError> {
    let socket = endpoint.connect().await?;
    let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(socket))
        .await
        .map_err(|_| ErrorCode::NetworkError)?;
    let request = Request::post(PAIR_ROUTE)
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
    timeout(REDEEM_TIMEOUT, async {
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
