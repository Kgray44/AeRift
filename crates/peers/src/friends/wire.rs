//! Private Friends offer control over scoped, pinned device mTLS.
//! Uses the same explicit private routes and pinned connector as Remote,
//! but admission comes solely from the Friends book. There is no payload,
//! discovery, enumeration, invitation redemption or generic transfer route here.

use std::{convert::Infallible, net::SocketAddr, sync::Arc, time::Duration};

use aerift_transfer::{Connector, ErrorCode, PeerId, TransferError};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{Method, Request, Response, Version, body::Incoming, header, service::service_fn};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tokio::{net::TcpListener, sync::Semaphore, task::JoinSet, time::timeout};
use tokio_rustls::TlsAcceptor;
use tokio_util::sync::CancellationToken;
use uuid::{Uuid, Variant};

use crate::{Identity, RemotePeerNode, network::pinned_endpoint};

use super::{FriendBook, FriendClaim, FriendDecision};

const ALPN: &[u8] = b"aerift-friends-offer/1";
const ACCEPT: &str = "/friends/v1/accept";
const DECISION: &str = "/friends/v1/decision";
const CONTROL_LIMIT: usize = 1024;
const BUDGET: Duration = Duration::from_secs(10);

pub struct FriendOfferEndpoint;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Control {
    id: Uuid,
    digest: [u8; 32],
}

impl FriendOfferEndpoint {
    /// The platform must open only an explicit authorized private listener.
    /// Neither generic Remote pairing nor nearby grants admit any route here.
    pub async fn serve(
        identity: &Identity,
        listener: TcpListener,
        book: Arc<FriendBook>,
        shutdown: CancellationToken,
    ) -> Result<(), TransferError> {
        let bound = listener.local_addr().map_err(|_| ErrorCode::NetworkError)?;
        if !RemotePeerNode::supports_private_endpoint(bound) {
            return Err(ErrorCode::InvalidRequest.into());
        }
        let mut config = identity.server_config()?;
        config.alpn_protocols = vec![ALPN.to_vec()];
        let tls = TlsAcceptor::from(Arc::new(config));
        let mut tasks = JoinSet::new();
        let connections = Arc::new(Semaphore::new(16));
        loop {
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => break,
                _ = tasks.join_next(), if !tasks.is_empty() => {},
                next = listener.accept() => {
                    let (socket, _) = next.map_err(|_| ErrorCode::NetworkError)?;
                    let Ok(permit) = connections.clone().try_acquire_owned() else { continue; };
                    let tls = tls.clone();
                    let book = book.clone();
                    tasks.spawn(async move {
                        let _permit = permit;
                        let Ok(Ok(stream)) = timeout(BUDGET, tls.accept(socket)).await else { return; };
                        let session = stream.get_ref().1;
                        if session.alpn_protocol() != Some(ALPN) { return; }
                        let Some(leaf) = session.peer_certificates().and_then(|chain| chain.first()) else { return; };
                        let authenticated = PeerId::from_tls_leaf(leaf.as_ref());
                        let service = service_fn(|request| {
                            let book = book.clone();
                            async move { Ok::<_, Infallible>(dispatch(request, authenticated, &book).await) }
                        });
                        let _ = hyper::server::conn::http1::Builder::new()
                            .timer(TokioTimer::new()).header_read_timeout(BUDGET)
                            .max_buf_size(16 * 1024).keep_alive(false)
                            .serve_connection(TokioIo::new(stream), service).await;
                    });
                }
            }
        }
        tasks.shutdown().await;
        Ok(())
    }

    /// Client policy: call only for the deliberate acceptance of this exact
    /// offer on this device. Network retries by the same winner are safe.
    pub async fn accept(
        identity: &Identity,
        routes: &[SocketAddr],
        issuer: PeerId,
        id: Uuid,
        digest: [u8; 32],
    ) -> Result<FriendClaim, TransferError> {
        client(identity, routes, issuer, ACCEPT, Control { id, digest }).await
    }

    /// Poll only a known offer from its authenticated issuer. A non-winner
    /// learns only that its own prompt is withdrawn, never which device won.
    pub async fn decision(
        identity: &Identity,
        routes: &[SocketAddr],
        issuer: PeerId,
        id: Uuid,
        digest: [u8; 32],
    ) -> Result<FriendDecision, TransferError> {
        client(identity, routes, issuer, DECISION, Control { id, digest }).await
    }
}

