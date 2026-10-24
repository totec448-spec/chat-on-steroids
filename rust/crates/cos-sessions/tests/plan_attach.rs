//! A plan accepted under a request id becomes its chat's plan once the chat is proven
//! (`attachRequestPlan`, the request-plan cases of `test/agent-plan.test.ts`).

use std::path::{Path, PathBuf};

use cos_sessions::{PlanAttach, SessionStore};
use cos_store::{AppPaths, Logger};
use cos_types::ids::SessionId;
use cos_types::json::Extra;
use cos_types::state::RequestCorrelation;
use serde_json::{Value, json};

fn profile(name: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("cos-sessions-attach-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("profile");
    dir
}

async fn store(profile: &Path) -> SessionStore {
    let store = SessionStore::open(&AppPaths::at(profile), Logger::new());
    store.restore().await;
    store
}

const STEP: &str = "Fix the ownership boundary";

/// `state/request-plans.json` holding these `(requestId, startedAt, storedAt)` plans.
fn hold(profile: &Path, plans: &[(&str, u64, u64)]) {
    let state = AppPaths::at(profile).state();
    std::fs::create_dir_all(&state).expect("state");
    let entries: Vec<Value> = plans
        .iter()
        .map(|(request, started, stored)| {
            json!({
                "requestId": request,
                "update": { "plan": [{ "step": STEP, "status": "in_progress" }] },
                "startedAt": started, "storedAt": stored
            })
        })
        .collect();
    std::fs::write(
        state.join("request-plans.json"),
        serde_json::to_vec(&json!({ "version": 1, "entries": entries })).expect("encode"),
    )
    .expect("write");
}

fn owner(request: &str, conversation: &str, session: &SessionId) -> RequestCorrelation {
    RequestCorrelation {
        request_id: request.into(),
        conversation_id: conversation.into(),
        session_id: session.as_str().into(),
        message_id: format!("msg-{request}"),
        tool: "update_plan".into(),
        observed_at: 600,
        extra: Extra::new(),
    }
}

fn plan(profile: &Path, session: &SessionId) -> Option<Value> {
    let file = profile
        .join("sessions")
        .join(session.as_str())
        .join("plan.json");
    std::fs::read(file)
        .ok()
        .map(|bytes| serde_json::from_slice(&bytes).expect("plan json"))
}

fn now() -> u64 {
    cos_tools::EpochMs::now().0
}

#[tokio::test]
async fn a_held_plan_attaches_once_and_an_older_one_is_dropped_as_stale() {
    let dir = profile("once");
    let at = now();
    hold(
        &dir,
        &[("wfr_plan_owner", at, at), ("wfr_plan_stale", at - 100, at)],
    );
    let store = store(&dir).await;
    let session = store
        .create_for_conversation("plan-request-owner", None)
        .await
        .expect("session")
        .id;
    assert_eq!(
        store.held_request_plans().await,
        ["wfr_plan_owner", "wfr_plan_stale"]
    );
    assert_eq!(
        store
            .attach_request_plan(&owner("wfr_plan_owner", "plan-request-owner", &session))
            .await,
        Ok(PlanAttach::Attached)
    );
    assert_eq!(
        plan(&dir, &session),
        Some(json!({ "plan": [{ "step": STEP, "status": "in_progress" }], "updatedAt": at }))
    );
    assert_eq!(
        store
            .attach_request_plan(&owner("wfr_plan_owner", "plan-request-owner", &session))
            .await,
        Ok(PlanAttach::Missing),
        "an attached plan is no longer held"
    );
    assert_eq!(
        store
            .attach_request_plan(&owner("wfr_plan_stale", "plan-request-owner", &session))
            .await,
        Ok(PlanAttach::Stale)
    );
    assert_eq!(plan(&dir, &session).expect("plan")["updatedAt"], json!(at));
    assert!(store.held_request_plans().await.is_empty());
    assert!(
        !AppPaths::at(&dir)
            .state()
            .join("request-plans.json")
            .exists(),
        "an empty ledger is removed"
    );
}

#[tokio::test]
async fn a_plan_accepted_before_its_chat_was_replaced_still_lands_and_a_later_one_does_not() {
    let dir = profile("retired");
    let at = now();
    hold(
        &dir,
        &[
            ("wfr_plan_before_handoff", at - 100, at),
            ("wfr_plan_rogue_source", at + 10_900, at + 11_000),
            ("wfr_plan_unrelated_chat", at - 100, at),
        ],
    );
    let session = {
        let store = store(&dir).await;
        let id = store
            .create_for_conversation("pending-plan-a", None)
            .await
            .expect("session")
            .id;
        store.flush().await;
        id
    };
    // A -> B -> C, A retired at +10 s.
    let meta = dir
        .join("sessions")
        .join(session.as_str())
        .join("meta.json");
    let mut summary: Value =
        serde_json::from_slice(&std::fs::read(&meta).expect("meta")).expect("json");
    summary["conversationId"] = json!("pending-plan-c");
    summary["chatIds"] = json!(["pending-plan-a", "pending-plan-b", "pending-plan-c"]);
    summary["retiredChatAt"] =
        json!({ "pending-plan-a": at + 10_000, "pending-plan-b": at + 20_000 });
    std::fs::write(&meta, serde_json::to_vec(&summary).expect("encode")).expect("write");

    let store = store(&dir).await;
    assert_eq!(
        store
            .attach_request_plan(&owner(
                "wfr_plan_before_handoff",
                "pending-plan-a",
                &session
            ))
            .await,
        Ok(PlanAttach::Attached)
    );
    assert_eq!(
        plan(&dir, &session).expect("plan")["updatedAt"],
        json!(at - 100)
    );
    assert_eq!(
        store
            .attach_request_plan(&owner("wfr_plan_rogue_source", "pending-plan-a", &session))
            .await,
        Ok(PlanAttach::Stale)
    );
    assert_eq!(
        store
            .attach_request_plan(&owner(
                "wfr_plan_unrelated_chat",
                "not-in-lineage",
                &session
            ))
            .await,
        Ok(PlanAttach::Stale)
    );
    assert_eq!(
        plan(&dir, &session).expect("plan")["updatedAt"],
        json!(at - 100)
    );
}

#[tokio::test]
async fn a_failed_attachment_keeps_the_plan_held() {
    let dir = profile("missing-session");
    let at = now();
    hold(&dir, &[("wfr_plan_nowhere", at, at)]);
    let store = store(&dir).await;
    let gone = SessionId::parse("2026-01-01-00000099").expect("id");
    assert!(
        store
            .attach_request_plan(&owner("wfr_plan_nowhere", "plan-gone", &gone))
            .await
            .is_err()
    );
    assert_eq!(store.held_request_plans().await, ["wfr_plan_nowhere"]);
}
