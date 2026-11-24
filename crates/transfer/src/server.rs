use std::{convert::Infallible, sync::Arc, time::Duration};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{
    Method, Request, Response, StatusCode,
    body::{Body, Incoming},
    header,
    server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use crate::receiver::Upload;
use crate::{
    ErrorCode, Offer, PeerId, RECEIVER_READY_ROUTE, Receiver, ReceiverReady, Status, TransferError,
    TransferKey, parse_id, read_control,
};

type Reply = Response<Full<Bytes>>;

/// Optional transport-lane policy. Must run only after peer TLS authentication.
/// Treat an admitted metadata offer as prior explicit consent, never generic trust.
pub trait TransferScope: Send + Sync {
    fn admit(&self, key: TransferKey, offer: &Offer) -> Result<(), TransferError>;
    fn check(&self, key: TransferKey) -> Result<(), TransferError>;
    fn publish(
        &self,
        key: TransferKey,
        action: impl FnOnce() -> Result<Status, TransferError>,
    ) -> Result<Status, TransferError>;
}
struct NoScope;
impl TransferScope for NoScope {
    fn admit(&self, _: TransferKey, _: &Offer) -> Result<(), TransferError> {
        Ok(())
    }
    fn check(&self, _: TransferKey) -> Result<(), TransferError> {
        Ok(())
    }
    fn publish(
        &self,
        _: TransferKey,
        action: impl FnOnce() -> Result<Status, TransferError>,
    ) -> Result<Status, TransferError> {
        action()
    }
}

/// Serve one HTTP/1.1 connection. The caller owns the preceding TLS handshake and
/// supplies its verified peer. The trust callback is evaluated on every request.
pub async fn serve<I, T>(
    io: I,
    peer: PeerId,
    receiver: Arc<Receiver>,
    is_trusted: T,
) -> Result<(), TransferError>
where
    I: AsyncRead + AsyncWrite + Unpin,
    T: Fn(PeerId) -> bool,
{
    http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(Duration::from_secs(10))
        .max_buf_size(32 * 1024)
        .serve_connection(
            TokioIo::new(io),
            service_fn(|request| {
                let trusted = is_trusted(peer);
                let receiver = Arc::clone(&receiver);
                async move {
                    Ok::<_, Infallible>(if trusted {
                        serve_request(request, peer, receiver, CancellationToken::new()).await
                    } else {
                        error(ErrorCode::PeerUntrusted.into())
                    })
                }
            }),
        )
        .await
        .map_err(|_| ErrorCode::NetworkError.into())
}

/// Dispatch after the caller has verified both TLS possession and local trust.
pub async fn serve_request(
    request: Request<Incoming>,
    peer: PeerId,
    receiver: Arc<Receiver>,
    trust: CancellationToken,
) -> Reply {
    dispatch(request, peer, receiver, trust, None::<&NoScope>).await
}

/// Separate optional guarded scope; ordinary Nearby/Remote remain unchanged.
pub async fn serve_scoped_request(
    request: Request<Incoming>,
    peer: PeerId,
    receiver: Arc<Receiver>,
    trust: CancellationToken,
    scope: &impl TransferScope,
) -> Reply {
    dispatch(request, peer, receiver, trust, Some(scope)).await
}

async fn dispatch(
    request: Request<Incoming>,
    peer: PeerId,
    receiver: Arc<Receiver>,
    trust: CancellationToken,
    scope: Option<&impl TransferScope>,
) -> Reply {
    if trust.is_cancelled() {
        return error(ErrorCode::PeerUntrusted.into());
    }
    let path = request.uri().path();
    if request.uri().query().is_some() || request.version() != hyper::Version::HTTP_11 {
        return error(ErrorCode::InvalidRequest.into());
    }
    if !path.starts_with("/v1/") {
        return error(ErrorCode::UnsupportedVersion.into());
    }
    if path == RECEIVER_READY_ROUTE {
        if scope.is_some() {
            return error(ErrorCode::PeerUntrusted.into());
        }
        if request.method() != Method::GET || request.body().size_hint().exact() != Some(0) {
            return error(ErrorCode::InvalidRequest.into());
        }
        let mut reply = json(
            StatusCode::OK,
            &ReceiverReady {
                ready: receiver.is_ready(),
            },
        );
        reply.headers_mut().insert(
            header::CACHE_CONTROL,
            header::HeaderValue::from_static("no-store"),
        );
        return reply;
    }
    if path == "/v1/transfers" && request.method() == Method::POST {
        return offer(request, peer, &receiver, &trust, scope).await;
    }
    let Some(path) = path.strip_prefix("/v1/transfers/") else {
        return error(ErrorCode::PeerUnavailable.into());
    };
    let (raw_id, content) = match path.strip_suffix("/content") {
        Some(raw_id) => (raw_id, true),
        None => (path, false),
    };
    let Some(id) = parse_id(raw_id) else {
        return error(ErrorCode::InvalidRequest.into());
    };
    let key = TransferKey { peer, id };
    if let Some(scope) = scope {
        if let Err(failure) = scope.check(key) {
            return error(failure);
        }
    }
    let result = match (request.method(), content) {
        (&Method::GET, false) => receiver.status(key),
        (&Method::DELETE, false) => receiver.cancel(key),
        (&Method::PUT, true) => {
            let Some(size) = content_length(&request) else {
                return error(ErrorCode::InvalidRequest.into());
            };
            match receiver.start(key, size) {
                Ok(upload) => {
                    let result = receive(&upload, request.into_body(), key, scope).await;
                    if let Err(error) = result {
                        upload.fail(error);
                    }
                    result
                }
                Err(error) => Err(error),
            }
        }
        _ => return error(ErrorCode::InvalidRequest.into()),
    };
    match result {
        Ok(status) => json(StatusCode::OK, &status),
        Err(failure) => error(failure),
    }
}

async fn offer(
    request: Request<Incoming>,
    peer: PeerId,
    receiver: &Receiver,
    trust: &CancellationToken,
    scope: Option<&impl TransferScope>,
) -> Reply {
    let body = match tokio::time::timeout(
        Duration::from_secs(10),
        read_control(request.into_body()),
    )
    .await
    {
        Ok(Ok(body)) => body,
        Ok(Err(true)) => {
            return json(
                StatusCode::PAYLOAD_TOO_LARGE,
                &TransferError::from(ErrorCode::InvalidRequest),
            );
        }
        _ => return error(ErrorCode::InvalidRequest.into()),
    };
    let Ok(offer) = serde_json::from_slice::<Offer>(&body) else {
        return error(ErrorCode::InvalidRequest.into());
    };
    let key = TransferKey { peer, id: offer.id };
    if let Some(scope) = scope {
        if let Err(failure) = offer.validate().and_then(|()| scope.admit(key, &offer)) {
            return error(failure);
        }
    }
    match receiver.offer(peer, offer, trust) {
        Ok((created, status)) => {
            let status = if created && scope.is_some() {
                match scope
                    .expect("checked")
                    .check(key)
                    .and_then(|()| receiver.respond(key, true))
                {
                    Ok(status) => status,
                    Err(failure) => {
                        let _ = receiver.cancel(key);
                        return error(failure);
                    }
                }
            } else {
                status
            };
            json(
                if created {
                    StatusCode::CREATED
                } else {
                    StatusCode::OK
                },
                &status,
            )
        }
        Err(failure) => error(failure),
    }
}

fn content_length(request: &Request<Incoming>) -> Option<u64> {
    let headers = request.headers();
    if headers.get(header::CONTENT_TYPE)?.as_bytes() != b"application/octet-stream"
        || headers.contains_key(header::TRANSFER_ENCODING)
        || headers.get_all(header::CONTENT_LENGTH).iter().count() != 1
    {
        return None;
    }
    headers
        .get(header::CONTENT_LENGTH)?
        .to_str()
        .ok()?
        .parse()
        .ok()
}

async fn receive(
    upload: &Upload,
    mut body: Incoming,
    key: TransferKey,
    scope: Option<&impl TransferScope>,
) -> Result<Status, TransferError> {
    let temporary = upload.tempfile()?;
    let handle = temporary.reopen().map_err(|_| ErrorCode::StorageFailed)?;
    let mut file = tokio::fs::File::from_std(handle);
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    loop {
        let frame = tokio::select! {
            biased;
            _ = upload.cancel.cancelled() => return Err(ErrorCode::Cancelled.into()),
            _ = upload.trust.cancelled() => return Err(ErrorCode::Cancelled.into()),
            next = tokio::time::timeout(Duration::from_secs(30), body.frame()) =>
                next.map_err(|_| ErrorCode::PeerUnavailable)?,
        };
        let Some(frame) = frame else { break };
        if let Some(scope) = scope {
            scope.check(key)?;
        }
        let data = frame
            .map_err(|_| ErrorCode::IntegrityFailed)?
            .into_data()
            .map_err(|_| ErrorCode::InvalidRequest)?;
        bytes += data.len() as u64;
        if bytes > upload.offer.size_bytes {
            return Err(ErrorCode::IntegrityFailed.into());
        }
        file.write_all(&data)
            .await
            .map_err(|_| ErrorCode::StorageFailed)?;
        hash.update(&data);
        upload.progress(bytes)?;
    }
    if bytes != upload.offer.size_bytes || format!("{:x}", hash.finalize()) != upload.offer.sha256 {
        return Err(ErrorCode::IntegrityFailed.into());
    }
    file.flush().await.map_err(|_| ErrorCode::StorageFailed)?;
    file.sync_all()
        .await
        .map_err(|_| ErrorCode::StorageFailed)?;
    drop(file);
    match scope {
        Some(scope) => scope.publish(key, || upload.publish(temporary)),
        None => upload.publish(temporary),
    }
}

fn error(failure: TransferError) -> Reply {
    let status = match failure.code {
        ErrorCode::InvalidRequest | ErrorCode::UnsupportedVersion => StatusCode::BAD_REQUEST,
        ErrorCode::PeerUntrusted | ErrorCode::PairingRejected => StatusCode::FORBIDDEN,
        ErrorCode::PairingExpired => StatusCode::GONE,
        ErrorCode::PeerUnavailable => StatusCode::NOT_FOUND,
        ErrorCode::Conflict | ErrorCode::TransferRejected | ErrorCode::Cancelled => {
            StatusCode::CONFLICT
        }
        ErrorCode::IntegrityFailed => StatusCode::UNPROCESSABLE_ENTITY,
        ErrorCode::StorageFailed | ErrorCode::NetworkError | ErrorCode::InternalError => {
            StatusCode::INTERNAL_SERVER_ERROR
        }
    };
    json(status, &failure)
}

fn json(status: StatusCode, data: &impl serde::Serialize) -> Reply {
    let body = serde_json::to_vec(data).expect("serializable v1 response");
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(body)))
        .expect("static response headers")
}
