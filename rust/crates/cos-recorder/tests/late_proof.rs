//! A call filed as Unattributed moves to its chat once a page proves its request id
//! (`repairDeterministicAttribution`, cases of `test/attribution-repair.test.ts`), and a plan held
//! under a request id becomes the chat's plan (`attachRequestPlan`, `test/agent-plan.test.ts`).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use cos_recorder::Recorder;
use cos_sessions::{EventPosition, EventQuery, SessionStore};
use cos_store::config::first_launch_config;
use cos_store::{AppPaths, DurableStore, Logger, Platform};
use cos_tools::{
    CallNotes, CallRecord, Caller, EpochMs, RequestId, SurfaceId, ToolOutcome, ToolResult,
};
use cos_types::config::Config;
use cos_types::ids::SessionId;
use serde_json::{Value, json};
use tokio::sync::watch;

const CHAT: &str = "c1c1c1c1-0000-4000-8000-000000000001";
const OTHER: &str = "c2c2c2c2-0000-4000-8000-000000000002";
const NOW: EpochMs = EpochMs(1_767_225_610_000);
const UNATTRIBUTED: &str = "Unattributed activity";

fn profile(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cos-recorder-late-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("profile");
    dir
}

/// A store and recorder over `profile`, restored as the Core restores them, and the settings
/// they follow.
async fn open_with_config(profile: &Path) -> (SessionStore, Recorder, watch::Sender<Arc<Config>>) {
    let paths = AppPaths::at(profile);
    let sessions = SessionStore::open(&paths, Logger::new());
    let (config, settings) = watch::channel(Arc::new(first_launch_config(Platform::current())));
    let recorder = Recorder::new(
        sessions.clone(),
        &DurableStore::new(paths.state(), Logger::new()),
        settings,
        Logger::new(),
    );
    sessions.restore().await;
    recorder.restore().await;
    recorder.settle().await;
    (sessions, recorder, config)
}

async fn open(profile: &Path) -> (SessionStore, Recorder) {
    let (sessions, recorder, _) = open_with_config(profile).await;
    (sessions, recorder)
}

/// Shutdown phases 3 and 4.
async fn close(sessions: &SessionStore, recorder: &Recorder) {
    sessions.flush_recorder().await;
    recorder.settle().await;
    sessions.flush().await;
    recorder.flush();
}

/// One finished `read` call, resolved through the attribution port as the kernel does.
async fn call(sessions: &SessionStore, recorder: &Recorder, request: Option<&str>, text: &str) {
    let request = request.map(|id| RequestId::from_header(id).expect("request id"));
    let caller: Caller =
        cos_tools::Attribution::resolve(recorder, "read", NOW, request.as_ref()).await;
    let result = ToolResult::text(text);
    sessions
        .recorder()
        .record(CallRecord {
            surface: SurfaceId::Core,
            tool: "read",
            nested: false,
            caller: &caller,
            started_at: NOW,
            finished_at: NOW,
            outcome: ToolOutcome::Ok,
            arguments: &json!({ "paths": ["/project/a.txt"] }),
            result: &result,
            notes: &CallNotes::default(),
        })
        .await;
}

async fn prove(recorder: &Recorder, conversation: &str, request: &str) -> SessionId {
    let reply = recorder
        .correlate(
            &json!({ "conversationId": conversation, "calls": [{ "requestId": request }] }),
            NOW,
        )
        .await
        .expect("correlated");
    SessionId::parse(reply.session_id.expect("chat session")).expect("session id")
}

fn buckets(sessions: &SessionStore) -> Vec<SessionId> {
    sessions
        .index()
        .borrow()
        .sessions
        .iter()
        .filter(|summary| summary.title == UNATTRIBUTED && summary.conversation_id.is_none())
        .map(|summary| summary.id.clone())
        .collect()
}

