//! Native AeRift v1 discovery, identity, pairing, and TLS transport host.

mod discovery;
mod friends;
mod identity;
mod nearby;
mod network;
mod pairing;
mod remote;

pub use discovery::{DiscoveredPeer, Discovery, SERVICE_TYPE};
pub use friends::*;
pub use identity::{Identity, SecretStore};
pub use network::{NearbyAmbientHook, PeerNode, PinnedEndpoint, RemoteRoute, RoutedPinnedEndpoint};
pub use pairing::{Device, InvitationCode, Pairing, PendingPairing, Platform, TrustStore};

pub use nearby::{NearbyChallenge, NearbyPending};
pub use remote::{RemotePeerNode, RemoteTrustStore};
