//! Windows A1 qualification-only ingress. Not registered by the shipping app.
//! Only a future native consent flow may construct a device grant.

use aerift_transfer::ambient_camera::{
    CameraCadence, CameraIssue, DriverReadGate, LandmarkFrame, LocalCameraProvider,
    LocalLandmarkSource, Rgb32Layout, RgbFrame, RgbLandmarker,
};
use std::{
    ffi::OsStr,
    os::windows::ffi::OsStrExt,
    ptr::null_mut,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use windows::{
    core::{implement, Ref, HRESULT, PCWSTR},
    Win32::{
        Media::MediaFoundation::*,
        System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
    },
};

const VIDEO_STREAM: u32 = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
const ALL_STREAMS: u32 = MF_SOURCE_READER_ALL_STREAMS.0 as u32;

/// A native, explicitly selected MF capture device and an independent OS permission check.
/// Construction has no side effects: it does not probe or start the camera.
pub(crate) struct NativeCameraGrant {
    symbolic_link: Vec<u16>,
    permission_now: Box<dyn Fn() -> bool + Send + Sync>,
}

impl NativeCameraGrant {
    pub(crate) fn from_native_choice(
        device_link: &OsStr,
        deliberately_enabled: bool,
        permission_now: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Result<Self, CameraIssue> {
        let mut name: Vec<_> = device_link.encode_wide().take(4097).collect();
        if !deliberately_enabled || !permission_now() {
            return Err(CameraIssue::PermissionDenied);
        }
        if name.len() > 4096 || name.len() < 5 || name.contains(&0) || name[..4] != [92, 92, 63, 92]
        {
            return Err(CameraIssue::DeviceUnavailable);
        }
        name.push(0);
        Ok(Self {
            symbolic_link: name,
            permission_now: Box::new(permission_now),
        })
    }

    pub(crate) fn allowed(&self) -> Result<(), CameraIssue> {
        (self.permission_now)()
            .then_some(())
            .ok_or(CameraIssue::PermissionDenied)
    }
}

pub(crate) trait NativeIndicator: Send + 'static {
    type Guard;
    fn show(&mut self) -> Result<Self::Guard, CameraIssue>;
    fn occupancy_probe(&self) -> Arc<dyn Fn() -> bool + Send + Sync>;
}

pub(crate) struct WindowsCameraProvider<M, I> {
    model: Arc<Mutex<M>>,
    indicator: I,
    grant: Arc<NativeCameraGrant>,
}

impl<M: RgbLandmarker, I: NativeIndicator> WindowsCameraProvider<M, I> {
    pub(crate) fn new(model: M, indicator: I, grant: NativeCameraGrant) -> Self {
        Self::with_shared_grant(model, indicator, Arc::new(grant))
    }

    pub(crate) fn with_shared_grant(model: M, indicator: I, grant: Arc<NativeCameraGrant>) -> Self {
        Self { model: Arc::new(Mutex::new(model)), indicator, grant }
    }
}

impl<M: RgbLandmarker, I: NativeIndicator> LocalCameraProvider for WindowsCameraProvider<M, I> {
    type Lease = WindowsLandmarkLease<M>;
    type Indicator = I::Guard;

    fn preflight(&mut self) -> Result<(), CameraIssue> {
        self.grant.allowed()?;
        self.model
            .lock()
            .map_err(|_| CameraIssue::ModelUnavailable)?
            .preflight()
    }

    fn indicate_camera_use(&mut self) -> Result<Self::Indicator, CameraIssue> {
        self.indicator.show()
    }

    fn acquire(
        &mut self,
        cadence: CameraCadence,
        budget: Duration,
    ) -> Result<Self::Lease, CameraIssue> {
        self.grant.allowed()?;
        let occupancy = self.indicator.occupancy_probe();
        if !occupancy() {
            return Err(CameraIssue::IndicatorUnavailable);
        }
        let ingress = MediaReader::start(&self.grant, cadence, budget)?;
        if !occupancy() {
            return Err(CameraIssue::IndicatorUnavailable);
        }
        Ok(WindowsLandmarkLease {
            ingress,
            occupancy,
            model: self.model.clone(),
            grant: self.grant.clone(),
        })
    }
}

pub(crate) struct WindowsLandmarkLease<M> {
    ingress: MediaReader,
    occupancy: Arc<dyn Fn() -> bool + Send + Sync>,
    model: Arc<Mutex<M>>,
    grant: Arc<NativeCameraGrant>,
}

impl<M: RgbLandmarker> LocalLandmarkSource for WindowsLandmarkLease<M> {
    fn sample(&mut self, budget: Duration) -> Result<Option<LandmarkFrame>, CameraIssue> {
        self.grant.allowed()?;
        if !(self.occupancy)() {
            return Err(CameraIssue::IndicatorUnavailable);
        }
        let deadline = Instant::now() + budget;
        // Keep half the total budget available for the independently bounded model.
        let Some(frame) = self.ingress.sample(budget / 2)? else {
            return Ok(None);
        };
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(None);
        }
        self.grant.allowed()?;
        let hand = self
            .model
            .lock()
            .map_err(|_| CameraIssue::ModelUnavailable)?
            .recognize(&frame, remaining)?;
        if Instant::now() > deadline {
            return Ok(None);
        }
        self.grant.allowed()?;
        if !(self.occupancy)() {
            return Err(CameraIssue::IndicatorUnavailable);
        }
        Ok(Some(LandmarkFrame {
            captured: frame.captured,
            width: frame.width,
            height: frame.height,
            hand,
        }))
    }
}

