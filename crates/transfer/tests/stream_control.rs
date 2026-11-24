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
    trusted: bool,
    old_receiver: bool,
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
                    let trust = CancellationToken::new();
                    if !test.trusted {
                        trust.cancel();
                    }
                    let request =
                        if test.old_receiver && request.uri().path() == "/v1/receiver-ready" {
                            let mut request = request;
                            *request.uri_mut() = "/v1/unknown".parse().unwrap();
                            request
                        } else {
                            request
                        };
                    let reply =
                        aerift_transfer::serve_request(request, test.peer, receiver, trust).await;
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
            trusted: true,
            old_receiver: false,
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
async fn readiness_defaults_off_and_expires_without_creating_a_transfer() {
    let (_dir, harness) = setup();
    let receiver = harness.receiver.clone();
    let sender = Sender::new(harness, Duration::from_secs(4), Duration::from_secs(5));
    assert!(!sender.receiver_ready().await.unwrap());
    receiver.set_ready_until(Some(tokio::time::Instant::now() + Duration::from_secs(45)));
    assert!(sender.receiver_ready().await.unwrap());
    assert!(receiver.snapshot().is_empty());
    receiver.set_ready_until(None);
    assert!(!sender.receiver_ready().await.unwrap());
    receiver.set_ready_until(Some(tokio::time::Instant::now()));
    assert!(!sender.receiver_ready().await.unwrap());
}

#[tokio::test]
async fn readiness_requires_trust_and_unavailable_route_defaults_off() {
    let (_dir, mut harness) = setup();
    harness
        .receiver
        .set_ready_until(Some(tokio::time::Instant::now() + Duration::from_secs(45)));
    harness.trusted = false;
    let sender = Sender::new(
        harness.clone(),
        Duration::from_secs(4),
        Duration::from_secs(5),
    );
    assert_eq!(
        sender.receiver_ready().await.unwrap_err().code,
        ErrorCode::PeerUntrusted
    );
    harness.trusted = true;
    harness.old_receiver = true;
    let sender = Sender::new(harness, Duration::from_secs(4), Duration::from_secs(5));
    assert!(!sender.receiver_ready().await.unwrap());
}

#[tokio::test]
async fn a_preassigned_id_reaches_the_receiver_but_readiness_cannot_accept_an_offer() {
    let (dir, harness) = setup();
    let file = dir.path().join("sample.txt");
    std::fs::write(&file, b"only after consent").unwrap();
    let id = Uuid::new_v4();
    let cancel = CancellationToken::new();
    let receiver = harness.receiver.clone();
    receiver.set_ready_until(Some(tokio::time::Instant::now() + Duration::from_secs(45)));
    let mut changes = receiver.subscribe();
    let expected = cancel.clone();
    let sender = tokio::spawn(async move {
        Sender::new(harness, Duration::from_secs(4), Duration::from_secs(5))
            .send_file_with_id(id, &file, "sample.txt", expected, move |wire_id, _| {
                assert_eq!(wire_id, id)
            })
            .await
    });
    let pending = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(entry) = receiver.snapshot().into_iter().next() {
                break entry;
            }
            changes.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert_eq!(pending.key.id, id);
    assert_eq!(pending.status.state, State::Pending);
    assert_eq!(pending.status.bytes_transferred, 0);
    assert!(!dir.path().join("received/sample.txt").exists());
    cancel.cancel();
    assert_eq!(sender.await.unwrap().unwrap().state, State::Cancelled);
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

#[tokio::test]
async fn frozen_object_send_reuses_v1_consent_and_refuses_changed_source_before_offer() {
    use aerift_transfer::ambient::{Candidate, CaptureContext, CaptureLimits, freeze};
    let (temp, harness) = setup();
    let source = temp.path().join("ambient-source.bin");
    std::fs::write(&source, b"selected bytes").unwrap();
    let capture = Arc::new(
        freeze(
            CaptureContext {
                explicit_selection: vec![Candidate::path(source.clone())],
                ..Default::default()
            },
            CaptureLimits::default(),
        )
        .unwrap(),
    );
    let receiver = harness.receiver.clone();
    let sender = Sender::new(harness, Duration::from_secs(4), Duration::from_secs(5));
    let accepted = tokio::spawn(approve(receiver.clone()));
    let receipt = sender
        .send_frozen_file_with_id(
            Uuid::new_v4(),
            capture.clone(),
            CancellationToken::new(),
            |_, _| {},
        )
        .await
        .unwrap();
    assert_eq!(receipt.state, State::Completed);
    accepted.await.unwrap();
    assert_eq!(
        std::fs::read(temp.path().join("received/ambient-source.bin")).unwrap(),
        b"selected bytes"
    );
    std::fs::write(source, b"changed, not selected").unwrap();
    let error = sender
        .send_frozen_file_with_id(Uuid::new_v4(), capture, CancellationToken::new(), |_, _| {})
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::IntegrityFailed);
    assert_eq!(receiver.snapshot().len(), 1);
}

