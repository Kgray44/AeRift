use aerift_peers::{FriendAuthority, FriendBook, FriendRecord, FriendStore, SecretStore};
use aerift_transfer::{ErrorCode, PeerId, TransferError};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[derive(Default)]
struct Memory(Mutex<Option<Vec<u8>>>);
impl SecretStore for Memory {
    fn load(&self) -> Result<Option<Vec<u8>>, TransferError> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn initialize(&self, candidate: &[u8]) -> Result<Vec<u8>, TransferError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .get_or_insert(candidate.to_vec())
            .clone())
    }
}
impl FriendStore for Memory {
    fn load(&self) -> Result<Option<Vec<u8>>, TransferError> {
        SecretStore::load(self)
    }
    fn replace(&self, expected: Option<&[u8]>, data: &[u8]) -> Result<(), TransferError> {
        let mut s = self.0.lock().unwrap();
        if s.as_deref() != expected {
            return Err(ErrorCode::Conflict.into());
        }
        *s = Some(data.to_vec());
        Ok(())
    }
}

#[test]
fn two_approvals_and_exact_devices_bind_invitation_to_person() {
    let store = Memory::default();
    let alice = FriendAuthority::load_or_create(&store).unwrap();
    assert_eq!(
        FriendAuthority::load_or_create(&store).unwrap().id(),
        alice.id()
    );
    let bob = FriendAuthority::load_or_create(&Memory::default()).unwrap();
    let alice_phone = PeerId::from_tls_leaf(b"synthetic-alice");
    let bob_phone = PeerId::from_tls_leaf(b"synthetic-bob");
    let bob_desktop = PeerId::from_tls_leaf(b"synthetic-bob-desktop");
    let invitation = alice.invite(alice_phone, bob.id(), bob_phone, 100).unwrap();
    assert!(
        bob.accept(&invitation, alice_phone, bob_desktop, 101)
            .is_err()
    );
    assert!(
        bob.accept(&invitation, alice_phone, bob_phone, 700)
            .is_err()
    );
    let accepted = bob
        .accept(&invitation, alice_phone, bob_phone, 101)
        .unwrap();
    assert!(
        alice
            .confirm(&invitation, &accepted, bob_desktop, 101)
            .is_err()
    );
    let approval = alice
        .confirm(&invitation, &accepted, bob_phone, 101)
        .unwrap();
    assert!(
        FriendRecord::verify(
            &invitation,
            &accepted,
            &approval,
            alice.id(),
            bob_desktop,
            bob_phone,
            101
        )
        .is_err()
    );
    let local = FriendRecord::verify(
        &invitation,
        &accepted,
        &approval,
        alice.id(),
        alice_phone,
        bob_phone,
        101,
    )
    .unwrap();
    let remote = FriendRecord::verify(
        &invitation,
        &accepted,
        &approval,
        bob.id(),
        bob_phone,
        alice_phone,
        101,
    )
    .unwrap();
    assert_eq!(local.person(), bob.id());
    assert_eq!(remote.person(), alice.id());
}

#[test]
fn sender_awards_one_device_and_persists_withdrawal_across_reopening() {
    let alice = FriendAuthority::load_or_create(&Memory::default()).unwrap();
    let bob = FriendAuthority::load_or_create(&Memory::default()).unwrap();
    let alice_phone = PeerId::from_tls_leaf(b"synthetic-alice");
    let phone = PeerId::from_tls_leaf(b"synthetic-phone");
    let laptop = PeerId::from_tls_leaf(b"synthetic-laptop");
    let invite = alice.invite(alice_phone, bob.id(), phone, 100).unwrap();
    let consent = bob.accept(&invite, alice_phone, phone, 101).unwrap();
    let confirm = alice.confirm(&invite, &consent, phone, 102).unwrap();
    let verified = FriendRecord::verify(
        &invite,
        &consent,
        &confirm,
        alice.id(),
        alice_phone,
        phone,
        102,
    )
    .unwrap();
    let store = Arc::new(Memory::default());
    let book = FriendBook::open(alice.id(), store.clone()).unwrap();
    let wrong_book = FriendBook::open(bob.id(), Arc::new(Memory::default())).unwrap();
    assert!(wrong_book.add(verified.clone(), 102).is_err());
    let relationship = verified.relationship();
    assert!(book.add(verified.clone(), 400).is_err());
    book.add(verified, 102).unwrap();
    assert!(FriendBook::open(bob.id(), store.clone()).is_err());
    book.enroll(bob.enroll(relationship, laptop, 103).unwrap(), laptop, 104)
        .unwrap();
    let intent = Uuid::new_v4();
    book.offer(intent, bob.id(), None, [42; 32]).unwrap();
    let t = std::thread::scope(|s| {
        let a = s.spawn(|| book.claim(intent, phone, [42; 32]));
        let b = s.spawn(|| book.claim(intent, laptop, [42; 32]));
        assert_ne!(a.join().unwrap().is_ok(), b.join().unwrap().is_ok());
        book.winner(intent).unwrap().unwrap()
    });
    let loser = if t == phone { laptop } else { phone };
    let book = FriendBook::open(alice.id(), store).unwrap();
    assert_eq!(book.winner(intent).unwrap(), Some(t));
    assert_eq!(
        book.claim(intent, t, [42; 32]).unwrap(),
        aerift_peers::FriendClaim::AlreadyAwarded
    );
    assert!(book.claim(intent, loser, [42; 32]).is_err());
    assert!(book.claim(intent, t, [41; 32]).is_err());
    assert!(book.authorize_payload(intent, t, [42; 32]).is_ok());
    std::thread::scope(|s| {
        let a = s.spawn(|| book.begin_payload(intent, t, [42; 32]));
        let b = s.spawn(|| book.begin_payload(intent, t, [42; 32]));
        assert_ne!(a.join().unwrap().is_ok(), b.join().unwrap().is_ok());
    });
    book.revoke_device(bob.id(), t).unwrap();
    assert!(book.authorize_payload(intent, t, [42; 32]).is_err());
    assert!(book.claim(intent, loser, [42; 32]).is_err());
    assert!(
        book.enroll(bob.enroll(relationship, t, 105).unwrap(), t, 106)
            .is_err()
    );
}

