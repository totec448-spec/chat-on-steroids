//! What the transport reads from a request before any route: the Origin and the extension's
//! own headers (`originOf`, `extensionProtocol`, `extensionBuildOf`, `browserOf` in `bridge.ts`).

use cos_types::bridge::{BRIDGE_PROTOCOL, WakeHost};
use http::HeaderMap;

/// Why the Origin rule exists: a web page can neither suppress nor forge its Origin, so refusing
/// every origin that is not an extension keeps chatgpt.com and every other site out. A missing
/// Origin is allowed, because Chrome does not always attach one to an extension's own fetch; the
/// bearer token is the boundary that carries the weight.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Origin {
    Absent,
    /// A `chrome-extension://` origin, echoed in CORS headers.
    Extension(String),
    /// A web page, `null` (a sandboxed frame) included.
    Forbidden,
}

impl Origin {
    pub(crate) fn of(headers: &HeaderMap) -> Self {
        let Some(value) = headers.get(http::header::ORIGIN) else {
            return Self::Absent;
        };
        match value.to_str() {
            Ok("") => Self::Absent,
            Ok(origin) if origin.starts_with("chrome-extension://") => {
                Self::Extension(origin.to_owned())
            }
            _ => Self::Forbidden,
        }
    }

    /// The value to echo in `access-control-allow-origin`.
    pub(crate) fn echo(&self) -> Option<&str> {
        match self {
            Self::Extension(origin) => Some(origin),
            Self::Absent | Self::Forbidden => None,
        }
    }
}

/// The extension's self-description, from its `x-extension-*` headers. Every field is
/// optional: older builds and plain clients send none of them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Peer {
    /// `x-extension-version`, at most 32 characters.
    pub version: Option<String>,
    /// `x-extension-protocol` when it reads as a safe integer (`Number(header)`).
    pub protocol: Option<i64>,
    /// `x-extension-build`, twelve lowercase hex digits.
    pub build: Option<String>,
    /// `x-extension-browser`, the extension's random id for its browser.
    pub browser: Option<String>,
    /// `x-extension-host`: the CoS browser's own copy or the person's browser.
    pub host: Option<WakeHost>,
}

impl Peer {
    pub(crate) fn of(headers: &HeaderMap) -> Self {
        let text = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
        Self {
            version: text("x-extension-version").map(|value| value.chars().take(32).collect()),
            protocol: text("x-extension-protocol").and_then(js_safe_integer),
            build: text("x-extension-build")
                .filter(|value| {
                    value.len() == 12
                        && value
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                })
                .map(str::to_owned),
            browser: text("x-extension-browser")
                .filter(|value| {
                    (16..=64).contains(&value.len())
                        && value
                            .bytes()
                            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
                })
                .map(str::to_owned),
            host: match text("x-extension-host") {
                Some("cos") => Some(WakeHost::Cos),
                Some("browser") => Some(WakeHost::Browser),
                _ => None,
            },
        }
    }

    /// `protocolCompatible`: the caller states this app's protocol.
    pub fn compatible(&self) -> bool {
        self.protocol == i64::try_from(BRIDGE_PROTOCOL).ok()
    }
}

/// `Number(text)` restricted to `Number.isSafeInteger`: whitespace is trimmed, an empty string
/// is 0, and `0x`, `0o` and `0b` prefixes are read as JavaScript does.
fn js_safe_integer(text: &str) -> Option<i64> {
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    let text = text.trim();
    if text.is_empty() {
        return Some(0);
    }
    let radix = match text.get(..2).map(str::to_ascii_lowercase).as_deref() {
        Some("0x") => Some(16),
        Some("0o") => Some(8),
        Some("0b") => Some(2),
        _ => None,
    };
    if let Some(radix) = radix {
        let value = i64::from_str_radix(&text[2..], radix).ok()?;
        return (value as f64 <= MAX_SAFE).then_some(value);
    }
    // Rust also reads `inf` and `nan`, which JavaScript does not; neither is an integer.
    let value: f64 = text.parse().ok()?;
    (value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE).then_some(value as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(*name, value.parse().expect("a header value"));
        }
        map
    }

    #[test]
    fn only_an_absent_or_extension_origin_is_allowed() {
        assert_eq!(Origin::of(&headers(&[])), Origin::Absent);
        assert_eq!(Origin::of(&headers(&[("origin", "")])), Origin::Absent);
        assert_eq!(
            Origin::of(&headers(&[("origin", "chrome-extension://abc")])),
            Origin::Extension("chrome-extension://abc".into())
        );
        for web in [
            "https://chatgpt.com",
            "https://evil.example.com",
            "http://localhost:3000",
            "null",
        ] {
            assert_eq!(
                Origin::of(&headers(&[("origin", web)])),
                Origin::Forbidden,
                "{web}"
            );
        }
    }

    #[test]
    fn the_protocol_header_reads_as_javascript_number_does() {
        let protocol =
            |value: &str| Peer::of(&headers(&[("x-extension-protocol", value)])).protocol;
        assert_eq!(protocol("14"), Some(14));
        assert_eq!(protocol(" 14 "), Some(14));
        assert_eq!(protocol("14.0"), Some(14));
        assert_eq!(protocol("0x0e"), Some(14));
        assert_eq!(protocol(""), Some(0));
        assert_eq!(protocol("14.5"), None);
        assert_eq!(protocol("fourteen"), None);
        assert_eq!(protocol("inf"), None);
        assert_eq!(Peer::of(&headers(&[])).protocol, None);
        assert!(Peer::of(&headers(&[("x-extension-protocol", "14")])).compatible());
        assert!(!Peer::of(&headers(&[("x-extension-protocol", "13")])).compatible());
    }

    #[test]
    fn extension_headers_keep_only_their_documented_shapes() {
        let peer = Peer::of(&headers(&[
            ("x-extension-version", &"9".repeat(40)),
            ("x-extension-build", "0123456789ab"),
            ("x-extension-browser", "abcdefghij012345"),
            ("x-extension-host", "cos"),
        ]));
        assert_eq!(peer.version.as_deref().map(str::len), Some(32));
        assert_eq!(peer.build.as_deref(), Some("0123456789ab"));
        assert_eq!(peer.browser.as_deref(), Some("abcdefghij012345"));
        assert_eq!(peer.host, Some(WakeHost::Cos));
        let odd = Peer::of(&headers(&[
            ("x-extension-build", "0123456789AB"),
            ("x-extension-browser", "short"),
            ("x-extension-host", "other"),
        ]));
        assert_eq!((odd.build, odd.browser, odd.host), (None, None, None));
    }
}
