//! `/settings`, `/status` and the `/plugin-refresh` handshake, from the route cases of
//! `test/bridge.test.ts` and the recorded fixtures of `cos-types`.

mod support;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use cos_companion::settings::{self, GoalKeys, Outcome, Writers};
use cos_companion::status::{self, HoldLog, Invalid, Owners, Pass};
use cos_companion::{
    BoxFuture, BrowserWork, ChatModelCatalog, ChatModels, ChatPolicy, ConfigWriter, NoChatPolicy,
    NoPluginRefreshes, NoProjects, PluginRefreshes, PreferenceRequests, ProjectCreates, StatusCall,
    WorkParts, plugin_refresh,
};
use cos_secrets::SecretStore;
use cos_store::config::first_launch_config;
use cos_store::{DurableStore, Logger, Platform};
use cos_types::bridge::{ExtensionUpdateOffer, PendingPluginRefresh, StatusQuery};
use cos_types::config::{BackgroundPlacement, Config, GoalBackend, GoalMode, GoalProviderKind};
use serde_json::{Value, json};
use support::{ManualClock, Wakes, scratch};

const NOW: u64 = 1_767_225_600_000;

/// The Settings owner in memory.
#[derive(Clone)]
struct Saved(Arc<Mutex<Config>>);

impl Saved {
    fn new(config: Config) -> Self {
        Self(Arc::new(Mutex::new(config)))
    }

    fn get(&self) -> Config {
        self.0.lock().expect("lock").clone()
    }
}

impl ConfigWriter for Saved {
    fn update(
        &self,
        change: Box<dyn FnOnce(&Config) -> Config + Send>,
    ) -> BoxFuture<'static, Result<Arc<Config>, String>> {
        let saved = self.0.clone();
        Box::pin(async move {
            let mut config = saved.lock().expect("lock");
            *config = change(&config);
            Ok(Arc::new(config.clone()))
        })
    }
}

/// A chat-level owner that answers what a test says, and counts what it was asked to do.
#[derive(Default)]
struct Policy {
    superseded: bool,
    blocked: bool,
    worker: bool,
    cancel_fails: bool,
    cancelled: AtomicUsize,
    retired: Mutex<Vec<bool>>,
}

impl ChatPolicy for Policy {
    fn superseded(&self, _: String) -> BoxFuture<'static, bool> {
        let superseded = self.superseded;
        Box::pin(async move { superseded })
    }

    fn blocked(&self, _: &str) -> bool {
        self.blocked
    }

    fn worker(&self, _: &str) -> bool {
        self.worker
    }

    fn cancel_automatic_resumes(&self) -> BoxFuture<'static, Result<(), String>> {
        self.cancelled.fetch_add(1, Ordering::SeqCst);
        let fails = self.cancel_fails;
        Box::pin(async move {
            if fails {
                Err("disk full".into())
            } else {
                Ok(())
            }
        })
    }

    fn retire_goal_drafts(&self, all: bool) {
        self.retired.lock().expect("lock").push(all);
    }
}

fn config() -> Config {
    let mut config = first_launch_config(Platform::current());
    config.compaction.auto_tokens = 400_000;
    config.sessions.advisory_tokens = 400_000;
    config.sessions.limit_tokens = 533_333;
    config
}

fn keys() -> GoalKeys {
    GoalKeys::new(Arc::new(Mutex::new(SecretStore::new(scratch("cos-keys")))))
}

fn unknown_catalog() -> ChatModelCatalog {
    let models = ChatModels::new(
        &DurableStore::new(scratch("cos-catalog"), Logger::new()),
        ManualClock::at(NOW).clock(),
        Wakes::default().wake(),
        Logger::new(),
    );
    models.catalog()
}

async fn post(body: Value, saved: &Saved, policy: &dyn ChatPolicy) -> Outcome {
    let catalog = unknown_catalog();
    let keys = keys();
    let logger = Logger::new();
    settings::change(
        &body,
        Writers {
            config: saved,
            policy,
            switches: &cos_companion::NoChatSwitches,
            keys: &keys,
            catalog: &catalog,
            logger: &logger,
        },
    )
    .await
}

fn reply(outcome: Outcome) -> (u16, Value) {
    match outcome {
        Outcome::Reply(status, body) => (status, body),
        Outcome::NotServed => panic!("expected a reply"),
    }
}

const CHAT: &str = "a1a1a1a1-0000-4000-8000-00000000ac01";

