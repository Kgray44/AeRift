//! Feature-gated Windows x64 qualification provider for the pinned MediaPipe C ABI.
//! Not registered by AeRift; the isolated headless probe compiles the same code.

use aerift_transfer::ambient_camera::{CameraIssue, Landmark, RgbFrame, RgbLandmarker};
use sha2::{Digest, Sha256};
use std::{
    ffi::{c_char, c_int, c_void},
    fs::{self, File, OpenOptions},
    io::Read,
    num::NonZeroUsize,
    os::windows::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    ptr::{null, null_mut},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{FreeLibrary, HMODULE},
    System::LibraryLoader::{GetProcAddress, LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExW},
};

const DLL_SHA: &str = "6dbb21a391cf79bead3d82efb00d02b3638435340c950545042b83194a5b87e7";
const MODEL_SHA: &str = "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1";
const MAX_MODEL: usize = 8 * 1024 * 1024;
const MAX_DLL: usize = 29 * 1024 * 1024;

#[repr(C)]
struct BaseOptions {
    asset: *const u8,
    asset_count: u32,
    asset_path: *const c_char,
    delegate: c_int,
}
#[repr(C)]
struct HandOptions {
    base: BaseOptions,
    mode: c_int,
    num_hands: c_int,
    detection: f32,
    presence: f32,
    tracking: f32,
    callback: *mut c_void,
}
#[repr(C)]
struct Point {
    x: f32,
    y: f32,
    z: f32,
    has_visibility: u8,
    visibility: f32,
    has_presence: u8,
    presence: f32,
    name: *const c_char,
}
#[repr(C)]
struct Points {
    points: *const Point,
    count: u32,
}
#[repr(C)]
#[derive(Default)]
struct Detection {
    handedness: *const c_void,
    handedness_count: u32,
    hands: *const Points,
    hands_count: u32,
    world: *const c_void,
    world_count: u32,
}

type ErrorOutput = *mut *mut c_char;
type Create = unsafe extern "C" fn(*mut HandOptions, *mut *mut c_void, ErrorOutput) -> c_int;
type Close = unsafe extern "C" fn(*mut c_void, ErrorOutput) -> c_int;
type Detect = unsafe extern "C" fn(
    *mut c_void,
    *mut c_void,
    *const c_void,
    i64,
    *mut Detection,
    ErrorOutput,
) -> c_int;
type ReleaseDetection = unsafe extern "C" fn(*mut Detection);
type CreateImage = unsafe extern "C" fn(
    c_int,
    c_int,
    c_int,
    *const u8,
    c_int,
    *mut *mut c_void,
    ErrorOutput,
) -> c_int;
type ReleaseImage = unsafe extern "C" fn(*mut c_void);

fn pinned_file(path: &Path, limit: usize, digest: &str) -> Result<(File, Vec<u8>), CameraIssue> {
    // Windows detects reparse points as part of the filesystem object. Do not
    // follow links in a qualification bundle. File-share permits reading only.
    for item in path.ancestors() {
        if fs::symlink_metadata(item)
            .map_err(|_| CameraIssue::ModelUnavailable)?
            .file_attributes()
            & 0x400
            != 0
        {
            return Err(CameraIssue::ModelUnavailable);
        }
    }
    let mut file = OpenOptions::new()
        .read(true)
        .share_mode(1)
        .custom_flags(0x0020_0000)
        .open(path)
        .map_err(|_| CameraIssue::ModelUnavailable)?;
    let metadata = file.metadata().map_err(|_| CameraIssue::ModelUnavailable)?;
    if !metadata.is_file()
        || metadata.file_attributes() & 0x400 != 0
        || metadata.len() > limit as u64
    {
        return Err(CameraIssue::ModelUnavailable);
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| CameraIssue::ModelUnavailable)?;
    if bytes.len() > limit || format!("{:x}", Sha256::digest(&bytes)) != digest {
        return Err(CameraIssue::ModelUnavailable);
    }
    Ok((file, bytes))
}

