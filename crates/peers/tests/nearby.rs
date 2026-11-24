mod support;

use aerift_peers::{Identity, PeerNode, Platform};
use aerift_transfer::{ReceiveLimits, Receiver};
use std::{
    net::{Ipv4Addr, SocketAddr},
    sync::Arc,
};
use support::Store;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

fn node(name: &str, store: &Arc<Store>, dir: &std::path::Path) -> Arc<PeerNode> {
    Arc::new(
        PeerNode::new(
            Identity::load_or_create(store.as_ref()).unwrap(),
            name.into(),
            Platform::Linux,
            store.clone(),
            Arc::new(
                Receiver::new(
                    dir,
                    ReceiveLimits {
                        active_bytes: 4096,
                        session_offers: 8,
                    },
                )
                .unwrap(),
            ),
        )
        .unwrap(),
    )
}

#[tokio::test]
async fn nearby_code_and_two_independent_approvals_gate_trust() {
    let a_dir = tempfile::tempdir().unwrap();
    let b_dir = tempfile::tempdir().unwrap();
    let a_store = Arc::new(Store::default());
    let b_store = Arc::new(Store::default());
    let a = node("First", &a_store, a_dir.path());
    let b = node("Second", &b_store, b_dir.path());
    let a_id = a.pairing().device().id;
    let b_id = b.pairing().device().id;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let endpoint = listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let task = {
        let b = b.clone();
        let stop = stop.clone();
        tokio::spawn(async move {
            b.serve_with_nearby(listener, stop, move |peer, source: SocketAddr| {
                peer == a_id && source.ip().is_loopback()
            })
            .await
            .unwrap();
        })
    };
    let pending = a.begin_nearby(endpoint, b_id).await.unwrap();
    let incoming = b.subscribe_nearby().borrow().clone().unwrap();
    assert_eq!(incoming.id, pending.id);
    assert_eq!(incoming.verification, pending.verification);
    assert_eq!(incoming.verification.len(), 6);
    assert!(
        incoming
            .verification
            .bytes()
            .all(|byte| byte.is_ascii_digit())
    );
    assert!(!a.pairing().is_trusted(b_id));
    assert!(!b.pairing().is_trusted(a_id));
    b.confirm_nearby(incoming.id, true).unwrap();
    assert!(!b.pairing().is_trusted(a_id));
    a.finish_nearby(pending, true).await.unwrap();
    assert!(a.pairing().is_trusted(b_id));
    assert!(b.pairing().is_trusted(a_id));
    stop.cancel();
    task.await.unwrap();
}

#[tokio::test]
async fn requester_first_waits_and_recipient_decline_never_pairs() {
    let a_dir = tempfile::tempdir().unwrap();
    let b_dir = tempfile::tempdir().unwrap();
    let a = node("First", &Arc::new(Store::default()), a_dir.path());
    let b = node("Second", &Arc::new(Store::default()), b_dir.path());
    let a_id = a.pairing().device().id;
    let b_id = b.pairing().device().id;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let endpoint = listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let task = {
        let b = b.clone();
        let stop = stop.clone();
        tokio::spawn(async move {
            b.serve_with_nearby(listener, stop, move |peer, source: SocketAddr| {
                peer == a_id && source.ip().is_loopback()
            })
            .await
            .unwrap();
        })
    };
    let first = a.begin_nearby(endpoint, b_id).await.unwrap();
    let old_id = first.id;
    let mut approval = {
        let a = a.clone();
        tokio::spawn(async move { a.finish_nearby(first, true).await })
    };
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(70), &mut approval)
            .await
            .is_err()
    );
    assert!(!a.pairing().is_trusted(b_id));
    assert!(!b.pairing().is_trusted(a_id));
    b.confirm_nearby(old_id, false).unwrap();
    assert!(approval.await.unwrap().is_err());
    assert!(b.subscribe_nearby().borrow().is_none());
    assert!(b.confirm_nearby(old_id, true).is_err());
    let second = a.begin_nearby(endpoint, b_id).await.unwrap();
    assert_ne!(second.id, old_id);
    a.finish_nearby(second, false).await.unwrap();
    assert!(!a.pairing().is_trusted(b_id));
    assert!(!b.pairing().is_trusted(a_id));
    stop.cancel();
    task.await.unwrap();
}

