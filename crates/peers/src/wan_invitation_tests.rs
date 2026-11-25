use crate::{Device, Identity, Platform, RemotePeerNode, RemoteTrustStore, SecretStore};
use aerift_transfer::{PeerId, ReceiveLimits, TransferError};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};

#[derive(Default)]
struct Store(Mutex<Option<Vec<u8>>>);
impl SecretStore for Store {
    fn load(&self) -> Result<Option<Vec<u8>>, TransferError> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn initialize(&self, candidate: &[u8]) -> Result<Vec<u8>, TransferError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .get_or_insert_with(|| candidate.to_vec())
            .clone())
    }
}
impl RemoteTrustStore for Store {
    fn load_remote(&self) -> Result<Vec<Device>, TransferError> {
        Ok(vec![])
    }
    fn put_remote(&self, _: &Device) -> Result<(), TransferError> {
        Ok(())
    }
    fn remove_remote(&self, _: PeerId) -> Result<(), TransferError> {
        Ok(())
    }
}
fn node(dir: &Path) -> RemotePeerNode {
    let store = Arc::new(Store::default());
    RemotePeerNode::new(
        Identity::load_or_create(&*store).unwrap(),
        "Device".into(),
        Platform::Linux,
        store,
        dir,
        ReceiveLimits {
            active_bytes: 1024,
            session_offers: 1,
        },
    )
    .unwrap()
}

#[test]
fn invitation_binds_distinct_recipient_device_and_route_key_without_granting_trust() {
    let temp = tempfile::tempdir().unwrap();
    let issuer = node(temp.path());
    let dir = tempfile::tempdir().unwrap();
    let recipient = node(dir.path());
    let code = issuer
        .create_wan_invitation(recipient.device().id, [1; 32], [2; 32])
        .unwrap();
    let verified = recipient
        .inspect_wan_invitation(&code, issuer.device().id, [2; 32])
        .unwrap();
    assert_eq!(verified.issuer(), issuer.device().id);
    assert_eq!(verified.issuer_endpoint_key(), [1; 32]);
    assert_eq!(verified.recipient(), recipient.device().id);
    assert_eq!(verified.recipient_endpoint_key(), [2; 32]);
    assert!(issuer.trusted_devices().is_empty() && recipient.trusted_devices().is_empty());
    assert!(
        recipient
            .inspect_wan_invitation(&code, issuer.device().id, [3; 32])
            .is_err()
    );
    assert!(
        recipient
            .inspect_wan_invitation(&code, recipient.device().id, [2; 32])
            .is_err()
    );
    assert!(
        issuer
            .inspect_wan_invitation(&code, issuer.device().id, [2; 32])
            .is_err()
    );
    assert!(
        issuer
            .create_wan_invitation(recipient.device().id, [1; 32], [1; 32])
            .is_err()
    );
}

#[test]
fn invitation_rejects_expired_or_unsigned_changes_before_route_resolution() {
    let root = tempfile::tempdir().unwrap();
    let peer = tempfile::tempdir().unwrap();
    let issuer = node(root.path());
    let recipient = node(peer.path());
    let code = issuer
        .create_wan_invitation(recipient.device().id, [1; 32], [2; 32])
        .unwrap();
    let verified = recipient
        .inspect_wan_invitation(&code, issuer.device().id, [2; 32])
        .unwrap();
    assert!(
        crate::wan_invitation::inspect_at(
            &code,
            issuer.device().id,
            recipient.device().id,
            [2; 32],
            verified.expires_at()
        )
        .is_err()
    );
    assert!(
        crate::wan_invitation::inspect_at(
            &code,
            issuer.device().id,
            recipient.device().id,
            [2; 32],
            SystemTime::now() - Duration::from_secs(301)
        )
        .is_err()
    );
    let mut altered = code.clone().into_bytes();
    let end = altered.len() - 4;
    altered[end] = if altered[end] == b'A' { b'B' } else { b'A' };
    assert!(
        recipient
            .inspect_wan_invitation(
                &String::from_utf8(altered).unwrap(),
                issuer.device().id,
                [2; 32]
            )
            .is_err()
    );
    assert!(
        recipient
            .inspect_wan_invitation(&"x".repeat(16384), issuer.device().id, [2; 32])
            .is_err()
    );
}

