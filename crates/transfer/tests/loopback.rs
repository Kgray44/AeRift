use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};

use aerift_transfer::ambient_inbox::{FrozenDelivery, Inbox};
use aerift_transfer::{
    Connector, ErrorCode, PeerId, ReceiveLimits, Receiver, Sender, State, TransferError,
};
use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair};
use sha2::{Digest, Sha256};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::{
    TlsAcceptor, TlsConnector,
    client::TlsStream,
    rustls::{
        ClientConfig, RootCertStore, ServerConfig,
        pki_types::{CertificateDer, PrivatePkcs8KeyDer, ServerName},
        server::WebPkiClientVerifier,
        version::TLS13,
    },
};
use tokio_util::sync::CancellationToken;

const SOURCE_BYTES: usize = 3 * 1024 * 1024 + 17;

struct Endpoint {
    addr: String,
    tls: TlsConnector,
    peer: PeerId,
}

impl Connector for Endpoint {
    type Stream = TlsStream<TcpStream>;

    async fn connect(&self) -> Result<Self::Stream, TransferError> {
        let socket = TcpStream::connect(&self.addr)
            .await
            .map_err(|_| ErrorCode::PeerUnavailable)?;
        let stream = self
            .tls
            .connect(ServerName::try_from("localhost").unwrap(), socket)
            .await
            .map_err(|_| ErrorCode::PeerUntrusted)?;
        let connection = stream.get_ref().1;
        let actual = connection
            .peer_certificates()
            .and_then(|certs| certs.first());
        if connection.alpn_protocol() != Some(&b"http/1.1"[..])
            || actual.map(|cert| PeerId::from_tls_leaf(cert.as_ref())) != Some(self.peer)
        {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        Ok(stream)
    }

    fn authority(&self) -> &str {
        &self.addr
    }
}

fn provision(root: &Path) {
    let mut ca = CertificateParams::default();
    ca.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca.distinguished_name
        .push(rcgen::DnType::CommonName, "AeRift loopback test CA");
    let ca_key = KeyPair::generate().unwrap();
    let cert = ca.self_signed(&ca_key).unwrap();
    let issuer = Issuer::from_params(&ca, &ca_key);
    fs::write(root.join("ca.der"), cert.der()).unwrap();
    for name in ["a", "b", "c"] {
        let key = KeyPair::generate().unwrap();
        let mut params = CertificateParams::new(vec!["localhost".to_owned()]).unwrap();
        params
            .distinguished_name
            .push(rcgen::DnType::CommonName, name);
        let cert = params.signed_by(&key, &issuer).unwrap();
        fs::write(root.join(format!("{name}.der")), cert.der()).unwrap();
        fs::write(root.join(format!("{name}.key")), key.serialize_der()).unwrap();
        fs::create_dir(root.join(format!("{name}-received"))).unwrap();
        fs::create_dir(root.join(format!("{name}-inbox"))).unwrap();
    }
}

fn tls(root: &Path, name: &str) -> (TlsConnector, TlsAcceptor) {
    let mut roots = RootCertStore::empty();
    roots
        .add(CertificateDer::from(fs::read(root.join("ca.der")).unwrap()))
        .unwrap();
    let leaf = CertificateDer::from(fs::read(root.join(format!("{name}.der"))).unwrap());
    let key = PrivatePkcs8KeyDer::from(fs::read(root.join(format!("{name}.key"))).unwrap());
    let mut client = ClientConfig::builder_with_protocol_versions(&[&TLS13])
        .with_root_certificates(roots.clone())
        .with_client_auth_cert(vec![leaf.clone()], key.clone_key().into())
        .unwrap();
    client.alpn_protocols = vec![b"http/1.1".to_vec()];
    client.resumption = tokio_rustls::rustls::client::Resumption::disabled();
    let mut server = ServerConfig::builder_with_protocol_versions(&[&TLS13])
        .with_client_cert_verifier(
            WebPkiClientVerifier::builder(Arc::new(roots))
                .build()
                .unwrap(),
        )
        .with_single_cert(vec![leaf], key.into())
        .unwrap();
    server.alpn_protocols = vec![b"http/1.1".to_vec()];
    server.send_tls13_tickets = 0;
    (
        TlsConnector::from(Arc::new(client)),
        TlsAcceptor::from(Arc::new(server)),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fixture_process() {
    let Some(root) = std::env::var_os("AERIFT_FIXTURE_ROOT").map(PathBuf::from) else {
        return;
    };
    let name = std::env::var("AERIFT_FIXTURE_NODE").unwrap();
    let other = if name == "a" { "b" } else { "a" };
    let peer = PeerId::from_tls_leaf(&fs::read(root.join(format!("{other}.der"))).unwrap());
    let (tls, acceptor) = tls(&root, &name);
    let receiver = Arc::new(
        Receiver::new(
            &root.join(format!("{name}-received")),
            ReceiveLimits {
                active_bytes: 8 * 1024 * 1024,
                session_offers: 32,
            },
        )
        .unwrap(),
    );
    let listen = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listen.local_addr().unwrap();
    let mut changes = receiver.subscribe();
    let inbound = Arc::clone(&receiver);
    let listener = tokio::spawn(async move {
        loop {
            let (socket, _) = listen.accept().await.unwrap();
            let inbound = Arc::clone(&inbound);
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                if let Ok(stream) = acceptor.accept(socket).await {
                    let connection = stream.get_ref().1;
                    if connection.alpn_protocol() != Some(&b"http/1.1"[..]) {
                        return;
                    }
                    if let Some(leaf) = connection
                        .peer_certificates()
                        .and_then(|certs| certs.first())
                    {
                        let verified = PeerId::from_tls_leaf(leaf.as_ref());
                        let _ = aerift_transfer::serve(stream, verified, inbound, |id| id == peer)
                            .await;
                    }
                }
            });
        }
    });
    // The listener exists before the address is published through an atomic rename.
    let raw = root.join(format!("{name}.addr.tmp"));
    fs::write(&raw, address.to_string()).unwrap();
    fs::rename(raw, root.join(format!("{name}.addr"))).unwrap();

    let approvals = Arc::clone(&receiver);
    let inbox_path = root.join(format!("{name}-inbox"));
    let inbox = Arc::new(Inbox::open(&inbox_path).unwrap());
    let approver = tokio::spawn(async move {
        loop {
            for transfer in approvals.snapshot() {
                if transfer.status.state == State::Pending {
                    if transfer.offer.name == "payload.bin" {
                        approvals
                            .respond_to_inbox(transfer.key, inbox.clone(), FrozenDelivery::Inbox)
                            .unwrap();
                        assert!(inbox.recovery_candidates("").unwrap().entries.is_empty());
                    } else {
                        approvals.respond(transfer.key, true).unwrap();
                    }
                }
            }
            let completed = approvals
                .snapshot()
                .into_iter()
                .filter(|transfer| transfer.status.state == State::Completed)
                .count();
            if completed == 2 {
                return;
            }
            changes.changed().await.unwrap();
        }
    });
    let addr = tokio::time::timeout(Duration::from_secs(15), async {
        let path = root.join(format!("{other}.addr"));
        loop {
            if let Ok(address) = fs::read_to_string(&path) {
                break address;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .unwrap();

    let sender = Sender::new(
        Endpoint { addr, tls, peer },
        Duration::from_secs(5),
        Duration::from_secs(15),
    );
    let observed = Arc::new(Mutex::new(Vec::new()));
    let record = Arc::clone(&observed);
    let done = sender
        .send_file(
            &root.join(format!("{name}.bin")),
            "payload.bin",
            CancellationToken::new(),
            move |_, status| record.lock().unwrap().push(status),
        )
        .await
        .unwrap();
    assert_eq!(done.state, State::Completed);
    assert_eq!(done.bytes_transferred, SOURCE_BYTES as u64);
    let progress = observed.lock().unwrap().clone();
    assert!(
        progress
            .iter()
            .any(|event| event.state == State::Transferring
                && event.bytes_transferred > 0
                && event.bytes_transferred < SOURCE_BYTES as u64)
    );
    assert!(
        progress
            .windows(2)
            .all(|pair| pair[0].bytes_transferred <= pair[1].bytes_transferred)
    );
    assert_eq!(progress.last(), Some(&done));
    assert_eq!(
        sender
            .send_file(
                &root.join("empty.bin"),
                "empty.bin",
                CancellationToken::new(),
                |_, _| {}
            )
            .await
            .unwrap()
            .state,
        State::Completed
    );
    tokio::time::timeout(Duration::from_secs(15), approver)
        .await
        .unwrap()
        .unwrap();
    fs::write(root.join(format!("{name}.done")), []).unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        while !root.join(format!("{other}.done")).exists() {
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .unwrap();
    listener.abort();
    let transfers = receiver.snapshot();
    drop(receiver);
    let reopened = Inbox::open(&inbox_path).unwrap();
    let recovered = reopened.recovery_candidates("PAYload").unwrap();
    assert_eq!(recovered.entries.len(), 1);
    assert_eq!(recovered.entries[0].peer, peer);
    assert!(!recovered.truncated);
    assert!(
        reopened
            .recovery_candidates("nothing")
            .unwrap()
            .entries
            .is_empty()
    );
    for transfer in transfers {
        if transfer.offer.name == "payload.bin" {
            let proof = reopened.verified_receipt(transfer.key).unwrap();
            assert_eq!(proof.peer(), peer);
            assert_eq!(proof.offer(), &transfer.offer);
        }
        assert_eq!(transfer.offer.size_bytes, transfer.status.bytes_transferred);
        assert_eq!(transfer.key.peer, peer);
    }
    println!(
        "{name} sent {} bytes with {} progress events; also sent an empty file",
        done.bytes_transferred,
        progress.len()
    );
}

#[test]
fn two_independent_processes_transfer_binary_in_both_directions() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    provision(root);
    fs::write(root.join("empty.bin"), []).unwrap();
    for name in ["a", "b", "c"] {
        let salt = if name == "a" { 11 } else { 37 };
        let binary: Vec<_> = (0..SOURCE_BYTES)
            .map(|i| ((i * salt + i / 251) % 256) as u8)
            .collect();
        fs::write(root.join(format!("{name}.bin")), binary).unwrap();
    }
    let exe = std::env::current_exe().unwrap();
    let spawn = |name: &str| {
        Command::new(&exe)
            .args(["--exact", "fixture_process", "--nocapture"])
            .env("AERIFT_FIXTURE_ROOT", root)
            .env("AERIFT_FIXTURE_NODE", name)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    };
    let a = spawn("a");
    let b = spawn("b");
    for child in [a, b] {
        let output = child.wait_with_output().unwrap();
        println!("{}", String::from_utf8_lossy(&output.stdout));
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    for (source, destination) in [("a", "b"), ("b", "a")] {
        let expected = fs::read(root.join(format!("{source}.bin"))).unwrap();
        let dir = root.join(format!("{destination}-received"));
        let inbox_dir = root.join(format!("{destination}-inbox"));
        let mut stored = fs::read_dir(inbox_dir).unwrap();
        let actual = fs::read(stored.next().unwrap().unwrap().path().join("payload")).unwrap();
        assert!(stored.next().is_none());
        let digest = Sha256::digest(actual);
        assert_eq!(Sha256::digest(expected), digest);
        assert_eq!(fs::metadata(dir.join("empty.bin")).unwrap().len(), 0);
        assert_eq!(fs::read_dir(dir).unwrap().count(), 1);
        println!("{source} -> {destination}: SHA-256 {digest:x}");
    }
}

#[tokio::test]
async fn nearby_drop_uses_verified_tls_leaf_and_rejects_cross_lane_forgery_replay() {
    use aerift_transfer::ambient::{
        Candidate, CaptureContext, CaptureLimits, freeze,
        nearby_drop::NearbyDrop,
        session::{DropAuthority, Lane},
    };
    use hyper_util::rt::TokioIo;
    use std::{convert::Infallible, time::Instant};
    use uuid::Uuid;

    struct Scope(PeerId);
    impl DropAuthority for Scope {
        fn permits(&self, peer: PeerId, lane: Lane) -> bool {
            peer == self.0 && lane == Lane::Nearby
        }
    }
    let root = tempfile::tempdir().unwrap();
    provision(root.path());
    let source = root.path().join("source.bin");
    fs::write(&source, b"test object").unwrap();
    let capture = freeze(
        CaptureContext {
            explicit_selection: vec![Candidate::path(source)],
            ..Default::default()
        },
        CaptureLimits::default(),
    )
    .unwrap();
    let drop = Arc::new(NearbyDrop::open(capture, Instant::now()).unwrap());
    let id = drop.interaction().unwrap();
    let source_cert = PeerId::from_tls_leaf(&fs::read(root.path().join("a.der")).unwrap());
    let allowed = PeerId::from_tls_leaf(&fs::read(root.path().join("b.der")).unwrap());
    let authority = Scope(allowed);
    let (forger, server_tls) = tls(root.path(), "a");
    let (receiver_tls, _) = tls(root.path(), "b");
    let socket = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = socket.local_addr().unwrap().to_string();
    let server_drop = drop.clone();
    let server = tokio::spawn(async move {
        for lane in [
            Lane::Nearby,
            Lane::Remote,
            Lane::Nearby,
            Lane::Nearby,
            Lane::Nearby,
            Lane::Nearby,
        ] {
            let (socket, _) = socket.accept().await.unwrap();
            let tls = server_tls.accept(socket).await.unwrap();
            let tls_state = tls.get_ref().1;
            assert_eq!(tls_state.alpn_protocol(), Some(&b"http/1.1"[..]));
            let peer = PeerId::from_tls_leaf(tls_state.peer_certificates().unwrap()[0].as_ref());
            hyper::server::conn::http1::Builder::new()
                .serve_connection(
                    TokioIo::new(tls),
                    hyper::service::service_fn(|request| async {
                        Ok::<_, Infallible>(
                            server_drop
                                .handle_authenticated(
                                    request,
                                    peer,
                                    lane,
                                    &CancellationToken::new(),
                                    &authority,
                                )
                                .await,
                        )
                    }),
                )
                .await
                .unwrap();
        }
    });
    let send = |tls| {
        Sender::new(
            Endpoint {
                addr: addr.clone(),
                tls,
                peer: source_cert,
            },
            Duration::from_secs(1),
            Duration::from_secs(1),
        )
    };
    assert_eq!(
        send(forger).record_nearby_drop(id).await.unwrap_err().code,
        ErrorCode::PeerUntrusted
    );
    let client = send(receiver_tls);
    assert_eq!(
        client.record_nearby_drop(id).await.unwrap_err().code,
        ErrorCode::PeerUntrusted
    );
    assert_eq!(
        client
            .record_nearby_drop(Uuid::new_v4())
            .await
            .unwrap_err()
            .code,
        ErrorCode::InvalidRequest
    );
    let challenge = client.nearby_drop_challenge().await.unwrap().unwrap();
    assert_ne!(challenge, id);
    client.record_nearby_drop(challenge).await.unwrap();
    assert_eq!(
        client.record_nearby_drop(challenge).await.unwrap_err().code,
        ErrorCode::InvalidRequest
    );
    server.await.unwrap();
    tokio::time::sleep(Duration::from_millis(510)).await;
    assert!(drop.resolve(Instant::now(), &Scope(allowed)).is_ok());
}

#[tokio::test]
async fn nearby_drop_selection_requires_exactly_one_pinned_source() {
    use aerift_transfer::ambient::{
        Candidate, CaptureContext, CaptureLimits, freeze,
        nearby_drop::{NearbyDrop, claim_only_nearby_pickup},
        session::{DropAuthority, DropError, Lane},
    };
    use hyper_util::rt::TokioIo;
    use std::{convert::Infallible, time::Instant};

    struct Scope(PeerId);
    impl DropAuthority for Scope {
        fn permits(&self, peer: PeerId, lane: Lane) -> bool {
            peer == self.0 && lane == Lane::Nearby
        }
    }

    for ambiguous in [false, true] {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        provision(root);
        let (client, _) = tls(root, "b");
        let left = PeerId::from_tls_leaf(&fs::read(root.join("a.der")).unwrap());
        let right = PeerId::from_tls_leaf(&fs::read(root.join("c.der")).unwrap());
        let recipient = PeerId::from_tls_leaf(&fs::read(root.join("b.der")).unwrap());
        let source = root.join("source.bin");
        fs::write(&source, b"selected").unwrap();
        let service = || {
            Arc::new(
                NearbyDrop::open(
                    freeze(
                        CaptureContext {
                            explicit_selection: vec![Candidate::path(source.clone())],
                            ..Default::default()
                        },
                        CaptureLimits::default(),
                    )
                    .unwrap(),
                    Instant::now(),
                )
                .unwrap(),
            )
        };
        let active = service();
        let alternative = ambiguous.then(service);
        let mut senders = Vec::new();
        let mut servers = Vec::new();
        for (name, identity, service) in [
            ("a", left, Some(active.clone())),
            ("c", right, alternative.clone()),
        ] {
            let (_, tls) = tls(root, name);
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap().to_string();
            let requests = if !ambiguous && name == "a" { 2 } else { 1 };
            servers.push(tokio::spawn(async move {
                let scope = Scope(recipient);
                let trust = CancellationToken::new();
                for _ in 0..requests {
                    let (stream, _) = listener.accept().await.unwrap();
                    let stream = tls.accept(stream).await.unwrap();
                    let session = stream.get_ref().1;
                    assert_eq!(session.alpn_protocol(), Some(&b"http/1.1"[..]));
                    let peer =
                        PeerId::from_tls_leaf(session.peer_certificates().unwrap()[0].as_ref());
                    hyper::server::conn::http1::Builder::new()
                        .serve_connection(
                            TokioIo::new(stream),
                            hyper::service::service_fn(|request| async {
                                Ok::<_, Infallible>(match &service {
                                    Some(active) => {
                                        active
                                            .handle_authenticated(
                                                request,
                                                peer,
                                                Lane::Nearby,
                                                &trust,
                                                &scope,
                                            )
                                            .await
                                    }
                                    None => NearbyDrop::availability(
                                        None,
                                        request,
                                        peer,
                                        Lane::Nearby,
                                        &trust,
                                        &scope,
                                    ),
                                })
                            }),
                        )
                        .await
                        .unwrap();
                }
            }));
            senders.push((
                identity,
                Sender::new(
                    Endpoint {
                        addr,
                        tls: client.clone(),
                        peer: identity,
                    },
                    Duration::from_secs(1),
                    Duration::from_secs(1),
                ),
            ));
        }
        let result = claim_only_nearby_pickup(senders, &CancellationToken::new()).await;
        if ambiguous {
            assert_eq!(result.unwrap_err().code, ErrorCode::Conflict);
            assert_eq!(
                active.resolve(Instant::now(), &Scope(recipient)).err(),
                Some(DropError::NoDrop)
            );
            assert_eq!(
                alternative
                    .unwrap()
                    .resolve(Instant::now(), &Scope(recipient))
                    .err(),
                Some(DropError::NoDrop)
            );
        } else {
            result.unwrap();
            tokio::time::sleep(Duration::from_millis(510)).await;
            assert!(active.resolve(Instant::now(), &Scope(recipient)).is_ok());
        }
        for server in servers {
            tokio::time::timeout(Duration::from_secs(2), server)
                .await
                .unwrap()
                .unwrap();
        }
    }
}