#[test]
fn altered_invite_and_cross_invite_consent_never_authorize() {
    use aerift_peers::FriendInvitation;
    let alice = FriendAuthority::load_or_create(&Memory::default()).unwrap();
    let bob = FriendAuthority::load_or_create(&Memory::default()).unwrap();
    let a = PeerId::from_tls_leaf(b"a");
    let b = PeerId::from_tls_leaf(b"b");
    let invite = alice.invite(a, bob.id(), b, 100).unwrap();
    let signed = bob.accept(&invite, a, b, 101).unwrap();
    let other = alice.invite(a, bob.id(), b, 100).unwrap();
    assert!(alice.confirm(&other, &signed, b, 101).is_err());
    let mut value = serde_json::to_value(&invite).unwrap();
    value["issued"] = 99.into();
    value["expires"] = 399.into();
    let altered: FriendInvitation = serde_json::from_value(value).unwrap();
    assert!(bob.accept(&altered, a, b, 101).is_err());
}

#[test]
fn denied_friend_or_other_device_cannot_receive_or_claim_specific_offer() {
    let a = FriendAuthority::load_or_create(&Memory::default()).unwrap();
    let b = FriendAuthority::load_or_create(&Memory::default()).unwrap();
    let a_phone = PeerId::from_tls_leaf(b"a-phone");
    let b_phone = PeerId::from_tls_leaf(b"b-phone");
    let b_laptop = PeerId::from_tls_leaf(b"b-laptop");
    let untrusted = PeerId::from_tls_leaf(b"nearby-but-not-friend");
    let invite = a.invite(a_phone, b.id(), b_phone, 10).unwrap();
    let accepted = b.accept(&invite, a_phone, b_phone, 11).unwrap();
    let confirmed = a.confirm(&invite, &accepted, b_phone, 12).unwrap();
    let book = FriendBook::open(a.id(), Arc::new(Memory::default())).unwrap();
    let friend =
        FriendRecord::verify(&invite, &accepted, &confirmed, a.id(), a_phone, b_phone, 13).unwrap();
    let relationship = friend.relationship();
    book.add(friend.clone(), 13).unwrap();
    assert!(!book.may_receive_from(b.id(), untrusted).unwrap());
    assert!(
        book.enroll(b.enroll(relationship, b_laptop, 13).unwrap(), untrusted, 14)
            .is_err()
    );
    book.enroll(b.enroll(relationship, b_laptop, 14).unwrap(), b_laptop, 15)
        .unwrap();
    assert!(book.may_receive_from(b.id(), b_phone).unwrap());
    book.set_receive_permission(b.id(), false).unwrap();
    assert!(!book.may_receive_from(b.id(), b_phone).unwrap());
    let intent = Uuid::new_v4();
    book.offer(intent, b.id(), Some(b_laptop), [1; 32]).unwrap();
    assert!(book.claim(intent, b_phone, [1; 32]).is_err());
    assert!(book.claim(intent, untrusted, [1; 32]).is_err());
    assert!(book.claim(intent, b_laptop, [1; 32]).is_ok());
    book.remove(b.id()).unwrap();
    assert!(book.begin_payload(intent, b_laptop, [1; 32]).is_err());
    assert!(
        book.add(friend, 16).is_err(),
        "the accepted invitation must not be replayable after removing a friendship"
    );
    let old_enrollment = b.enroll(relationship, b_laptop, 16).unwrap();
    let new_invite = a.invite(a_phone, b.id(), b_phone, 17).unwrap();
    let new_accept = b.accept(&new_invite, a_phone, b_phone, 18).unwrap();
    let new_confirm = a.confirm(&new_invite, &new_accept, b_phone, 19).unwrap();
    let new_friend = FriendRecord::verify(
        &new_invite,
        &new_accept,
        &new_confirm,
        a.id(),
        a_phone,
        b_phone,
        20,
    )
    .unwrap();
    assert_ne!(relationship, new_friend.relationship());
    book.add(new_friend, 20).unwrap();
    assert!(book.enroll(old_enrollment, b_laptop, 20).is_err());
}