struct Module {
    handle: NonZeroUsize,
    // Keep the authenticated file read-locked against replacement throughout
    // the qualification lease. Future app wiring must use a trusted staged root.
    _locked_binary: File,
}
impl Module {
    fn open(root: &Path) -> Result<Self, CameraIssue> {
        if !root.is_absolute() {
            return Err(CameraIssue::ModelUnavailable);
        }
        let path = root.join("libmediapipe.dll");
        let (locked, bytes) = pinned_file(&path, MAX_DLL, DLL_SHA)?;
        drop(bytes);
        let mut nul_path: Vec<_> = path.as_os_str().encode_wide().collect();
        if nul_path.contains(&0) {
            return Err(CameraIssue::ModelUnavailable);
        }
        nul_path.push(0);
        // Absolute measured DLL; dependencies resolved only from System32.
        let handle =
            unsafe { LoadLibraryExW(nul_path.as_ptr(), null_mut(), LOAD_LIBRARY_SEARCH_SYSTEM32) };
        Ok(Self {
            handle: NonZeroUsize::new(handle as usize).ok_or(CameraIssue::ModelUnavailable)?,
            _locked_binary: locked,
        })
    }

    fn as_raw(&self) -> HMODULE {
        self.handle.get() as HMODULE
    }
}
impl Drop for Module {
    fn drop(&mut self) {
        let _ = unsafe { FreeLibrary(self.as_raw()) };
    }
}

struct Api {
    _module: Module,
    create: Create,
    close: Close,
    detect: Detect,
    release_detection: ReleaseDetection,
    create_image: CreateImage,
    release_image: ReleaseImage,
}
impl Api {
    fn open(root: &Path) -> Result<Self, CameraIssue> {
        let module = Module::open(root)?;
        // The module bytes are checked against the precise version whose headers
        // define these signature/layouts; no caller-provided library or ABI.
        macro_rules! symbol {
            ($name:expr, $function:ty) => {{
                let native =
                    unsafe { GetProcAddress(module.as_raw(), concat!($name, "\0").as_ptr()) }
                        .ok_or(CameraIssue::ModelUnavailable)?;
                unsafe {
                    std::mem::transmute::<unsafe extern "system" fn() -> isize, $function>(native)
                }
            }};
        }
        Ok(Self {
            create: symbol!("MpHandLandmarkerCreate", Create),
            close: symbol!("MpHandLandmarkerClose", Close),
            detect: symbol!("MpHandLandmarkerDetectForVideo", Detect),
            release_detection: symbol!("MpHandLandmarkerCloseResult", ReleaseDetection),
            create_image: symbol!("MpImageCreateFromUint8Data", CreateImage),
            release_image: symbol!("MpImageFree", ReleaseImage),
            _module: module,
        })
    }
}

struct Task {
    handle: NonZeroUsize,
    api: Api,
    _model: Vec<u8>,
    clock: Instant,
    last_ms: Option<i64>,
}
impl Task {
    fn open(root: &Path) -> Result<Self, CameraIssue> {
        let (_, model) = pinned_file(&root.join("hand_landmarker.task"), MAX_MODEL, MODEL_SHA)?;
        let api = Api::open(root)?;
        let mut configuration = HandOptions {
            base: BaseOptions {
                asset: model.as_ptr(),
                asset_count: model.len() as u32,
                asset_path: null(),
                delegate: 0,
            },
            mode: 2,
            num_hands: 2,
            detection: 0.5,
            presence: 0.5,
            tracking: 0.5,
            callback: null_mut(),
        };
        let mut value = null_mut();
        if unsafe { (api.create)(&mut configuration, &mut value, null_mut()) } != 0 {
            return Err(CameraIssue::ModelUnavailable);
        }
        Ok(Self {
            handle: NonZeroUsize::new(value as usize).ok_or(CameraIssue::ModelUnavailable)?,
            api,
            _model: model,
            clock: Instant::now(),
            last_ms: None,
        })
    }
}
impl Drop for Task {
    fn drop(&mut self) {
        let _ = unsafe { (self.api.close)(self.handle.get() as *mut _, null_mut()) };
    }
}

