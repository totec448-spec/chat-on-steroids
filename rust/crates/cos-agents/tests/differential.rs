//! The Rust half of `differential/run.mjs`: runs each case's broker ops against the Rust
//! broker and leaves `state/swarm.json`, `state/retired-workers.json` and the answers beside
//! the TypeScript side's. Without `COS_AGENTS_CASES` it does nothing.

mod support;

use std::fs;
use std::path::Path;

use cos_agents::{Caller, ClearOutcome, MessageItem, WorkerRequest};
use serde_json::{Value, json};
use support::Served;

fn caller(op: &Value) -> Caller {
    Caller {
        conversation_id: op["caller"]["conversationId"].as_str().map(str::to_owned),
        request_id: op["caller"]["requestId"].as_str().map(str::to_owned),
        setup_profile_id: None,
        run_id: op["caller"]["runId"].as_str().map(str::to_owned),
    }
}

fn text(op: &Value, key: &str) -> String {
    op[key].as_str().unwrap_or_default().to_owned()
}

fn refused(error: impl Into<ErrorText>) -> Value {
    json!({ "error": error.into().0 })
}

struct ErrorText(String);

impl From<cos_agents::AgentError> for ErrorText {
    fn from(error: cos_agents::AgentError) -> Self {
        Self(error.text().to_owned())
    }
}

impl From<cos_agents::AcceptError> for ErrorText {
    fn from(error: cos_agents::AcceptError) -> Self {
        match error {
            cos_agents::AcceptError::Refused(error) => Self(error.text().to_owned()),
            cos_agents::AcceptError::NotDurable(text) => Self(text),
        }
    }
}

async fn apply(served: &Served, op: &Value) -> Value {
    let agents = &served.agents;
    let who = caller(op);
    let prime = op["prime"].as_str().map(str::to_owned);
    match op["op"].as_str().unwrap_or_default() {
        "spawn" => {
            let workers: Vec<WorkerRequest> = op["workers"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|worker| WorkerRequest {
                    label: worker["label"].as_str().map(str::to_owned),
                    task: worker["task"].as_str().unwrap_or_default().to_owned(),
                    model: worker["model"].as_str().map(str::to_owned),
                    reasoning_effort: worker["reasoning_effort"].as_str().map(str::to_owned),
                })
                .collect();
            let context = op["context"].as_str().map(str::to_owned);
            match agents
                .accept("spawn", move |broker, policy, now| {
                    broker.spawn(&who, &workers, context.as_deref(), policy, &[], now)
                })
                .await
            {
                Ok(staged) => json!({
                    "runId": staged.run_id,
                    "becamePrime": staged.became_prime,
                    "created": staged.created.iter().map(|info| json!([info.id, info.state.as_str()])).collect::<Vec<_>>(),
                }),
                Err(error) => refused(error),
            }
        }
        "bind" => {
            let (id, conversation) = (text(op, "id"), text(op, "conversationId"));
            json!(
                served
                    .broker(move |broker, _, now| {
                        let run = prime.and_then(|prime| broker.current_run_id(&prime));
                        broker.bind_conversation(&id, &conversation, run.as_deref(), now)
                    })
                    .await
            )
        }
        "message" => {
            let items: Vec<MessageItem> = op["items"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|item| MessageItem {
                    to: item["to"].as_str().unwrap_or_default().to_owned(),
                    text: item["text"].as_str().unwrap_or_default().to_owned(),
                    label: item["label"].as_str().map(str::to_owned),
                })
                .collect();
            match agents
                .accept("message", move |broker, policy, now| {
                    broker.stage_messages(&who, &items, policy, now)
                })
                .await
            {
                Ok(staged) => json!({
                    "runId": staged.run_id,
                    "to": staged.messages.iter().map(|message| message.to.clone()).collect::<Vec<_>>(),
                    "waking": staged.waking,
                }),
                Err(error) => refused(error),
            }
        }
        "offer" => {
            let offered = served
                .broker(move |broker, policy, now| {
                    broker.offer_for_caller(&who, false, policy, now)
                })
                .await;
            offered.map_or(Value::Null, |(_, messages)| {
                messages
                    .iter()
                    .map(|message| json!([message.from, message.text, message.offers]))
                    .collect()
            })
        }
        "ack" => {
            let acked = served
                .broker(move |broker, policy, now| {
                    broker.acknowledge_for_caller(&who, false, u64::MAX, policy, now)
                })
                .await;
            acked.map_or(Value::Null, |(_, messages)| {
                messages.iter().map(|message| json!(message.id)).collect()
            })
        }
        "finish" => {
            let result = text(op, "result");
            match agents
                .accept("finish", move |broker, policy, now| {
                    broker.finish(&who, &result, policy, now)
                })
                .await
            {
                Ok(finished) => json!({
                    "state": finished.info.state.as_str(),
                    "repeat": finished.repeat,
                    "report": finished.report.map(|report| report.text),
                }),
                Err(error) => refused(error),
            }
        }
        "status" => match agents
            .read(move |broker, policy| broker.status_for_caller(&who, policy))
            .await
        {
            Ok(status) => json!({
                "self": status.self_info.map(|info| info.id),
                "runId": status.run_id,
                "free": status.free_worker_slots,
                "agents": status.state.agents.iter().map(|info| json!([info.id, info.state.as_str()])).collect::<Vec<_>>(),
            }),
            Err(error) => refused(error),
        },
        "context" => {
            let (conversation, tokens) = (
                text(op, "conversationId"),
                op["tokens"].as_u64().unwrap_or(0),
            );
            served
                .broker(move |broker, _, now| {
                    broker.note_context_tokens(&conversation, tokens, now)
                })
                .await;
            Value::Null
        }
        "release" => json!(
            served
                .broker(|broker, _, now| broker.release_quiescent_run(
                    None,
                    "no worker is currently running",
                    now
                ))
                .await
        ),
        "revived" => {
            let id = text(op, "id");
            served
                .broker(move |broker, policy, now| {
                    let run = prime.and_then(|prime| broker.current_run_id(&prime));
                    let revival = broker
                        .pending_worker_revivals(policy)
                        .into_iter()
                        .find(|entry| entry.id == id && Some(&entry.run_id) == run.as_ref())?;
                    let noted = broker.note_worker_revived(
                        &id,
                        &revival.conversation_id,
                        &revival.message_ids,
                        None,
                        run.as_deref(),
                        now,
                    );
                    Some(json!([revival.text, noted]))
                })
                .await
                .unwrap_or(Value::Null)
        }
        "failRevival" => {
            let (id, why) = (text(op, "id"), text(op, "why"));
            served
                .broker(move |broker, _, now| {
                    let run = prime.and_then(|prime| broker.current_run_id(&prime));
                    broker.fail_worker_revival(&id, &why, run.as_deref(), now)
                })
                .await
                .map_or(Value::Null, |report| json!(report.text))
        }
        "sleep" => {
            let (id, reason) = (text(op, "id"), text(op, "reason"));
            served
                .broker(move |broker, _, now| {
                    let run = prime.and_then(|prime| broker.current_run_id(&prime));
                    broker.sleep_worker(&id, &reason, run.as_deref(), now)
                })
                .await
                .and_then(|finished| finished.report)
                .map_or(Value::Null, |report| json!(report.text))
        }
        "fail" => {
            let (id, reason) = (text(op, "id"), text(op, "reason"));
            served
                .broker(move |broker, _, now| {
                    let run = prime.and_then(|prime| broker.current_run_id(&prime));
                    broker.fail_agent(&id, &reason, None, false, run.as_deref(), now)
                })
                .await
                .and_then(|finished| finished.report)
                .map_or(Value::Null, |report| json!(report.text))
        }
        "clear" => {
            let id = text(op, "id");
            let outcome = served
                .broker(move |broker, _, now| {
                    let run = prime.and_then(|prime| broker.current_run_id(&prime));
                    broker.clear_agent(&id, run.as_deref(), now)
                })
                .await;
            json!(match outcome {
                ClearOutcome::Run => "run",
                ClearOutcome::Worker(_) => "worker",
                ClearOutcome::None(_) => "none",
            })
        }
        "disable" => json!(
            served
                .broker(|broker, _, now| broker
                    .pause_for_disable("multi-agent mode was turned off", now))
                .await
        ),
        other => panic!("unknown op {other}"),
    }
}

