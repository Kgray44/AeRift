use std::sync::Mutex;

use tauri::{ipc::Channel, AppHandle, Runtime, State};

use crate::{
    hand_camera_authorized, hand_camera_clock, start_hand_camera, stop_hand_camera, CameraUpdate,
};

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
pub(crate) async fn camera_authorized<R: Runtime>(app: AppHandle<R>) -> Result<bool, &'static str> {
    hand_camera_authorized(&app)
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
    if attempt_id.is_empty() || attempt_id.len() > 128 {
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
    if attempt_id.is_empty() || attempt_id.len() > 128 {
        return Err("Invalid camera attempt.");
    }
    camera.clear_attempt(&attempt_id)?;
    stop_hand_camera(&app, &attempt_id)
        .await
        .map_err(|_| "Could not stop the camera.")
}
