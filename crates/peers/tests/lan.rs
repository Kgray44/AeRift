mod support;

use aerift_peers::{Identity, PeerNode, Platform};
use aerift_transfer::{ErrorCode, ReceiveLimits, Receiver, State};
use std::{
    fs,
    sync::{Arc, atomic::Ordering},
    time::Duration,
};
use support::Store;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pairing_is_pinned_and_approved_then_real_files_can_be_sent_both_ways() {
    let a_dir = tempfile::tempdir().unwrap();
    let b_dir = tempfile::tempdir().unwrap();
    let a_store = Arc::new(Store::default());
    let b_store = Arc::new(Store::default());
    let limits = ReceiveLimits {
        active_bytes: 16 * 1024 * 1024,
        session_offers: 32,
    };
    let a_recv = Arc::new(Receiver::new(a_dir.path(), limits).unwrap());
    let b_recv = Arc::new(Receiver::new(b_dir.path(), limits).unwrap());
    let a = Arc::new(
        PeerNode::new(
            Identity::load_or_create(a_store.as_ref()).unwrap(),
            "Windows fixture".to_owned(),
            Platform::Windows,
            a_store.clone(),
            a_recv.clone(),
        )
        .unwrap(),
    );
    let b = Arc::new(
        PeerNode::new(
            Identity::load_or_create(b_store.as_ref()).unwrap(),
            "iOS fixture".to_owned(),
            Platform::Ios,
            b_store.clone(),
            b_recv.clone(),
        )
        .unwrap(),
    );
    let a_id = a.pairing().device().id;
    let b_id = b.pairing().device().id;
    assert_eq!(
        Identity::load_or_create(a_store.as_ref()).unwrap().id(),
        a_id
    );
    assert_ne!(a_id, b_id);

    let a_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let b_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let a_addr = a_listener.local_addr().unwrap();
    let b_addr = b_listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let run_a = tokio::spawn({
        let a = a.clone();
        let stop = stop.clone();
        async move { a.serve(a_listener, stop).await.unwrap() }
    });
    let run_b = tokio::spawn({
        let b = b.clone();
        let stop = stop.clone();
        async move { b.serve(b_listener, stop).await.unwrap() }
    });
    let decision = Duration::from_secs(5);
    let upload = Duration::from_secs(8);
    assert_eq!(
        a.sender(b_addr, b_id, decision, upload).err().unwrap().code,
        ErrorCode::PeerUntrusted
    );
    let mut pending = b.pairing().subscribe();
    let invitation = b.pairing().create_invitation().unwrap();
    assert_eq!(PeerNode::invitation_peer(&invitation.code).unwrap(), b_id);
    assert_eq!(
        a.redeem(a_addr, &invitation.code).await.unwrap_err().code,
        ErrorCode::PeerUntrusted
    );
    assert!(pending.borrow().is_none());

    let denied = tokio::spawn({
        let a = a.clone();
        let code = invitation.code.clone();
        async move { a.redeem(b_addr, &code).await }
    });
    let request = tokio::time::timeout(Duration::from_secs(5), pending.wait_for(Option::is_some))
        .await
        .unwrap()
        .unwrap()
        .as_ref()
        .unwrap()
        .clone();
    assert_eq!(request.device.id, a_id);
    assert!(!b.pairing().is_trusted(a_id));
    b.pairing().confirm(request.id, false).unwrap();
    assert_eq!(
        denied.await.unwrap().unwrap_err().code,
        ErrorCode::PairingRejected
    );
    assert_eq!(
        a.redeem(b_addr, &invitation.code).await.unwrap_err().code,
        ErrorCode::PairingExpired
    );

    let invitation = b.pairing().create_invitation().unwrap();
    let redeeming = tokio::spawn({
        let a = a.clone();
        let code = invitation.code.clone();
        async move { a.redeem(b_addr, &code).await }
    });
    let request = tokio::time::timeout(Duration::from_secs(5), pending.wait_for(Option::is_some))
        .await
        .unwrap()
        .unwrap()
        .as_ref()
        .unwrap()
        .clone();
    assert!(!redeeming.is_finished());
    b_store.reject_trust_writes.store(true, Ordering::Relaxed);
    assert_eq!(
        b.pairing().confirm(request.id, true).unwrap_err().code,
        ErrorCode::StorageFailed
    );
    assert!(!b.pairing().is_trusted(a_id));
    assert_eq!(pending.borrow().as_ref().unwrap().id, request.id);
    b_store.reject_trust_writes.store(false, Ordering::Relaxed);
    b.pairing().confirm(request.id, true).unwrap();
    assert_eq!(redeeming.await.unwrap().unwrap().id, b_id);
    assert_eq!(a.redeem(b_addr, &invitation.code).await.unwrap().id, b_id);
    assert!(b.pairing().is_trusted(a_id));
    let reloaded = PeerNode::new(
        Identity::load_or_create(a_store.as_ref()).unwrap(),
        "Windows fixture".to_owned(),
        Platform::Windows,
        a_store.clone(),
        a_recv.clone(),
    )
    .unwrap();
    assert!(reloaded.pairing().is_trusted(b_id));

    let a_source = a_dir.path().join("local.bin");
    let b_source = b_dir.path().join("local.bin");
    let a_data = vec![0x95; 256 * 1024 + 37];
    let b_data = vec![0x28; 512 * 1024 + 19];
    fs::write(&a_source, &a_data).unwrap();
    fs::write(&b_source, &b_data).unwrap();
    let approve = |receiver: Arc<Receiver>| async move {
        let mut updates = receiver.subscribe();
        loop {
            for receipt in receiver.snapshot() {
                if receipt.status.state == State::Pending {
                    receiver.respond(receipt.key, true).unwrap();
                    return;
                }
            }
            updates.changed().await.unwrap();
        }
    };
    let a_approve = tokio::spawn(approve(a_recv));
    let b_approve = tokio::spawn(approve(b_recv));
    let a_sender = a.sender(b_addr, b_id, decision, upload).unwrap();
    let b_sender = b.sender(a_addr, a_id, decision, upload).unwrap();
    let (to_b, to_a) = tokio::join!(
        a_sender.send_file(&a_source, "remote.bin", CancellationToken::new(), |_, _| {}),
        b_sender.send_file(&b_source, "remote.bin", CancellationToken::new(), |_, _| {}),
    );
    assert_eq!(to_b.unwrap().state, State::Completed);
    assert_eq!(to_a.unwrap().state, State::Completed);
    assert_eq!(fs::read(a_dir.path().join("remote.bin")).unwrap(), b_data);
    assert_eq!(fs::read(b_dir.path().join("remote.bin")).unwrap(), a_data);
    a_approve.await.unwrap();
    b_approve.await.unwrap();
    b.revoke(a_id).unwrap();
    assert!(!b.pairing().is_trusted(a_id));
    assert_eq!(
        a.redeem(b_addr, &invitation.code).await.unwrap_err().code,
        ErrorCode::PairingExpired
    );
    assert_eq!(
        a_sender
            .send_file(
                &a_source,
                "after-revoke.bin",
                CancellationToken::new(),
                |_, _| {}
            )
            .await
            .unwrap_err()
            .code,
        ErrorCode::PeerUntrusted
    );
    stop.cancel();
    run_a.await.unwrap();
    run_b.await.unwrap();
}
