//! The `/v1` session read shapes against the TypeScript corpus (`rust/golden/base/api`).
//!
//! The corpus session is the `base` variant's Unattributed activity: one `session_start` and 75
//! recorded calls. Its journal is rebuilt from the recorded event stream with no `meta.json`,
//! so restore has to recover the summary from history, and every read is then compared with
//! the recorded reply after the corpus placeholders are applied to this build's output.

use std::path::{Path, PathBuf};

use cos_sessions::{Cursor, EventPosition, EventQuery, EventsError, ListQuery, SessionStore};
use cos_store::{AppPaths, Logger};
use cos_types::ids::SessionId;
use serde_json::{Value, json};

const SESSION: &str = "2026-10-20-0a1b2c3d";
const SESSION_PLACEHOLDER: &str = "<SESSION:<EXEC_SESSION:17>>";

fn corpus(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../golden/base/api")
        .join(name);
    serde_json::from_slice(&std::fs::read(&path).expect("corpus file")).expect("corpus json")
}

fn temp_profile(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cos-sessions-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("profile");
    dir
}

fn stored(text: &Value) -> Value {
    let body = text["text"].as_str().expect("text");
    json!({
        "text": body,
        "truncated": text["truncated"],
        "chars": body.encode_utf16().count(),
    })
}

/// One journal line from one recorded control API row.
fn journal_line(row: &Value) -> Value {
    let seq = row["seq"].as_u64().expect("seq");
    let time = 1_792_000_000_000u64 + seq * 1000;
    match row["kind"].as_str() {
        Some("session_start") => json!({
            "time": time, "source": "app", "kind": "session_start",
            "conversationId": row["conversationId"], "title": row["title"], "seq": seq
        }),
        Some("tool_call") => {
            let tool = &row["tool"];
            let changes: Vec<Value> = tool["changes"]
                .as_array()
                .expect("changes")
                .iter()
                .map(|change| {
                    json!({
                        "path": change["path"], "added": change["added"],
                        "removed": change["removed"], "approximate": false
                    })
                })
                .collect();
            let mut call = json!({
                "callId": format!("00000000-0000-4000-8000-{seq:012}"),
                "tool": tool["name"],
                "attribution": tool["attribution"],
                "requestId": null,
                "conversationId": null,
                "attributionMethod": "unattributed",
                "args": stored(&tool["args"]),
                "result": stored(&tool["result"]),
                "outcome": tool["outcome"],
                "durationMs": 7,
                "summary": tool["summary"],
            });
            if !changes.is_empty() {
                call["changes"] = Value::Array(changes);
            }
            json!({ "time": time, "source": "mcp", "kind": "tool_call", "call": call, "seq": seq })
        }
        other => panic!("the corpus session holds no {other:?} rows"),
    }
}

/// A profile whose only session is the corpus journal, with no metadata.
fn corpus_profile(name: &str) -> PathBuf {
    let profile = temp_profile(name);
    let stream = corpus("sse/stream.json");
    let lines: Vec<String> = stream["response"]["frames"]
        .as_array()
        .expect("frames")
        .iter()
        .filter(|frame| frame.get("data").is_some())
        .map(|frame| journal_line(&frame["data"]).to_string() + "\n")
        .collect();
    assert_eq!(lines.len(), 76, "the corpus stream holds the whole session");
    let dir = profile.join("sessions").join(SESSION);
    std::fs::create_dir_all(&dir).expect("session folder");
    std::fs::write(dir.join("events.jsonl"), lines.concat()).expect("journal");
    std::fs::write(dir.join("messages.json"), "{}").expect("legacy map");
    profile
}

fn epoch_like(value: &Value) -> bool {
    value
        .as_u64()
        .is_some_and(|number| (1_000_000_000_000..10_000_000_000_000).contains(&number))
}

