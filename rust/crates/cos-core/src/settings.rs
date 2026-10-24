//! The Settings owner: the only writer of `config.json` and the only publisher of the config
//! snapshot every other owner reads.

use std::sync::Arc;

use cos_bridge::PortSelection;
use cos_store::{BridgePortOverride, ConfigError, ConfigStore};
use cos_types::config::{BrowserBridgePort, Config};
use serde_json::Value;
use tokio::sync::watch;

#[derive(Clone)]
pub struct Settings {
    store: ConfigStore,
    bridge_ports: Option<BridgePortOverride>,
    published: Arc<watch::Sender<Arc<Config>>>,
}

impl Settings {
    /// Loads `config.json` (a small synchronous read on the startup path) and publishes it.
    pub(crate) fn load(
        store: ConfigStore,
        app_version: &str,
        bridge_ports: Option<BridgePortOverride>,
    ) -> Self {
        let config = store.load(app_version);
        let (published, _) = watch::channel(Arc::new(config));
        Self {
            store,
            bridge_ports,
            published: Arc::new(published),
        }
    }

    pub fn config(&self) -> watch::Receiver<Arc<Config>> {
        self.published.subscribe()
    }

    /// This run started from the recovery config and is read-only until the user saves.
    pub fn recovered(&self) -> bool {
        self.store.recovered()
    }

    /// The Settings form's `{ base, patch }` save, then publication of the stored config. A
    /// save that moves the bridge to a port nothing can bind is refused before it is stored,
    /// so the setting never names a port the bridge is not on.
    pub async fn save(&self, request: Value) -> Result<Arc<Config>, ConfigError> {
        let store = self.store.clone();
        let bridge_ports = self.bridge_ports.clone();
        tokio::task::spawn_blocking(move || {
            store.save_settings(&request, bridge_ports.as_ref(), |choice| {
                PortSelection::new(choice, None).probe()
            })
        })
        .await
        .map_err(|error| ConfigError::Io(std::io::Error::other(error)))??;
        // Publishes what the store holds now rather than this save's own result, so two
        // concurrent saves both publish the later config whatever order they finish in.
        let config = Arc::new(self.store.get());
        self.published.send_replace(config.clone());
        Ok(config)
    }

    /// `updateConfig(change)`: an owner's own change (the extension's kept preferences, a
    /// composer's switch). It sees the latest saved config and is published like a save, and a
    /// change that moves the bridge port is held to the same rule as a save.
    pub async fn update(
        &self,
        change: impl FnOnce(&Config) -> Result<Config, ConfigError> + Send + 'static,
    ) -> Result<Arc<Config>, ConfigError> {
        let store = self.store.clone();
        let bridge_ports = self.bridge_ports.clone();
        tokio::task::spawn_blocking(move || {
            store.update(|current| {
                let next = change(current)?;
                bridge_port_move(current, &next, bridge_ports.as_ref(), |choice| {
                    PortSelection::new(choice, None).probe()
                })?;
                Ok(next)
            })
        })
        .await
        .map_err(|error| ConfigError::Io(std::io::Error::other(error)))??;
        let config = Arc::new(self.store.get());
        self.published.send_replace(config.clone());
        Ok(config)
    }
}

/// The rule a save holds a bridge port change to: refused while `CLF_BRIDGE_PORTS` holds the
/// ports, and otherwise only when `port_free` says the bridge could bind the new port.
fn bridge_port_move(
    current: &Config,
    next: &Config,
    bridge_ports: Option<&BridgePortOverride>,
    port_free: impl FnOnce(BrowserBridgePort) -> Result<(), String>,
) -> Result<(), ConfigError> {
    let port = |config: &Config| {
        config
            .ui
            .browser_bridge_port
            .unwrap_or(BrowserBridgePort::Auto)
    };
    if port(next) == port(current) {
        return Ok(());
    }
    if bridge_ports.is_some() {
        return Err(ConfigError::BridgePortOverridden);
    }
    port_free(port(next)).map_err(ConfigError::BridgePortUnavailable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cos_store::config::first_launch_config;
    use cos_store::{Logger, Platform};

    fn with_port(port: BrowserBridgePort) -> Config {
        let mut config = first_launch_config(Platform::current());
        config.ui.browser_bridge_port = Some(port);
        config
    }

    fn free(_: BrowserBridgePort) -> Result<(), String> {
        Ok(())
    }

    #[test]
    fn a_port_move_is_refused_while_the_environment_holds_the_ports() {
        let ports = BridgePortOverride::parse("0");
        let moved = bridge_port_move(
            &with_port(BrowserBridgePort::Auto),
            &with_port(BrowserBridgePort::Fixed(8767)),
            ports.as_ref(),
            free,
        );
        assert!(matches!(moved, Err(ConfigError::BridgePortOverridden)));
        let kept = with_port(BrowserBridgePort::Fixed(8767));
        assert!(bridge_port_move(&kept, &kept, ports.as_ref(), free).is_ok());
    }

    #[test]
    fn a_port_move_asks_whether_the_new_port_binds_and_reports_why_not() {
        let mut asked = None;
        let moved = bridge_port_move(
            &with_port(BrowserBridgePort::Auto),
            &with_port(BrowserBridgePort::Fixed(8766)),
            None,
            |choice| {
                asked = Some(choice);
                Err("Port 8766 is already in use (EADDRINUSE).".into())
            },
        );
        assert_eq!(asked, Some(BrowserBridgePort::Fixed(8766)));
        assert!(matches!(
            moved,
            Err(ConfigError::BridgePortUnavailable(text)) if text == "Port 8766 is already in use (EADDRINUSE)."
        ));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_owners_update_that_moves_the_port_is_refused_and_nothing_is_stored() {
        let dir = std::env::temp_dir().join(format!("cos-core-settings-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a profile");
        let store = ConfigStore::new(dir.join("config.json"), Platform::current(), Logger::new());
        let settings = Settings::load(store, "2.1.35", BridgePortOverride::parse("0"));
        let before = settings.config().borrow().ui.browser_bridge_port;
        let refused = settings
            .update(|config| {
                let mut next = config.clone();
                next.ui.browser_bridge_port = Some(BrowserBridgePort::Fixed(8768));
                Ok(next)
            })
            .await;
        assert!(matches!(refused, Err(ConfigError::BridgePortOverridden)));
        assert_eq!(settings.config().borrow().ui.browser_bridge_port, before);
        let on_disk = std::fs::read_to_string(dir.join("config.json")).unwrap_or_default();
        assert!(!on_disk.contains("8768"), "the refused change was written");
        let kept = settings
            .update(|config| {
                let mut next = config.clone();
                next.ui.background_chats = Some(true);
                Ok(next)
            })
            .await
            .expect("a change that keeps the port");
        assert_eq!(kept.ui.background_chats, Some(true));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
