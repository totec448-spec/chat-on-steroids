//! E2.4's routes over a real loopback bridge: the transport's gates, then each route's own
//! answers, from the route cases of `test/bridge.test.ts` and the recorded fixtures of
//! `cos-types` whose answer does not depend on state the TypeScript run had built up.

mod support;

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cos_bridge::families::models::{Companion, CompanionDeps};
use cos_bridge::{ExtensionFolder, MAX_BODY_BYTES};
use cos_companion::settings::GoalKeys;
use cos_companion::status::Owners;
use cos_companion::{
    BoxFuture, ChatModels, ConfigWriter, Diagnostics, NoBrowserWork, NoChatPolicy,
    NoPluginRefreshes, NoProjects, PreferenceRequests, ProjectCreates, UsageLimits, system_clock,
};
use cos_secrets::SecretStore;
use cos_store::config::first_launch_config;
use cos_store::{DurableStore, Logger, Platform};
use cos_types::config::{BrowserPreferences, Config};
use serde_json::{Value, json};
use support::{Fixture, Options, Request, scratch};
use tokio::sync::watch;

/// The Settings owner over a watch, as `cos-core`'s publishes.
struct Published(Arc<watch::Sender<Arc<Config>>>);

impl ConfigWriter for Published {
    fn update(
        &self,
        change: Box<dyn FnOnce(&Config) -> Config + Send>,
    ) -> BoxFuture<'static, Result<Arc<Config>, String>> {
        let next = Arc::new(change(&self.0.borrow()));
        self.0.send_replace(next.clone());
        Box::pin(async move { Ok(next) })
    }
}

struct Companions {
    fixture: Fixture,
    token: String,
    models: ChatModels,
    usage: UsageLimits,
    diagnostics: Diagnostics,
    config: watch::Receiver<Arc<Config>>,
    logger: Logger,
}

impl Companions {
    async fn start() -> Self {
        let dir = scratch("cos-companion");
        let config = Arc::new(watch::Sender::new(Arc::new(first_launch_config(
            Platform::current(),
        ))));
        let logger = Logger::new();
        let clock = system_clock();
        let wake: cos_companion::WakeBrowser = Arc::new(|| {});
        let models = ChatModels::new(
            &DurableStore::new(dir.join("state"), logger.clone()),
            clock.clone(),
            wake.clone(),
            logger.clone(),
        );
        let usage = UsageLimits::new();
        let diagnostics = Diagnostics::new();
        let deps = CompanionDeps {
            owners: Owners {
                models: models.clone(),
                preferences: PreferenceRequests::new(clock.clone(), wake),
                projects: ProjectCreates::new(Arc::new(NoProjects), clock),
                plugins: Arc::new(NoPluginRefreshes),
                work: Arc::new(NoBrowserWork),
            },
            usage: usage.clone(),
            diagnostics: diagnostics.clone(),
            config: config.subscribe(),
            config_writer: Arc::new(Published(config.clone())),
            policy: Arc::new(NoChatPolicy),
            switches: Arc::new(cos_companion::NoChatSwitches),
            keys: GoalKeys::new(Arc::new(Mutex::new(SecretStore::new(&dir)))),
            extension: ExtensionFolder::checkout(dir.join("no-extension"), &dir),
            running_tool_calls: Arc::new(|| 0),
            logger: logger.clone(),
        };
        let fixture = Fixture::start_in(
            dir,
            Options {
                routes: Some(Box::new(move |routes| {
                    routes.family(Arc::new(Companion::new(deps)))
                })),
                ..Options::default()
            },
        )
        .await;
        let token = fixture.pair().await;
        Self {
            fixture,
            token,
            models,
            usage,
            diagnostics,
            config: config.subscribe(),
            logger,
        }
    }

    async fn send(&self, request: Request) -> (u16, Value) {
        let reply = self.fixture.request(request.bearer(&self.token)).await;
        (reply.status, reply.body)
    }

    async fn post(&self, path: &str, body: Value) -> (u16, Value) {
        self.send(Request::post(path).json(&body)).await
    }
}

