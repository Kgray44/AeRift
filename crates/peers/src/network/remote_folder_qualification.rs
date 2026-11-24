//! Isolated eligibility proof. No installed listeners or invocation changes.
use super::*;

use aerift_transfer::{
    ReceiveLimits, State,
    ambient::{Candidate, CaptureContext, CaptureLimits, ReceiverCapabilities, freeze},
    folder::{
        admission::{AdmittedFolder, FolderCapability, FolderRepresentation},
        admission_store::{FolderAdmissionStore, ProtectedAdmissionStorage},
        prepare_folder,
    },
    serve_admitted_folder_request,
};
use tokio::sync::{Mutex, watch};
use uuid::Uuid;

const FOLDER_ALPN: &[u8] = b"aerift-remote-folder/1";
const BINDING: &[u8] = b"EXPORTER-AeRift-Remote-Folder-v1";
const TYPED_OFFER: &str = "/remote/folder/v1/offer";
const FOLDER_CAPABILITY: &str = "/remote/folder/v1/capability";

#[derive(Default)]
struct EphemeralProfile(std::sync::Mutex<Option<Vec<u8>>>);
impl ProtectedAdmissionStorage for EphemeralProfile {
    fn load(&self) -> Result<Option<Vec<u8>>, TransferError> {
        Ok(self.0.lock().unwrap().clone())
    }

    fn replace_write_through(&self, bytes: &[u8]) -> Result<(), TransferError> {
        *self.0.lock().unwrap() = Some(bytes.to_vec());
        Ok(())
    }
}

