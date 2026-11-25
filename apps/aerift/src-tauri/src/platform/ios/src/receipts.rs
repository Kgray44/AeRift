use std::{
    collections::HashSet,
    path::{Component, Path},
    sync::Mutex,
};

use aerift_transfer::{ErrorCode, IncomingTransfer, State, TransferError, TransferKey};
use serde::{Deserialize, Serialize};

use crate::IosKeychain;

const MAX_RECEIPTS: usize = 60;
const MAX_RECORDS_BYTES: usize = 96 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerifiedReceipt {
    pub id: String,
    pub name: String,
    pub size_bytes: u64,
    pub leaf: String,
    pub sha256: String,
}

fn hex(text: &str) -> bool {
    text.bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn valid_id(id: &str) -> bool {
    let Some((peer, id)) = id.split_once(':') else {
        return false;
    };
    if peer.len() != 64 || !hex(peer) {
        return false;
    }
    let groups: Vec<_> = id.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(part, len)| part.len() == len && hex(part))
}
fn plain_leaf(name: &str, max: usize) -> bool {
    !name.is_empty()
        && name.len() <= max
        && !name.chars().any(char::is_control)
        && matches!(Path::new(name).components().collect::<Vec<_>>().as_slice(), [Component::Normal(part)] if *part == std::ffi::OsStr::new(name))
}
fn key_string(key: TransferKey) -> String {
    format!("{}:{}", key.peer, key.id)
}
impl VerifiedReceipt {
    fn valid(&self) -> bool {
        valid_id(&self.id)
            && plain_leaf(&self.name, 240)
            && plain_leaf(&self.leaf, 255)
            && self.sha256.len() == 64
            && hex(&self.sha256)
            && self.size_bytes <= (1 << 53) - 1
    }

    fn from_verified(published: &Path, incoming: &IncomingTransfer) -> Option<Self> {
        if incoming.status.state != State::Completed
            || incoming.status.error.is_some()
            || incoming.status.bytes_transferred != incoming.offer.size_bytes
        {
            return None;
        }
        let path = incoming.saved_path.as_deref()?;
        if path.parent() != Some(published) {
            return None;
        }
        let receipt = Self {
            id: key_string(incoming.key),
            name: incoming.offer.name.clone(),
            leaf: path.file_name()?.to_str()?.to_owned(),
            size_bytes: incoming.offer.size_bytes,
            sha256: incoming.offer.sha256.clone(),
        };
        receipt.valid().then_some(receipt)
    }
}

#[derive(Default)]
struct Catalog {
    enabled: bool,
    captured: HashSet<String>,
    rows: Vec<VerifiedReceipt>,
}

#[derive(Default)]
pub struct CompletionReceipts(Mutex<Catalog>);

impl CompletionReceipts {
    pub fn is_enabled(&self) -> bool {
        self.0.lock().is_ok_and(|catalog| catalog.enabled)
    }

    /// Authenticated, app-only Keychain storage; no paths are returned to JS.
    /// Empty overwrites the dedicated item's previous metadata atomically.
    pub fn configure(
        &self,
        enabled: bool,
        clear: bool,
        current: &[IncomingTransfer],
    ) -> Result<(), TransferError> {
        let mut catalog = self.0.lock().map_err(|_| ErrorCode::StorageFailed)?;
        if !enabled || clear {
            if !enabled {
                catalog.enabled = false;
            }
            write(&[])?;
            catalog.rows.clear();
            catalog.captured.extend(
                current
                    .iter()
                    .filter(|row| row.status.state == State::Completed)
                    .map(|row| key_string(row.key)),
            );
        } else if !catalog.enabled {
            catalog.rows = read()?;
            let keys: Vec<_> = catalog.rows.iter().map(|row| row.id.clone()).collect();
            catalog.captured.extend(keys);
        }
        catalog.enabled = enabled;
        Ok(())
    }

    pub fn capture(
        &self,
        published: &Path,
        incoming: &[IncomingTransfer],
    ) -> Result<(), TransferError> {
        let mut catalog = self.0.lock().map_err(|_| ErrorCode::StorageFailed)?;
        if !catalog.enabled {
            return Ok(());
        }
        let mut next: Vec<_> = incoming
            .iter()
            .filter_map(|item| VerifiedReceipt::from_verified(published, item))
            .filter(|row| !catalog.captured.contains(&row.id))
            .collect();
        if next.is_empty() {
            return Ok(());
        }
        // Watch notifications can be batched or reordered. Use stable IDs in
        // each batch, never invent a timestamp or infer completion from mtime.
        next.sort_by(|a, b| a.id.cmp(&b.id));
        let captured: Vec<_> = next.iter().map(|row| row.id.clone()).collect();
        next.extend(catalog.rows.iter().cloned());
        next.truncate(MAX_RECEIPTS);
        write(&next)?;
        catalog.captured.extend(captured);
        catalog.rows = next;
        Ok(())
    }

    pub fn snapshot(&self) -> Result<Vec<VerifiedReceipt>, TransferError> {
        let catalog = self.0.lock().map_err(|_| ErrorCode::StorageFailed)?;
        Ok(if catalog.enabled {
            catalog.rows.clone()
        } else {
            Vec::new()
        })
    }
}

fn read() -> Result<Vec<VerifiedReceipt>, TransferError> {
    let Some(bytes) = IosKeychain
        .load_receipts()
        .map_err(|_| ErrorCode::StorageFailed)?
    else {
        return Ok(Vec::new());
    };
    if bytes.len() > MAX_RECORDS_BYTES {
        return Err(ErrorCode::StorageFailed.into());
    }
    let rows: Vec<VerifiedReceipt> =
        serde_json::from_slice(&bytes).map_err(|_| ErrorCode::StorageFailed)?;
    let mut ids = HashSet::new();
    if rows.len() > MAX_RECEIPTS || rows.iter().any(|row| !row.valid() || !ids.insert(&row.id)) {
        return Err(ErrorCode::StorageFailed.into());
    }
    Ok(rows)
}
fn write(rows: &[VerifiedReceipt]) -> Result<(), TransferError> {
    let bytes = serde_json::to_vec(rows).map_err(|_| ErrorCode::StorageFailed)?;
    if bytes.len() > MAX_RECORDS_BYTES {
        return Err(ErrorCode::StorageFailed.into());
    }
    IosKeychain
        .replace_receipts(&bytes)
        .map_err(|_| ErrorCode::StorageFailed.into())
}
