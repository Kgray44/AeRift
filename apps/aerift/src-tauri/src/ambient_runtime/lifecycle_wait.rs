use std::time::Duration;
use tokio::sync::Notify;

#[derive(Default)]
pub(super) struct LifecycleWake(Notify);

impl LifecycleWake {
    pub(super) fn changed(&self) {
        // A single permit survives a change just before entering wait.
        self.0.notify_one();
    }

    pub(super) async fn wait(&self, enabled: bool) {
        if enabled {
            tokio::select! {
                biased;
                _ = self.0.notified() => {},
                _ = tokio::time::sleep(Duration::from_millis(250)) => {},
            }
        } else {
            self.0.notified().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn disabled_has_no_timer_but_survives_a_change_before_await() {
        let wake = LifecycleWake::default();
        assert!(
            tokio::time::timeout(Duration::from_millis(30), wake.wait(false))
                .await
                .is_err()
        );
        wake.changed();
        assert!(
            tokio::time::timeout(Duration::from_millis(30), wake.wait(false))
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn active_fallback_and_immediate_wake_both_work() {
        let wake = LifecycleWake::default();
        assert!(
            tokio::time::timeout(Duration::from_millis(30), wake.wait(true))
                .await
                .is_err()
        );
        wake.changed();
        assert!(
            tokio::time::timeout(Duration::from_millis(30), wake.wait(true))
                .await
                .is_ok()
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(450), wake.wait(true))
                .await
                .is_ok()
        );
    }
}