#[tokio::test]
async fn unobserved_sources_and_different_certificates_cannot_initiate() {
    let a_dir = tempfile::tempdir().unwrap();
    let b_dir = tempfile::tempdir().unwrap();
    let a = node("First", &Arc::new(Store::default()), a_dir.path());
    let b = node("Second", &Arc::new(Store::default()), b_dir.path());
    let b_id = b.pairing().device().id;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let endpoint = listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let task = {
        let b = b.clone();
        let stop = stop.clone();
        tokio::spawn(async move { b.serve(listener, stop).await.unwrap() })
    };
    assert!(
        a.begin_nearby(endpoint, a.pairing().device().id)
            .await
            .is_err()
    );
    assert!(a.begin_nearby(endpoint, b_id).await.is_err());
    assert!(b.subscribe_nearby().borrow().is_none());
    stop.cancel();
    task.await.unwrap();
}

#[tokio::test]
async fn ambient_mount_requires_native_scope_and_never_changes_ordinary_transfer_route() {
    use aerift_peers::TrustStore;
    use aerift_transfer::{
        ErrorCode,
        ambient::{Candidate, CaptureContext, CaptureLimits, freeze, nearby_drop::NearbyDrop},
    };
    use std::{
        sync::atomic::{AtomicBool, Ordering},
        time::{Duration, Instant},
    };

    let a_dir = tempfile::tempdir().unwrap();
    let b_dir = tempfile::tempdir().unwrap();
    let a_store = Arc::new(Store::default());
    let b_store = Arc::new(Store::default());
    let a_seed = node("fixture A", &a_store, a_dir.path());
    let b_seed = node("fixture B", &b_store, b_dir.path());
    a_store.put(&b_seed.pairing().device()).unwrap();
    b_store.put(&a_seed.pairing().device()).unwrap();
    let a = node("fixture A", &a_store, a_dir.path());
    let b = node("fixture B", &b_store, b_dir.path());
    let a_id = a.pairing().device().id;
    let b_id = b.pairing().device().id;

    let file = b_dir.path().join("selected");
    std::fs::write(&file, b"fixture").unwrap();
    let capture = freeze(
        CaptureContext {
            explicit_selection: vec![Candidate::path(file)],
            ..Default::default()
        },
        CaptureLimits::default(),
    )
    .unwrap();
    let pickup = Arc::new(NearbyDrop::open(capture, Instant::now()).unwrap());
    let enabled = Arc::new(AtomicBool::new(false));
    let nearby = Arc::new(AtomicBool::new(true));
    let generation = CancellationToken::new();
    let stop = CancellationToken::new();
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let serving = tokio::spawn({
        let (enabled, nearby, generation, stop) = (
            enabled.clone(),
            nearby.clone(),
            generation.clone(),
            stop.clone(),
        );
        async move {
            b.serve_with_nearby_ambient(
                listener,
                stop,
                move |peer, addr| {
                    peer == a_id && addr.ip().is_loopback() && nearby.load(Ordering::SeqCst)
                },
                Arc::new(move || {
                    enabled
                        .load(Ordering::SeqCst)
                        .then(|| (Some(pickup.clone()), generation.clone()))
                }),
            )
            .await
            .unwrap();
        }
    });

    let client = a
        .sender(addr, b_id, Duration::from_secs(4), Duration::from_secs(4))
        .unwrap();
    assert_eq!(
        client.nearby_drop_challenge().await.unwrap_err().code,
        ErrorCode::UnsupportedVersion
    );
    assert!(!client.receiver_ready().await.unwrap());
    enabled.store(true, Ordering::SeqCst);
    let challenge = client.nearby_drop_challenge().await.unwrap().unwrap();
    nearby.store(false, Ordering::SeqCst);
    assert_eq!(
        client.record_nearby_drop(challenge).await.unwrap_err().code,
        ErrorCode::PeerUntrusted
    );
    assert!(!client.receiver_ready().await.unwrap());
    nearby.store(true, Ordering::SeqCst);
    generation.cancel();
    assert_eq!(
        client.record_nearby_drop(challenge).await.unwrap_err().code,
        ErrorCode::PeerUntrusted
    );
    stop.cancel();
    serving.await.unwrap();
}
