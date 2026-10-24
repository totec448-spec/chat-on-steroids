//! The cases of `test/chat-models.test.ts` that do not launch a browser, against the catalog
//! owner.

mod support;

use cos_companion::{CatalogState, ChatModels, helper_selection, resolve_chat_model};
use cos_store::config::first_launch_config;
use cos_store::{DurableStore, Logger, Platform};
use std::path::PathBuf;

use cos_types::state::ChatModelOption;
use serde_json::{Value, json};
use support::{ManualClock, Wakes, scratch};

const START: u64 = 1_767_225_600_000;

fn models() -> Value {
    json!([{ "id": "gpt-example", "label": "GPT Example", "efforts": ["none", "medium", "high", "xhigh"] }])
}

struct Fixture {
    owner: ChatModels,
    clock: ManualClock,
    wakes: Wakes,
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        Self::in_state(scratch("cos-models"))
    }

    fn in_state(root: PathBuf) -> Self {
        let state = DurableStore::new(&root, Logger::new());
        let clock = ManualClock::at(START);
        let wakes = Wakes::default();
        let owner = ChatModels::new(&state, clock.clock(), wakes.wake(), Logger::new());
        Self {
            owner,
            clock,
            wakes,
            root,
        }
    }

    fn nonce(&self) -> String {
        self.owner.pending_request().expect("a request").nonce
    }

    fn observe_models(&self) -> bool {
        self.owner
            .observe(&json!({ "nonce": self.nonce(), "models": models() }))
    }
}

fn listed(catalog_models: &[ChatModelOption]) -> Value {
    serde_json::to_value(catalog_models).expect("serializes")
}

#[test]
fn gives_the_first_explicit_promotion_a_fresh_budget_without_extending_repeated_refresh_clicks() {
    let f = Fixture::new();
    f.owner.request(false);
    let passive = f.owner.pending_request().expect("passive");
    f.clock.advance(80_000);
    f.owner.request(true);
    let promoted = f.owner.pending_request().expect("promoted");
    assert_eq!(promoted.nonce, passive.nonce);
    assert!(promoted.allow_open);
    assert_eq!(promoted.expires_at, passive.expires_at + 80_000);
    f.clock.advance(80_000);
    f.owner.request(true);
    assert_eq!(f.owner.pending_request(), Some(promoted));
    f.clock.advance(40_000);
    assert_eq!(f.owner.pending_request(), None);
    assert_eq!(f.owner.catalog().state, CatalogState::Unavailable);
}

#[test]
fn keeps_nonce_bound_waiting_separate_from_model_evidence_and_retains_the_last_problem_at_expiry() {
    let f = Fixture::new();
    f.owner.request(true);
    assert!(f.observe_models());
    f.owner.request(true);
    let request = f.owner.pending_request().expect("request");
    assert!(
        f.owner
            .observe(&json!({ "nonce": request.nonce, "waiting": "generating" }))
    );
    let catalog = f.owner.catalog();
    assert_eq!(catalog.state, CatalogState::Pending);
    assert_eq!(listed(&catalog.models), models());
    assert!(catalog.waiting.expect("waiting").contains("generating"));
    assert_eq!(f.owner.pending_request(), Some(request.clone()));
    assert!(
        f.owner
            .observe(&json!({ "nonce": request.nonce, "waiting": "inspecting" }))
    );
    f.clock.advance(120_000);
    let expired = f.owner.catalog();
    assert_eq!(expired.state, CatalogState::Ready);
    let error = expired.error.expect("an error");
    assert!(
        error.starts_with("Model discovery timed out.") && error.contains("generating"),
        "{error}"
    );
    assert_eq!(expired.waiting, None);
    f.owner.request(true);
    assert!(
        !f.owner
            .observe(&json!({ "nonce": request.nonce, "waiting": "draft" }))
    );
    assert!(
        !f.owner
            .observe(&json!({ "nonce": f.nonce(), "waiting": "arbitrary-page-text" }))
    );
    assert!(f.observe_models());
    assert_eq!(f.owner.catalog().error, None);
    assert_eq!(f.owner.catalog().waiting, None);
}