#[tokio::test]
async fn get_settings_reads_the_app_wide_switches_with_no_chat_of_its_own() {
    let mut saved = config();
    saved.goal.enabled = true;
    saved.goal.mode = GoalMode::Loop;
    let view = settings::view(&saved, &unknown_catalog(), &keys()).await;
    assert_eq!(
        view,
        json!({
            "context": { "auto": true, "threshold": 400000, "warn": 400000, "limit": 533333 },
            "followOutput": true,
            "mentionCore": true,
            "goal": { "enabled": true, "own": false, "mode": "loop", "backend": "chatgpt", "model": "gpt-6",
                "provider": "openrouter", "hasKey": true, "objective": "", "blocked": "" }
        })
    );
}

#[tokio::test]
async fn an_api_driver_without_a_key_says_so_and_a_custom_endpoint_needs_none() {
    let mut saved = config();
    saved.goal.backend = Some(GoalBackend::Api);
    let view = settings::view(&saved, &unknown_catalog(), &keys()).await;
    assert_eq!(view["goal"]["backend"], "api");
    assert_eq!(view["goal"]["model"], "z-ai/glm-5.3");
    assert_eq!(view["goal"]["hasKey"], false);
    saved.goal.provider.kind = GoalProviderKind::Custom;
    let view = settings::view(&saved, &unknown_catalog(), &keys()).await;
    assert_eq!(view["goal"]["hasKey"], true);
}

#[tokio::test]
async fn post_settings_turns_app_wide_compaction_and_goal_off_and_answers_the_new_state() {
    let saved = Saved::new(config());
    let policy = Policy::default();
    let (status, body) = reply(
        post(
            json!({ "autoCompact": false, "goal": false }),
            &saved,
            &policy,
        )
        .await,
    );
    assert_eq!(status, 200);
    assert_eq!(
        body,
        json!({
            "context": { "auto": false, "threshold": 400000, "warn": 400000, "limit": 533333 },
            "goal": { "enabled": false, "own": false, "mode": "goal", "backend": "chatgpt", "model": "gpt-6",
                "provider": "openrouter", "hasKey": true }
        })
    );
    assert!(!saved.get().compaction.auto);
    assert_eq!(
        policy.cancelled.load(Ordering::SeqCst),
        1,
        "Auto Off cancels pending tickets"
    );
    assert!(
        policy.retired.lock().expect("lock").is_empty(),
        "the driving mode did not change"
    );
}

#[tokio::test]
async fn a_new_chat_moves_the_app_wide_goal_and_loop_switch() {
    let saved = Saved::new(config());
    let policy = Policy::default();
    let (_, body) = reply(post(json!({ "loop": true }), &saved, &policy).await);
    assert_eq!(body["goal"]["enabled"], true);
    assert_eq!(body["goal"]["mode"], "loop");
    assert_eq!(saved.get().goal.mode, GoalMode::Loop);
    // Off for the mode that is not on changes nothing; off for the one that is turns it off.
    reply(post(json!({ "goal": false }), &saved, &policy).await);
    assert!(saved.get().goal.enabled);
    reply(post(json!({ "loop": false }), &saved, &policy).await);
    assert!(!saved.get().goal.enabled);
    assert_eq!(
        *policy.retired.lock().expect("lock"),
        vec![false, true],
        "drafts made under another instruction retire"
    );
}

#[tokio::test]
async fn a_chat_scoped_switch_belongs_to_the_goal_owner_and_is_not_served_yet() {
    let saved = Saved::new(config());
    let before = saved.get();
    for body in [
        json!({ "conversationId": CHAT, "loop": true }),
        json!({ "conversationId": CHAT, "goal": false, "autoCompact": true }),
        json!({ "conversationId": CHAT, "loopAfterTurn": true }),
    ] {
        assert_eq!(
            post(body.clone(), &saved, &NoChatPolicy).await,
            Outcome::NotServed,
            "{body}"
        );
    }
    assert_eq!(saved.get(), before, "nothing was written");
    // Compaction from a chat's composer is still the app-wide setting.
    let (status, body) = reply(
        post(
            json!({ "conversationId": CHAT, "autoCompact": false }),
            &saved,
            &NoChatPolicy,
        )
        .await,
    );
    assert_eq!(status, 200);
    assert_eq!(body["context"]["auto"], false);
}

