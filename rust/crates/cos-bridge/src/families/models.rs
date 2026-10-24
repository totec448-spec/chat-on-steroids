//! E2.4: the routes outside of chats. `/status` (the maintenance pass), `/models`, `/usage`,
//! `/settings`, `/browser/preferences`, `/diagnostics`, `/plugin-refresh` and `/project-create`,
//! as thin adapters over the owners in `cos-companion`. `/status` answers `extensionUpdate`
//! from [`ExtensionFolder::update_offer`].

use std::sync::Arc;

use cos_companion::settings::{self, GoalKeys, Outcome, Writers};
use cos_companion::status::{self, HoldLog, Invalid, Owners, Pass};
use cos_companion::{
    ChatPolicy, ChatSwitches, ConfigWriter, Diagnostics, UsageLimits, plugin_refresh,
};
use cos_store::Logger;
use cos_tools::EpochMs;
use cos_types::bridge::{ExtensionUpdateOffer, StatusQuery};
use cos_types::config::Config;
use http::Method;
use serde_json::{Value, json};
use tokio::sync::watch;

use crate::MAX_BODY_BYTES;
use crate::extension::ExtensionFolder;
use crate::limits::BodyRefusal;
use crate::router::{BoxFuture, Exchange, Family, Reply, Route};

/// Everything the family answers from. `cos-core` builds the owners once and shares them with
/// the UI.
pub struct CompanionDeps {
    pub owners: Owners,
    pub usage: UsageLimits,
    pub diagnostics: Diagnostics,
    pub config: watch::Receiver<Arc<Config>>,
    pub config_writer: Arc<dyn ConfigWriter>,
    pub policy: Arc<dyn ChatPolicy>,
    /// Per-chat Goal/Loop switches (E2.7).
    pub switches: Arc<dyn ChatSwitches>,
    pub keys: GoalKeys,
    pub extension: ExtensionFolder,
    /// Tool calls whose handlers are running now: an extension reload could cut them short.
    pub running_tool_calls: Arc<dyn Fn() -> u64 + Send + Sync>,
    pub logger: Logger,
}

pub struct Companion {
    deps: CompanionDeps,
    holds: HoldLog,
}

impl Companion {
    pub fn new(deps: CompanionDeps) -> Self {
        Self {
            deps,
            holds: HoldLog::default(),
        }
    }

    fn config(&self) -> Arc<Config> {
        self.deps.config.borrow().clone()
    }

    /// An exception in `handle()`: logged, and answered `500 internal`.
    fn failed(&self, refusal: BodyRefusal) -> Reply {
        let word = match refusal {
            BodyRefusal::TooLarge => "body_too_large",
            BodyRefusal::Invalid => "invalid_json",
            BodyRefusal::Broken => "aborted",
        };
        self.deps
            .logger
            .warn(&format!("bridge request failed: {word}"));
        Reply::internal()
    }

    /// `readBody(req)` where `bridge.ts` lets a bad body throw.
    async fn body(&self, exchange: &mut Exchange) -> Result<Value, Reply> {
        exchange
            .json(MAX_BODY_BYTES)
            .await
            .map_err(|refusal| self.failed(refusal))
    }

    async fn status(&self, mut exchange: Exchange) -> Reply {
        let report = if exchange.method() == Method::POST {
            match self.body(&mut exchange).await {
                Ok(body) => Some(body),
                Err(reply) => return reply,
            }
        } else {
            None
        };
        let peer = exchange.peer();
        let extension_update =
            self.deps
                .extension
                .update_offer(peer.build.as_deref())
                .map(|offer| ExtensionUpdateOffer {
                    build: offer.build,
                    busy: (self.deps.running_tool_calls)() > 0,
                });
        let pass = Pass {
            report,
            query: StatusQuery::parse(
                exchange
                    .query
                    .iter()
                    .map(|(key, value)| (key.as_str(), value.as_str())),
            ),
            browser: peer.browser.clone(),
            extension_update,
        };
        let config = self.config();
        match status::answer(
            &self.deps.owners,
            &config,
            pass,
            &self.holds,
            &self.deps.logger,
        )
        .await
        {
            Ok(reply) => Reply::ok(&reply),
            Err(Invalid(word)) => Reply::error(400, word),
        }
    }

    async fn models(&self, mut exchange: Exchange) -> Reply {
        let body = match self.body(&mut exchange).await {
            Ok(body) => body,
            Err(reply) => return reply,
        };
        accepted(self.deps.owners.models.observe(&body))
    }

