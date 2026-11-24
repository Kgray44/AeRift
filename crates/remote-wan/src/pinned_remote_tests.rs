use super::*;
use aerift_peers::{
    Device, Identity, Platform, RemotePeerNode, RemoteRoute, RemoteTrustStore, SecretStore,
};
use aerift_transfer::{ErrorCode, PeerId, ReceiveLimits, State, TransferError};
use std::{
    collections::HashMap,
    fs,
    path::Path,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct EphemeralStore {
    identity: Mutex<Option<Vec<u8>>>,
    grants: Mutex<HashMap<PeerId, Device>>,
}

impl SecretStore for EphemeralStore {
    fn load(&self) -> Result<Option<Vec<u8>>, TransferError> {
        Ok(self.identity.lock().unwrap().clone())
    }

    fn initialize(&self, candidate: &[u8]) -> Result<Vec<u8>, TransferError> {
        Ok(self
            .identity
            .lock()
            .unwrap()
            .get_or_insert_with(|| candidate.to_vec())
            .clone())
    }
}

impl RemoteTrustStore for EphemeralStore {
    fn load_remote(&self) -> Result<Vec<Device>, TransferError> {
        Ok(self.grants.lock().unwrap().values().cloned().collect())
    }

    fn put_remote(&self, device: &Device) -> Result<(), TransferError> {
        self.grants
            .lock()
            .unwrap()
            .insert(device.id, device.clone());
        Ok(())
    }

    fn remove_remote(&self, peer: PeerId) -> Result<(), TransferError> {
        self.grants.lock().unwrap().remove(&peer);
        Ok(())
    }
}

fn node(name: &str, dir: &Path) -> Arc<RemotePeerNode> {
    fs::create_dir(dir).unwrap();
    let store = Arc::new(EphemeralStore::default());
    Arc::new(
        RemotePeerNode::new(
            Identity::load_or_create(store.as_ref()).unwrap(),
            name.into(),
            Platform::Linux,
            store,
            dir,
            ReceiveLimits {
                active_bytes: 8 * 1024 * 1024,
                session_offers: 8,
            },
        )
        .unwrap(),
    )
}

#[derive(Clone)]
struct RelayDial {
    endpoint: Arc<WanEndpoint>,
    route: Arc<WanRoute>,
}

impl RemoteRoute for RelayDial {
    type Stream = WanStream;

    async fn dial(&self) -> Result<WanStream, TransferError> {
        let stream = self
            .endpoint
            .open(&self.route)
            .await
            .map_err(|_| ErrorCode::PeerUnavailable)?;
        assert_eq!(stream.selected_path(), Some(PathKind::Relay));
        Ok(stream)
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn forced_private_relay_reuses_remote_pairing_offer_and_verified_digest() {
    tokio::time::timeout(Duration::from_secs(35), exercise_pinned_transfer())
        .await
        .unwrap();
}

async fn exercise_pinned_transfer() {
    let (relay, url, receiver_wan, sender_wan) = tests::private_relay_fixture().await;
    let receiver_wan = Arc::new(receiver_wan);
    let sender_wan = Arc::new(sender_wan);
    let temporary = tempfile::tempdir().unwrap();
    let destination = temporary.path().join("received");
    let sender = node("Fixture sender", &temporary.path().join("sent"));
    let receiver = node("Fixture recipient", &destination);
    let impostor = node("Unbound certificate", &temporary.path().join("impostor"));
    let sender_id = sender.device().id;
    let receiver_id = receiver.device().id;
    let outer_sender = sender_wan.id();
    let dial = RelayDial {
        route: Arc::new(WanRoute::new(receiver_wan.id(), &[], Some(url)).unwrap()),
        endpoint: sender_wan.clone(),
    };

    assert_eq!(
        sender
            .sender_via(
                dial.clone(),
                receiver_id,
                Duration::from_secs(5),
                Duration::from_secs(5)
            )
            .err()
            .unwrap()
            .code,
        ErrorCode::PeerUntrusted
    );

    let stop = CancellationToken::new();
    let _guard = stop.clone().drop_guard();
    let host = tokio::spawn({
        let stop = stop.clone();
        let receiver_wan = receiver_wan.clone();
        let receiver = receiver.clone();
        async move {
            let allow = HashSet::from([outer_sender]);
            let mut tasks = tokio::task::JoinSet::new();
            loop {
                // Reap completed handlers before entering accept. The accept
                // future can already own the next QUIC connection while it
                // awaits the bidirectional stream, so a cleanup branch must
                // never cancel it. Only explicit fixture shutdown may do so.
                while tasks.try_join_next().is_some() {}
                tokio::select! {
                    biased;
                    _ = stop.cancelled() => break,
                    result = receiver_wan.accept(&allow) => {
                        let (endpoint, stream) = result.unwrap();
                        assert_eq!(endpoint, outer_sender);
                        assert_eq!(stream.selected_path(), Some(PathKind::Relay));
                        let receiver = receiver.clone();
                        tasks.spawn(async move { receiver.serve_routed_stream(stream, sender_id).await });
                    }
                }
            }
            tasks.shutdown().await;
        }
    });

    // A correct outer route still cannot stand in for a different pinned issuer.
    let wrong_target = impostor.create_invitation(sender_id).unwrap();
    assert_eq!(
        sender
            .redeem_via(dial.clone(), &wrong_target.code)
            .await
            .unwrap_err()
            .code,
        ErrorCode::PeerUntrusted
    );
    assert!(sender.trusted_devices().is_empty());
    assert!(receiver.subscribe_pairing().borrow().is_none());

    let invitation = receiver.create_invitation(sender_id).unwrap();
    let mut pairing = receiver.subscribe_pairing();
    // A different inner certificate on an allowed outer route cannot redeem even the correct invite.
    assert!(
        impostor
            .redeem_via(dial.clone(), &invitation.code)
            .await
            .is_err()
    );
    assert!(pairing.borrow().is_none());
    assert!(impostor.trusted_devices().is_empty());

    let redeem = tokio::spawn({
        let sender = sender.clone();
        let dial = dial.clone();
        async move { sender.redeem_via(dial, &invitation.code).await.unwrap() }
    });
    let request = pairing
        .wait_for(Option::is_some)
        .await
        .unwrap()
        .as_ref()
        .unwrap()
        .clone();
    assert_eq!(request.device.id, sender_id);
    assert!(receiver.trusted_devices().is_empty());
    assert!(!redeem.is_finished());
    receiver.confirm_pairing(request.id, true).unwrap();
    assert_eq!(redeem.await.unwrap().id, receiver_id);

    let payload: Vec<u8> = (0..1_570_013).map(|index| (index % 251) as u8).collect();
    let source = temporary.path().join("source.bin");
    fs::write(&source, &payload).unwrap();
    let mut offers = receiver.subscribe_transfers();
    let offer_sender = sender
        .sender_via(
            dial.clone(),
            receiver_id,
            Duration::from_secs(5),
            Duration::from_secs(15),
        )
        .unwrap();
    let transfer = tokio::spawn({
        let source = source.clone();
        async move {
            offer_sender
                .send_file(&source, "verified.bin", CancellationToken::new(), |_, _| {})
                .await
                .unwrap()
        }
    });
    let offer = loop {
        if let Some(offer) = receiver
            .transfers()
            .into_iter()
            .find(|offer| offer.status.state == State::Pending)
        {
            break offer;
        }
        offers.changed().await.unwrap();
    };
    assert_eq!(offer.key.peer, sender_id);
    assert!(!destination.join("verified.bin").exists());
    assert!(!transfer.is_finished());
    receiver.respond(offer.key, true).unwrap();
    let receipt = transfer.await.unwrap();
    assert_eq!(receipt.state, State::Completed);
    assert_eq!(receipt.bytes_transferred, payload.len() as u64);
    let received = fs::read(destination.join("verified.bin")).unwrap();
    assert_eq!(received.len(), payload.len());
    assert_eq!(
        ring::digest::digest(&ring::digest::SHA256, &received).as_ref(),
        ring::digest::digest(&ring::digest::SHA256, &payload).as_ref()
    );

    receiver.revoke(sender_id).unwrap();
    let sender = sender
        .sender_via(
            dial,
            receiver_id,
            Duration::from_secs(5),
            Duration::from_secs(5),
        )
        .unwrap();
    assert_eq!(
        sender
            .send_file(&source, "revoked.bin", CancellationToken::new(), |_, _| {})
            .await
            .unwrap_err()
            .code,
        ErrorCode::PeerUntrusted
    );
    assert!(!destination.join("revoked.bin").exists());
    stop.cancel();
    host.await.unwrap();
    tokio::join!(sender_wan.close(), receiver_wan.close());
    relay.shutdown().await.unwrap();
}