struct Image<'a> {
    value: *mut c_void,
    api: &'a Api,
}
impl Drop for Image<'_> {
    fn drop(&mut self) {
        unsafe { (self.api.release_image)(self.value) }
    }
}
struct DetectionLease<'a> {
    data: Detection,
    api: &'a Api,
}
impl Drop for DetectionLease<'_> {
    fn drop(&mut self) {
        unsafe { (self.api.release_detection)(&mut self.data) }
    }
}
impl DetectionLease<'_> {
    fn landmarks(&self) -> Result<Option<[Landmark; 21]>, CameraIssue> {
        if self.data.hands_count != 1 {
            return Ok(None);
        }
        let points = unsafe { self.data.hands.as_ref() }.ok_or(CameraIssue::InvalidFrame)?;
        if points.count != 21 || points.points.is_null() {
            return Err(CameraIssue::InvalidFrame);
        }
        let points = unsafe { std::slice::from_raw_parts(points.points, 21) };
        let mut result = [Landmark {
            x: 0.,
            y: 0.,
            z: 0.,
            confidence: None,
        }; 21];
        for (source, point) in points.iter().zip(&mut result) {
            if ![source.x, source.y, source.z]
                .iter()
                .all(|value| value.is_finite())
                || !(0.0..=1.0).contains(&source.x)
                || !(0.0..=1.0).contains(&source.y)
            {
                return Ok(None); // Never turn clipped/out-of-frame landmarks into a gesture.
            }
            *point = Landmark {
                x: source.x,
                y: source.y,
                z: source.z,
                confidence: None,
            };
        }
        Ok(Some(result))
    }
}

pub(crate) struct VerifiedWindowsLandmarker {
    root: PathBuf,
    task: Option<Task>,
}
impl VerifiedWindowsLandmarker {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self { root, task: None }
    }
}
impl RgbLandmarker for VerifiedWindowsLandmarker {
    fn preflight(&mut self) -> Result<(), CameraIssue> {
        self.task = None; // independent recognition state for each newly authorized lease
        self.task = Some(Task::open(&self.root)?);
        Ok(())
    }

    fn recognize(
        &mut self,
        frame: &RgbFrame,
        budget: Duration,
    ) -> Result<Option<[Landmark; 21]>, CameraIssue> {
        if budget.is_zero() {
            return Ok(None);
        }
        let task = self.task.as_mut().ok_or(CameraIssue::ModelUnavailable)?;
        let started = Instant::now();
        let age = frame
            .captured
            .checked_duration_since(task.clock)
            .unwrap_or_default();
        let timestamp = i64::try_from(age.as_millis()).map_err(|_| CameraIssue::InvalidFrame)?;
        if task.last_ms.is_some_and(|prior| timestamp <= prior) {
            return Ok(None);
        }
        let mut image = null_mut();
        let result = unsafe {
            (task.api.create_image)(
                1,
                i32::from(frame.width),
                i32::from(frame.height),
                frame.rgb().as_ptr(),
                c_int::try_from(frame.rgb().len()).map_err(|_| CameraIssue::InvalidFrame)?,
                &mut image,
                null_mut(),
            )
        };
        if result != 0 || image.is_null() {
            return Err(CameraIssue::InvalidFrame);
        }
        let image = Image {
            value: image,
            api: &task.api,
        };
        let mut result = Detection::default();
        if unsafe {
            (task.api.detect)(
                task.handle.get() as *mut _,
                image.value,
                null(),
                timestamp,
                &mut result,
                null_mut(),
            )
        } != 0
        {
            return Err(CameraIssue::ModelUnavailable);
        }
        task.last_ms = Some(timestamp);
        let lease = DetectionLease {
            data: result,
            api: &task.api,
        };
        if started.elapsed() > budget {
            return Ok(None);
        }
        lease.landmarks()
    }
}
