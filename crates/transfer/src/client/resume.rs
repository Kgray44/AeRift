//! Opt-in sender for the resumable wire protocol. Never downgrade to v1.

use super::{
    AsyncReadExt, AsyncSeekExt, BodyExt, Bytes, CancellationToken, ErrorCode, Full, Method, Offer,
    Ordering, Path, Sender, State, Status, TransferError, Uuid, prepare, validate_status,
};
use crate::{RESUMABLE_CHUNK_SIZE, RESUMABLE_ROUTE, folder::PreparedFolder};
use std::{future::Future, io, sync::atomic::AtomicU64, time::Duration};

enum ResumeSource {
    File(tokio::fs::File),
    Folder(PreparedFolder),
}

impl ResumeSource {
    async fn block(&mut self, offset: u64, length: usize) -> Result<Vec<u8>, TransferError> {
        match self {
            Self::File(file) => {
                let mut data = vec![0; length];
                file.read_exact(&mut data).await.map_err(|error| {
                    if error.kind() == io::ErrorKind::UnexpectedEof {
                        ErrorCode::IntegrityFailed
                    } else {
                        ErrorCode::StorageFailed
                    }
                })?;
                Ok(data)
            }
            Self::Folder(folder) => {
                let folder = folder.clone();
                tokio::task::spawn_blocking(move || folder.block(offset, length))
                    .await
                    .map_err(|_| ErrorCode::InternalError)?
            }
        }
    }
}

const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(20);
const BACKOFF: [Duration; 3] = [
    Duration::from_millis(250),
    Duration::from_millis(500),
    Duration::from_secs(1),
];

impl<C: super::Connector> Sender<C> {
    /// Explicitly use the resumable protocol; an older peer never receives a v1 fallback.
    pub async fn send_resumable_file(
        &self,
        path: &Path,
        name: &str,
        cancel: CancellationToken,
        progress: impl Fn(Uuid, Status) + Send + Sync + 'static,
    ) -> Result<Status, TransferError> {
        self.send_resumable_file_with_id(Uuid::new_v4(), path, name, cancel, progress)
            .await
    }

    /// Reuse an ID with the same immutable source bytes and name to continue an interrupted
    /// transfer. Progress reports only bytes committed by the authenticated recipient.
    pub async fn send_resumable_file_with_id(
        &self,
        id: Uuid,
        path: &Path,
        name: &str,
        cancel: CancellationToken,
        progress: impl Fn(Uuid, Status) + Send + Sync + 'static,
    ) -> Result<Status, TransferError> {
        self.send_resumable_file_with_manifest_progress(
            id,
            path,
            name,
            cancel,
            move |manifest, status| {
                progress(manifest.id, status);
            },
        )
        .await
    }

    /// Share the validated manifest with an invocation-local progress observer.
    /// The recipient's acknowledged status and the same opened source are used;
    /// no second path lookup or alternate transport is introduced.
    pub async fn send_resumable_file_with_manifest_progress(
        &self,
        id: Uuid,
        path: &Path,
        name: &str,
        cancel: CancellationToken,
        progress: impl Fn(&Offer, Status) + Send + Sync + 'static,
    ) -> Result<Status, TransferError> {
        if id.get_version() != Some(uuid::Version::Random)
            || id.get_variant() != uuid::Variant::RFC4122
        {
            return Err(ErrorCode::InvalidRequest.into());
        }

        let revoked = self.connector.trust_revoked().unwrap_or_default();
        let (offer, file) = tokio::select! {
            biased;
            _ = revoked.cancelled() => return Err(ErrorCode::PeerUntrusted.into()),
            _ = cancel.cancelled() => return Err(ErrorCode::Cancelled.into()),
            result = prepare(id, path, name) => result?,
        };
        let manifest = offer.clone();
        self.send_resumable_source(offer, ResumeSource::File(file), cancel, move |_, status| {
            progress(&manifest, status);
        })
        .await
    }

    pub(crate) async fn send_folder_with_id(
        &self,
        id: Uuid,
        source: PreparedFolder,
        cancel: CancellationToken,
        progress: impl Fn(Uuid, Status) + Send + Sync + 'static,
    ) -> Result<Status, TransferError> {
        let offer = source.offer(id)?;
        self.send_resumable_source(offer, ResumeSource::Folder(source), cancel, progress)
            .await
    }

