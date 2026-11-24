use aerift_transfer::ambient_camera::{CameraIssue, RgbFrame};
use std::time::Instant;

#[test]
fn rgb32_top_down_bgrx_reorders_channels_and_removes_padding() {
    let pixels = [
        1, 2, 3, 255, 4, 5, 6, 0, 0, 0, 0, 0, 7, 8, 9, 255, 10, 11, 12, 0, 99, 99, 99, 99,
    ];
    let frame = RgbFrame::from_mf_rgb32(Instant::now(), 2, 2, 12, &pixels).unwrap();
    assert_eq!(frame.rgb(), &[3, 2, 1, 6, 5, 4, 9, 8, 7, 12, 11, 10]);
}

#[test]
fn rgb32_bottom_up_reverses_row_order_but_not_pixels_within_each_row() {
    let pixels = [1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0, 10, 11, 12, 0];
    let frame = RgbFrame::from_mf_rgb32(Instant::now(), 2, 2, -8, &pixels).unwrap();
    assert_eq!(frame.rgb(), &[9, 8, 7, 12, 11, 10, 3, 2, 1, 6, 5, 4]);
}

#[test]
fn unsafe_or_truncated_pixel_layout_fails_closed() {
    for (width, height, stride, length) in [
        (0, 1, 4, 4),
        (1921, 1, 7684, 4),
        (2, 2, 7, 16),
        (1, 2, i32::MIN, 1),
        (1, 2, 4, 7),
        (1, 2, 4, 9),
        (1920, 1920, 15360, 10),
    ] {
        assert!(matches!(
            RgbFrame::from_mf_rgb32(Instant::now(), width, height, stride, &vec![0; length]),
            Err(CameraIssue::InvalidFrame)
        ));
    }
}

#[test]
fn driver_ticks_do_not_queue_and_late_results_do_not_become_fresh_frames() {
    use aerift_transfer::ambient_camera::DriverReadGate;
    use std::time::Duration;
    let now = Instant::now();
    let mut gate = DriverReadGate::default();
    assert!(gate.begin(now));
    assert!(!gate.begin(now + Duration::from_millis(20)));
    assert!(!gate.stalled(now + Duration::from_millis(299)));
    assert!(gate.stalled(now + Duration::from_millis(300)));
    assert_eq!(gate.complete(now + Duration::from_millis(170)), None);
    let next = now + Duration::from_millis(200);
    assert!(gate.begin(next));
    assert_eq!(gate.complete(next + Duration::from_millis(10)), Some(next));
    assert_eq!(gate.complete(next + Duration::from_millis(11)), None);
}