/// Applies the corpus placeholders (`scripts/golden/normalize.mjs`) to this build's output.
fn normalize(value: &mut Value, uuids: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, item) in map.iter_mut() {
                let timed = key.ends_with("At") || key.ends_with("Time") || key == "time";
                if timed && epoch_like(item) {
                    *item = Value::from("<EPOCH_MS>");
                } else if key == "durationMs" {
                    *item = Value::from("<DURATION>");
                } else if key == "chars" && item.is_number() {
                    *item = Value::from("<CHARS>");
                } else if key == "estimatedTokens" {
                    *item = Value::from("<ESTIMATEDTOKENS>");
                } else if key == "contextTokens" {
                    *item = Value::from("<CONTEXTTOKENS>");
                } else if key == "callId" {
                    let id = item.as_str().unwrap_or_default().to_owned();
                    let at = uuids
                        .iter()
                        .position(|seen| *seen == id)
                        .unwrap_or_else(|| {
                            uuids.push(id);
                            uuids.len() - 1
                        });
                    *item = Value::from(format!("<UUID:{}>", at + 1));
                } else {
                    normalize(item, uuids);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| normalize(item, uuids)),
        Value::String(text) if text == SESSION => *text = SESSION_PLACEHOLDER.to_owned(),
        _ => {}
    }
}

/// The recorded text of a call whose stored text was cut differs after normalization, because
/// the placeholders change its length before the cut. Those texts are compared by their flags.
fn mask_cut_texts(expected: &mut Value, actual: &mut Value) {
    match (expected, actual) {
        (Value::Object(want), Value::Object(got)) => {
            if want.get("truncated") == Some(&Value::Bool(true))
                && got.get("truncated") == Some(&Value::Bool(true))
                && want.contains_key("text")
            {
                want.insert("text".into(), Value::from("<CUT>"));
                got.insert("text".into(), Value::from("<CUT>"));
            }
            for (key, item) in want.iter_mut() {
                if let Some(other) = got.get_mut(key) {
                    mask_cut_texts(item, other);
                }
            }
        }
        (Value::Array(want), Value::Array(got)) => {
            for (item, other) in want.iter_mut().zip(got.iter_mut()) {
                mask_cut_texts(item, other);
            }
        }
        _ => {}
    }
}

fn assert_same(case: &str, mut expected: Value, actual: impl serde::Serialize) {
    let mut actual = serde_json::to_value(actual).expect("serializes");
    normalize(&mut actual, &mut Vec::new());
    mask_cut_texts(&mut expected, &mut actual);
    assert_eq!(actual, expected, "{case}");
}

fn events(position: EventPosition, limit: u32, kinds: Option<&str>) -> EventQuery {
    EventQuery {
        position,
        limit,
        kinds: kinds.map(|kind| vec![kind.to_owned()]),
    }
}

