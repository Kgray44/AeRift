mod support;

use aerift_peers::{
    Device, Identity, PeerNode, Platform, RemotePeerNode, RemoteTrustStore, TrustStore,
};
use aerift_transfer::{ErrorCode, PeerId, ReceiveLimits, Receiver, State, TransferError};
use std::{
    collections::HashMap,
    fs,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use support::Store;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::timeout,
};
use tokio_util::sync::CancellationToken;

const DECISION: Duration = Duration::from_secs(4);
const UPLOAD: Duration = Duration::from_secs(5);
const WAIT: Duration = Duration::from_secs(3);
const LIMITS: ReceiveLimits = ReceiveLimits {
    active_bytes: 4 * 1024 * 1024,
    session_offers: 8,
};

#[derive(Default)]
struct RemoteStore(Mutex<HashMap<PeerId, Device>>);

impl RemoteTrustStore for RemoteStore {
    fn load_remote(&self) -> Result<Vec<Device>, TransferError> {
        Ok(self.0.lock().unwrap().values().cloned().collect())
    }

    fn put_remote(&self, device: &Device) -> Result<(), TransferError> {
        self.0.lock().unwrap().insert(device.id, device.clone());
        Ok(())
    }

    fn remove_remote(&self, peer: PeerId) -> Result<(), TransferError> {
        self.0.lock().unwrap().remove(&peer);
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_invitations_and_file_approval_are_independent_of_existing_lan_trust() {
    timeout(Duration::from_secs(20), exercise_scope_boundary())
        .await
        .expect("remote authority scenario exceeded the global deadline");
}

async fn exercise_scope_boundary() {
    let fixtures = tempfile::tempdir().unwrap();
    let destination = |name| {
        let path = fixtures.path().join(name);
        fs::create_dir(&path).unwrap();
        path
    };
    let a_lan_dir = destination("a-lan");
    let b_lan_dir = destination("b-lan");
    let a_remote_dir = destination("a-remote");
    let b_remote_dir = destination("b-remote");
    let a_lan_trust = Arc::new(Store::default());
    let b_lan_trust = Arc::new(Store::default());
    let a_identity = || Identity::load_or_create(a_lan_trust.as_ref()).unwrap();
    let b_identity = || Identity::load_or_create(b_lan_trust.as_ref()).unwrap();
    let a_profile = Device {
        id: a_identity().id(),
        name: "Test sender".into(),
        platform: Platform::Windows,
    };
    let b_profile = Device {
        id: b_identity().id(),
        name: "Test receiver".into(),
        platform: Platform::Linux,
    };
    a_lan_trust.put(&b_profile).unwrap();
    b_lan_trust.put(&a_profile).unwrap();
    let a_lan = PeerNode::new(
        a_identity(),
        a_profile.name.clone(),
        a_profile.platform,
        a_lan_trust.clone(),
        Arc::new(Receiver::new(&a_lan_dir, LIMITS).unwrap()),
    )
    .unwrap();
    let b_lan = PeerNode::new(
        b_identity(),
        b_profile.name.clone(),
        b_profile.platform,
        b_lan_trust.clone(),
        Arc::new(Receiver::new(&b_lan_dir, LIMITS).unwrap()),
    )
    .unwrap();
    let a_remote_trust = Arc::new(RemoteStore::default());
    let b_remote_trust = Arc::new(RemoteStore::default());
    let a_remote = Arc::new(
        RemotePeerNode::new(
            a_identity(),
            a_profile.name.clone(),
            a_profile.platform,
            a_remote_trust.clone(),
            &a_remote_dir,
            LIMITS,
        )
        .unwrap(),
    );
    let b_remote = Arc::new(
        RemotePeerNode::new(
            b_identity(),
            b_profile.name.clone(),
            b_profile.platform,
            b_remote_trust.clone(),
            &b_remote_dir,
            LIMITS,
        )
        .unwrap(),
    );
    assert_eq!(a_remote.device().id, a_lan.pairing().device().id);
    assert_eq!(b_remote.device().id, b_lan.pairing().device().id);
    assert!(a_remote.trusted_devices().is_empty());
    assert!(b_remote.trusted_devices().is_empty());

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let _stop_on_drop = stop.clone().drop_guard();
    let serve = tokio::spawn({
        let b_remote = b_remote.clone();
        let stop = stop.clone();
        async move { b_remote.serve(listener, stop).await.unwrap() }
    });
    let routes = [address];
    let source = fixtures.path().join("fixture.bin");
    let bytes: Vec<_> = (0..262_181).map(|i| (i % 251) as u8).collect();
    fs::write(&source, &bytes).unwrap();
    assert_eq!(
        a_remote
            .sender(&routes, b_profile.id, DECISION, UPLOAD)
            .err()
            .unwrap()
            .code,
        ErrorCode::PeerUntrusted
    );

    // The same certs and valid LAN trust still cannot authorize remote ingress.
    let legacy_sender = a_lan
        .sender(address, b_profile.id, DECISION, UPLOAD)
        .unwrap();
    assert_eq!(
        legacy_sender
            .send_file(
                &source,
                "lan-to-remote.bin",
                CancellationToken::new(),
                |_, _| {}
            )
            .await
            .unwrap_err()
            .code,
        ErrorCode::PeerUntrusted
    );
    assert!(b_remote.transfers().is_empty());

    let nearby_invite = b_lan.pairing().create_invitation().unwrap();
    let mut pending = b_remote.subscribe_pairing();
    let remote_invite = b_remote.create_invitation(a_profile.id).unwrap();
    assert_eq!(
        RemotePeerNode::invitation_peer(&remote_invite.code).unwrap(),
        b_profile.id
    );
    assert!(PeerNode::invitation_peer(&remote_invite.code).is_err());
    assert!(RemotePeerNode::invitation_peer(&nearby_invite.code).is_err());
    assert!(a_remote.redeem(&routes, &nearby_invite.code).await.is_err());
    assert!(a_lan.redeem(address, &nearby_invite.code).await.is_err());
    assert!(pending.borrow().is_none());

    let stranger_store = Store::default();
    let stranger = RemotePeerNode::new(
        Identity::load_or_create(&stranger_store).unwrap(),
        "Uninvited fixture".into(),
        Platform::Linux,
        Arc::new(RemoteStore::default()),
        &destination("uninvited"),
        LIMITS,
    )
    .unwrap();
    assert_eq!(
        stranger
            .redeem(&routes, &remote_invite.code)
            .await
            .unwrap_err()
            .code,
        ErrorCode::PairingRejected
    );
    assert!(pending.borrow().is_none());
    assert!(stranger.trusted_devices().is_empty());

    let redeem = tokio::spawn({
        let a_remote = a_remote.clone();
        async move { a_remote.redeem(&routes, &remote_invite.code).await.unwrap() }
    });
    let request = timeout(WAIT, pending.wait_for(Option::is_some))
        .await
        .unwrap()
        .unwrap()
        .as_ref()
        .unwrap()
        .clone();
    assert_eq!(request.device.id, a_profile.id);
    assert!(b_remote.trusted_devices().is_empty());
    assert!(!redeem.is_finished());
    b_remote.confirm_pairing(request.id, true).unwrap();
    assert_eq!(
        timeout(WAIT, redeem).await.unwrap().unwrap().id,
        b_profile.id
    );
    assert_eq!(a_remote_trust.load_remote().unwrap()[0].id, b_profile.id);
    assert_eq!(b_remote_trust.load_remote().unwrap()[0].id, a_profile.id);

    let sender = a_remote
        .sender(&routes, b_profile.id, DECISION, UPLOAD)
        .unwrap();
    let mut transfers = b_remote.subscribe_transfers();
    let incoming = tokio::spawn({
        let source = source.clone();
        async move {
            sender
                .send_file(&source, "approved.bin", CancellationToken::new(), |_, _| {})
                .await
                .unwrap()
        }
    });
    let offer = timeout(WAIT, async {
        loop {
            if let Some(offer) = b_remote
                .transfers()
                .into_iter()
                .find(|offer| offer.status.state == State::Pending)
            {
                break offer;
            }
            transfers.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert_eq!(offer.key.peer, a_profile.id);
    assert!(!b_remote_dir.join("approved.bin").exists());
    assert!(!incoming.is_finished());
    b_remote.respond(offer.key, true).unwrap();
    let receipt = timeout(WAIT, incoming).await.unwrap().unwrap();
    assert_eq!(receipt.state, State::Completed);
    assert_eq!(receipt.bytes_transferred, bytes.len() as u64);
    assert_eq!(fs::read(b_remote_dir.join("approved.bin")).unwrap(), bytes);
    assert!(!b_lan_dir.join("approved.bin").exists());

    // Use the separate version over the real Remote TLS listener. It must
    // publish once, only after approval and an authenticated commit receipt.
    let mut resumed_data = vec![0x68; 2 * 1024 * 1024 + 173];
    resumed_data[1024 * 1024 + 13] = 0x77;
    fs::write(&source, &resumed_data).unwrap();
    let id = uuid::Uuid::new_v4();
    let resume_id = id;
    let bridge = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let interrupted_routes = [bridge.local_addr().unwrap()];
    let chunk_streams = Arc::new(AtomicUsize::new(0));
    let dropped = Arc::new(AtomicUsize::new(0));
    let proxy = tokio::spawn({
        let chunk_streams = chunk_streams.clone();
        let dropped = dropped.clone();
        async move { interrupt_second_chunk(bridge, address, chunk_streams, dropped).await }
    });
    let resumable = a_remote
        .sender(&interrupted_routes, b_profile.id, DECISION, UPLOAD)
        .unwrap();
    let write = tokio::spawn({
        let source = source.clone();
        async move {
            resumable
                .send_resumable_file_with_id(
                    resume_id,
                    &source,
                    "resumable.bin",
                    CancellationToken::new(),
                    |_, _| {},
                )
                .await
                .unwrap()
        }
    });
    let pending = timeout(WAIT, async {
        loop {
            if let Some(offer) = b_remote
                .transfers()
                .into_iter()
                .find(|offer| offer.key.id == id && offer.status.state == State::Pending)
            {
                break offer;
            }
            transfers.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert!(!b_remote_dir.join("resumable.bin").exists());
    b_remote.respond(pending.key, true).unwrap();
    let receipt = timeout(Duration::from_secs(8), write)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(receipt.state, State::Completed);
    assert_eq!(receipt.bytes_transferred, resumed_data.len() as u64);
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
    assert!(chunk_streams.load(Ordering::SeqCst) >= 3);
    proxy.abort();
    let _ = proxy.await;
    assert_eq!(
        fs::read(b_remote_dir.join("resumable.bin")).unwrap(),
        resumed_data
    );
    let resumable = a_remote
        .sender(&routes, b_profile.id, DECISION, UPLOAD)
        .unwrap();
    assert_eq!(
        resumable.status(id).await.unwrap_err().code,
        ErrorCode::Conflict
    );
    assert_eq!(
        resumable
            .send_resumable_file_with_id(
                id,
                &source,
                "resumable.bin",
                CancellationToken::new(),
                |_, _| {}
            )
            .await
            .unwrap(),
        receipt
    );
    assert!(!b_remote_dir.join("1-resumable.bin").exists());

    // Revoke the recipient-side Remote grant; the same identity remains nearby-trusted.
    b_remote.revoke(a_profile.id).unwrap();
    assert!(b_remote_trust.load_remote().unwrap().is_empty());
    assert!(b_lan.pairing().is_trusted(a_profile.id));
    let sender = a_remote
        .sender(&routes, b_profile.id, DECISION, UPLOAD)
        .unwrap();
    assert_eq!(
        sender
            .send_file(
                &source,
                "after-revoke.bin",
                CancellationToken::new(),
                |_, _| {}
            )
            .await
            .unwrap_err()
            .code,
        ErrorCode::PeerUntrusted
    );
    assert!(!b_remote_dir.join("after-revoke.bin").exists());
    // Revoking Nearby does not erase the independently persisted Remote grant.
    a_lan.revoke(b_profile.id).unwrap();
    assert!(!a_lan.pairing().is_trusted(b_profile.id));
    assert_eq!(a_remote_trust.load_remote().unwrap()[0].id, b_profile.id);
    stop.cancel();
    timeout(WAIT, serve).await.unwrap().unwrap();
}

// Use real routed TCP byte streams and leave the mTLS session end to end.
// The proxy never decrypts anything. After two large encrypted sends are
// observed, cut the second before the receiver has its full block.
async fn interrupt_second_chunk(
    listener: TcpListener,
    target: std::net::SocketAddr,
    chunk_streams: Arc<AtomicUsize>,
    dropped: Arc<AtomicUsize>,
) {
    let mut streams = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            _ = streams.join_next(), if !streams.is_empty() => {}
            result = listener.accept() => {
                let (incoming, _) = result.unwrap();
                let chunk_streams = chunk_streams.clone();
                let dropped = dropped.clone();
                streams.spawn(async move {
                    let mut outgoing = TcpStream::connect(target).await?;
                    let mut incoming = incoming;
                    let (mut sender, mut to_sender) = incoming.split();
                    let (mut receiver, mut to_receiver) = outgoing.split();
                    let upload = async {
                        let mut count = 0;
                        let mut frame = [0; 8192];
                        loop {
                            let read = sender.read(&mut frame).await?;
                            if read == 0 { break; }
                            let next = count + read;
                            if count < 256 * 1024 && next >= 256 * 1024
                                && chunk_streams.fetch_add(1, Ordering::SeqCst) == 1
                            {
                                dropped.fetch_add(1, Ordering::SeqCst);
                                return Ok::<_, std::io::Error>(());
                            }
                            to_receiver.write_all(&frame[..read]).await?;
                            count = next;
                        }
                        to_receiver.shutdown().await
                    };
                    tokio::select! {
                        result = upload => result,
                        result = tokio::io::copy(&mut receiver, &mut to_sender) => result.map(|_| ()),
                    }
                });
            }
        }
    }
}
