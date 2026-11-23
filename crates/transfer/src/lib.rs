//! AeRift v1 file transport on a peer-authenticated HTTP/1.1 stream.

mod client;
mod model;
mod receiver;
mod server;

pub use client::{Connector, Sender};
pub use model::{ErrorCode, Offer, PeerId, State, Status, TransferError};
pub use receiver::{IncomingTransfer, ReceiveLimits, Receiver, TransferKey};
pub use server::serve;

use bytes::Bytes;
use http_body_util::{BodyExt, Limited};
use hyper::body::Incoming;

async fn read_control(body: Incoming) -> Result<Bytes, bool> {
    Limited::new(body, model::MAX_CONTROL_BYTES)
        .collect()
        .await
        .map(|body| body.to_bytes())
        .map_err(|error| error.is::<http_body_util::LengthLimitError>())
}

fn parse_id(raw: &str) -> Option<uuid::Uuid> {
    let id = uuid::Uuid::parse_str(raw).ok()?;
    (id.get_version() == Some(uuid::Version::Random) && id.to_string() == raw).then_some(id)
}
