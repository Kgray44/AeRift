//! Owned CI fixture peer. No arbitrary file inputs or installed command.
#[cfg(windows)]
#[path = "../src/private_remote_profile.rs"]
mod private_remote_profile;
#[cfg(windows)]
#[path = "../src/protected_store.rs"]
mod protected_store;
#[cfg(windows)]
#[path = "../src/windows_storage.rs"]
mod windows_storage;

#[cfg(not(windows))]
fn main() {
    std::process::exit(1);
}

#[cfg(windows)]
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    use aerift_peers::{Platform, RemotePeerNode};
    use aerift_transfer::{
        ambient::{freeze, Candidate, CaptureContext, CaptureLimits},
        folder::prepare_folder,
        ErrorCode, PeerId, ReceiveLimits, State,
    };
    use private_remote_profile::{overlay_endpoint, PrivateRemoteProfile};
    use std::{
        env, fs,
        io::{self, BufRead, Write},
        net::Ipv4Addr,
        path::PathBuf,
        sync::Arc,
        time::Duration,
    };
    use tokio::{net::TcpListener, time::timeout};
    use tokio_util::sync::CancellationToken;
    use uuid::Uuid;

    let fail = || "This fixture requires an explicitly approved disposable Windows CI runner";
    if env::var("GITHUB_ACTIONS").as_deref() != Ok("true")
        || env::var("RUNNER_ENVIRONMENT").as_deref() != Ok("github-hosted")
    {
        return Err(fail().into());
    }
    let mut args = env::args().skip(1);
    let endpoint = overlay_endpoint(&args.next().ok_or_else(fail)?)?;
    if args.next().is_some() || endpoint.ip() != Ipv4Addr::new(100, 127, 255, 250) {
        return Err(fail().into());
    }
    // This proves the fixed test alias is actually local before any connection.
    drop(TcpListener::bind((endpoint.ip(), 0)).await?);
    let mut input = io::stdin().lock().lines();
    let mut line = || {
        input
            .next()
            .transpose()?
            .ok_or_else(|| io::Error::from(io::ErrorKind::UnexpectedEof))
    };
    if line()? != "SYNTHETIC PRIVATE FOLDERS ONLY" {
        return Err(fail().into());
    }
    let ready = |event: &str, value: &str| -> io::Result<()> {
        let mut out = io::stdout().lock();
        writeln!(
            out,
            "{}",
            serde_json::json!({ "event": event, "value": value })
        )?;
        out.flush()
    };
    let peer_root =
        tempfile::tempdir_in(PathBuf::from(env::var_os("RUNNER_TEMP").ok_or_else(fail)?))?;
    let profile = peer_root.path().join("Profile");
    let receive = peer_root.path().join("Receive");
    let source = peer_root.path().join("Synthetic Folder");
    for path in [&profile, &receive, &source, &source.join("empty")] {
        fs::create_dir(path)?;
    }
    fs::write(
        source.join("fixture.txt"),
        b"AeRift installed Windows folder fixture.\n",
    )?;
    let file = peer_root.path().join("legacy-fixture.txt");
    fs::write(&file, b"AeRift installed Windows legacy file.\n")?;
    let (identity, trust, _lease) = PrivateRemoteProfile::open(&profile)?.into_host_parts()?;
    let node = RemotePeerNode::new(
        identity,
        "AeRift owned CI folder peer".into(),
        Platform::Windows,
        Arc::new(trust),
        &receive,
        ReceiveLimits {
            active_bytes: 1024 * 1024,
            session_offers: 8,
        },
    )?;

    // Seed a new protected preference, not any trusted peer or acceptance.
    // This avoids starting Nearby discovery on the ordinary runner adapter.
    // Refuse to touch any existing app profile, even on the CI account.
    let app_profile =
        PathBuf::from(env::var_os("LOCALAPPDATA").ok_or_else(fail)?).join("com.kgamazing44.aerift");
    fs::create_dir(&app_profile)?;
    protected_store::ProtectedFile::new(&app_profile, "windows-private-remote-mode-v1.dpapi")
        .replace_write_through(&serde_json::to_vec(
            &serde_json::json!({ "version": 1, "endpoint": endpoint.to_string() }),
        )?)?;
    ready("fingerprint", &node.device().id.to_string())?;
    let expected: PeerId = line()?.parse()?;
    let invitation = line()?;
    if RemotePeerNode::invitation_peer(&invitation)? != expected
        || line()? != "PAIR PRIVATE FIXTURE"
    {
        return Err("Fixture pairing was not explicitly approved".into());
    }
    timeout(
        Duration::from_secs(30),
        node.redeem(&[endpoint], &invitation),
    )
    .await??;
    ready("paired", "")?;

    let cancel = CancellationToken::new();
    let prepared = prepare_folder(
        Arc::new(
            freeze(
                CaptureContext {
                    explicit_selection: vec![Candidate::path(source)],
                    ..Default::default()
                },
                CaptureLimits::default(),
            )
            .map_err(|_| "Synthetic freeze failed")?,
        ),
        &cancel,
    )?;
    loop {
        let command = line()?;
        match command.as_str() {
            "OFFER LEGACY FIXTURE" => {
                let sender = node.sender(
                    &[endpoint],
                    expected,
                    Duration::from_secs(20),
                    Duration::from_secs(30),
                )?;
                let receipt = timeout(
                    Duration::from_secs(40),
                    sender.send_resumable_file_with_id(
                        Uuid::new_v4(),
                        &file,
                        "legacy-fixture.txt",
                        cancel.child_token(),
                        |_, _| {},
                    ),
                )
                .await??;
                if receipt.state != State::Completed {
                    return Err("Legacy file was not completed".into());
                }
                ready("legacy_verified", "")?;
            }
            "OFFER FOLDER FIXTURE" | "OFFER DECLINE FIXTURE" | "CHECK REVOKED FIXTURE" => {
                let attempt = timeout(
                    Duration::from_secs(45),
                    node.send_folder(
                        &[endpoint],
                        expected,
                        &prepared,
                        Uuid::new_v4(),
                        cancel.child_token(),
                        |_, _| {},
                    ),
                )
                .await?;
                let event = match (command.as_str(), attempt) {
                    ("OFFER FOLDER FIXTURE", Ok(receipt)) if receipt.state == State::Completed => {
                        "folder_verified"
                    }
                    ("OFFER DECLINE FIXTURE", Ok(receipt)) if receipt.state == State::Rejected => {
                        "folder_declined"
                    }
                    ("OFFER DECLINE FIXTURE", Err(error))
                        if error.code == ErrorCode::TransferRejected =>
                    {
                        "folder_declined"
                    }
                    ("CHECK REVOKED FIXTURE", Err(error))
                        if matches!(
                            error.code,
                            ErrorCode::PeerUntrusted | ErrorCode::NetworkError
                        ) =>
                    {
                        "not_admitted"
                    }
                    _ => return Err("Unexpected private folder outcome".into()),
                };
                ready(event, "")?;
            }
            "STOP FIXTURE" => return Ok(()),
            _ => return Err("Unknown fixture command".into()),
        }
    }
}
