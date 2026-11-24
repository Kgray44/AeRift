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