#[derive(Clone)]
struct LocalTestRoute {
    receiver: Arc<RemotePeerNode>,
    sender: PeerId,
}
impl crate::RemoteRoute for LocalTestRoute {
    type Stream = tokio::io::DuplexStream;
    async fn dial(&self) -> Result<Self::Stream, TransferError> {
        let (client, server) = tokio::io::duplex(128 * 1024);
        let receiver = self.receiver.clone();
        let sender = self.sender;
        tokio::spawn(async move {
            let _ = receiver.serve_routed_stream(server, sender).await;
        });
        Ok(client)
    }
}

#[tokio::test]
async fn signed_wan_entry_uses_pinned_tls_and_explicit_consent_for_round_trip_files() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let dir = tempfile::tempdir().unwrap();
        let a_dir = dir.path().join("a");
        let b_dir = dir.path().join("b");
        std::fs::create_dir(&a_dir).unwrap();
        std::fs::create_dir(&b_dir).unwrap();
        let a = Arc::new(node(&a_dir));
        let b = Arc::new(node(&b_dir));
        let a_id = a.device().id;
        let b_id = b.device().id;
        let invite = a.create_wan_invitation(b_id, [1; 32], [2; 32]).unwrap();
        let route = LocalTestRoute {
            receiver: a.clone(),
            sender: b_id,
        };
        let mut pending = a.subscribe_pairing();
        let not_dialed = b
            .redeem_wan_invitation::<LocalTestRoute>(&invite, a_id, [3; 32], |_| {
                panic!("invalid invite must not reach route selection")
            })
            .await;
        assert!(not_dialed.is_err());
        assert!(pending.borrow().is_none());
        let redeem = tokio::spawn({
            let b = b.clone();
            let route = route.clone();
            async move {
                b.redeem_wan_invitation(&invite, a_id, [2; 32], |binding| {
                    assert_eq!(binding.issuer_endpoint_key(), [1; 32]);
                    Ok(route)
                })
                .await
            }
        });
        let request = pending
            .wait_for(Option::is_some)
            .await
            .unwrap()
            .clone()
            .unwrap();
        assert_eq!(request.device.id, b_id);
        assert!(a.trusted_devices().is_empty());
        assert!(!redeem.is_finished());
        a.confirm_pairing(request.id, true).unwrap();
        assert_eq!(redeem.await.unwrap().unwrap().id, a_id);

        for (from, to, destination, name) in
            [(&b, &a, &a_dir, "to-a.bin"), (&a, &b, &b_dir, "to-b.bin")]
        {
            let payload = name.as_bytes();
            let source = dir.path().join("source");
            std::fs::write(&source, payload).unwrap();
            let mut watch = to.subscribe_transfers();
            let sender = from
                .sender_via(
                    LocalTestRoute {
                        receiver: to.clone(),
                        sender: from.device().id,
                    },
                    to.device().id,
                    Duration::from_secs(5),
                    Duration::from_secs(5),
                )
                .unwrap();
            let send = tokio::spawn(async move {
                sender
                    .send_file(
                        &source,
                        name,
                        tokio_util::sync::CancellationToken::new(),
                        |_, _| {},
                    )
                    .await
                    .unwrap()
            });
            let offered = loop {
                if let Some(offer) = to
                    .transfers()
                    .into_iter()
                    .find(|entry| entry.offer.name == name)
                {
                    break offer;
                }
                watch.changed().await.unwrap();
            };
            assert!(!send.is_finished());
            assert!(!destination.join(name).exists());
            to.respond(offered.key, true).unwrap();
            assert_eq!(send.await.unwrap().state, aerift_transfer::State::Completed);
            assert_eq!(std::fs::read(destination.join(name)).unwrap(), payload);
        }
    })
    .await
    .unwrap();
}
