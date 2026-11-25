//! Admission lifetimes and platform-protected seed format for native WAN hosts.
use aerift_transfer::{ErrorCode, PeerId, TransferError};
use ring::rand::{SecureRandom, SystemRandom};
use tokio::time::{Instant, sleep_until};
use tokio_util::sync::CancellationToken;

use crate::SecretStore;

const SEED_DOMAIN: &[u8] = b"aerift/remote-wan/endpoint-seed/1\0";

/// Native hosts must hold their platform's exclusive profile lock and provide
/// the dedicated protected store. Never pass a preference or WebView store.
pub fn load_wan_endpoint_seed(
    store: &(impl SecretStore + ?Sized),
    owner: PeerId,
) -> Result<[u8; 32], TransferError> {
    let mut prefix = SEED_DOMAIN.to_vec();
    prefix.extend(owner.to_string().as_bytes());
    let record = match store.load()? {
        Some(record) => record,
        None => {
            let mut candidate = [0; 32];
            SystemRandom::new()
                .fill(&mut candidate)
                .map_err(|_| ErrorCode::StorageFailed)?;
            if candidate == [0; 32] {
                return Err(ErrorCode::StorageFailed.into());
            }
            let mut record = prefix.clone();
            record.extend(candidate);
            store.initialize(&record)?
        }
    };
    let seed: [u8; 32] = record
        .strip_prefix(prefix.as_slice())
        .and_then(|seed| seed.try_into().ok())
        .ok_or(ErrorCode::StorageFailed)?;
    if seed == [0; 32] {
        return Err(ErrorCode::StorageFailed.into());
    }
    Ok(seed)
}

/// Session-bound authority to present a single outer stream to inner TLS.
/// An accepted route is never a pairing grant or acceptance of a file.
pub struct WanRoutePermit {
    peer: PeerId,
    stopped: CancellationToken,
    live: CancellationToken,
    deadline: Option<Instant>,
}
impl WanRoutePermit {
    pub(crate) fn new(
        peer: PeerId,
        stopped: CancellationToken,
        live: CancellationToken,
        deadline: Option<Instant>,
    ) -> Self {
        Self {
            peer,
            stopped,
            live,
            deadline,
        }
    }

    pub fn peer(&self) -> PeerId {
        self.peer
    }

    pub(crate) fn pairing_only(&self) -> bool {
        self.deadline.is_some()
    }

    pub fn is_closed(&self) -> bool {
        self.is_closed_at(Instant::now())
    }

    pub(crate) fn is_closed_at(&self, now: Instant) -> bool {
        self.stopped.is_cancelled()
            || self.live.is_cancelled()
            || self.deadline.is_some_and(|deadline| now >= deadline)
    }

    #[cfg(test)]
    pub(crate) fn deadline(&self) -> Option<Instant> {
        self.deadline
    }

    pub async fn closed(&self) {
        let age = async {
            match self.deadline {
                Some(at) => sleep_until(at).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            _ = self.stopped.cancelled() => {}
            _ = self.live.cancelled() => {}
            _ = age => {}
        }
    }
}