#[test]
fn private_contact_card_bootstraps_only_a_bound_targeted_invite() {
    let a = FriendAuthority::load_or_create(&Memory::default()).unwrap();
    let b = FriendAuthority::load_or_create(&Memory::default()).unwrap();
    let c = FriendAuthority::load_or_create(&Memory::default()).unwrap();
    let ap = PeerId::from_tls_leaf(b"invite-issuer");
    let bp = PeerId::from_tls_leaf(b"contact-card-owner");
    let cp = PeerId::from_tls_leaf(b"not-the-target-device");
    let card = b.contact_card(bp, 10).unwrap();
    let invite = a.invite_contact(ap, &card, 11).unwrap();
    assert!(c.accept(&invite, ap, cp, 12).is_err());
    assert!(b.accept(&invite, ap, bp, 12).is_ok());
    assert!(a.invite_contact(ap, &card, 86_410).is_err());
    assert!(a.invite_contact(ap, &(card + "AA"), 11).is_err());
}

#[test]
fn separate_book_instances_cannot_double_award_after_reading_same_revision() {
    use std::sync::{
        Barrier,
        atomic::{AtomicBool, Ordering},
    };
    struct RaceStore {
        inner: Memory,
        synchronize_reads: AtomicBool,
        ready: Barrier,
    }
    impl FriendStore for RaceStore {
        fn load(&self) -> Result<Option<Vec<u8>>, TransferError> {
            let snapshot = FriendStore::load(&self.inner)?;
            if self.synchronize_reads.load(Ordering::SeqCst) {
                self.ready.wait();
            }
            Ok(snapshot)
        }
        fn replace(&self, expected: Option<&[u8]>, data: &[u8]) -> Result<(), TransferError> {
            self.inner.replace(expected, data)
        }
    }
    let a = FriendAuthority::load_or_create(&Memory::default()).unwrap();
    let b = FriendAuthority::load_or_create(&Memory::default()).unwrap();
    let ap = PeerId::from_tls_leaf(b"a-sender");
    let bp1 = PeerId::from_tls_leaf(b"b-device-1");
    let bp2 = PeerId::from_tls_leaf(b"b-device-2");
    let invite = a.invite(ap, b.id(), bp1, 100).unwrap();
    let acceptance = b.accept(&invite, ap, bp1, 101).unwrap();
    let approval = a.confirm(&invite, &acceptance, bp1, 102).unwrap();
    let verified =
        FriendRecord::verify(&invite, &acceptance, &approval, a.id(), ap, bp1, 103).unwrap();
    let relation = verified.relationship();
    let storage = Arc::new(RaceStore {
        inner: Memory::default(),
        synchronize_reads: AtomicBool::new(false),
        ready: Barrier::new(2),
    });
    let first = FriendBook::open(a.id(), storage.clone()).unwrap();
    let second = FriendBook::open(a.id(), storage.clone()).unwrap();
    first.add(verified, 103).unwrap();
    first
        .enroll(b.enroll(relation, bp2, 104).unwrap(), bp2, 105)
        .unwrap();
    let intent = Uuid::new_v4();
    first.offer(intent, b.id(), None, [7; 32]).unwrap();
    storage.synchronize_reads.store(true, Ordering::SeqCst);
    std::thread::scope(|s| {
        let a = s.spawn(|| first.claim(intent, bp1, [7; 32]));
        let b = s.spawn(|| second.claim(intent, bp2, [7; 32]));
        assert_ne!(a.join().unwrap().is_ok(), b.join().unwrap().is_ok());
    });
    storage.synchronize_reads.store(false, Ordering::SeqCst);
    assert!(first.winner(intent).unwrap().is_some());
    assert_eq!(
        first.winner(intent).unwrap(),
        second.winner(intent).unwrap()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn friends_offer_fanout_retains_real_recipient_consent_and_withdrawal() {
    use aerift_peers::{
        FriendControlObject, FriendDecision, FriendObjectKind, FriendOfferEndpoint, Identity,
    };
    use tokio::net::TcpListener;
    use tokio_util::sync::CancellationToken;
    let alice = FriendAuthority::load_or_create(&Memory::default()).unwrap();
    let bob = FriendAuthority::load_or_create(&Memory::default()).unwrap();
    let a = Arc::new(Identity::load_or_create(&Memory::default()).unwrap());
    let b = Arc::new(Identity::load_or_create(&Memory::default()).unwrap());
    let c = Arc::new(Identity::load_or_create(&Memory::default()).unwrap());
    let unrelated = Identity::load_or_create(&Memory::default()).unwrap();
    let (ap, bp, cp) = (a.id(), b.id(), c.id());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let invitation = alice.invite(ap, bob.id(), bp, now).unwrap();
    let consent = bob.accept(&invitation, ap, bp, now).unwrap();
    let approval = alice.confirm(&invitation, &consent, bp, now).unwrap();
    let av =
        FriendRecord::verify(&invitation, &consent, &approval, alice.id(), ap, bp, now).unwrap();
    let bv = FriendRecord::verify(&invitation, &consent, &approval, bob.id(), bp, ap, now).unwrap();
    let relationship = av.relationship();
    let book_a = Arc::new(FriendBook::open(alice.id(), Arc::new(Memory::default())).unwrap());
    let b_store = Arc::new(Memory::default());
    let book_b = Arc::new(FriendBook::open(bob.id(), b_store.clone()).unwrap());
    let book_c = Arc::new(FriendBook::open(bob.id(), Arc::new(Memory::default())).unwrap());
    book_a.add(av, now).unwrap();
    book_b.add(bv.clone(), now).unwrap();
    book_c.add(bv, now).unwrap();
    book_a
        .enroll(bob.enroll(relationship, cp, now).unwrap(), cp, now)
        .unwrap();
    let cancel = CancellationToken::new();
    let mut servers = Vec::new();
    let mut routes = Vec::new();
    for (identity, book) in [(&a, &book_a), (&b, &book_b), (&c, &book_c)] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        routes.push([listener.local_addr().unwrap()]);
        let (identity, book, stop) = (identity.clone(), book.clone(), cancel.clone());
        servers.push(tokio::spawn(async move {
            FriendOfferEndpoint::serve(&identity, listener, book, stop).await
        }));
    }
    let intent = Uuid::new_v4();
    let hash = [22; 32];
    book_a.offer(intent, bob.id(), None, hash).unwrap();
    book_a
        .prepare_fanout(
            intent,
            FriendControlObject::new(FriendObjectKind::File, "fixture.bin".into(), 900, now + 350)
                .unwrap(),
            now,
        )
        .unwrap();
    assert!(
        FriendOfferEndpoint::deliver(&unrelated, &book_a, intent, bp, &routes[1], now)
            .await
            .is_err()
    );
    assert!(book_b.incoming(now).unwrap().is_empty());
    book_c.set_receive_permission(alice.id(), false).unwrap();
    assert!(
        FriendOfferEndpoint::deliver(&a, &book_a, intent, cp, &routes[2], now)
            .await
            .is_err()
    );
    book_c.set_receive_permission(alice.id(), true).unwrap();
    assert!(
        FriendOfferEndpoint::deliver(&a, &book_a, intent, bp, &routes[2], now)
            .await
            .is_err()
    );
    assert!(
        FriendOfferEndpoint::accept_received(&b, &book_b, &routes[0], ap, intent, now)
            .await
            .is_err()
    );
    assert_eq!(book_a.winner(intent).unwrap(), None);
    let (r1, r2) = tokio::join!(
        FriendOfferEndpoint::deliver(&a, &book_a, intent, bp, &routes[1], now),
        FriendOfferEndpoint::deliver(&a, &book_a, intent, cp, &routes[2], now)
    );
    r1.unwrap();
    r2.unwrap();
    FriendOfferEndpoint::deliver(&a, &book_a, intent, bp, &routes[1], now)
        .await
        .unwrap();
    assert_eq!(book_a.winner(intent).unwrap(), None);
    assert_eq!(
        book_b.incoming(now).unwrap().len(),
        1,
        "delivery retry is deduplicated"
    );
    assert_eq!(book_c.incoming(now).unwrap().len(), 1);
    let reopened = FriendBook::open(bob.id(), b_store).unwrap();
    assert_eq!(
        reopened.incoming(now).unwrap()[0].decision(),
        FriendDecision::Open
    );
    let (first, second) = tokio::join!(
        FriendOfferEndpoint::accept_received(&b, &book_b, &routes[0], ap, intent, now),
        FriendOfferEndpoint::accept_received(&c, &book_c, &routes[0], ap, intent, now)
    );
    assert_ne!(first.is_ok(), second.is_ok());
    let (winner, win_book, loser, lose_book) = if first.is_ok() {
        (&b, &book_b, &c, &book_c)
    } else {
        (&c, &book_c, &b, &book_b)
    };
    assert_eq!(book_a.winner(intent).unwrap(), Some(winner.id()));
    assert_eq!(
        FriendOfferEndpoint::accept_received(winner, win_book, &routes[0], ap, intent, now)
            .await
            .unwrap(),
        aerift_peers::FriendClaim::AlreadyAwarded
    );
    assert_eq!(
        FriendOfferEndpoint::refresh_received(loser, lose_book, &routes[0], ap, intent, now)
            .await
            .unwrap(),
        FriendDecision::Withdrawn
    );
    assert_eq!(
        lose_book.incoming(now).unwrap()[0].decision(),
        FriendDecision::Withdrawn
    );
    assert!(
        FriendOfferEndpoint::accept_received(loser, lose_book, &routes[0], ap, intent, now)
            .await
            .is_err()
    );
    win_book.set_receive_permission(alice.id(), false).unwrap();
    assert!(
        FriendOfferEndpoint::accept_received(winner, win_book, &routes[0], ap, intent, now)
            .await
            .is_err()
    );
    cancel.cancel();
    for server in servers {
        server.await.unwrap().unwrap();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn private_invitation_wire_requires_both_approvals_and_exact_tls_recipient() {
    use aerift_peers::{FriendInviteEndpoint, FriendInviteState, Identity};
    use tokio::net::TcpListener;
    use tokio_util::sync::CancellationToken;
    let a = FriendAuthority::load_or_create(&Memory::default()).unwrap();
    let b = FriendAuthority::load_or_create(&Memory::default()).unwrap();
    let ap = Arc::new(Identity::load_or_create(&Memory::default()).unwrap());
    let bp = Identity::load_or_create(&Memory::default()).unwrap();
    let unrelated = Identity::load_or_create(&Memory::default()).unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let recipient_card = b.contact_card(bp.id(), now).unwrap();
    let a_data = Arc::new(Memory::default());
    let a_book = Arc::new(FriendBook::open(a.id(), a_data.clone()).unwrap());
    let b_data = Arc::new(Memory::default());
    let b_book = FriendBook::open(b.id(), b_data.clone()).unwrap();
    let expired_card = b.contact_card(bp.id(), now - 360).unwrap();
    let expired = FriendInviteEndpoint::issue(&a, &ap, &a_book, &expired_card, now - 360).unwrap();
    let pending = FriendInviteEndpoint::issue(&a, &ap, &a_book, &recipient_card, now).unwrap();
    let nonce = pending.id();
    assert_eq!(
        FriendInviteEndpoint::local_state(&ap, &a_book, nonce, now).unwrap(),
        FriendInviteState::AwaitingRecipient
    );
    assert!(!a_book.may_receive_from(b.id(), bp.id()).unwrap());
    assert!(!b_book.may_receive_from(a.id(), ap.id()).unwrap());
    assert!(FriendInviteEndpoint::approve(&a, &ap, &a_book, nonce, now).is_err());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let routes = [listener.local_addr().unwrap()];
    let shutdown = CancellationToken::new();
    let server = {
        let (ap, a_book, stop) = (ap.clone(), a_book.clone(), shutdown.clone());
        tokio::spawn(async move { FriendInviteEndpoint::serve(&ap, listener, a_book, stop).await })
    };
    assert!(
        FriendInviteEndpoint::consent(&b, &bp, &b_book, &routes, &expired, now - 360)
            .await
            .is_err()
    );
    assert!(
        FriendInviteEndpoint::consent(&b, &unrelated, &b_book, &routes, &pending, now)
            .await
            .is_err()
    );
    FriendInviteEndpoint::consent(&b, &bp, &b_book, &routes, &pending, now)
        .await
        .unwrap();
    assert!(!a_book.may_receive_from(b.id(), bp.id()).unwrap());
    assert!(
        !FriendInviteEndpoint::finish(&b, &bp, &b_book, &routes, &pending, now)
            .await
            .unwrap()
    );
    assert_eq!(
        FriendInviteEndpoint::local_state(&ap, &a_book, nonce, now).unwrap(),
        FriendInviteState::RecipientConsented
    );
    let b_book = FriendBook::open(b.id(), b_data).unwrap();
    let reopened = FriendBook::open(a.id(), a_data).unwrap();
    FriendInviteEndpoint::approve(&a, &ap, &reopened, nonce, now).unwrap();
    assert_eq!(
        FriendInviteEndpoint::local_state(&ap, &a_book, nonce, now).unwrap(),
        FriendInviteState::Confirmed
    );
    assert!(a_book.may_receive_from(b.id(), bp.id()).unwrap());
    assert!(
        FriendInviteEndpoint::finish(&b, &bp, &b_book, &routes, &pending, now)
            .await
            .unwrap()
    );
    assert!(b_book.may_receive_from(a.id(), ap.id()).unwrap());
    b_book.remove(a.id()).unwrap();
    assert!(
        FriendInviteEndpoint::finish(&b, &bp, &b_book, &routes, &pending, now)
            .await
            .is_err()
    );
    assert!(!b_book.may_receive_from(a.id(), ap.id()).unwrap());
    shutdown.cancel();
    server.await.unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn private_roster_enrollment_requires_signed_grant_expected_peer_and_does_not_replay_revoked_device()
 {
    use aerift_peers::{FriendInviteEndpoint, Identity};
    use tokio::net::TcpListener;
    use tokio_util::sync::CancellationToken;

    let a = FriendAuthority::load_or_create(&Memory::default()).unwrap();
    let b = FriendAuthority::load_or_create(&Memory::default()).unwrap();
    let receiver = Arc::new(Identity::load_or_create(&Memory::default()).unwrap());
    let existing = Identity::load_or_create(&Memory::default()).unwrap();
    let additional = Identity::load_or_create(&Memory::default()).unwrap();
    let wrong = Identity::load_or_create(&Memory::default()).unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let invite = a.invite(receiver.id(), b.id(), existing.id(), now).unwrap();
    let consent = b
        .accept(&invite, receiver.id(), existing.id(), now)
        .unwrap();
    let approval = a.confirm(&invite, &consent, existing.id(), now).unwrap();
    let record = FriendRecord::verify(
        &invite,
        &consent,
        &approval,
        a.id(),
        receiver.id(),
        existing.id(),
        now,
    )
    .unwrap();
    let relationship = record.relationship();
    let book = Arc::new(FriendBook::open(a.id(), Arc::new(Memory::default())).unwrap());
    book.add(record, now).unwrap();

    let grant = b.enroll(relationship, additional.id(), now).unwrap();
    let ticket = FriendInviteEndpoint::expect_device(&receiver, &book, grant, now).unwrap();
    assert!(!book.may_receive_from(b.id(), additional.id()).unwrap());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let routes = [listener.local_addr().unwrap()];
    let shutdown = CancellationToken::new();
    let server = {
        let (receiver, book, stop) = (receiver.clone(), book.clone(), shutdown.clone());
        tokio::spawn(
            async move { FriendInviteEndpoint::serve(&receiver, listener, book, stop).await },
        )
    };
    assert!(
        FriendInviteEndpoint::prove_device(&wrong, &routes, receiver.id(), ticket)
            .await
            .is_err()
    );
    assert!(
        FriendInviteEndpoint::prove_device(&additional, &routes, receiver.id(), Uuid::new_v4())
            .await
            .is_err()
    );
    FriendInviteEndpoint::prove_device(&additional, &routes, receiver.id(), ticket)
        .await
        .unwrap();
    assert!(book.may_receive_from(b.id(), additional.id()).unwrap());
    FriendInviteEndpoint::prove_device(&additional, &routes, receiver.id(), ticket)
        .await
        .unwrap();
    book.revoke_device(b.id(), additional.id()).unwrap();
    assert!(
        FriendInviteEndpoint::prove_device(&additional, &routes, receiver.id(), ticket)
            .await
            .is_err()
    );
    assert!(!book.may_receive_from(b.id(), additional.id()).unwrap());
    shutdown.cancel();
    server.await.unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn friends_payload_reaches_only_winner_with_verified_digest_and_receipt() {
    use aerift_peers::{FriendOfferEndpoint, FriendPayloadEndpoint, Identity};
    use aerift_transfer::{ReceiveLimits, Receiver, State, inspect_file_offer};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tokio::net::TcpListener;
    use tokio_util::sync::CancellationToken;

    let alice = FriendAuthority::load_or_create(&Memory::default()).unwrap();
    let bob = FriendAuthority::load_or_create(&Memory::default()).unwrap();
    let a = Arc::new(Identity::load_or_create(&Memory::default()).unwrap());
    let b = Arc::new(Identity::load_or_create(&Memory::default()).unwrap());
    let c = Arc::new(Identity::load_or_create(&Memory::default()).unwrap());
    let (ap, bp, cp) = (a.id(), b.id(), c.id());
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let inv = alice.invite(ap, bob.id(), bp, now).unwrap();
    let acc = bob.accept(&inv, ap, bp, now).unwrap();
    let confirm = alice.confirm(&inv, &acc, bp, now).unwrap();
    let av = FriendRecord::verify(&inv, &acc, &confirm, alice.id(), ap, bp, now).unwrap();
    let bv = FriendRecord::verify(&inv, &acc, &confirm, bob.id(), bp, ap, now).unwrap();
    let relation = av.relationship();
    let a_data = Arc::new(Memory::default());
    let book_a = Arc::new(FriendBook::open(alice.id(), a_data.clone()).unwrap());
    let b_data = Arc::new(Memory::default());
    let book_b = Arc::new(FriendBook::open(bob.id(), b_data.clone()).unwrap());
    let book_c = Arc::new(FriendBook::open(bob.id(), Arc::new(Memory::default())).unwrap());
    book_a.add(av, now).unwrap();
    book_b.add(bv.clone(), now).unwrap();
    book_c.add(bv, now).unwrap();
    book_a
        .enroll(bob.enroll(relation, cp, now).unwrap(), cp, now)
        .unwrap();

    let stop = CancellationToken::new();
    let mut jobs = Vec::new();
    let mut controls = Vec::new();
    for (identity, book) in [(&a, &book_a), (&b, &book_b), (&c, &book_c)] {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        controls.push([l.local_addr().unwrap()]);
        let (identity, book, stop) = (identity.clone(), book.clone(), stop.clone());
        jobs.push(tokio::spawn(async move {
            FriendOfferEndpoint::serve(&identity, l, book, stop).await
        }));
    }
    let dir_b = tempfile::tempdir().unwrap();
    let dir_c = tempfile::tempdir().unwrap();
    let limit = ReceiveLimits {
        session_offers: 16,
        active_bytes: 32 * 1024 * 1024,
    };
    let receiver_b = Arc::new(Receiver::new(dir_b.path(), limit).unwrap());
    let receiver_c = Arc::new(Receiver::new(dir_c.path(), limit).unwrap());
    let mut payloads = Vec::new();
    for (identity, book, receiver) in [(&b, &book_b, &receiver_b), (&c, &book_c, &receiver_c)] {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        payloads.push([l.local_addr().unwrap()]);
        let (identity, book, receiver, stop) = (
            identity.clone(),
            book.clone(),
            receiver.clone(),
            stop.clone(),
        );
        jobs.push(tokio::spawn(async move {
            FriendPayloadEndpoint::serve(&identity, l, book, receiver, stop).await
        }));
    }
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("source.bin");
    let bytes = (0..256_000usize)
        .map(|i| (i % 251) as u8)
        .collect::<Vec<_>>();
    std::fs::write(&input, &bytes).unwrap();
    let manifest = FriendPayloadEndpoint::stage_file(
        &book_a,
        bob.id(),
        None,
        &input,
        "fixture.bin",
        now + 350,
    )
    .await
    .unwrap();
    let intent = manifest.id;
    assert!(
        FriendPayloadEndpoint::send_file(
            &a,
            book_a.clone(),
            &payloads[0],
            &manifest,
            &input,
            CancellationToken::new(),
            |_, _| {}
        )
        .await
        .is_err()
    );
    FriendOfferEndpoint::deliver(&a, &book_a, intent, bp, &controls[1], now)
        .await
        .unwrap();
    FriendOfferEndpoint::deliver(&a, &book_a, intent, cp, &controls[2], now)
        .await
        .unwrap();
    FriendOfferEndpoint::accept_received(&b, &book_b, &controls[0], ap, intent, now)
        .await
        .unwrap();
    assert!(
        FriendOfferEndpoint::accept_received(&c, &book_c, &controls[0], ap, intent, now)
            .await
            .is_err()
    );
    assert!(
        FriendPayloadEndpoint::send_file(
            &a,
            book_a.clone(),
            &payloads[1],
            &manifest,
            &input,
            CancellationToken::new(),
            |_, _| {}
        )
        .await
        .is_err()
    );
    std::fs::write(&input, vec![123; bytes.len()]).unwrap();
    assert!(
        FriendPayloadEndpoint::send_file(
            &a,
            book_a.clone(),
            &payloads[0],
            &manifest,
            &input,
            CancellationToken::new(),
            |_, _| {}
        )
        .await
        .is_err()
    );
    assert!(receiver_b.snapshot().is_empty());
    std::fs::write(&input, &bytes).unwrap();
    let status = FriendPayloadEndpoint::send_file(
        &a,
        book_a.clone(),
        &payloads[0],
        &manifest,
        &input,
        CancellationToken::new(),
        |_, _| {},
    )
    .await
    .unwrap();
    assert_eq!(status.state, State::Completed);
    assert_eq!(status.bytes_transferred, bytes.len() as u64);
    assert!(receiver_c.snapshot().is_empty());
    let receipt = receiver_b.snapshot().pop().unwrap();
    assert_eq!(receipt.key.id, intent);
    assert_eq!(receipt.status.state, State::Completed);
    let saved = receipt.saved_path.unwrap();
    assert_eq!(std::fs::read(&saved).unwrap(), bytes);
    assert_eq!(
        inspect_file_offer(intent, &saved, "fixture.bin")
            .await
            .unwrap()
            .sha256,
        manifest.sha256
    );
    let reopened = FriendBook::open(alice.id(), a_data).unwrap();
    assert!(
        FriendPayloadEndpoint::send_file(
            &a,
            Arc::new(reopened),
            &payloads[0],
            &manifest,
            &input,
            CancellationToken::new(),
            |_, _| {}
        )
        .await
        .is_err()
    );
    let cancelled = FriendPayloadEndpoint::stage_file(
        &book_a,
        bob.id(),
        Some(bp),
        &input,
        "cancel.bin",
        now + 350,
    )
    .await
    .unwrap();
    FriendOfferEndpoint::deliver(&a, &book_a, cancelled.id, bp, &controls[1], now)
        .await
        .unwrap();
    FriendOfferEndpoint::accept_received(&b, &book_b, &controls[0], ap, cancelled.id, now)
        .await
        .unwrap();
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let state = FriendPayloadEndpoint::send_file(
        &a,
        book_a.clone(),
        &payloads[0],
        &cancelled,
        &input,
        cancel,
        move |_, status| {
            if status.state == State::Accepted {
                trigger.cancel()
            }
        },
    )
    .await
    .unwrap();
    assert_eq!(state.state, State::Cancelled);
    assert!(!dir_b.path().join("cancel.bin").exists());
    let cancel_receipt = receiver_b
        .snapshot()
        .into_iter()
        .find(|r| r.key.id == cancelled.id)
        .unwrap();
    assert_eq!(cancel_receipt.status.bytes_transferred, 0);
    assert_eq!(cancel_receipt.status.state, State::Cancelled);
    let denied = FriendPayloadEndpoint::stage_file(
        &book_a,
        bob.id(),
        Some(bp),
        &input,
        "revoked.bin",
        now + 350,
    )
    .await
    .unwrap();
    FriendOfferEndpoint::deliver(&a, &book_a, denied.id, bp, &controls[1], now)
        .await
        .unwrap();
    FriendOfferEndpoint::accept_received(&b, &book_b, &controls[0], ap, denied.id, now)
        .await
        .unwrap();
    book_b.revoke_device(alice.id(), ap).unwrap();
    assert!(
        FriendPayloadEndpoint::send_file(
            &a,
            book_a.clone(),
            &payloads[0],
            &denied,
            &input,
            CancellationToken::new(),
            |_, _| {}
        )
        .await
        .is_err()
    );
    assert!(!dir_b.path().join("revoked.bin").exists());

    let active = FriendPayloadEndpoint::stage_file(
        &book_a,
        bob.id(),
        Some(cp),
        &input,
        "active-revoke.bin",
        now + 350,
    )
    .await
    .unwrap();
    FriendOfferEndpoint::deliver(&a, &book_a, active.id, cp, &controls[2], now)
        .await
        .unwrap();
    FriendOfferEndpoint::accept_received(&c, &book_c, &controls[0], ap, active.id, now)
        .await
        .unwrap();
    let sending_book = book_a.clone();
    let bob_id = bob.id();
    let attempted = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let attempt = attempted.clone();
    let result = FriendPayloadEndpoint::send_file(
        &a,
        book_a.clone(),
        &payloads[1],
        &active,
        &input,
        CancellationToken::new(),
        move |_, status| {
            use std::sync::atomic::Ordering;
            if status.state == State::Transferring
                && status.bytes_transferred > 0
                && !attempt.swap(true, Ordering::SeqCst)
            {
                sending_book.revoke_device(bob_id, cp).unwrap();
            }
        },
    )
    .await;
    assert!(attempted.load(std::sync::atomic::Ordering::SeqCst));
    assert!(result.is_err() || result.unwrap().state != State::Completed);
    assert!(!dir_c.path().join("active-revoke.bin").exists());
    stop.cancel();
    for job in jobs {
        tokio::time::timeout(Duration::from_secs(2), job)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}
