//! Process-owned Windows Ambient capture supervisor. No webview or destination
//! grants reach the native capture worker.
use std::{
    collections::BTreeSet,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use aerift_transfer::{
    ambient::{
        freeze_guarded, AmbientPolicy, CameraMode, Candidate, CaptureContext, CaptureError,
        CaptureLimits, FrozenCapture, ObjectManifest, RiftObjectKind, SessionActivity,
        SourceApplication,
    },
    ErrorCode, TransferError,
};
use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

use crate::ambient_context::{self, ContextError, ExplorerContext};

#[derive(Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub(crate) enum CaptureView {
    Idle,
    Working,
    Paused,
    Unavailable {
        reason: &'static str,
    },
    Frozen {
        id: uuid::Uuid,
        kind: RiftObjectKind,
        entries: Vec<ObjectManifest>,
    },
}

struct Slot {
    captured_at: Instant,
    id: uuid::Uuid,
    object: FrozenCapture,
}

#[derive(Default)]
struct Config {
    enabled: bool,
    paused: bool,
    excludes: BTreeSet<String>,
    watcher: Option<Channel<CaptureView>>,
    slot: Option<Slot>,
}

#[derive(Default)]
struct Supervisor {
    config: Mutex<Config>,
    generation: AtomicU64,
    working: AtomicBool,
}

#[derive(Clone, Default)]
pub(crate) struct AmbientRuntime(Arc<Supervisor>);

struct WorkLease(Arc<Supervisor>);
impl Drop for WorkLease {
    fn drop(&mut self) {
        self.0.working.store(false, Ordering::Release);
    }
}

fn emit(config: &Config, view: CaptureView) {
    if let Some(channel) = config.watcher.as_ref() {
        let _ = channel.send(view);
    }
}

pub(crate) fn capture_shortcut() -> Shortcut {
    Shortcut::new(
        Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT),
        Code::KeyA,
    )
}

fn is_normal_app_id(app_id: &str) -> bool {
    app_id.len() <= 128
        && app_id.to_ascii_lowercase().ends_with(".exe")
        && app_id.len() > 4
        && app_id.bytes().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, b'-' | b'_' | b'.')
        })
}

fn reason(error: CaptureError) -> &'static str {
    match error {
        CaptureError::SensitiveContext => "sensitive_context",
        CaptureError::NoSupportedObject => "no_supported_object",
        CaptureError::SourceUnavailable => "source_unavailable",
        CaptureError::SourceChanged => "source_changed",
        CaptureError::UnsupportedRepresentation => "unsupported_selection",
        CaptureError::LimitExceeded => "selection_too_large",
        CaptureError::Cancelled => "cancelled",
    }
}

fn acquire(
    context: ExplorerContext,
    allow: impl Fn() -> bool,
) -> Result<FrozenCapture, CaptureError> {
    // Folder context is not selected source content; preserve the adapter seam
    // but do not implicitly include everything in the active folder.
    let _folder = context.target_folder;
    let context = CaptureContext {
        source: Some(SourceApplication {
            app_id: context.source_executable,
        }),
        explicit_selection: context
            .explicit_selection
            .into_iter()
            .map(Candidate::path)
            .collect(),
        ..Default::default()
    };
    freeze_guarded(context, CaptureLimits::default(), allow)
}

fn camera_policy(config: &Config, source: Option<&str>) -> AmbientPolicy {
    let mut power: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
    let known_power = unsafe { GetSystemPowerStatus(&mut power) } != 0;
    AmbientPolicy {
        enabled: config.enabled,
        paused: config.paused,
        excluded_app: source
            .is_some_and(|source| config.excludes.contains(&source.to_ascii_lowercase())),
        session: if ambient_context::interactive_session() {
            SessionActivity::Unlocked
        } else {
            SessionActivity::Unknown
        },
        battery_saver: !known_power || power.SystemStatusFlag != 0,
        ..Default::default()
    }
}

