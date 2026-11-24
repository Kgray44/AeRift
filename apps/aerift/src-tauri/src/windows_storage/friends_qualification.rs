//! Actual native Windows profile/transport test. All addresses and profiles are
//! fresh local fixtures. No application commands, native UI or real-user store.

use std::{
    fs,
    net::SocketAddr,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use aerift_peers::{
    FriendBook, FriendInviteEndpoint, FriendOfferEndpoint, FriendPayloadEndpoint, Identity,
};
use aerift_transfer::{inspect_file_offer, ErrorCode, ReceiveLimits, Receiver, State};
use tokio::{net::TcpListener, task::JoinHandle};
use tokio_util::sync::CancellationToken;

use super::{open_friends, WindowsIdentity, WindowsTrust};
use aerift_peers::TrustStore;

type TestJob = JoinHandle<Result<(), aerift_transfer::TransferError>>;

async fn local_listener() -> (TcpListener, [SocketAddr; 1]) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    (listener, [address])
}

async fn offer_server(
    identity: &Arc<Identity>,
    book: &Arc<FriendBook>,
    shutdown: &CancellationToken,
) -> ([SocketAddr; 1], TestJob) {
    let (listener, routes) = local_listener().await;
    let (identity, book, shutdown) = (identity.clone(), book.clone(), shutdown.clone());
    (
        routes,
        tokio::spawn(async move {
            FriendOfferEndpoint::serve(&identity, listener, book, shutdown).await
        }),
    )
}

async fn join(job: TestJob) {
    tokio::time::timeout(Duration::from_secs(4), job)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn friends_native_profiles_qualify_private_invitation_offer_and_verified_payload() {
    let a_dir = tempfile::tempdir().unwrap();
    let b_dir = tempfile::tempdir().unwrap();
    let stranger_dir = tempfile::tempdir().unwrap();
    let (a_authority, a_book) = open_friends(a_dir.path()).unwrap();
    let (b_authority, b_book) = open_friends(b_dir.path()).unwrap();
    let a = Arc::new(Identity::load_or_create(&WindowsIdentity::new(a_dir.path())).unwrap());
    let b = Arc::new(Identity::load_or_create(&WindowsIdentity::new(b_dir.path())).unwrap());
    let stranger = Identity::load_or_create(&WindowsIdentity::new(stranger_dir.path())).unwrap();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let a_stop = CancellationToken::new();
    let b_stop = CancellationToken::new();
    let (invite_listener, invite_routes) = local_listener().await;
    let a_invites = {
        let (a, a_book, stop) = (a.clone(), a_book.clone(), a_stop.clone());
        tokio::spawn(
            async move { FriendInviteEndpoint::serve(&a, invite_listener, a_book, stop).await },
        )
    };
    let invitation = FriendInviteEndpoint::issue(
        &a_authority,
        &a,
        &a_book,
        &b_authority.contact_card(b.id(), now).unwrap(),
        now,
    )
    .unwrap();
    assert!(FriendInviteEndpoint::consent(
        &b_authority,
        &stranger,
        &b_book,
        &invite_routes,
        &invitation,
        now
    )
    .await
    .is_err());
    FriendInviteEndpoint::consent(&b_authority, &b, &b_book, &invite_routes, &invitation, now)
        .await
        .unwrap();
    assert!(!a_book.may_receive_from(b_authority.id(), b.id()).unwrap());
    FriendInviteEndpoint::approve(&a_authority, &a, &a_book, invitation.id(), now).unwrap();
    assert!(FriendInviteEndpoint::finish(
        &b_authority,
        &b,
        &b_book,
        &invite_routes,
        &invitation,
        now
    )
    .await
    .unwrap());
    assert!(WindowsTrust::new(a_dir.path()).load().unwrap().is_empty());
    assert!(WindowsTrust::new(b_dir.path()).load().unwrap().is_empty());

    let (a_controls, a_offers) = offer_server(&a, &a_book, &a_stop).await;
    let (b_controls, b_offers) = offer_server(&b, &b_book, &b_stop).await;
    let (payload_listener, payload_routes) = local_listener().await;
    let receive_dir = tempfile::tempdir().unwrap();
    let receiver = Arc::new(
        Receiver::new(
            receive_dir.path(),
            ReceiveLimits {
                session_offers: 8,
                active_bytes: 1024 * 1024,
            },
        )
        .unwrap(),
    );
    let b_payloads = {
        let (b, b_book, receiver, stop) =
            (b.clone(), b_book.clone(), receiver.clone(), b_stop.clone());
        tokio::spawn(async move {
            FriendPayloadEndpoint::serve(&b, payload_listener, b_book, receiver, stop).await
        })
    };
    let source_dir = tempfile::tempdir().unwrap();
    let source = source_dir.path().join("picked.bin");
    let bytes = (0..131_100).map(|i| (i % 251) as u8).collect::<Vec<_>>();
    fs::write(&source, &bytes).unwrap();
    let offer = FriendPayloadEndpoint::stage_file(
        &a_book,
        b_authority.id(),
        None,
        &source,
        "private-fixture.bin",
        now + 300,
    )
    .await
    .unwrap();
    assert!(FriendPayloadEndpoint::send_file(
        &a,
        a_book.clone(),
        &payload_routes,
        &offer,
        &source,
        CancellationToken::new(),
        |_, _| {},
    )
    .await
    .is_err());
    FriendOfferEndpoint::deliver(&a, &a_book, offer.id, b.id(), &b_controls, now)
        .await
        .unwrap();
    assert!(receiver.snapshot().is_empty());
    FriendOfferEndpoint::accept_received(&b, &b_book, &a_controls, a.id(), offer.id, now)
        .await
        .unwrap();
    let status = FriendPayloadEndpoint::send_file(
        &a,
        a_book.clone(),
        &payload_routes,
        &offer,
        &source,
        CancellationToken::new(),
        |_, _| {},
    )
    .await
    .unwrap();
    assert_eq!(status.state, State::Completed);
    assert_eq!(status.bytes_transferred, bytes.len() as u64);
    let receipt = receiver.snapshot().pop().unwrap();
    assert_eq!(receipt.key.peer, a.id());
    assert_eq!(receipt.key.id, offer.id);
    assert_eq!(receipt.status, status);
    let saved = receipt.saved_path.unwrap();
    assert_eq!(fs::read(&saved).unwrap(), bytes);
    assert_eq!(
        inspect_file_offer(offer.id, &saved, &offer.name)
            .await
            .unwrap()
            .sha256,
        offer.sha256
    );

    a_stop.cancel();
    join(a_offers).await;
    join(a_invites).await;
    drop(a_book);
    let (reopened_authority, reopened_book) = open_friends(a_dir.path()).unwrap();
    assert_eq!(reopened_authority.id(), a_authority.id());
    let reopened_device = Identity::load_or_create(&WindowsIdentity::new(a_dir.path())).unwrap();
    assert_eq!(reopened_device.id(), a.id());
    let error = FriendPayloadEndpoint::send_file(
        &reopened_device,
        reopened_book,
        &payload_routes,
        &offer,
        &source,
        CancellationToken::new(),
        |_, _| {},
    )
    .await
    .unwrap_err();
    assert_eq!(
        error.code,
        ErrorCode::Conflict,
        "live recipient cannot receive a second copy after sender profile reopen"
    );
    assert_eq!(receiver.snapshot().len(), 1);

    b_stop.cancel();
    join(b_payloads).await;
    join(b_offers).await;
}