#[test]
fn settles_native_picker_close_failure_immediately_while_retaining_observed_choices() {
    let f = Fixture::new();
    f.owner.request(true);
    f.observe_models();
    f.owner.request(true);
    assert!(
        f.owner.observe(
            &json!({ "nonce": f.nonce(), "models": null, "error": "picker_close_failed" })
        )
    );
    assert_eq!(f.owner.pending_request(), None);
    let catalog = f.owner.catalog();
    assert_eq!(catalog.state, CatalogState::Ready);
    assert_eq!(listed(&catalog.models), models());
    assert!(catalog.error.is_some());
}

#[test]
fn restores_successful_choices_after_restart_without_restoring_browser_opening_authority() {
    let f = Fixture::new();
    f.owner.request(true);
    f.observe_models();
    f.owner.flush();
    let saved: Value = serde_json::from_slice(
        &std::fs::read(f.root.join("chat-models.json")).expect("the catalog is kept"),
    )
    .expect("json");
    assert_eq!(saved, json!({ "observedAt": START, "models": models() }));

    let restarted = Fixture::in_state(f.root.clone());
    restarted.owner.restore();
    let catalog = restarted.owner.catalog();
    assert_eq!(catalog.state, CatalogState::Ready);
    assert_eq!(listed(&catalog.models), models());
    assert_eq!(restarted.owner.pending_request(), None);
}

#[test]
fn keeps_usable_choices_through_refresh_and_a_failed_refresh() {
    let f = Fixture::new();
    f.owner.request(true);
    f.observe_models();
    f.owner.request(true);
    let refreshing = f.owner.catalog();
    assert_eq!(refreshing.state, CatalogState::Pending);
    assert_eq!(listed(&refreshing.models), models());
    f.owner
        .observe(&json!({ "nonce": f.nonce(), "models": null }));
    let failed = f.owner.catalog();
    assert_eq!(failed.state, CatalogState::Ready);
    assert_eq!(listed(&failed.models), models());
    assert!(failed.error.is_some());
}

#[test]
fn explains_a_missing_native_picker_without_claiming_sign_in_failure_or_inventing_models() {
    let f = Fixture::new();
    f.owner.request(true);
    f.owner
        .observe(&json!({ "nonce": f.nonce(), "models": null, "error": "picker_unavailable" }));
    let catalog = f.owner.catalog();
    assert_eq!(catalog.state, CatalogState::Unavailable);
    assert!(catalog.models.is_empty());
    assert!(
        catalog
            .error
            .expect("error")
            .contains("native model picker")
    );
}

#[test]
fn reuses_a_pending_request_accepts_only_its_nonce_and_detaches_all_public_views() {
    let f = Fixture::new();
    assert_eq!(f.owner.catalog().state, CatalogState::Unknown);
    assert_eq!(f.owner.request(true).state, CatalogState::Pending);
    let request = f.owner.pending_request().expect("request");
    f.owner.request(true);
    assert_eq!(f.owner.pending_request(), Some(request.clone()));
    assert!(
        !f.owner.observe(
            &json!({ "nonce": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "models": models() })
        )
    );
    assert!(
        f.owner
            .observe(&json!({ "nonce": request.nonce, "models": models() }))
    );
    let mut view = f.owner.catalog();
    assert_eq!(view.state, CatalogState::Ready);
    view.models[0].label = "mutated".into();
    assert_eq!(f.owner.catalog().models[0].label, "GPT Example");
    assert!(
        !f.owner
            .observe(&json!({ "nonce": request.nonce, "models": models() }))
    );
}

