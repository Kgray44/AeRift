//! Process-owned Ambient recognition lifecycle. No windows, camera pixels, filesystem,
//! transfer destinations, or network permissions are part of this interface.

use crate::ambient::{AmbientPolicy, CameraMode};
use std::{
    sync::{Arc, Condvar, Mutex, MutexGuard},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

pub const CAPTURE_FRESHNESS: Duration = Duration::from_millis(150);
pub const SAMPLE_BUDGET: Duration = Duration::from_millis(40);
const STARTUP_BUDGET: Duration = Duration::from_millis(500);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Landmark {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub confidence: Option<f32>,
}

/// A normalized top-left image-coordinate result. There are deliberately no camera pixels.
#[derive(Clone, Copy, PartialEq)]
pub struct LandmarkFrame {
    pub captured: Instant,
    pub width: u16,
    pub height: u16,
    pub hand: Option<[Landmark; 21]>,
}
impl LandmarkFrame {
    fn is_valid(self, now: Instant, prior: Option<Instant>) -> bool {
        let age = now.checked_duration_since(self.captured);
        let newer = prior.is_none_or(|prior| self.captured > prior);
        age.is_some_and(|age| age <= CAPTURE_FRESHNESS)
            && newer
            && (1..=1920).contains(&self.width)
            && (1..=1920).contains(&self.height)
            && self.hand.is_none_or(|hand| {
                hand.iter().all(|point| {
                    (0.0..=1.0).contains(&point.x)
                        && (0.0..=1.0).contains(&point.y)
                        && point.z.is_finite()
                        && point
                            .confidence
                            .is_none_or(|score| (0.0..=1.0).contains(&score))
                })
            })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CameraIssue {
    PermissionDenied,
    DeviceBusy,
    DeviceUnavailable,
    ModelUnavailable,
    IndicatorUnavailable,
    InvalidFrame,
    WorkerPanicked,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CameraStatus {
    Suspended,
    Starting,
    Running(CameraMode),
    Unavailable(CameraIssue),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CameraCadence {
    pub sample_interval: Duration,
    pub target_width: u16,
    pub target_height: u16,
}
impl CameraCadence {
    fn for_mode(mode: CameraMode) -> Self {
        match mode {
            CameraMode::Normal => Self {
                sample_interval: Duration::from_millis(50),
                target_width: 640,
                target_height: 480,
            },
            CameraMode::Reduced | CameraMode::Suspended => Self {
                sample_interval: Duration::from_millis(110),
                target_width: 480,
                target_height: 360,
            },
        }
    }
}

/// Provider owns sensor and inference. It returns only normalized landmarks and must
/// end each poll by its budget. Dropping the lease must promptly stop capture.
pub trait LocalLandmarkSource {
    fn sample(&mut self, budget: Duration) -> Result<Option<LandmarkFrame>, CameraIssue>;
}

/// Factory API for a pinned local model and OS camera adapter. Instances are confined
/// to one worker. Preflight must not open the camera or fetch models. Acquisition
/// must not trigger permission UI and must return by its budget. Platforms unable
/// to meet either bound must return unavailable, not silently run in the background.
pub trait LocalCameraProvider: Send + 'static {
    type Lease: LocalLandmarkSource;
    type Indicator;
    fn preflight(&mut self) -> Result<(), CameraIssue>;
    /// The returned RAII guard must keep a user-visible Camera indicator active.
    fn indicate_camera_use(&mut self) -> Result<Self::Indicator, CameraIssue>;
    fn acquire(
        &mut self,
        cadence: CameraCadence,
        budget: Duration,
    ) -> Result<Self::Lease, CameraIssue>;
}

// Drop the device lease before the indicator: never imply the sensor is closed while
// the provider still holds it.
struct Running<L, I> {
    lease: L,
    _indicator: I,
    last_capture: Option<Instant>,
}

struct State {
    generation: u64,
    desired: CameraMode,
    status: CameraStatus,
    latest: Option<LandmarkFrame>,
    stop: bool,
}
impl Default for State {
    fn default() -> Self {
        Self {
            generation: 0,
            desired: CameraMode::Suspended,
            status: CameraStatus::Suspended,
            latest: None,
            stop: false,
        }
    }
}
#[derive(Default)]
struct Mailbox {
    state: Mutex<State>,
    changed: Condvar,
}
impl Mailbox {
    fn guard(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|err| err.into_inner())
    }
    fn mark(&self, generation: u64, status: CameraStatus) {
        let mut state = self.guard();
        if state.generation == generation && !state.stop {
            state.status = status;
        }
    }
    fn wait_for_update(&self, generation: u64, delay: Option<Duration>) {
        let state = self.guard();
        let unchanged = |state: &mut State| state.generation == generation && !state.stop;
        match delay {
            Some(time) => drop(self.changed.wait_timeout_while(state, time, unchanged)),
            None => drop(self.changed.wait_while(state, unchanged)),
        }
    }
}

/// One bounded, replaceable mailbox with no unbounded camera event queue.
pub struct CameraSupervisor {
    mailbox: Arc<Mailbox>,
    worker: Option<JoinHandle<()>>,
}
impl CameraSupervisor {
    pub fn spawn(provider: impl LocalCameraProvider) -> std::io::Result<Self> {
        let mailbox = Arc::new(Mailbox::default());
        let handle = Arc::clone(&mailbox);
        let worker = thread::Builder::new()
            .name("aerift-native-camera".into())
            .spawn(move || {
                run(handle, provider);
            })?;
        Ok(Self {
            mailbox,
            worker: Some(worker),
        })
    }

    /// The native user-consent path, not renderer visibility, supplies this grant.
    /// Unknown OS session status and missing permission are both fail-closed.
    pub fn configure(&self, policy: AmbientPolicy, permission_already_granted: bool) {
        let requested = if permission_already_granted {
            policy.camera_mode()
        } else {
            CameraMode::Suspended
        };
        let mut state = self.mailbox.guard();
        if !state.stop && state.desired != requested {
            state.desired = requested;
            state.latest = None;
            state.generation = state.generation.wrapping_add(1);
            self.mailbox.changed.notify_one();
        }
    }

    /// Explicit reattempt after a denied, unplugged, busy, or unavailable resource.
    pub fn retry(&self) {
        let mut state = self.mailbox.guard();
        if !state.stop
            && matches!(state.status, CameraStatus::Unavailable(_))
            && state.desired != CameraMode::Suspended
        {
            state.generation = state.generation.wrapping_add(1);
            self.mailbox.changed.notify_one();
        }
    }

    pub fn status(&self) -> CameraStatus {
        self.mailbox.guard().status
    }

    pub fn take_latest(&self) -> Option<LandmarkFrame> {
        let mut state = self.mailbox.guard();
        if state.stop
            || state.desired == CameraMode::Suspended
            || state.status != CameraStatus::Running(state.desired)
        {
            return None;
        }
        state
            .latest
            .take()
            .filter(|packet| packet.is_valid(Instant::now(), None))
    }

    pub fn shutdown(mut self) -> Result<(), CameraIssue> {
        self.join()
    }
    fn join(&mut self) -> Result<(), CameraIssue> {
        {
            let mut state = self.mailbox.guard();
            state.latest = None;
            state.stop = true;
            self.mailbox.changed.notify_one();
        }
        if let Some(worker) = self.worker.take() {
            worker.join().map_err(|_| CameraIssue::WorkerPanicked)?;
        }
        Ok(())
    }
}
impl Drop for CameraSupervisor {
    fn drop(&mut self) {
        let _ = self.join();
    }
}

fn acquire<P: LocalCameraProvider>(
    provider: &mut P,
    mode: CameraMode,
    still_current: impl Fn() -> bool,
) -> Result<Option<Running<P::Lease, P::Indicator>>, CameraIssue> {
    provider.preflight()?;
    if !still_current() {
        return Ok(None);
    }
    let indicator = provider.indicate_camera_use()?;
    if !still_current() {
        return Ok(None);
    }
    let lease = provider.acquire(CameraCadence::for_mode(mode), STARTUP_BUDGET)?;
    if !still_current() {
        drop(lease);
        return Ok(None);
    }
    Ok(Some(Running {
        lease,
        _indicator: indicator,
        last_capture: None,
    }))
}

fn run<P: LocalCameraProvider>(mailbox: Arc<Mailbox>, mut provider: P) {
    let mut generation = None;
    let mut active = None;
    loop {
        let (revision, desired, stop) = {
            let state = mailbox.guard();
            (state.generation, state.desired, state.stop)
        };
        if stop {
            break;
        }
        if generation != Some(revision) {
            drop(active.take()); // release the previous exclusive lease before any new open
            generation = Some(revision);
            if desired == CameraMode::Suspended {
                mailbox.mark(revision, CameraStatus::Suspended);
            } else {
                mailbox.mark(revision, CameraStatus::Starting);
                let still_current = || {
                    let state = mailbox.guard();
                    state.generation == revision && !state.stop
                };
                match acquire(&mut provider, desired, still_current) {
                    Ok(Some(lease)) => {
                        active = Some(lease);
                        mailbox.mark(revision, CameraStatus::Running(desired));
                    }
                    Ok(None) => continue,
                    Err(issue) => mailbox.mark(revision, CameraStatus::Unavailable(issue)),
                }
            }
        }
        let Some(active_lease) = active.as_mut() else {
            mailbox.wait_for_update(revision, None);
            continue;
        };
        let started = Instant::now();
        let packet = active_lease.lease.sample(SAMPLE_BUDGET).and_then(|packet| {
            if packet
                .is_some_and(|frame| !frame.is_valid(Instant::now(), active_lease.last_capture))
            {
                Err(CameraIssue::InvalidFrame)
            } else {
                Ok(packet)
            }
        });
        match packet {
            Ok(packet) => {
                if let Some(frame) = packet {
                    active_lease.last_capture = Some(frame.captured);
                }
                let mut state = mailbox.guard();
                if state.generation == revision && !state.stop {
                    // Latest wins; no queue of historical landmarks survives a pause.
                    state.latest = packet;
                }
            }
            Err(issue) => {
                drop(active.take());
                let mut state = mailbox.guard();
                if state.generation == revision && !state.stop {
                    state.latest = None;
                    state.status = CameraStatus::Unavailable(issue);
                }
            }
        }
        let interval = CameraCadence::for_mode(desired).sample_interval;
        mailbox.wait_for_update(revision, Some(interval.saturating_sub(started.elapsed())));
    }
    drop(active);
}
