//! The pure Goal rules against the TypeScript module itself: `differential/corpus.json` run
//! through `src/main/goal.ts` and `src/shared/goal-*.ts` (`differential/oracle.mjs`) gave
//! `differential/oracle.json`; the Rust port must answer the same.

use cos_goal::{
    CONTINUATIONS, Decision, Endpoint, error_key, error_message, human_reply, resolve_base_url,
    template_continuation, template_decision,
};
use cos_types::config::GoalProviderKind;
use serde_json::{Value, json};

fn load(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("differential")
        .join(name);
    serde_json::from_str(&std::fs::read_to_string(path).expect("fixture")).expect("json")
}

fn strings(value: &Value) -> Vec<&str> {
    value
        .as_array()
        .expect("list")
        .iter()
        .map(|v| v.as_str().expect("string"))
        .collect()
}

#[test]
fn human_reply_types_what_typescript_types() {
    let (corpus, oracle) = (load("corpus.json"), load("oracle.json"));
    for (input, expected) in strings(&corpus["replies"])
        .into_iter()
        .zip(strings(&oracle["replies"]))
    {
        assert_eq!(human_reply(input), expected, "{input}");
        assert_eq!(
            human_reply(input),
            human_reply(input),
            "the same draft every time"
        );
    }
}

#[test]
fn error_explanations_match() {
    let (corpus, oracle) = (load("corpus.json"), load("oracle.json"));
    let expected = oracle["errors"].as_array().expect("errors");
    for (error, want) in strings(&corpus["errors"]).into_iter().zip(expected) {
        assert_eq!(
            json!({ "message": error_message(error), "key": error_key(error) }),
            *want,
            "{error}"
        );
    }
}

#[test]
fn base_url_rules_match() {
    let (corpus, oracle) = (load("corpus.json"), load("oracle.json"));
    let expected = oracle["urls"].as_array().expect("urls");
    for (url, want) in strings(&corpus["urls"]).into_iter().zip(expected) {
        let endpoint = Endpoint {
            kind: GoalProviderKind::Custom,
            base_url: url.to_owned(),
        };
        let got = match resolve_base_url(&endpoint) {
            Ok(ok) => json!({ "ok": ok }),
            Err(error) => json!({ "error": error }),
        };
        assert_eq!(got, *want, "{url}");
    }
}

#[test]
fn offline_templates_match() {
    let (corpus, oracle) = (load("corpus.json"), load("oracle.json"));
    let continuations = strings(&oracle["continuations"]);
    assert_eq!(continuations.len(), CONTINUATIONS);
    for (slot, want) in continuations.into_iter().enumerate() {
        assert_eq!(template_continuation(slot), want);
    }
    let cases = corpus["templates"].as_array().expect("templates");
    for (case, want) in cases
        .iter()
        .zip(oracle["templates"].as_array().expect("answers"))
    {
        let final_text = case[0].as_str().expect("final");
        let got = match template_decision(
            final_text,
            case[1].as_u64().expect("slot"),
            case[2].as_u64().expect("slot"),
        ) {
            Decision::Stop => json!({ "action": "stop" }),
            Decision::Continue(reply) => json!({ "action": "continue", "reply": reply }),
            Decision::Invalid(error) => json!({ "action": "invalid", "error": error }),
        };
        assert_eq!(got, *want, "{final_text}");
    }
}