#[tokio::test]
async fn post_settings_refuses_what_describes_no_change_or_no_real_state() {
    let saved = Saved::new(config());
    let cases = [
        (json!({}), "nothing_to_change"),
        (json!({ "autoCompact": "yes" }), "nothing_to_change"),
        (
            json!({ "goal": true, "loop": false }),
            "goal_and_loop_exclusive",
        ),
        (json!({ "loopAfterTurn": true }), "bad_loop_delivery"),
        (
            json!({ "conversationId": CHAT, "loopAfterTurn": true, "goal": true }),
            "bad_loop_delivery",
        ),
    ];
    for (body, word) in cases {
        assert_eq!(
            reply(post(body.clone(), &saved, &NoChatPolicy).await),
            (400, json!({ "error": word })),
            "{body}"
        );
    }
}

#[tokio::test]
async fn a_chat_that_may_not_take_a_switch_is_refused_before_anything_is_written() {
    let saved = Saved::new(config());
    let before = saved.get();
    let superseded = Policy {
        superseded: true,
        ..Policy::default()
    };
    assert_eq!(
        reply(
            post(
                json!({ "conversationId": CHAT, "autoCompact": true }),
                &saved,
                &superseded
            )
            .await
        ),
        (409, json!({ "error": "conversation_superseded" }))
    );
    let blocked = Policy {
        blocked: true,
        ..Policy::default()
    };
    let (status, body) = reply(
        post(
            json!({ "conversationId": CHAT, "autoCompact": true }),
            &saved,
            &blocked,
        )
        .await,
    );
    assert_eq!((status, &body["error"]), (409, &json!("chat_blocked")));
    // Turning things off stays the person's to do from a blocked chat.
    let (status, _) = reply(
        post(
            json!({ "conversationId": CHAT, "autoCompact": false }),
            &saved,
            &blocked,
        )
        .await,
    );
    assert_eq!(status, 200);
    let worker = Policy {
        worker: true,
        ..Policy::default()
    };
    let (status, body) = reply(
        post(
            json!({ "conversationId": CHAT, "autoCompact": false }),
            &saved,
            &worker,
        )
        .await,
    );
    assert_eq!(
        (status, &body["error"]),
        (409, &json!("worker_compaction_disabled"))
    );
    assert!(
        before.compaction.auto && !saved.get().compaction.auto,
        "only the off switch was written"
    );
}

#[tokio::test]
async fn auto_off_that_cannot_cancel_its_tickets_durably_asks_for_a_retry() {
    let saved = Saved::new(config());
    let policy = Policy {
        cancel_fails: true,
        ..Policy::default()
    };
    assert_eq!(
        reply(post(json!({ "autoCompact": false }), &saved, &policy).await),
        (
            503,
            json!({ "error": "auto_compaction_cancel_not_durable", "retryable": true })
        )
    );
}

/// Records the pass it was given.
#[derive(Clone, Default)]
struct Seen(Arc<Mutex<Option<StatusCall>>>);

impl BrowserWork for Seen {
    fn status(&self, call: StatusCall) -> BoxFuture<'static, WorkParts> {
        let parts = WorkParts::none(&call);
        *self.0.lock().expect("lock") = Some(call);
        Box::pin(async move { parts })
    }

    fn input_project(&self, _: String) -> BoxFuture<'static, Option<String>> {
        Box::pin(async { None })
    }
}

struct StatusFixture {
    owners: Owners,
    seen: Seen,
}

fn status_fixture(plugins: Arc<dyn PluginRefreshes>) -> StatusFixture {
    let clock = ManualClock::at(NOW);
    let wakes = Wakes::default();
    let seen = Seen::default();
    let owners = Owners {
        models: ChatModels::new(
            &DurableStore::new(scratch("cos-status"), Logger::new()),
            clock.clock(),
            wakes.wake(),
            Logger::new(),
        ),
        preferences: PreferenceRequests::new(clock.clock(), wakes.wake()),
        projects: ProjectCreates::new(Arc::new(NoProjects), clock.clock()),
        plugins,
        work: Arc::new(seen.clone()),
    };
    StatusFixture { owners, seen }
}

async fn pass(
    f: &StatusFixture,
    config: &Config,
    report: Option<Value>,
    query: &[(&str, &str)],
) -> Result<Value, Invalid> {
    let pass = Pass {
        report,
        query: StatusQuery::parse(query.iter().copied()),
        browser: Some("browser-1".into()),
        extension_update: None,
    };
    status::answer(&f.owners, config, pass, &HoldLog::default(), &Logger::new())
        .await
        .map(|reply| serde_json::to_value(reply).expect("serializes"))
}

