//! Qualification-only lifecycle requests. No serialization, IPC or production witness.
const MAX_GENERATION: u64 = (1 << 53) - 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Admission {
    Disabled,
    ClosedFixture,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Request<'a> {
    Present { generation: u64, address: &'a str },
    Navigate { generation: u64, address: &'a str },
    Back { generation: u64 },
    Forward { generation: u64 },
    Reload { generation: u64 },
    Close { generation: u64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Reply {
    Unavailable,
    Denied,
    Accepted,
    Closed,
    Presented {
        width_px: u32,
        height_px: u32,
        can_back: bool,
        can_forward: bool,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Pending {
    generation: u64,
    serial: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum View {
    Hidden,
    Visible { width_px: u32, height_px: u32 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ControllerError {
    Denied,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct History {
    pub can_back: bool,
    pub can_forward: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HistoryAction {
    Back,
    Forward,
    Reload,
}

pub(crate) trait Controller {
    type Layout: Copy;
    fn address_admitted(address: &str) -> bool;
    fn layout_admitted(layout: Self::Layout) -> bool;
    fn apply_layout(&mut self, layout: Self::Layout) -> Result<View, ControllerError>;
    fn navigate(&self, address: &str) -> Result<(), ControllerError>;
    fn history(&self) -> History;
    fn history_action(&self, action: HistoryAction) -> Result<(), ControllerError>;
    fn close(&mut self);
}

pub(crate) struct RequestOwner<C: Controller> {
    admission: Admission,
    generation: u64,
    layout: C::Layout,
    pending: Option<Pending>,
    serial: u64,
    view: Option<(C, View)>,
}

impl<C: Controller> RequestOwner<C> {
    pub(crate) fn new(admission: Admission, layout: C::Layout) -> Self {
        Self {
            admission,
            generation: 0,
            layout,
            pending: None,
            serial: 0,
            view: None,
        }
    }

    fn remove(&mut self) {
        self.pending = None;
        if let Some((mut view, _)) = self.view.take() {
            view.close();
        }
        // Saturation is terminal (MAX_GENERATION+1 is never admitted).
        self.generation = self.generation.saturating_add(1);
    }

    pub(crate) fn revoke(&mut self) {
        self.admission = Admission::Disabled;
        self.remove();
    }

    /// Layout comes exclusively from the native STA, not a request.
    pub(crate) fn set_layout(&mut self, layout: C::Layout) -> Reply {
        self.layout = layout;
        if self.pending.is_some() && !C::layout_admitted(layout) {
            self.remove();
            return Reply::Closed;
        }
        self.apply_layout()
    }

    fn apply_layout(&mut self) -> Reply {
        let Some((controller, view)) = self.view.as_mut() else {
            return Reply::Closed;
        };
        match controller.apply_layout(self.layout) {
            Ok(next) => {
                let reply = Self::projection(next, controller.history());
                if next != View::Hidden && reply == Reply::Unavailable {
                    self.remove();
                } else {
                    *view = next;
                }
                reply
            }
            Err(_) => {
                self.remove();
                Reply::Unavailable
            }
        }
    }

    fn projection(view: View, history: History) -> Reply {
        match view {
            View::Visible {
                width_px,
                height_px,
            } if (64..=16_384).contains(&width_px) && (64..=16_384).contains(&height_px) => {
                Reply::Presented {
                    width_px,
                    height_px,
                    can_back: history.can_back,
                    can_forward: history.can_forward,
                }
            }
            _ => Reply::Unavailable,
        }
    }

    pub(crate) fn request(&mut self, request: Request<'_>) -> (Reply, Option<Pending>) {
        let generation = match request {
            Request::Present { generation, .. }
            | Request::Navigate { generation, .. }
            | Request::Back { generation }
            | Request::Forward { generation }
            | Request::Reload { generation }
            | Request::Close { generation } => generation,
        };
        if self.admission != Admission::ClosedFixture {
            return (Reply::Unavailable, None);
        }
        if generation != self.generation || generation > MAX_GENERATION {
            return (Reply::Denied, None);
        }
        match request {
            Request::Present { address, .. }
                if self.pending.is_none()
                    && self.view.is_none()
                    && C::layout_admitted(self.layout)
                    && C::address_admitted(address) =>
            {
                let Some(serial) = self.serial.checked_add(1) else {
                    return (Reply::Unavailable, None);
                };
                self.serial = serial;
                let ticket = Pending { generation, serial };
                self.pending = Some(ticket);
                (Reply::Accepted, Some(ticket))
            }
            Request::Close { .. } => {
                self.remove();
                (Reply::Closed, None)
            }
            Request::Navigate { address, .. } => {
                let reply = match self.view.as_ref() {
                    Some((controller, view @ View::Visible { .. })) => {
                        match controller.navigate(address) {
                            Ok(()) => Self::projection(*view, controller.history()), // Pane exists; does not promise a loaded page.
                            Err(ControllerError::Denied) => Reply::Denied,
                            Err(ControllerError::Unavailable) => {
                                self.remove();
                                Reply::Unavailable
                            }
                        }
                    }
                    _ => Reply::Denied,
                };
                (reply, None)
            }
            Request::Back { .. } => (self.history_action(HistoryAction::Back), None),
            Request::Forward { .. } => (self.history_action(HistoryAction::Forward), None),
            Request::Reload { .. } => (self.history_action(HistoryAction::Reload), None),
            Request::Present { .. } => (Reply::Denied, None),
        }
    }

    fn history_action(&mut self, action: HistoryAction) -> Reply {
        let Some((controller, view @ View::Visible { .. })) = self.view.as_ref() else {
            return Reply::Denied;
        };
        let snapshot = controller.history();
        if (action == HistoryAction::Back && !snapshot.can_back)
            || (action == HistoryAction::Forward && !snapshot.can_forward)
        {
            return Reply::Denied;
        }
        match controller.history_action(action) {
            Ok(()) => Self::projection(*view, controller.history()),
            Err(ControllerError::Denied) => Reply::Denied,
            Err(ControllerError::Unavailable) => {
                self.remove();
                Reply::Unavailable
            }
        }
    }

    /// Complete only an admitted present. Old completion can never reopen a pane.
    pub(crate) fn complete(
        &mut self,
        ticket: Pending,
        result: Result<C, ControllerError>,
    ) -> Reply {
        if self.admission != Admission::ClosedFixture
            || self.pending != Some(ticket)
            || ticket.generation != self.generation
        {
            if let Ok(mut controller) = result {
                controller.close();
            }
            return Reply::Denied;
        }
        self.pending = None;
        match result {
            Ok(controller) => {
                self.view = Some((controller, View::Hidden));
                let reply = self.apply_layout();
                if reply == Reply::Unavailable && self.view.is_some() {
                    self.remove();
                }
                reply
            }
            Err(error) => {
                // Keep this generation available for the client's matching Close.
                match error {
                    ControllerError::Denied => Reply::Denied,
                    ControllerError::Unavailable => Reply::Unavailable,
                }
            }
        }
    }
}

impl<C: Controller> Drop for RequestOwner<C> {
    fn drop(&mut self) {
        if let Some((mut controller, _)) = self.view.take() {
            controller.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, rc::Rc};

    struct Fake {
        closed: Rc<Cell<usize>>,
        navigations: Cell<usize>,
    }
    impl Controller for Fake {
        type Layout = Option<(u32, u32)>;
        fn address_admitted(address: &str) -> bool {
            address == "fixture-address"
        }
        fn layout_admitted(layout: Self::Layout) -> bool {
            layout.is_some()
        }
        fn apply_layout(&mut self, layout: Self::Layout) -> Result<View, ControllerError> {
            Ok(
                layout.map_or(View::Hidden, |(width_px, height_px)| View::Visible {
                    width_px,
                    height_px,
                }),
            )
        }
        fn navigate(&self, address: &str) -> Result<(), ControllerError> {
            if !Self::address_admitted(address) {
                return Err(ControllerError::Denied);
            }
            self.navigations.set(self.navigations.get() + 1);
            Ok(())
        }
        fn history(&self) -> History {
            History {
                can_back: self.navigations.get() > 0,
                can_forward: false,
            }
        }
        fn history_action(&self, action: HistoryAction) -> Result<(), ControllerError> {
            match action {
                HistoryAction::Back if self.navigations.get() > 0 => self.navigations.set(0),
                HistoryAction::Reload => {}
                _ => return Err(ControllerError::Denied),
            }
            Ok(())
        }
        fn close(&mut self) {
            self.closed.set(self.closed.get() + 1);
        }
    }
    fn fake(closed: &Rc<Cell<usize>>) -> Fake {
        Fake {
            closed: closed.clone(),
            navigations: Cell::new(0),
        }
    }
    fn present(generation: u64) -> Request<'static> {
        Request::Present {
            generation,
            address: "fixture-address",
        }
    }
    fn navigate(generation: u64) -> Request<'static> {
        Request::Navigate {
            generation,
            address: "fixture-address",
        }
    }

    #[test]
    fn admission_combines_capability_address_and_native_layout() {
        let mut owner = RequestOwner::<Fake>::new(Admission::Disabled, Some((600, 480)));
        assert_eq!(owner.request(present(0)), (Reply::Unavailable, None));
        let mut owner = RequestOwner::<Fake>::new(Admission::ClosedFixture, None);
        assert_eq!(owner.request(present(0)), (Reply::Denied, None));
        owner.set_layout(Some((600, 480)));
        assert_eq!(
            owner.request(Request::Present {
                generation: 0,
                address: "unapproved"
            }),
            (Reply::Denied, None)
        );
        assert_eq!(owner.request(present(0)).0, Reply::Accepted);
        assert_eq!(owner.request(present(0)), (Reply::Denied, None));
    }

    #[test]
    fn only_current_completion_can_present_and_closed_controller_is_dropped_once() {
        let closed = Rc::new(Cell::new(0));
        let mut owner = RequestOwner::<Fake>::new(Admission::ClosedFixture, Some((600, 480)));
        let old = owner.request(present(0)).1.unwrap();
        assert_eq!(owner.request(navigate(0)).0, Reply::Denied);
        assert_eq!(
            owner.request(Request::Close { generation: 0 }).0,
            Reply::Closed
        );
        let fresh = owner.request(present(1)).1.unwrap();
        assert_eq!(owner.complete(old, Ok(fake(&closed))), Reply::Denied);
        assert_eq!(
            owner.complete(fresh, Ok(fake(&closed))),
            Reply::Presented {
                width_px: 600,
                height_px: 480,
                can_back: false,
                can_forward: false
            }
        );
        assert_eq!(closed.get(), 1);
        assert_eq!(
            owner.request(Request::Close { generation: 0 }).0,
            Reply::Denied
        );
        assert!(matches!(
            owner.request(navigate(1)).0,
            Reply::Presented { .. }
        ));
        assert_eq!(owner.set_layout(None), Reply::Unavailable);
        assert_eq!(owner.request(navigate(1)).0, Reply::Denied);
        assert_eq!(
            owner.request(Request::Back { generation: 1 }).0,
            Reply::Denied
        );
        assert_eq!(
            owner.request(Request::Forward { generation: 1 }).0,
            Reply::Denied
        );
        assert_eq!(
            owner.request(Request::Reload { generation: 1 }).0,
            Reply::Denied
        );
        owner.revoke();
        drop(owner);
        assert_eq!(closed.get(), 2);
    }

    #[test]
    fn occlusion_revokes_pending_ticket_and_invalid_viewport_never_presents() {
        let closed = Rc::new(Cell::new(0));
        let mut owner = RequestOwner::<Fake>::new(Admission::ClosedFixture, Some((600, 480)));
        let ticket = owner.request(present(0)).1.unwrap();
        assert_eq!(owner.set_layout(None), Reply::Closed);
        assert_eq!(owner.complete(ticket, Ok(fake(&closed))), Reply::Denied);
        owner.set_layout(Some((50, 480)));
        let oversized = owner.request(present(1)).1.unwrap();
        assert_eq!(
            owner.complete(oversized, Ok(fake(&closed))),
            Reply::Unavailable
        );
        assert_eq!(closed.get(), 2);
    }

    #[test]
    fn failed_generation_cannot_reopen_from_duplicate_completion() {
        let closed = Rc::new(Cell::new(0));
        let mut owner = RequestOwner::<Fake>::new(Admission::ClosedFixture, Some((600, 480)));
        let first = owner.request(present(0)).1.unwrap();
        assert_eq!(
            owner.complete(first, Err(ControllerError::Unavailable)),
            Reply::Unavailable
        );
        let retry = owner.request(present(0)).1.unwrap();
        assert_eq!(owner.complete(first, Ok(fake(&closed))), Reply::Denied);
        assert!(matches!(
            owner.complete(retry, Ok(fake(&closed))),
            Reply::Presented { .. }
        ));
        assert_eq!(closed.get(), 1);
    }
    #[test]
    fn history_actions_require_current_visible_controller_and_native_affordance() {
        let closed = Rc::new(Cell::new(0));
        let mut owner = RequestOwner::<Fake>::new(Admission::ClosedFixture, Some((600, 480)));
        let ticket = owner.request(present(0)).1.unwrap();
        assert_eq!(
            owner.request(Request::Reload { generation: 0 }).0,
            Reply::Denied
        );
        owner.complete(ticket, Ok(fake(&closed)));
        assert_eq!(
            owner.request(Request::Back { generation: 0 }).0,
            Reply::Denied
        );
        assert_eq!(
            owner.request(Request::Forward { generation: 0 }).0,
            Reply::Denied
        );
        assert!(matches!(
            owner.request(navigate(0)).0,
            Reply::Presented { can_back: true, .. }
        ));
        assert!(matches!(
            owner.request(Request::Reload { generation: 0 }).0,
            Reply::Presented { can_back: true, .. }
        ));
        assert!(matches!(
            owner.request(Request::Back { generation: 0 }).0,
            Reply::Presented {
                can_back: false,
                ..
            }
        ));
        owner.request(Request::Close { generation: 0 });
        assert_eq!(
            owner.request(Request::Reload { generation: 0 }).0,
            Reply::Denied
        );
    }
}
