use aerift_transfer::{
    ambient::{CaptureOrigin, RiftObjectKind},
    ambient_browser::{ExtensionOrigin, IntakeError, MAX_MESSAGE_BYTES, receive_one},
};
use std::io::{Cursor, Read};

const ALLOWED: &str = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";
fn message(body: &str) -> Cursor<Vec<u8>> {
    let mut bytes = (body.len() as u32).to_ne_bytes().to_vec();
    bytes.extend(body.as_bytes());
    Cursor::new(bytes)
}

#[test]
fn freezes_explicit_text_with_digest_and_no_raw_file_authority() {
    let origin = ExtensionOrigin::authorize(ALLOWED, ALLOWED).unwrap();
    let capture = receive_one(
        &mut message(r#"{"version":1,"kind":"selection","value":"hello"}"#),
        &origin,
    )
    .unwrap();
    assert_eq!(capture.origin, CaptureOrigin::ExplicitSelection);
    assert_eq!(capture.kind, RiftObjectKind::PlainText);
    let item = &capture.entries()[0];
    let mut output = String::new();
    item.open_verified()
        .unwrap()
        .read_to_string(&mut output)
        .unwrap();
    assert_eq!(output, "hello");
    assert!(item.manifest().sha256.is_some());
    assert!(
        capture
            .negotiate(aerift_transfer::ambient::ReceiverCapabilities::V1)
            .is_err()
    );
}

#[test]
fn refuses_unknown_origin_and_oversize_before_payload_reads() {
    assert!(
        ExtensionOrigin::authorize(
            ALLOWED,
            "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/"
        )
        .is_err()
    );
    assert!(ExtensionOrigin::authorize("chrome-extension://*/", "chrome-extension://*/").is_err());
    let origin = ExtensionOrigin::authorize(ALLOWED, ALLOWED).unwrap();
    let mut oversized = Cursor::new(((MAX_MESSAGE_BYTES + 1) as u32).to_ne_bytes().to_vec());
    assert_eq!(
        receive_one(&mut oversized, &origin).err(),
        Some(IntakeError::Frame)
    );
    assert_eq!(oversized.position(), 4);
}

#[test]
fn strict_schema_and_no_secret_url_reference() {
    let origin = ExtensionOrigin::authorize(ALLOWED, ALLOWED).unwrap();
    for invalid in [
        r#"{"version":2,"kind":"page","value":"https://example.test/"}"#,
        r#"{"version":1,"kind":"page","value":"https://user:pass@example.test/"}"#,
        r#"{"version":1,"kind":"page","value":"https://example.test/?token=secret"}"#,
        r#"{"version":1,"kind":"page","value":"file:///C:/secret"}"#,
        r#"{"version":1,"kind":"page","value":"https://example.test/","cookie":"secret"}"#,
        r#"{"version":1,"kind":"media_bytes","value":"test"}"#,
    ] {
        assert!(
            receive_one(&mut message(invalid), &origin).is_err(),
            "{invalid}"
        );
    }
    let capture = receive_one(
        &mut message(r#"{"version":1,"kind":"media","value":"https://example.test/video.mp4"}"#),
        &origin,
    )
    .unwrap();
    assert_eq!(capture.kind, RiftObjectKind::MediaReference);
    assert_eq!(capture.origin, CaptureOrigin::ActiveContent);
}

#[test]
fn browser_pickup_requires_one_user_arm_and_one_review_of_the_exact_frozen_object() {
    use aerift_transfer::ambient_browser::BrowserPickup;
    use std::time::{Duration, Instant};

    let now = Instant::now();
    let mut host = BrowserPickup::default();
    let origin = ExtensionOrigin::authorize(
        "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
        "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
    )
    .unwrap();
    let original = || message(r#"{"version":1,"kind":"selection","value":"exact frozen capture"}"#);
    let mutable = || message(r#"{"version":1,"kind":"selection","value":"different page"}"#);
    let ticket = host.arm(now);
    assert!(
        host.submit(uuid::Uuid::new_v4(), now, original().get_ref(), &origin)
            .is_err()
    );
    let review = host
        .submit(ticket, now, original().get_ref(), &origin)
        .unwrap();
    assert_eq!(review.literal, "exact frozen capture");
    assert!(
        host.submit(ticket, now, mutable().get_ref(), &origin)
            .is_err()
    );
    assert!(host.confirm(uuid::Uuid::new_v4(), now).is_err());
    let frozen = host.confirm(review.id, now).unwrap();
    let mut value = String::new();
    frozen.entries()[0]
        .open_verified()
        .unwrap()
        .read_to_string(&mut value)
        .unwrap();
    assert_eq!(value, "exact frozen capture");
    assert!(host.confirm(review.id, now).is_err());

    let replacement = host.arm(now + Duration::from_secs(2));
    assert!(
        host.submit(
            ticket,
            now + Duration::from_secs(2),
            original().get_ref(),
            &origin
        )
        .is_err()
    );
    assert!(
        host.submit(
            replacement,
            now + Duration::from_secs(301),
            original().get_ref(),
            &origin
        )
        .is_err()
    );
    assert!(
        host.confirm(review.id, now + Duration::from_secs(301))
            .is_err()
    );
}
