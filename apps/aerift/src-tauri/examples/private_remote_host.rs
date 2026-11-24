//! Explicit headless Windows qualifier. Never linked into installed app startup.
#[cfg(windows)]
#[path = "../src/private_remote_profile.rs"]
mod private_remote_profile;
#[cfg(windows)]
#[path = "../src/protected_store.rs"]
mod protected_store;
#[cfg(windows)]
#[path = "../src/windows_storage.rs"]
mod windows_storage;

#[cfg(windows)]
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    qualification::run().await
}

#[cfg(not(windows))]
fn main() {
    eprintln!("This protected native qualification host runs only on Windows.");
    std::process::exit(1);
}

#[cfg(windows)]
mod qualification {
    use std::{
        io::{self, Write},
        net::SocketAddr,
        path::Path,
        sync::Arc,
        time::Duration,
    };

    use aerift_peers::{Platform, RemotePeerNode, RemoteTrustStore};
    use aerift_transfer::{PeerId, ReceiveLimits, State};
    use tokio::{net::TcpListener, time::timeout};
    use tokio_util::sync::CancellationToken;
    use uuid::Uuid;

    use crate::private_remote_profile::{overlay_endpoint, PrivateRemoteProfile};

    type Failure = Box<dyn std::error::Error>;
    const BYTES: u64 = 256 * 1024 * 1024;
    const WAIT: Duration = Duration::from_secs(300);
    const FILE_WINDOW: Duration = Duration::from_secs(900);

    pub async fn run() -> Result<(), Failure> {
        let args: Vec<_> = std::env::args_os().skip(1).collect();
        match args.as_slice() {
            [mode, profile, receive, bind] if mode == "receive" => {
                let endpoint = overlay_endpoint(bind.to_str().ok_or("Use a numeric private endpoint")?)?;
                let profile = PrivateRemoteProfile::open(Path::new(profile))?;
                receiver(profile, Path::new(receive), endpoint).await
            }
            [mode, profile, file, target] if mode == "send" => {
                let endpoint = overlay_endpoint(target.to_str().ok_or("Use a numeric private endpoint")?)?;
                let profile = PrivateRemoteProfile::open(Path::new(profile))?;
                sender(profile, Path::new(file), endpoint).await
            }
            [mode, profile] if mode == "revoke" => {
                let profile = PrivateRemoteProfile::open(Path::new(profile))?;
                let peer: PeerId = ask("Remote device fingerprint to revoke (Nearby remains unchanged): ".to_owned()).await?.parse()?;
                if ask("Type REVOKE REMOTE to confirm: ".to_owned()).await? != "REVOKE REMOTE" {
                    return Err("Remote revocation cancelled".into());
                }
                profile.trust.remove_remote(peer)?;
                println!("Removed Remote authorization only.");
                Ok(())
            }
            _ => Err("Usage: private_remote_host receive PROFILE RECEIVED_DIR OVERLAY_IPV4:PORT | send PROFILE SYNTHETIC_FILE OVERLAY_IPV4:PORT | revoke PROFILE".into()),
        }
    }

    async fn authorize_operator() -> Result<(), Failure> {
        println!("Use only an already-authorized private overlay; do not enable port forwarding, expose this host publicly, or use personal files.");
        if ask("Type PRIVATE TEST to continue: ".to_owned()).await? != "PRIVATE TEST" {
            return Err("Private qualification cancelled".into());
        }
        Ok(())
    }

    fn node(
        profile: PrivateRemoteProfile,
        destination: &Path,
    ) -> Result<(Arc<RemotePeerNode>, std::fs::File), Failure> {
        let (identity, trust, lock) = profile.into_host_parts()?;
        Ok((
            Arc::new(RemotePeerNode::new(
                identity,
                "AeRift Windows private qualification".into(),
                Platform::Windows,
                Arc::new(trust),
                destination,
                ReceiveLimits {
                    active_bytes: BYTES,
                    session_offers: 8,
                },
            )?),
            lock,
        ))
    }