struct Com;
impl Com {
    fn start() -> Result<Self, CameraIssue> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok() }.map_err(mf_error)?;
        Ok(Self)
    }
}
impl Drop for Com {
    fn drop(&mut self) {
        unsafe { CoUninitialize() }
    }
}

struct Mf;
impl Mf {
    fn start() -> Result<Self, CameraIssue> {
        unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) }.map_err(mf_error)?;
        Ok(Self)
    }
}
impl Drop for Mf {
    fn drop(&mut self) {
        let _ = unsafe { MFShutdown() };
    }
}

struct Source(IMFMediaSource);
impl Drop for Source {
    fn drop(&mut self) {
        let _ = unsafe { self.0.Shutdown() };
    }
}

fn mf_error(error: windows::core::Error) -> CameraIssue {
    match error.code().0 as u32 {
        0x80070005 => CameraIssue::PermissionDenied, // E_ACCESSDENIED
        0x80070020 | 0x800700aa => CameraIssue::DeviceBusy,
        _ => CameraIssue::DeviceUnavailable,
    }
}

#[derive(Clone)]
struct CallbackState {
    open: Arc<AtomicBool>,
    layout: Arc<Mutex<Option<Rgb32Layout>>>,
    output: SyncSender<Result<Option<RgbFrame>, CameraIssue>>,
}

#[implement(IMFSourceReaderCallback)]
struct Callback(CallbackState);

impl IMFSourceReaderCallback_Impl for Callback_Impl {
    fn OnReadSample(
        &self,
        status: HRESULT,
        _stream: u32,
        flags: u32,
        _timestamp: i64,
        sample: Ref<IMFSample>,
    ) -> windows::core::Result<()> {
        let state = &self.0;
        if !state.open.load(Ordering::Acquire) {
            return Ok(());
        }
        let invalid = (MF_SOURCE_READERF_ERROR.0
            | MF_SOURCE_READERF_ENDOFSTREAM.0
            | MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0
            | MF_SOURCE_READERF_NATIVEMEDIATYPECHANGED.0) as u32;
        let frame = if status.is_err() || flags & invalid != 0 {
            Err(CameraIssue::DeviceUnavailable)
        } else if let Some(sample) = sample.as_ref() {
            let captured = Instant::now();
            let layout = state.layout.lock().ok().and_then(|layout| *layout);
            layout
                .ok_or(CameraIssue::InvalidFrame)
                .and_then(|layout| frame_from_sample(sample, layout, captured))
                .map(Some)
        } else {
            Ok(None)
        };
        if state.open.load(Ordering::Acquire) {
            // Never block a driver callback on inference or runtime shutdown.
            let _ = state.output.try_send(frame);
        }
        Ok(())
    }

