//! The `/plugin-refresh` handshake: a page refreshes a connector whose tools changed, in
//! ChatGPT's own settings, and reports what it saw. The refresh ledger
//! (`state/plugin-refresh.json`) and the publications belong to the plugin owner behind
//! [`PluginRefreshes`]; this module checks the request and the person's setting first, as
//! `bridge.ts` does.

use std::sync::Arc;

use cos_types::bridge::{ConnectorApps, PendingPluginRefresh, PluginRefreshRequest};
use cos_types::config::Config;
use cos_types::state::PluginSurface;
use serde_json::{Value, json};

use crate::BoxFuture;
use crate::text::{js_cut, request_id, string};

/// Which ChatGPT app a page found for one refresh request.
#[derive(Clone, Debug, PartialEq)]
pub struct Identity {
    pub id: String,
    /// `asdk_app_…`.
    pub app_id: String,
}

/// What a page saw of the connector it is about to refresh (`Enrollment`).
#[derive(Clone, Debug, PartialEq)]
pub struct Enrollment {
    pub connector_name: String,
    /// The tools ChatGPT lists, as the page sent them.
    pub tools: Option<Value>,
    /// `tunnel_…`, the tunnel the connector points at.
    pub tunnel_id: Option<String>,
    /// This install's tunnel per surface, from config, so the owner can check `tunnel_id`.
    pub own_tunnels: OwnTunnels,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OwnTunnels {
    pub core: String,
    pub desktop: String,
    pub plugins: String,
}

impl OwnTunnels {
    fn of(config: &Config) -> Self {
        Self {
            core: config.tunnel.tunnel_id.clone(),
            desktop: config.tunnel.desktop_tunnel_id.clone(),
            plugins: config.tunnel.plugins_tunnel_id.clone().unwrap_or_default(),
        }
    }

    /// `ownsTunnel(surface, id)`.
    pub fn owns(&self, surface: PluginSurface, tunnel_id: &str) -> bool {
        let own = match surface {
            PluginSurface::Core => &self.core,
            PluginSurface::Desktop => &self.desktop,
            PluginSurface::Plugins => &self.plugins,
        };
        own == tunnel_id
    }
}

/// The plugin owner (`plugin-refresh.ts`): its ledger, its publications and the connector apps
/// proven to be this install's.
pub trait PluginRefreshes: Send + Sync + 'static {
    fn pending(&self, automatic: bool) -> BoxFuture<'static, Vec<PendingPluginRefresh>>;
    /// `claim`, or `current` when ChatGPT already shows the current tools.
    fn claim(
        &self,
        identity: Identity,
        enrollment: Enrollment,
        already_current: bool,
    ) -> BoxFuture<'static, bool>;
    fn manual(
        &self,
        identity: Identity,
        enrollment: Enrollment,
        error: String,
    ) -> BoxFuture<'static, bool>;
    fn complete(
        &self,
        identity: Identity,
        tools: Option<Value>,
        version_id: Option<String>,
    ) -> BoxFuture<'static, bool>;
    fn fail(&self, id: String, error: String) -> BoxFuture<'static, bool>;
    /// `pluginRefreshPublications()`: every connector whose tools the page should check.
    fn publications(&self) -> Vec<PluginRefreshRequest>;
    /// `connectorApps()`: apps proven to be this install's connectors, by surface.
    fn connector_apps(&self) -> ConnectorApps;
}

/// No connector published and no refresh ledger.
pub struct NoPluginRefreshes;

impl PluginRefreshes for NoPluginRefreshes {
    fn pending(&self, _automatic: bool) -> BoxFuture<'static, Vec<PendingPluginRefresh>> {
        Box::pin(async { Vec::new() })
    }

    fn claim(&self, _: Identity, _: Enrollment, _: bool) -> BoxFuture<'static, bool> {
        Box::pin(async { false })
    }

    fn manual(&self, _: Identity, _: Enrollment, _: String) -> BoxFuture<'static, bool> {
        Box::pin(async { false })
    }

    fn complete(
        &self,
        _: Identity,
        _: Option<Value>,
        _: Option<String>,
    ) -> BoxFuture<'static, bool> {
        Box::pin(async { false })
    }

    fn fail(&self, _: String, _: String) -> BoxFuture<'static, bool> {
        Box::pin(async { false })
    }

    fn publications(&self) -> Vec<PluginRefreshRequest> {
        Vec::new()
    }

    fn connector_apps(&self) -> ConnectorApps {
        ConnectorApps {
            core: Vec::new(),
            desktop: Vec::new(),
            plugins: Vec::new(),
        }
    }
}

