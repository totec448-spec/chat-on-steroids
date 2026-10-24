//! The store through its public interface: what a recorded call leaves on disk, what a
//! restart restores, and what `update_plan` answers and writes.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use cos_fs::Roots;
use cos_sessions::{EventPosition, EventQuery, ListQuery, SessionStore};
use cos_store::{AppPaths, Logger, Platform};
use cos_tools::{
    CallContext, CallNotes, CallRecord, Caller, CapabilitySet, EpochMs, FeatureSet, Grants,
    ProcessNotes, SurfaceId, ToolError, ToolResult,
};
use cos_types::ids::{ConversationId, SessionId};
use cos_types::json::Extra;
use cos_types::session::{FileChange, ToolOutcome};
use serde_json::{Value, json};

fn profile(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cos-sessions-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("profile");
    dir
}

fn store(profile: &Path) -> SessionStore {
    SessionStore::open(&AppPaths::at(profile), Logger::new())
}

fn session_dirs(profile: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(profile.join("sessions"))
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .collect()
        })
        .unwrap_or_default();
    dirs.sort();
    dirs
}

fn journal(dir: &Path) -> Vec<Value> {
    std::fs::read_to_string(dir.join("events.jsonl"))
        .expect("journal")
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_str(line).expect("event line"))
        .collect()
}

fn json_file(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).expect("file")).expect("json")
}

async fn record(
    store: &SessionStore,
    tool: &'static str,
    arguments: Value,
    result: &str,
    outcome: ToolOutcome,
    notes: CallNotes,
) {
    let caller = Caller::unattributed(None);
    let result = ToolResult::text(result);
    store
        .recorder()
        .record(CallRecord {
            surface: SurfaceId::Core,
            tool,
            nested: false,
            caller: &caller,
            started_at: EpochMs(1_792_000_000_000),
            finished_at: EpochMs(1_792_000_000_395),
            outcome,
            arguments: &arguments,
            result: &result,
            notes: &notes,
        })
        .await;
}

fn latest(limit: u32) -> EventQuery {
    EventQuery {
        position: EventPosition::Latest,
        limit,
        kinds: None,
    }
}

#[tokio::test]
async fn a_call_without_browser_proof_is_filed_as_unattributed_activity() {
    let profile = profile("unattributed");
    let store = store(&profile);
    let mut appended = store.appended();
    let notes = CallNotes {
        detail: Some("lines 1\u{2013}2".into()),
        ..CallNotes::default()
    };
    record(
        &store,
        "read",
        json!({ "paths": ["/project/src/greeting.txt"] }),
        "1\thello world\n2\tsecond line",
        ToolOutcome::Ok,
        notes,
    )
    .await;

    let dirs = session_dirs(&profile);
    assert_eq!(dirs.len(), 1, "one Unattributed session");
    let dir = &dirs[0];
    assert_eq!(
        std::fs::read_to_string(dir.join("messages.json")).expect("map"),
        "{}"
    );
    let lines = journal(dir);
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0]["kind"], "session_start");
    assert_eq!(lines[0]["title"], "Unattributed activity");
    assert_eq!(lines[0]["seq"], 1);
    let call = &lines[1]["call"];
    assert_eq!(lines[1]["seq"], 2);
    assert_eq!(lines[1]["time"], 1_792_000_000_000u64);
    assert_eq!(lines[1]["source"], "mcp");
    assert_eq!(call["tool"], "read");
    assert_eq!(call["attribution"], "unattributed");
    assert_eq!(call["attributionMethod"], "unattributed");
    assert_eq!(call["requestId"], Value::Null);
    assert_eq!(call["durationMs"], 395);
    assert_eq!(
        call["args"],
        json!({ "text": "{\"paths\":[\"/project/src/greeting.txt\"]}", "truncated": false, "chars": 39 })
    );
    assert_eq!(
        call["summary"],
        json!({ "title": "Read src/greeting.txt", "detail": "lines 1\u{2013}2", "metric": "2 lines", "tone": "neutral", "kind": "read" })
    );
    assert_eq!(appended.recv().await.expect("start").seq, 1);
    assert_eq!(appended.recv().await.expect("call").seq, 2);

    // The summary reaches meta.json on the debounce or on flush, whichever comes first.
    store.flush().await;
    let meta = json_file(&dir.join("meta.json"));
    assert_eq!(meta["events"], 2);
    assert_eq!(meta["toolCalls"], 1);
    assert_eq!(meta["__historySeq"], 2);
    assert_eq!(meta["__canonicalProjection"], 1);
    assert_eq!(meta["__tokenEstimate"], 1);
    assert!(
        dir.join("meta.backup.json").exists(),
        "the first checkpoint is kept as backup"
    );

    let list = store
        .list(ListQuery {
            limit: 20,
            cursor: None,
            live: false,
        })
        .await;
    let id = dir
        .file_name()
        .expect("name")
        .to_string_lossy()
        .into_owned();
    assert_eq!(list.active_id.as_deref(), Some(id.as_str()));
    assert_eq!(list.sessions[0].session.tool_calls, 1);
    let page = store
        .events(&SessionId::parse(&id).expect("id"), latest(50))
        .await
        .expect("page");
    assert_eq!(page.events.len(), 2);
    assert_eq!(page.next_from, 3);
    let _ = std::fs::remove_dir_all(&profile);
}

