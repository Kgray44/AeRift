use aerift_peers::{
    FRIEND_PROFILE_RGB_EDGE, FriendAuthority, FriendBook, FriendGlassPreset, FriendProfileAvatar,
    FriendRecord, FriendStore, SecretStore, SharedFriendProfile,
};
use aerift_transfer::{ErrorCode, PeerId, TransferError};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

#[derive(Default)]
struct Memory(Mutex<Option<Vec<u8>>>, AtomicBool);
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
        if self.1.load(Ordering::SeqCst) {
            return Err(ErrorCode::StorageFailed.into());
        }
        let mut state = self.0.lock().unwrap();
        if state.as_deref() != expected {
            return Err(ErrorCode::Conflict.into());
        }
        *state = Some(data.to_vec());
        Ok(())
    }
}

struct Pair {
    alice: FriendAuthority,
    bob: FriendAuthority,
    a_book: FriendBook,
    b_book: FriendBook,
    a_device: PeerId,
    b_device: PeerId,
    b_store: Arc<Memory>,
}
impl Pair {
    fn new() -> Self {
        let alice = FriendAuthority::load_or_create(&Memory::default()).unwrap();
        let bob = FriendAuthority::load_or_create(&Memory::default()).unwrap();
        let a_book = FriendBook::open(alice.id(), Arc::new(Memory::default())).unwrap();
        let b_store = Arc::new(Memory::default());
        let b_book = FriendBook::open(bob.id(), b_store.clone()).unwrap();
        Self {
            alice,
            bob,
            a_book,
            b_book,
            a_device: PeerId::from_tls_leaf(b"fixture-a"),
            b_device: PeerId::from_tls_leaf(b"fixture-b"),
            b_store,
        }
    }
    fn pair(&self, time: u64) {
        let invite = self
            .alice
            .invite(self.a_device, self.bob.id(), self.b_device, time)
            .unwrap();
        let acceptance = self
            .bob
            .accept(&invite, self.a_device, self.b_device, time)
            .unwrap();
        let approval = self
            .alice
            .confirm(&invite, &acceptance, self.b_device, time)
            .unwrap();
        let local = FriendRecord::verify(
            &invite,
            &acceptance,
            &approval,
            self.alice.id(),
            self.a_device,
            self.b_device,
            time,
        )
        .unwrap();
        let remote = FriendRecord::verify(
            &invite,
            &acceptance,
            &approval,
            self.bob.id(),
            self.b_device,
            self.a_device,
            time,
        )
        .unwrap();
        self.a_book.add(local, time).unwrap();
        self.b_book.add(remote, time).unwrap();
    }
    fn share(&self, revision: u64, confirmed: bool) -> Result<Vec<u8>, TransferError> {
        self.alice.share_profile(
            &self.a_book,
            self.a_device,
            self.bob.id(),
            self.b_device,
            revision,
            102,
            SharedFriendProfile::new(
                "Alice",
                None,
                FriendProfileAvatar::Glass {
                    preset: FriendGlassPreset::Prism,
                },
            )
            .unwrap(),
            confirmed,
        )
    }
}

#[test]
fn first_shared_profile_needs_confirmed_live_relationship_and_sender_pin() {
    let pair = Pair::new();
    assert!(pair.share(1, true).is_err());
    pair.pair(100);
    assert!(pair.share(1, false).is_err());
    assert!(pair.share(0, true).is_err());
    let wire = pair.share(1, true).unwrap();
    let result = pair
        .b_book
        .verify_shared_profile(&wire, pair.b_device, pair.a_device, 103, None)
        .unwrap();
    assert_eq!(result.profile.display_name(), "Alice");
    assert_eq!(result.profile.nickname(), None);
    assert_eq!(result.cursor.revision(), 1);
    assert!(!std::str::from_utf8(&wire).unwrap().contains("nickname"));
    let other_pin = PeerId::from_tls_leaf(b"unrelated device");
    assert!(
        pair.b_book
            .verify_shared_profile(&wire, pair.b_device, other_pin, 103, None)
            .is_err()
    );
    assert!(
        pair.b_book
            .verify_shared_profile(&wire, other_pin, pair.a_device, 103, None)
            .is_err()
    );
    assert!(
        pair.a_book
            .verify_shared_profile(&wire, pair.b_device, pair.a_device, 103, None)
            .is_err()
    );
}