struct TestIdentity;
impl crate::SecretStore for TestIdentity {
    fn load(&self) -> Result<Option<Vec<u8>>, TransferError> {
        Ok(None)
    }
    fn initialize(&self, candidate: &[u8]) -> Result<Vec<u8>, TransferError> {
        Ok(candidate.to_vec())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_pinned_remote_folder_tls_requires_typed_admission_and_explicit_acceptance() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let sender_root = root.join("sender/Forest");
    let receiver_root = root.join("receiver");
    let scratch = root.join("scratch");
    std::fs::create_dir_all(sender_root.join("Empty")).unwrap();
    std::fs::create_dir(&receiver_root).unwrap();
    std::fs::create_dir(&scratch).unwrap();
    let contents = vec![0xC1; 1024 * 1024 + 119];
    std::fs::write(sender_root.join("fixture"), &contents).unwrap();

    let left = Identity::load_or_create(&TestIdentity).unwrap();
    let right = Identity::load_or_create(&TestIdentity).unwrap();
    let recipient = right.id();
    let sender = left.id();
    let address_helper = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = address_helper.local_addr().unwrap();

    let mut tls = right.server_config().unwrap();
    tls.alpn_protocols = vec![FOLDER_ALPN.to_vec()];
    let tls = TlsAcceptor::from(Arc::new(tls));
    let rx = Arc::new(
        Receiver::new_resumable(
            &receiver_root,
            ReceiveLimits {
                active_bytes: 4 * 1024 * 1024,
                session_offers: 4,
            },
        )
        .unwrap(),
    );
    let live = CancellationToken::new();
    let store = Arc::new(FolderAdmissionStore::new(EphemeralProfile::default()));
    let admitted = Arc::new(Mutex::new(None::<Arc<AdmittedFolder>>));
    let capability = Arc::new(FolderCapability {
        representation: FolderRepresentation::FolderManifestV1,
        maximum_envelope_bytes: 4 * 1024 * 1024,
    });
    let stop = CancellationToken::new();
    let (cuts, mut lost_receipt) = watch::channel(0_u8);
    let server = tokio::spawn({
        let (rx, live, stop) = (rx.clone(), live.clone(), stop.clone());
        let store = store.clone();
        let admitted = admitted.clone();
        let capability = capability.clone();
        async move {
            let mut tasks = JoinSet::new();
            loop {
                tokio::select! {
                    _ = stop.cancelled() => break,
                    _ = tasks.join_next(), if !tasks.is_empty() => {},
                    socket = address_helper.accept() => {
                        let (socket, _) = socket.unwrap();
                        let (tls, rx, live, store, admitted, capability, cuts) = (
                            tls.clone(), rx.clone(), live.clone(), store.clone(), admitted.clone(), capability.clone(), cuts.clone()
                        );
                        tasks.spawn(async move {
                            let Ok(stream) = tls.accept(socket).await else { return };
                            let session = stream.get_ref().1;
                            let peer = session.peer_certificates().and_then(|certs| certs.first())
                                .map(|leaf| PeerId::from_tls_leaf(leaf.as_ref()));
                            if session.alpn_protocol() != Some(FOLDER_ALPN) || peer != Some(sender) || live.is_cancelled() {
                                return;
                            }
                            // Use complementary client/server TLS exporters: the
                            // body cannot choose this binding or peer identity.
                            let binding = session.export_keying_material([0; 32], BINDING, None).unwrap();
                            let cut = CancellationToken::new();
                            let service = service_fn(|request: Request<Incoming>| {
                                let (rx, live, store, admitted, capability, cuts, cut) = (
                                    rx.clone(), live.clone(), store.clone(), admitted.clone(), capability.clone(), cuts.clone(), cut.clone()
                                );
                                async move {
                                    let result = match (request.method(), request.uri().path()) {
                                        (&Method::POST, FOLDER_CAPABILITY) => reply(StatusCode::OK, &*capability),
                                        (&Method::POST, TYPED_OFFER) => {
                                            match Limited::new(request.into_body(), 2048).collect().await {
                                                Ok(bytes) => match AdmittedFolder::from_remote_control(
                                                    &bytes.to_bytes(), Some(&capability), sender, recipient, binding,
                                                ) {
                                                    Ok(offer) => {
                                                        store.remember(&offer, &live).unwrap();
                                                        *admitted.lock().await = Some(Arc::new(offer));
                                                        reply(StatusCode::OK, &true)
                                                    }
                                                    Err(failure) => error(failure),
                                                },
                                                Err(_) => error(ErrorCode::InvalidRequest.into()),
                                            }
                                        },
                                        _ => match admitted.lock().await.clone() {
                                            Some(typed) => {
                                                let is_put = request.method() == Method::PUT;
                                                let result = serve_admitted_folder_request(request, sender, rx, live, &typed).await;
                                                if is_put && result.status() == StatusCode::OK && *cuts.borrow() == 0 {
                                                    cuts.send_replace(1);
                                                    cut.cancel();
                                                    std::future::pending::<()>().await;
                                                }
                                                result
                                            },
                                            None => error(ErrorCode::PeerUntrusted.into()),
                                        },
                                    };
                                    Ok::<_, Infallible>(result)
                                }
                            });
                            tokio::select! {
                                _ = cut.cancelled() => {},
                                _ = hyper::server::conn::http1::Builder::new().keep_alive(false)
                                    .serve_connection(TokioIo::new(stream), service) => {},
                            }
                        });
                    }
                }
            }
            tasks.shutdown().await;
        }
    });
    let endpoint = || {
        pinned_endpoint(
            &left,
            &[address],
            recipient,
            Some(live.clone()),
            FOLDER_ALPN,
        )
        .unwrap()
    };
    let ordinary_endpoint =
        pinned_endpoint(&left, &[address], recipient, None, Lane::Remote.alpn()).unwrap();
    assert!(ordinary_endpoint.connect().await.is_err());
    let impersonator = Identity::load_or_create(&TestIdentity).unwrap();
    let impostor =
        pinned_endpoint(&impersonator, &[address], recipient, None, FOLDER_ALPN).unwrap();
    let denied: Result<FolderCapability, _> = pair_call_bytes(
        impostor.connect().await.unwrap(),
        impostor.authority(),
        FOLDER_CAPABILITY,
        Vec::new(),
        Duration::from_secs(5),
    )
    .await;
    assert!(denied.is_err());

    let profile = endpoint();
    let received_capability: FolderCapability = pair_call_bytes(
        profile.connect().await.unwrap(),
        profile.authority(),
        FOLDER_CAPABILITY,
        Vec::new(),
        Duration::from_secs(5),
    )
    .await
    .unwrap();
    assert_eq!(received_capability, *capability);
    let capture = freeze(
        CaptureContext {
            explicit_selection: vec![Candidate::path(sender_root)],
            ..Default::default()
        },
        CaptureLimits::default(),
    )
    .unwrap();
    let folder = prepare_folder(Arc::new(capture), &CancellationToken::new()).unwrap();
    let first = Uuid::new_v4();
    let io = profile.connect().await.unwrap();
    let binding = io
        .get_ref()
        .1
        .export_keying_material([0; 32], BINDING, None)
        .unwrap();
    let offer = folder
        .encode_typed_offer(&received_capability, first, sender, recipient, binding)
        .unwrap();
    let failure: Result<bool, _> = pair_call_bytes(
        profile.connect().await.unwrap(),
        profile.authority(),
        TYPED_OFFER,
        offer.clone(),
        Duration::from_secs(5),
    )
    .await;
    assert_eq!(failure.unwrap_err().code, ErrorCode::PeerUntrusted);
    let acknowledged: bool = pair_call_bytes(
        io,
        profile.authority(),
        TYPED_OFFER,
        offer,
        Duration::from_secs(5),
    )
    .await
    .unwrap();
    assert!(acknowledged);
    assert!(
        rx.snapshot().is_empty(),
        "admission cannot imply incoming consent"
    );

    let id = first;
    let legacy = ReceiverCapabilities::V1;
    let enabled = ReceiverCapabilities {
        object_manifest_v1: true,
    };
    let wrong = Sender::new(endpoint(), Duration::from_secs(5), Duration::from_secs(10));
    assert_eq!(
        folder
            .send_over(
                &wrong,
                Uuid::new_v4(),
                enabled,
                CancellationToken::new(),
                |_, _| {}
            )
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    assert_eq!(
        folder
            .send_over(&wrong, id, legacy, CancellationToken::new(), |_, _| {})
            .await
            .unwrap_err()
            .code,
        ErrorCode::UnsupportedVersion
    );

    let outgoing = Sender::new(endpoint(), Duration::from_secs(8), Duration::from_secs(15));
    let mut updates = rx.subscribe();
    let call = tokio::spawn(async move {
        folder
            .send_over(&outgoing, id, enabled, CancellationToken::new(), |_, _| {})
            .await
            .unwrap()
    });
    timeout(Duration::from_secs(5), async {
        while rx
            .snapshot()
            .first()
            .is_none_or(|offer| offer.status.state != State::Pending)
        {
            updates.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert!(rx.snapshot()[0].saved_path.is_none());
    assert_eq!(rx.snapshot()[0].status.bytes_transferred, 0);
    let key = rx.snapshot()[0].key;
    rx.respond(key, true).unwrap();
    timeout(Duration::from_secs(8), lost_receipt.changed())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(*lost_receipt.borrow(), 1);
    let receipt = call.await.unwrap();
    assert_eq!(receipt.state, State::Completed);
    assert_eq!(receipt, rx.snapshot()[0].status);
    let computed = rx
        .stage_resumable_folder(key, enabled, &scratch, &CancellationToken::new())
        .unwrap();
    assert_eq!(
        std::fs::read(computed.path().join("fixture")).unwrap(),
        contents
    );
    assert!(computed.path().join("Empty").is_dir());
    live.cancel();
    let denied_again = Sender::new(endpoint(), Duration::from_secs(5), Duration::from_secs(5));
    assert_eq!(
        denied_again.resumable_status(id).await.unwrap_err().code,
        ErrorCode::PeerUntrusted
    );
    stop.cancel();
    server.await.unwrap();
}

#[derive(Default)]
struct FixedRemoteDevices(std::sync::Mutex<Vec<crate::Device>>);
impl crate::RemoteTrustStore for FixedRemoteDevices {
    fn load_remote(&self) -> Result<Vec<crate::Device>, TransferError> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn put_remote(&self, device: &crate::Device) -> Result<(), TransferError> {
        let mut list = self.0.lock().unwrap();
        list.retain(|entry| entry.id != device.id);
        list.push(device.clone());
        Ok(())
    }
    fn remove_remote(&self, peer: PeerId) -> Result<(), TransferError> {
        self.0.lock().unwrap().retain(|device| device.id != peer);
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_remote_listener_separates_new_and_old_alpn_and_preserves_files() {
    let temp = tempfile::tempdir().unwrap();
    let t = temp.path();
    for name in [
        "send/Directory/Empty",
        "from",
        "want",
        "folder-envelopes",
        "stage",
    ] {
        std::fs::create_dir_all(t.join(name)).unwrap();
    }
    std::fs::write(t.join("send/Directory/file"), b"folder bytes").unwrap();
    std::fs::write(t.join("send/file"), b"ordinary bytes").unwrap();
    let a = Identity::load_or_create(&TestIdentity).unwrap();
    let b = Identity::load_or_create(&TestIdentity).unwrap();
    let aid = a.id();
    let bid = b.id();
    let limits = ReceiveLimits {
        active_bytes: 4 * 1024 * 1024,
        session_offers: 4,
    };
    let devices = |id| {
        Arc::new(FixedRemoteDevices(std::sync::Mutex::new(vec![
            crate::Device {
                id,
                name: "synthetic friend".into(),
                platform: Platform::Windows,
            },
        ])))
    };
    let left = Arc::new(
        crate::RemotePeerNode::new(
            a,
            "left".into(),
            Platform::Windows,
            devices(bid),
            &t.join("from"),
            limits,
        )
        .unwrap(),
    );
    let right = Arc::new(
        crate::RemotePeerNode::new(
            b,
            "right".into(),
            Platform::Windows,
            devices(aid),
            &t.join("want"),
            limits,
        )
        .unwrap(),
    );
    let folders = Arc::new(
        crate::RemoteFolderIngress::new(
            &t.join("folder-envelopes"),
            limits,
            Arc::new(EphemeralProfile::default()),
        )
        .unwrap(),
    );
    let bad_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let bad = Arc::new(
        crate::RemoteFolderIngress::new(
            &t.join("want"),
            limits,
            Arc::new(EphemeralProfile::default()),
        )
        .unwrap(),
    );
    assert_eq!(
        right
            .serve_with_folders(bad_listener, CancellationToken::new(), bad)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict,
    );
    let old_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let new_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let old_addr = old_listener.local_addr().unwrap();
    let new_addr = new_listener.local_addr().unwrap();
    let old_stop = CancellationToken::new();
    let new_stop = CancellationToken::new();
    let old_host = tokio::spawn({
        let (right, stop) = (right.clone(), old_stop.clone());
        async move {
            right.serve(old_listener, stop).await.unwrap();
        }
    });
    let new_host = tokio::spawn({
        let (right, stop, folders) = (right.clone(), new_stop.clone(), folders.clone());
        async move {
            right
                .serve_with_folders(new_listener, stop, folders)
                .await
                .unwrap();
        }
    });
    let capture = freeze(
        CaptureContext {
            explicit_selection: vec![Candidate::path(t.join("send/Directory"))],
            ..Default::default()
        },
        CaptureLimits::default(),
    )
    .unwrap();
    let prepared = prepare_folder(Arc::new(capture), &CancellationToken::new()).unwrap();
    assert!(
        left.send_folder(
            &[old_addr],
            bid,
            &prepared,
            Uuid::new_v4(),
            CancellationToken::new(),
            |_, _| {}
        )
        .await
        .is_err()
    );
    assert!(right.transfers().is_empty());
    assert!(folders.snapshot().is_empty());
    let id = Uuid::new_v4();
    let key = aerift_transfer::TransferKey { peer: aid, id };
    let outgoing = tokio::spawn({
        let left = left.clone();
        async move {
            left.send_folder(
                &[new_addr],
                bid,
                &prepared,
                id,
                CancellationToken::new(),
                |_, _| {},
            )
            .await
            .unwrap()
        }
    });
    let mut observed_folder = folders.subscribe();
    timeout(Duration::from_secs(5), async {
        loop {
            if folders
                .review(key)
                .is_ok_and(|(_, review)| review.status.state == State::Pending)
            {
                break;
            }
            observed_folder.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    let (typed, received) = folders.review(key).unwrap();
    assert_eq!(typed.root_title(), "Directory");
    assert_eq!(received.status.bytes_transferred, 0);
    assert!(right.transfers().is_empty());

    // Next run an ordinary File on the same explicitly bound socket.
    let source = t.join("send/file");
    let mut observed_file = right.subscribe_transfers();
    let file = tokio::spawn({
        let left = left.clone();
        async move {
            left.sender(
                &[new_addr],
                bid,
                Duration::from_secs(8),
                Duration::from_secs(10),
            )
            .unwrap()
            .send_resumable_file(&source, "file", CancellationToken::new(), |_, _| {})
            .await
            .unwrap()
        }
    });
    let file_key = timeout(Duration::from_secs(5), async {
        loop {
            if let Some(received) = right
                .transfers()
                .iter()
                .find(|item| item.status.state == State::Pending)
            {
                break received.key;
            }
            observed_file.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert!(folders.review(file_key).is_err());
    assert!(right.respond(key, true).is_err());
    right.respond(file_key, true).unwrap();
    assert_eq!(file.await.unwrap().state, State::Completed);
    assert_eq!(
        std::fs::read(t.join("want/file")).unwrap(),
        b"ordinary bytes"
    );
    assert_eq!(folders.review(key).unwrap().1.status.state, State::Pending);
    folders.respond(key, true).unwrap();
    assert_eq!(outgoing.await.unwrap().state, State::Completed);
    assert!(folders.review(key).unwrap().1.saved_path.is_some());
    assert!(
        !t.join("want/Directory").exists(),
        "typed receipt must not auto-publish"
    );
    right.revoke(aid).unwrap();
    assert!(folders.review(key).is_err());
    old_stop.cancel();
    new_stop.cancel();
    old_host.await.unwrap();
    new_host.await.unwrap();
}