    async fn receiver(
        profile: PrivateRemoteProfile,
        destination: &Path,
        endpoint: SocketAddr,
    ) -> Result<(), Failure> {
        authorize_operator().await?;
        let (node, _exclusive_profile) = node(profile, destination)?;
        let expected = ask("New pairing: enter the sender fingerprint privately. Existing trusted peer: press Enter. ".to_owned()).await?;
        let expected = if expected.is_empty() {
            None
        } else {
            Some(expected.parse::<PeerId>()?)
        };
        // The concrete existing overlay interface is selected deliberately.
        // Do not scan, advertise, infer a port, or bind a wildcard.
        let listener = TcpListener::bind(endpoint).await?;
        let stop = CancellationToken::new();
        let _cleanup = stop.clone().drop_guard();
        let mut pairing = node.subscribe_pairing();
        let mut transfers = node.subscribe_transfers();
        let server = tokio::spawn({
            let node = node.clone();
            let stop = stop.clone();
            async move { node.serve(listener, stop).await }
        });

        if let Some(peer) = expected {
            let invitation = node.create_invitation(peer)?;
            println!("Privately convey inviter ID {} and the five-minute invitation; do not log or forward it publicly.\n{}", node.device().id, invitation.code);
            let pending = timeout(WAIT, pairing.wait_for(Option::is_some))
                .await??
                .clone()
                .ok_or("Pairing no longer pending")?;
            let accept = ask(format!(
                "Expected authenticated device {}. Type PAIR REMOTE to grant Remote access: ",
                pending.device.id
            ))
            .await?
                == "PAIR REMOTE";
            node.confirm_pairing(pending.id, accept)?;
            if !accept {
                return Err("Remote pairing declined".into());
            }
        }

        let offer = timeout(WAIT, async {
            loop {
                if let Some(active) = node
                    .transfers()
                    .into_iter()
                    .find(|candidate| candidate.status.state == State::Pending)
                {
                    break Ok::<_, tokio::sync::watch::error::RecvError>(active);
                }
                transfers.changed().await?;
            }
        })
        .await??;
        let accept = ask(format!(
            "Accept synthetic file {} ({} bytes) from {}? Type ACCEPT FILE: ",
            offer.offer.name, offer.offer.size_bytes, offer.key.peer
        ))
        .await?
            == "ACCEPT FILE";
        node.respond(offer.key, accept)?;
        if !accept {
            return Err("File declined".into());
        }
        let result = timeout(FILE_WINDOW, async {
            loop {
                if let Some(active) = node.transfers().into_iter().find(|candidate| {
                    candidate.key == offer.key && candidate.status.state.is_terminal()
                }) {
                    break Ok::<_, tokio::sync::watch::error::RecvError>(active);
                }
                transfers.changed().await?;
            }
        })
        .await??;
        if result.status.state != State::Completed || result.saved_path.is_none() {
            return Err("Receiver did not durably publish a verified file".into());
        }
        println!(
            "Receiver verified and published {} bytes; SHA-256 {}",
            result.status.bytes_transferred, offer.offer.sha256
        );
        let _ =
            ask("After the sender confirms its receipt, press Enter to stop: ".to_owned()).await?;
        stop.cancel();
        server.await??;
        Ok(())
    }

    async fn sender(
        profile: PrivateRemoteProfile,
        file: &Path,
        endpoint: SocketAddr,
    ) -> Result<(), Failure> {
        authorize_operator().await?;
        let metadata = std::fs::symlink_metadata(file)?;
        let name = file
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or("Use a safe UTF-8 fixture name")?;
        if !metadata.is_file() || metadata.len() > BYTES {
            return Err("Use a regular synthetic file no larger than 256 MiB".into());
        }
        let scratch = tempfile::tempdir()?;
        let (node, _exclusive_profile) = node(profile, scratch.path())?;
        println!("Convey this device fingerprint to the receiver privately if pairing for the first time: {}", node.device().id);
        let expected: PeerId = ask("Recipient fingerprint confirmed privately: ".to_owned())
            .await?
            .parse()?;
        if !node
            .trusted_devices()
            .iter()
            .any(|device| device.id == expected)
        {
            let code =
                ask("Paste the five-minute Remote invitation privately: ".to_owned()).await?;
            if RemotePeerNode::invitation_peer(&code)? != expected {
                return Err("Invitation fingerprint is not the expected recipient".into());
            }
            if ask("Type PAIR REMOTE to approve pairing: ".to_owned()).await? != "PAIR REMOTE" {
                return Err("Remote pairing cancelled".into());
            }
            node.redeem(&[endpoint], &code).await?;
        }
        if ask(format!("Type SEND FIXTURE to offer {name}: ")).await? != "SEND FIXTURE" {
            return Err("Transfer cancelled".into());
        }
        let id = Uuid::new_v4();
        let receipt = node
            .sender(&[endpoint], expected, WAIT, FILE_WINDOW)?
            .send_resumable_file_with_id(id, file, name, CancellationToken::new(), |_, _| {})
            .await?;
        if receipt.state != State::Completed {
            return Err(format!("Transfer ended {:?}", receipt.state).into());
        }
        println!(
            "Sender received verified completion for {} bytes.",
            receipt.bytes_transferred
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
            if input.len() > 256 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Input is too long",
                ));
            }
            Ok(input.trim().to_owned())
        })
        .await
        .map_err(io::Error::other)?
    }
}