    fn OnFlush(&self, _stream: u32) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnEvent(&self, _stream: u32, _event: Ref<IMFMediaEvent>) -> windows::core::Result<()> {
        Ok(())
    }
}

struct BufferLock<'a>(&'a IMFMediaBuffer);
impl Drop for BufferLock<'_> {
    fn drop(&mut self) {
        let _ = unsafe { self.0.Unlock() };
    }
}

fn frame_from_sample(
    sample: &IMFSample,
    layout: Rgb32Layout,
    captured: Instant,
) -> Result<RgbFrame, CameraIssue> {
    let buffer = unsafe { sample.ConvertToContiguousBuffer() }.map_err(mf_error)?;
    let mut bytes = null_mut();
    let mut capacity = 0;
    let mut length = 0;
    unsafe { buffer.Lock(&mut bytes, Some(&mut capacity), Some(&mut length)) }.map_err(mf_error)?;
    let _lock = BufferLock(&buffer);
    if bytes.is_null() || length > capacity || length as usize != layout.bytes() {
        return Err(CameraIssue::InvalidFrame);
    }
    // Driver buffer remains locked until after the owned RGB conversion ends.
    let pixels = unsafe { std::slice::from_raw_parts(bytes, length as usize) };
    RgbFrame::decode(captured, layout, pixels)
}

struct MediaReader {
    open: Arc<AtomicBool>,
    reader: Option<IMFSourceReader>,
    output: Receiver<Result<Option<RgbFrame>, CameraIssue>>,
    pending: DriverReadGate,
    _source: Source,
    _mf: Mf,
    _com: Com,
}

fn attributes(count: u32) -> Result<IMFAttributes, CameraIssue> {
    let mut result = None;
    unsafe { MFCreateAttributes(&mut result, count) }.map_err(mf_error)?;
    result.ok_or(CameraIssue::DeviceUnavailable)
}