    async fn send_resumable_source(
        &self,
        offer: Offer,
        source: ResumeSource,
        cancel: CancellationToken,
        progress: impl Fn(Uuid, Status) + Send + Sync + 'static,
    ) -> Result<Status, TransferError> {
        let id = offer.id;
        let revoked = self.connector.trust_revoked().unwrap_or_default();
        let size = offer.size_bytes;
        let committed = AtomicU64::new(0);
        let on_checkpoint = |status: Status| {
            committed.fetch_max(status.bytes_transferred, Ordering::Relaxed);
            progress(id, status);
        };

        // A user cancellation is the only reason to discard the receiver's prefix.
        // Drop the interrupted exchange before sending DELETE so it cannot upload more.
        let result = {
            let run = self.run_resumable(offer, source, &on_checkpoint);
            tokio::pin!(run);
            tokio::select! {
                biased;
                _ = revoked.cancelled() => Some(Err(ErrorCode::PeerUntrusted.into())),
                _ = cancel.cancelled() => None,
                result = &mut run => Some(result),
            }
        };
        let offset = committed.load(Ordering::Relaxed);
        let result = match result {
            Some(result) => result,
            None => {
                let response = tokio::select! {
                    biased;
                    _ = revoked.cancelled() => return Err(ErrorCode::PeerUntrusted.into()),
                    result = retry(|| self.cancel_resumable(id)) => result,
                };
                match response.and_then(|status| check(status, size, offset)) {
                    Ok(status) if status.state.is_terminal() => Ok(status),
                    Ok(_) => Err(ErrorCode::Conflict.into()),
                    Err(error) => Err(error),
                }
            }
        };

        match result {
            Ok(status) => {
                on_checkpoint(status);
                Ok(status)
            }
            Err(error) => {
                on_checkpoint(Status {
                    state: State::Failed,
                    bytes_transferred: offset,
                    error: Some(error),
                });
                Err(error)
            }
        }
    }

    /// Query a resumable transfer, not a legacy v1 transfer sharing the same ID.
    pub async fn resumable_status(&self, id: Uuid) -> Result<Status, TransferError> {
        self.control(Method::GET, &transfer_path(id), Vec::new())
            .await
            .and_then(validate_status)
    }

    /// Explicitly discard resumable state for this peer and transfer ID.
    pub async fn cancel_resumable(&self, id: Uuid) -> Result<Status, TransferError> {
        self.control(Method::DELETE, &transfer_path(id), Vec::new())
            .await
            .and_then(validate_status)
    }

    async fn run_resumable(
        &self,
        offer: Offer,
        mut source: ResumeSource,
        progress: &(impl Fn(Status) + Sync),
    ) -> Result<Status, TransferError> {
        let id = offer.id;
        let size = offer.size_bytes;
        let data = serde_json::to_vec(&offer).map_err(|_| ErrorCode::InvalidRequest)?;
        let accepted = tokio::time::timeout(self.decision_timeout, async {
            let mut status = check(
                retry(|| self.control(Method::POST, RESUMABLE_ROUTE, data.clone())).await?,
                size,
                0,
            )?;
            while status.state == State::Pending {
                progress(status);
                tokio::time::sleep(Duration::from_secs(1)).await;
                status = check(retry(|| self.resumable_status(id)).await?, size, 0)?;
            }
            Ok::<_, TransferError>(status)
        })
        .await
        .map_err(|_| ErrorCode::PeerUnavailable)??;
        if accepted.state.is_terminal() {
            return Ok(accepted);
        }
        if !matches!(accepted.state, State::Accepted | State::Transferring) {
            return Err(ErrorCode::Conflict.into());
        }

        progress(accepted);
        tokio::time::timeout(self.upload_timeout, async {
            let mut before = accepted.bytes_transferred;
            if let ResumeSource::File(file) = &mut source {
                file.seek(io::SeekFrom::Start(before))
                    .await
                    .map_err(|_| ErrorCode::StorageFailed)?;
            }
            while before < size {
                let length = (size - before).min(RESUMABLE_CHUNK_SIZE as u64) as usize;
                let data = source.block(before, length).await?;
                let status = self
                    .put_checkpoint(id, size, before, Bytes::from(data))
                    .await?;
                if status.state.is_terminal() {
                    return Ok(status);
                }
                // Strict advancement was authenticated by the receiver.
                before = status.bytes_transferred;
                progress(status);
            }
            self.commit_checkpoint(id, size).await
        })
        .await
        .map_err(|_| ErrorCode::PeerUnavailable)?
    }