/// A status and a JSON body, the route's answer.
#[derive(Clone, Debug, PartialEq)]
pub struct Answer {
    pub status: u16,
    pub body: Value,
    /// An accepted change: the app republishes its state.
    pub changed: bool,
}

impl Answer {
    fn of(status: u16, body: Value) -> Self {
        Self {
            status,
            body,
            changed: false,
        }
    }
}

/// `/^asdk_app_[a-zA-Z0-9_-]{1,160}$/`.
fn app_id(value: Option<&Value>) -> Option<&str> {
    string(value).filter(|id| {
        id.strip_prefix("asdk_app_").is_some_and(|rest| {
            (1..=160).contains(&rest.len())
                && rest
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
    })
}

/// `/^tunnel_[a-zA-Z0-9]{8,80}$/`.
fn tunnel_id(value: Option<&Value>) -> Option<&str> {
    string(value).filter(|id| {
        id.strip_prefix("tunnel_").is_some_and(|rest| {
            (8..=80).contains(&rest.len()) && rest.bytes().all(|b| b.is_ascii_alphanumeric())
        })
    })
}

/// `POST /plugin-refresh`.
pub async fn answer(raw: &Value, config: &Config, owner: &Arc<dyn PluginRefreshes>) -> Answer {
    let empty = serde_json::Map::new();
    let body = raw.as_object().unwrap_or(&empty);
    let action = string(body.get("action"));
    let automatic = config.ui.auto_refresh_plugins == Some(true);
    if action == Some("pending") {
        let requests = if automatic {
            owner.pending(true).await
        } else {
            Vec::new()
        };
        return Answer::of(200, json!({ "requests": requests }));
    }
    // Turning the setting off also revokes a request already handed to the page.
    if action == Some("claim") && !automatic {
        return Answer::of(
            409,
            json!({ "ok": false, "error": "automatic_refresh_disabled" }),
        );
    }
    let Some(id) = request_id(body.get("id")) else {
        return Answer::of(400, json!({ "error": "invalid_request" }));
    };
    let id = id.to_owned();
    let enrollment = |connector_name: &str| Enrollment {
        connector_name: connector_name.to_owned(),
        tools: body.get("tools").cloned(),
        tunnel_id: tunnel_id(body.get("tunnelId")).map(str::to_owned),
        own_tunnels: OwnTunnels::of(config),
    };
    let connector = string(body.get("connectorName"));
    let error = string(body.get("error"));
    let ok = match (action, app_id(body.get("appId"))) {
        (Some("fail"), _) if error.is_some() => {
            owner.fail(id, js_cut(error.unwrap_or_default(), 200)).await
        }
        (Some(action @ ("claim" | "current")), Some(app_id)) => match connector {
            Some(connector) => {
                let identity = Identity {
                    id,
                    app_id: app_id.to_owned(),
                };
                owner
                    .claim(identity, enrollment(connector), action == "current")
                    .await
            }
            None => false,
        },
        (Some("manual"), Some(app_id)) => match (connector, error) {
            (Some(connector), Some(error)) => {
                let identity = Identity {
                    id,
                    app_id: app_id.to_owned(),
                };
                owner
                    .manual(identity, enrollment(connector), js_cut(error, 200))
                    .await
            }
            _ => false,
        },
        (Some("complete"), Some(app_id)) => {
            let identity = Identity {
                id,
                app_id: app_id.to_owned(),
            };
            let version = string(body.get("versionId")).map(|version| js_cut(version, 200));
            owner
                .complete(identity, body.get("tools").cloned(), version)
                .await
        }
        _ => false,
    };
    Answer {
        status: if ok { 200 } else { 409 },
        body: json!({ "ok": ok }),
        changed: ok,
    }
}
