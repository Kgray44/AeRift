use aerift_transfer::ambient::*;
use std::io::{Read, Write};

fn candidate(kind: RiftObjectKind, title: &str) -> Candidate {
    Candidate::inline(kind, title, b"abc".to_vec(), "text/plain")
}
#[test]
fn explicit_selection_precedes_target_document_and_page() {
    let context = CaptureContext {
        explicit_selection: vec![candidate(RiftObjectKind::PlainText, "selected")],
        explicit_targets: vec![candidate(RiftObjectKind::Document, "target")],
        active_content: Some(candidate(RiftObjectKind::Video, "active")),
        active_page: Some(candidate(RiftObjectKind::WebPage, "web")),
        ..Default::default()
    };
    let captured = freeze(context, CaptureLimits::default()).unwrap();
    assert_eq!(captured.origin, CaptureOrigin::ExplicitSelection);
    assert_eq!(captured.entries()[0].manifest().title, "selected");
}
#[test]
fn unsupported_selection_never_falls_back_to_unrelated_objects() {
    let context = CaptureContext {
        explicit_selection: vec![Candidate::path("/not/a/real/path".into())],
        active_page: Some(candidate(RiftObjectKind::WebPage, "do-not-capture")),
        ..Default::default()
    };
    assert!(matches!(
        freeze(context, CaptureLimits::default()),
        Err(CaptureError::SourceUnavailable)
    ));
}
#[test]
fn selection_freezes_folder_members_and_v1_does_not_silently_drop_them() {
    let root = tempfile::tempdir().unwrap();
    let nested = root.path().join("nested");
    std::fs::create_dir(&nested).unwrap();
    std::fs::write(nested.join("first.txt"), "first").unwrap();
    let context = CaptureContext {
        explicit_selection: vec![
            Candidate::path(nested.clone()),
            candidate(RiftObjectKind::PlainText, "text"),
        ],
        ..Default::default()
    };
    let captured = freeze(context, CaptureLimits::default()).unwrap();
    std::fs::write(nested.join("added.txt"), "new").unwrap();
    assert_eq!(captured.kind, RiftObjectKind::Collection);
    assert_eq!(captured.entries().len(), 3);
    assert!(matches!(
        captured.negotiate(ReceiverCapabilities::V1),
        Err(CaptureError::UnsupportedRepresentation)
    ));
    let wire = serde_json::to_string(captured.entries()[1].manifest()).unwrap();
    assert!(!wire.contains(&root.path().to_string_lossy().to_string()));
    assert!(!wire.contains("added.txt"));
}
#[test]
fn verified_stream_checks_frozen_bytes_and_reports_source_change() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let mut out = file.reopen().unwrap();
    out.write_all(b"abcd").unwrap();
    let captured = freeze(
        CaptureContext {
            explicit_selection: vec![Candidate::path(file.path().into())],
            ..Default::default()
        },
        CaptureLimits::default(),
    )
    .unwrap();
    let entry = &captured.entries()[0];
    let mut before = String::new();
    entry
        .open_verified()
        .unwrap()
        .read_to_string(&mut before)
        .unwrap();
    assert_eq!(before, "abcd");
    std::fs::write(file.path(), "zzzz").unwrap();
    let result = entry.open_verified().and_then(|mut r| {
        r.read_to_end(&mut Vec::new())
            .map(|_| ())
            .map_err(|_| CaptureError::SourceChanged)
    });
    assert!(matches!(result, Err(CaptureError::SourceChanged)));
}
#[test]
fn blocked_or_locked_runtime_does_not_resolve_but_window_close_is_not_a_suspend() {
    let mut policy = AmbientPolicy::default();
    assert_eq!(policy.camera_mode(), CameraMode::Suspended);
    policy.enabled = true;
    policy.window_open = false;
    policy.session = SessionActivity::Unlocked;
    assert_eq!(policy.camera_mode(), CameraMode::Normal);
    policy.battery_saver = true;
    assert_eq!(policy.camera_mode(), CameraMode::Reduced);
    policy.excluded_app = true;
    assert!(!policy.may_capture());
    policy.excluded_app = false;
    policy.session = SessionActivity::Locked;
    assert!(!policy.may_capture());
    policy.session = SessionActivity::Unknown;
    assert_eq!(policy.camera_mode(), CameraMode::Suspended);
}

#[test]
fn guarded_capture_aborts_when_policy_changes_during_hashing() {
    let file = tempfile::NamedTempFile::new().unwrap();
    file.as_file().set_len(131072).unwrap();
    let calls = std::cell::Cell::new(0);
    let captured = freeze_guarded(
        CaptureContext {
            explicit_selection: vec![Candidate::path(file.path().into())],
            ..Default::default()
        },
        CaptureLimits::default(),
        || {
            let previous = calls.get();
            calls.set(previous + 1);
            previous < 3
        },
    );
    assert!(matches!(captured, Err(CaptureError::Cancelled)));
}

#[test]
fn streaming_large_regular_file_without_a_second_copy() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let size = 16 * 1024 * 1024;
    file.as_file().set_len(size).unwrap();
    let capture = freeze(
        CaptureContext {
            explicit_selection: vec![Candidate::path(file.path().into())],
            ..Default::default()
        },
        CaptureLimits::default(),
    )
    .unwrap();
    assert_eq!(
        capture.negotiate(ReceiverCapabilities::V1),
        Ok(Representation::SingleRawFile)
    );
    let mut reader = capture.entries()[0].open_verified().unwrap();
    assert_eq!(
        std::io::copy(&mut reader, &mut std::io::sink()).unwrap(),
        size
    );
}

#[test]
fn sensitive_context_is_not_resolved_even_with_an_explicit_selection() {
    assert!(matches!(
        freeze(
            CaptureContext {
                sensitive: true,
                explicit_selection: vec![candidate(RiftObjectKind::PlainText, "private")],
                ..Default::default()
            },
            CaptureLimits::default()
        ),
        Err(CaptureError::SensitiveContext)
    ));
}

#[cfg(unix)]
#[test]
fn symlink_selection_and_directories_with_symlink_entries_are_refused() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let file = tempfile::NamedTempFile::new().unwrap();
    let linked = dir.path().join("untargeted.txt");
    symlink(file.path(), &linked).unwrap();
    for selection in [linked, dir.path().to_owned()] {
        assert!(matches!(
            freeze(
                CaptureContext {
                    explicit_selection: vec![Candidate::path(selection)],
                    ..Default::default()
                },
                CaptureLimits::default()
            ),
            Err(CaptureError::UnsupportedRepresentation)
        ));
    }
}