#[test]
fn expires_requests_but_retains_observed_choices_for_this_startup_until_explicit_refresh() {
    let f = Fixture::new();
    f.owner.request(true);
    let stale = f.owner.pending_request().expect("request");
    f.clock.advance(120_000);
    assert!(
        !f.owner
            .observe(&json!({ "nonce": stale.nonce, "models": models() }))
    );
    assert_eq!(f.owner.catalog().state, CatalogState::Unavailable);
    f.owner.request(true);
    f.observe_models();
    f.clock.advance(300_000);
    assert_eq!(f.owner.catalog().state, CatalogState::Ready);
    let refreshed = f.owner.request(true);
    assert_eq!(refreshed.state, CatalogState::Pending);
    assert_eq!(listed(&refreshed.models), models());
}

#[test]
fn bounds_observations_excludes_arbitrary_metadata_and_refuses_duplicate_or_invented_efforts() {
    let f = Fixture::new();
    f.owner.request(true);
    let nonce = f.nonce();
    let model = models()[0].clone();
    let with = |key: &str, value: Value| {
        let mut changed = model.clone();
        changed[key] = value;
        changed
    };
    for invalid in [
        json!({ "nonce": nonce, "models": models(), "accountId": "private" }),
        json!({ "nonce": nonce, "models": vec![model.clone(); 21] }),
        json!({ "nonce": nonce, "models": [model, model] }),
        json!({ "nonce": nonce, "models": [with("efforts", json!(["invented"]))] }),
        json!({ "nonce": nonce, "models": [with("efforts", json!(["high", "high"]))] }),
        json!({ "nonce": nonce, "models": [with("label", json!("x".repeat(81)))] }),
    ] {
        assert!(!f.owner.observe(&invalid), "{invalid}");
    }
    assert!(f.owner.observe(&json!({ "nonce": nonce, "models": null })));
    let catalog = f.owner.catalog();
    assert_eq!(catalog.state, CatalogState::Unavailable);
    assert!(catalog.models.is_empty());
}

#[test]
fn publishes_exactly_all_canonical_observed_efforts() {
    let f = Fixture::new();
    f.owner.request(true);
    let observed = json!([{ "id": "actual-sol", "label": "GPT-5.6 Sol",
        "efforts": ["pro", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] }]);
    assert!(
        f.owner
            .observe(&json!({ "nonce": f.nonce(), "models": observed }))
    );
    assert_eq!(listed(&f.owner.catalog().models), observed);
}

#[test]
fn a_label_is_kept_trimmed() {
    let f = Fixture::new();
    f.owner.request(true);
    let padded = json!([{ "id": "gpt-6", "label": "  GPT-6  ", "efforts": ["high"] }]);
    assert!(
        f.owner
            .observe(&json!({ "nonce": f.nonce(), "models": padded }))
    );
    assert_eq!(f.owner.catalog().models[0].label, "GPT-6");
}

#[test]
fn asks_the_open_page_once_for_an_unoffered_choice_and_not_again_after_a_fresh_catalog() {
    let f = Fixture::new();
    f.owner.request(true);
    f.observe_models();
    assert_eq!(f.owner.pending_request(), None);
    f.owner.refresh_for_unoffered("goal helper 6");
    let request = f.owner.pending_request().expect("asked");
    assert!(!request.allow_open);
    f.owner.refresh_for_unoffered("goal helper 6");
    assert_eq!(f.owner.pending_request(), Some(request.clone()));
    f.clock.advance(1);
    f.owner
        .observe(&json!({ "nonce": request.nonce, "models": models() }));
    f.owner.refresh_for_unoffered("goal helper 6");
    assert_eq!(f.owner.pending_request(), None);
    f.owner.refresh_for_unoffered("default worker 6");
    assert!(!f.owner.pending_request().expect("asked again").allow_open);
}

#[test]
fn does_nothing_for_an_unoffered_choice_before_any_catalog_was_observed() {
    let f = Fixture::new();
    f.owner.refresh_for_unoffered("goal helper 6");
    assert_eq!(f.owner.pending_request(), None);
}