#[tokio::test]
async fn a_code_mode_child_call_is_filed_as_nested_and_adds_no_context_tokens() {
    let profile = profile("nested");
    let store = store(&profile);
    let text = "a line the model read\n".repeat(200);
    record(
        &store,
        "read",
        json!({ "paths": ["/project/a.md"] }),
        &text,
        ToolOutcome::Ok,
        CallNotes::default(),
    )
    .await;
    let tokens = |list: cos_types::control_api::ControlApiSessionList| {
        list.sessions[0].session.context_tokens
    };
    let query = || ListQuery {
        limit: 20,
        cursor: None,
        live: false,
    };
    let before = tokens(store.list(query()).await);
    assert!(before > 400, "the direct call counts: {before}");

    let caller = Caller::unattributed(None);
    let arguments = json!({ "paths": ["/project/a.md"] });
    let result = ToolResult::text(&text);
    store
        .recorder()
        .record(CallRecord {
            surface: SurfaceId::Core,
            tool: "read",
            nested: true,
            caller: &caller,
            started_at: EpochMs(1_792_000_000_500),
            finished_at: EpochMs(1_792_000_000_506),
            outcome: ToolOutcome::Ok,
            arguments: &arguments,
            result: &result,
            notes: &CallNotes::default(),
        })
        .await;

    assert_eq!(tokens(store.list(query()).await), before);
    let lines = journal(&session_dirs(&profile)[0]);
    assert_eq!(lines[1]["call"].get("nested"), None);
    assert_eq!(lines[2]["call"]["nested"], true);
    let _ = std::fs::remove_dir_all(&profile);
}

/// The summary the TypeScript app wrote for the recorded call at `seq` of the `base` stream.
fn corpus_summary(seq: u64) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../golden/base/api/sse/stream.json");
    let corpus = json_file(&path);
    corpus["response"]["frames"]
        .as_array()
        .expect("frames")
        .iter()
        .find(|frame| frame["data"]["seq"] == seq)
        .expect("frame")["data"]["tool"]["summary"]
        .clone()
}

#[tokio::test]
async fn process_notes_give_the_corpus_summaries_of_failed_and_waited_calls() {
    let profile = profile("process-notes");
    let store = store(&profile);
    let exited = |code| CallNotes {
        process: Some(ProcessNotes {
            exit_code: Some(code),
            running: Some(false),
            ..ProcessNotes::default()
        }),
        ..CallNotes::default()
    };
    record(
        &store,
        "exec_command",
        json!({ "cmd": "exit 3", "workdir": "/project" }),
        "Process exited with code 3",
        ToolOutcome::ProcessExitNonzero,
        exited(3),
    )
    .await;
    record(
        &store,
        "write_stdin",
        json!({ "session_id": "<EXEC_SESSION:13>", "chars": "" }),
        "Process exited with code 0",
        ToolOutcome::Ok,
        exited(0),
    )
    .await;
    let lines = journal(&session_dirs(&profile)[0]);
    assert_eq!(lines[1]["call"]["summary"], corpus_summary(44));
    assert_eq!(lines[2]["call"]["summary"], corpus_summary(60));
    let _ = std::fs::remove_dir_all(&profile);
}