impl AmbientRuntime {
    pub(crate) fn configure(
        &self,
        app: &AppHandle,
        enabled: bool,
        excluded_apps: Vec<String>,
    ) -> Result<(), TransferError> {
        if excluded_apps.len() > 64 || !excluded_apps.iter().all(|id| is_normal_app_id(id)) {
            return Err(ErrorCode::InvalidRequest.into());
        }
        let excluded_apps = excluded_apps
            .into_iter()
            .map(|id| id.to_ascii_lowercase())
            .collect();
        let mut cfg = self.0.config.lock().map_err(|_| ErrorCode::InternalError)?;
        if cfg.enabled != enabled {
            let shortcut = capture_shortcut();
            if enabled {
                app.global_shortcut()
                    .register(shortcut)
                    .map_err(|_| ErrorCode::Conflict)?;
            } else {
                // Revoke in-process authority even if OS cleanup fails.
                cfg.enabled = false;
                cfg.paused = false;
                cfg.slot = None;
                self.0.generation.fetch_add(1, Ordering::AcqRel);
                emit(&cfg, CaptureView::Idle);
                if app.global_shortcut().unregister(shortcut).is_err() {
                    return Err(ErrorCode::InternalError.into());
                }
            }
        }
        if cfg.enabled != enabled || cfg.excludes != excluded_apps {
            self.0.generation.fetch_add(1, Ordering::AcqRel);
            cfg.enabled = enabled;
            cfg.excludes = excluded_apps;
            cfg.slot = None;
            emit(
                &cfg,
                if cfg.paused {
                    CaptureView::Paused
                } else {
                    CaptureView::Idle
                },
            );
        }
        Ok(())
    }

    pub(crate) fn toggle_paused(&self) -> Option<bool> {
        let mut cfg = self.0.config.lock().ok()?;
        if !cfg.enabled {
            return None;
        }
        cfg.paused = !cfg.paused;
        cfg.slot = None;
        self.0.generation.fetch_add(1, Ordering::AcqRel);
        emit(
            &cfg,
            if cfg.paused {
                CaptureView::Paused
            } else {
                CaptureView::Idle
            },
        );
        Some(cfg.paused)
    }