    async fn put_checkpoint(
        &self,
        id: Uuid,
        size: u64,
        before: u64,
        bytes: Bytes,
    ) -> Result<Status, TransferError> {
        let path = format!("{}/chunks/{before}", transfer_path(id));
        let after = before + bytes.len() as u64;
        for index in 0..=BACKOFF.len() {
            let body = Full::new(bytes.clone())
                .map_err(|never| match never {})
                .boxed_unsync();
            let exchange = self
                .request(
                    Method::PUT,
                    &path,
                    "application/octet-stream",
                    bytes.len() as u64,
                    body,
                    EXCHANGE_TIMEOUT,
                )
                .await;
            let direct_error = match exchange {
                Ok(status) => {
                    let status = check(status, size, before)?;
                    if status.state == State::Completed {
                        // A PUT is not a commit receipt.
                        return Err(ErrorCode::Conflict.into());
                    }
                    if status.state.is_terminal()
                        || (status.state == State::Transferring
                            && status.bytes_transferred == after)
                    {
                        return Ok(status);
                    }
                    return Err(ErrorCode::IntegrityFailed.into());
                }
                Err(error) if transient(error) || error.code == ErrorCode::Conflict => error,
                Err(error) => return Err(error),
            };

            // A broken reply can follow a committed in-process checkpoint. Resolve it against the
            // authenticated receiver before replaying an identical chunk.
            let status = check(retry(|| self.resumable_status(id)).await?, size, before)?;
            if status.state.is_terminal()
                || (status.state == State::Transferring && status.bytes_transferred == after)
            {
                return Ok(status);
            }
            if !matches!(status.state, State::Accepted | State::Transferring)
                || status.bytes_transferred != before
            {
                return Err(ErrorCode::IntegrityFailed.into());
            }
            let Some(delay) = BACKOFF.get(index) else {
                return Err(direct_error);
            };
            tokio::time::sleep(*delay).await;
        }
        unreachable!("bounded by the retry schedule")
    }

    async fn commit_checkpoint(&self, id: Uuid, size: u64) -> Result<Status, TransferError> {
        let path = format!("{}/commit", transfer_path(id));
        for index in 0..=BACKOFF.len() {
            let direct_error = match self.control(Method::POST, &path, Vec::new()).await {
                Ok(status) => {
                    let status = check(status, size, size)?;
                    return if status.state.is_terminal() {
                        Ok(status)
                    } else {
                        Err(ErrorCode::Conflict.into())
                    };
                }
                Err(error) if transient(error) || error.code == ErrorCode::Conflict => error,
                Err(error) => return Err(error),
            };
            // An earlier commit may still be finishing after its reply was lost.
            // Its authenticated status can prove publication; an unverified local
            // write or full progress bar cannot.
            let status = check(retry(|| self.resumable_status(id)).await?, size, size)?;
            if status.state.is_terminal() {
                return Ok(status);
            }
            let Some(delay) = BACKOFF.get(index) else {
                return Err(direct_error);
            };
            tokio::time::sleep(*delay).await;
        }
        unreachable!("bounded by the retry schedule")
    }
}

fn transfer_path(id: Uuid) -> String {
    format!("{RESUMABLE_ROUTE}/{id}")
}

fn transient(error: TransferError) -> bool {
    matches!(
        error.code,
        ErrorCode::NetworkError | ErrorCode::PeerUnavailable
    )
}

async fn retry<T, F, Fut>(mut operation: F) -> Result<T, TransferError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, TransferError>>,
{
    for delay in BACKOFF {
        match operation().await {
            Err(error) if transient(error) => tokio::time::sleep(delay).await,
            result => return result,
        }
    }
    operation().await
}

