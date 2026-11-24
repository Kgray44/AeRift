//! Windows-native entry points for opt-in A4. No calls from overlay IPC or
//! browser proposals. The owning tray/menu may call these after integration.
use super::{ambient_context, emit, AmbientRuntime, CaptureView, Config};
use aerift_transfer::{
    ambient::{nearby_runtime::NearbyRuntime, ReceiverCapabilities, Representation},
    Connector, ErrorCode, PeerId, Sender, TransferError,
};
use std::time::Duration;

impl AmbientRuntime {
    pub(super) fn sync_a4_policy(&self, cfg: &Config) {
        let opted_in = cfg.enabled && cfg.a4_opt_in;
        let interactive = opted_in
            && ambient_context::interactive_session()
            && ambient_context::foreground_executable()
                .is_some_and(|id| !cfg.excludes.contains(&id));
        self.0.a4.set_policy(opted_in, interactive, cfg.paused);
    }

    /// Wire to a separately labelled desktop opt-in, never an app startup.
    pub(crate) fn set_a4_native_opt_in(&self, enabled: bool) -> Result<(), TransferError> {
        let mut cfg = self.0.config.lock().map_err(|_| ErrorCode::InternalError)?;
        if enabled && !cfg.enabled {
            return Err(ErrorCode::Conflict.into());
        }
        cfg.a4_opt_in = enabled;
        self.0.lifecycle_wake.changed();
        self.sync_a4_policy(&cfg);
        Ok(())
    }

    /// Promote the exact existing frozen slot after an explicit native user
    /// action. This consumes the slot and doesn't rerun context resolution.
    pub(crate) fn hold_a4_native_pickup(
        &self,
        capture_id: uuid::Uuid,
    ) -> Result<(), TransferError> {
        let mut cfg = self.0.config.lock().map_err(|_| ErrorCode::InternalError)?;
        self.sync_a4_policy(&cfg);
        if self.0.a4.source().is_none() {
            return Err(ErrorCode::Conflict.into());
        }
        if !cfg.slot.as_ref().is_some_and(|slot| {
            slot.id == capture_id
                && slot.captured_at.elapsed() < Duration::from_secs(30)
                && slot.object.negotiate(ReceiverCapabilities::V1)
                    == Ok(Representation::SingleRawFile)
        }) {
            return Err(ErrorCode::InvalidRequest.into());
        }
        let slot = cfg.slot.take().ok_or(ErrorCode::InvalidRequest)?;
        self.0.a4.pickup(slot.object, slot.captured_at)?;
        emit(&cfg, CaptureView::Idle);
        Ok(())
    }

    pub(crate) fn a4_current_capture(&self) -> Option<uuid::Uuid> {
        let cfg = self.0.config.lock().ok()?;
        cfg.slot.as_ref().map(|slot| slot.id)
    }

    pub(crate) fn a4_is_enabled(&self) -> bool {
        self.0
            .config
            .lock()
            .is_ok_and(|config| config.enabled && config.a4_opt_in)
    }

    /// The host must build candidates from the live paired Nearby roster.
    pub(crate) async fn drop_a4_native<C: Connector + 'static>(
        &self,
        peers: Vec<(PeerId, Sender<C>)>,
    ) -> Result<(), TransferError> {
        self.a4_for_nearby()?.explicit_drop(peers).await
    }

    /// Supply to the opt-in Nearby listener hook only. This rechecks local
    /// exclusion and desktop state immediately, in addition to watchdog checks.
    pub(crate) fn a4_for_nearby(&self) -> Result<&NearbyRuntime, TransferError> {
        let cfg = self.0.config.lock().map_err(|_| ErrorCode::InternalError)?;
        self.sync_a4_policy(&cfg);
        if self.0.a4.source().is_none() {
            return Err(ErrorCode::Conflict.into());
        }
        Ok(&self.0.a4)
    }
}