#[test]
fn duplicate_rollback_expiry_and_tampered_display_are_rejected() {
    let pair = Pair::new();
    pair.pair(100);
    let wire = pair.share(1, true).unwrap();
    let revised = pair.share(2, true).unwrap();
    let receive = |wire: &[u8], time, cursor| {
        pair.b_book
            .verify_shared_profile(wire, pair.b_device, pair.a_device, time, cursor)
    };
    let result = receive(&wire, 103, None).unwrap();
    let updated = receive(&revised, 104, Some(result.cursor)).unwrap();
    assert!(receive(&wire, 104, Some(updated.cursor)).is_err());
    assert!(receive(&revised, 104, Some(updated.cursor)).is_err());
    assert!(receive(&wire, 101, None).is_err());
    assert!(receive(&wire, 702, None).is_err());
    let mut altered: serde_json::Value = serde_json::from_slice(&wire).unwrap();
    altered["profile"]["displayName"] = "Not Alice".into();
    assert!(receive(&serde_json::to_vec(&altered).unwrap(), 104, None).is_err());
    altered["profile"]["localOverride"] = "Never shared".into();
    assert!(receive(&serde_json::to_vec(&altered).unwrap(), 104, None).is_err());
}

#[test]
fn revoking_device_or_repairing_does_not_reuse_profile_scope() {
    let pair = Pair::new();
    pair.pair(100);
    let wire = pair.share(1, true).unwrap();
    pair.b_book
        .revoke_device(pair.alice.id(), pair.a_device)
        .unwrap();
    assert!(
        pair.b_book
            .verify_shared_profile(&wire, pair.b_device, pair.a_device, 103, None)
            .is_err()
    );
    pair.b_book.remove(pair.alice.id()).unwrap();
    pair.a_book.remove(pair.bob.id()).unwrap();
    pair.pair(105);
    assert!(
        pair.b_book
            .verify_shared_profile(&wire, pair.b_device, pair.a_device, 106, None)
            .is_err()
    );
    pair.a_book
        .revoke_device(pair.bob.id(), pair.b_device)
        .unwrap();
    assert!(pair.share(2, true).is_err());
}

#[test]
fn raster_is_fixed_metadata_free_and_names_are_bounded() {
    let size = FRIEND_PROFILE_RGB_EDGE.pow(2) * 3;
    assert!(FriendProfileAvatar::from_rgb64(&vec![0; size - 1]).is_err());
    let pixels = vec![59; size];
    let avatar = FriendProfileAvatar::from_rgb64(&pixels).unwrap();
    assert_eq!(avatar.rgb64_pixels().unwrap().unwrap(), pixels);
    assert!(SharedFriendProfile::new(&"a".repeat(129), None, avatar.clone()).is_err());
    assert!(SharedFriendProfile::new("Alice\u{202e}png", None, avatar.clone()).is_err());
    assert!(SharedFriendProfile::new("Alice", Some("\n"), avatar.clone()).is_err());
    let pair = Pair::new();
    pair.pair(100);
    let profile = SharedFriendProfile::new(" Álïce ", Some("Garden"), avatar).unwrap();
    let wire = pair
        .alice
        .share_profile(
            &pair.a_book,
            pair.a_device,
            pair.bob.id(),
            pair.b_device,
            3,
            102,
            profile,
            true,
        )
        .unwrap();
    let profile = pair
        .b_book
        .verify_shared_profile(&wire, pair.b_device, pair.a_device, 103, None)
        .unwrap()
        .profile;
    assert_eq!(profile.display_name(), "Álïce");
    assert_eq!(profile.nickname(), Some("Garden"));
    assert_eq!(profile.avatar().rgb64_pixels().unwrap().unwrap(), pixels);
    assert!(
        pair.b_book
            .verify_shared_profile(&[b' '; 18_001], pair.b_device, pair.a_device, 103, None)
            .is_err()
    );
}