async fn dispatch(
    request: Request<Incoming>,
    peer: PeerId,
    book: &FriendBook,
) -> Response<Full<Bytes>> {
    let fail = |code: ErrorCode| response::<()>(Err(code.into()));
    let accept = request.uri().path() == ACCEPT;
    if request.method() != Method::POST
        || request.version() != Version::HTTP_11
        || request.uri().query().is_some()
        || (!accept && request.uri().path() != DECISION)
    {
        return fail(ErrorCode::InvalidRequest);
    }
    let Ok(Ok(data)) = timeout(
        BUDGET,
        Limited::new(request.into_body(), CONTROL_LIMIT).collect(),
    )
    .await
    else {
        return fail(ErrorCode::InvalidRequest);
    };
    let Ok(Control { id, digest }) = serde_json::from_slice(&data.to_bytes()) else {
        return fail(ErrorCode::InvalidRequest);
    };
    if id.get_version() != Some(uuid::Version::Random) || id.get_variant() != Variant::RFC4122 {
        return fail(ErrorCode::InvalidRequest);
    }
    if accept {
        response(book.claim(id, peer, digest))
    } else {
        response(book.decision(id, peer, digest))
    }
}

fn response<T: Serialize>(result: Result<T, TransferError>) -> Response<Full<Bytes>> {
    let status = match &result {
        Ok(_) => 200,
        Err(error) => match error.code {
            ErrorCode::TransferRejected | ErrorCode::PeerUntrusted => 403,
            ErrorCode::Conflict => 409,
            ErrorCode::InvalidRequest => 400,
            _ => 500,
        },
    };
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(
            serde_json::to_vec(&result).expect("concrete Friends control response"),
        )))
        .expect("static Friends response headers")
}

async fn client<T: DeserializeOwned>(
    identity: &Identity,
    routes: &[SocketAddr],
    issuer: PeerId,
    path: &'static str,
    control: Control,
) -> Result<T, TransferError> {
    if routes
        .iter()
        .any(|a| !RemotePeerNode::supports_private_endpoint(*a))
    {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let endpoint = pinned_endpoint(identity, routes, issuer, None, ALPN)?;
    let request = Request::post(path)
        .header(header::HOST, endpoint.authority())
        .header(header::CONNECTION, "close")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(
            serde_json::to_vec(&control).map_err(|_| ErrorCode::InvalidRequest)?,
        )))
        .map_err(|_| ErrorCode::InvalidRequest)?;
    let socket = endpoint.connect().await?;
    timeout(BUDGET, async {
        let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(socket))
            .await
            .map_err(|_| ErrorCode::NetworkError)?;
        let result = async move {
            let reply = sender
                .send_request(request)
                .await
                .map_err(|_| ErrorCode::NetworkError)?;
            let status = reply.status();
            let data = Limited::new(reply.into_body(), CONTROL_LIMIT)
                .collect()
                .await
                .map_err(|_| ErrorCode::NetworkError)?
                .to_bytes();
            let decoded = serde_json::from_slice::<Result<T, TransferError>>(&data)
                .map_err(|_| ErrorCode::NetworkError)?;
            if (status == hyper::StatusCode::OK) != decoded.is_ok() {
                return Err(ErrorCode::NetworkError.into());
            }
            decoded
        };
        tokio::pin!(result);
        tokio::select! {
            biased;
            value = &mut result => value,
            _ = conn => result.await,
        }
    })
    .await
    .map_err(|_| ErrorCode::PeerUnavailable)?
}