fn lines(profile: &Path, session: &SessionId) -> Vec<Value> {
    std::fs::read_to_string(
        profile
            .join("sessions")
            .join(session.as_str())
            .join("events.jsonl"),
    )
    .unwrap_or_default()
    .lines()
    .map(|line| serde_json::from_str(line).expect("line"))
    .collect()
}

fn calls(profile: &Path, session: &SessionId) -> Vec<Value> {
    lines(profile, session)
        .into_iter()
        .filter(|line| line["kind"] == "tool_call")
        .map(|line| line["call"].clone())
        .collect()
}

fn request_ids(calls: &[Value]) -> Vec<&str> {
    calls
        .iter()
        .map(|call| call["requestId"].as_str().unwrap_or("none"))
        .collect()
}

#[tokio::test]
async fn a_call_proved_after_it_was_filed_moves_to_its_chat_and_the_stream_sees_it() {
    let dir = profile("moves");
    let (sessions, recorder) = open(&dir).await;
    call(&sessions, &recorder, Some("wfr_late"), "1\thello").await;
    call(&sessions, &recorder, Some("wfr_never"), "2\tstays").await;
    let [bucket] = buckets(&sessions).try_into().expect("one bucket");
    let filed = calls(&dir, &bucket);
    assert_eq!(request_ids(&filed), ["wfr_late", "wfr_never"]);

    let mut appended = sessions.appended();
    let chat = prove(&recorder, CHAT, "wfr_late").await;
    recorder.settle().await;

    let moved = calls(&dir, &chat);
    assert_eq!(request_ids(&moved), ["wfr_late"]);
    assert_eq!(moved[0]["conversationId"], CHAT);
    assert_eq!(moved[0]["attribution"], "request_id");
    assert_eq!(moved[0]["attributionMethod"], "request_id");
    let left = calls(&dir, &bucket);
    assert_eq!(request_ids(&left), ["wfr_never"], "the unproven call stays");
    assert_eq!(
        lines(&dir, &bucket)
            .iter()
            .map(|line| line["seq"].as_u64().unwrap_or(0))
            .collect::<Vec<_>>(),
        [1, 2],
        "the bucket is renumbered after its session_start"
    );
    assert_eq!(
        moved[0]["callId"], filed[0]["callId"],
        "the call keeps its id"
    );

    let mut chat_appends = 0;
    while let Ok(appended) = appended.try_recv() {
        if appended.session == chat {
            chat_appends += 1;
        }
    }
    assert!(
        chat_appends >= 1,
        "a stream on the chat is told of the moved call"
    );
    let page = sessions
        .events(
            &chat,
            EventQuery {
                position: EventPosition::Latest,
                limit: 50,
                kinds: Some(vec!["tool_call".into()]),
            },
        )
        .await
        .expect("events");
    let shown = serde_json::to_value(&page.events).expect("json");
    assert_eq!(shown.as_array().map(Vec::len), Some(1));
    assert_eq!(shown[0]["tool"]["callId"], filed[0]["callId"]);
    assert_eq!(shown[0]["tool"]["attribution"], "request_id");
    let bucket_summary = sessions.summary(&bucket).await.expect("bucket");
    assert_eq!(bucket_summary.tool_calls, 1);
    assert_eq!(bucket_summary.events, 2);
    let chat_summary = sessions.summary(&chat).await.expect("chat");
    assert_eq!(chat_summary.tool_calls, 1);
}

#[tokio::test]
async fn the_writable_bucket_stays_when_every_call_in_it_moved() {
    let dir = profile("writable");
    let (sessions, recorder) = open(&dir).await;
    call(&sessions, &recorder, Some("wfr_known"), "ok").await;
    let [bucket] = buckets(&sessions).try_into().expect("one bucket");
    prove(&recorder, CHAT, "wfr_known").await;
    recorder.settle().await;
    assert!(
        sessions.summary(&bucket).await.is_some(),
        "this process still writes to it"
    );
    assert!(calls(&dir, &bucket).is_empty());

    call(&sessions, &recorder, None, "later").await;
    assert_eq!(
        buckets(&sessions),
        std::slice::from_ref(&bucket),
        "a later unknown call reuses it"
    );
    assert_eq!(calls(&dir, &bucket).len(), 1);
}

