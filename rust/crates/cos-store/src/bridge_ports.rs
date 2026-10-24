//! `CLF_BRIDGE_PORTS`, the environment override of the browser bridge's ports. Port of the
//! override half of `bridgePortSelection` in `src/main/bridge-ports.ts`.

use crate::js;

/// The environment variable that holds the override.
pub const ENV: &str = "CLF_BRIDGE_PORTS";

/// The ports that `CLF_BRIDGE_PORTS` forces on the bridge, in order. Port 0 asks the OS for any
/// free port. While an override exists, the Settings form cannot change the bridge port.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BridgePortOverride(Vec<u16>);

impl BridgePortOverride {
    /// The override in this process's environment.
    pub fn from_env() -> Option<Self> {
        Self::parse(&std::env::var_os(ENV)?.to_string_lossy())
    }

    /// Each comma-separated entry is read with `Number.parseInt(entry.trim(), 10)`, and entries
    /// that are not 0 to 65535 are skipped. `None` when no entry is left: the user's choice then
    /// applies.
    pub fn parse(raw: &str) -> Option<Self> {
        let ports: Vec<u16> = raw.split(',').filter_map(parse_port).collect();
        (!ports.is_empty()).then_some(Self(ports))
    }

    pub fn ports(&self) -> &[u16] {
        &self.0
    }
}

/// `Number.parseInt(entry.trim(), 10)` when the result is an integer from 0 to 65535. `parseInt`
/// reads an optional sign and then leading ASCII digits, ignoring the rest; `-0` is 0.
fn parse_port(entry: &str) -> Option<u16> {
    let entry = js::trim(entry);
    let (negative, unsigned) = match entry.as_bytes().first() {
        Some(b'-') => (true, &entry[1..]),
        Some(b'+') => (false, &entry[1..]),
        _ => (false, entry),
    };
    let digits = unsigned.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let magnitude = unsigned[..digits].bytes().try_fold(0u16, |value, digit| {
        value.checked_mul(10)?.checked_add(u16::from(digit - b'0'))
    })?;
    (!negative || magnitude == 0).then_some(magnitude)
}
