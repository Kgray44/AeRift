//! First single-file payload lane. Separate private ALPN, no app enablement.
use std::{net::SocketAddr, path::Path, sync::Arc, time::Duration};

use aerift_transfer::{
    Connector, ErrorCode, Offer, PeerId, Receiver, Sender, Status, TransferError, TransferKey,
    TransferScope, inspect_file_offer, serve_scoped_request,
};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{
    FriendBook, FriendControlObject, FriendObjectKind, PersonId,
    wire::{serve_scoped, wall_clock},
};
use crate::{Identity, RemotePeerNode, network::pinned_endpoint};

const ALPN: &[u8] = b"aerift-friends-payload/1";
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

pub struct FriendPayloadEndpoint;

struct RecipientScope {
    book: Arc<FriendBook>,
    local: PeerId,
}

impl TransferScope for RecipientScope {
    fn admit(&self, key: TransferKey, offer: &Offer) -> Result<(), TransferError> {
        if offer.size_bytes > MAX_FILE_BYTES {
            return Err(ErrorCode::TransferRejected.into());
        }
        self.book.reserve_incoming_payload(self.local, key, offer)
    }

    fn check(&self, key: TransferKey) -> Result<(), TransferError> {
        self.book.check_incoming_payload(self.local, key)
    }

    fn publish(
        &self,
        key: TransferKey,
        action: impl FnOnce() -> Result<Status, TransferError>,
    ) -> Result<Status, TransferError> {
        self.book.with_incoming_payload(self.local, key, action)
    }
}

impl FriendPayloadEndpoint {
    /// Prepare immutable preview metadata from the same shared file manifest
    /// that the eventual data receiver decodes; staging grants no bytes.
    pub async fn stage_file(
        book: &FriendBook,
        person: PersonId,
        device: Option<PeerId>,
        path: &Path,
        name: &str,
        expires: u64,
    ) -> Result<Offer, TransferError> {
        let now = wall_clock()?;
        reject_unsafe_source(path).await?;
        let manifest = inspect_file_offer(Uuid::new_v4(), path, name).await?;
        if manifest.size_bytes > MAX_FILE_BYTES {
            return Err(ErrorCode::InvalidRequest.into());
        }
        let metadata = FriendControlObject::new(
            FriendObjectKind::File,
            manifest.name.clone(),
            manifest.size_bytes,
            expires,
        )?;
        let digest = manifest.manifest_digest()?;
        book.offer(manifest.id, person, device, digest)?;
        if let Err(error) = book.prepare_fanout(manifest.id, metadata, now) {
            let _ = book.withdraw(manifest.id);
            return Err(error);
        }
        Ok(manifest)
    }

    /// Dial only the selected recipient's pinned certificate. Source path comes
    /// from an explicitly staged local object. No automatic retry after payload start.
    pub async fn send_file(
        identity: &Identity,
        book: Arc<FriendBook>,
        routes: &[SocketAddr],
        manifest: &Offer,
        path: &Path,
        cancel: CancellationToken,
        progress: impl Fn(Uuid, Status) + Send + Sync + 'static,
    ) -> Result<Status, TransferError> {
        if routes
            .iter()
            .any(|address| !RemotePeerNode::supports_private_endpoint(*address))
        {
            return Err(ErrorCode::InvalidRequest.into());
        }
        if cancel.is_cancelled() {
            return Err(ErrorCode::Cancelled.into());
        }
        let digest = manifest.manifest_digest()?;
        let winner = book
            .winner(manifest.id)?
            .ok_or(ErrorCode::TransferRejected)?;
        book.authorize_payload(manifest.id, winner, digest)?;
        if manifest.size_bytes > MAX_FILE_BYTES {
            return Err(ErrorCode::InvalidRequest.into());
        }
        reject_unsafe_source(path).await?;
        let recomputed = inspect_file_offer(manifest.id, path, &manifest.name).await?;
        if recomputed != *manifest {
            return Err(ErrorCode::IntegrityFailed.into());
        }
        let endpoint = pinned_endpoint(identity, routes, winner, None, ALPN)?;
        // Do not spend the one-shot reservation for a route whose TLS pin failed.
        let _ = endpoint.connect().await?;
        if cancel.is_cancelled() {
            return Err(ErrorCode::Cancelled.into());
        }
        book.begin_payload(manifest.id, winner, digest)?;
        Sender::new(endpoint, Duration::from_secs(5), Duration::from_secs(60))
            .send_file_guarded(manifest.id, path, &manifest.name, cancel, progress, {
                let id = manifest.id;
                move || book.authorize_payload(id, winner, digest)
            })
            .await
    }

    /// Start only in an isolated listener and receiver state; do not reuse
    /// Nearby/Remote receiver tables or grants. All requests prove TLS possession.
    pub async fn serve(
        identity: &Identity,
        listener: TcpListener,
        book: Arc<FriendBook>,
        receiver: Arc<Receiver>,
        shutdown: CancellationToken,
    ) -> Result<(), TransferError> {
        let stop = shutdown.clone();
        serve_scoped(
            identity,
            listener,
            book,
            shutdown,
            ALPN,
            move |request, peer, local, book| {
                let receiver = receiver.clone();
                let stop = stop.clone();
                async move {
                    serve_scoped_request(
                        request,
                        peer,
                        receiver,
                        stop,
                        &RecipientScope { book, local },
                    )
                    .await
                }
            },
        )
        .await
    }
}

async fn reject_unsafe_source(path: &Path) -> Result<(), TransferError> {
    // Native callers supply opaque, private picker-staged sources. Checking
    // symlink metadata before opening also refuses known FIFOs, devices, and links.
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|_| ErrorCode::StorageFailed)?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return Err(ErrorCode::InvalidRequest.into());
    }
    Ok(())
}
