//! Explicit, short-lived Friends file receive window. No discovery or UI assumptions.
use std::{
    net::{Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use aerift_transfer::{
    ErrorCode, Offer, PeerId, ReceiveLimits, Receiver, State, Status, TransferError,
};
use tokio::{net::TcpListener, sync::Mutex};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{
    FriendBook, FriendDecision, FriendIncomingOffer, FriendOfferEndpoint, FriendPayloadEndpoint,
    PersonId, wire::wall_clock,
};
use crate::{Identity, RemotePeerNode};

const WINDOW_SECS: u64 = 300;
const FILE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FriendFileRoute {
    pub offers: SocketAddr,
    pub payload: SocketAddr,
}

impl FriendFileRoute {
    pub fn new(offers: SocketAddr, payload: SocketAddr) -> Result<Self, TransferError> {
        if !RemotePeerNode::supports_private_endpoint(offers)
            || !RemotePeerNode::supports_private_endpoint(payload)
            || offers.ip() != payload.ip()
            || offers.port() == payload.port()
        {
            return Err(ErrorCode::InvalidRequest.into());
        }
        Ok(Self { offers, payload })
    }
}

pub struct FriendFileWindow {
    identity: Arc<Identity>,
    book: Arc<FriendBook>,
    receiver: Arc<Receiver>,
    route: FriendFileRoute,
    expires: u64,
    stop: CancellationToken,
    pending: Mutex<Option<Outbound>>,
}

struct Outbound {
    manifest: Offer,
    source: PathBuf,
    recipients: Vec<(PeerId, FriendFileRoute)>,
    notified: usize,
}

impl Drop for FriendFileWindow {
    fn drop(&mut self) {
        self.stop();
    }
}

impl FriendFileWindow {
    /// Only explicit platform user action should start this window. Callers
    /// supply and retain ownership of the profile's *same* protected FriendBook.
    pub async fn open(
        identity: Arc<Identity>,
        book: Arc<FriendBook>,
        destination: &Path,
        bind: Ipv4Addr,
    ) -> Result<Self, TransferError> {
        if !RemotePeerNode::supports_private_endpoint(SocketAddr::from((bind, 1))) {
            return Err(ErrorCode::InvalidRequest.into());
        }
        let expires = wall_clock()?.saturating_add(WINDOW_SECS);
        let receiver = Arc::new(Receiver::new(
            destination,
            ReceiveLimits {
                session_offers: 8,
                active_bytes: FILE_BYTES,
            },
        )?);
        let a = TcpListener::bind((bind, 0))
            .await
            .map_err(|_| ErrorCode::NetworkError)?;
        let b = TcpListener::bind((bind, 0))
            .await
            .map_err(|_| ErrorCode::NetworkError)?;
        let route = FriendFileRoute::new(
            a.local_addr().map_err(|_| ErrorCode::NetworkError)?,
            b.local_addr().map_err(|_| ErrorCode::NetworkError)?,
        )?;
        let stop = CancellationToken::new();
        let (identity2, book2, receiver2, stop2) = (
            identity.clone(),
            book.clone(),
            receiver.clone(),
            stop.clone(),
        );
        tokio::spawn(async move {
            tokio::select! {
                _ = FriendOfferEndpoint::serve(&identity2, a, book2.clone(), stop2.clone()) => {},
                _ = FriendPayloadEndpoint::serve(&identity2, b, book2.clone(), receiver2, stop2.clone()) => {},
                _ = tokio::time::sleep(Duration::from_secs(WINDOW_SECS)) => {},
            }
            // The departed futures drop their listener/task groups. Never keep
            // the other half in service after expiry or loss of either lane.
            stop2.cancel();
        });
        Ok(Self {
            identity,
            book,
            receiver,
            route,
            expires,
            stop,
            pending: Mutex::new(None),
        })
    }

    pub fn route(&self) -> FriendFileRoute {
        self.route
    }
    pub fn expires_at(&self) -> u64 {
        self.expires
    }
    pub fn is_open(&self) -> bool {
        !self.stop.is_cancelled() && wall_clock().is_ok_and(|now| now < self.expires)
    }
    fn ensure_open(&self) -> Result<u64, TransferError> {
        if !self.is_open() {
            return Err(ErrorCode::Cancelled.into());
        }
        wall_clock()
    }

    pub fn incoming(&self) -> Result<Vec<FriendIncomingOffer>, TransferError> {
        self.book.incoming(self.ensure_open()?)
    }

    pub fn receipts(&self) -> Vec<(PeerId, Uuid, Status)> {
        self.receiver
            .snapshot()
            .into_iter()
            .filter(|entry| entry.status.state == State::Completed)
            .map(|entry| (entry.key.peer, entry.key.id, entry.status))
            .collect()
    }

    /// Deliver consent metadata only. Recipient device is explicitly shown and
    /// pinned; inability to reach it never silently selects another device.
    /// 'path' must originate in a native picker or approved selection registry.
    pub async fn offer(
        &self,
        person: PersonId,
        device: PeerId,
        path: PathBuf,
        route: FriendFileRoute,
    ) -> Result<Uuid, TransferError> {
        self.offer_to_routes(person, Some(device), path, &[(device, route)])
            .await
    }

    /// One offer addressed to a verified person. The routes are explicitly
    /// supplied for that person's individually authorized devices; nothing is
    /// discovered, and an unlisted device has no delivery ticket or claim.
    pub async fn offer_person(
        &self,
        person: PersonId,
        path: PathBuf,
        routes: &[(PeerId, FriendFileRoute)],
    ) -> Result<Uuid, TransferError> {
        self.offer_to_routes(person, None, path, routes).await
    }

    async fn offer_to_routes(
        &self,
        person: PersonId,
        device: Option<PeerId>,
        path: PathBuf,
        routes: &[(PeerId, FriendFileRoute)],
    ) -> Result<Uuid, TransferError> {
        self.ensure_open()?;
        if routes.is_empty() || routes.len() > 32 {
            return Err(ErrorCode::InvalidRequest.into());
        }
        let friend = self
            .book
            .contacts()?
            .into_iter()
            .find(|f| f.person == person)
            .ok_or(ErrorCode::PeerUntrusted)?;
        let mut unique = std::collections::HashSet::new();
        for (device, route) in routes {
            if !unique.insert(*device) {
                return Err(ErrorCode::InvalidRequest.into());
            }
            if !friend.devices.contains(device) {
                return Err(ErrorCode::PeerUntrusted.into());
            }
            FriendFileRoute::new(route.offers, route.payload)?;
        }
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or(ErrorCode::InvalidRequest)?;
        let mut pending = self.pending.try_lock().map_err(|_| ErrorCode::Conflict)?;
        if pending.is_some() {
            return Err(ErrorCode::Conflict.into());
        }
        let manifest = FriendPayloadEndpoint::stage_file(
            &self.book,
            person,
            device,
            &path,
            name,
            self.expires,
        )
        .await?;
        let mut last_error = None;
        let mut notified = 0;
        for (device, route) in routes {
            if !self.is_open() {
                break;
            }
            let now = wall_clock()?;
            let route_list = [route.offers];
            let delivery = tokio::select! {
                result = FriendOfferEndpoint::deliver(&self.identity, &self.book, manifest.id, *device, &route_list, now) => result,
                _ = self.stop.cancelled() => Err(ErrorCode::Cancelled.into()),
            };
            match delivery {
                Ok(()) => notified += 1,
                Err(error) => last_error = Some(error),
            }
        }
        let id = manifest.id;
        if !self.is_open() || (notified == 0 && self.book.winner(id)?.is_none()) {
            self.book.withdraw(id)?;
            return Err(last_error.unwrap_or_else(|| ErrorCode::Cancelled.into()));
        }
        *pending = Some(Outbound {
            manifest,
            source: path,
            recipients: routes.to_vec(),
            notified,
        });
        Ok(id)
    }

    /// Poll only the exact known offer over that issuer's pinned control lane.
    /// Reconciles a losing or withdrawn prompt without requesting an award.
    pub async fn reconcile(
        &self,
        issuer: PeerId,
        id: Uuid,
        route: SocketAddr,
    ) -> Result<FriendDecision, TransferError> {
        let now = self.ensure_open()?;
        if !RemotePeerNode::supports_private_endpoint(route) {
            return Err(ErrorCode::InvalidRequest.into());
        }
        let routes = [route];
        tokio::select! {
            result = FriendOfferEndpoint::refresh_received(&self.identity,&self.book,&routes,issuer,id,now) => result,
            _ = self.stop.cancelled() => Err(ErrorCode::Cancelled.into()),
        }
    }

    pub async fn accept(
        &self,
        issuer: PeerId,
        id: Uuid,
        control_route: SocketAddr,
    ) -> Result<(), TransferError> {
        let now = self.ensure_open()?;
        if !RemotePeerNode::supports_private_endpoint(control_route) {
            return Err(ErrorCode::InvalidRequest.into());
        }
        let route_list = [control_route];
        tokio::select! {
            result = FriendOfferEndpoint::accept_received(&self.identity, &self.book, &route_list, issuer, id, now) => result.map(|_| ()),
            _ = self.stop.cancelled() => Err(ErrorCode::Cancelled.into()),
        }
    }

    pub async fn decline(&self, issuer: PeerId, id: Uuid) -> Result<(), TransferError> {
        let now = self.ensure_open()?;
        self.book
            .update_decision(
                issuer,
                self.identity.id(),
                id,
                now,
                FriendDecision::Withdrawn,
            )
            .map(|_| ())
    }

    // Retain the existing selected-device adapter contract.
    pub fn outgoing(&self) -> Result<Option<(Uuid, PeerId, bool)>, TransferError> {
        let pending = self.pending.try_lock().map_err(|_| ErrorCode::Conflict)?;
        pending
            .as_ref()
            .filter(|entry| entry.recipients.len() == 1)
            .map(|entry| {
                let recipient = entry.recipients[0].0;
                Ok((
                    entry.manifest.id,
                    recipient,
                    self.book.winner(entry.manifest.id)? == Some(recipient),
                ))
            })
            .transpose()
    }

    /// Returns exact route count reported delivered, and only the current
    /// committed winner. Does not infer availability for undelivered devices.
    pub fn outgoing_person(&self) -> Result<Option<(Uuid, usize, Option<PeerId>)>, TransferError> {
        let pending = self.pending.try_lock().map_err(|_| ErrorCode::Conflict)?;
        pending
            .as_ref()
            .map(|entry| {
                let id = entry.manifest.id;
                Ok((id, entry.notified, self.book.winner(id)?))
            })
            .transpose()
    }

    pub async fn send(&self, id: Uuid) -> Result<Status, TransferError> {
        self.ensure_open()?;
        let mut pending = self.pending.try_lock().map_err(|_| ErrorCode::Conflict)?;
        let entry = pending
            .as_ref()
            .filter(|entry| entry.manifest.id == id)
            .ok_or(ErrorCode::InvalidRequest)?;
        let winner = self.book.winner(id)?.ok_or(ErrorCode::TransferRejected)?;
        let route = entry
            .recipients
            .iter()
            .find(|(peer, _)| *peer == winner)
            .map(|(_, route)| route)
            .ok_or(ErrorCode::TransferRejected)?;
        let result = FriendPayloadEndpoint::send_file(
            &self.identity,
            self.book.clone(),
            &[route.payload],
            &entry.manifest,
            &entry.source,
            self.stop.child_token(),
            |_, _| {},
        )
        .await;
        // Never send the same contents a second time from this window. A new
        // offer (with fresh explicit consent) is required after any attempt.
        *pending = None;
        if result.as_ref().map(|s| s.state) != Ok(State::Completed) {
            self.book.withdraw(id)?;
        }
        result
    }

    pub async fn withdraw(&self, id: Uuid) -> Result<(), TransferError> {
        let mut pending = self.pending.try_lock().map_err(|_| ErrorCode::Conflict)?;
        if pending.as_ref().is_none_or(|entry| entry.manifest.id != id) {
            return Err(ErrorCode::InvalidRequest.into());
        }
        self.book.withdraw(id)?;
        *pending = None;
        Ok(())
    }

    /// Cancels active sends and listener tasks; old rows remain non-replayable.
    pub fn stop(&self) {
        self.stop.cancel();
        if let Ok(mut pending) = self.pending.try_lock() {
            if let Some(offer) = pending.take() {
                let _ = self.book.withdraw(offer.manifest.id);
            }
        }
    }
}
