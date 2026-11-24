//! Short authenticated comparison. The displayed digits are not credentials and
//! never leave the endpoints. The peer certificate identities remain authoritative.
use aerift_transfer::{ErrorCode, PeerId, TransferError};
use serde::{Deserialize, Serialize};
use std::{
    net::SocketAddr,
    sync::Mutex,
    time::{Duration, SystemTime},
};
use tokio::{
    sync::watch,
    time::{Instant, timeout_at},
};
use uuid::Uuid;

use crate::{Device, Pairing, Platform, pairing::valid_name};

pub(crate) const START: &str = "/v2/nearby-pair/start";
pub(crate) const FINISH: &str = "/v2/nearby-pair/finish";
pub(crate) const EXPORTER: &[u8] = b"EXPORTER-AeRift-Nearby-v2";
pub(crate) const TTL: Duration = Duration::from_secs(120);

#[derive(Clone)]
pub struct NearbyPending {
    pub id: Uuid,
    pub device: Device,
    pub verification: String,
    pub expires_at: SystemTime,
    pub approved: bool,
}

/// Only the initiating native host retains the socket hint. Never expose it to UI.
#[derive(Clone)]
pub struct NearbyChallenge {
    pending: NearbyPending,
    pub(crate) endpoint: SocketAddr,
}
impl std::ops::Deref for NearbyChallenge {
    type Target = NearbyPending;
    fn deref(&self) -> &Self::Target {
        &self.pending
    }
}
impl NearbyChallenge {
    pub fn matches_endpoint(&self, endpoint: SocketAddr) -> bool {
        self.endpoint == endpoint
    }
    pub(crate) fn new(started: Started, endpoint: SocketAddr, verification: String) -> Self {
        Self {
            endpoint,
            pending: NearbyPending {
                id: started.id,
                device: started.device,
                verification,
                approved: false,
                expires_at: SystemTime::now() + TTL,
            },
        }
    }
}

#[derive(Serialize, Deserialize)]
pub(crate) struct Start {
    pub name: String,
    pub platform: Platform,
}
#[derive(Serialize, Deserialize)]
pub(crate) struct Started {
    pub id: Uuid,
    pub device: Device,
}
#[derive(Serialize, Deserialize)]
pub(crate) struct Finish {
    pub id: Uuid,
    pub accept: bool,
}

struct Entry {
    pending: NearbyPending,
    deadline: Instant,
    decision: watch::Sender<Option<bool>>,
    complete: bool,
}
pub(crate) struct Nearby {
    entry: Mutex<Option<Entry>>,
    pending: watch::Sender<Option<NearbyPending>>,
}
impl Nearby {
    pub fn new() -> Self {
        Self {
            entry: Mutex::new(None),
            pending: watch::channel(None).0,
        }
    }
    pub fn subscribe(&self) -> watch::Receiver<Option<NearbyPending>> {
        self.pending.subscribe()
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Entry>> {
        self.entry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
    fn clear(&self, entry: &mut Option<Entry>) {
        if let Some(entry) = entry.take() {
            entry.decision.send_replace(Some(false));
        }
        self.pending.send_replace(None);
    }
    fn expire_locked(&self, entry: &mut Option<Entry>) {
        if entry
            .as_ref()
            .is_some_and(|entry| Instant::now() >= entry.deadline)
        {
            self.clear(entry);
        }
    }
    pub fn expire(&self) {
        self.expire_locked(&mut self.lock());
    }
    pub fn cancel(&self, peer: Option<PeerId>) {
        let mut lock = self.lock();
        if peer.is_none()
            || lock
                .as_ref()
                .is_some_and(|entry| Some(entry.pending.device.id) == peer)
        {
            self.clear(&mut lock);
        }
    }
    pub fn start(
        &self,
        start: Start,
        peer: PeerId,
        pairing: &Pairing,
        verification: String,
    ) -> Result<Started, TransferError> {
        if peer == pairing.device().id || pairing.is_trusted(peer) || !valid_name(&start.name) {
            return Err(ErrorCode::PairingRejected.into());
        }
        let mut lock = self.lock();
        self.expire_locked(&mut lock);
        if lock.as_ref().is_some_and(|entry| !entry.complete) {
            return Err(ErrorCode::PairingRejected.into());
        }
        let pending = NearbyPending {
            id: Uuid::new_v4(),
            device: Device {
                id: peer,
                name: start.name,
                platform: start.platform,
            },
            verification,
            approved: false,
            expires_at: SystemTime::now() + TTL,
        };
        *lock = Some(Entry {
            pending: pending.clone(),
            deadline: Instant::now() + TTL,
            decision: watch::channel(None).0,
            complete: false,
        });
        self.pending.send_replace(Some(pending.clone()));
        Ok(Started {
            id: pending.id,
            device: pairing.device().clone(),
        })
    }
    pub fn confirm(&self, id: Uuid, accept: bool) -> Result<(), TransferError> {
        let mut lock = self.lock();
        self.expire_locked(&mut lock);
        let entry = lock
            .as_mut()
            .filter(|entry| entry.pending.id == id && !entry.complete)
            .ok_or(ErrorCode::PairingExpired)?;
        if !accept {
            self.clear(&mut lock);
            return Ok(());
        }
        entry.pending.approved = true;
        entry.decision.send_replace(Some(true));
        self.pending.send_replace(Some(entry.pending.clone()));
        Ok(())
    }
    pub async fn finish(
        &self,
        peer: PeerId,
        finish: Finish,
        pairing: &Pairing,
    ) -> Result<Option<Device>, TransferError> {
        let matches =
            |entry: &&mut Entry| entry.pending.id == finish.id && entry.pending.device.id == peer;
        let (mut decision, deadline) = {
            let mut lock = self.lock();
            self.expire_locked(&mut lock);
            let entry = lock
                .as_mut()
                .filter(matches)
                .ok_or(ErrorCode::PairingExpired)?;
            if !finish.accept {
                if !entry.complete {
                    self.clear(&mut lock);
                }
                return Ok(None);
            }
            (entry.decision.subscribe(), entry.deadline)
        };
        let approval = timeout_at(deadline, decision.wait_for(|decision| decision.is_some()))
            .await
            .map_err(|_| ErrorCode::PairingExpired)?
            .map_err(|_| ErrorCode::PairingRejected)?;
        if *approval != Some(true) {
            return Err(ErrorCode::PairingRejected.into());
        }
        drop(approval);
        let mut lock = self.lock();
        self.expire_locked(&mut lock);
        let entry = lock
            .as_mut()
            .filter(matches)
            .ok_or(ErrorCode::PairingExpired)?;
        if !entry.complete {
            pairing.record_remote(entry.pending.device.clone())?;
            entry.complete = true;
            self.pending.send_replace(None);
        } else if !pairing.is_trusted(peer) {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        Ok(Some(pairing.device().clone()))
    }
}

pub(crate) fn context(initiator: PeerId, responder: PeerId) -> Vec<u8> {
    // TLS 1.3's exporter creation precedes client CertificateVerify; explicitly
    // bind both ordered certificate fingerprints in the exporter context.
    format!("{initiator}:{responder}").into_bytes()
}
pub(crate) fn digits(bytes: [u8; 8]) -> String {
    format!("{:06}", u64::from_be_bytes(bytes) % 1_000_000)
}