#[tokio::test]
async fn text_past_the_inline_cap_is_kept_whole_in_an_asset() {
    let profile = profile("overflow");
    let store = store(&profile);
    let output: String = (0..900).map(|line| format!("line {line:04}\n")).collect();
    record(
        &store,
        "exec_command",
        json!({ "cmd": "x" }),
        &output,
        ToolOutcome::Ok,
        CallNotes::default(),
    )
    .await;
    let dir = &session_dirs(&profile)[0];
    let result = &journal(dir)[1]["call"]["result"];
    let units = output.encode_utf16().count();
    assert_eq!(result["chars"], units);
    assert_eq!(result["truncated"], true);
    let asset = result["assetId"].as_str().expect("spilled");
    assert!(asset.ends_with(".txt") && asset.len() == 36, "{asset}");
    assert_eq!(
        std::fs::read_to_string(dir.join("assets").join(asset)).expect("asset"),
        output
    );
    let inline = result["text"].as_str().expect("text");
    assert!(inline.starts_with(&output[..8000]));
    assert!(inline.ends_with(&format!(
        "\n\u{2026}[{} more characters stored in full as {asset}]",
        units - 8000
    )));
    let _ = std::fs::remove_dir_all(&profile);
}

#[tokio::test]
async fn an_event_over_the_line_cap_is_refused_without_spending_a_sequence_number() {
    let profile = profile("line-cap");
    let store = store(&profile);
    let changes = (0..3000)
        .map(|index| FileChange {
            path: format!("/project/{index}/{}", "p".repeat(200)),
            added: 1,
            removed: 0,
            approximate: false,
            review_asset_id: None,
            review_unavailable: None,
            extra: Extra::new(),
        })
        .collect();
    let huge = CallNotes {
        changes,
        ..CallNotes::default()
    };
    record(
        &store,
        "apply_patch",
        json!({ "patch": "" }),
        "ok",
        ToolOutcome::Ok,
        huge,
    )
    .await;
    record(
        &store,
        "read",
        json!({ "paths": ["/project/a"] }),
        "ok",
        ToolOutcome::Ok,
        CallNotes::default(),
    )
    .await;
    let lines = journal(&session_dirs(&profile)[0]);
    let seqs: Vec<&Value> = lines.iter().map(|line| &line["seq"]).collect();
    assert_eq!(seqs, [&json!(1), &json!(2)]);
    assert_eq!(lines[1]["call"]["tool"], "read");
    let _ = std::fs::remove_dir_all(&profile);
}

#[tokio::test]
async fn a_restart_restores_every_session_and_opens_its_own_unattributed_stream() {
    let profile = profile("restart");
    let first = store(&profile);
    record(
        &first,
        "read",
        json!({ "paths": ["/project/a"] }),
        "a",
        ToolOutcome::Ok,
        CallNotes::default(),
    )
    .await;
    first.flush().await;

    let second = store(&profile);
    let report = second.restore().await;
    assert_eq!((report.sessions, report.skipped.len()), (1, 0));
    assert_eq!(second.index().borrow().sessions.len(), 1);
    let list = second
        .list(ListQuery {
            limit: 20,
            cursor: None,
            live: false,
        })
        .await;
    assert_eq!((list.total, list.active_id.clone()), (1, None));
    record(
        &second,
        "exec_command",
        json!({ "cmd": "exit 3" }),
        "exit 3",
        ToolOutcome::ProcessExitNonzero,
        CallNotes::default(),
    )
    .await;
    let list = second
        .list(ListQuery {
            limit: 20,
            cursor: None,
            live: false,
        })
        .await;
    assert_eq!(
        list.total, 2,
        "each process files into its own Unattributed session"
    );
    assert_eq!(list.sessions[0].session.process_exit_nonzero, 1);
    let page = second
        .list(ListQuery {
            limit: 1,
            cursor: None,
            live: false,
        })
        .await;
    assert!(page.next_cursor.is_some());
    let _ = std::fs::remove_dir_all(&profile);
}

#[tokio::test]
async fn a_torn_final_line_costs_that_line_and_not_the_session() {
    let profile = profile("torn");
    let first = store(&profile);
    record(
        &first,
        "read",
        json!({ "paths": ["/project/a"] }),
        "a",
        ToolOutcome::Ok,
        CallNotes::default(),
    )
    .await;
    record(
        &first,
        "read",
        json!({ "paths": ["/project/b"] }),
        "b",
        ToolOutcome::Ok,
        CallNotes::default(),
    )
    .await;
    first.flush().await;
    let dir = session_dirs(&profile)[0].clone();
    let id = SessionId::parse(dir.file_name().expect("name").to_string_lossy()).expect("id");
    // A crash mid-append: half a line, and the summary never saw it.
    let mut text = std::fs::read_to_string(dir.join("events.jsonl")).expect("journal");
    text.push_str("{\"time\":1,\"source\":\"mcp\",\"kind\":\"tool_ca");
    std::fs::write(dir.join("events.jsonl"), text).expect("torn");

    let second = store(&profile);
    second.restore().await;
    let detail = second.detail(&id).await.expect("restored");
    assert_eq!(detail.session.events, 3);
    let page = second.events(&id, latest(50)).await.expect("page");
    assert_eq!(
        page.events
            .iter()
            .map(|event| event.seq)
            .collect::<Vec<_>>(),
        [1, 2, 3]
    );
    let _ = std::fs::remove_dir_all(&profile);
}