#[tokio::test]
async fn a_changed_first_block_cannot_emit_bytes_after_the_receiver_approves() {
    use aerift_transfer::ambient::{Candidate, CaptureContext, CaptureLimits, freeze};
    let (temp, harness) = setup();
    let source = temp.path().join("freeze-before-offer.bin");
    std::fs::write(&source, vec![1u8; 1024 * 1024 + 1]).unwrap();
    let capture = Arc::new(
        freeze(
            CaptureContext {
                explicit_selection: vec![Candidate::path(source.clone())],
                ..Default::default()
            },
            CaptureLimits::default(),
        )
        .unwrap(),
    );
    let receiver = harness.receiver.clone();
    let sender = Sender::new(harness, Duration::from_secs(4), Duration::from_secs(5));
    let receiver_task = receiver.clone();
    let modifier = tokio::spawn(async move {
        let mut events = receiver_task.subscribe();
        loop {
            if let Some(offer) = receiver_task
                .snapshot()
                .into_iter()
                .find(|offer| offer.status.state == State::Pending)
            {
                // Retain the same path, length and inode, forcing per-block verification
                // to catch a mutation after the sender has opened the file.
                use std::io::Write;
                std::fs::OpenOptions::new()
                    .write(true)
                    .open(&source)
                    .unwrap()
                    .write_all(&[2])
                    .unwrap();
                receiver_task.respond(offer.key, true).unwrap();
                break;
            }
            events.changed().await.unwrap();
        }
    });
    let progress = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let measured = progress.clone();
    let error = sender
        .send_frozen_file_with_id(
            Uuid::new_v4(),
            capture,
            CancellationToken::new(),
            move |_, status| {
                measured.fetch_max(
                    status.bytes_transferred,
                    std::sync::atomic::Ordering::Relaxed,
                );
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::IntegrityFailed);
    modifier.await.unwrap();
    assert_eq!(progress.load(std::sync::atomic::Ordering::Relaxed), 0);
    assert!(
        !temp
            .path()
            .join("received/freeze-before-offer.bin")
            .exists()
    );
}

#[tokio::test]
async fn inbox_acceptance_is_one_shot_and_corrupted_upload_leaves_no_candidate() {
    use aerift_transfer::ambient_inbox::{FrozenDelivery, Inbox};
    let (dir, harness) = setup();
    let inbox_root = dir.path().join("inbox");
    std::fs::create_dir(&inbox_root).unwrap();
    let inbox = Arc::new(Inbox::open(&inbox_root).unwrap());
    let id = Uuid::new_v4();
    let offer = Offer {
        id,
        name: "receive.bin".to_owned(),
        size_bytes: 3,
        sha256: format!("{:x}", Sha256::digest(b"abc")),
    };
    assert_eq!(
        raw(
            &harness,
            Method::POST,
            "/v1/transfers",
            "application/json",
            serde_json::to_vec(&offer).unwrap()
        )
        .await
        .0,
        StatusCode::CREATED
    );
    let key = harness.receiver.snapshot()[0].key;
    harness
        .receiver
        .respond_to_inbox(key, inbox.clone(), FrozenDelivery::Inbox)
        .unwrap();
    assert_eq!(
        harness.receiver.respond(key, true).unwrap_err().code,
        ErrorCode::Conflict
    );
    assert_eq!(
        raw(
            &harness,
            Method::PUT,
            &format!("/v1/transfers/{id}/content"),
            "application/octet-stream",
            b"bad".to_vec()
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(harness.receiver.status(key).unwrap().state, State::Failed);
    assert!(harness.receiver.snapshot()[0].saved_path.is_none());
    assert!(inbox.recovery_candidates("").unwrap().entries.is_empty());
    assert_eq!(std::fs::read_dir(&inbox_root).unwrap().count(), 0);
    assert!(inbox.verified_receipt(key).is_err());
}

#[tokio::test]
async fn ambient_dispatch_requires_receiver_consent_and_emits_one_verified_completion() {
    use aerift_transfer::ambient::{
        Candidate, CaptureContext, CaptureLimits, freeze,
        session::{DropAuthority, HeldSession, Lane},
    };
    use std::time::Instant;
    struct Only(PeerId);
    impl DropAuthority for Only {
        fn permits(&self, peer: PeerId, lane: Lane) -> bool {
            peer == self.0 && lane == Lane::MyDevices
        }
    }
    let (temp, harness) = setup();
    let source = temp.path().join("selected.bin");
    std::fs::write(&source, b"held contents").unwrap();
    let capture = freeze(
        CaptureContext {
            explicit_selection: vec![Candidate::path(source)],
            ..Default::default()
        },
        CaptureLimits::default(),
    )
    .unwrap();
    let peer = PeerId::from_tls_leaf(b"fixture destination");
    let auth = Only(peer);
    let now = Instant::now();
    let mut held = HeldSession::pickup(capture, Lane::MyDevices, now).unwrap();
    let id = held.id();
    held.drop_claim(id, peer, Lane::MyDevices, now, &auth)
        .unwrap();
    let dispatch = held
        .resolve(now + Duration::from_millis(500), &auth)
        .unwrap();
    let receiver = harness.receiver.clone();
    let sender = Sender::new(harness, Duration::from_secs(4), Duration::from_secs(5));
    let frames = Arc::new(std::sync::Mutex::new(Vec::<serde_json::Value>::new()));
    let observe = frames.clone();
    let recorder = frames.clone();
    let observer = tokio::spawn(async move {
        let mut events = receiver.subscribe();
        let pending = loop {
            if let Some(pending) = receiver
                .snapshot()
                .into_iter()
                .find(|o| o.status.state == State::Pending)
            {
                break pending;
            }
            events.changed().await.unwrap();
        };
        assert!(
            observe
                .lock()
                .unwrap()
                .iter()
                .all(|event| event.get("verified").is_none())
        );
        receiver.respond(pending.key, true).unwrap();
    });
    assert_eq!(
        dispatch
            .send(
                &auth,
                |p, lane| {
                    assert_eq!((p, lane), (peer, Lane::MyDevices));
                    Some(sender)
                },
                CancellationToken::new(),
                move |frame| {
                    recorder
                        .lock()
                        .unwrap()
                        .push(serde_json::to_value(frame).unwrap())
                }
            )
            .await
            .unwrap()
            .state,
        State::Completed
    );
    observer.await.unwrap();
    let frames = frames.lock().unwrap();
    let verified = frames
        .iter()
        .filter(|event| event.get("verified").is_some())
        .collect::<Vec<_>>();
    assert_eq!(verified.len(), 1);
    assert_eq!(verified[0]["phase"], "completed");
    assert_eq!(verified[0]["interaction"], id.to_string());
    assert_eq!(
        std::fs::read(temp.path().join("received/selected.bin")).unwrap(),
        b"held contents"
    );
}