#[tokio::test]
async fn a_quiet_install_answers_the_maintenance_pass_with_its_config_and_no_work() {
    let f = status_fixture(Arc::new(NoPluginRefreshes));
    let mut saved = config();
    saved.ui.background_chats = Some(true);
    saved.ui.background_placement = Some(BackgroundPlacement::Window);
    let reply = pass(&f, &saved, None, &[]).await.expect("answers");
    assert_eq!(
        reply,
        json!({
            "ok": true, "conversations": [], "stopTurns": [], "modelCatalogRequest": null,
            "connectorNames": { "core": "Chat On Steroids Core", "desktop": "Chat On Steroids Desktop",
                "plugins": "Chat On Steroids Plugins" },
            "connectorApps": { "core": [], "desktop": [], "plugins": [] },
            "pluginRefreshRequests": [], "browserPreferenceRequest": null, "projectCreateRequests": [],
            "inputOpeningIds": [], "inputs": [], "background": true, "backgroundPlacement": "window",
            "browserOnly": false, "browserWindowBounds": { "width": 800, "height": 600 },
            "commands": 0, "commandIds": [], "revival": null, "revivals": [], "placement": null,
            "repairs": [], "idleReuseAfterMs": 120000, "idleCloseAfterMs": 300000,
            "cancelledDecisionClaims": [], "retiredConversations": [], "conversationActivityAt": {},
            "managedConversations": [], "reusableConversations": [], "nonDiscardableConversations": [],
            "blockedConversations": [], "closableConversations": [], "recoveryMonitoring": false,
            "extensionUpdate": null, "language": null, "browserPreferences": null
        })
    );
    let call = f
        .seen
        .0
        .lock()
        .expect("lock")
        .clone()
        .expect("the work owners were asked");
    assert!(!call.post);
    assert_eq!(call.browser.as_deref(), Some("browser-1"));
}

#[tokio::test]
async fn a_post_pass_reports_its_tabs_and_receipt_to_the_work_owners() {
    let f = status_fixture(Arc::new(NoPluginRefreshes));
    let report = json!({ "openConversations": ["a1a1a1a1-0000-4000-8000-00000000ad01"],
        "stalledConversations": ["a1a1a1a1-0000-4000-8000-00000000ad01"], "canReveal": true, "canExportImages": true });
    let reply = pass(
        &f,
        &config(),
        Some(report),
        &[("repaired", "TTTTTTTTTTTT"), ("repairAction", "reloaded")],
    )
    .await
    .expect("answers");
    assert_eq!(reply["reveals"], json!([]));
    assert_eq!(reply["imageExports"], json!([]));
    let call = f.seen.0.lock().expect("lock").clone().expect("asked");
    assert!(call.post && call.can_reveal && call.can_export_images);
    assert_eq!(
        call.open_conversations,
        vec!["a1a1a1a1-0000-4000-8000-00000000ad01"]
    );
    assert_eq!(call.stalled_conversations, call.open_conversations);
    assert!(
        call.query.receipt.is_some(),
        "the receipt reaches the repair owner"
    );
}

#[tokio::test]
async fn a_pass_that_names_something_other_than_a_chat_is_refused() {
    let f = status_fixture(Arc::new(NoPluginRefreshes));
    let cases = [
        (json!({}), "invalid_open_conversations"),
        (
            json!({ "openConversations": "a1a1a1a1-0000" }),
            "invalid_open_conversations",
        ),
        (
            json!({ "openConversations": ["not a chat"] }),
            "invalid_open_conversations",
        ),
        (
            json!({ "openConversations": vec!["a1a1a1a1"; 10_001] }),
            "invalid_open_conversations",
        ),
        (
            json!({ "openConversations": [], "stalledConversations": null }),
            "invalid_stalled_conversations",
        ),
        (
            json!({ "openConversations": [], "stalledConversations": ["zz"] }),
            "invalid_stalled_conversations",
        ),
    ];
    for (report, word) in cases {
        assert_eq!(
            pass(&f, &config(), Some(report), &[]).await,
            Err(Invalid(word))
        );
    }
}