fn grants(allow_unattributed: bool) -> Arc<Grants> {
    Arc::new(Grants {
        capabilities: CapabilitySet::EMPTY,
        read_only: false,
        features: FeatureSet::default(),
        allow_unattributed,
        roots: Roots::from_config(&[], Path::new("skills")),
        platform: Platform::Windows,
    })
}

fn corpus_call(name: &str) -> (Value, String) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../golden/base/mcp/core/calls")
        .join(name);
    let case: Value = serde_json::from_slice(&std::fs::read(path).expect("corpus")).expect("json");
    let text = case["response"]["messages"][0]["result"]["content"][0]["text"]
        .as_str()
        .expect("text")
        .to_owned();
    (case["request"]["arguments"].clone(), text)
}

fn refusal(result: Result<cos_tools::ToolOutput, ToolError>) -> ToolError {
    result.expect_err("refused")
}

#[tokio::test]
async fn update_plan_refuses_a_caller_without_identity_as_the_corpus_records() {
    let profile = profile("plan-identity");
    let store = store(&profile);
    let tool = store.plan_tool();
    for case in ["79-plan-set.json", "83-plan-clear.json"] {
        let (arguments, text) = corpus_call(case);
        let cx =
            CallContext::standalone(SurfaceId::Core, grants(false), Caller::unattributed(None));
        let refused = refusal(tool.call_json(&cx, arguments).await);
        assert_eq!(refused, ToolError::Identity(text), "{case}");
    }
    // Allowed unattributed calls still need a request id to own the plan.
    let (arguments, _) = corpus_call("79-plan-set.json");
    let cx = CallContext::standalone(SurfaceId::Core, grants(true), Caller::unattributed(None));
    assert!(matches!(
        refusal(tool.call_json(&cx, arguments).await),
        ToolError::Identity(_)
    ));
    assert!(!profile.join("state").join("request-plans.json").exists());
    assert!(
        !profile.join("sessions").exists(),
        "a refused plan writes nothing"
    );
    let _ = std::fs::remove_dir_all(&profile);
}

/// A session a browser-attributed chat owns, as the TypeScript store left it.
fn attributed_session(profile: &Path, id: &str, conversation: &str) {
    let dir = profile.join("sessions").join(id);
    std::fs::create_dir_all(&dir).expect("dir");
    let meta = json!({
        "id": id, "title": "ChatGPT session", "conversationId": conversation, "chatIds": [conversation],
        "startedAt": 1_792_000_000_000u64, "updatedAt": 1_792_000_000_000u64, "endedAt": null, "events": 1,
        "timelineTurns": {}, "nativeQuestion": null, "requestTurns": {}, "userMessages": 0, "toolCalls": 0,
        "lastToolCallAt": null, "lastToolActivity": null, "lastAssistantFinalAt": null, "lastTurnEndAt": null,
        "lastFinishReportAt": null, "processExitNonzero": 0, "toolRejected": 0, "toolInternalErrors": 0,
        "errors": 0, "estimatedTokens": 0, "contextTokens": 0, "lastHandoffId": null, "lastHandoffAt": null,
        "lastCommittedResumeHandoffId": null, "lastTurnOutcome": null, "activeTurnId": null, "finishTurn": null,
        "agents": [], "origin": null, "__historySeq": 1, "__canonicalProjection": 1, "__tokenEstimate": 1
    });
    std::fs::write(
        dir.join("meta.json"),
        serde_json::to_string_pretty(&meta).expect("meta"),
    )
    .expect("meta");
    let start = json!({ "time": 1_792_000_000_000u64, "source": "app", "kind": "session_start",
        "conversationId": conversation, "title": "ChatGPT session", "seq": 1 });
    std::fs::write(dir.join("events.jsonl"), format!("{start}\n")).expect("journal");
}

