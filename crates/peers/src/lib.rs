//! Native AeRift v1 discovery, identity, pairing, and TLS transport host.

mod discovery;
mod identity;
mod network;
mod pairing;

pub use discovery::{DiscoveredPeer, Discovery, SERVICE_TYPE};
pub use identity::{Identity, SecretStore};
pub use network::{PeerNode, PinnedEndpoint};
pub use pairing::{Device, InvitationCode, Pairing, PendingPairing, Platform, TrustStore};
