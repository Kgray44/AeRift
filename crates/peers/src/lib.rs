//! Native AeRift v1 discovery, identity, pairing, and TLS transport host.

mod discovery;
mod friends;
mod identity;
mod nearby;
mod network;
mod pairing;
mod remote;
mod remote_folder;
mod wan_invitation;
#[cfg(test)]
mod wan_invitation_tests;
mod wan_lifecycle;

pub use discovery::{DiscoveredPeer, Discovery, SERVICE_TYPE};
pub use friends::*;
pub use identity::{Identity, SecretStore};
pub use network::{NearbyAmbientHook, PeerNode, PinnedEndpoint, RemoteRoute, RoutedPinnedEndpoint};
pub use pairing::{Device, InvitationCode, Pairing, PendingPairing, Platform, TrustStore};

pub use nearby::{NearbyChallenge, NearbyPending};
pub use remote::{RemotePeerNode, RemoteTrustStore};

pub use remote_folder::RemoteFolderIngress;
pub use wan_invitation::WanInvitationBinding;

pub use wan_lifecycle::{WanRoutePermit, load_wan_endpoint_seed};