    async fn usage(&self, mut exchange: Exchange) -> Reply {
        let invalid = || Reply::error(400, "invalid_usage");
        let Ok(body) = exchange.json(MAX_BODY_BYTES).await else {
            return invalid();
        };
        let now = EpochMs::now().0 as f64;
        match self
            .deps
            .usage
            .observe(body.get("rows"), body.get("observedAt"), now)
        {
            Ok(()) => Reply::ok(&json!({ "ok": true })),
            Err(_) => invalid(),
        }
    }

    async fn preferences(&self, mut exchange: Exchange) -> Reply {
        match self.body(&mut exchange).await {
            Ok(body) => accepted(self.deps.owners.preferences.acknowledge(&body)),
            Err(reply) => reply,
        }
    }

    async fn diagnostics(&self, mut exchange: Exchange) -> Reply {
        let body = match self.body(&mut exchange).await {
            Ok(body) => body,
            Err(reply) => return reply,
        };
        if let Some(kept) = self.deps.diagnostics.record(&body) {
            // Kept after the answer, so a slow config write never holds the extension.
            if self.config().ui.browser_preferences != Some(kept) {
                let writer = self.deps.config_writer.clone();
                let logger = self.deps.logger.clone();
                tokio::spawn(async move {
                    let result = writer
                        .update(Box::new(move |config| {
                            let mut next = config.clone();
                            next.ui.browser_preferences = Some(kept);
                            next
                        }))
                        .await;
                    if let Err(error) = result {
                        logger.warn(&format!(
                            "bridge: could not keep the extension preferences: {error}"
                        ));
                    }
                });
            }
        }
        Reply::ok(&json!({ "ok": true }))
    }

    async fn plugin_refresh(&self, mut exchange: Exchange) -> Reply {
        let body = match self.body(&mut exchange).await {
            Ok(body) => body,
            Err(reply) => return reply,
        };
        let config = self.config();
        let answer = plugin_refresh::answer(&body, &config, &self.deps.owners.plugins).await;
        Reply::json(answer.status, &answer.body)
    }

    async fn project_create(&self, mut exchange: Exchange) -> Reply {
        let body = match self.body(&mut exchange).await {
            Ok(body) => body,
            Err(reply) => return reply,
        };
        let owners = &self.deps.owners;
        let (status, body) = owners
            .projects
            .answer(&body, owners.work.as_ref(), &self.deps.logger)
            .await;
        Reply::json(status, &body)
    }

    async fn settings_view(&self) -> Reply {
        let config = self.config();
        let catalog = self.deps.owners.models.catalog();
        Reply::ok(&settings::view(&config, &catalog, &self.deps.keys).await)
    }

    async fn settings_change(&self, mut exchange: Exchange) -> Reply {
        let body = match exchange.json(MAX_BODY_BYTES).await {
            Ok(body) => body,
            Err(BodyRefusal::TooLarge) => return Reply::error(413, "body_too_large"),
            Err(_) => return Reply::error(400, "bad_request"),
        };
        let catalog = self.deps.owners.models.catalog();
        let writers = Writers {
            config: self.deps.config_writer.as_ref(),
            policy: self.deps.policy.as_ref(),
            switches: self.deps.switches.as_ref(),
            keys: &self.deps.keys,
            catalog: &catalog,
            logger: &self.deps.logger,
        };
        match settings::change(&body, writers).await {
            Outcome::Reply(status, body) => Reply::json(status, &body),
            Outcome::NotServed => Reply::error(404, "not_found"),
        }
    }
}

/// `{ ok }`: 200 when the report was taken, 409 when it was stale or not for this app.
fn accepted(ok: bool) -> Reply {
    Reply::json(if ok { 200 } else { 409 }, &json!({ "ok": ok }))
}

impl Family for Companion {
    fn routes(&self) -> &'static [Route] {
        const ROUTES: &[Route] = &[
            Route::any("/status"),
            Route::post("/models"),
            Route::post("/usage"),
            Route::get("/settings"),
            Route::post("/settings"),
            Route::post("/browser/preferences"),
            Route::post("/diagnostics"),
            Route::post("/plugin-refresh"),
            Route::post("/project-create"),
        ];
        ROUTES
    }

    fn serve(self: Arc<Self>, exchange: Exchange) -> BoxFuture<Reply> {
        Box::pin(async move {
            match (exchange.path(), exchange.method() == Method::GET) {
                ("/status", _) => self.status(exchange).await,
                ("/models", _) => self.models(exchange).await,
                ("/usage", _) => self.usage(exchange).await,
                ("/settings", true) => self.settings_view().await,
                ("/settings", false) => self.settings_change(exchange).await,
                ("/browser/preferences", _) => self.preferences(exchange).await,
                ("/diagnostics", _) => self.diagnostics(exchange).await,
                ("/plugin-refresh", _) => self.plugin_refresh(exchange).await,
                _ => self.project_create(exchange).await,
            }
        })
    }
}