fn fixtures() -> Vec<(String, Value)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../cos-types/tests/fixtures/http/bridge");
    let mut found: Vec<(String, Value)> = std::fs::read_dir(&dir)
        .expect("the bridge fixtures")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| {
            [
                "GET_status.",
                "POST_status.",
                "POST_models.",
                "POST_usage.",
                "GET_settings.",
                "POST_settings.",
                "POST_browser_preferences.",
                "POST_diagnostics.",
                "POST_plugin-refresh.",
                "POST_project-create.",
            ]
            .iter()
            .any(|prefix| name.starts_with(prefix))
        })
        .map(|name| {
            let fixture = serde_json::from_slice(&std::fs::read(dir.join(&name)).expect("read"))
                .expect("json");
            (name, fixture)
        })
        .collect();
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_route_is_served_behind_the_bearer_token() {
    let c = Companions::start().await;
    for (name, fixture) in fixtures() {
        let method = if fixture["method"] == "GET" {
            "GET"
        } else {
            "POST"
        };
        let route = fixture["route"].as_str().expect("route");
        let mut request = Request::new(method, route);
        if !fixture["request"].is_null() {
            request = request.json(&fixture["request"]);
        }
        let unauthorised = c.fixture.request(request.clone()).await;
        assert_eq!(
            (unauthorised.status, unauthorised.body),
            (401, json!({ "error": "unauthorised" })),
            "{name}"
        );
        if fixture["status"] == 401 {
            continue;
        }
        let served = c.send(request).await;
        // A chat's own Goal or Loop switch waits for the Goal owner.
        let body = &fixture["request"];
        let chat_switch = route == "/settings"
            && body.get("conversationId").is_some()
            && (body.get("goal").is_some() || body.get("loop").is_some());
        if !chat_switch {
            assert_ne!(
                served,
                (404, json!({ "error": "not_found" })),
                "{name} is served"
            );
        }
    }
    c.fixture.shutdown().await;
}