#[test]
fn every_new_or_promoted_request_and_every_accepted_answer_wakes_the_browser() {
    let f = Fixture::new();
    f.owner.request(false);
    assert_eq!(f.wakes.count(), 1);
    f.owner.request(false);
    assert_eq!(f.wakes.count(), 1, "a reused request is not news");
    f.owner.request(true);
    assert_eq!(f.wakes.count(), 2);
    f.observe_models();
    assert_eq!(f.wakes.count(), 3);
}

#[tokio::test(start_paused = true)]
async fn the_deadline_ends_a_request_and_tells_the_ui_without_anyone_polling() {
    let f = Fixture::new();
    let mut seen = f.owner.watch();
    f.owner.request(true);
    seen.borrow_and_update();
    // The wall clock reads the deadline when the paused runtime reaches it.
    f.clock.advance(120_000);
    tokio::time::timeout(std::time::Duration::from_secs(121), seen.changed())
        .await
        .expect("published at the deadline")
        .expect("open");
    let catalog = seen.borrow().clone();
    assert_eq!(catalog.state, CatalogState::Unavailable);
    assert!(
        catalog
            .error
            .as_deref()
            .is_some_and(|error| error.contains("timed out"))
    );
}

fn option(id: &str, label: &str, efforts: &[&str], aliases: Option<&[&str]>) -> ChatModelOption {
    serde_json::from_value(json!({
        "id": id, "label": label, "efforts": efforts,
        "aliases": aliases,
    }))
    .or_else(|_| serde_json::from_value(json!({ "id": id, "label": label, "efforts": efforts })))
    .expect("a model")
}

#[test]
fn a_saved_value_resolves_by_id_alias_or_a_unique_label() {
    let models = vec![
        option("gpt-6", "GPT-6", &["high"], Some(&["gpt-6-thinking"])),
        option("gpt-5-6", "GPT-5.6 Sol", &["high"], None),
    ];
    assert_eq!(
        resolve_chat_model(&models, "gpt-6").map(|m| m.id.as_str()),
        Some("gpt-6")
    );
    assert_eq!(
        resolve_chat_model(&models, "gpt-6-thinking").map(|m| m.id.as_str()),
        Some("gpt-6")
    );
    // Labels became full names in 2.1.31: "6" still means the GPT-6 family.
    assert_eq!(
        resolve_chat_model(&models, "6").map(|m| m.id.as_str()),
        Some("gpt-6")
    );
    assert_eq!(
        resolve_chat_model(&models, "5.6 Sol").map(|m| m.id.as_str()),
        Some("gpt-5-6")
    );
    // NFKC first: full-width letters and digits, and the ligature, read as the label ChatGPT shows.
    assert_eq!(
        resolve_chat_model(&models, "ＧＰＴ－５.６ Ｓｏｌ").map(|m| m.id.as_str()),
        Some("gpt-5-6")
    );
    assert_eq!(
        resolve_chat_model(&models, "５.６ \u{FB06}ol").map(|m| m.id.as_str()),
        None,
        "the st ligature becomes st, which is not Sol"
    );
    let twins = vec![
        option("a", "GPT-6", &["high"], None),
        option("b", "GPT-6", &["high"], None),
    ];
    assert_eq!(
        resolve_chat_model(&twins, "6"),
        None,
        "an ambiguous label is no choice"
    );
}

#[test]
fn the_goal_helper_falls_back_to_chatgpts_selection_when_the_account_does_not_offer_it() {
    let config = first_launch_config(Platform::current());
    let f = Fixture::new();
    // Before any catalog the saved default stands.
    let unknown = helper_selection(&config, &f.owner.catalog());
    assert_eq!(unknown.model.as_deref(), Some("gpt-6"));
    f.owner.request(true);
    f.observe_models();
    let missing = helper_selection(&config, &f.owner.catalog());
    assert_eq!(missing.model, None);
    assert_eq!(
        missing.unoffered.as_deref(),
        Some("goal helper model \"gpt-6\"")
    );
}
