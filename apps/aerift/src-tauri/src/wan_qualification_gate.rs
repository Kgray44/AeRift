//! Policy and single-owner shutdown shared by the Windows qualification example.
use std::ffi::OsString;
use std::sync::atomic::{AtomicU8, Ordering};

const EXPLICIT_START: &str = "--start-approved-wan-qualification";

pub(crate) fn admitted_args(args: impl IntoIterator<Item = OsString>) -> bool {
    let mut args = args.into_iter();
    args.next().is_some_and(|arg| arg == EXPLICIT_START) && args.next().is_none()
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ExitAction {
    StartShutdown,
    WaitForShutdown,
    Allow,
}

#[derive(Default)]
pub(crate) struct ExitGate(AtomicU8);

impl ExitGate {
    pub(crate) fn requested(&self) -> ExitAction {
        match self
            .0
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => ExitAction::StartShutdown,
            Err(2) => ExitAction::Allow,
            Err(_) => ExitAction::WaitForShutdown,
        }
    }

    pub(crate) fn completed(&self) {
        self.0.store(2, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_opt_in_accepts_only_the_exact_start_flag() {
        let args = |values: &[&str]| values.iter().map(OsString::from).collect::<Vec<_>>();
        assert!(admitted_args(args(&[EXPLICIT_START])));
        assert!(!admitted_args(args(&[])));
        assert!(!admitted_args(args(&["--private-remote-dev"])));
        assert!(!admitted_args(args(&[
            EXPLICIT_START,
            "https://untrusted.invalid"
        ])));
        assert!(!admitted_args(args(&["--relay", EXPLICIT_START])));
    }

    #[test]
    fn only_the_first_exit_request_owns_shutdown_and_release_is_explicit() {
        let gate = ExitGate::default();
        std::thread::scope(|scope| {
            let requests: Vec<_> = (0..16).map(|_| scope.spawn(|| gate.requested())).collect();
            let results: Vec<_> = requests
                .into_iter()
                .map(|request| request.join().unwrap())
                .collect();
            assert_eq!(
                results
                    .iter()
                    .filter(|result| **result == ExitAction::StartShutdown)
                    .count(),
                1
            );
            assert_eq!(
                results
                    .iter()
                    .filter(|result| **result == ExitAction::WaitForShutdown)
                    .count(),
                15
            );
        });
        assert_eq!(gate.requested(), ExitAction::WaitForShutdown);
        gate.completed();
        assert_eq!(gate.requested(), ExitAction::Allow);
    }
}