#[tokio::test]
async fn the_pass_hands_out_the_apps_requests_and_the_extensions_kept_settings() {
    let f = status_fixture(Arc::new(NoPluginRefreshes));
    let mut saved = config();
    saved.connector_suffix = Some("Work PC".into());
    saved.ui.browser_preferences = Some(cos_types::config::BrowserPreferences {
        overwrite: false,
        durations: true,
    });
    saved.ui.browser_only = Some(true);
    saved.ui.background_placement = Some(BackgroundPlacement::Group);
    f.owners.models.request(false);
    let reply = pass(&f, &saved, None, &[]).await.expect("answers");
    let nonce = f.owners.models.pending_request().expect("pending").nonce;
    assert_eq!(
        reply["modelCatalogRequest"],
        json!({ "nonce": nonce, "expiresAt": NOW + 120_000, "allowOpen": false })
    );
    assert_eq!(
        reply["connectorNames"]["core"],
        "Chat On Steroids Core (Work PC)"
    );
    assert_eq!(
        reply["browserPreferences"],
        json!({ "overwrite": false, "durations": true })
    );
    assert_eq!(reply["browserOnly"], true);
    assert_eq!(reply["backgroundPlacement"], "group");

    let pass_with_offer = Pass {
        report: None,
        query: StatusQuery::default(),
        browser: None,
        extension_update: Some(ExtensionUpdateOffer {
            build: "0123456789ab".into(),
            busy: true,
        }),
    };
    let offered = status::answer(
        &f.owners,
        &saved,
        pass_with_offer,
        &HoldLog::default(),
        &Logger::new(),
    )
    .await
    .expect("answers");
    assert_eq!(
        serde_json::to_value(offered.extension_update).expect("offer"),
        json!({ "build": "0123456789ab", "busy": true })
    );
}

/// A plugin owner with one publication and one pending refresh.
struct OnePublication;

impl PluginRefreshes for OnePublication {
    fn pending(&self, automatic: bool) -> BoxFuture<'static, Vec<PendingPluginRefresh>> {
        Box::pin(async move {
            assert!(automatic);
            vec![serde_json::from_value(json!({ "surface": "core", "schemaId": "s1", "connectorName": "Chat On Steroids Core",
                "tools": [], "id": "16f3c4de-3588-4e50-8c0f-209d342cd733", "appId": null })).expect("pending")]
        })
    }

    fn claim(
        &self,
        identity: plugin_refresh::Identity,
        enrollment: plugin_refresh::Enrollment,
        current: bool,
    ) -> BoxFuture<'static, bool> {
        Box::pin(async move {
            !current
                && identity.app_id == "asdk_app_synthetic"
                && enrollment.tunnel_id.as_deref().is_none_or(|tunnel| {
                    enrollment
                        .own_tunnels
                        .owns(cos_types::state::PluginSurface::Core, tunnel)
                })
        })
    }

    fn manual(
        &self,
        _: plugin_refresh::Identity,
        _: plugin_refresh::Enrollment,
        error: String,
    ) -> BoxFuture<'static, bool> {
        Box::pin(async move { error.chars().count() == 200 })
    }

    fn complete(
        &self,
        _: plugin_refresh::Identity,
        _: Option<Value>,
        version: Option<String>,
    ) -> BoxFuture<'static, bool> {
        Box::pin(async move { version.as_deref() == Some("asdk_app_v_synthetic") })
    }

    fn fail(&self, _: String, error: String) -> BoxFuture<'static, bool> {
        Box::pin(async move { !error.is_empty() })
    }

    fn publications(&self) -> Vec<cos_types::bridge::PluginRefreshRequest> {
        vec![serde_json::from_value(json!({ "surface": "core", "schemaId": "s1", "connectorName": "Chat On Steroids Core" }))
            .expect("publication")]
    }

    fn connector_apps(&self) -> cos_types::bridge::ConnectorApps {
        serde_json::from_value(
            json!({ "core": [{ "appId": "asdk_app_synthetic", "linkId": null, "name": "Core" }],
            "desktop": [], "plugins": [] }),
        )
        .expect("apps")
    }
}

const REFRESH: &str = "16f3c4de-3588-4e50-8c0f-209d342cd733";

