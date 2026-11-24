use std::{
    future::Future,
    io,
    path::Path,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    task::{Context, Poll},
    time::Duration,
};

use bytes::Bytes;
use http_body_util::{BodyExt, Full, combinators::UnsyncBoxBody};
use hyper::{
    Method, Request, StatusCode,
    body::{Body, Frame, SizeHint},
    client::conn::http1,
    header,
};
use hyper_util::rt::TokioIo;
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWrite, ReadBuf};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    ErrorCode, Offer, RECEIVER_READY_ROUTE, ReceiverReady, State, Status, TransferError,
    model::{BUFFER_SIZE, MAX_SAFE_SIZE},
    read_control,
};

const CONTROL_TIMEOUT: Duration = Duration::from_secs(10);
const READY_QUERY_TIMEOUT: Duration = Duration::from_millis(1200);
type RequestBody = UnsyncBoxBody<Bytes, io::Error>;
type Progress = Arc<dyn Fn(Uuid, Status) + Send + Sync>;

/// Supply a fresh stream with authenticated TLS 1.3 and HTTP/1.1 ALPN.
/// Pin the chosen destination leaf and present the local device certificate.
pub trait Connector: Send + Sync {
    type Stream: AsyncRead + AsyncWrite + Send + Unpin + 'static;

    fn connect(&self) -> impl Future<Output = Result<Self::Stream, TransferError>> + Send;

    /// The selected LAN endpoint, formatted as an HTTP Host header.
    fn authority(&self) -> &str;

    /// Cancels in-flight sends if the platform revokes this peer.
    fn trust_revoked(&self) -> Option<CancellationToken> {
        None
    }
}

pub struct Sender<C> {
    connector: C,
    decision_timeout: Duration,
    upload_timeout: Duration,
}

impl<C: Connector> Sender<C> {
    pub fn new(connector: C, decision_timeout: Duration, upload_timeout: Duration) -> Self {
        Self {
            connector,
            decision_timeout,
            upload_timeout,
        }
    }

    /// The path comes from the trusted local file picker. MIME type, if available,
    /// can be retained with the selection by the caller. v1 uses octet-stream.
    pub async fn send_file(
        &self,
        path: &Path,
        name: &str,
        cancel: CancellationToken,
        progress: impl Fn(Uuid, Status) + Send + Sync + 'static,
    ) -> Result<Status, TransferError> {
        self.send_file_with_id(Uuid::new_v4(), path, name, cancel, progress)
            .await
    }

    /// Use a v4 UUID allocated by the host for this transfer's local and remote receipts.
    pub async fn send_file_with_id(
        &self,
        id: Uuid,
        path: &Path,
        name: &str,
        cancel: CancellationToken,
        progress: impl Fn(Uuid, Status) + Send + Sync + 'static,
    ) -> Result<Status, TransferError> {
        if id.get_version() != Some(uuid::Version::Random)
            || id.get_variant() != uuid::Variant::RFC4122
        {
            return Err(ErrorCode::InvalidRequest.into());
        }
        let revoked = self.connector.trust_revoked().unwrap_or_default();
        let stop = async {
            tokio::select! {
                _ = cancel.cancelled() => {},
                _ = revoked.cancelled() => {},
            }
        };
        tokio::pin!(stop);
        let (offer, file) = tokio::select! {
            biased;
            _ = &mut stop => return Err(ErrorCode::Cancelled.into()),
            result = prepare(id, path, name) => result?,
        };
        let sent = Arc::new(AtomicU64::new(0));
        let measured = Arc::clone(&sent);
        let progress: Progress = Arc::new(move |id, status| {
            measured.fetch_max(status.bytes_transferred, Ordering::Relaxed);
            progress(id, status);
        });
        let result = {
            let run = self.run(offer.clone(), file, Arc::clone(&progress));
            tokio::pin!(run);
            tokio::select! {
                biased;
                // Keep the upload socket open but stop polling it until DELETE has
                // reached the receiver. Otherwise EOF could race the cancellation.
                _ = &mut stop => match self.cancel(id).await {
                    Ok(status) if status.state == State::Completed => Ok(status),
                    _ => Ok(Status { state: State::Cancelled, bytes_transferred: sent.load(Ordering::Relaxed), error: None }),
                },
                result = &mut run => result,
            }
        };
        let mut final_status = match result {
            Ok(status) => status,
            Err(error) => {
                // A timed-out offer or upload may still be outstanding remotely.
                let _ = self.cancel(id).await;
                progress(
                    id,
                    Status {
                        state: State::Failed,
                        bytes_transferred: sent.load(Ordering::Relaxed),
                        error: Some(error),
                    },
                );
                return Err(error);
            }
        };
        if final_status.state == State::Completed
            && final_status.bytes_transferred != offer.size_bytes
        {
            return Err(ErrorCode::IntegrityFailed.into());
        }
        if final_status.state != State::Completed {
            final_status.bytes_transferred = sent.load(Ordering::Relaxed);
        }
        progress(id, final_status);
        Ok(final_status)
    }