#[tokio::test]
async fn update_plan_replaces_the_proven_chat_plan_and_keeps_a_newer_one() {
    let profile = profile("plan-chat");
    let id = "2026-10-20-0a1b2c3d";
    let conversation = "68f1c2d4-1111-4bbb-8ccc-0123456789ab";
    attributed_session(&profile, id, conversation);
    let store = store(&profile);
    store.restore().await;
    let tool = store.plan_tool();
    let caller = Caller {
        request_id: None,
        chat: Some((
            ConversationId::parse(conversation).expect("chat"),
            SessionId::parse(id).expect("id"),
        )),
    };
    let (arguments, _) = corpus_call("79-plan-set.json");
    let cx = CallContext::standalone(SurfaceId::Core, grants(false), caller.clone());
    let accepted = tool.call_json(&cx, arguments).await.expect("accepted");
    assert_eq!(accepted.result, ToolResult::text("Plan updated"));
    let plan = json_file(&profile.join("sessions").join(id).join("plan.json"));
    assert_eq!(plan["explanation"], "golden");
    assert_eq!(
        plan["plan"][0],
        json!({ "step": "First", "status": "completed", "details": "done" })
    );
    assert_eq!(plan["updatedAt"], cx.started_at.0);

    let mut older = CallContext::standalone(SurfaceId::Core, grants(false), caller.clone());
    older.started_at = EpochMs(cx.started_at.0 - 1);
    let stale = refusal(tool.call_json(&older, json!({ "plan": [] })).await);
    assert_eq!(
        stale,
        ToolError::Refused(
            "This plan update is stale or its chat was replaced. The current plan was preserved."
                .into()
        )
    );
    let other = Caller {
        request_id: None,
        chat: Some((
            ConversationId::parse("68f1c2d4-2222-4bbb-8ccc-0123456789ab").expect("chat"),
            SessionId::parse(id).expect("id"),
        )),
    };
    let cx = CallContext::standalone(SurfaceId::Core, grants(false), other);
    assert!(matches!(
        refusal(tool.call_json(&cx, json!({ "plan": [] })).await),
        ToolError::Refused(_)
    ));
    assert_eq!(
        json_file(&profile.join("sessions").join(id).join("plan.json"))["explanation"],
        "golden"
    );
    let _ = std::fs::remove_dir_all(&profile);
}

#[tokio::test]
async fn an_attributed_call_continues_the_chat_journal_after_a_torn_line() {
    let profile = profile("attributed");
    let id = "2026-10-20-0a1b2c3d";
    let conversation = "68f1c2d4-1111-4bbb-8ccc-0123456789ab";
    attributed_session(&profile, id, conversation);
    let dir = profile.join("sessions").join(id);
    let mut text = std::fs::read_to_string(dir.join("events.jsonl")).expect("journal");
    text.push_str("{\"torn\":");
    std::fs::write(dir.join("events.jsonl"), text).expect("torn");
    let store = store(&profile);
    store.restore().await;
    let caller = Caller {
        request_id: None,
        chat: Some((
            ConversationId::parse(conversation).expect("chat"),
            SessionId::parse(id).expect("id"),
        )),
    };
    let arguments = json!({ "paths": ["/project/a"] });
    let result = ToolResult::text("a");
    store
        .recorder()
        .record(CallRecord {
            surface: SurfaceId::Core,
            tool: "read",
            nested: false,
            caller: &caller,
            started_at: EpochMs(1_792_000_001_000),
            finished_at: EpochMs(1_792_000_001_010),
            outcome: ToolOutcome::Ok,
            arguments: &arguments,
            result: &result,
            notes: &CallNotes::default(),
        })
        .await;
    let raw = std::fs::read_to_string(dir.join("events.jsonl")).expect("journal");
    let lines: Vec<&str> = raw.lines().collect();
    assert_eq!(lines.len(), 3, "start, the sealed torn line, the call");
    assert_eq!(lines[1], "{\"torn\":");
    let call: Value = serde_json::from_str(lines[2]).expect("call line");
    assert_eq!(call["seq"], 2);
    assert_eq!(call["call"]["attribution"], "request_id");
    assert_eq!(call["call"]["conversationId"], conversation);
    assert_eq!(
        session_dirs(&profile).len(),
        1,
        "no Unattributed session for a proven chat"
    );
    store.flush_recorder().await;
    let _ = std::fs::remove_dir_all(&profile);
}