#[tokio::test]
async fn plugin_refresh_follows_the_persons_automatic_refresh_setting() {
    let owner: Arc<dyn PluginRefreshes> = Arc::new(OnePublication);
    let mut saved = config();
    saved.ui.auto_refresh_plugins = Some(false);
    let off = plugin_refresh::answer(&json!({ "action": "pending" }), &saved, &owner).await;
    assert_eq!((off.status, off.body), (200, json!({ "requests": [] })));
    let refused = plugin_refresh::answer(
        &json!({ "action": "claim", "id": REFRESH, "appId": "asdk_app_synthetic", "connectorName": "Chat On Steroids Core" }),
        &saved,
        &owner,
    )
    .await;
    assert_eq!(
        (refused.status, refused.body),
        (
            409,
            json!({ "ok": false, "error": "automatic_refresh_disabled" })
        )
    );
    let f = status_fixture(owner.clone());
    assert_eq!(
        pass(&f, &saved, None, &[]).await.expect("answers")["pluginRefreshRequests"],
        json!([])
    );

    saved.ui.auto_refresh_plugins = Some(true);
    let on = plugin_refresh::answer(&json!({ "action": "pending" }), &saved, &owner).await;
    assert_eq!(on.body["requests"][0]["id"], REFRESH);
    let status = pass(&f, &saved, None, &[]).await.expect("answers");
    assert_eq!(
        status["pluginRefreshRequests"],
        json!([{ "surface": "core", "schemaId": "s1", "connectorName": "Chat On Steroids Core" }])
    );
    assert_eq!(
        status["connectorApps"]["core"][0]["appId"],
        "asdk_app_synthetic"
    );
}

#[tokio::test]
async fn plugin_refresh_checks_ids_and_hands_the_owner_cut_reports() {
    let owner: Arc<dyn PluginRefreshes> = Arc::new(OnePublication);
    let mut saved = config();
    saved.ui.auto_refresh_plugins = Some(true);
    saved.tunnel.tunnel_id = "tunnel_abcdef0123".into();
    let answer = |body: Value| {
        let saved = saved.clone();
        let owner = owner.clone();
        async move {
            let answer = plugin_refresh::answer(&body, &saved, &owner).await;
            (answer.status, answer.body)
        }
    };
    assert_eq!(
        answer(json!({ "action": "claim", "id": "short" })).await,
        (400, json!({ "error": "invalid_request" }))
    );
    assert_eq!(
        answer(json!(null)).await,
        (400, json!({ "error": "invalid_request" }))
    );
    let claim = json!({ "action": "claim", "id": REFRESH, "appId": "asdk_app_synthetic", "connectorName": "Chat On Steroids Core" });
    assert_eq!(answer(claim.clone()).await, (200, json!({ "ok": true })));
    let mut foreign = claim.clone();
    foreign["tunnelId"] = json!("tunnel_someoneelse");
    assert_eq!(
        answer(foreign).await,
        (409, json!({ "ok": false })),
        "a tunnel that is not this install's"
    );
    let mut own = claim.clone();
    own["tunnelId"] = json!("tunnel_abcdef0123");
    assert_eq!(answer(own).await, (200, json!({ "ok": true })));
    let mut bad_app = claim;
    bad_app["appId"] = json!("app_synthetic");
    assert_eq!(answer(bad_app).await, (409, json!({ "ok": false })));
    let manual = json!({ "action": "manual", "id": REFRESH, "appId": "asdk_app_synthetic",
        "connectorName": "Chat On Steroids Core", "error": "x".repeat(300) });
    assert_eq!(
        answer(manual).await,
        (200, json!({ "ok": true })),
        "the error is cut to 200 characters"
    );
    let complete = json!({ "action": "complete", "id": REFRESH, "appId": "asdk_app_synthetic", "versionId": "asdk_app_v_synthetic" });
    assert_eq!(answer(complete).await, (200, json!({ "ok": true })));
    assert_eq!(
        answer(json!({ "action": "fail", "id": REFRESH, "error": "no page" })).await,
        (200, json!({ "ok": true }))
    );
    assert_eq!(
        answer(json!({ "action": "fail", "id": REFRESH })).await,
        (409, json!({ "ok": false }))
    );
    // With no plugin owner nothing is pending and every report is refused.
    let none: Arc<dyn PluginRefreshes> = Arc::new(NoPluginRefreshes);
    let refused = plugin_refresh::answer(
        &json!({ "action": "complete", "id": REFRESH, "appId": "asdk_app_synthetic" }),
        &saved,
        &none,
    )
    .await;
    assert_eq!(
        (refused.status, refused.body),
        (409, json!({ "ok": false }))
    );
}