/// The recorded answers that hold on any profile: they depend on the body alone.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recorded_answers_that_depend_on_the_body_alone_match() {
    let c = Companions::start().await;
    for name in [
        "POST_usage.01.json",
        "POST_diagnostics.01.json",
        "POST_diagnostics.03.json",
        "POST_browser_preferences.02.json",
        "POST_project-create.01.json",
    ] {
        let fixture = fixtures()
            .into_iter()
            .find(|(found, _)| found == name)
            .expect("fixture")
            .1;
        let route = fixture["route"].as_str().expect("route");
        let answer = c.post(route, fixture["request"].clone()).await;
        let expected = match name {
            // That run had a project waiting; on a profile with none, a page's report is stale.
            "POST_project-create.01.json" => (409, json!({ "ok": false })),
            _ => (
                fixture["status"].as_u64().expect("status") as u16,
                fixture["response"].clone(),
            ),
        };
        assert_eq!(answer, expected, "{name}");
    }
    c.fixture.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn models_are_taken_only_as_the_answer_to_the_request_in_flight() {
    let c = Companions::start().await;
    let observed = json!([{ "id": "gpt-observed", "label": "GPT Observed", "efforts": ["none", "medium", "high", "xhigh"] }]);
    let answer = json!({ "nonce": "1dbd0921-77ca-47b7-9da3-b21140be7f66", "models": observed });
    assert_eq!(
        c.post("/models", answer).await,
        (409, json!({ "ok": false }))
    );
    c.models.request(true);
    let (_, status) = c.send(Request::get("/status")).await;
    let nonce = status["modelCatalogRequest"]["nonce"]
        .as_str()
        .expect("a request")
        .to_owned();
    assert_eq!(status["modelCatalogRequest"]["allowOpen"], true);
    assert_eq!(
        c.post("/models", json!({ "nonce": nonce, "waiting": "opening" }))
            .await,
        (200, json!({ "ok": true }))
    );
    assert_eq!(
        c.post("/models", json!({ "nonce": nonce, "models": observed }))
            .await,
        (200, json!({ "ok": true }))
    );
    assert_eq!(
        serde_json::to_value(&c.models.catalog().models).expect("models"),
        observed
    );
    let (_, status) = c.send(Request::get("/status")).await;
    assert_eq!(status["modelCatalogRequest"], Value::Null);
    c.fixture.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn usage_rows_that_do_not_parse_are_refused_and_good_ones_reach_the_usage_view() {
    let c = Companions::start().await;
    let now = cos_tools::EpochMs::now().0;
    let row = json!({ "model": "gpt-6", "scope": "model", "remaining": 12, "remainingPercent": 40,
        "resetAt": null, "windowSeconds": 10800 });
    assert_eq!(
        c.post("/usage", json!({ "rows": [row], "observedAt": now }))
            .await,
        (200, json!({ "ok": true }))
    );
    assert_eq!(c.usage.watch().borrow().fresh(now as f64)[0].model, "gpt-6");
    for body in [
        json!({}),
        json!({ "rows": [{ "model": "gpt-6" }] }),
        json!({ "rows": "none" }),
    ] {
        assert_eq!(
            c.post("/usage", body).await,
            (400, json!({ "error": "invalid_usage" }))
        );
    }
    let big = Request::post("/usage").raw(vec![b' '; MAX_BODY_BYTES + 1]);
    assert_eq!(
        c.send(big).await,
        (400, json!({ "error": "invalid_usage" }))
    );
    c.fixture.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn diagnostics_keep_the_preferences_the_extension_stored_and_status_hands_them_back() {
    let c = Companions::start().await;
    let report = |preferences: Value, stored: bool| {
        json!({ "capturedAt": 1, "status": { "connected": true, "paired": true }, "preferences": preferences,
            "preferencesStored": stored, "tab": null })
    };
    assert_eq!(
        c.post(
            "/diagnostics",
            report(json!({ "overwrite": true, "durations": false }), false)
        )
        .await,
        (200, json!({ "ok": true }))
    );
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(
        c.config.borrow().ui.browser_preferences,
        None,
        "a fresh install's defaults are not a choice"
    );
    assert_eq!(
        c.post(
            "/diagnostics",
            report(json!({ "overwrite": false, "durations": true }), true)
        )
        .await,
        (200, json!({ "ok": true }))
    );
    let mut config = c.config.clone();
    tokio::time::timeout(
        Duration::from_secs(5),
        config.wait_for(|config| config.ui.browser_preferences.is_some()),
    )
    .await
    .expect("kept after the answer")
    .expect("open");
    let kept = Some(BrowserPreferences {
        overwrite: false,
        durations: true,
    });
    assert_eq!(c.config.borrow().ui.browser_preferences, kept);
    let (_, status) = c.send(Request::get("/status")).await;
    assert_eq!(
        status["browserPreferences"],
        json!({ "overwrite": false, "durations": true })
    );
    assert!(c.diagnostics.watch().borrow().snapshot.is_some());
    assert_eq!(
        c.post("/diagnostics", json!("not an object")).await,
        (200, json!({ "ok": true }))
    );
    c.fixture.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settings_read_and_write_the_app_wide_switches() {
    let c = Companions::start().await;
    let (status, view) = c.send(Request::get("/settings")).await;
    assert_eq!(status, 200);
    assert_eq!(view["goal"]["own"], false);
    assert_eq!(view["goal"]["objective"], "");
    assert_eq!(view["context"]["auto"], c.config.borrow().compaction.auto);
    let (status, changed) = c
        .post("/settings", json!({ "autoCompact": false, "loop": true }))
        .await;
    assert_eq!(status, 200);
    assert_eq!(changed["context"]["auto"], false);
    assert_eq!(changed["goal"]["mode"], "loop");
    assert_eq!(changed["goal"]["enabled"], true);
    assert!(!c.config.borrow().compaction.auto);
    assert_eq!(
        c.post(
            "/settings",
            json!({ "conversationId": "a1a1a1a1-0000-4000-8000-00000000ac01", "goal": true })
        )
        .await,
        (404, json!({ "error": "not_found" })),
        "a chat's own switch waits for the Goal owner"
    );
    assert_eq!(
        c.post("/settings", json!({})).await,
        (400, json!({ "error": "nothing_to_change" }))
    );
    let bad = Request::post("/settings").raw(b"{".to_vec());
    assert_eq!(c.send(bad).await, (400, json!({ "error": "bad_request" })));
    let big = Request::post("/settings").raw(vec![b' '; MAX_BODY_BYTES + 1]);
    assert_eq!(
        c.send(big).await,
        (413, json!({ "error": "body_too_large" }))
    );
    c.fixture.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn status_answers_get_and_post_and_refuses_reports_that_name_no_chat() {
    let c = Companions::start().await;
    let (status, get) = c.send(Request::get("/status")).await;
    assert_eq!(status, 200);
    let recorded = &fixtures()
        .into_iter()
        .find(|(name, _)| name == "GET_status.01.json")
        .expect("fixture")
        .1["response"];
    let keys = |value: &Value| {
        let mut keys: Vec<String> = value.as_object().expect("object").keys().cloned().collect();
        keys.sort();
        keys
    };
    assert_eq!(
        keys(&get),
        keys(recorded),
        "every field the extension reads"
    );
    let (status, post) = c
        .post(
            "/status?repairHeld=TTTT&why=busy",
            json!({ "openConversations": [], "canReveal": true }),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(post["reveals"], json!([]));
    assert_eq!(
        c.post("/status", json!({ "openConversations": ["not a chat"] }))
            .await,
        (400, json!({ "error": "invalid_open_conversations" }))
    );
    let bad = Request::post("/status").raw(b"{".to_vec());
    assert_eq!(
        c.send(bad).await,
        (500, json!({ "error": "internal" })),
        "an unreadable report throws in bridge.ts"
    );
    assert!(
        c.logger
            .entries()
            .iter()
            .any(|entry| entry.message == "bridge request failed: invalid_json")
    );
    c.fixture.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handshakes_with_no_owner_yet_hand_out_nothing_and_refuse_reports() {
    let c = Companions::start().await;
    assert_eq!(
        c.post("/plugin-refresh", json!({ "action": "pending" }))
            .await,
        (200, json!({ "requests": [] }))
    );
    assert_eq!(
        c.post("/project-create", json!({ "action": "pending" }))
            .await,
        (200, json!({ "requests": [] }))
    );
    assert_eq!(
        c.post(
            "/project-create",
            json!({ "action": "claim", "id": "196809ee-97bf-4703-8a49-b66ba331c69b" })
        )
        .await,
        (400, json!({ "error": "invalid_request" }))
    );
    assert_eq!(
        c.post(
            "/browser/preferences",
            json!({ "nonce": "5e9140f2-1bcd-4df8-b48c-cd3cd8c8141b", "values": null })
        )
        .await,
        (409, json!({ "ok": false }))
    );
    c.fixture.shutdown().await;
}
