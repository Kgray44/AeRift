use aerift_transfer::{
    PeerId,
    ambient::{
        Candidate, CaptureContext, CaptureLimits, RiftObjectKind, freeze,
        session::{DropAuthority, DropError, HeldSession, Lane},
    },
};
use std::time::{Duration, Instant};
use uuid::Uuid;

struct Policy(bool);
impl DropAuthority for Policy {
    fn permits(&self, _: PeerId, lane: Lane) -> bool {
        self.0 && lane == Lane::MyDevices
    }
}
fn pickup(now: Instant) -> (tempfile::NamedTempFile, HeldSession) {
    let file = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(file.path(), b"frozen payload").unwrap();
    let capture = freeze(
        CaptureContext {
            explicit_selection: vec![Candidate::file_as(RiftObjectKind::File, file.path().into())],
            ..Default::default()
        },
        CaptureLimits::default(),
    )
    .unwrap();
    (
        file,
        HeldSession::pickup(capture, Lane::MyDevices, now).unwrap(),
    )
}
#[test]
fn resolve_requires_window_binding_trust_and_is_one_shot() {
    let now = Instant::now();
    let (_file, mut held) = pickup(now);
    let id = held.id();
    let peer = PeerId::from_tls_leaf(b"fixture peer");
    let end = now + Duration::from_millis(500);
    assert_eq!(
        held.resolve(now, &Policy(true)).err(),
        Some(DropError::NoDrop)
    );
    for (token, lane, ok, expected) in [
        (Uuid::new_v4(), Lane::MyDevices, true, DropError::Invalid),
        (id, Lane::Nearby, true, DropError::Invalid),
        (id, Lane::MyDevices, false, DropError::Unauthorized),
    ] {
        assert_eq!(
            held.drop_claim(token, peer, lane, now, &Policy(ok)),
            Err(expected)
        );
    }
    held.drop_claim(id, peer, Lane::MyDevices, now, &Policy(true))
        .unwrap();
    held.drop_claim(id, peer, Lane::MyDevices, now, &Policy(true))
        .unwrap();
    assert_eq!(
        held.resolve(now, &Policy(true)).err(),
        Some(DropError::WindowOpen)
    );
    assert!(held.resolve(end, &Policy(true)).is_ok());
    assert_eq!(
        held.resolve(end, &Policy(true)).err(),
        Some(DropError::Closed)
    );
    assert!(held.cancel().is_none());
}
#[test]
fn competing_authenticated_claims_never_dispatch() {
    let now = Instant::now();
    let (_file, mut held) = pickup(now);
    for leaf in [b"one", b"two"] {
        held.drop_claim(
            held.id(),
            PeerId::from_tls_leaf(leaf),
            Lane::MyDevices,
            now,
            &Policy(true),
        )
        .unwrap();
    }
    assert_eq!(
        held.resolve(now + Duration::from_secs(1), &Policy(true))
            .err(),
        Some(DropError::Ambiguous)
    );
    let event = serde_json::to_value(held.ambiguous_frame().unwrap()).unwrap();
    assert_eq!(event["phase"], "ambiguous");
    assert!(event.get("verified").is_none());
    assert!(event.get("peer").is_none());
}
#[test]
fn revocation_expiry_and_cancellation_refuse_dispatch() {
    let now = Instant::now();
    let (_file, mut held) = pickup(now);
    held.drop_claim(
        held.id(),
        PeerId::from_tls_leaf(b"fixture"),
        Lane::MyDevices,
        now,
        &Policy(true),
    )
    .unwrap();
    assert_eq!(
        held.resolve(now + Duration::from_secs(1), &Policy(false))
            .err(),
        Some(DropError::Unauthorized)
    );
    let (_file, mut held) = pickup(now);
    let later = now + Duration::from_secs(30);
    assert_eq!(
        held.resolve(later, &Policy(true)).err(),
        Some(DropError::Closed)
    );
    assert_eq!(
        serde_json::to_value(held.expire(later).unwrap()).unwrap()["phase"],
        "expired"
    );
    assert!(held.expire(later).is_none());
    let (_file, held) = pickup(now);
    assert_eq!(
        serde_json::to_value(held.cancel().unwrap()).unwrap()["phase"],
        "cancelled"
    );
}
