//! Person identities and specifically scoped sender-owned offer selection.
//! Only use authenticated peer IDs from the Remote transport in host adapters.

mod authority;
mod book;
mod file_window;
mod payload;
mod wire;

pub use authority::{
    DeviceEnrollment, FriendAcceptance, FriendApproval, FriendAuthority, FriendInvitation,
    FriendRecord, PersonId,
};
pub use book::{
    FriendBook, FriendClaim, FriendContactView, FriendControlObject, FriendDecision,
    FriendIncomingOffer, FriendInviteEndpoint, FriendInviteState, FriendObjectKind, FriendStore,
};

pub use payload::FriendPayloadEndpoint;
pub use wire::FriendOfferEndpoint;

pub use file_window::{FriendFileRoute, FriendFileWindow};
