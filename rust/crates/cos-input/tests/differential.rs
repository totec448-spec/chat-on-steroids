//! The Rust half of `differential/run.mjs`: runs each case's ops against the outbox, the command
//! ledger and the recorder on a fresh profile, and leaves `sessions/`, `state/` and the answers
//! beside the TypeScript ones. Without `COS_INPUT_CASES` it does nothing.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use cos_input::{Commands, Outbox, OutboxDeps, image_export_answer, system_clock};
use cos_recorder::{Recorder, Refusal};
use cos_sessions::SessionStore;
use cos_store::config::first_launch_config;
use cos_store::{AppPaths, DurableStore, Logger, Platform};
use cos_tools::EpochMs;
use serde_json::{Map, Value, json};
use tokio::sync::watch;

struct Process {
    sessions: SessionStore,
    recorder: Recorder,
    outbox: Outbox,
    commands: Commands,
}

async fn start(profile: &Path) -> Process {
    let paths = AppPaths::at(profile);
    let logger = Logger::new();
    let sessions = SessionStore::open(&paths, logger.clone());
    let config = watch::channel(Arc::new(first_launch_config(Platform::current()))).1;
    let state = DurableStore::new(paths.state(), logger.clone());
    let recorder = Recorder::new(sessions.clone(), &state, config.clone(), logger.clone());
    sessions.restore().await;
    recorder.restore().await;
    let notify: cos_input::Notify = Arc::new(|| {});
    let outbox = Outbox::new(OutboxDeps {
        sessions: sessions.clone(),
        state: &state,
        user_data: profile.to_owned(),
        config,
        logger: logger.clone(),
        notify: notify.clone(),
        clock: system_clock(),
    });
    let commands = Commands::new(sessions.clone(), &state, logger, notify, system_clock());
    commands.restore().await;
    Process {
        sessions,
        recorder,
        outbox,
        commands,
    }
}

async fn stop(process: &Process) {
    process.sessions.flush().await;
    process.recorder.flush();
    process.outbox.flush();
    process.commands.flush();
}

/// `<SESSION:conversation>` is that chat's session id, `<NOW-n>` the clock minus n.
fn resolve(value: &Value, sessions: &SessionStore) -> Value {
    match value {
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| resolve(item, sessions)).collect())
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), resolve(item, sessions)))
                .collect::<Map<String, Value>>(),
        ),
        Value::String(text) => {
            if let Some(conversation) = text
                .strip_prefix("<SESSION:")
                .and_then(|rest| rest.strip_suffix('>'))
            {
                return sessions
                    .find_by_conversation(conversation, false)
                    .map_or(value.clone(), |session| json!(session.id.as_str()));
            }
            if let Some(ms) = text
                .strip_prefix("<NOW-")
                .and_then(|rest| rest.strip_suffix('>'))
                .and_then(|ms| ms.parse::<u64>().ok())
            {
                return json!(EpochMs::now().0 - ms);
            }
            value.clone()
        }
        _ => value.clone(),
    }
}

async fn exchange(process: &Process, route: &str, body: &Value) -> Value {
    let now = EpochMs::now();
    let refused = |Refusal(word)| (400, json!({ "error": word }));
    let (status, body) = match route {
        "/events" => match process.recorder.events(body, now).await {
            Ok(stored) => (200, serde_json::to_value(stored).unwrap_or_default()),
            Err(refusal) => refused(refusal),
        },
        "/closed" => {
            process.recorder.closed(body).await;
            (200, json!({ "ok": true }))
        }
        "/conversation-deleted" => {
            let answer = process.outbox.deleted_answer(body).await;
            (answer.status, answer.body)
        }
        "/image-export" => {
            let answer = image_export_answer(body);
            (answer.status, answer.body)
        }
        route if route.starts_with("/commands/") => {
            let answer = process.commands.answer(route, body).await;
            (answer.status, answer.body)
        }
        route if route.starts_with("/input/") => {
            let answer = process.outbox.answer(route, body).await;
            (answer.status, answer.body)
        }
        other => (404, json!({ "error": format!("unscripted route {other}") })),
    };
    json!({ "route": route, "status": status, "body": body })
}

async fn run_case(dir: &Path) {
    let ops: Vec<Value> =
        serde_json::from_slice(&std::fs::read(dir.join("ops.json")).expect("ops"))
            .expect("ops json");
    let profile: PathBuf = dir.join("rust");
    let mut process = start(&profile).await;
    let mut seeds: Vec<(String, Value)> = Vec::new();
    let mut answers = Vec::new();
    for raw in &ops {
        let op = resolve(raw, &process.sessions);
        if let Some(route) = op["route"].as_str() {
            answers.push(exchange(&process, route, &op["request"]).await);
        } else if !op["enqueue"].is_null() {
            let answer = match process.outbox.enqueue(&op["enqueue"]).await {
                Ok(row) => serde_json::to_value(row).unwrap_or_default(),
                Err(error) => json!({ "error": error.0 }),
            };
            answers.push(json!({ "enqueue": answer }));
        } else if op["pending"] == true {
            let pending = process.outbox.pending().await.expect("pending");
            answers.push(json!({ "pending": pending }));
        } else if let Some(name) = op["seed"].as_str() {
            seeds.push((name.to_owned(), op["value"].clone()));
            answers.push(json!({ "seed": name }));
        } else if op["restart"] == true {
            stop(&process).await;
            drop(process);
            for (name, value) in seeds.drain(..) {
                let state = profile.join("state");
                std::fs::create_dir_all(&state).expect("state");
                std::fs::write(
                    state.join(format!("{name}.json")),
                    serde_json::to_vec(&value).expect("seed"),
                )
                .expect("write seed");
            }
            process = start(&profile).await;
            answers.push(json!({ "restart": true }));
        }
    }
    stop(&process).await;
    std::fs::write(
        profile.join("answers.json"),
        serde_json::to_vec_pretty(&answers).expect("answers"),
    )
    .expect("write answers");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn runs_the_outbox_ops() {
    let Ok(root) = std::env::var("COS_INPUT_CASES") else {
        return;
    };
    let root = PathBuf::from(root);
    let cases: Vec<String> =
        serde_json::from_slice(&std::fs::read(root.join("cases.json")).expect("cases"))
            .expect("cases json");
    for case in cases {
        run_case(&root.join(case)).await;
    }
}
