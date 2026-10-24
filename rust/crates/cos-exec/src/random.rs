//! Unpredictable-enough numbers for session ids, chunk ids, batch markers and pipe names. None of
//! them is a secret: custody of a session is checked against its owner, never against its id.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};

static STATE: AtomicU64 = AtomicU64::new(0);
static SEED: OnceLock<u64> = OnceLock::new();

/// SplitMix64 over a per-process random seed.
pub(crate) fn next() -> u64 {
    let seed = *SEED.get_or_init(|| RandomState::new().build_hasher().finish());
    let mut z = seed.wrapping_add(
        STATE
            .fetch_add(0x9E37_79B9_7F4A_7C15, Ordering::Relaxed)
            .wrapping_add(0x9E37_79B9_7F4A_7C15),
    );
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// `count` random bytes as lowercase hex.
pub(crate) fn hex(count: usize) -> String {
    let mut out = String::with_capacity(count * 2);
    while out.len() < count * 2 {
        for byte in next().to_le_bytes() {
            if out.len() < count * 2 {
                out.push_str(&format!("{byte:02x}"));
            }
        }
    }
    out
}