#[tokio::test]
async fn an_empty_bucket_from_an_earlier_run_is_deleted_and_a_kept_one_is_written_to_again() {
    let dir = profile("historical");
    let (sessions, recorder) = open(&dir).await;
    call(&sessions, &recorder, Some("wfr_old"), "old").await;
    let [old] = buckets(&sessions).try_into().expect("one bucket");
    close(&sessions, &recorder).await;

    let (sessions, recorder) = open(&dir).await;
    let chat = prove(&recorder, CHAT, "wfr_old").await;
    recorder.settle().await;
    assert!(
        !dir.join("sessions").join(old.as_str()).exists(),
        "the empty old bucket is removed"
    );
    assert!(sessions.summary(&old).await.is_none());
    assert_eq!(request_ids(&calls(&dir, &chat)), ["wfr_old"]);
    assert!(buckets(&sessions).is_empty());

    let dir = profile("historical-kept");
    let (sessions, recorder) = open(&dir).await;
    call(&sessions, &recorder, Some("wfr_proved"), "a").await;
    call(&sessions, &recorder, Some("wfr_unknown"), "b").await;
    let [old] = buckets(&sessions).try_into().expect("one bucket");
    close(&sessions, &recorder).await;
    let (sessions, recorder) = open(&dir).await;
    prove(&recorder, CHAT, "wfr_proved").await;
    recorder.settle().await;
    call(&sessions, &recorder, None, "c").await;
    assert_eq!(
        buckets(&sessions),
        std::slice::from_ref(&old),
        "the kept old bucket becomes this run's"
    );
    assert_eq!(request_ids(&calls(&dir, &old)), ["wfr_unknown", "none"]);
}

#[tokio::test]
async fn startup_moves_calls_whose_owner_the_ledger_already_holds() {
    let dir = profile("startup");
    let (sessions, recorder) = open(&dir).await;
    let chat = prove(&recorder, CHAT, "wfr_other").await;
    call(&sessions, &recorder, Some("wfr_restored"), "x").await;
    let [old] = buckets(&sessions).try_into().expect("one bucket");
    close(&sessions, &recorder).await;
    let file = AppPaths::at(&dir).state().join("request-correlations.json");
    let mut ledger: Value =
        serde_json::from_slice(&std::fs::read(&file).expect("ledger")).expect("json");
    ledger["entries"]
        .as_array_mut()
        .expect("entries")
        .push(json!({
            "requestId": "wfr_restored", "conversationId": CHAT, "sessionId": chat.as_str(),
            "messageId": "m-restored", "tool": "read", "observedAt": 5
        }));
    std::fs::write(&file, serde_json::to_vec(&ledger).expect("encode")).expect("write");

    let (sessions, _recorder) = open(&dir).await;
    assert_eq!(request_ids(&calls(&dir, &chat)), ["wfr_restored"]);
    assert!(sessions.summary(&old).await.is_none());
}

