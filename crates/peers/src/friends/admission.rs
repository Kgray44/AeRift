//! Private invitation control, intentionally separate from Friends offer control.
//! Nothing is listed or accepted unless an operator first registers one exact
//! expiring invite and shares it out of band with its intended recipient.
use std::{net::SocketAddr, sync::Arc, time::Duration};

use aerift_transfer::{ErrorCode, PeerId, TransferError};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{Method, Request, Response, Version, body::Incoming};
use serde::{Deserialize, Serialize};
use tokio::{net::TcpListener, time::timeout};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::super::{
    DeviceEnrollment, FriendAcceptance, FriendApproval, FriendAuthority, FriendInvitation,
    FriendRecord,
    wire::{response, scoped_client, serve_scoped, wall_clock},
};
use super::FriendBook;
use crate::Identity;

const ALPN: &[u8] = b"aerift-friends-invite/1";
const CONSENT: &str = "/friends/v1/admission/consent";
const ENROLL: &str = "/friends/v1/admission/enroll";
const OUTCOME: &str = "/friends/v1/admission/outcome";
const MAX_PENDING: usize = 32;
const CONTROL_BYTES: usize = 1024;
const READ_BUDGET: Duration = Duration::from_secs(10);

pub struct FriendInviteEndpoint;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FriendInviteState {
    AwaitingRecipient,
    RecipientConsented,
    Confirmed,
}

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct PendingInvite {
    invite: FriendInvitation,
    consent: Option<FriendAcceptance>,
    approval: Option<FriendApproval>,
}

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct PendingEnrollment {
    ticket: Uuid,
    local: PeerId,
    grant: DeviceEnrollment,
    committed: bool,
}

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct RecipientConsent {
    invite: FriendInvitation,
    proof: FriendAcceptance,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct InviteControl {
    nonce: Uuid,
    consent: Option<FriendAcceptance>,
}

impl FriendInviteEndpoint {
    /// Only privately shared, user-verified contact cards should reach this API.
    /// Issuing an invitation does not grant friendship, even temporarily.
    pub fn issue(
        authority: &FriendAuthority,
        identity: &Identity,
        book: &FriendBook,
        recipient_card: &str,
        now: u64,
    ) -> Result<FriendInvitation, TransferError> {
        let invite = authority.invite_contact(identity.id(), recipient_card, now)?;
        book.mutate(|state| {
            if state.owner != invite.issuer {
                return Err(ErrorCode::PeerUntrusted.into());
            }
            state.invites.retain(|row| row.invite.verify(now).is_ok());
            if state.invites.len() >= MAX_PENDING
                || state.used.contains(&invite.id())
                || state.friends.iter().any(|f| {
                    f.person == invite.recipient || f.devices.contains(&invite.recipient_device)
                })
            {
                return Err(ErrorCode::Conflict.into());
            }
            state.invites.push(PendingInvite {
                invite: invite.clone(),
                consent: None,
                approval: None,
            });
            Ok(())
        })?;
        Ok(invite)
    }

    /// Recipient invokes only after explicit comparison and consent. It sends a
    /// signed acceptance to the exact issuer endpoint pinned by the invitation.
    pub async fn consent(
        authority: &FriendAuthority,
        identity: &Identity,
        book: &FriendBook,
        routes: &[SocketAddr],
        invite: &FriendInvitation,
        now: u64,
    ) -> Result<(), TransferError> {
        let proof = authority.accept(invite, invite.issuer_device, identity.id(), now)?;
        book.mutate(|state| {
            if state.owner != invite.recipient {
                return Err(ErrorCode::PeerUntrusted.into());
            }
            state
                .consent_drafts
                .retain(|draft| draft.invite.verify(now).is_ok());
            if let Some(existing) = state
                .consent_drafts
                .iter()
                .find(|draft| draft.invite.id() == invite.id())
            {
                if &existing.invite != invite || existing.proof != proof {
                    return Err(ErrorCode::Conflict.into());
                }
                return Ok(());
            }
            if state.consent_drafts.len() >= MAX_PENDING || state.used.contains(&invite.id()) {
                return Err(ErrorCode::Conflict.into());
            }
            state.consent_drafts.push(RecipientConsent {
                invite: invite.clone(),
                proof: proof.clone(),
            });
            Ok(())
        })?;
        scoped_client(
            identity,
            routes,
            invite.issuer_device,
            CONSENT,
            InviteControl {
                nonce: invite.id(),
                consent: Some(proof),
            },
            ALPN,
        )
        .await
    }

    /// Local-only snapshot for the issuer's confirmation prompt. Never register
    /// this method as a network operation or query by address/name.
    pub fn local_state(
        identity: &Identity,
        book: &FriendBook,
        nonce: Uuid,
        now: u64,
    ) -> Result<FriendInviteState, TransferError> {
        let state = book.read()?;
        let row = state
            .invites
            .iter()
            .find(|row| row.invite.id() == nonce && row.invite.issuer_device == identity.id())
            .ok_or(ErrorCode::PairingRejected)?;
        row.invite.verify(now)?;
        if row.approval.is_some() {
            if state.friends.iter().any(|f| {
                f.person == row.invite.recipient
                    && f.relationship == row.invite.id()
                    && f.devices.contains(&row.invite.recipient_device)
            }) {
                return Ok(FriendInviteState::Confirmed);
            }
            return Err(ErrorCode::PairingRejected.into());
        }
        Ok(if row.consent.is_some() {
            FriendInviteState::RecipientConsented
        } else {
            FriendInviteState::AwaitingRecipient
        })
    }

    /// Issuer uses this explicitly after examining the authenticated request.
    /// The grant and signed approval commit atomically in the same protected book.
    pub fn approve(
        authority: &FriendAuthority,
        identity: &Identity,
        book: &FriendBook,
        nonce: Uuid,
        now: u64,
    ) -> Result<(), TransferError> {
        book.mutate(|state| {
            let index = state
                .invites
                .iter()
                .position(|row| row.invite.id() == nonce)
                .ok_or(ErrorCode::PairingRejected)?;
            let invite = state.invites[index].clone();
            let consent = invite.consent.as_ref().ok_or(ErrorCode::PairingRejected)?;
            if invite.invite.issuer_device != identity.id() || authority.id() != state.owner {
                return Err(ErrorCode::PeerUntrusted.into());
            }
            let approval =
                authority.confirm(&invite.invite, consent, invite.invite.recipient_device, now)?;
            let record = FriendRecord::verify(
                &invite.invite,
                consent,
                &approval,
                authority.id(),
                identity.id(),
                invite.invite.recipient_device,
                now,
            )?;
            if invite.approval.is_some() {
                if state.friends.iter().any(|f| {
                    f.person == record.person
                        && f.relationship == record.nonce
                        && f.devices.contains(&record.primary)
                }) {
                    return Ok(());
                }
                return Err(ErrorCode::PairingRejected.into());
            }
            FriendBook::add_record(state, record, now)?;
            state.invites[index].approval = Some(approval);
            Ok(())
        })
    }

    /// Decline a still-pending issuer invite without affecting existing friends.
    pub fn decline(book: &FriendBook, nonce: Uuid) -> Result<(), TransferError> {
        book.mutate(|state| {
            let index = state
                .invites
                .iter()
                .position(|row| row.invite.id() == nonce && row.approval.is_none())
                .ok_or(ErrorCode::PairingRejected)?;
            state.invites.remove(index);
            Ok(())
        })
    }

    /// Retrieve the dual signed transcript and commit the reciprocal friend
    /// grant. An exact retry is safe, but a removed grant cannot be replayed.
    pub async fn finish(
        authority: &FriendAuthority,
        identity: &Identity,
        book: &FriendBook,
        routes: &[SocketAddr],
        invite: &FriendInvitation,
        now: u64,
    ) -> Result<bool, TransferError> {
        invite.verify(now)?;
        if invite.recipient != authority.id() || invite.recipient_device != identity.id() {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        let consent = book
            .read()?
            .consent_drafts
            .into_iter()
            .find(|draft| &draft.invite == invite)
            .ok_or(ErrorCode::PairingRejected)?
            .proof;
        consent.verify(invite)?;
        let approval: Option<FriendApproval> = scoped_client(
            identity,
            routes,
            invite.issuer_device,
            OUTCOME,
            InviteControl {
                nonce: invite.id(),
                consent: None,
            },
            ALPN,
        )
        .await?;
        let Some(approval) = approval else {
            return Ok(false);
        };
        let now = wall_clock()?;
        let grant = FriendRecord::verify(
            invite,
            &consent,
            &approval,
            authority.id(),
            identity.id(),
            invite.issuer_device,
            now,
        )?;
        book.mutate(|state| {
            if state.owner != grant.owner
                || !state
                    .consent_drafts
                    .iter()
                    .any(|draft| &draft.invite == invite && draft.proof == consent)
            {
                return Err(ErrorCode::PeerUntrusted.into());
            }
            if state.friends.iter().any(|f| {
                f.person == grant.person
                    && f.relationship == grant.nonce
                    && f.devices.contains(&grant.primary)
            }) {
                return Ok(true);
            }
            FriendBook::add_record(state, grant, now)?;
            Ok(true)
        })
    }

    /// Local user has examined an exact device grant signed by the known
    /// person's root and explicitly approves enrollment, pending proof this
    /// new TLS device actually holds the corresponding private key. The ticket
    /// is intentionally shared only with that device; it grants no authority alone.
    pub fn expect_device(
        identity: &Identity,
        book: &FriendBook,
        grant: DeviceEnrollment,
        now: u64,
    ) -> Result<Uuid, TransferError> {
        if grant.device == identity.id() {
            return Err(ErrorCode::PairingRejected.into());
        }
        grant.verify(grant.device, now)?;
        book.mutate(|state| {
            let allowed = state.friends.iter().any(|f| {
                f.person == grant.person
                    && f.relationship == grant.relationship
                    && !f.devices.contains(&grant.device)
                    && !f.revoked.contains(&grant.device)
            });
            if !allowed {
                return Err(ErrorCode::PairingRejected.into());
            }
            state
                .enrollments
                .retain(|r| r.grant.verify(r.grant.device, now).is_ok());
            if state.enrollments.len() >= MAX_PENDING {
                return Err(ErrorCode::Conflict.into());
            }
            let ticket = Uuid::new_v4();
            state.enrollments.push(PendingEnrollment {
                ticket,
                grant,
                local: identity.id(),
                committed: false,
            });
            Ok(ticket)
        })
    }

    /// Prove possession of the exact locally pre-authorized new certificate.
    pub async fn prove_device(
        identity: &Identity,
        routes: &[SocketAddr],
        receiver: PeerId,
        ticket: Uuid,
    ) -> Result<(), TransferError> {
        scoped_client(
            identity,
            routes,
            receiver,
            ENROLL,
            InviteControl {
                nonce: ticket,
                consent: None,
            },
            ALPN,
        )
        .await
    }

    /// Explicitly started with private route and independent ALPN. There is no
    /// invitation collection endpoint or generic trust-discovery operation.
    pub async fn serve(
        identity: &Identity,
        listener: TcpListener,
        book: Arc<FriendBook>,
        shutdown: CancellationToken,
    ) -> Result<(), TransferError> {
        serve_scoped(identity, listener, book, shutdown, ALPN, dispatch).await
    }
}

async fn dispatch(
    request: Request<Incoming>,
    authenticated: PeerId,
    issuer: PeerId,
    book: Arc<FriendBook>,
) -> Response<Full<Bytes>> {
    let deny = |code: ErrorCode| response::<()>(Err(code.into()));
    let submit = request.uri().path() == CONSENT;
    let enroll = request.uri().path() == ENROLL;
    if request.method() != Method::POST
        || request.version() != Version::HTTP_11
        || request.uri().query().is_some()
        || (!submit && !enroll && request.uri().path() != OUTCOME)
    {
        return deny(ErrorCode::InvalidRequest);
    }
    let Ok(Ok(data)) = timeout(
        READ_BUDGET,
        Limited::new(request.into_body(), CONTROL_BYTES).collect(),
    )
    .await
    else {
        return deny(ErrorCode::InvalidRequest);
    };
    let Ok(wire) = serde_json::from_slice::<InviteControl>(&data.to_bytes()) else {
        return deny(ErrorCode::InvalidRequest);
    };
    if submit != wire.consent.is_some() {
        return deny(ErrorCode::InvalidRequest);
    }
    let Ok(now) = wall_clock() else {
        return deny(ErrorCode::InternalError);
    };
    if enroll {
        return response(book.mutate(|state| {
            let idx = state
                .enrollments
                .iter()
                .position(|row| {
                    row.ticket == wire.nonce
                        && row.local == issuer
                        && row.grant.device == authenticated
                })
                .ok_or(ErrorCode::PairingRejected)?;
            let row = state.enrollments[idx].clone();
            row.grant.verify(authenticated, now)?;
            if row.committed {
                if state.friends.iter().any(|f| {
                    f.person == row.grant.person
                        && f.relationship == row.grant.relationship
                        && f.devices.contains(&authenticated)
                }) {
                    return Ok(());
                }
                return Err(ErrorCode::PairingRejected.into());
            }
            FriendBook::enroll_record(state, &row.grant, authenticated, now)?;
            state.enrollments[idx].committed = true;
            Ok(())
        }));
    }
    let matches = |row: &PendingInvite| {
        row.invite.id() == wire.nonce
            && row.invite.recipient_device == authenticated
            && row.invite.issuer_device == issuer
            && row.invite.verify(now).is_ok()
    };
    if let Some(consent) = wire.consent {
        return response(book.mutate(|state| {
            let row = state
                .invites
                .iter_mut()
                .find(|row| matches(row))
                .ok_or(ErrorCode::PairingRejected)?;
            consent.verify(&row.invite)?;
            if row.approval.is_some()
                && !state.friends.iter().any(|f| {
                    f.person == row.invite.recipient
                        && f.relationship == row.invite.id()
                        && f.devices.contains(&authenticated)
                })
            {
                return Err(ErrorCode::PairingRejected.into());
            }
            if row.consent.as_ref().is_some_and(|old| old != &consent) {
                return Err(ErrorCode::Conflict.into());
            }
            row.consent = Some(consent);
            Ok(())
        }));
    }
    response(book.read().and_then(|state| {
        let row = state
            .invites
            .iter()
            .find(|row| matches(row))
            .ok_or(ErrorCode::PairingRejected)?;
        if row.consent.is_none()
            || (row.approval.is_some()
                && !state.friends.iter().any(|f| {
                    f.person == row.invite.recipient
                        && f.relationship == row.invite.id()
                        && f.devices.contains(&authenticated)
                }))
        {
            return Err(ErrorCode::PairingRejected.into());
        }
        Ok(row.approval.clone())
    }))
}
