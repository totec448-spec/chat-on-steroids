//! The Rust half of `differential/run.mjs`: runs each case's ops against `cos-continuation` on a
//! fresh profile and leaves `sessions/`, `state/` and the answers beside the TypeScript ones.
//! Without `COS_CONTINUATION_CASES` it does nothing.

mod support;

use std::path::{Path, PathBuf};

use cos_continuation::CommitResult;
use serde_json::{Value, json};
use support::*;

fn view(process: &Process, token: &str) -> Value {
    let Some(entry) = process.continuations.by_token(token) else {
        return Value::Null;
    };
    json!({
        "state": entry.state.as_str(),
        "to": entry.to,
        "error": entry.error,
        "automatic": entry.automatic,
        "hasHandoff": entry.handoff_id.is_some(),
        "sourceSend": entry.source_send.state.as_str(),
        "destinationSend": entry.destination_send.send.state.as_str(),
    })
}

async fn step(process: &Process, token: &str, name: &str) -> Value {
    let c = &process.continuations;
    match name {
        "sourceAttempt" => json!(
            c.begin_source_send(token, None)
                .await
                .ok()
                .flatten()
                .map(|s| s.allowed)
        ),
        "sourceDispatch" => json!(
            c.dispatch_source_send(token, Some("before"))
                .await
                .unwrap_or(false)
        ),
        "sourceMessage" => json!(
            c.bind_source_message(token, "handoff-message", None)
                .await
                .unwrap_or(false)
        ),
        "capture" => json!(c.attach_summary(token, SAMPLE_BRIEF).await.is_some()),
        "claim" => json!(c.claim(token, "command-1").await.ok().flatten().is_some()),
        "destinationAttempt" => json!(
            c.begin_destination_send(token)
                .await
                .ok()
                .flatten()
                .map(|s| s.allowed)
        ),
        "destinationDispatch" => json!(c.dispatch_destination_send(token).await.unwrap_or(false)),
        "destinationMessage" => json!(
            c.bind_destination_message(token, CHAT_B, "resume-message")
                .await
                .unwrap_or(false)
        ),
        "commit" => json!(match c.commit(token, CHAT_B).await {
            CommitResult::Committed(_) => "committed",
            CommitResult::AlreadyCommitted(_) => "already-committed",
            CommitResult::Retryable(_) => "retryable",
            CommitResult::Rejected(_) => "rejected",
        }),
        "abort" => json!(c.abort_now(token, "cancelled").await.unwrap_or(false)),
        other => panic!("unknown step {other}"),
    }
}

async fn run_case(profile: &Path, ops: &[Value]) -> Vec<Value> {
    let offset = Offset::default();
    let mut process = start(profile, &offset).await;
    let mut session = None;
    let mut token = String::new();
    let mut answers = Vec::new();
    for op in ops {
        if let Some(chat) = op["create"].as_str() {
            session = Some(process.chat_session(chat).await);
            answers.push(json!({ "created": true }));
        } else if let Some(open) = op.get("open") {
            let automatic = open["automatic"].as_bool().unwrap_or(false);
            let session = session.as_ref().expect("a session first");
            let opened = process
                .continuations
                .open(session, CHAT_A, automatic, None)
                .await
                .expect("opened");
            token = opened.token.clone();
            answers.push(json!({ "opened": opened.state.as_str(), "automatic": opened.automatic }));
        } else if let Some(name) = op["step"].as_str() {
            answers.push(json!({ "step": name, "result": step(&process, &token, name).await }));
        } else if op["restart"] == true {
            process.stop().await;
            process = start(profile, &offset).await;
            answers.push(json!({ "restart": true }));
        } else if op["view"] == true {
            answers.push(json!({ "view": view(&process, &token) }));
        } else if let Some(crash) = op.get("crash") {
            let to = crash["to"].as_str().expect("to");
            process.stop().await;
            let file = profile.join("state").join("continuations.json");
            let mut wal: Value =
                serde_json::from_slice(&std::fs::read(&file).expect("wal")).expect("json");
            wal["entries"][0]["state"] = "committing".into();
            wal["entries"][0]["to"] = to.into();
            std::fs::write(&file, serde_json::to_vec(&wal).expect("bytes")).expect("written");
            if crash["rebound"] == true {
                let session = session.as_ref().expect("a session");
                assert!(
                    process
                        .sessions
                        .rebind_session(session, Some(CHAT_A), to, None)
                        .await
                );
            }
            process.stop().await;
            process = start(profile, &offset).await;
            answers.push(json!({ "crash": true }));
        }
    }
    process.stop().await;
    answers
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn runs_the_continuation_ops() {
    let Ok(cases) = std::env::var("COS_CONTINUATION_CASES") else {
        return;
    };
    let cases = PathBuf::from(cases);
    let names: Vec<String> =
        serde_json::from_slice(&std::fs::read(cases.join("cases.json")).expect("cases"))
            .expect("json");
    for name in names {
        let dir = cases.join(&name);
        let ops: Vec<Value> =
            serde_json::from_slice(&std::fs::read(dir.join("ops.json")).expect("ops"))
                .expect("json");
        let profile = dir.join("rust");
        let answers = run_case(&profile, &ops).await;
        std::fs::write(
            profile.join("answers.json"),
            serde_json::to_vec_pretty(&answers).expect("answers"),
        )
        .expect("written");
    }
}