#[tokio::test]
async fn owners_split_one_bucket_and_a_rerun_appends_nothing_twice() {
    let dir = profile("split");
    let (sessions, recorder) = open(&dir).await;
    for request in ["wfr_a1", "wfr_b1", "wfr_a2", "wfr_none"] {
        call(&sessions, &recorder, Some(request), request).await;
    }
    let [bucket] = buckets(&sessions).try_into().expect("one bucket");
    // Both owners in one evidence batch each, then one coalesced pass.
    let a = recorder
        .correlate(
            &json!({ "conversationId": CHAT, "calls": [{ "requestId": "wfr_a1" }, { "requestId": "wfr_a2" }] }),
            NOW,
        )
        .await
        .expect("a");
    let b = prove(&recorder, OTHER, "wfr_b1").await;
    recorder.settle().await;
    let a = SessionId::parse(a.session_id.expect("a")).expect("id");
    assert_eq!(request_ids(&calls(&dir, &a)), ["wfr_a1", "wfr_a2"]);
    assert_eq!(request_ids(&calls(&dir, &b)), ["wfr_b1"]);
    assert_eq!(request_ids(&calls(&dir, &bucket)), ["wfr_none"]);

    // A crash after the copy and before the rewrite leaves the call in both places.
    let mut row = lines(&dir, &a)
        .into_iter()
        .find(|line| line["kind"] == "tool_call")
        .expect("row");
    row["call"]["attribution"] = json!("unattributed");
    row["call"]["conversationId"] = Value::Null;
    row["call"]["attributionMethod"] = json!("unattributed");
    row["seq"] = json!(3);
    let journal = dir
        .join("sessions")
        .join(bucket.as_str())
        .join("events.jsonl");
    let mut text = std::fs::read_to_string(&journal).expect("journal");
    text.push_str(&format!("{row}\n"));
    std::fs::write(&journal, text).expect("write");
    close(&sessions, &recorder).await;
    let (_sessions, _recorder) = open(&dir).await;
    assert_eq!(
        request_ids(&calls(&dir, &a)),
        ["wfr_a1", "wfr_a2"],
        "no duplicate"
    );
    assert_eq!(request_ids(&calls(&dir, &bucket)), ["wfr_none"]);
}

#[tokio::test]
async fn a_superseded_call_and_a_call_whose_asset_is_gone_stay_where_they_are() {
    let dir = profile("kept");
    let (sessions, recorder) = open(&dir).await;
    call(&sessions, &recorder, Some("wfr_retired"), "a").await;
    call(
        &sessions,
        &recorder,
        Some("wfr_large"),
        &"large result ".repeat(1_000),
    )
    .await;
    let [bucket] = buckets(&sessions).try_into().expect("one bucket");
    close(&sessions, &recorder).await;
    let folder = dir.join("sessions").join(bucket.as_str());
    let journal = folder.join("events.jsonl");
    let text = std::fs::read_to_string(&journal).expect("journal");
    let rewritten: String = text
        .lines()
        .map(|line| {
            let mut event: Value = serde_json::from_str(line).expect("line");
            if event["call"]["requestId"] == "wfr_retired" {
                event["call"]["attributionMethod"] = json!("superseded");
                event["call"]["attribution"] = json!("superseded");
            }
            format!("{event}\n")
        })
        .collect();
    std::fs::write(&journal, rewritten).expect("write");
    let asset = calls(&dir, &bucket)[1]["result"]["assetId"]
        .as_str()
        .expect("the large result spilled to an asset")
        .to_owned();
    std::fs::remove_file(folder.join("assets").join(&asset)).expect("remove asset");

    let (sessions, recorder) = open(&dir).await;
    let chat = prove(&recorder, CHAT, "wfr_retired").await;
    prove(&recorder, CHAT, "wfr_large").await;
    recorder.settle().await;
    assert!(calls(&dir, &chat).is_empty(), "nothing moved");
    assert_eq!(
        request_ids(&calls(&dir, &bucket)),
        ["wfr_retired", "wfr_large"]
    );
    assert!(sessions.summary(&bucket).await.is_some());
}

#[tokio::test]
async fn a_moved_call_brings_its_overflow_asset_along() {
    let dir = profile("assets");
    let (sessions, recorder) = open(&dir).await;
    call(
        &sessions,
        &recorder,
        Some("wfr_big"),
        &"large result ".repeat(1_000),
    )
    .await;
    let chat = prove(&recorder, CHAT, "wfr_big").await;
    recorder.settle().await;
    let moved = calls(&dir, &chat);
    let asset = moved[0]["result"]["assetId"].as_str().expect("asset id");
    let copied = std::fs::read(
        dir.join("sessions")
            .join(chat.as_str())
            .join("assets")
            .join(asset),
    )
    .expect("the asset was copied");
    assert_eq!(copied, "large result ".repeat(1_000).into_bytes());
}