#[tokio::test]
async fn restore_rebuilds_the_corpus_session_and_reads_it_back_as_recorded() {
    let profile = corpus_profile("golden");
    let store = SessionStore::open(&AppPaths::at(&profile), Logger::new());
    let report = store.restore().await;
    assert_eq!((report.sessions, report.skipped.len()), (1, 0));

    let detail = store
        .detail(&SessionId::parse(SESSION).expect("id"))
        .await
        .expect("restored");
    // The counters come from the journal replay, not from any stored projection.
    let session = corpus("session.json")["response"]["body"]["session"].clone();
    assert_same("session.json", session.clone(), &detail.session);
    let live = corpus("session-live.json")["response"]["body"]["session"].clone();
    assert_same("session-live.json", live, &detail.session);

    let id = SessionId::parse(SESSION).expect("id");
    let cases = [
        (
            "session-events.json",
            events(EventPosition::Latest, 50, None),
        ),
        (
            "session-events-from.json",
            events(EventPosition::From(0), 1, None),
        ),
        (
            "session-events-before-3.json",
            events(EventPosition::Before(3), 50, None),
        ),
        (
            "session-events-after-2.json",
            events(EventPosition::After(2), 2, None),
        ),
        (
            "session-events-limit-2.json",
            events(EventPosition::Latest, 2, None),
        ),
        (
            "session-events-kinds.json",
            events(EventPosition::Latest, 50, Some("tool_call")),
        ),
    ];
    for (case, query) in cases {
        let page = store.events(&id, query).await.expect("page");
        assert_same(case, corpus(case)["response"]["body"].clone(), page);
    }

    for (case, from, kinds) in [
        ("sse/stream.json", 0, None),
        ("sse/stream-from.json", 3, None),
        ("sse/stream-kinds.json", 0, Some("tool_call")),
        ("sse/stream-last-event-id.json", 3, None),
    ] {
        let frames: Vec<Value> = corpus(case)["response"]["frames"]
            .as_array()
            .expect("frames")
            .iter()
            .filter_map(|frame| frame.get("data").cloned())
            .collect();
        let page = store
            .events(&id, events(EventPosition::From(from), 100, kinds))
            .await
            .expect("stream page");
        assert_same(case, Value::Array(frames), &page.events);
    }

    assert_eq!(
        store
            .events(&id, events(EventPosition::Latest, 50, Some("nope")))
            .await,
        Err(EventsError::UnknownKind("nope".into()))
    );
    let missing = SessionId::parse("2026-10-20-ffffffff").expect("id");
    assert_eq!(
        store
            .events(&missing, events(EventPosition::Latest, 50, None))
            .await,
        Err(EventsError::NotFound)
    );
    assert!(store.detail(&missing).await.is_none());

    // Restore wrote the recovered projection, so a second process reads it without a replay.
    let meta: Value = serde_json::from_slice(
        &std::fs::read(profile.join("sessions").join(SESSION).join("meta.json")).expect("meta"),
    )
    .expect("meta json");
    assert_eq!(meta["__historySeq"], 76);
    assert_eq!(meta["toolCalls"], session["toolCalls"]);
    let _ = std::fs::remove_dir_all(&profile);
}

#[tokio::test]
async fn the_list_pages_newest_first_with_pressure_and_the_recorded_cursor() {
    let profile = corpus_profile("golden-list");
    let store = SessionStore::open(&AppPaths::at(&profile), Logger::new());
    store.restore().await;
    let mut expected = corpus("sessions.json")["response"]["body"].clone();
    // `activeId` names the session this process last wrote; a restored one is not active.
    expected["activeId"] = Value::Null;
    let list = store
        .list(ListQuery {
            limit: 20,
            cursor: None,
            live: false,
        })
        .await;
    assert_same("sessions.json", expected.clone(), &list);
    let one = store
        .list(ListQuery {
            limit: 1,
            cursor: None,
            live: false,
        })
        .await;
    assert_same("sessions-limit-1.json", expected, &one);

    let cursor = Cursor::parse(&format!("{}.{SESSION}", u64::MAX >> 12)).expect("cursor");
    let after = store
        .list(ListQuery {
            limit: 20,
            cursor: Some(cursor),
            live: false,
        })
        .await;
    assert_eq!(
        after.sessions.len(),
        1,
        "a cursor newer than the session keeps it"
    );
    let past = Cursor::parse(&format!("1.{SESSION}")).expect("cursor");
    let none = store
        .list(ListQuery {
            limit: 20,
            cursor: Some(past),
            live: false,
        })
        .await;
    assert!(none.sessions.is_empty());
    assert_eq!(none.total, 1);
    let _ = std::fs::remove_dir_all(&profile);
}

#[test]
fn cursors_parse_only_the_shape_this_store_issues() {
    assert!(Cursor::parse("1792000000000.2026-10-20-0a1b2c3d").is_ok());
    for bad in [
        "",
        "abc",
        "1792000000000",
        "1792000000000.short",
        "1792000000000.2026-10-20-0A1B2C3D",
        "12345678901234567.2026-10-20-0a1b2c3d",
        "9007199254740993.2026-10-20-0a1b2c3d",
        "-1.2026-10-20-0a1b2c3d",
    ] {
        assert!(Cursor::parse(bad).is_err(), "{bad}");
    }
}
