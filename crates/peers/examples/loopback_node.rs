//! Interactive demo using ephemeral stores and the production peer transport.

#[path = "../tests/support/mod.rs"]
mod support;

use std::{
    io::{self, Write},
    net::SocketAddr,
    path::Path,
    sync::Arc,
    time::Duration,
};

use aerift_peers::{Identity, PeerNode, Platform};
use aerift_transfer::{ReceiveLimits, Receiver, State};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

type BoxError = Box<dyn std::error::Error>;

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<(), BoxError> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [mode, endpoint, path] if mode == "receive" => receive(endpoint.parse()?, Path::new(path)).await,
        [mode, endpoint, path] if mode == "send" => send(endpoint.parse()?, Path::new(path)).await,
        _ => Err("Usage: loopback_node receive LISTEN_ADDR DIRECTORY | loopback_node send PEER_ADDR FILE".into()),
    }
}

fn node(path: &Path, name: &str) -> Result<(Arc<PeerNode>, Arc<Receiver>), BoxError> {
    let store = Arc::new(support::Store::default());
    let receiver = Arc::new(Receiver::new(
        path,
        ReceiveLimits {
            active_bytes: 64 * 1024 * 1024,
            session_offers: 16,
        },
    )?);
    let node = PeerNode::new(
        Identity::load_or_create(store.as_ref())?,
        name.to_owned(),
        if cfg!(windows) {
            Platform::Windows
        } else if cfg!(target_os = "macos") {
            Platform::Macos
        } else {
            Platform::Linux
        },
        store,
        receiver.clone(),
    )?;
    Ok((Arc::new(node), receiver))
}

async fn receive(address: SocketAddr, path: &Path) -> Result<(), BoxError> {
    let (node, receiver) = node(path, "AeRift demo receiver")?;
    let listener = TcpListener::bind(address).await?;
    let stop = CancellationToken::new();
    let server = tokio::spawn({
        let node = node.clone();
        let stop = stop.clone();
        async move { node.serve(listener, stop).await }
    });
    let mut pairs = node.pairing().subscribe();
    let mut offers = receiver.subscribe();
    let invitation = node.pairing().create_invitation()?;
    println!("Enter this code at the sender prompt:\n{}", invitation.code);
    let pending = pairs
        .wait_for(Option::is_some)
        .await?
        .as_ref()
        .expect("pending request")
        .clone();
    let approve = ask(format!(
        "Pair with {} ({})? Type yes: ",
        pending.device.name, pending.device.id
    ))
    .await?;
    node.pairing().confirm(pending.id, approve == "yes")?;
    if approve == "yes" {
        let offer = loop {
            if let Some(offer) = receiver
                .snapshot()
                .into_iter()
                .find(|offer| offer.status.state == State::Pending)
            {
                break offer;
            }
            offers.changed().await?;
        };
        let accept = ask(format!(
            "Accept {} ({} bytes)? Type yes: ",
            offer.offer.name, offer.offer.size_bytes
        ))
        .await?;
        receiver.respond(offer.key, accept == "yes")?;
        loop {
            let status = receiver.status(offer.key)?;
            if status.state.is_terminal() {
                println!(
                    "Receiver result: {:?}, {} bytes",
                    status.state, status.bytes_transferred
                );
                break;
            }
            offers.changed().await?;
        }
    }
    // Let the peer receive its final response before taking the demo listener down.
    tokio::time::sleep(Duration::from_secs(2)).await;
    stop.cancel();
    server.await??;
    Ok(())
}

async fn send(address: SocketAddr, file: &Path) -> Result<(), BoxError> {
    let scratch = tempfile::tempdir()?;
    let (node, _) = node(scratch.path(), "AeRift demo sender")?;
    let code = ask("Enter the receiver's pairing code: ".to_owned()).await?;
    let peer = node.redeem(address, &code).await?;
    let sender = node.sender(
        address,
        peer.id,
        Duration::from_secs(60),
        Duration::from_secs(120),
    )?;
    let name = file
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("A UTF-8 filename is required")?;
    let status = sender
        .send_file(file, name, CancellationToken::new(), |_, status| {
            if status.state != State::Transferring {
                println!(
                    "Sender result: {:?}, {} bytes",
                    status.state, status.bytes_transferred
                );
            }
        })
        .await?;
    if status.state != State::Completed {
        return Err(format!("Transfer ended in {:?}", status.state).into());
    }
    Ok(())
}

async fn ask(prompt: String) -> io::Result<String> {
    tokio::task::spawn_blocking(move || {
        print!("{prompt}");
        io::stdout().flush()?;
        let mut input = String::new();
        io::stdin().read_line(&mut input)?;
        Ok(input.trim().to_owned())
    })
    .await
    .map_err(io::Error::other)?
}
