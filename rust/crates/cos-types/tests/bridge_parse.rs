//! The bridge boundary parses that decide something beyond a serde shape, with the cases
//! `test/bridge.test.ts` checks against the TypeScript handlers.

use cos_types::bridge::{
    CompactRequest, CompactStep, CompanionDiagnostics, EventsReport, PageTraceItem, RepairAction,
    RepairReceipt, StatusQuery, StatusReport,
};
use serde_json::{Value, json};

fn diagnostics(body: &Value) -> CompanionDiagnostics {
    match CompanionDiagnostics::sanitise(body) {
        Some(kept) => kept,
        None => panic!("{body} did not sanitise"),
    }
}

#[test]
fn companion_diagnostics_are_bounded_and_keep_nothing_unknown() {
    let trace: Vec<Value> = (0..30)
        .map(|_| json!({ "requestId": "r", "read": true, "text": "must not be forwarded" }))
        .collect();
    let body = json!({
        "capturedAt": 1_767_225_600_000_u64,
        "status": { "connected": true, "paired": true, "appVersion": "v".repeat(200) },
        "preferences": { "overwrite": true, "durations": false },
        "transcript": "must not be forwarded",
        "tab": { "tab": 17, "page": { "text": "must not be forwarded", "requestId": "r".repeat(500), "trace": trace } }
    });
    let kept = diagnostics(&body);
    assert_eq!(kept.status.app_version.as_deref().map(str::len), Some(32));
    let page = kept.tab.as_ref().and_then(|tab| tab.page.as_ref());
    assert_eq!(
        page.and_then(|page| page.request_id.as_deref())
            .map(str::len),
        Some(160)
    );
    assert_eq!(page.map(|page| page.trace.len()), Some(16));
    let written = serde_json::to_string(&kept).unwrap_or_default();
    assert!(!written.contains("must not be forwarded"), "{written}");
    assert!(!CompanionDiagnostics::preferences_stored(&body));
}

#[test]
fn companion_diagnostics_default_what_is_not_well_typed() {
    let kept = diagnostics(&json!({
        "capturedAt": -5,
        "status": { "connected": "yes", "compatible": false, "pending": 5_000_000, "port": "8765" },
        "preferences": { "overwrite": "no" },
        "preferencesStored": true,
        "tab": null
    }));
    assert!(!kept.status.connected);
    assert_eq!(kept.status.compatible, Some(false));
    assert_eq!(kept.status.pending.0, 1_000_000.0);
    assert_eq!(kept.status.port, None);
    assert_eq!(kept.captured_at.0, 0.0);
    // Only an explicit `false` turns overwrite off.
    assert!(kept.preferences.overwrite);
    assert!(!kept.preferences.durations);
    assert!(kept.tab.is_none());
    assert!(CompanionDiagnostics::preferences_stored(
        &json!({ "preferencesStored": true })
    ));
}

#[test]
fn companion_diagnostics_need_status_and_preferences_objects() {
    for body in [
        json!(null),
        json!([]),
        json!({ "status": {} }),
        json!({ "preferences": {} }),
        json!({ "status": [], "preferences": {} }),
    ] {
        assert!(CompanionDiagnostics::sanitise(&body).is_none(), "{body}");
    }
}

fn step(body: Value) -> CompactStep {
    match serde_json::from_value::<CompactRequest>(body.clone()) {
        Ok(request) => request.step(),
        Err(error) => panic!("{body}: {error}"),
    }
}

#[test]
fn compact_reads_its_step_in_the_app_order() {
    let chat = "f0f00003-1111-4111-8111-111111111111";
    assert_eq!(step(json!({ "conversationId": chat })), CompactStep::Open);
    assert_eq!(
        step(json!({ "conversationId": chat, "ticket": true, "automatic": true })),
        CompactStep::Ticket
    );
    assert_eq!(
        step(json!({ "conversationId": chat, "token": "t", "summary": "brief" })),
        CompactStep::Capture
    );
    assert_eq!(
        step(json!({ "conversationId": chat, "ticket": true, "summary": "brief" })),
        CompactStep::Ticket
    );
    assert_eq!(
        step(json!({ "conversationId": chat, "cancel": true, "ticket": true })),
        CompactStep::Cancel
    );
    assert_eq!(
        step(
            json!({ "conversationId": chat, "token": "t", "sourceMessageId": "m", "cancel": true })
        ),
        CompactStep::SourceMessage
    );
    assert_eq!(
        step(
            json!({ "token": "t", "commandId": "c", "client": "tab", "destinationAttempt": true, "sourceAttempt": true })
        ),
        CompactStep::DestinationAttempt
    );
    assert_eq!(
        step(
            json!({ "conversationId": chat, "token": "t", "sourceLost": true, "sourceDispatch": true })
        ),
        CompactStep::SourceLost
    );
    // A flag that is not `true` asks for nothing.
    assert_eq!(
        step(json!({ "conversationId": chat, "cancel": false })),
        CompactStep::Open
    );
}

#[test]
fn a_repair_receipt_is_read_from_the_query_like_the_app() {
    let query = StatusQuery::parse([
        ("repaired", "a"),
        ("repairFailed", "b"),
        ("repairAction", "reloaded"),
    ]);
    assert_eq!(
        query.receipt,
        Some(RepairReceipt::Done {
            token: "a".into(),
            action: Some(RepairAction::Reloaded)
        })
    );

    let long = "x".repeat(100);
    let detail = "d".repeat(100);
    let failed = StatusQuery::parse([
        ("repairFailed", long.as_str()),
        ("repairAction", "exploded"),
        ("why", "no-tab"),
        ("detail", detail.as_str()),
        ("repairHeld", "h"),
    ]);
    assert_eq!(
        failed.receipt,
        Some(RepairReceipt::Failed {
            token: "x".repeat(64),
            action: None,
            why: Some("no-tab".into()),
            detail: Some("d".repeat(80)),
        })
    );
    assert_eq!(failed.held, Some(("h".into(), Some("no-tab".into()))));

    let empty = StatusQuery::parse([("repaired", ""), ("repairHeld", "")]);
    assert_eq!(empty, StatusQuery::default());
}

#[test]
fn a_status_report_refuses_an_id_that_is_not_a_chat() {
    let good = json!({ "openConversations": ["a1a1a1a1-0000-4000-8000-00000000ad01"] });
    assert!(serde_json::from_value::<StatusReport>(good).is_ok());
    let bad =
        json!({ "openConversations": ["a1a1a1a1-0000-4000-8000-00000000ad01", "not a chat"] });
    assert!(serde_json::from_value::<StatusReport>(bad).is_err());
    let stalled = json!({ "openConversations": [], "stalledConversations": ["../x"] });
    assert!(serde_json::from_value::<StatusReport>(stalled).is_err());
}

#[test]
fn an_unreadable_trace_item_does_not_refuse_the_batch() {
    let report = json!({
        "conversationId": "f0f00942-1111-4111-8111-111111111111",
        "events": [{ "kind": "turn_trace", "time": 1, "turnId": "g-1", "trace": [
            { "kind": "say", "text": "First.", "done": true },
            { "kind": "mystery", "text": "x" },
            { "kind": "call", "tool": "read" }
        ] }]
    });
    let parsed: EventsReport = match serde_json::from_value(report) {
        Ok(parsed) => parsed,
        Err(error) => panic!("{error}"),
    };
    let trace = parsed.events[0].trace.as_deref().unwrap_or_default();
    let readable = trace
        .iter()
        .filter(|item| matches!(item, PageTraceItem::Readable(_)))
        .count();
    assert_eq!((trace.len(), readable), (3, 1));
}
