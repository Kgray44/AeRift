//! Composition qualification only; uses synthetic devices and no external network.
mod support;

use std::{
    net::{Ipv4Addr, SocketAddr},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use aerift_peers::{
    Device, Identity, PeerNode, Platform, RemotePeerNode, RemoteTrustStore, TrustStore,
};
use aerift_transfer::{ErrorCode, PeerId, ReceiveLimits, Receiver, TransferError};
use support::Store;
use tokio::{net::TcpListener, time::timeout};
use tokio_util::sync::CancellationToken;

const LIMITS: ReceiveLimits = ReceiveLimits {
    active_bytes: 20 * 1024 * 1024,
    session_offers: 16,
};
const WAIT: Duration = Duration::from_secs(5);

impl RemoteTrustStore for Store {
    fn load_remote(&self) -> Result<Vec<Device>, TransferError> {
        TrustStore::load(self)
    }
    fn put_remote(&self, device: &Device) -> Result<(), TransferError> {
        self.put(device)
    }
    fn remove_remote(&self, peer: PeerId) -> Result<(), TransferError> {
        self.remove(peer)
    }
}

#[tokio::test]
async fn explicit_nearby_discovery_and_remote_invites_remain_disjoint_on_composed_head() {
    timeout(Duration::from_secs(20), exercise()).await.unwrap();
}

async fn exercise() {
    let root = tempfile::tempdir().unwrap();
    let directory = |name: &str| {
        let directory = root.path().join(name);
        std::fs::create_dir(&directory).unwrap();
        directory
    };
    let a_keys = Arc::new(Store::default());
    let b_keys = Arc::new(Store::default());
    let identity = |keys: &Store| Identity::load_or_create(keys).unwrap();
    let a_dir = directory("a-nearby");
    let b_dir = directory("b-nearby");
    let b_inbox = Arc::new(Receiver::new(&b_dir, LIMITS).unwrap());
    let a_lan = PeerNode::new(
        identity(&a_keys),
        "Sender".into(),
        Platform::Linux,
        a_keys.clone(),
        Arc::new(Receiver::new(&a_dir, LIMITS).unwrap()),
    )
    .unwrap();
    let b_lan = Arc::new(
        PeerNode::new(
            identity(&b_keys),
            "Receiver".into(),
            Platform::Linux,
            b_keys.clone(),
            b_inbox.clone(),
        )
        .unwrap(),
    );
    let a_remote = RemotePeerNode::new(
        identity(&a_keys),
        "Sender".into(),
        Platform::Linux,
        Arc::new(Store::default()),
        &directory("a-remote"),
        LIMITS,
    )
    .unwrap();
    let b_remote = Arc::new(
        RemotePeerNode::new(
            identity(&b_keys),
            "Receiver".into(),
            Platform::Linux,
            Arc::new(Store::default()),
            &directory("b-remote"),
            LIMITS,
        )
        .unwrap(),
    );
    let a = a_lan.pairing().device().id;
    let b = b_lan.pairing().device().id;
    assert_eq!(a, a_remote.device().id);
    assert_eq!(b, b_remote.device().id);

    // Legacy Nearby historically binds wildcard. This test uses loopback to
    // exercise that listener, but only a matched observed address may pair.
    let wildcard = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).await.unwrap();
    let lan = SocketAddr::from((Ipv4Addr::LOCALHOST, wildcard.local_addr().unwrap().port()));
    let remote_wildcard = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).await.unwrap();
    assert_eq!(
        b_remote
            .serve(remote_wildcard, CancellationToken::new())
            .await
            .unwrap_err()
            .code,
        ErrorCode::InvalidRequest
    );
    let explicit = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let remote = explicit.local_addr().unwrap();

    let discovery = Arc::new(AtomicBool::new(false));
    let stop = CancellationToken::new();
    let _stop_on_drop = stop.clone().drop_guard();
    let lan_task = {
        let (b_lan, discovery, stop) = (b_lan.clone(), discovery.clone(), stop.clone());
        tokio::spawn(async move {
            b_lan
                .serve_with_nearby(wildcard, stop, move |id, observed| {
                    discovery.load(Ordering::SeqCst) && id == a && observed.ip().is_loopback()
                })
                .await
                .unwrap();
        })
    };
    let remote_task = {
        let (b_remote, stop) = (b_remote.clone(), stop.clone());
        tokio::spawn(async move {
            b_remote.serve(explicit, stop).await.unwrap();
        })
    };

    assert_eq!(
        a_lan.begin_nearby(lan, b).await.err().unwrap().code,
        ErrorCode::PeerUnavailable
    );
    assert!(b_lan.subscribe_nearby().borrow().is_none());
    discovery.store(true, Ordering::SeqCst);
    assert!(a_lan.begin_nearby(remote, b).await.is_err());
    assert!(b_remote.subscribe_pairing().borrow().is_none());
    assert!(b_remote.trusted_devices().is_empty());

    let challenge = a_lan.begin_nearby(lan, b).await.unwrap();
    let verified = b_lan.subscribe_nearby().borrow().clone().unwrap();
    assert_eq!(verified.verification, challenge.verification);
    b_lan.confirm_nearby(challenge.id, true).unwrap();
    assert!(!b_lan.pairing().is_trusted(a));
    a_lan.finish_nearby(challenge, true).await.unwrap();
    assert!(b_lan.pairing().is_trusted(a));
    assert!(a_remote.trusted_devices().is_empty());
    assert!(b_remote.trusted_devices().is_empty());

    let invitation = b_remote.create_invitation(a).unwrap();
    assert!(a_remote.redeem(&[lan], &invitation.code).await.is_err());
    assert!(b_lan.subscribe_nearby().borrow().is_none());
    assert!(b_lan.pairing().subscribe().borrow().is_none());
    let mut incoming = b_remote.subscribe_pairing();
    tokio::join!(
        async {
            assert_eq!(
                a_remote
                    .redeem(&[remote], &invitation.code)
                    .await
                    .unwrap()
                    .id,
                b
            );
        },
        async {
            let id = timeout(WAIT, incoming.wait_for(Option::is_some))
                .await
                .unwrap()
                .unwrap()
                .as_ref()
                .unwrap()
                .id;
            b_remote.confirm_pairing(id, true).unwrap();
        }
    );
    let source = root.path().join("local-synthetic.bin");
    std::fs::write(&source, b"synthetic fixture").unwrap();
    assert!(
        a_remote
            .sender(&[lan], b, WAIT, WAIT)
            .unwrap()
            .send_file(
                &source,
                "out-of-scope.bin",
                CancellationToken::new(),
                |_, _| {}
            )
            .await
            .is_err()
    );
    assert!(b_inbox.snapshot().is_empty());

    b_lan.revoke(a).unwrap();
    assert!(!b_lan.pairing().is_trusted(a));
    assert!(b_remote.trusted_devices().iter().any(|d| d.id == a));
    stop.cancel();
    lan_task.await.unwrap();
    remote_task.await.unwrap();
}
