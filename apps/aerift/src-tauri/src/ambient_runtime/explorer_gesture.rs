//! Local, qualification-only Ambient Explorer pickup recognition.
//! Ported geometry/timing from packages/gestures/src/{landmarks,intent}.ts.
//! Private native callers only. Never offer a transfer or grant destination access.

use aerift_transfer::ambient_camera::{CAPTURE_FRESHNESS, Landmark, LandmarkFrame};
use std::time::{Duration, Instant};

const MAX_GAP: Duration = Duration::from_millis(220);
const OPEN_DWELL: Duration = Duration::from_millis(200);
const FIST_DWELL: Duration = Duration::from_millis(130);
const ARMED_WINDOW: Duration = Duration::from_secs(3);
const MIN_SAMPLES: u8 = 3;

/// A snapshot from the trusted native host, never IPC. All three identity
/// fields must describe one uninterrupted opt-in, permission, visible camera
/// indicator, live lease, unlocked session and eligible Explorer epoch. Loss
/// is None; bump the epoch and clear the mailbox before replacing a lease.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct ExplorerCameraContext<A> {
    pub(super) anchor: A,
    pub(super) epoch: u64,
    pub(super) active_since: Instant,
}

/// A single-use, foreground- and lease-bound capture permit. No send authority.
pub(super) struct ExplorerPickup<A> {
    context: ExplorerCameraContext<A>,
    captured: Instant,
}

