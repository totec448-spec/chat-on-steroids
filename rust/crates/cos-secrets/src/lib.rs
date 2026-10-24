//! The Chat On Steroids credential store, `<userData>/secrets.bin`, read and written exactly as
//! the Electron app's `src/main/secrets.ts` does through Electron 44 async `safeStorage`.
//!
//! [`SecretStore`] is the port of that module's API: [`SecretStore::get`], [`SecretStore::set`],
//! [`SecretStore::clear`], [`SecretStore::delete_all`], [`SecretStore::status`],
//! [`SecretStore::unreadable`] and [`SecretStore::set_aside_unreadable`]. A file that the
//! profile key cannot open reads as "no credential", every write then fails closed, and only an
//! explicit set-aside renames the file to `secrets.unreadable-<UTC>.bin` and starts empty.
//!
//! A missing, unparseable or keyless `Local State`, or one whose key DPAPI cannot unwrap, gets a
//! new key as Electron gives it one. A `Local State` whose key is usable is never written. One
//! difference is deliberate: a key that Electron can neither use nor replace reports secure
//! storage unavailable, where Electron reports it available and then cannot save.
//!
//! Windows is the only platform implemented. See `README.md` for the byte format, the key source
//! and the macOS and Linux status.

mod format;
mod key;
mod store;
mod text;

use std::borrow::Cow;
use std::fmt;
use std::io;

pub use key::Unavailable;
pub use store::SecretStore;
pub use text::clean_api_key;

/// The decrypted store, in insertion order so a map Electron wrote is written back byte for byte.
/// Keys this build does not know are kept.
pub type SecretMap = indexmap::IndexMap<String, String>;

/// `SecretKey` in `secrets.ts`: the slots the app stores.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum SecretKey {
    OpenaiApiKey,
    /// The bearer token the paired browser extension presents. Not a user credential.
    BridgeToken,
    OpenRouterApiKey,
    CustomProviderApiKey,
    /// `plugin:<rest>`, where the plugin manager writes `<pluginId>:<credential>` as the rest.
    Plugin(String),
    /// `setup:<rest>`, the API key of an inactive setup profile.
    Setup(String),
}

impl SecretKey {
    /// The key name inside `secrets.bin`.
    pub fn name(&self) -> Cow<'_, str> {
        match self {
            SecretKey::OpenaiApiKey => "openaiApiKey".into(),
            SecretKey::BridgeToken => "bridgeToken".into(),
            SecretKey::OpenRouterApiKey => "openRouterApiKey".into(),
            SecretKey::CustomProviderApiKey => "customProviderApiKey".into(),
            SecretKey::Plugin(rest) => format!("plugin:{rest}").into(),
            SecretKey::Setup(rest) => format!("setup:{rest}").into(),
        }
    }

    /// The inverse of [`SecretKey::name`]. `None` for a name outside the `SecretKey` type.
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "openaiApiKey" => SecretKey::OpenaiApiKey,
            "bridgeToken" => SecretKey::BridgeToken,
            "openRouterApiKey" => SecretKey::OpenRouterApiKey,
            "customProviderApiKey" => SecretKey::CustomProviderApiKey,
            _ => {
                if let Some(rest) = name.strip_prefix("plugin:") {
                    SecretKey::Plugin(rest.to_owned())
                } else {
                    SecretKey::Setup(name.strip_prefix("setup:")?.to_owned())
                }
            }
        })
    }

    /// `isApiKey`: values that [`clean_api_key`] cleans on write and on read. Other values are
    /// trimmed on write only.
    fn is_api_key(&self) -> bool {
        matches!(
            self,
            SecretKey::OpenaiApiKey
                | SecretKey::OpenRouterApiKey
                | SecretKey::CustomProviderApiKey
                | SecretKey::Setup(_)
        )
    }
}

/// Why a store operation changed nothing.
#[derive(Debug)]
pub enum Error {
    /// Secure storage cannot supply the key (`UNAVAILABLE` in `secrets.ts`).
    Unavailable(Unavailable),
    /// `secrets.bin` exists but the profile key cannot turn it back into keys (`UNREADABLE`).
    /// Writes stay refused until [`SecretStore::set_aside_unreadable`] or
    /// [`SecretStore::delete_all`].
    Unreadable,
    /// Writing, renaming or removing `secrets.bin` failed.
    Io(io::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Unavailable(why) => {
                write!(f, "secure OS credential storage is unavailable: {why}")
            }
            Error::Unreadable => f.write_str("the saved keys could not be read"),
            Error::Io(error) => write!(f, "secrets.bin could not be updated: {error}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Unavailable(why) => Some(why),
            Error::Unreadable => None,
            Error::Io(error) => Some(error),
        }
    }
}

impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        Error::Io(error)
    }
}

impl From<Unavailable> for Error {
    fn from(why: Unavailable) -> Self {
        Error::Unavailable(why)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_key_name_parses_back_to_its_key() {
        for key in [
            SecretKey::OpenaiApiKey,
            SecretKey::BridgeToken,
            SecretKey::OpenRouterApiKey,
            SecretKey::CustomProviderApiKey,
            SecretKey::Plugin("github:oauth:state".into()),
            SecretKey::Plugin(String::new()),
            SecretKey::Setup("profile-1".into()),
        ] {
            assert_eq!(SecretKey::parse(&key.name()), Some(key));
        }
        assert_eq!(SecretKey::parse("futureKey"), None);
        assert_eq!(SecretKey::parse("Plugin:x"), None);
    }
}
