//! Constants shared by AeRift v1 native protocol implementations.

pub const VERSION: u8 = 1;
pub const DISCOVERY_SERVICE: &str = "_aerift._tcp.local.";
pub const ALPN: &[u8] = b"http/1.1";

pub const PAIR_PATH: &str = "/v1/pair";
pub const OFFER_PATH: &str = "/v1/transfers";
pub const MAX_CONTROL_BYTES: usize = 16 * 1024;
