//! Person identities and specifically scoped sender-owned offer selection.
//! Only use authenticated peer IDs from the Remote transport in host adapters.

mod authority;
mod book;

pub use authority::{
    DeviceEnrollment, FriendAcceptance, FriendApproval, FriendAuthority, FriendInvitation,
    FriendRecord, PersonId,
};
pub use book::{FriendBook, FriendClaim, FriendStore};
