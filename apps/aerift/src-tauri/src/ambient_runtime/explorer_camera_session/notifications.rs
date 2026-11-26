//! Dedicated session-owner thread only. Tracks notification loss as revocation.
//! The hidden window has no WebView, no input and is never shown.
use std::{
    cell::{Cell, OnceCell},
    ffi::c_void,
    marker::PhantomData,
    ptr::{null, null_mut},
    rc::Rc,
    sync::{atomic::{AtomicBool, Ordering}, Arc},
};
use windows_sys::Win32::{
    Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM},
    UI::WindowsAndMessaging::{
        CallWindowProcW, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
        MsgWaitForMultipleObjectsEx, PeekMessageW, SetWindowLongPtrW,
        GWLP_WNDPROC, MSG, MWMO_INPUTAVAILABLE, PM_REMOVE, QS_ALLINPUT,
        WM_QUIT, WS_POPUP,
    },
};

const EVENT_SYSTEM_FOREGROUND: u32 = 3;
const WINEVENT_OUTOFCONTEXT: u32 = 0;
const WM_WTSSESSION_CHANGE: u32 = 0x02b1;
const NOTIFY_FOR_THIS_SESSION: u32 = 0;
const WAIT_FAILED: u32 = u32::MAX;
const STATIC_CLASS: [u16; 7] = [83, 84, 65, 84, 73, 67, 0];

type Hook = *mut c_void;
type WinEventProc = unsafe extern "system" fn(Hook, u32, HWND, i32, i32, u32, u32);

#[link(name = "user32")]
unsafe extern "system" {
    fn SetWinEventHook(first: u32, last: u32, module: HINSTANCE,
        callback: Option<WinEventProc>, process: u32, thread: u32, flags: u32) -> Hook;
    fn UnhookWinEvent(hook: Hook) -> i32;
}

#[link(name = "wtsapi32")]
unsafe extern "system" {
    fn WTSRegisterSessionNotification(window: HWND, scope: u32) -> i32;
    fn WTSUnRegisterSessionNotification(window: HWND) -> i32;
}

thread_local! {
    // OUTOFCONTEXT callbacks are dispatched on the thread that registered.
    // No HWND/process identity is stored or transmitted.
    static LATCH: OnceCell<Arc<AtomicBool>> = const { OnceCell::new() };
    static ORIGINAL_WNDPROC: Cell<isize> = const { Cell::new(0) };
}

fn invalidate() {
    let _ = LATCH.try_with(|slot| {
        if let Some(latch) = slot.get() {
            latch.store(true, Ordering::Release);
        }
    });
}

unsafe extern "system" fn foreground_event(_: Hook, event: u32, _: HWND, _: i32, _: i32, _: u32, _: u32) {
    if event == EVENT_SYSTEM_FOREGROUND {
        // Even an apparent return to the same window ends the session.
        invalidate();
    }
}

unsafe extern "system" fn notify_window(window: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if message == WM_WTSSESSION_CHANGE {
        // Includes lock, unlock, disconnect and desktop/session transitions.
        // No event (including unlock) can make an old grant live again.
        invalidate();
        return 0;
    }
    let original = ORIGINAL_WNDPROC.try_with(Cell::get).unwrap_or_default();
    if original != 0 {
        // SAFETY: this is the nonzero previous procedure value returned by
        // SetWindowLongPtrW. CallWindowProcW handles internal thunk values.
        let proc = unsafe { std::mem::transmute::<isize, unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT>(original) };
        unsafe { CallWindowProcW(Some(proc), window, message, w, l) }
    } else {
        unsafe { DefWindowProcW(window, message, w, l) }
    }
}

pub(super) struct Notifications {
    hook: Hook,
    window: HWND,
    subscribed: bool,
    latch: Arc<AtomicBool>,
    // Handles are only dropped and pumped on their registering thread.
    _thread_affine: PhantomData<Rc<()>>,
}