async fn run_case(case: &Path) {
    let ops: Vec<Value> =
        serde_json::from_str(&fs::read_to_string(case.join("ops.json")).expect("ops.json"))
            .expect("ops parse");
    let name = case
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("case");
    let mut served = Served::new(&format!("differential-{name}"), |config| {
        config.multi_agent.max_workers = 3;
        config.multi_agent.allow_unattributed_calls = false;
    });
    let run = served.profile.parent().expect("run folder").to_owned();
    let mut answers = Vec::new();
    for op in &ops {
        let answer = if op["op"] == "restart" {
            served.agents.flush();
            drop(served);
            served = Served::at(run.clone(), |config| {
                config.multi_agent.max_workers = 3;
                config.multi_agent.allow_unattributed_calls = false;
            });
            served.agents.restore().await;
            Value::Null
        } else {
            apply(&served, op).await
        };
        let swarm = served
            .agents
            .read(|broker, policy| broker.swarm_state(policy))
            .await;
        answers.push(json!({ "op": op["op"], "answer": answer, "swarm": swarm }));
    }
    let out = case.join("rust");
    fs::create_dir_all(out.join("state")).expect("state folder");
    let (swarm, retired) = served.agents.snapshots().await;
    if let Some(swarm) = swarm {
        fs::write(
            out.join("state/swarm.json"),
            serde_json::to_string_pretty(&swarm).expect("json"),
        )
        .expect("swarm.json");
    }
    fs::write(
        out.join("state/retired-workers.json"),
        serde_json::to_string_pretty(&retired).expect("json"),
    )
    .expect("retired-workers.json");
    fs::write(
        out.join("answers.json"),
        serde_json::to_string_pretty(&answers).expect("json"),
    )
    .expect("answers.json");
}

#[tokio::test]
async fn runs_the_broker_ops() {
    let Ok(cases) = std::env::var("COS_AGENTS_CASES") else {
        return;
    };
    let root = Path::new(&cases);
    let names: Vec<String> =
        serde_json::from_str(&fs::read_to_string(root.join("cases.json")).expect("cases.json"))
            .expect("cases parse");
    for name in names {
        run_case(&root.join(name)).await;
    }
}
