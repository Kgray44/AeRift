//! Run with the locked AeRift peer crates and a prepared local fixture.
mod support {
    include!(concat!(
        env!("AERIFT_VALIDATION_PEER_ROOT"),
        "/crates/peers/tests/support/mod.rs"
    ));
}

use aerift_peers::{Identity, PeerNode, Platform};
use aerift_transfer::{ReceiveLimits, Receiver, State, Status};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{self, Read},
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{net::TcpListener, sync::watch, time::timeout};
use tokio_util::sync::CancellationToken;

const MAX_BYTES: u64 = 64 * 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(60);
const DESTINATION: &str = "received.bin";

#[derive(Default)]
struct Progress {
    first: Option<(Instant, u64)>,
    events: u64,
    callback_ns: u128,
}

fn peer(directory: &Path, name: &str) -> (Arc<PeerNode>, Arc<Receiver>) {
    let receiver = Arc::new(
        Receiver::new(
            directory,
            ReceiveLimits {
                active_bytes: MAX_BYTES,
                session_offers: 2,
            },
        )
        .unwrap(),
    );
    let store = Arc::new(support::Store::default());
    let identity = Identity::load_or_create(&*store).unwrap();
    let node = PeerNode::new(
        identity,
        name.into(),
        Platform::Windows,
        store,
        receiver.clone(),
    )
    .unwrap();
    (Arc::new(node), receiver)
}

fn digest(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut sha = Sha256::new();
    let mut chunk = vec![0; 64 * 1024];
    loop {
        let count = file.read(&mut chunk)?;
        if count == 0 {
            return Ok(format!("{:x}", sha.finalize()));
        }
        sha.update(&chunk[..count]);
    }
}

async fn trial(
    source: &Path,
    scratch: &Path,
    size: u64,
    expected_hash: &str,
    forward: bool,
) -> Value {
    let sink_dir = tempfile::tempdir_in(scratch).unwrap();
    let source_dir = tempfile::tempdir_in(scratch).unwrap();
    let (sink, receiver) = peer(sink_dir.path(), "Validation receiver");
    let (source_peer, _) = peer(source_dir.path(), "Validation sender");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let shutdown = CancellationToken::new();
    let server = tokio::spawn({
        let sink = sink.clone();
        let shutdown = shutdown.clone();
        async move { sink.serve(listener, shutdown).await.unwrap() }
    });

    let mut pairing = sink.pairing().subscribe();
    let invitation = sink.pairing().create_invitation().unwrap();
    let connection_start = Instant::now();
    let redeem = tokio::spawn({
        let source_peer = source_peer.clone();
        async move { source_peer.redeem(address, &invitation.code).await.unwrap() }
    });
    let request = pairing
        .wait_for(Option::is_some)
        .await
        .unwrap()
        .as_ref()
        .unwrap()
        .id;
    let invitation_to_consent = connection_start.elapsed();
    sink.pairing().confirm(request, true).unwrap();
    let device = redeem.await.unwrap();

    let mut offers = receiver.subscribe();
    let approver = tokio::spawn(async move {
        loop {
            if let Some(offer) = receiver
                .snapshot()
                .into_iter()
                .find(|offer| offer.status.state == State::Pending)
            {
                receiver.respond(offer.key, true).unwrap();
                break;
            }
            offers.changed().await.unwrap();
        }
    });

    let (notifications, mut listener) = watch::channel(None::<Status>);
    let observer = tokio::spawn(async move {
        let mut observed = 0;
        while listener.changed().await.is_ok() {
            if std::hint::black_box(*listener.borrow_and_update()).is_some() {
                observed += 1;
            }
        }
        observed
    });

    let trace = Arc::new(Mutex::new(Progress::default()));
    let tx = source_peer
        .sender(
            address,
            device.id,
            Duration::from_secs(15),
            Duration::from_secs(30),
        )
        .unwrap();
    let complete = tx
        .send_file(source, DESTINATION, CancellationToken::new(), {
            let trace = trace.clone();
            move |_, status| {
                if status.state != State::Transferring {
                    return;
                }
                let mut stats = trace.lock().unwrap();
                stats
                    .first
                    .get_or_insert_with(|| (Instant::now(), status.bytes_transferred));
                let started = Instant::now();
                if forward {
                    notifications.send_replace(Some(status));
                }
                stats.callback_ns += started.elapsed().as_nanos();
                stats.events += 1;
            }
        })
        .await
        .unwrap();
    let confirmed_at = Instant::now();
    assert_eq!(complete.state, State::Completed);
    assert_eq!(complete.bytes_transferred, size);
    approver.await.unwrap();
    let observed = observer.await.unwrap();
    assert_eq!(observed > 0, forward);

    let saved = sink_dir.path().join(DESTINATION);
    assert_eq!(fs::metadata(&saved).unwrap().len(), size);
    assert_eq!(digest(&saved).unwrap(), expected_hash);
    shutdown.cancel();
    server.await.unwrap();

    let stats = trace.lock().unwrap();
    let (first, first_bytes) = stats.first.unwrap();
    let upload = confirmed_at.duration_since(first);
    json!({
        "forwarding": forward,
        "invitationToConsentMs": invitation_to_consent.as_secs_f64() * 1000.0,
        "firstProgressToConfirmationMs": upload.as_secs_f64() * 1000.0,
        "bytesAfterFirstProgress": size - first_bytes,
        "progressEvents": stats.events,
        "observedNotifications": observed,
        "meanTimedCallbackNs": stats.callback_ns as f64 / stats.events as f64,
        "sha256": expected_hash,
    })
}

fn main() {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    let [source, scratch] = arguments.as_slice() else {
        panic!("usage: peer-progress-probe <fixture file> <scratch directory>");
    };
    let (source, scratch) = (Path::new(source), Path::new(scratch));
    let metadata = fs::metadata(source).unwrap();
    let size = metadata.len();
    assert!(metadata.is_file() && size >= 1024 * 1024 && size <= MAX_BYTES);
    let expected_hash = digest(source).unwrap();
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            for index in 0..=5 {
                for forward in [index % 2 == 1, index % 2 == 0] {
                    let mut result = timeout(
                        DEADLINE,
                        trial(source, scratch, size, &expected_hash, forward),
                    )
                    .await
                    .expect("peer probe timed out");
                    result["pair"] = json!(index);
                    result["warmup"] = json!(index == 0);
                    println!("{result}");
                }
            }
        });
}
