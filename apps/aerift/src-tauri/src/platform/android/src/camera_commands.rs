use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, plugin::mobile::PluginInvokeError, AppHandle, Runtime, State};

use crate::{call, call_empty};

#[derive(Default)]
pub(crate) struct CameraUi(Mutex<CameraSubscription>);

#[derive(Default)]
struct CameraSubscription {
    events: Option<Channel<CameraUpdate>>,
    active: Option<String>,
}

impl CameraUi {
    fn clear_attempt(&self, attempt_id: &str) -> Result<(), &'static str> {
        let mut subscription = self.0.lock().map_err(|_| "Camera state unavailable.")?;
        if subscription.active.as_deref() == Some(attempt_id) {
            subscription.active = None;
        }
        Ok(())
    }
}

#[tauri::command]
pub(crate) async fn camera_permission<R: Runtime>(
    app: AppHandle<R>,
    request: bool,
) -> Result<String, &'static str> {
    hand_camera_permission(&app, request)
        .await
        .map_err(|_| "Camera authorization unavailable.")
}

#[tauri::command]
pub(crate) async fn camera_clock<R: Runtime>(app: AppHandle<R>) -> Result<f64, &'static str> {
    hand_camera_clock(&app)
        .await
        .map_err(|_| "Camera clock unavailable.")
}

#[tauri::command]
pub(crate) async fn register_camera_events<R: Runtime>(
    app: AppHandle<R>,
    camera: State<'_, CameraUi>,
    events: Channel<CameraUpdate>,
) -> Result<(), &'static str> {
    let old_attempt = {
        let mut subscription = camera.0.lock().map_err(|_| "Camera state unavailable.")?;
        subscription.events = Some(events);
        subscription.active.take()
    };
    if let Some(attempt_id) = old_attempt {
        stop_hand_camera(&app, &attempt_id)
            .await
            .map_err(|_| "Could not stop the previous camera attempt.")?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn start_camera<R: Runtime>(
    app: AppHandle<R>,
    camera: State<'_, CameraUi>,
    attempt_id: String,
) -> Result<(), &'static str> {
    if !valid_attempt_id(&attempt_id) {
        return Err("Invalid camera attempt.");
    }

    let events = {
        let mut subscription = camera.0.lock().map_err(|_| "Camera state unavailable.")?;
        if subscription.active.is_some() {
            return Err("A camera attempt is still active.");
        }
        let events = subscription
            .events
            .clone()
            .ok_or("Camera events are not registered.")?;
        subscription.active = Some(attempt_id.clone());
        events
    };

    if start_hand_camera(&app, &attempt_id, &events).await.is_err() {
        camera.clear_attempt(&attempt_id)?;
        return Err("Could not start the camera.");
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn stop_camera<R: Runtime>(
    app: AppHandle<R>,
    camera: State<'_, CameraUi>,
    attempt_id: String,
) -> Result<(), &'static str> {
    if !valid_attempt_id(&attempt_id) {
        return Err("Invalid camera attempt.");
    }
    camera.clear_attempt(&attempt_id)?;
    stop_hand_camera(&app, &attempt_id)
        .await
        .map_err(|_| "Could not stop the camera.")
}

fn valid_attempt_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 96 &&
        id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[derive(Deserialize, Serialize)]
pub struct HandLandmark {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandFrame {
    pub capture_ms: f64,
    pub width: u32,
    pub height: u32,
    pub hands: Vec<Vec<HandLandmark>>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CameraState {
    Disabled,
    Requesting,
    Starting,
    Ready,
    Denied,
    Unavailable,
    Busy,
    Suspended,
    Error,
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CameraUpdate {
    Frame {
        attempt_id: String,
        frame: HandFrame,
    },
    State {
        attempt_id: String,
        state: CameraState,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CameraStart<'a> {
    attempt_id: &'a str,
    events: &'a Channel<CameraUpdate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CameraStop<'a> {
    attempt_id: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CameraClock {
    clock_ms: f64,
}

async fn hand_camera_clock<R: Runtime>(app: &AppHandle<R>) -> Result<f64, PluginInvokeError> {
    let clock: CameraClock = call(app, "cameraClock", ()).await?;
    Ok(clock.clock_ms)
}

#[derive(Serialize)]
struct CameraPermissionRequest {
    request: bool,
}

#[derive(Deserialize)]
struct CameraPermission {
    status: String,
}

async fn hand_camera_permission<R: Runtime>(
    app: &AppHandle<R>,
    request: bool,
) -> Result<String, PluginInvokeError> {
    let permission: CameraPermission =
        call(app, "cameraPermission", CameraPermissionRequest { request }).await?;
    Ok(permission.status)
}

/// Call only from an explicit foreground camera action. Reuse the app's
/// channel for new attempts and route state changes to the shared controller.
pub async fn start_hand_camera<R: Runtime>(
    app: &AppHandle<R>,
    attempt_id: &str,
    events: &Channel<CameraUpdate>,
) -> Result<(), PluginInvokeError> {
    call_empty(app, "startCamera", CameraStart { attempt_id, events }).await
}

pub async fn stop_hand_camera<R: Runtime>(
    app: &AppHandle<R>,
    attempt_id: &str,
) -> Result<(), PluginInvokeError> {
    call_empty(app, "stopCamera", CameraStop { attempt_id }).await
}
