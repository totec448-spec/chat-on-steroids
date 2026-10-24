//! `config.json`: load, validate and repair, then serialized read-modify-write saves.
//!
//! Port of `src/main/config.ts`. A missing file is a first launch and gets the shipped
//! defaults. A file that exists but cannot be trusted keeps a copy of its bytes beside it and
//! loads as the conservative recovery config, read-only until the user saves again.

mod schema;
mod settings;

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use cos_types::config::BrowserBridgePort;
pub use cos_types::config::Config;
use serde_json::Value;

use crate::bridge_ports::BridgePortOverride;
pub use crate::check::Invalid;
use crate::js;
use crate::logger::Logger;
pub use schema::{Platform, first_launch_config, parse_config, recovery_config};

/// A `Config` has only string keys and finite numbers.
const SERIALIZES: &str = "a Config always serializes";

/// Why a save did not happen. The stored config is unchanged in every case.
#[derive(Debug)]
pub enum ConfigError {
    /// The proposed config, or a Settings request, failed validation.
    Invalid(Invalid),
    /// A Settings save edited a tunnel id of a setup profile that is no longer selected.
    ProfileChanged,
    /// A Settings save edited the bridge port while `CLF_BRIDGE_PORTS` holds it.
    BridgePortOverridden,
    /// A Settings save moved the bridge to a port that cannot be bound. Holds the bridge's
    /// own error text.
    BridgePortUnavailable(String),
    Io(io::Error),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(invalid) => invalid.fmt(f),
            Self::ProfileChanged => f.write_str(
                "Setup profile changed. Edit the tunnel ID in the selected profile again.",
            ),
            Self::BridgePortOverridden => {
                f.write_str("Browser bridge port is controlled by CLF_BRIDGE_PORTS.")
            }
            Self::BridgePortUnavailable(reason) => f.write_str(reason),
            Self::Io(error) => write!(f, "could not save settings: {error}"),
        }
    }
}

impl std::error::Error for ConfigError {}

impl From<Invalid> for ConfigError {
    fn from(invalid: Invalid) -> Self {
        Self::Invalid(invalid)
    }
}

/// The settings owner. Clones share one config.
#[derive(Clone)]
pub struct ConfigStore {
    inner: Arc<Inner>,
}

struct Inner {
    file: PathBuf,
    platform: Platform,
    logger: Logger,
    /// The last config that reached disk; readers never wait for a save.
    published: RwLock<Published>,
    /// Orders read-modify-write saves so each one sees the result of the one before it.
    mutations: Mutex<()>,
}

#[derive(Clone)]
struct Published {
    config: Config,
    recovered: bool,
}

impl ConfigStore {
    pub fn new(file: impl Into<PathBuf>, platform: Platform, logger: Logger) -> Self {
        Self {
            inner: Arc::new(Inner {
                file: file.into(),
                platform,
                logger,
                published: RwLock::new(Published {
                    config: first_launch_config(platform),
                    recovered: false,
                }),
                mutations: Mutex::new(()),
            }),
        }
    }

    /// `loadConfig()`. `app_version` is recorded as the last seen version on a first launch.
    pub fn load(&self, app_version: &str) -> Config {
        let _queue = self
            .inner
            .mutations
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let loaded = self.read_file(app_version);
        let mut published = self
            .inner
            .published
            .write()
            .unwrap_or_else(|poison| poison.into_inner());
        if loaded.recovered {
            published.recovered = true;
        }
        published.config = loaded.config.clone();
        loaded.config
    }

    pub fn get(&self) -> Config {
        self.inner
            .published
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
            .config
            .clone()
    }

    /// This run started from the recovery config and read-only has not been switched off since.
    pub fn recovered(&self) -> bool {
        self.inner
            .published
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
            .recovered
    }

    /// `updateConfig(update)`: the update sees the latest saved config, and its result is
    /// validated, written atomically and only then published.
    pub fn update(
        &self,
        update: impl FnOnce(&Config) -> Result<Config, ConfigError>,
    ) -> Result<Config, ConfigError> {
        let _queue = self
            .inner
            .mutations
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let previous = self.get();
        // Validated through its JSON form, as TypeScript re-parses every proposed config.
        let proposed = parse_config(&serde_json::to_value(update(&previous)?).expect(SERIALIZES))?;
        self.persist(&proposed)?;
        let mut published = self
            .inner
            .published
            .write()
            .unwrap_or_else(|poison| poison.into_inner());
        published.config = proposed.clone();
        if !proposed.read_only {
            published.recovered = false;
        }
        Ok(proposed)
    }

