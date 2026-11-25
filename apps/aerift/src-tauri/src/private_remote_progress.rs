//! Rate limit for per-operation Remote progress; no transfer authority.
use std::time::{Duration, Instant};

const INTERVAL: Duration = Duration::from_millis(250);
const MAX_FRAMES: u16 = 7_200;

#[derive(Default)]
pub(super) struct ProgressWindow {
    last: Option<(Instant, u64)>,
    emitted: u16,
}

impl ProgressWindow {
    pub(super) fn permit(&mut self, now: Instant, bytes: u64, total: u64) -> bool {
        if bytes == 0 || bytes > total || self.emitted >= MAX_FRAMES {
            return false;
        }
        if self.last.is_some_and(|(at, previous)| {
            bytes <= previous || now.saturating_duration_since(at) < INTERVAL
        }) {
            return false;
        }
        self.last = Some((now, bytes));
        self.emitted += 1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_actual_positive_checkpoints_and_drops_duplicates() {
        let now = Instant::now();
        let mut window = ProgressWindow::default();
        assert!(!window.permit(now, 0, 500));
        assert!(!window.permit(now, 501, 500));
        assert!(window.permit(now, 100, 500));
        assert!(!window.permit(now + INTERVAL, 100, 500));
        assert!(!window.permit(now + INTERVAL, 99, 500));
        assert!(!window.permit(now + Duration::from_millis(249), 200, 500));
        assert!(window.permit(now + INTERVAL, 300, 500));
        assert!(window.permit(now + INTERVAL * 2, 500, 500));
    }

    #[test]
    fn a_run_has_a_hard_publication_budget() {
        let now = Instant::now();
        let mut window = ProgressWindow::default();
        for frame in 0..MAX_FRAMES {
            assert!(window.permit(
                now + INTERVAL * u32::from(frame),
                u64::from(frame) + 1,
                10_000
            ));
        }
        assert!(!window.permit(now + INTERVAL * u32::from(MAX_FRAMES), 9_000, 10_000));
    }
}