impl Notifications {
    pub(super) fn subscribe() -> Result<Self, ()> {
        let latch = Arc::new(AtomicBool::new(false));
        LATCH.with(|slot| slot.set(latch.clone())).map_err(|_| ())?;
        let mut this = Self {
            hook: null_mut(), window: null_mut(), subscribed: false,
            latch, _thread_affine: PhantomData,
        };
        // SAFETY: owner thread owns the hidden, parentless, non-visible window.
        // The system STATIC class needs no application-specific class lifetime.
        unsafe {
            this.window = CreateWindowExW(0, STATIC_CLASS.as_ptr(), null(), WS_POPUP,
                0, 0, 0, 0, null_mut(), null_mut(), null_mut(), null());
            if this.window.is_null() {
                return Err(());
            }
            let previous = SetWindowLongPtrW(this.window, GWLP_WNDPROC, notify_window as *const () as isize);
            if previous == 0 {
                return Err(());
            }
            ORIGINAL_WNDPROC.with(|slot| slot.set(previous));
            this.hook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND,
                null_mut(), Some(foreground_event), 0, 0, WINEVENT_OUTOFCONTEXT);
            if this.hook.is_null()
                || WTSRegisterSessionNotification(this.window, NOTIFY_FOR_THIS_SESSION) == 0
            {
                return Err(());
            }
            this.subscribed = true;
        }
        this.drain()?;
        Ok(this)
    }

    pub(super) fn latch(&self) -> Arc<AtomicBool> {
        self.latch.clone()
    }

    pub(super) fn drain(&self) -> Result<(), ()> {
        // Bound the dispatch work on this dedicated window thread. Saturation
        // revokes rather than allowing a pickup through an unknown queue.
        let mut message: MSG = unsafe { std::mem::zeroed() };
        for _ in 0..64 {
            if self.latch.load(Ordering::Acquire) {
                return Err(());
            }
            if unsafe { PeekMessageW(&mut message, null_mut(), 0, 0, PM_REMOVE) } == 0 {
                return (!self.latch.load(Ordering::Acquire)).then_some(()).ok_or(());
            }
            if message.message == WM_QUIT {
                break;
            }
            unsafe { DispatchMessageW(&message); }
        }
        self.latch.store(true, Ordering::Release);
        Err(())
    }

    pub(super) fn wait(&self, milliseconds: u32) -> Result<(), ()> {
        // No handles supplied. Wait for a queued input or the camera poll
        // deadline; the mandatory drain dispatches notifications immediately.
        let result = unsafe { MsgWaitForMultipleObjectsEx(0, null(), milliseconds,
            QS_ALLINPUT, MWMO_INPUTAVAILABLE) };
        if result == WAIT_FAILED {
            self.latch.store(true, Ordering::Release);
            return Err(());
        }
        self.drain()
    }
}

impl Drop for Notifications {
    fn drop(&mut self) {
        self.latch.store(true, Ordering::Release);
        // SAFETY: registrations, callback and handles all belong to this thread.
        unsafe {
            if self.subscribed {
                WTSUnRegisterSessionNotification(self.window);
            }
            if !self.hook.is_null() {
                UnhookWinEvent(self.hook);
            }
            if !self.window.is_null() {
                DestroyWindow(self.window);
            }
        }
        // This is a dedicated one-session thread; its TLS is dropped on exit.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn foreground_callback_irreversibly_revokes_even_without_window_identity() {
        std::thread::spawn(|| {
            let latch = Arc::new(AtomicBool::new(false));
            LATCH.with(|slot| assert!(slot.set(latch.clone()).is_ok()));
            unsafe { foreground_event(null_mut(), EVENT_SYSTEM_FOREGROUND, null_mut(), 0, 0, 0, 0) };
            assert!(latch.load(Ordering::Acquire));
            unsafe { foreground_event(null_mut(), 0, null_mut(), 0, 0, 0, 0) };
            assert!(latch.load(Ordering::Acquire));
        }).join().unwrap();
    }

    #[test]
    fn lock_or_unlock_never_restarts_a_camera_session() {
        std::thread::spawn(|| {
            let latch = Arc::new(AtomicBool::new(false));
            LATCH.with(|slot| assert!(slot.set(latch.clone()).is_ok()));
            // Directly exercise the WTS branch; no window or sensor is created.
            unsafe { notify_window(null_mut(), WM_WTSSESSION_CHANGE, 7, 0) };
            assert!(latch.load(Ordering::Acquire));
            unsafe { notify_window(null_mut(), WM_WTSSESSION_CHANGE, 8, 0) };
            assert!(latch.load(Ordering::Acquire));
        }).join().unwrap();
    }
}