#[test]
fn committed_profile_and_revision_reopen_together_and_removal_hides_cache() {
    let pair = Pair::new();
    pair.pair(100);
    let wire = pair.share(1, true).unwrap();
    pair.b_book
        .apply_shared_profile(&wire, pair.b_device, pair.a_device, 103)
        .unwrap();
    let reopened = FriendBook::open(pair.bob.id(), pair.b_store.clone()).unwrap();
    let stored = reopened.shared_profile(pair.alice.id()).unwrap().unwrap();
    assert_eq!(stored.cursor.revision(), 1);
    assert_eq!(stored.profile.display_name(), "Alice");
    assert!(
        reopened
            .apply_shared_profile(&wire, pair.b_device, pair.a_device, 104)
            .is_err()
    );
    let disk: serde_json::Value =
        serde_json::from_slice(&SecretStore::load(pair.b_store.as_ref()).unwrap().unwrap())
            .unwrap();
    assert_eq!(disk["version"], 2);
    assert!(
        !disk["friends"][0]["profile"]
            .to_string()
            .contains("signature")
    );
    reopened.remove(pair.alice.id()).unwrap();
    assert!(reopened.shared_profile(pair.alice.id()).unwrap().is_none());
    pair.a_book.remove(pair.bob.id()).unwrap();
    pair.pair(105);
    assert!(
        pair.b_book
            .shared_profile(pair.alice.id())
            .unwrap()
            .is_none()
    );
    assert!(
        pair.b_book
            .apply_shared_profile(&wire, pair.b_device, pair.a_device, 106)
            .is_err()
    );
}

#[test]
fn failed_commit_and_failed_revocation_are_fail_closed() {
    let pair = Pair::new();
    pair.pair(100);
    let one = pair.share(1, true).unwrap();
    let two = pair.share(2, true).unwrap();
    pair.b_book
        .apply_shared_profile(&one, pair.b_device, pair.a_device, 103)
        .unwrap();
    pair.b_store.1.store(true, Ordering::SeqCst);
    assert!(
        pair.b_book
            .apply_shared_profile(&two, pair.b_device, pair.a_device, 103)
            .is_err()
    );
    assert_eq!(
        pair.b_book
            .shared_profile(pair.alice.id())
            .unwrap()
            .unwrap()
            .cursor
            .revision(),
        1
    );
    assert!(
        pair.b_book
            .revoke_device(pair.alice.id(), pair.a_device)
            .is_err()
    );
    assert!(
        pair.b_book
            .shared_profile(pair.alice.id())
            .unwrap()
            .is_none()
    );
    assert!(
        pair.b_book
            .apply_shared_profile(&two, pair.b_device, pair.a_device, 104)
            .is_err()
    );
    // An unrelated protected friend-book action commits the pending restriction.
    pair.b_store.1.store(false, Ordering::SeqCst);
    pair.b_book
        .set_receive_permission(pair.alice.id(), true)
        .unwrap();
    let reopened = FriendBook::open(pair.bob.id(), pair.b_store.clone()).unwrap();
    assert!(reopened.shared_profile(pair.alice.id()).unwrap().is_none());
    let raw = SecretStore::load(pair.b_store.as_ref()).unwrap().unwrap();
    let disk = std::str::from_utf8(&raw).unwrap();
    assert!(disk.contains("revision"));
    assert!(!disk.contains("displayName"));
}

#[test]
fn racing_receives_cannot_lower_the_persisted_revision() {
    let pair = Pair::new();
    pair.pair(100);
    let one = pair.share(1, true).unwrap();
    let three = pair.share(3, true).unwrap();
    std::thread::scope(|scope| {
        let older = scope.spawn(|| {
            pair.b_book
                .apply_shared_profile(&one, pair.b_device, pair.a_device, 103)
        });
        pair.b_book
            .apply_shared_profile(&three, pair.b_device, pair.a_device, 103)
            .unwrap();
        let _ = older.join().unwrap();
    });
    assert_eq!(
        pair.b_book
            .shared_profile(pair.alice.id())
            .unwrap()
            .unwrap()
            .cursor
            .revision(),
        3
    );
}