impl MediaReader {
    fn start(
        grant: &NativeCameraGrant,
        cadence: CameraCadence,
        budget: Duration,
    ) -> Result<Self, CameraIssue> {
        let started = Instant::now();
        let com = Com::start()?;
        let mf = Mf::start()?;
        let device = attributes(2)?;
        unsafe {
            device
                .SetGUID(
                    &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
                    &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
                )
                .map_err(mf_error)?;
            device
                .SetString(
                    &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK,
                    PCWSTR(grant.symbolic_link.as_ptr()),
                )
                .map_err(mf_error)?;
        }
        grant.allowed()?;
        if started.elapsed() >= budget {
            return Err(CameraIssue::DeviceUnavailable);
        }
        let source = Source(unsafe { MFCreateDeviceSource(&device) }.map_err(mf_error)?);
        let (tx, rx) = sync_channel(1);
        let open = Arc::new(AtomicBool::new(true));
        let layout = Arc::new(Mutex::new(None));
        let callback: IMFSourceReaderCallback = Callback(CallbackState {
            open: open.clone(),
            layout: layout.clone(),
            output: tx,
        })
        .into();
        let configuration = attributes(3)?;
        unsafe {
            configuration
                .SetUnknown(&MF_SOURCE_READER_ASYNC_CALLBACK, &callback)
                .map_err(mf_error)?;
            configuration
                .SetUINT32(&MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1)
                .map_err(mf_error)?;
            // This lease, not the reader, owns the device source shutdown.
            configuration
                .SetUINT32(&MF_SOURCE_READER_DISCONNECT_MEDIASOURCE_ON_SHUTDOWN, 1)
                .map_err(mf_error)?;
        }
        let reader = unsafe { MFCreateSourceReaderFromMediaSource(&source.0, &configuration) }
            .map_err(mf_error)?;
        let media = unsafe { MFCreateMediaType() }.map_err(mf_error)?;
        let size = (u64::from(cadence.target_width) << 32) | u64::from(cadence.target_height);
        unsafe {
            media
                .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
                .map_err(mf_error)?;
            media
                .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)
                .map_err(mf_error)?;
            media.SetUINT64(&MF_MT_FRAME_SIZE, size).map_err(mf_error)?;
            reader
                .SetStreamSelection(ALL_STREAMS, false)
                .map_err(mf_error)?;
            reader
                .SetStreamSelection(VIDEO_STREAM, true)
                .map_err(mf_error)?;
            reader
                .SetCurrentMediaType(VIDEO_STREAM, None, &media)
                .map_err(mf_error)?;
        }
        let current = unsafe { reader.GetCurrentMediaType(VIDEO_STREAM) }.map_err(mf_error)?;
        if unsafe { current.GetGUID(&MF_MT_SUBTYPE) }.map_err(mf_error)? != MFVideoFormat_RGB32 {
            return Err(CameraIssue::InvalidFrame);
        }
        let accepted_size = unsafe { current.GetUINT64(&MF_MT_FRAME_SIZE) }.map_err(mf_error)?;
        // Reject unrequested high-resolution modes instead of silently increasing load.
        if accepted_size != size {
            return Err(CameraIssue::InvalidFrame);
        }
        let pitch = unsafe { current.GetUINT32(&MF_MT_DEFAULT_STRIDE) }.map_err(mf_error)? as i32;
        let frame_layout = Rgb32Layout::new(cadence.target_width, cadence.target_height, pitch)?;
        *layout.lock().map_err(|_| CameraIssue::DeviceUnavailable)? = Some(frame_layout);
        grant.allowed()?;
        if started.elapsed() >= budget {
            return Err(CameraIssue::DeviceUnavailable);
        }
        Ok(Self {
            open,
            reader: Some(reader),
            output: rx,
            pending: DriverReadGate::default(),
            _source: source,
            _mf: mf,
            _com: com,
        })
    }

    fn sample(&mut self, timeout: Duration) -> Result<Option<RgbFrame>, CameraIssue> {
        if self.pending.begin(Instant::now()) {
            let reader = self.reader.as_ref().ok_or(CameraIssue::DeviceUnavailable)?;
            // Async source reader: all out pointers are NULL and only one request is
            // in flight. A driver stall returns no frame, not queued requests.
            unsafe { reader.ReadSample(VIDEO_STREAM, 0, None, None, None, None) }
                .map_err(mf_error)?;
        }
        match self.output.recv_timeout(timeout) {
            Ok(result) => {
                let at = self.pending.complete(Instant::now());
                result.map(|frame| {
                    at.zip(frame).map(|(at, mut frame)| {
                        frame.captured = at;
                        frame
                    })
                })
            }
            Err(RecvTimeoutError::Timeout) if self.pending.stalled(Instant::now()) => {
                Err(CameraIssue::DeviceUnavailable)
            }
            Err(RecvTimeoutError::Timeout) => Ok(None),
            Err(RecvTimeoutError::Disconnected) => Err(CameraIssue::DeviceUnavailable),
        }
    }
}

impl Drop for MediaReader {
    fn drop(&mut self) {
        self.open.store(false, Ordering::Release);
        if let Some(reader) = self.reader.take() {
            let _ = unsafe { reader.Flush(ALL_STREAMS) };
            drop(reader);
        }
        // Fields then shut down media source, MF, and COM in that order.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_opt_in_and_missing_os_permission_do_not_construct_a_grant() {
        let path = OsStr::new(r"\\?\synthetic-device-id");
        assert!(matches!(
            NativeCameraGrant::from_native_choice(path, false, || true),
            Err(CameraIssue::PermissionDenied)
        ));
        assert!(matches!(
            NativeCameraGrant::from_native_choice(path, true, || false),
            Err(CameraIssue::PermissionDenied)
        ));
    }

    #[test]
    fn arbitrary_paths_and_embedded_nuls_are_not_device_links() {
        for name in [r"C:\fake\asset.bin", "\\\\?\\bad\0device"] {
            assert!(matches!(
                NativeCameraGrant::from_native_choice(OsStr::new(name), true, || true),
                Err(CameraIssue::DeviceUnavailable)
            ));
        }
    }
}
