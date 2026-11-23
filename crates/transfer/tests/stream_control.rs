use std::{
    convert::Infallible,
    sync::{Arc, Mutex},
    time::Duration,
};

use aerift_transfer::{
    Connector, ErrorCode, Offer, PeerId, ReceiveLimits, Receiver, Sender, State, TransferError,
};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{Method, Request, StatusCode, header, service::service_fn};
use hyper_util::rt::TokioIo;
use sha2::{Digest, Sha256};
use tokio::io::{DuplexStream, duplex};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone)]
struct Harness {
    receiver: Arc<Receiver>,
    peer: PeerId,
    lose_completion: bool,
}

impl Connector for Harness {
    type Stream = DuplexStream;

    async fn connect(&self) -> Result<Self::Stream, TransferError> {
        let (client, server) = duplex(4096);
        let test = self.clone();
        tokio::spawn(async move {
            let disconnect = CancellationToken::new();
            let signal = disconnect.clone();
            let service = service_fn(move |request: Request<_>| {
                let is_upload = request.method() == Method::PUT;
                let receiver = test.receiver.clone();
                let signal = signal.clone();
                let test = test.clone();
                async move {
                    let reply = aerift_transfer::serve_request(
                        request,
                        test.peer,
                        receiver,
                        CancellationToken::new(),
                    )
                    .await;
                    if is_upload && test.lose_completion && reply.status() == StatusCode::OK {
                        signal.cancel();
                        std::future::pending::<()>().await;
                    }
                    Ok::<_, Infallible>(reply)
                }
            });
            tokio::select! {
                _ = disconnect.cancelled() => {},
                _ = hyper::server::conn::http1::Builder::new().keep_alive(false)
                    .serve_connection(TokioIo::new(server), service) => {},
            }
        });
        Ok(client)
    }

    fn authority(&self) -> &str {
        "fixture.invalid"
    }
}

fn setup() -> (tempfile::TempDir, Harness) {
    let directory = tempfile::tempdir().unwrap();
    let destination = directory.path().join("received");
    let staging = directory.path().join("private");
    std::fs::create_dir(&destination).unwrap();
    std::fs::create_dir(&staging).unwrap();
    let receiver = Arc::new(
        Receiver::with_staging_directory(
            &destination,
            &staging,
            ReceiveLimits {
                active_bytes: 16 * 1024 * 1024,
                session_offers: 32,
            },
        )
        .unwrap(),
    );
    let peer = PeerId::from_tls_leaf(b"fixture peer");
    (
        directory,
        Harness {
            receiver,
            peer,
            lose_completion: false,
        },
    )
}

async fn raw(
    harness: &Harness,
    method: Method,
    route: &str,
    media_type: &str,
    body: Vec<u8>,
) -> (StatusCode, serde_json::Value) {
    let (mut tx, conn) =
        hyper::client::conn::http1::handshake(TokioIo::new(harness.connect().await.unwrap()))
            .await
            .unwrap();
    let connection = tokio::spawn(conn);
    let response = tx
        .send_request(
            Request::builder()
                .method(method)
                .uri(route)
                .header(header::HOST, harness.authority())
                .header(header::CONNECTION, "close")
                .header(header::CONTENT_TYPE, media_type)
                .header(header::CONTENT_LENGTH, body.len())
                .body(Full::new(Bytes::from(body)))
                .unwrap(),
        )
        .await
        .unwrap();
    let code = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    connection.await.unwrap().unwrap();
    (code, serde_json::from_slice(&body).unwrap())
}

async fn approve(receiver: Arc<Receiver>) {
    let mut updates = receiver.subscribe();
    loop {
        for offer in receiver.snapshot() {
            if offer.status.state == State::Pending {
                receiver.respond(offer.key, true).unwrap();
                return;
            }
        }
        updates.changed().await.unwrap();
    }
}

#[tokio::test]
async fn sender_recovers_lost_completion_and_preserves_an_existing_destination() {
    let (dir, mut harness) = setup();
    harness.lose_completion = true;
    let destination = dir.path().join("received");
    let existing = destination.join("payload.bin");
    let source = dir.path().join("source.bin");
    std::fs::write(&existing, b"already here").unwrap();
    let data = vec![0x8d; 150_000];
    std::fs::write(&source, &data).unwrap();
    let decision = tokio::spawn(approve(harness.receiver.clone()));
    let sender = Sender::new(harness, Duration::from_secs(4), Duration::from_secs(5));
    let result = sender
        .send_file(&source, "payload.bin", CancellationToken::new(), |_, _| {})
        .await
        .unwrap();
    decision.await.unwrap();
    assert_eq!(result.state, State::Completed);
    assert_eq!(result.bytes_transferred, data.len() as u64);
    assert_eq!(std::fs::read(&existing).unwrap(), b"already here");
    assert_eq!(
        std::fs::read(destination.join("1-payload.bin")).unwrap(),
        data
    );
    assert_eq!(std::fs::read_dir(destination).unwrap().count(), 2);
    assert_eq!(
        std::fs::read_dir(dir.path().join("private"))
            .unwrap()
            .count(),
        0
    );
}

