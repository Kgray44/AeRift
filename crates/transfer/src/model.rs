use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::{Uuid, Variant, Version};

pub const MAX_CONTROL_BYTES: usize = 16 * 1024;
pub const MAX_SAFE_SIZE: u64 = (1 << 53) - 1;
pub const BUFFER_SIZE: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct PeerId([u8; 32]);

impl PeerId {
    /// Call only with a leaf whose possession was verified by the TLS handshake.
    pub fn from_tls_leaf(der: &[u8]) -> Self {
        Self(Sha256::digest(der).into())
    }
}

impl std::fmt::Display for PeerId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for byte in self.0 {
            write!(f, "{byte:02x}")?;
        }
        Ok(())
    }
}

impl std::str::FromStr for PeerId {
    type Err = TransferError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value.len() != 64
            || !value
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        {
            return Err(ErrorCode::InvalidRequest.into());
        }
        let mut digest = [0; 32];
        for (index, byte) in digest.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
                .map_err(|_| ErrorCode::InvalidRequest)?;
        }
        Ok(Self(digest))
    }
}

impl Serialize for PeerId {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for PeerId {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    #[serde(deserialize_with = "canonical_id")]
    pub id: Uuid,
    pub name: String,
    pub size_bytes: u64,
    pub sha256: String,
}

impl Offer {
    pub fn validate(&self) -> Result<(), TransferError> {
        let valid_digest = self.sha256.len() == 64
            && self
                .sha256
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'));
        if self.id.get_version() != Some(Version::Random)
            || self.id.get_variant() != Variant::RFC4122
            || !safe_name(&self.name)
            || self.size_bytes > MAX_SAFE_SIZE
            || !valid_digest
        {
            return Err(ErrorCode::InvalidRequest.into());
        }
        Ok(())
    }
}

pub(crate) fn safe_name(name: &str) -> bool {
    if name.is_empty()
        || name.len() > 240
        || name.starts_with(['.', ' '])
        || name.ends_with(['.', ' '])
        || name
            .chars()
            .any(|ch| ch.is_control() || "<>:\"/\\|?*".contains(ch))
    {
        return false;
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) {
        return false;
    }
    for prefix in ["COM", "LPT"] {
        if matches!(
            stem.strip_prefix(prefix),
            Some("1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")
        ) {
            return false;
        }
    }
    true
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Pending,
    Accepted,
    Transferring,
    Completed,
    Rejected,
    Cancelled,
    Failed,
}

impl State {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Rejected | Self::Cancelled | Self::Failed
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidRequest,
    UnsupportedVersion,
    PeerUntrusted,
    PeerUnavailable,
    PairingExpired,
    PairingRejected,
    TransferRejected,
    Conflict,
    IntegrityFailed,
    StorageFailed,
    NetworkError,
    Cancelled,
    InternalError,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TransferError {
    pub code: ErrorCode,
}

impl From<ErrorCode> for TransferError {
    fn from(code: ErrorCode) -> Self {
        Self { code }
    }
}

impl std::fmt::Display for TransferError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self.code)
    }
}

impl std::error::Error for TransferError {}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: State,
    pub bytes_transferred: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<TransferError>,
}

impl Status {
    pub(crate) fn new(state: State) -> Self {
        Self {
            state,
            bytes_transferred: 0,
            error: None,
        }
    }
}

fn canonical_id<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Uuid, D::Error> {
    let raw = String::deserialize(deserializer)?;
    crate::parse_id(&raw).ok_or_else(|| serde::de::Error::custom("canonical UUIDv4 required"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_windows_and_ios_basenames() {
        for name in [
            "",
            ".",
            "..",
            "../x",
            "..\\x",
            "/x",
            "C:x",
            "file:ads",
            "NUL.txt",
            "COM¹.txt",
            "lpt9 .txt",
            "x. ",
            "x\0",
            "file\nname",
        ] {
            assert!(!safe_name(name), "{name:?}");
        }
        assert!(safe_name("réunion 01.bin"));
    }
}