    pub(crate) fn request_pickup(&self) {
        let Ok(mut cfg) = self.0.config.lock() else {
            return;
        };
        if !cfg.enabled || cfg.paused {
            return;
        }
        let policy = camera_policy(&cfg, None);
        if policy.camera_mode() == CameraMode::Suspended {
            cfg.slot = None;
            emit(&cfg, CaptureView::Paused);
            return;
        }
        let Ok(anchor) = ambient_context::capture_anchor() else {
            cfg.slot = None;
            emit(
                &cfg,
                CaptureView::Unavailable {
                    reason: "no_supported_object",
                },
            );
            return;
        };
        let source = ambient_context::foreground_executable();
        if source
            .as_ref()
            .is_none_or(|source| cfg.excludes.contains(source))
            || ambient_context::capture_anchor().ok() != Some(anchor)
        {
            cfg.slot = None;
            emit(
                &cfg,
                CaptureView::Unavailable {
                    reason: "sensitive_context",
                },
            );
            return;
        }
        if self.0.working.swap(true, Ordering::AcqRel) {
            return;
        }
        let generation = self.0.generation.load(Ordering::Acquire);
        cfg.slot = None;
        emit(&cfg, CaptureView::Working);
        drop(cfg);
        let runtime = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _lease = WorkLease(runtime.0.clone());
            let result = ambient_context::capture(anchor)
                .map_err(|error| match error {
                    ContextError::Unsupported => CaptureError::NoSupportedObject,
                    ContextError::SelectionChanged => CaptureError::SourceChanged,
                    ContextError::UnsafeSelection => CaptureError::UnsupportedRepresentation,
                    ContextError::SelectionTooLarge => CaptureError::LimitExceeded,
                    ContextError::Unavailable => CaptureError::SourceUnavailable,
                })
                .and_then(|context| {
                    let cfg = runtime
                        .0
                        .config
                        .lock()
                        .map_err(|_| CaptureError::SourceUnavailable)?;
                    if !camera_policy(&cfg, Some(&context.source_executable)).may_capture() {
                        return Err(CaptureError::SensitiveContext);
                    }
                    drop(cfg);
                    let guard_state = std::cell::Cell::new((None::<Instant>, true));
                    acquire(context, || {
                        if runtime.0.generation.load(Ordering::Acquire) != generation {
                            return false;
                        }
                        let (last_check, mut session_open) = guard_state.get();
                        if last_check
                            .is_none_or(|last| last.elapsed() >= Duration::from_millis(100))
                        {
                            session_open = ambient_context::interactive_session();
                            guard_state.set((Some(Instant::now()), session_open));
                        }
                        session_open
                    })
                });

            let Ok(mut cfg) = runtime.0.config.lock() else {
                return;
            };
            if runtime.0.generation.load(Ordering::Acquire) != generation
                || !cfg.enabled
                || cfg.paused
            {
                return;
            }
            if !ambient_context::interactive_session() {
                emit(&cfg, CaptureView::Paused);
                return;
            }
            match result {
                Ok(object) => {
                    let id = uuid::Uuid::new_v4();
                    cfg.slot = Some(Slot {
                        captured_at: Instant::now(),
                        id,
                        object,
                    });
                    if let Some(slot) = cfg.slot.as_ref() {
                        emit(&cfg, Self::view(slot));
                    }
                }
                Err(error) => emit(
                    &cfg,
                    CaptureView::Unavailable {
                        reason: reason(error),
                    },
                ),
            }
        });
    }

    fn view(slot: &Slot) -> CaptureView {
        CaptureView::Frozen {
            id: slot.id,
            kind: slot.object.kind,
            entries: slot
                .object
                .entries()
                .iter()
                .map(|entry| entry.manifest().clone())
                .collect(),
        }
    }

    pub(crate) fn start_lifecycle_watch(&self) {
        let runtime = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut clock = tokio::time::interval(Duration::from_millis(250));
            let mut was_paused_by_session = false;
            loop {
                clock.tick().await;
                let Ok(mut config) = runtime.0.config.lock() else {
                    break;
                };
                if !config.enabled {
                    was_paused_by_session = false;
                    continue;
                }
                let locked = !ambient_context::interactive_session();
                if locked && !was_paused_by_session {
                    runtime.0.generation.fetch_add(1, Ordering::AcqRel);
                    config.slot = None;
                    emit(&config, CaptureView::Paused);
                } else if !locked && was_paused_by_session && !config.paused {
                    emit(&config, CaptureView::Idle);
                } else if config
                    .slot
                    .as_ref()
                    .is_some_and(|slot| slot.captured_at.elapsed() >= Duration::from_secs(120))
                {
                    config.slot = None;
                    emit(&config, CaptureView::Idle);
                }
                was_paused_by_session = locked;
            }
        });
    }
}

fn require_main(window: &WebviewWindow) -> Result<(), TransferError> {
    if window.label() != "main" {
        return Err(ErrorCode::InvalidRequest.into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn set_ambient_capture(
    window: WebviewWindow,
    enabled: bool,
    excluded_apps: Vec<String>,
) -> Result<(), TransferError> {
    require_main(&window)?;
    window
        .state::<AmbientRuntime>()
        .configure(window.app_handle(), enabled, excluded_apps)
}

#[tauri::command]
pub(crate) fn watch_ambient_capture(
    window: WebviewWindow,
    updates: Channel<CaptureView>,
) -> Result<(), TransferError> {
    require_main(&window)?;
    let runtime = window.state::<AmbientRuntime>();
    let mut cfg = runtime
        .0
        .config
        .lock()
        .map_err(|_| ErrorCode::InternalError)?;
    cfg.watcher = Some(updates);
    let view = if cfg.paused || (cfg.enabled && !ambient_context::interactive_session()) {
        CaptureView::Paused
    } else if runtime.0.working.load(Ordering::Acquire) {
        CaptureView::Working
    } else {
        cfg.slot
            .as_ref()
            .map(AmbientRuntime::view)
            .unwrap_or(CaptureView::Idle)
    };
    emit(&cfg, view);
    Ok(())
}
