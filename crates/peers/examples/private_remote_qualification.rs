//! Bounded, one-transfer qualification harness. Ephemeral identities, no discovery.
#[path = "../tests/support/mod.rs"]
mod support;

use std::{
    io::{self, Write},
    net::SocketAddr,
    path::Path,
    sync::Arc,
    time::Duration,
};

use aerift_peers::{Device, Identity, Platform, RemotePeerNode, RemoteTrustStore, TrustStore};
use aerift_transfer::{PeerId, ReceiveLimits, State, TransferError};
use tokio::{net::TcpListener, time::timeout};
use tokio_util::sync::CancellationToken;

type Failure = Box<dyn std::error::Error>;
const LIMIT: u64 = 256 * 1024 * 1024;
const APPROVAL: Duration = Duration::from_secs(120);
const UPLOAD: Duration = Duration::from_secs(600);

#[derive(Default)]
struct IsolatedTrust(support::Store);

impl RemoteTrustStore for IsolatedTrust {
    fn load_remote(&self) -> Result<Vec<Device>, TransferError> {
        TrustStore::load(&self.0)
    }
    fn put_remote(&self, device: &Device) -> Result<(), TransferError> {
        self.0.put(device)
    }
    fn remove_remote(&self, peer: PeerId) -> Result<(), TransferError> {
        self.0.remove(peer)
    }
}

fn node(destination: &Path) -> Result<Arc<RemotePeerNode>, Failure> {
    let identity = Identity::load_or_create(&support::Store::default())?;
    let platform = if cfg!(windows) {
        Platform::Windows
    } else if cfg!(target_os = "macos") {
        Platform::Macos
    } else {
        Platform::Linux
    };
    Ok(Arc::new(RemotePeerNode::new(
        identity,
        "AeRift synthetic fixture".into(),
        platform,
        Arc::new(IsolatedTrust::default()),
        destination,
        ReceiveLimits {
            active_bytes: LIMIT,
            session_offers: 4,
        },
    )?))
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<(), Failure> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [mode, address, path] if mode == "receive" => {
            let address = address.parse::<SocketAddr>()?;
            if !RemotePeerNode::supports_private_endpoint(address) {
                return Err("Bind only the explicit IPv4 address of an approved private interface".into());
            }
            receive(address, Path::new(path)).await
        }
        [mode, routes, path] if mode == "send" => {
            let routes: Vec<SocketAddr> = routes.split(',').map(str::parse).collect::<Result<_, _>>()?;
            if routes.is_empty() || routes.len() > 4 || !routes.iter().copied().all(RemotePeerNode::supports_private_endpoint) {
                return Err("Supply 1–4 approved private IPv4 endpoints".into());
            }
            send(&routes, Path::new(path)).await
        }
        _ => Err("Usage: private_remote_qualification receive PRIVATE_ADDR DEST_DIR | send PRIVATE_ADDR[,ALTERNATE] SYNTHETIC_FILE".into()),
    }
}

async fn receive(address: SocketAddr, destination: &Path) -> Result<(), Failure> {
    let node = node(destination)?;
    let expected: PeerId = ask("Sender fingerprint received privately: ".into())
        .await?
        .parse()?;
    let listener = TcpListener::bind(address).await?;
    let mut pairing = node.subscribe_pairing();
    let mut changes = node.subscribe_transfers();
    let stop = CancellationToken::new();
    let _cleanup = stop.clone().drop_guard();
    let served = tokio::spawn({
        let node = node.clone();
        let stop = stop.clone();
        async move { node.serve(listener, stop).await }
    });
    let invitation = node.create_invitation(expected)?;
    println!(
        "Share this five-minute invite privately. Do not copy it into qualification logs.\n{}",
        invitation.code
    );
    let pending = timeout(Duration::from_secs(300), pairing.wait_for(Option::is_some))
        .await??
        .clone()
        .ok_or("Pairing expired")?;
    let approve = ask(format!(
        "Confirm pairing with verified fingerprint {}? Type yes: ",
        pending.device.id
    ))
    .await?
        == "yes";
    node.confirm_pairing(pending.id, approve)?;
    if !approve {
        return Err("Pairing rejected".into());
    }
    let offer = timeout(APPROVAL, async {
        loop {
            if let Some(offer) = node
                .transfers()
                .into_iter()
                .find(|offer| offer.status.state == State::Pending)
            {
                break Ok::<_, TransferError>(offer);
            }
            changes
                .changed()
                .await
                .map_err(|_| aerift_transfer::ErrorCode::InternalError)?;
        }
    })
    .await??;
    let accept = ask(format!(
        "Accept synthetic fixture {} ({} bytes)? Type yes: ",
        offer.offer.name, offer.offer.size_bytes
    ))
    .await?
        == "yes";
    node.respond(offer.key, accept)?;
    let result =
        timeout(UPLOAD, async {
            loop {
                if let Some(transfer) = node.transfers().into_iter().find(|transfer| {
                    transfer.key == offer.key && transfer.status.state.is_terminal()
                }) {
                    break Ok::<_, TransferError>(transfer);
                }
                changes
                    .changed()
                    .await
                    .map_err(|_| aerift_transfer::ErrorCode::InternalError)?;
            }
        })
        .await??;
    if !accept || result.status.state != State::Completed || result.saved_path.is_none() {
        return Err(format!("Receiver ended in {:?}", result.status.state).into());
    }
    println!(
        "Receiver verified/published: {} bytes SHA-256 {}",
        result.status.bytes_transferred, offer.offer.sha256
    );
    // Do not terminate while the sender's completion receipt is still in flight
    // (or while it is retrying the final status after a broken socket).
    let _ = ask("After the sender confirms its receipt, press Enter to stop: ".into()).await?;
    stop.cancel();
    served.await??;
    Ok(())
}

async fn send(routes: &[SocketAddr], source: &Path) -> Result<(), Failure> {
    let data = source.metadata()?;
    if !data.is_file() || data.len() > LIMIT {
        return Err("Use a synthetic regular file no larger than 256 MiB".into());
    }
    let temporary = tempfile::tempdir()?;
    let node = node(temporary.path())?;
    println!(
        "Send this device fingerprint privately to the receiver:\n{}",
        node.device().id
    );
    let code = ask("Paste the invitation received privately: ".into()).await?;
    let peer = RemotePeerNode::invitation_peer(&code)?;
    if ask(format!(
        "You expect the inviter fingerprint {peer}. Type yes to redeem: "
    ))
    .await?
        != "yes"
    {
        return Err("Sender cancelled pairing".into());
    }
    let peer = node.redeem(routes, &code).await?;
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Use a UTF-8 filename")?;
    let status = node
        .sender(routes, peer.id, APPROVAL, UPLOAD)?
        .send_file(source, name, CancellationToken::new(), |_, _| {})
        .await?;
    if status.state != State::Completed {
        return Err(format!("Sender ended in {:?}", status.state).into());
    }
    println!(
        "Sender received completion: {} bytes",
        status.bytes_transferred
    );
    Ok(())
}

async fn ask(prompt: String) -> io::Result<String> {
    tokio::task::spawn_blocking(move || {
        print!("{prompt}");
        io::stdout().flush()?;
        let mut input = String::new();
        if io::stdin().read_line(&mut input)? == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Interactive input ended",
            ));
        }
        Ok(input.trim().to_owned())
    })
    .await
    .map_err(io::Error::other)?
}