    /// `saveConfig(next)`: replaces the whole config.
    pub fn save(&self, next: Config) -> Result<Config, ConfigError> {
        self.update(|_| Ok(next))
    }

    /// The Settings form's `{ base, patch }` save: fields the form did not change keep the
    /// value another writer may have saved since the form read `base`. While `CLF_BRIDGE_PORTS`
    /// holds the bridge's ports (`bridge_ports`), a save that edits the bridge port is refused.
    /// Otherwise a save that moves the bridge to another port asks `port_free` first, inside the
    /// save, and is refused with its error text: the bridge must be able to follow the setting.
    pub fn save_settings(
        &self,
        request: &Value,
        bridge_ports: Option<&BridgePortOverride>,
        port_free: impl FnOnce(BrowserBridgePort) -> Result<(), String>,
    ) -> Result<Config, ConfigError> {
        let request = settings::SettingsSave::parse(request)?;
        if bridge_ports.is_some() && request.edits_bridge_port() {
            return Err(ConfigError::BridgePortOverridden);
        }
        self.update(|current| {
            let next = request.merge_into(current)?;
            let port = |config: &Config| {
                config
                    .ui
                    .browser_bridge_port
                    .unwrap_or(BrowserBridgePort::Auto)
            };
            if bridge_ports.is_none() && port(&next) != port(current) {
                port_free(port(&next)).map_err(ConfigError::BridgePortUnavailable)?;
            }
            Ok(next)
        })
    }

    fn persist(&self, config: &Config) -> Result<(), ConfigError> {
        let file = &self.inner.file;
        let text = serde_json::to_string_pretty(config).expect(SERIALIZES);
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent).map_err(ConfigError::Io)?;
        }
        crate::durable::write_replacing(file, &with_suffix(file, ".tmp"), text.as_bytes())
            .map_err(ConfigError::Io)
    }

    fn read_file(&self, app_version: &str) -> Published {
        let logger = &self.inner.logger;
        let bytes = match fs::read(&self.inner.file) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                // A fresh install has nothing new to show: it records its own version first.
                let mut config = first_launch_config(self.inner.platform);
                config.ui.last_seen_version = Some(app_version.to_owned());
                return Published {
                    config,
                    recovered: false,
                };
            }
            Err(error) => {
                logger.error(&format!("Could not read settings: {error}"));
                return Published {
                    config: recovery_config(),
                    recovered: true,
                };
            }
        };
        let text = String::from_utf8_lossy(&bytes);
        // Windows PowerShell 5.1 and older Notepad start UTF-8 files with a byte-order mark.
        let json = text.strip_prefix('\u{feff}').unwrap_or(&text);
        let parsed = match serde_json::from_str::<Value>(json) {
            Ok(value) => parse_config(&value)
                .map_err(|_| "Settings file was invalid and has been reset to defaults".to_owned()),
            Err(error) => Err(format!("Could not read settings: {error}")),
        };
        match parsed {
            Ok(config) => Published {
                config: schema::adopt_current_defaults(config),
                recovered: false,
            },
            Err(message) => {
                logger.error(&message);
                self.keep_unreadable(&bytes);
                Published {
                    config: recovery_config(),
                    recovered: true,
                }
            }
        }
    }

    /// Keeps the unusable file's bytes beside it, so the next save cannot destroy them.
    fn keep_unreadable(&self, bytes: &[u8]) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis() as u64);
        let stamp = js::iso_time(now).replace([':', '.'], "-");
        let copy = with_suffix(&self.inner.file, &format!(".unreadable-{stamp}"));
        let name = copy
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        match fs::write(&copy, bytes) {
            Ok(()) => self.inner.logger.error(&format!(
                "The settings file could not be used; its original was kept as {name}"
            )),
            Err(error) => self.inner.logger.error(&format!(
                "Could not keep a copy of the unusable settings file: {error}"
            )),
        }
    }
}

fn with_suffix(file: &Path, suffix: &str) -> PathBuf {
    let mut name = file.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}
