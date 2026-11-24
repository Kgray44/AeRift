//! AeRift v1 file transport on a peer-authenticated HTTP/1.1 stream.

pub mod ambient;
pub mod ambient_browser;
pub mod ambient_camera;
pub mod ambient_inbox;
mod checkpoint;
mod client;
pub mod folder;
#[cfg(unix)]
mod journal;
mod model;
mod receiver;
mod server;

pub use client::{Connector, Sender, inspect_file_offer};
pub use model::{ErrorCode, Offer, PeerId, State, Status, TransferError};
pub use receiver::{IncomingTransfer, ReceiveLimits, Receiver, TransferKey};
pub use server::{TransferScope, serve, serve_request, serve_scoped_request};

use bytes::Bytes;
use http_body_util::{BodyExt, Limited};
use hyper::body::Incoming;

pub(crate) const RESUMABLE_ROUTE: &str = "/v2/resumable/transfers";
pub(crate) const RESUMABLE_CHUNK_SIZE: usize = 1024 * 1024;

const RECEIVER_READY_ROUTE: &str = "/v1/receiver-ready";

#[derive(serde::Deserialize, serde::Serialize)]
struct ReceiverReady {
    ready: bool,
}

async fn read_control(body: Incoming) -> Result<Bytes, bool> {
    Limited::new(body, model::MAX_CONTROL_BYTES)
        .collect()
        .await
        .map(|body| body.to_bytes())
        .map_err(|error| error.is::<http_body_util::LengthLimitError>())
}

fn parse_id(raw: &str) -> Option<uuid::Uuid> {
    let id = uuid::Uuid::parse_str(raw).ok()?;
    (id.get_version() == Some(uuid::Version::Random)
        && id.get_variant() == uuid::Variant::RFC4122
        && id.to_string() == raw)
        .then_some(id)
}