impl<A: Copy + Eq> ExplorerPickup<A> {
    /// Check at capture admission (inside the owning runtime's coordination
    /// lock), then use the returned exact anchor, never sample a replacement.
    pub(super) fn claim(
        self,
        current: Option<ExplorerCameraContext<A>>,
        now: Instant,
    ) -> Option<A> {
        if current != Some(self.context) || !fresh(self.captured, now) {
            return None;
        }
        Some(self.context.anchor)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Posture {
    Open,
    Fist,
    Neutral,
}

#[derive(Clone, Copy)]
struct Palm {
    center_x: f64,
    center_y: f64,
    scale: f64,
    width: u16,
    height: u16,
    captured: Instant,
}

impl Palm {
    fn continuous(self, prior: Self) -> bool {
        let aspect = f64::from(self.width) / f64::from(self.height);
        self.width == prior.width
            && self.height == prior.height
            && self.captured > prior.captured
            && self.captured.duration_since(prior.captured) <= MAX_GAP
            && (self.center_x - prior.center_x)
                .hypot((self.center_y - prior.center_y) / aspect)
                + 0.25 * (self.scale - prior.scale).abs()
                <= 0.14
    }
}

#[derive(Clone, Copy)]
struct Dwell {
    posture: Posture,
    since: Instant,
    samples: u8,
}

pub(super) struct ExplorerGesture<A> {
    context: Option<ExplorerCameraContext<A>>,
    prior: Option<Palm>,
    watermark: Option<Instant>,
    dwell: Option<Dwell>,
    armed_until: Option<Instant>,
}

impl<A: Copy + Eq> Default for ExplorerGesture<A> {
    fn default() -> Self {
        Self {
            context: None,
            prior: None,
            watermark: None,
            dwell: None,
            armed_until: None,
        }
    }
}

impl<A: Copy + Eq> ExplorerGesture<A> {
    fn reset_attempt(&mut self) {
        self.prior = None;
        self.dwell = None;
        self.armed_until = None;
    }

    /// Consume the current replaceable mailbox entry at most once. A first
    /// fist, a lone pose, a stale sample, or a reacquired hand cannot pick up.
    pub(super) fn observe(
        &mut self,
        authority: Option<ExplorerCameraContext<A>>,
        newest: Option<LandmarkFrame>,
        now: Instant,
    ) -> Option<ExplorerPickup<A>> {
        if authority != self.context {
            self.reset_attempt();
            self.context = authority;
            self.watermark = None;
        }
        let context = authority?;
        if self
            .prior
            .is_some_and(|prior| now.saturating_duration_since(prior.captured) > MAX_GAP)
            || self.armed_until.is_some_and(|deadline| now >= deadline)
        {
            self.reset_attempt();
        }
        let frame = newest?;
        let at = frame.captured;
        if !fresh(at, now)
            || at < context.active_since
            || self.watermark.is_some_and(|prior| at <= prior)
        {
            self.reset_attempt();
            return None;
        }
        self.watermark = Some(at);
        let Some((palm, posture)) = classify(frame) else {
            self.reset_attempt();
            return None;
        };
        if !self.prior.is_some_and(|prior| palm.continuous(prior)) {
            self.reset_attempt();
        }
        self.prior = Some(palm);
        if posture == Posture::Neutral {
            self.dwell = None;
            return None;
        }
        let dwell = self.dwell.get_or_insert(Dwell {
            posture,
            since: at,
            samples: 0,
        });
        if dwell.posture != posture {
            *dwell = Dwell {
                posture,
                since: at,
                samples: 0,
            };
        }
        dwell.samples = dwell.samples.saturating_add(1);
        if dwell.samples < MIN_SAMPLES {
            return None;
        }
        let elapsed = at.duration_since(dwell.since);
        if self.armed_until.is_none() && posture == Posture::Open && elapsed >= OPEN_DWELL {
            self.armed_until = now.checked_add(ARMED_WINDOW);
        } else if self.armed_until.is_some() && posture == Posture::Fist && elapsed >= FIST_DWELL {
            // One pickup per deliberate open-to-fist attempt. No send/release.
            self.reset_attempt();
            return Some(ExplorerPickup { context, captured: at });
        }
        None
    }
}

fn fresh(captured: Instant, now: Instant) -> bool {
    now.checked_duration_since(captured)
        .is_some_and(|age| age <= CAPTURE_FRESHNESS)
}

fn classify(frame: LandmarkFrame) -> Option<(Palm, Posture)> {
    let points = frame.hand?;
    if !(1..=1920).contains(&frame.width)
        || !(1..=1920).contains(&frame.height)
        || points.iter().any(|p| {
            !(0.0..=1.0).contains(&p.x)
                || !(0.0..=1.0).contains(&p.y)
                || !p.z.is_finite()
                || p.confidence.is_some_and(|score| !(0.6..=1.0).contains(&score))
        })
    {
        return None;
    }
    let aspect = f64::from(frame.width) / f64::from(frame.height);
    let distance = |a: Landmark, b: Landmark| {
        let x = f64::from(a.x) - f64::from(b.x);
        let y = (f64::from(a.y) - f64::from(b.y)) / aspect;
        let z = f64::from(a.z) - f64::from(b.z);
        x.hypot(y).hypot(z)
    };
    let wrist = points[0];
    let pinky = points[17];
    let index = points[5];
    let middle = points[9];
    let palm = Palm {
        center_x: [wrist, pinky, index, middle]
            .into_iter()
            .map(|p| f64::from(p.x) / 4.0)
            .sum(),
        center_y: [wrist, pinky, index, middle]
            .into_iter()
            .map(|p| f64::from(p.y) / 4.0)
            .sum(),
        scale: (f64::from(index.x) - f64::from(pinky.x))
            .hypot((f64::from(index.y) - f64::from(pinky.y)) / aspect),
        width: frame.width,
        height: frame.height,
        captured: frame.captured,
    };
    let size = distance(index, pinky).max(0.8 * distance(wrist, middle));
    if !(0.035..=0.65).contains(&size) {
        return Some((palm, Posture::Neutral));
    }
    let mut extended = 0;
    let mut curled = 0;
    for base in [5, 9, 13, 17] {
        let [a, b, c, tip] = [
            points[base],
            points[base + 1],
            points[base + 2],
            points[base + 3],
        ];
        let length = distance(a, b) + distance(b, c) + distance(c, tip);
        if length > size * 0.35 {
            let reach = distance(a, tip);
            let extension = reach / length;
            if extension >= 0.83 && reach >= size * 0.48 {
                extended += 1;
            }
            if extension <= 0.72 && reach <= size * 0.72 {
                curled += 1;
            }
        }
    }
    let posture = if extended >= 3 && curled == 0 && distance(points[4], points[8]) >= size * 0.48 {
        Posture::Open
    } else if curled >= 3 && extended == 0 {
        Posture::Fist
    } else {
        Posture::Neutral
    };
    Some((palm, posture))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(value: u64) -> Duration {
        Duration::from_millis(value)
    }

    fn context(start: Instant) -> ExplorerCameraContext<u32> {
        ExplorerCameraContext {
            anchor: 7,
            epoch: 1,
            active_since: start,
        }
    }

    fn hand(at: Instant, posture: Posture) -> LandmarkFrame {
        let point = |x, y| Landmark {
            x,
            y,
            z: 0.0,
            confidence: None,
        };
        let mut points = [point(0.47, 0.7); 21];
        points[4] = point(0.31, 0.48);
        for (index, base) in [5, 9, 13, 17].into_iter().enumerate() {
            let x = 0.40 + index as f32 * 0.05;
            points[base] = point(x, 0.50);
            points[base + 1] = point(x, 0.39);
            points[base + 2] = point(x, 0.28);
            points[base + 3] = match posture {
                Posture::Open => point(x, 0.17),
                Posture::Fist => point(x, 0.46),
                Posture::Neutral => point(x, 0.35),
            };
        }
        LandmarkFrame {
            captured: at,
            width: 640,
            height: 480,
            hand: Some(points),
        }
    }

    fn sample(
        gesture: &mut ExplorerGesture<u32>,
        ctx: Option<ExplorerCameraContext<u32>>,
        at: Instant,
        posture: Posture,
    ) -> Option<ExplorerPickup<u32>> {
        gesture.observe(ctx, Some(hand(at, posture)), at)
    }

    fn open(
        gesture: &mut ExplorerGesture<u32>,
        ctx: Option<ExplorerCameraContext<u32>>,
        start: Instant,
    ) {
        for dt in [0, 100, 200] {
            assert!(sample(gesture, ctx, start + ms(dt), Posture::Open).is_none());
        }
    }

    fn fist(
        gesture: &mut ExplorerGesture<u32>,
        ctx: Option<ExplorerCameraContext<u32>>,
        start: Instant,
    ) -> Option<ExplorerPickup<u32>> {
        assert!(sample(gesture, ctx, start, Posture::Fist).is_none());
        assert!(sample(gesture, ctx, start + ms(70), Posture::Fist).is_none());
        sample(gesture, ctx, start + ms(140), Posture::Fist)
    }

    #[test]
    fn open_then_fist_claims_exactly_once_and_requires_new_open_dwell() {
        let start = Instant::now();
        let ctx = Some(context(start));
        let mut gesture = ExplorerGesture::default();
        assert!(fist(&mut gesture, ctx, start).is_none());
        open(&mut gesture, ctx, start + ms(180));
        let permit_at = start + ms(570);
        let pickup = fist(&mut gesture, ctx, start + ms(430)).expect("fresh deliberate hold");
        assert_eq!(pickup.claim(ctx, permit_at), Some(7));
        assert!(fist(&mut gesture, ctx, permit_at + ms(80)).is_none());
        open(&mut gesture, ctx, permit_at + ms(280));
        assert!(fist(&mut gesture, ctx, permit_at + ms(530)).is_some());
    }

    #[test]
    fn camera_revocation_before_pickup_or_before_dispatch_cannot_capture() {
        let start = Instant::now();
        let ctx = Some(context(start));
        let mut gesture = ExplorerGesture::default();
        open(&mut gesture, ctx, start);
        assert!(gesture.observe(None, None, start + ms(230)).is_none());
        let replacement = Some(ExplorerCameraContext {
            epoch: 2,
            active_since: start + ms(250),
            ..context(start)
        });
        assert!(fist(&mut gesture, replacement, start + ms(250)).is_none());
        open(&mut gesture, replacement, start + ms(450));
        let pickup = fist(&mut gesture, replacement, start + ms(700)).unwrap();
        assert_eq!(pickup.claim(None, start + ms(850)), None);
    }

    #[test]
    fn changed_anchor_cannot_supply_a_replacement_selection() {
        let start = Instant::now();
        let ctx = Some(context(start));
        let changed = Some(ExplorerCameraContext {
            anchor: 8,
            ..context(start)
        });
        let mut gesture = ExplorerGesture::default();
        open(&mut gesture, ctx, start);
        assert!(fist(&mut gesture, changed, start + ms(250)).is_none());
        open(&mut gesture, ctx, start + ms(500));
        let permit = fist(&mut gesture, ctx, start + ms(750)).unwrap();
        assert_eq!(permit.claim(changed, start + ms(900)), None);
    }

    #[test]
    fn hand_loss_duplicate_stale_gap_and_tracking_jump_clear_armed_attempt() {
        for fault in 0..6 {
            let start = Instant::now();
            let ctx = Some(context(start));
            let mut gesture = ExplorerGesture::default();
            open(&mut gesture, ctx, start);
            let at = start + ms(250);
            let mut now = at;
            let mut bad = hand(at, Posture::Fist);
            match fault {
                0 => bad.hand = None,
                1 => bad.captured = start + ms(200),
                2 => now += ms(151),
                3 => {
                    now += ms(221);
                    bad.captured = now;
                }
                4 => bad
                    .hand
                    .as_mut()
                    .unwrap()
                    .iter_mut()
                    .for_each(|p| p.x += 0.23),
                5 => bad.hand.as_mut().unwrap()[8].confidence = Some(0.3),
                _ => unreachable!(),
            }
            assert!(gesture.observe(ctx, Some(bad), now).is_none());
            assert!(fist(&mut gesture, ctx, now + ms(50)).is_none());
        }
    }

    #[test]
    fn reduced_camera_cadence_works_but_does_not_extend_the_armed_window() {
        let start = Instant::now();
        let ctx = Some(context(start));
        let mut gesture = ExplorerGesture::default();
        for dt in [0, 110, 220] {
            assert!(sample(&mut gesture, ctx, start + ms(dt), Posture::Open).is_none());
        }
        for dt in [330, 440] {
            assert!(sample(&mut gesture, ctx, start + ms(dt), Posture::Fist).is_none());
        }
        assert!(sample(&mut gesture, ctx, start + ms(550), Posture::Fist).is_some());

        let start = start + ms(1_000);
        open(&mut gesture, ctx, start);
        for dt in (300..=3_400).step_by(100) {
            assert!(sample(&mut gesture, ctx, start + ms(dt), Posture::Neutral).is_none());
        }
        assert!(fist(&mut gesture, ctx, start + ms(3_500)).is_none());
    }

    #[test]
    fn expired_future_and_predating_camera_context_are_rejected() {
        let start = Instant::now();
        let ctx = Some(context(start));
        let mut gesture = ExplorerGesture::default();
        let renewed = Some(ExplorerCameraContext {
            active_since: start + ms(40),
            ..context(start)
        });
        assert!(
            gesture
                .observe(renewed, Some(hand(start, Posture::Open)), start + ms(50))
                .is_none()
        );
        assert!(
            gesture
                .observe(ctx, Some(hand(start + ms(100), Posture::Open)), start)
                .is_none()
        );
        open(&mut gesture, ctx, start + ms(200));
        let permit = fist(&mut gesture, ctx, start + ms(450)).unwrap();
        assert_eq!(permit.claim(ctx, start + ms(741)), None);
    }
}