    pub async fn status(&self, id: Uuid) -> Result<Status, TransferError> {
        self.control(Method::GET, &format!("/v1/transfers/{id}"), Vec::new())
            .await
            .and_then(validate_status)
    }

    pub async fn cancel(&self, id: Uuid) -> Result<Status, TransferError> {
        self.control(Method::DELETE, &format!("/v1/transfers/{id}"), Vec::new())
            .await
            .and_then(validate_status)
    }

    /// Read the peer's optional availability signal without sending file metadata.
    pub async fn receiver_ready(&self) -> Result<bool, TransferError> {
        let revoked = self.connector.trust_revoked().unwrap_or_default();
        let request = self.control::<ReceiverReady>(Method::GET, RECEIVER_READY_ROUTE, Vec::new());
        tokio::select! {
            biased;
            _ = revoked.cancelled() => Err(ErrorCode::PeerUntrusted.into()),
            result = tokio::time::timeout(READY_QUERY_TIMEOUT, request) => match result {
                Ok(Ok(reply)) => Ok(reply.ready),
                Ok(Err(error)) if error.code == ErrorCode::PeerUnavailable => Ok(false),
                Ok(Err(error)) => Err(error),
                Err(_) => Ok(false),
            },
        }
    }

    async fn run(
        &self,
        offer: Offer,
        file: tokio::fs::File,
        progress: Progress,
    ) -> Result<Status, TransferError> {
        let id = offer.id;
        let encoded = serde_json::to_vec(&offer).map_err(|_| ErrorCode::InvalidRequest)?;
        let mut status =
            validate_status(self.control(Method::POST, "/v1/transfers", encoded).await?)?;
        validate_progress(status, offer.size_bytes)?;
        progress(id, status);
        let deadline = tokio::time::Instant::now() + self.decision_timeout;
        while status.state == State::Pending {
            status = tokio::time::timeout_at(deadline, async {
                tokio::time::sleep(Duration::from_secs(1)).await;
                self.status(id).await
            })
            .await
            .map_err(|_| ErrorCode::PeerUnavailable)??;
            validate_progress(status, offer.size_bytes)?;
            if !status.state.is_terminal() {
                progress(id, status);
            }
        }
        if status.state.is_terminal() {
            return Ok(status);
        }
        if status.state != State::Accepted {
            return Err(ErrorCode::Conflict.into());
        }

        let body = FileBody {
            file,
            id,
            remaining: offer.size_bytes,
            sent: 0,
            progress,
            buffer: vec![0; BUFFER_SIZE],
        };
        let path = format!("/v1/transfers/{id}/content");
        let result = self
            .request(
                Method::PUT,
                &path,
                "application/octet-stream",
                offer.size_bytes,
                body.boxed_unsync(),
                self.upload_timeout,
            )
            .await
            .and_then(validate_status);
        match result {
            Ok(status) if status.state == State::Completed => Ok(status),
            Ok(_) => Err(ErrorCode::Conflict.into()),
            Err(error)
                if matches!(
                    error.code,
                    ErrorCode::NetworkError | ErrorCode::PeerUnavailable
                ) =>
            {
                self.recover(id, error).await
            }
            Err(error) => Err(error),
        }
    }

    async fn recover(&self, id: Uuid, original: TransferError) -> Result<Status, TransferError> {
        for _ in 0..3 {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if let Ok(status) = self.status(id).await {
                if status.state.is_terminal() {
                    return Ok(status);
                }
                if status.state != State::Transferring {
                    break;
                }
            }
        }
        Err(original)
    }

