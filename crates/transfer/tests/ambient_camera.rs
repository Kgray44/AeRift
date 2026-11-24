use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use aerift_transfer::ambient::{AmbientPolicy, CameraMode, SessionActivity};
use aerift_transfer::ambient_camera::*;

#[derive(Default)]
struct Evidence {
    order: Vec<&'static str>,
    cadences: Vec<CameraCadence>,
}
struct Fixture {
    proof: Arc<Mutex<Evidence>>,
    ready: bool,
    indicator_fails: bool,
    invalid_frame: bool,
}
struct Indication(Arc<Mutex<Evidence>>);
impl Drop for Indication {
    fn drop(&mut self) {
        self.0.lock().unwrap().order.push("indicator off");
    }
}
struct CameraLease(Arc<Mutex<Evidence>>, bool);
impl Drop for CameraLease {
    fn drop(&mut self) {
        self.0.lock().unwrap().order.push("camera released");
    }
}
impl LocalLandmarkSource for CameraLease {
    fn sample(&mut self, _: Duration) -> Result<Option<LandmarkFrame>, CameraIssue> {
        Ok(Some(LandmarkFrame {
            captured: Instant::now(),
            width: if self.1 { 0 } else { 640 },
            height: 480,
            hand: None,
        }))
    }
}
impl LocalCameraProvider for Fixture {
    type Lease = CameraLease;
    type Indicator = Indication;
    fn preflight(&mut self) -> Result<(), CameraIssue> {
        if self.ready {
            Ok(())
        } else {
            Err(CameraIssue::ModelUnavailable)
        }
    }
    fn indicate_camera_use(&mut self) -> Result<Self::Indicator, CameraIssue> {
        if self.indicator_fails {
            return Err(CameraIssue::IndicatorUnavailable);
        }
        self.proof.lock().unwrap().order.push("indicator on");
        Ok(Indication(Arc::clone(&self.proof)))
    }
    fn acquire(&mut self, cadence: CameraCadence, _: Duration) -> Result<Self::Lease, CameraIssue> {
        let mut evidence = self.proof.lock().unwrap();
        evidence.cadences.push(cadence);
        evidence.order.push("camera acquired");
        Ok(CameraLease(Arc::clone(&self.proof), self.invalid_frame))
    }
}
fn unlocked() -> AmbientPolicy {
    AmbientPolicy {
        enabled: true,
        session: SessionActivity::Unlocked,
        window_open: false,
        ..Default::default()
    }
}
fn expect_status(runtime: &CameraSupervisor, status: CameraStatus) {
    let until = Instant::now() + Duration::from_secs(2);
    while runtime.status() != status {
        assert!(
            Instant::now() < until,
            "actual {:?}, expected {:?}",
            runtime.status(),
            status
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}
#[test]
fn process_owned_lease_runs_with_closed_window_and_releases_on_lock() {
    let evidence = Arc::new(Mutex::new(Evidence::default()));
    let worker = CameraSupervisor::spawn(Fixture {
        proof: evidence.clone(),
        ready: true,
        indicator_fails: false,
        invalid_frame: false,
    })
    .unwrap();
    worker.configure(unlocked(), false);
    expect_status(&worker, CameraStatus::Suspended);
    assert!(evidence.lock().unwrap().order.is_empty());
    worker.configure(unlocked(), true);
    expect_status(&worker, CameraStatus::Running(CameraMode::Normal));
    let mut locked = unlocked();
    locked.session = SessionActivity::Locked;
    worker.configure(locked, true);
    assert!(worker.take_latest().is_none());
    expect_status(&worker, CameraStatus::Suspended);
    let mut reduced = unlocked();
    reduced.battery_saver = true;
    worker.configure(reduced, true);
    expect_status(&worker, CameraStatus::Running(CameraMode::Reduced));
    worker.shutdown().unwrap();
    let evidence = evidence.lock().unwrap();
    assert_eq!(
        evidence.order,
        [
            "indicator on",
            "camera acquired",
            "camera released",
            "indicator off",
            "indicator on",
            "camera acquired",
            "camera released",
            "indicator off",
        ]
    );
    assert!(evidence.cadences[0].sample_interval < evidence.cadences[1].sample_interval);
}
#[test]
fn provider_or_indicator_unavailable_never_opens_sensor() {
    for (ready, indicator_fails, error) in [
        (false, false, CameraIssue::ModelUnavailable),
        (true, true, CameraIssue::IndicatorUnavailable),
    ] {
        let evidence = Arc::new(Mutex::new(Evidence::default()));
        let worker = CameraSupervisor::spawn(Fixture {
            proof: evidence.clone(),
            ready,
            indicator_fails,
            invalid_frame: false,
        })
        .unwrap();
        worker.configure(unlocked(), true);
        expect_status(&worker, CameraStatus::Unavailable(error));
        assert!(evidence.lock().unwrap().order.is_empty());
        worker.shutdown().unwrap();
    }
}
#[test]
fn exclusions_cancel_in_flight_observations_and_bad_frames_are_not_published() {
    let evidence = Arc::new(Mutex::new(Evidence::default()));
    let worker = CameraSupervisor::spawn(Fixture {
        proof: evidence,
        ready: true,
        indicator_fails: false,
        invalid_frame: true,
    })
    .unwrap();
    worker.configure(unlocked(), true);
    expect_status(
        &worker,
        CameraStatus::Unavailable(CameraIssue::InvalidFrame),
    );
    assert!(worker.take_latest().is_none());
    let excluded = AmbientPolicy {
        excluded_app: true,
        ..unlocked()
    };
    worker.configure(excluded, true);
    expect_status(&worker, CameraStatus::Suspended);
    assert!(worker.take_latest().is_none());
    worker.shutdown().unwrap();
}

struct SlowProvider {
    entered: std::sync::mpsc::SyncSender<()>,
    proceed: std::sync::mpsc::Receiver<()>,
}
struct InFlight {
    entered: std::sync::mpsc::SyncSender<()>,
    proceed: std::sync::mpsc::Receiver<()>,
}
impl LocalLandmarkSource for InFlight {
    fn sample(&mut self, budget: Duration) -> Result<Option<LandmarkFrame>, CameraIssue> {
        let _ = self.entered.try_send(());
        self.proceed
            .recv_timeout(budget)
            .map_err(|_| CameraIssue::DeviceUnavailable)?;
        Ok(Some(LandmarkFrame {
            captured: Instant::now(),
            width: 480,
            height: 360,
            hand: None,
        }))
    }
}
impl LocalCameraProvider for SlowProvider {
    type Lease = InFlight;
    type Indicator = ();
    fn preflight(&mut self) -> Result<(), CameraIssue> {
        Ok(())
    }
    fn indicate_camera_use(&mut self) -> Result<(), CameraIssue> {
        Ok(())
    }
    fn acquire(&mut self, _: CameraCadence, _: Duration) -> Result<Self::Lease, CameraIssue> {
        let (_inert_sender, inert_receiver) = std::sync::mpsc::channel();
        Ok(InFlight {
            entered: self.entered.clone(),
            proceed: std::mem::replace(&mut self.proceed, inert_receiver),
        })
    }
}
#[test]
fn inflight_sample_is_discarded_when_pause_changes_generation() {
    let (entered, observing) = std::sync::mpsc::sync_channel(1);
    let (release, proceed) = std::sync::mpsc::channel();
    let runtime = CameraSupervisor::spawn(SlowProvider { entered, proceed }).unwrap();
    runtime.configure(unlocked(), true);
    observing.recv_timeout(Duration::from_secs(2)).unwrap();
    runtime.configure(
        AmbientPolicy {
            paused: true,
            ..unlocked()
        },
        true,
    );
    let _ = release.send(());
    expect_status(&runtime, CameraStatus::Suspended);
    assert!(runtime.take_latest().is_none());
    runtime.shutdown().unwrap();
}
