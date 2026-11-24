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
    for name in ["a", "b"] {
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
    for name in ["a", "b"] {
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
