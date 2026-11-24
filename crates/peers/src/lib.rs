//! Native AeRift v1 discovery, identity, pairing, and TLS transport host.

mod discovery;
mod identity;
mod network;
mod pairing;
mod remote;

pub use discovery::{DiscoveredPeer, Discovery, SERVICE_TYPE};
pub use identity::{Identity, SecretStore};
pub use network::{PeerNode, PinnedEndpoint, RemoteRoute, RoutedPinnedEndpoint};
pub use pairing::{Device, InvitationCode, Pairing, PendingPairing, Platform, TrustStore};

pub use remote::{RemotePeerNode, RemoteTrustStore};