fn check(status: Status, size: u64, at_least: u64) -> Result<Status, TransferError> {
    let status = validate_status(status)?;
    let bytes = status.bytes_transferred;
    let chunk_size = RESUMABLE_CHUNK_SIZE as u64;
    if bytes < at_least
        || bytes > size
        || (bytes != size && !bytes.is_multiple_of(chunk_size))
        || (status.state == State::Completed && bytes != size)
        || (matches!(status.state, State::Pending | State::Accepted) && bytes != 0)
    {
        return Err(ErrorCode::IntegrityFailed.into());
    }
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ErrorCode, State, Status};

    fn status(state: State, bytes: u64) -> Status {
        Status {
            state,
            bytes_transferred: bytes,
            error: None,
        }
    }

    #[test]
    fn only_exact_non_regressing_receiver_checkpoints_are_usable() {
        let size = 1_048_600;
        let chunk = 1_048_576;
        assert!(check(status(State::Transferring, chunk), size, 0).is_ok());
        assert!(check(status(State::Transferring, size), size, chunk).is_ok());
        assert!(check(status(State::Completed, size), size, size).is_ok());
        assert!(check(status(State::Accepted, 0), 0, 0).is_ok());
        for invalid in [
            status(State::Pending, 1),
            status(State::Transferring, 1),
            status(State::Transferring, size + 1),
            status(State::Completed, chunk),
        ] {
            assert_eq!(
                check(invalid, size, 0).unwrap_err().code,
                ErrorCode::IntegrityFailed
            );
        }
        assert_eq!(
            check(status(State::Accepted, 0), size, chunk)
                .unwrap_err()
                .code,
            ErrorCode::IntegrityFailed
        );
    }

    #[derive(Default)]
    struct SimulatedRecipient {
        offer: Option<Offer>,
        bytes: Vec<u8>,
        put_offsets: Vec<u64>,
        committed: bool,
        deletes: usize,
        withhold_first_put: bool,
        withhold_commit: bool,
        commit_inflight: bool,
        disconnect_after: Option<u64>,
    }

    struct InProcessConnector(std::sync::Arc<std::sync::Mutex<SimulatedRecipient>>);

    impl super::super::Connector for InProcessConnector {
        type Stream = tokio::io::DuplexStream;

        async fn connect(&self) -> Result<Self::Stream, TransferError> {
            use hyper::{
                Request, Response, StatusCode, body::Incoming, server::conn::http1,
                service::service_fn,
            };
            use hyper_util::rt::TokioIo;
            let state = self.0.clone();
            let (reader, writer) = tokio::io::duplex(64 * 1024);
            tokio::spawn(async move {
                let service = service_fn(move |request: Request<Incoming>| {
                    let state = state.clone();
                    async move {
                        let method = request.method().clone();
                        let path = request.uri().path().to_owned();
                        let body = request.into_body().collect().await.unwrap().to_bytes();
                        let mut state = state.lock().unwrap();
                        let mut reply = StatusCode::OK;
                        if method == Method::POST && path == RESUMABLE_ROUTE {
                            let offer = serde_json::from_slice::<Offer>(&body).unwrap();
                            assert!(offer.size_bytes > 0);
                            state.offer = Some(offer);
                            reply = StatusCode::CREATED;
                        } else if method == Method::PUT {
                            let (_, offset) = path.split_once("/chunks/").unwrap();
                            let offset = offset.parse::<u64>().unwrap();
                            state.put_offsets.push(offset);
                            if state.disconnect_after.is_some_and(|n| offset >= n) {
                                return Err(io::Error::other(
                                    "fixture dropped chunk before saving it",
                                ));
                            }
                            assert_eq!(offset, state.bytes.len() as u64);
                            state.bytes.extend_from_slice(&body);
                            if std::mem::take(&mut state.withhold_first_put) {
                                return Err(io::Error::other(
                                    "fixture lost chunk reply after saving",
                                ));
                            }
                        } else if method == Method::POST && path.ends_with("/commit") {
                            if std::mem::take(&mut state.withhold_commit) {
                                state.commit_inflight = true;
                                return Err(io::Error::other(
                                    "fixture lost reply while commit was running",
                                ));
                            }
                            state.committed = true;
                            if std::mem::take(&mut state.commit_inflight) {
                                // The original commit became visible after retry observed its lock.
                                let conflict = TransferError::from(ErrorCode::Conflict);
                                return Ok(Response::builder()
                                    .status(StatusCode::CONFLICT)
                                    .body(Full::new(Bytes::from(
                                        serde_json::to_vec(&conflict).unwrap(),
                                    )))
                                    .unwrap());
                            }
                        } else if method == Method::DELETE {
                            state.deletes += 1;
                        } else {
                            assert_eq!(method, Method::GET);
                        }
                        let phase = if state.committed {
                            State::Completed
                        } else if state.bytes.is_empty() {
                            State::Accepted
                        } else {
                            State::Transferring
                        };
                        let result = status(phase, state.bytes.len() as u64);
                        Ok::<_, io::Error>(
                            Response::builder()
                                .status(reply)
                                .body(Full::new(Bytes::from(serde_json::to_vec(&result).unwrap())))
                                .unwrap(),
                        )
                    }
                });
                let _ = http1::Builder::new()
                    .serve_connection(TokioIo::new(writer), service)
                    .await;
            });
            Ok(reader)
        }

        fn authority(&self) -> &str {
            "resumable-test.invalid"
        }
    }

    #[tokio::test]
    async fn lost_chunk_and_commit_replies_use_checkpoints_without_replaying_or_deleting() {
        let state = std::sync::Arc::new(std::sync::Mutex::new(SimulatedRecipient {
            withhold_first_put: true,
            withhold_commit: true,
            ..Default::default()
        }));
        let progress = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = progress.clone();
        let sender = Sender::new(
            InProcessConnector(state.clone()),
            Duration::from_secs(3),
            Duration::from_secs(3),
        );
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("fixture.bin");
        let source = vec![99; RESUMABLE_CHUNK_SIZE + 31];
        tokio::fs::write(&path, &source).await.unwrap();
        let result = sender
            .send_resumable_file(
                &path,
                "fixture.bin",
                CancellationToken::new(),
                move |_, s| {
                    log.lock().unwrap().push((s.state, s.bytes_transferred));
                },
            )
            .await
            .unwrap();
        let state = state.lock().unwrap();
        assert_eq!(result.state, State::Completed);
        assert_eq!(state.bytes, source);
        assert_eq!(state.put_offsets, [0, RESUMABLE_CHUNK_SIZE as u64]);
        assert_eq!(state.deletes, 0);
        assert_eq!(
            *progress.lock().unwrap(),
            [
                (State::Accepted, 0),
                (State::Transferring, RESUMABLE_CHUNK_SIZE as u64),
                (State::Transferring, source.len() as u64),
                (State::Completed, source.len() as u64),
            ]
        );
    }

    #[tokio::test]
    async fn observed_manifest_is_the_exact_offer_sent_with_acknowledged_checkpoints() {
        let state = std::sync::Arc::new(std::sync::Mutex::new(SimulatedRecipient::default()));
        let observed = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = observed.clone();
        let sender = Sender::new(
            InProcessConnector(state.clone()),
            Duration::from_secs(3),
            Duration::from_secs(3),
        );
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("native-source.bin");
        let data = vec![84; RESUMABLE_CHUNK_SIZE + 31];
        tokio::fs::write(&path, &data).await.unwrap();
        let id = Uuid::new_v4();
        let result = sender
            .send_resumable_file_with_manifest_progress(
                id,
                &path,
                "verified-label.bin",
                CancellationToken::new(),
                move |offer, status| sink.lock().unwrap().push((offer.clone(), status)),
            )
            .await
            .unwrap();
        let native = state.lock().unwrap();
        let offered = native.offer.as_ref().unwrap();
        let events = observed.lock().unwrap();
        assert_eq!(result.state, State::Completed);
        assert_eq!(offered.id, id);
        assert_eq!(offered.name, "verified-label.bin");
        assert_eq!(offered.size_bytes, data.len() as u64);
        assert_eq!(native.bytes, data);
        assert!(events.iter().all(|(manifest, _)| manifest == offered));
        assert_eq!(
            events
                .iter()
                .filter(|(_, status)| status.state == State::Transferring)
                .map(|(_, status)| status.bytes_transferred)
                .collect::<Vec<_>>(),
            vec![RESUMABLE_CHUNK_SIZE as u64, offered.size_bytes],
        );
    }

    #[tokio::test]
    async fn exhausted_upload_budget_never_deletes_and_same_id_starts_at_committed_offset() {
        let prefix = RESUMABLE_CHUNK_SIZE as u64;
        let state = std::sync::Arc::new(std::sync::Mutex::new(SimulatedRecipient {
            disconnect_after: Some(prefix),
            ..Default::default()
        }));
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("fixture.bin");
        let source = vec![123; RESUMABLE_CHUNK_SIZE + 47];
        tokio::fs::write(&path, &source).await.unwrap();
        let id = Uuid::new_v4();
        let sender = Sender::new(
            InProcessConnector(state.clone()),
            Duration::from_secs(3),
            Duration::from_millis(400),
        );
        let interrupted = sender
            .send_resumable_file_with_id(
                id,
                &path,
                "fixture.bin",
                CancellationToken::new(),
                |_, _| {},
            )
            .await
            .unwrap_err();
        assert_eq!(interrupted.code, ErrorCode::PeerUnavailable);
        {
            let mut state = state.lock().unwrap();
            assert_eq!(state.bytes.len() as u64, prefix);
            assert_eq!(state.deletes, 0);
            assert_eq!(state.put_offsets[0], 0);
            assert!(
                state.put_offsets[1..]
                    .iter()
                    .all(|offset| *offset == prefix)
            );
            state.put_offsets.clear();
            state.disconnect_after = None;
        }
        let sender = Sender::new(
            InProcessConnector(state.clone()),
            Duration::from_secs(3),
            Duration::from_secs(3),
        );
        let completed = sender
            .send_resumable_file_with_id(
                id,
                &path,
                "fixture.bin",
                CancellationToken::new(),
                |_, _| {},
            )
            .await
            .unwrap();
        let state = state.lock().unwrap();
        assert_eq!(completed.state, State::Completed);
        assert_eq!(state.bytes, source);
        assert_eq!(state.put_offsets, [prefix]);
        assert_eq!(state.deletes, 0);
    }
}
