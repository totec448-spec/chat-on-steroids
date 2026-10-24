//! What this install calls each connector and which connectors share a Secure Tunnel ID, from
//! one config snapshot (`connectorName` in `shared/connector-names.ts`, `connectorsSharingTunnel`
//! in `shared/tunnel-ids.ts`).

use cos_types::config::Config;

use crate::SurfaceId;

const SUFFIX_MAX: usize = 32;
const SURFACES: [SurfaceId; 3] = [SurfaceId::Core, SurfaceId::Desktop, SurfaceId::Plugins];

/// The connector naming facts of one config snapshot.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Connectors {
    /// This computer's normalized connector suffix; empty for none.
    suffix: String,
    /// Each surface's trimmed Secure Tunnel ID, in [`SURFACES`] order; empty for none.
    tunnel_ids: [String; 3],
}

impl Connectors {
    pub fn from_config(config: &Config) -> Self {
        let tunnel = &config.tunnel;
        Self {
            suffix: config
                .connector_suffix
                .as_deref()
                .map(normalize_suffix)
                .unwrap_or_default(),
            tunnel_ids: [
                tunnel.tunnel_id.as_str(),
                tunnel.desktop_tunnel_id.as_str(),
                tunnel.plugins_tunnel_id.as_deref().unwrap_or(""),
            ]
            .map(|id| id.trim().to_owned()),
        }
    }

    /// The name the user gives this connector in ChatGPT, with this computer's suffix.
    pub fn name(&self, surface: SurfaceId) -> String {
        let word = match surface {
            SurfaceId::Core => "Core",
            SurfaceId::Desktop => "Desktop",
            SurfaceId::Plugins => "Plugins",
        };
        if self.suffix.is_empty() {
            format!("Chat On Steroids {word}")
        } else {
            format!("Chat On Steroids {word} ({})", self.suffix)
        }
    }

    /// The other connectors configured on `surface`'s Secure Tunnel ID, in surface order.
    /// OpenAI hands calls round-robin to every client on one ID, so each of these receives
    /// calls meant for the others. An empty ID shares nothing.
    pub fn sharing_tunnel(&self, surface: SurfaceId) -> Vec<SurfaceId> {
        let own = &self.tunnel_ids[slot(surface)];
        if own.is_empty() {
            return Vec::new();
        }
        SURFACES
            .into_iter()
            .filter(|&other| other != surface && self.tunnel_ids[slot(other)] == *own)
            .collect()
    }
}

fn slot(surface: SurfaceId) -> usize {
    match surface {
        SurfaceId::Core => 0,
        SurfaceId::Desktop => 1,
        SurfaceId::Plugins => 2,
    }
}

/// `normalizeConnectorSuffix`: collapsed whitespace, at most 32 UTF-16 units of letters,
/// digits, spaces, dots, dashes and underscores; anything else is no suffix.
fn normalize_suffix(value: &str) -> String {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let allowed = collapsed
        .chars()
        .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-'));
    if allowed && collapsed.encode_utf16().count() <= SUFFIX_MAX {
        collapsed
    } else {
        String::new()
    }
}