#[tokio::test]
async fn public_sender_mid_stream_cancel_keeps_progress_and_removes_partial() {
    let (dir, harness) = setup();
    let source = dir.path().join("source.bin");
    std::fs::write(&source, vec![0xeb; 8 * 1024 * 1024]).unwrap();
    let decision = tokio::spawn(approve(harness.receiver.clone()));
    let cancellation = CancellationToken::new();
    let observer = harness.receiver.clone();
    let stop = cancellation.clone();
    let destination = dir.path().join("received");
    let staging = dir.path().join("private");
    let active_destination = destination.clone();
    let active_staging = staging.clone();
    let cancel_at_progress = tokio::spawn(async move {
        let mut watch = observer.subscribe();
        while !observer.snapshot().iter().any(|item| {
            item.status.state == State::Transferring && item.status.bytes_transferred > 0
        }) {
            watch.changed().await.unwrap();
        }
        let destination_count = std::fs::read_dir(active_destination).unwrap().count();
        let staging_count = std::fs::read_dir(active_staging).unwrap().count();
        stop.cancel();
        (destination_count, staging_count)
    });
    let observed = Arc::new(Mutex::new(Vec::new()));
    let events = observed.clone();
    let sender = Sender::new(
        harness.clone(),
        Duration::from_secs(5),
        Duration::from_secs(8),
    );
    let status = sender
        .send_file(&source, "cancelled.bin", cancellation, move |id, status| {
            events.lock().unwrap().push((id, status));
        })
        .await
        .unwrap();
    decision.await.unwrap();
    assert_eq!(cancel_at_progress.await.unwrap(), (0, 1));
    assert_eq!(status.state, State::Cancelled);
    assert!(status.bytes_transferred > 0);
    assert_eq!(observed.lock().unwrap().last().unwrap().1, status);
    assert!(
        observed
            .lock()
            .unwrap()
            .windows(2)
            .all(|pair| pair[0].1.bytes_transferred <= pair[1].1.bytes_transferred)
    );
    let id = observed.lock().unwrap().last().unwrap().0;
    assert_eq!(sender.cancel(id).await.unwrap().state, State::Cancelled);
    tokio::time::timeout(Duration::from_secs(3), async {
        while std::fs::read_dir(&staging).unwrap().count() != 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(std::fs::read_dir(destination).unwrap().count(), 0);
}

#[tokio::test]
async fn metadata_retries_are_scoped_and_digest_mismatch_never_publishes() {
    let (dir, harness) = setup();
    let offer = Offer {
        id: Uuid::new_v4(),
        name: "file.bin".to_owned(),
        size_bytes: 3,
        sha256: format!("{:x}", Sha256::digest(b"abc")),
    };
    let data = serde_json::to_vec(&offer).unwrap();
    let post = "/v1/transfers";
    let content = format!("{post}/{}/content", offer.id);
    let url = format!("{post}/{}", offer.id);
    assert_eq!(
        raw(
            &harness,
            Method::POST,
            post,
            "application/json",
            data.clone()
        )
        .await
        .0,
        StatusCode::CREATED
    );
    assert_eq!(
        raw(&harness, Method::POST, post, "application/json", data)
            .await
            .0,
        StatusCode::OK
    );
    let mut conflict = offer.clone();
    conflict.name = "other.bin".to_owned();
    assert_eq!(
        raw(
            &harness,
            Method::POST,
            post,
            "application/json",
            serde_json::to_vec(&conflict).unwrap()
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let mut other = harness.clone();
    other.peer = PeerId::from_tls_leaf(b"another authenticated peer");
    assert_eq!(
        raw(&other, Method::GET, &url, "application/json", vec![])
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        raw(
            &harness,
            Method::PUT,
            &content,
            "application/octet-stream",
            b"abc".to_vec()
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let key = harness.receiver.snapshot()[0].key;
    harness.receiver.respond(key, true).unwrap();
    assert_eq!(
        raw(
            &harness,
            Method::PUT,
            &content,
            "application/octet-stream",
            b"ab".to_vec()
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (code, body) = raw(
        &harness,
        Method::PUT,
        &content,
        "application/octet-stream",
        b"bad".to_vec(),
    )
    .await;
    assert_eq!(code, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["code"], "integrity_failed");
    let status = harness.receiver.status(key).unwrap();
    assert_eq!(status.state, State::Failed);
    assert_eq!(status.error.unwrap().code, ErrorCode::IntegrityFailed);
    for name in ["received", "private"] {
        assert_eq!(std::fs::read_dir(dir.path().join(name)).unwrap().count(), 0);
    }
}
