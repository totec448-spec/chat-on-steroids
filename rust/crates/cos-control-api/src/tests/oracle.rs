//! Replays `tests/fixtures/oracle.json`: what the TypeScript control API decided, with the app's
//! own zod and Node's URL parser, for each query, header, body, text and target in its lists.
//! Regenerate it with `tests/oracle/oracle.mjs`.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};

use crate::actions::{cancel_body, send_body};
use crate::query::{Shape, parse_query, parse_target};
use crate::reads::{EVENTS, INPUTS, LOG, SESSION, SESSIONS, STREAM, events_query};
use crate::reply::Refusal;
use crate::text::redact_secret_text;

fn oracle() -> Value {
    let text = include_str!("../../tests/fixtures/oracle.json");
    serde_json::from_str(text).expect("the oracle is JSON")
}

/// The case's expected outcome in the oracle's form: `{ok}` or `{status, error, detail?}`.
fn expected(case: &Value) -> Value {
    let mut case = case.clone();
    let object = case.as_object_mut().expect("a case");
    object.retain(|key, _| matches!(key.as_str(), "ok" | "status" | "error" | "detail"));
    case
}

fn outcome(result: Result<Value, Refusal>) -> Value {
    match result {
        Ok(value) => json!({ "ok": value }),
        Err(Refusal::InvalidQuery(detail)) => {
            json!({ "status": 400, "error": "invalid_query", "detail": detail })
        }
        Err(Refusal::InvalidBody(detail)) => {
            json!({ "status": 400, "error": "invalid_body", "detail": detail })
        }
        Err(other) => panic!("not a refusal the oracle covers: {other:?}"),
    }
}

fn params(query: &str) -> Vec<(String, String)> {
    parse_target(&format!("/?{query}"))
        .expect("a target")
        .params
}

fn shape(route: &str) -> Shape {
    match route {
        "sessions" => SESSIONS,
        "session" => SESSION,
        "events" => EVENTS,
        "stream" => STREAM,
        "inputs" => INPUTS,
        "agents" => &[],
        "log" => LOG,
        other => panic!("no shape for {other}"),
    }
}

#[test]
fn queries_are_decided_as_the_app_decides_them() {
    let oracle = oracle();
    let mut checked = 0;
    for (route, cases) in oracle["query"].as_object().expect("routes") {
        for case in cases.as_array().expect("cases") {
            let query = case["query"].as_str().expect("a query");
            let given = params(query);
            let got = match route.as_str() {
                "events" => events_query(&given).map(|query| query.to_json()),
                "stream" => crate::stream::start(&given, &[]).map(|(from, kinds)| {
                    let mut ok = json!({ "from": from });
                    if let Some(kinds) = kinds {
                        ok["kinds"] = json!(kinds);
                    }
                    ok
                }),
                _ => parse_query(&given, shape(route)).map(|query| query.to_json()),
            };
            assert_eq!(outcome(got), expected(case), "{route}?{query}");
            checked += 1;
        }
    }
    assert!(checked > 90, "only {checked} query cases");
}

#[test]
fn last_event_id_is_decided_as_the_app_decides_it() {
    let oracle = oracle();
    for case in oracle["lastEventId"].as_array().expect("cases") {
        let header = case["header"].as_str().expect("a header");
        let got = crate::stream::start(&params("from=5"), &[header.as_bytes()])
            .map(|(from, _)| json!({ "from": from }));
        assert_eq!(outcome(got), expected(case), "{header:?}");
    }
}

#[test]
fn action_bodies_are_decided_as_the_app_decides_them() {
    let oracle = oracle();
    let send = |body: Option<&Value>| send_body(body).map(|_| ());
    for (list, check) in [
        (
            "send",
            &send as &dyn Fn(Option<&Value>) -> Result<(), Refusal>,
        ),
        ("cancel", &cancel_body),
    ] {
        for case in oracle[list].as_array().expect("cases") {
            let body = &case["body"];
            let given = (body != "<undefined>").then_some(body);
            let got = check(given).map(|()| Value::Null);
            let mut want = expected(case);
            if want.get("ok").is_some() {
                want = json!({ "ok": null });
            }
            assert_eq!(outcome(got), want, "{list} {body}");
        }
    }
}

#[test]
fn credential_shapes_are_redacted_as_the_app_redacts_them() {
    let oracle = oracle();
    let decode = |value: &Value| {
        let bytes = STANDARD
            .decode(value.as_str().expect("base64"))
            .expect("base64");
        String::from_utf8(bytes).expect("utf-8")
    };
    for case in oracle["redaction"].as_array().expect("cases") {
        let text = decode(&case["text"]);
        assert_eq!(
            redact_secret_text(&text),
            decode(&case["redacted"]),
            "{text:?}"
        );
    }
}

#[test]
fn targets_are_parsed_as_node_parses_them() {
    let oracle = oracle();
    for case in oracle["targets"].as_array().expect("cases") {
        let raw = case["raw"].as_str().expect("a target");
        let got = match parse_target(raw) {
            Err(Refusal::InvalidTarget) => json!({ "invalid": true }),
            Err(other) => panic!("{raw}: {other:?}"),
            Ok(target) => json!({
                "pathname": target.path,
                "search": if target.search.is_empty() { String::new() } else { format!("?{}", target.search) },
                "params": target.params.iter().map(|(name, value)| json!([name, value])).collect::<Vec<_>>(),
            }),
        };
        let mut want = case.clone();
        want.as_object_mut().expect("a case").remove("raw");
        assert_eq!(got, want, "{raw}");
    }
}
