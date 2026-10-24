//! What this install calls its connectors in ChatGPT (`shared/connector-names.ts`): the brand,
//! the surface word, and this computer's suffix when it has a clean one. The connection owner
//! shows the names in Setup and the bridge hands them to the extension, so both read them here.

use crate::app_state::SurfaceId;
use crate::bridge::ConnectorNames;

const BRAND: &str = "Chat On Steroids";
const SUFFIX_MAX: usize = 32;

/// `normalizeConnectorSuffix`: inner whitespace collapsed, and empty unless the result is at most
/// 32 UTF-16 units of letters, digits, spaces, dots, dashes and underscores.
pub fn normalize_suffix(value: &str) -> String {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let allowed = collapsed
        .chars()
        .all(|c| c.is_alphabetic() || c.is_numeric() || matches!(c, ' ' | '.' | '_' | '-'));
    if allowed && collapsed.encode_utf16().count() <= SUFFIX_MAX {
        collapsed
    } else {
        String::new()
    }
}

fn word(surface: SurfaceId) -> &'static str {
    match surface {
        SurfaceId::Core => "Core",
        SurfaceId::Desktop => "Desktop",
        SurfaceId::Plugins => "Plugins",
    }
}

/// `connectorName(surface, suffix)`: `Chat On Steroids Core`, or `Chat On Steroids Core (<suffix>)`.
pub fn connector_name(surface: SurfaceId, suffix: Option<&str>) -> String {
    let tag = suffix.map(normalize_suffix).unwrap_or_default();
    if tag.is_empty() {
        format!("{BRAND} {}", word(surface))
    } else {
        format!("{BRAND} {} ({tag})", word(surface))
    }
}

/// `connectorNames(suffix)`: every surface's name, as `/status` sends them.
pub fn connector_names(suffix: Option<&str>) -> ConnectorNames {
    ConnectorNames {
        core: connector_name(SurfaceId::Core, suffix),
        desktop: connector_name(SurfaceId::Desktop, suffix),
        plugins: connector_name(SurfaceId::Plugins, suffix),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_takes_a_clean_suffix_only() {
        assert_eq!(connector_names(None).core, "Chat On Steroids Core");
        assert_eq!(
            connector_names(Some("  Work   PC ")).plugins,
            "Chat On Steroids Plugins (Work PC)"
        );
        assert_eq!(
            connector_name(SurfaceId::Desktop, Some("bad(name)")),
            "Chat On Steroids Desktop"
        );
        assert_eq!(
            connector_names(Some(&"x".repeat(33))).core,
            "Chat On Steroids Core"
        );
        assert_eq!(
            connector_name(SurfaceId::Core, Some(&"é".repeat(32))),
            format!("Chat On Steroids Core ({})", "é".repeat(32))
        );
    }
}
