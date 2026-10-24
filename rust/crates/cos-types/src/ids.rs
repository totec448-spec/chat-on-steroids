//! Identifiers the TypeScript app validates before it trusts them, as newtypes.
//!
//! Each is checked once, on construction or deserialization, with the same character set and
//! length bounds the TypeScript owner applies. Code that holds one can rely on its shape.

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize};

/// Why a string was refused as an identifier.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InvalidId {
    kind: &'static str,
}

impl fmt::Display for InvalidId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "not a valid {}", self.kind)
    }
}

impl std::error::Error for InvalidId {}

fn alnum_dash(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn prefixed(value: &str, prefix: &str, rest: impl Fn(&str) -> bool) -> bool {
    value.strip_prefix(prefix).is_some_and(rest)
}

macro_rules! branded_id {
    ($(#[$meta:meta])* $name:ident, $kind:literal, $valid:expr) => {
        $(#[$meta])*
        #[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// Checks `value` against the TypeScript owner's rule.
            pub fn parse(value: impl Into<String>) -> Result<Self, InvalidId> {
                let value = value.into();
                let valid: fn(&str) -> bool = $valid;
                if valid(&value) {
                    Ok(Self(value))
                } else {
                    Err(InvalidId { kind: $kind })
                }
            }

            /// The identifier as written on disk and on the wire.
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                Self::parse(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
            }
        }
    };
}

branded_id!(
    /// A local recording session (`sessions/<id>/`). `/^[0-9a-z-]{8,64}$/i` in `session/store.ts`.
    SessionId,
    "session id",
    |value| alnum_dash(value, 8, 64)
);

branded_id!(
    /// A ChatGPT conversation id.
    ///
    /// The owners disagree on the upper bound: blocked and trusted chats accept 8..=64
    /// characters, Goal replies 8..=256. This type takes the wider rule; an owner with the
    /// narrower one checks [`ConversationId::as_str`] length itself.
    ConversationId,
    "conversation id",
    |value| alnum_dash(value, 8, 256)
);

branded_id!(
    /// A ChatGPT conversation id as the browser bridge takes one from the extension:
    /// `conversationId(value)` in `bridge.ts`, `/^[0-9a-f-]{8,64}$/i`. Every id ChatGPT mints
    /// has this shape; anything else in a tab report refuses the whole report.
    BridgeConversationId,
    "bridge conversation id",
    |value| (8..=64).contains(&value.len())
        && value.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
);

branded_id!(
    /// An OpenAI Secure Tunnel id, `tunnel_` and 32 lowercase hex digits (`tunnel/index.ts`).
    ///
    /// `config.json` stores tunnel ids as free text (empty when unset), so the settings types
    /// keep `String`; the tunnel owner parses into this type before it starts a client.
    TunnelId,
    "tunnel id",
    |value| prefixed(value, "tunnel_", |rest| {
        rest.len() == 32 && rest.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    })
);

branded_id!(
    /// A native ChatGPT Project, `g-p-` and 32 lowercase hex digits (`shared/projects.ts`).
    ChatgptProjectId,
    "ChatGPT project id",
    |value| prefixed(value, "g-p-", |rest| {
        rest.len() == 32 && rest.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    })
);

branded_id!(
    /// A ChatGPT connector app id, `asdk_app_` and 1..=160 of `[A-Za-z0-9_-]`.
    ConnectorAppId,
    "connector app id",
    |value| prefixed(value, "asdk_app_", |rest| {
        (1..=160).contains(&rest.len())
            && rest.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    })
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_follow_the_typescript_rules() {
        assert!(SessionId::parse("2026-10-19-abc").is_ok());
        assert!(SessionId::parse("short").is_err());
        assert!(SessionId::parse("has space here").is_err());
        assert!(ConversationId::parse("68f1c2d4-1111-4bbb-8ccc-0123456789ab").is_ok());
        assert!(BridgeConversationId::parse("68F1C2D4-1111-4bbb-8ccc-0123456789ab").is_ok());
        assert!(BridgeConversationId::parse("conversation-other").is_err());
        assert!(BridgeConversationId::parse("a".repeat(65)).is_err());
        assert!(BridgeConversationId::parse("abcdef1").is_err());
        assert!(TunnelId::parse("tunnel_0123456789abcdef0123456789abcdef").is_ok());
        assert!(TunnelId::parse("tunnel_0123456789ABCDEF0123456789abcdef").is_err());
        assert!(ChatgptProjectId::parse("g-p-0123456789abcdef0123456789abcdef").is_ok());
        assert!(ConnectorAppId::parse("asdk_app_x").is_ok());
        assert!(ConnectorAppId::parse("asdk_app_").is_err());
    }

    #[test]
    fn deserialization_refuses_a_malformed_id() {
        let parsed: Result<SessionId, _> = serde_json::from_str("\"../escape\"");
        assert!(parsed.is_err());
    }
}