#[tokio::test]
async fn with_recording_off_a_queued_repair_moves_nothing() {
    let dir = profile("off");
    let (sessions, recorder, config) = open_with_config(&dir).await;
    call(&sessions, &recorder, Some("wfr_off"), "x").await;
    let [bucket] = buckets(&sessions).try_into().expect("one bucket");
    let chat = prove(&recorder, CHAT, "wfr_off").await;
    let mut off = first_launch_config(Platform::current());
    off.sessions.record = false;
    config.send_replace(Arc::new(off));
    recorder.settle().await;
    assert!(calls(&dir, &chat).is_empty());
    assert_eq!(request_ids(&calls(&dir, &bucket)), ["wfr_off"]);
}

fn hold_plan(profile: &Path, request: &str) {
    let state = AppPaths::at(profile).state();
    std::fs::create_dir_all(&state).expect("state");
    let at = EpochMs::now().0;
    std::fs::write(
        state.join("request-plans.json"),
        serde_json::to_vec(&json!({ "version": 1, "entries": [{
            "requestId": request,
            "update": { "plan": [{ "step": "Ship it", "status": "in_progress" }] },
            "startedAt": at, "storedAt": at
        }] }))
        .expect("encode"),
    )
    .expect("write");
}

fn plan_steps(profile: &Path, session: &SessionId) -> Option<Value> {
    std::fs::read(
        profile
            .join("sessions")
            .join(session.as_str())
            .join("plan.json"),
    )
    .ok()
    .map(|bytes| serde_json::from_slice::<Value>(&bytes).expect("plan")["plan"].clone())
}

#[tokio::test]
async fn a_plan_held_under_a_request_moves_to_the_chat_when_the_page_proves_it() {
    let dir = profile("plan-proof");
    hold_plan(&dir, "wfr_plan");
    let (_sessions, recorder) = open(&dir).await;
    let chat = prove(&recorder, CHAT, "wfr_plan").await;
    assert_eq!(
        plan_steps(&dir, &chat),
        Some(json!([{ "step": "Ship it", "status": "in_progress" }]))
    );
    assert!(
        !AppPaths::at(&dir)
            .state()
            .join("request-plans.json")
            .exists()
    );
}

#[tokio::test]
async fn a_plan_whose_request_was_proved_before_a_restart_attaches_at_restore() {
    let dir = profile("plan-restore");
    let (sessions, recorder) = open(&dir).await;
    let chat = prove(&recorder, CHAT, "wfr_plan_restart").await;
    close(&sessions, &recorder).await;
    hold_plan(&dir, "wfr_plan_restart");
    let _reopened = open(&dir).await;
    assert_eq!(
        plan_steps(&dir, &chat),
        Some(json!([{ "step": "Ship it", "status": "in_progress" }]))
    );
}

#[tokio::test]
async fn a_rule_that_refuses_by_chat_waits_for_the_proof_that_ingress_does_not() {
    let dir = profile("proven");
    let (_sessions, recorder) = open(&dir).await;
    let request = RequestId::from_header("wfr_proven_late/att1").expect("request id");
    let unproven = cos_tools::Attribution::resolve(&recorder, "read", NOW, Some(&request)).await;
    assert!(!unproven.is_attributed(), "ingress does not wait");

    let waiting = {
        let recorder = recorder.clone();
        let request = request.clone();
        tokio::spawn(async move {
            cos_tools::Attribution::resolve_proven(&recorder, "read", NOW, Some(&request)).await
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(40)).await;
    let session = prove(&recorder, CHAT, "wfr_proven_late").await;
    let proven = waiting.await.expect("the wait ends");
    let (conversation, owner) = proven.chat.expect("proven once the page reports it");
    assert_eq!(conversation.as_str(), CHAT);
    assert_eq!(owner, session);
}