    async fn control<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        data: Vec<u8>,
    ) -> Result<T, TransferError> {
        let size = data.len() as u64;
        let body = Full::new(Bytes::from(data))
            .map_err(|never| match never {})
            .boxed_unsync();
        self.request(
            method,
            path,
            "application/json",
            size,
            body,
            CONTROL_TIMEOUT,
        )
        .await
    }

    async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        content_type: &str,
        size: u64,
        body: RequestBody,
        deadline: Duration,
    ) -> Result<T, TransferError> {
        let stream = tokio::time::timeout(CONTROL_TIMEOUT, self.connector.connect())
            .await
            .map_err(|_| ErrorCode::PeerUnavailable)??;
        let (mut sender, connection) = http1::handshake(TokioIo::new(stream))
            .await
            .map_err(|_| ErrorCode::NetworkError)?;
        let request = Request::builder()
            .method(method.clone())
            .uri(path)
            .header(header::HOST, self.connector.authority())
            .header(header::CONNECTION, "close")
            .header(header::CONTENT_TYPE, content_type)
            .header(header::CONTENT_LENGTH, size)
            .body(body)
            .map_err(|_| ErrorCode::InvalidRequest)?;
        let exchange = async move {
            let response = sender
                .send_request(request)
                .await
                .map_err(|_| ErrorCode::NetworkError)?;
            let code = response.status();
            let bytes = read_control(response.into_body())
                .await
                .map_err(|_| ErrorCode::NetworkError)?;
            if code == StatusCode::OK || (code == StatusCode::CREATED && method == Method::POST) {
                return serde_json::from_slice(&bytes).map_err(|_| ErrorCode::NetworkError.into());
            }
            Err(serde_json::from_slice(&bytes).unwrap_or_else(|_| ErrorCode::NetworkError.into()))
        };
        // Drive HTTP and the response together so dropping this request also closes
        // the socket. A connection closing after a response may still have buffered data.
        tokio::time::timeout(deadline, async {
            tokio::pin!(exchange);
            tokio::select! {
                biased;
                result = &mut exchange => result,
                _ = connection => exchange.await,
            }
        })
        .await
        .map_err(|_| ErrorCode::PeerUnavailable)?
    }
}

fn validate_status(status: Status) -> Result<Status, TransferError> {
    if status.bytes_transferred > MAX_SAFE_SIZE
        || (status.state == State::Failed) != status.error.is_some()
    {
        return Err(ErrorCode::NetworkError.into());
    }
    Ok(status)
}

fn validate_progress(status: Status, offered_bytes: u64) -> Result<(), TransferError> {
    if status.bytes_transferred > offered_bytes
        || (matches!(status.state, State::Pending | State::Accepted)
            && status.bytes_transferred != 0)
    {
        return Err(ErrorCode::NetworkError.into());
    }
    Ok(())
}

async fn prepare(
    id: Uuid,
    path: &Path,
    name: &str,
) -> Result<(Offer, tokio::fs::File), TransferError> {
    if !crate::model::safe_name(name) {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|_| ErrorCode::StorageFailed)?;
    let metadata = file
        .metadata()
        .await
        .map_err(|_| ErrorCode::StorageFailed)?;
    if !metadata.is_file() || metadata.len() > MAX_SAFE_SIZE {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let size = metadata.len();
    let mut remaining = size;
    let mut buffer = vec![0; BUFFER_SIZE];
    let mut hash = Sha256::new();
    while remaining > 0 {
        let limit = remaining.min(BUFFER_SIZE as u64) as usize;
        let count = file
            .read(&mut buffer[..limit])
            .await
            .map_err(|_| ErrorCode::StorageFailed)?;
        if count == 0 {
            return Err(ErrorCode::IntegrityFailed.into());
        }
        remaining -= count as u64;
        hash.update(&buffer[..count]);
    }
    file.rewind().await.map_err(|_| ErrorCode::StorageFailed)?;
    Ok((
        Offer {
            id,
            name: name.to_owned(),
            size_bytes: size,
            sha256: format!("{:x}", hash.finalize()),
        },
        file,
    ))
}

struct FileBody {
    file: tokio::fs::File,
    id: Uuid,
    remaining: u64,
    sent: u64,
    progress: Progress,
    buffer: Vec<u8>,
}

impl Body for FileBody {
    type Data = Bytes;
    type Error = io::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, io::Error>>> {
        let this = self.get_mut();
        if this.remaining == 0 {
            return Poll::Ready(None);
        }
        let limit = this.remaining.min(BUFFER_SIZE as u64) as usize;
        let mut buffer = ReadBuf::new(&mut this.buffer[..limit]);
        match std::task::ready!(Pin::new(&mut this.file).poll_read(cx, &mut buffer)) {
            Err(error) => Poll::Ready(Some(Err(error))),
            Ok(()) if buffer.filled().is_empty() => {
                Poll::Ready(Some(Err(io::ErrorKind::UnexpectedEof.into())))
            }
            Ok(()) => {
                let data = Bytes::copy_from_slice(buffer.filled());
                this.remaining -= data.len() as u64;
                this.sent += data.len() as u64;
                (this.progress)(
                    this.id,
                    Status {
                        state: State::Transferring,
                        bytes_transferred: this.sent,
                        error: None,
                    },
                );
                Poll::Ready(Some(Ok(Frame::data(data))))
            }
        }
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::with_exact(self.remaining)
    }

    fn is_end_stream(&self) -> bool {
        self.remaining == 0
    }
}

mod resume;
