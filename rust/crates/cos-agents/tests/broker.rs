//! The broker's behavior, case by case from `test/agents.test.ts`: creating a run atomically,
//! the star topology, at-least-once delivery, sleeping and waking, terminal states and
//! restart. Calls a model makes go through the kernel; browser observations go to the broker.

mod support;

use cos_agents::{AgentError, Caller, MessageItem, PRIME_ID, WORKER_CONTEXT_CEILING_TOKENS};
use cos_types::session::AgentState;
use serde_json::{Value, json};
use support::{Served, conversation};

fn prime_chat() -> String {
    conversation(1)
}

fn worker_chat(n: u32) -> String {
    conversation(100 + n)
}

async fn start_swarm(served: &Served, count: usize) -> Value {
    let workers: Vec<Value> = (1..=count)
        .map(|n| json!({ "label": format!("Worker {n}"), "task": format!("task {n}") }))
        .collect();
    let result = served
        .call_from(
            Some(&prime_chat()),
            json!({ "action": "spawn", "workers": workers }),
        )
        .await;
    assert_eq!(result.get("isError"), None, "{result}");
    result
}

async fn bind(served: &Served, id: &str, chat: &str) -> bool {
    let (id, chat) = (id.to_owned(), chat.to_owned());
    served
        .broker(move |broker, _, now| broker.bind_conversation(&id, &chat, None, now))
        .await
}

async fn state_of(served: &Served, id: &str) -> AgentState {
    let id = id.to_owned();
    served
        .agents
        .read(move |broker, policy| {
            let state = broker.swarm_state(policy);
            state
                .agents
                .iter()
                .chain(state.retained_workers.iter().flatten())
                .find(|agent| agent.id == id)
                .map(|agent| agent.state)
        })
        .await
        .expect("agent exists")
}

async fn pending(served: &Served, id: &str) -> u64 {
    let id = id.to_owned();
    served
        .agents
        .read(move |broker, policy| {
            broker
                .swarm_state(policy)
                .agents
                .iter()
                .find(|agent| agent.id == id)
                .map_or(0, |agent| agent.pending)
        })
        .await
}

async fn fill_context(served: &Served, chat: &str) {
    let chat = chat.to_owned();
    served
        .broker(move |broker, _, now| {
            broker.note_context_tokens(&chat, WORKER_CONTEXT_CEILING_TOKENS, now)
        })
        .await;
}

#[tokio::test]
async fn returns_an_empty_exact_caller_status_without_creating_a_family_or_exposing_another_prime()
{
    let served = Served::new("empty-status", |config| config.multi_agent.max_workers = 3);
    let empty = served
        .call_from(Some(&prime_chat()), json!({ "action": "status" }))
        .await;
    assert_eq!(
        Served::text(&empty),
        "No workers or retained worker history belong to this caller. Use agents action=spawn if the task needs workers."
    );
    assert_eq!(
        empty["structuredContent"],
        json!({ "action": "status", "run_id": null, "self": null, "agents": [], "free_worker_slots": 3 })
    );
    start_swarm(&served, 1).await;
    let stranger = served
        .call_from(Some(&conversation(9)), json!({ "action": "status" }))
        .await;
    assert_eq!(stranger["structuredContent"]["agents"], json!([]));
    let own = served
        .call_from(Some(&prime_chat()), json!({ "action": "status" }))
        .await;
    assert_eq!(
        own["structuredContent"]["agents"].as_array().map(Vec::len),
        Some(2)
    );
    assert_eq!(own["structuredContent"]["self"], "prime");
}

#[tokio::test]
async fn binds_the_calling_conversation_as_prime_and_creates_its_workers() {
    let served = Served::new("spawn", |_| {});
    let result = start_swarm(&served, 2).await;
    let run_id = result["structuredContent"]["run_id"]
        .as_str()
        .expect("run id")
        .to_owned();
    assert!(Served::text(&result).starts_with(&format!(
        "This conversation is now the prime agent of run {run_id}. 2 worker(s) matched: worker-1 (Worker 1, invited), worker-2 (Worker 2, invited). New worker chats are opening"
    )));
    assert_eq!(result["structuredContent"]["became_prime"], true);
    let ids: Vec<String> = served
        .tabs
        .spawns
        .lock()
        .unwrap()
        .iter()
        .map(|spawn| spawn.id.clone())
        .collect();
    assert_eq!(ids, ["worker-1", "worker-2"]);
    let file = served
        .swarm_file()
        .expect("the accepted run is on disk before the answer");
    assert_eq!(file["version"], 7);
    assert_eq!(file["runId"], run_id.as_str());
    assert_eq!(file["primeConversationId"], prime_chat().as_str());
    let agents: Vec<&str> = file["activeRuns"][0]["agents"]
        .as_array()
        .expect("agents")
        .iter()
        .map(|agent| agent["info"]["id"].as_str().unwrap_or_default())
        .collect();
    assert_eq!(agents, ["prime", "worker-1", "worker-2"]);
    // A full version 4 UUID fences stale worker commands.
    let shape = run_id.split('-').map(str::len).collect::<Vec<_>>();
    assert_eq!(shape, [8, 4, 4, 4, 12]);
    assert_eq!(&run_id[14..15], "4");
}

#[tokio::test]
async fn creates_nothing_at_all_when_any_worker_in_the_request_is_invalid() {
    let served = Served::new("invalid-worker", |_| {});
    let result = served
        .call_from(
            Some(&prime_chat()),
            json!({ "action": "spawn", "workers": [{ "task": "fine" }, { "task": "   " }] }),
        )
        .await;
    assert_eq!(
        Served::text(&result),
        "Worker 2 has no task. Every worker needs one."
    );
    assert_eq!(result["isError"], true);
    let long = served
        .call_from(
            Some(&prime_chat()),
            json!({ "action": "spawn", "workers": [{ "label": "x".repeat(60), "task": "fine", "model": "bad model!" }] }),
        )
        .await;
    assert!(Served::text(&long).contains("Worker 1's model is not a ChatGPT model slug"));
    assert_eq!(served.swarm_file(), None);
    assert!(served.tabs.spawns.lock().unwrap().is_empty());
}

#[tokio::test]
async fn enforces_the_configured_live_worker_limit() {
    let served = Served::new("limit", |config| config.multi_agent.max_workers = 3);
    start_swarm(&served, 3).await;
    let more = served
        .call_from(
            Some(&prime_chat()),
            json!({ "action": "spawn", "workers": [{ "task": "one too many" }] }),
        )
        .await;
    assert_eq!(
        Served::text(&more),
        "That would make 4 live workers; the limit set in the app is 3."
    );
}

#[tokio::test]
async fn folds_an_exact_repeat_but_creates_a_fresh_worker_once_the_old_one_sleeps() {
    let served = Served::new("repeat", |_| {});
    start_swarm(&served, 1).await;
    let again = start_swarm(&served, 1).await;
    assert_eq!(again["structuredContent"]["became_prime"], false);
    assert_eq!(again["structuredContent"]["workers"][0]["id"], "worker-1");
    assert!(bind(&served, "worker-1", &worker_chat(1)).await);
    let finished = served
        .call_from(
            Some(&worker_chat(1)),
            json!({ "action": "finish", "result": "the first task finished" }),
        )
        .await;
    assert_eq!(finished["structuredContent"]["state"], "sleeping");
    let fresh = start_swarm(&served, 1).await;
    assert_eq!(fresh["structuredContent"]["workers"][0]["id"], "worker-2");
    assert_eq!(fresh["structuredContent"]["workers"][0]["state"], "invited");
    assert_eq!(state_of(&served, "worker-1").await, AgentState::Sleeping);
}

#[tokio::test]
async fn lets_independent_primes_recruit_only_into_their_own_families() {
    let served = Served::new("families", |_| {});
    start_swarm(&served, 1).await;
    let other = served
        .call_from(
            Some(&conversation(2)),
            json!({ "action": "spawn", "workers": [{ "task": "more" }] }),
        )
        .await;
    assert_eq!(other["structuredContent"]["became_prime"], true);
    assert_eq!(other["structuredContent"]["workers"][0]["id"], "worker-1");
    let all = served
        .agents
        .read(|broker, policy| broker.swarm_state(policy).agents.len())
        .await;
    assert_eq!(all, 4);
    let mine = served
        .call_from(Some(&prime_chat()), json!({ "action": "status" }))
        .await;
    assert_eq!(
        mine["structuredContent"]["agents"].as_array().map(Vec::len),
        Some(2)
    );
}

#[tokio::test]
async fn enforces_the_star_topology() {
    let served = Served::new("star", |_| {});
    start_swarm(&served, 2).await;
    assert!(bind(&served, "worker-1", &worker_chat(1)).await);
    assert!(bind(&served, "worker-2", &worker_chat(2)).await);
    let up = served
        .call_from(
            Some(&worker_chat(1)),
            json!({ "action": "message", "to": "prime", "text": "found something" }),
        )
        .await;
    assert_eq!(Served::text(&up), "Queued for prime.");
    let sideways = served
        .call_from(
            Some(&worker_chat(1)),
            json!({ "action": "message", "to": "worker-2", "text": "psst" }),
        )
        .await;
    assert_eq!(
        Served::text(&sideways),
        "Workers may only message the prime agent. Send it there and let the prime decide."
    );
    let down = served
        .call_from(
            Some(&prime_chat()),
            json!({ "action": "message", "to": "worker-1", "text": "noted" }),
        )
        .await;
    assert_eq!(Served::text(&down), "Queued for worker-1.");
    let unknown = served
        .call_from(
            Some(&prime_chat()),
            json!({ "action": "message", "to": "worker-9", "text": "hello" }),
        )
        .await;
    assert_eq!(
        Served::text(&unknown),
        "Unknown agent \"worker-9\". Call agents action=status to see who exists."
    );
    let both = served
        .call_from(
            Some(&prime_chat()),
            json!({ "action": "message", "to": "worker-1", "text": "a", "messages": [{ "to": "worker-2", "text": "b" }] }),
        )
        .await;
    assert_eq!(
        Served::text(&both),
        "agents action=message takes either to+text or messages, not both."
    );
    assert_eq!(pending(&served, "worker-2").await, 0);
    assert_eq!(pending(&served, PRIME_ID).await, 1);
}

#[tokio::test]
async fn re_offers_an_unacknowledged_message_and_retires_it_only_on_the_next_call() {
    let served = Served::new("delivery", |_| {});
    start_swarm(&served, 1).await;
    assert!(bind(&served, "worker-1", &worker_chat(1)).await);
    served
        .call_from(
            Some(&prime_chat()),
            json!({ "action": "message", "to": "worker-1", "text": "a correction" }),
        )
        .await;
    let worker = Caller::conversation(&worker_chat(1));
    let offer = |caller: Caller| {
        served.broker(move |broker, policy, now| {
            broker
                .offer_for_caller(&caller, false, policy, now)
                .map(|(_, messages)| messages)
                .unwrap_or_default()
        })
    };
    let first = offer(worker.clone()).await;
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].offers, 1);
    let second = offer(worker.clone()).await;
    assert_eq!(second[0].offers, 2);
    let acked = served
        .broker({
            let worker = worker.clone();
            move |broker, policy, now| {
                broker
                    .acknowledge_for_caller(&worker, false, u64::MAX, policy, now)
                    .map(|(_, messages)| messages.len())
            }
        })
        .await;
    assert_eq!(acked, Some(1));
    assert_eq!(pending(&served, "worker-1").await, 0);
    assert!(offer(worker).await.is_empty());
}

#[tokio::test]
async fn refuses_queue_overflow_instead_of_dropping_an_older_message() {
    let served = Served::new("overflow", |_| {});
    start_swarm(&served, 1).await;
    assert!(bind(&served, "worker-1", &worker_chat(1)).await);
    let prime = Caller::conversation(&prime_chat());
    let result = served
        .broker(move |broker, policy, now| {
            for index in 0..200 {
                let item = MessageItem {
                    to: "worker-1".into(),
                    text: format!("message {index}"),
                    label: None,
                };
                broker
                    .stage_messages(&prime, &[item], policy, now)
                    .expect("queued");
            }
            let item = MessageItem {
                to: "worker-1".into(),
                text: "one too many".into(),
                label: None,
            };
            broker.stage_messages(&prime, &[item], policy, now)
        })
        .await;
    let Err(AgentError::Refused(text)) = result else {
        panic!("overflow is refused");
    };
    assert!(text.starts_with("QUEUE_FULL: worker-1 already has 200 unacknowledged messages"));
    assert_eq!(pending(&served, "worker-1").await, 200);
}

#[tokio::test]
async fn a_finish_sleeps_the_worker_reports_once_and_a_repeat_changes_nothing() {
    let served = Served::new("finish", |config| config.multi_agent.max_workers = 3);
    start_swarm(&served, 2).await;
    assert!(bind(&served, "worker-1", &worker_chat(1)).await);
    let first = served
        .call_from(
            Some(&worker_chat(1)),
            json!({ "action": "finish", "result": "part one done" }),
        )
        .await;
    assert_eq!(
        first["structuredContent"],
        json!({ "action": "finish", "self": "worker-1", "state": "sleeping", "repeat": false })
    );
    assert!(
        Served::text(&first)
            .starts_with("worker-1 reported and is now asleep but remains reusable.")
    );
    let again = served
        .call_from(
            Some(&worker_chat(1)),
            json!({ "action": "finish", "result": "described differently" }),
        )
        .await;
    assert_eq!(again["structuredContent"]["repeat"], true);
    assert_eq!(pending(&served, PRIME_ID).await, 1);
    let report = served
        .broker(|broker, policy, now| {
            broker
                .offer_for_caller(&Caller::conversation(&prime_chat()), false, policy, now)
                .map(|(_, messages)| messages)
                .unwrap_or_default()
        })
        .await;
    assert_eq!(
        report[0].text,
        "[worker-1 reported] part one done\n(worker-1 sleeping; 2 of 3 worker slots are free. Reuse first: agents action=message to=\"worker-1\". Spawn only when no sleeping worker is suitable or more parallel capacity is needed.)"
    );
    let prime_finish = served
        .call_from(
            Some(&prime_chat()),
            json!({ "action": "finish", "result": "I am done" }),
        )
        .await;
    assert!(Served::text(&prime_finish).starts_with("The prime agent does not finish"));
}

#[tokio::test]
async fn ends_for_good_only_once_its_own_chat_is_full_and_then_parks_the_run() {
    let served = Served::new("ceiling", |_| {});
    start_swarm(&served, 1).await;
    assert!(bind(&served, "worker-1", &worker_chat(1)).await);
    fill_context(&served, &worker_chat(1)).await;
    let finished = served
        .call_from(
            Some(&worker_chat(1)),
            json!({ "action": "finish", "result": "finished safely" }),
        )
        .await;
    assert_eq!(finished["structuredContent"]["state"], "finished");
    let refused = served
        .call_from(
            Some(&prime_chat()),
            json!({ "action": "message", "to": "worker-1", "text": "one more thing" }),
        )
        .await;
    assert!(Served::text(&refused).starts_with("worker-1 is finished for good"));
    let parked = served
        .broker(|broker, _, now| {
            broker.release_quiescent_run(None, "no worker is currently running", now)
        })
        .await;
    assert!(parked);
    let state = served
        .agents
        .read(|broker, policy| broker.swarm_state(policy))
        .await;
    assert!(!state.running);
    assert_eq!(state.retained_history, Some(true));
    let status = served
        .call_from(Some(&prime_chat()), json!({ "action": "status" }))
        .await;
    assert_eq!(status["structuredContent"]["run_id"], Value::Null);
    assert_eq!(status["structuredContent"]["self"], "prime");
}

#[tokio::test]
async fn wakes_a_sleeping_worker_in_its_own_chat_and_holds_its_slot_while_waking() {
    let served = Served::new("wake", |config| config.multi_agent.max_workers = 1);
    start_swarm(&served, 1).await;
    assert!(bind(&served, "worker-1", &worker_chat(1)).await);
    served
        .call_from(
            Some(&worker_chat(1)),
            json!({ "action": "finish", "result": "done" }),
        )
        .await;
    let wake = served
        .call_from(
            Some(&prime_chat()),
            json!({ "action": "message", "to": "worker-1", "text": "one more thing" }),
        )
        .await;
    assert_eq!(
        Served::text(&wake),
        "Queued for worker-1. Waking worker-1 in the same chat."
    );
    assert_eq!(state_of(&served, "worker-1").await, AgentState::Waking);
    let revivals = served.tabs.revivals.lock().unwrap().clone();
    assert_eq!(revivals.len(), 1);
    assert_eq!(revivals[0].conversation_id, worker_chat(1));
    assert!(
        revivals[0]
            .text
            .starts_with("one more thing\n\n(Chat On Steroids: you are still worker-1")
    );
    let second = served
        .call_from(
            Some(&prime_chat()),
            json!({ "action": "message", "to": "worker-1", "text": "and another" }),
        )
        .await;
    assert!(
        Served::text(&second).starts_with("REVIVE_IN_PROGRESS: worker-1 is being woken right now.")
    );
    let spawn = served
        .call_from(
            Some(&prime_chat()),
            json!({ "action": "spawn", "workers": [{ "task": "parallel" }] }),
        )
        .await;
    assert_eq!(
        Served::text(&spawn),
        "That would make 2 live workers; the limit set in the app is 1."
    );
}

#[tokio::test]
async fn gives_the_slot_back_when_the_browser_cannot_wake_and_ends_after_two_failures() {
    let served = Served::new("wake-fail", |_| {});
    start_swarm(&served, 1).await;
    assert!(bind(&served, "worker-1", &worker_chat(1)).await);
    served
        .call_from(
            Some(&worker_chat(1)),
            json!({ "action": "finish", "result": "done" }),
        )
        .await;
    for _ in 0..2 {
        served
            .call_from(
                Some(&prime_chat()),
                json!({ "action": "message", "to": "worker-1", "text": "again" }),
            )
            .await;
    }
    let first = served
        .broker(|broker, _, now| {
            broker.fail_worker_revival("worker-1", "the tab did not load.", None, now)
        })
        .await
        .expect("report");
    assert!(
        first
            .text
            .starts_with("[worker-1 could not be woken] the tab did not load.")
    );
    assert_eq!(state_of(&served, "worker-1").await, AgentState::Sleeping);
    served
        .call_from(
            Some(&prime_chat()),
            json!({ "action": "message", "to": "worker-1", "text": "once more" }),
        )
        .await;
    let second = served
        .broker(|broker, _, now| {
            broker.fail_worker_revival("worker-1", "still nothing.", None, now)
        })
        .await
        .expect("report");
    assert!(
        second
            .text
            .starts_with("[worker-1 failed] Its chat did not answer 2 revivals in a row")
    );
    assert_eq!(state_of(&served, "worker-1").await, AgentState::Failed);
}

#[tokio::test]
async fn binding_is_set_once_and_one_conversation_holds_one_slot() {
    let served = Served::new("binding", |_| {});
    start_swarm(&served, 2).await;
    assert!(bind(&served, "worker-1", &worker_chat(1)).await);
    assert!(
        bind(&served, "worker-1", &worker_chat(1)).await,
        "the same binding again is a no-op"
    );
    assert!(
        !bind(&served, "worker-1", &worker_chat(3)).await,
        "a bound worker never moves"
    );
    assert!(
        !bind(&served, "worker-2", &worker_chat(1)).await,
        "a chat holds one slot"
    );
    assert!(
        !bind(&served, "worker-2", &prime_chat()).await,
        "the prime chat is taken"
    );
    assert_eq!(state_of(&served, "worker-1").await, AgentState::Active);
    assert_eq!(state_of(&served, "worker-2").await, AgentState::Invited);
}

#[tokio::test]
async fn carries_the_run_its_bindings_and_its_in_flight_messages_through_a_restart() {
    let served = Served::new("restart", |_| {});
    start_swarm(&served, 2).await;
    assert!(bind(&served, "worker-1", &worker_chat(1)).await);
    served
        .call_from(
            Some(&prime_chat()),
            json!({ "action": "message", "to": "worker-1", "text": "in flight" }),
        )
        .await;
    served
        .broker(|broker, policy, now| {
            broker.offer_for_caller(&Caller::conversation(&worker_chat(1)), false, policy, now)
        })
        .await;
    served.agents.flush();
    let before = served
        .agents
        .read(|broker, policy| broker.swarm_state(policy))
        .await;
    let run = served.profile.parent().expect("run folder").to_owned();
    drop(served);

    let restarted = Served::at(run, |_| {});
    restarted.agents.restore().await;
    let after = restarted
        .agents
        .read(|broker, policy| broker.swarm_state(policy))
        .await;
    let ids =
        |state: &cos_types::session::SwarmState| -> Vec<(String, AgentState, Option<String>)> {
            state
                .agents
                .iter()
                .map(|agent| (agent.id.clone(), agent.state, agent.conversation_id.clone()))
                .collect()
        };
    assert_eq!(ids(&after), ids(&before));
    // The offered message comes back unoffered: nobody can know whether that result arrived.
    let worker = after
        .agents
        .iter()
        .find(|agent| agent.id == "worker-1")
        .expect("worker-1");
    assert_eq!((worker.pending, worker.awaiting_ack), (1, 0));
    // The unbound worker still owes a tab, and is asked for again.
    let owed: Vec<String> = restarted
        .tabs
        .spawns
        .lock()
        .unwrap()
        .iter()
        .map(|spawn| spawn.id.clone())
        .collect();
    assert_eq!(owed, ["worker-2"]);
}

#[tokio::test]
async fn repairs_a_legacy_bound_but_invited_snapshot_and_a_revivable_finished_row() {
    let served = Served::new("repair", |_| {});
    let run_id = "0b9e7c2a-5f4d-4c1b-8a9e-112233445566";
    let info = |id: &str,
                role: &str,
                state: &str,
                conversation: Option<String>,
                revivable: bool| {
        json!({
            "id": id, "role": role, "label": id, "task": "t", "reasoningEffort": "sideways", "model": "gpt 5",
            "state": state, "createdAt": 1, "activatedAt": null, "finishedAt": null, "result": null,
            "pending": 0, "awaitingAck": 0, "delivered": 0, "conversationId": conversation,
            "detachedAt": null, "lastSeenAt": null, "revivable": revivable, "sleptAt": null, "contextTokens": 0
        })
    };
    let snapshot = json!({
        "version": 7, "savedAt": 1_767_225_600_000u64, "runId": run_id, "primeConversationId": prime_chat(),
        "startedAt": 1, "agents": [],
        "activeRuns": [{
            "runId": run_id, "primeConversationId": prime_chat(), "startedAt": 1,
            "agents": [
                { "info": info("prime", "prime", "active", Some(prime_chat()), false), "queue": [] },
                { "info": info("worker-1", "worker", "invited", Some(worker_chat(1)), false), "queue": [] },
                { "info": info("worker-2", "worker", "finished", Some(worker_chat(2)), true), "queue": [] }
            ]
        }],
        "dormantRuns": []
    });
    std::fs::write(
        served.profile.join("state/swarm.json"),
        serde_json::to_string(&snapshot).expect("json"),
    )
    .expect("written");
    served.agents.restore().await;
    let state = served
        .agents
        .read(|broker, policy| broker.swarm_state(policy))
        .await;
    let worker = |id: &str| {
        state
            .agents
            .iter()
            .find(|agent| agent.id == id)
            .expect("agent")
            .clone()
    };
    assert_eq!(worker("worker-1").state, AgentState::Active);
    assert_eq!(worker("worker-1").activated_at, Some(1_767_225_600_000));
    assert!(!worker("worker-2").revivable);
    assert_eq!(
        worker("worker-1").model,
        None,
        "a malformed model is repaired to the default"
    );
    assert_eq!(worker("worker-1").reasoning_effort, None);
    // The repaired projection was written back.
    let file = served.swarm_file().expect("swarm.json");
    assert_eq!(
        file["activeRuns"][0]["agents"][1]["info"]["state"],
        "active"
    );
}

#[tokio::test]
async fn re_keys_a_pre_uuid_version_4_snapshot() {
    let served = Served::new("rekey", |_| {});
    let snapshot = json!({
        "version": 4, "savedAt": 1_767_225_600_000u64, "runId": "a1b2c3d4", "primeConversationId": prime_chat(),
        "startedAt": 1,
        "agents": [
            { "info": { "id": "prime", "role": "prime", "label": "Prime", "task": "Coordinates the workers",
                "reasoningEffort": null, "model": null, "state": "active", "createdAt": 1, "activatedAt": 1,
                "finishedAt": null, "result": null, "pending": 0, "awaitingAck": 0, "delivered": 0,
                "conversationId": prime_chat(), "detachedAt": null, "lastSeenAt": 1, "revivable": false,
                "sleptAt": null, "contextTokens": 0 }, "queue": [] },
            { "info": { "id": "worker-1", "role": "worker", "label": "w", "task": "t",
                "reasoningEffort": null, "model": null, "state": "active", "createdAt": 1, "activatedAt": 1,
                "finishedAt": null, "result": null, "pending": 0, "awaitingAck": 0, "delivered": 0,
                "conversationId": worker_chat(1), "detachedAt": null, "lastSeenAt": 1, "revivable": false,
                "sleptAt": null, "contextTokens": 0 }, "queue": [] }
        ]
    });
    std::fs::write(
        served.profile.join("state/swarm.json"),
        serde_json::to_string(&snapshot).expect("json"),
    )
    .expect("written");
    served.agents.restore().await;
    let runs = served
        .agents
        .read(|broker, policy| broker.swarm_state(policy).agents[0].run_id.clone())
        .await
        .expect("a run");
    assert_ne!(runs, "a1b2c3d4");
    assert_eq!(&runs[14..15], "4");
}

#[tokio::test]
async fn rolls_back_a_spawn_whose_durable_acceptance_barrier_fails() {
    let served = Served::new("barrier", |_| {});
    // A folder where the ledger's file belongs makes every write of it fail.
    std::fs::create_dir_all(served.profile.join("state/swarm.json")).expect("blocker");
    let result = start_swarm_raw(&served).await;
    assert_eq!(result["isError"], true);
    assert!(Served::text(&result).starts_with(
        "The worker run could not cross its durable acceptance barrier. The spawn was rolled back; retry this same request. ("
    ));
    assert!(
        served.tabs.spawns.lock().unwrap().is_empty(),
        "no tab for an unaccepted run"
    );
    std::fs::remove_dir_all(served.profile.join("state/swarm.json")).expect("unblocked");
    let retry = start_swarm_raw(&served).await;
    assert_eq!(
        retry["structuredContent"]["became_prime"], true,
        "the failed spawn left no run"
    );
}

async fn start_swarm_raw(served: &Served) -> Value {
    served
        .call_from(
            Some(&prime_chat()),
            json!({ "action": "spawn", "workers": [{ "task": "t" }] }),
        )
        .await
}

#[tokio::test]
async fn pausing_for_disable_keeps_bound_workers_reusable_and_fails_unopened_ones() {
    let served = Served::new("disable", |_| {});
    start_swarm(&served, 2).await;
    assert!(bind(&served, "worker-1", &worker_chat(1)).await);
    served
        .broker(|broker, _, now| broker.pause_for_disable("multi-agent mode was turned off", now))
        .await;
    let state = served
        .agents
        .read(|broker, policy| broker.swarm_state(policy))
        .await;
    assert!(!state.running);
    let retained = state.retained_workers.unwrap_or_default();
    let worker = |id: &str| {
        retained
            .iter()
            .find(|agent| agent.id == id)
            .expect("agent")
            .clone()
    };
    assert_eq!(worker("worker-1").state, AgentState::Sleeping);
    assert!(worker("worker-1").revivable);
    assert_eq!(worker("worker-2").state, AgentState::Failed);
    assert_eq!(
        worker("worker-2").result.as_deref(),
        Some("multi-agent mode was turned off")
    );
}

#[tokio::test]
async fn clearing_the_prime_ends_the_run_and_fences_its_worker_chats() {
    let served = Served::new("clear", |_| {});
    start_swarm(&served, 1).await;
    assert!(bind(&served, "worker-1", &worker_chat(1)).await);
    served
        .broker(|broker, _, now| broker.clear_agent(PRIME_ID, None, now))
        .await;
    let fenced = served
        .broker(|broker, _, now| broker.retired_worker_for_conversation(&worker_chat(1), now))
        .await;
    assert_eq!(
        fenced.map(|worker| worker.reason),
        Some("the run was cleared in the app".to_owned())
    );
    let spawn = served
        .call_from(
            Some(&worker_chat(1)),
            json!({ "action": "spawn", "workers": [{ "task": "t" }] }),
        )
        .await;
    assert_eq!(
        Served::text(&spawn),
        "WORKTREE_OWNER_UNAVAILABLE: retired worker conversations cannot create new prime runs or workers."
    );
}

#[tokio::test]
async fn recovers_live_managed_checkouts_and_offers_cleanup_only_for_a_terminal_one() {
    let served = Served::new("managed", |_| {});
    let spawn = start_swarm(&served, 2).await;
    let run_id = spawn["structuredContent"]["run_id"]
        .as_str()
        .expect("run")
        .to_owned();
    let marked = run_id.clone();
    served
        .agents
        .accept("mark", move |broker, _, _| {
            broker.mark_worker_worktree(&marked, "worker-1")?;
            broker.mark_worker_worktree(&marked, "worker-2")
        })
        .await
        .expect("marked");
    assert!(bind(&served, "worker-1", &worker_chat(1)).await);
    assert!(bind(&served, "worker-2", &worker_chat(2)).await);
    let identities = served
        .agents
        .read(|broker, _| broker.managed_recovery_identities())
        .await;
    assert_eq!(
        identities,
        [
            (run_id.clone(), "worker-1".to_owned()),
            (run_id.clone(), "worker-2".to_owned())
        ]
    );
    fill_context(&served, &worker_chat(2)).await;
    served
        .call_from(
            Some(&worker_chat(2)),
            json!({ "action": "finish", "result": "Write the docs\nand more" }),
        )
        .await;
    let identities = served
        .agents
        .read(|broker, _| broker.managed_recovery_identities())
        .await;
    assert_eq!(identities, [(run_id.clone(), "worker-1".to_owned())]);
    let file = served.swarm_file().expect("swarm.json");
    let offers = &file["managedWorktreeCleanupOffers"];
    assert_eq!(offers.as_array().map(Vec::len), Some(1), "{file}");
    assert_eq!(offers[0]["agentId"], "worker-2");
    assert_eq!(offers[0]["reason"], "completed");
    assert_eq!(offers[0]["label"], "Worker 2");
}

#[tokio::test]
async fn publishes_worker_ownership_through_active_sleeping_and_parked_states() {
    let served = Served::new("ownership", |_| {});
    start_swarm(&served, 1).await;
    assert!(!served.agents.ownership().is_worker(&worker_chat(1)));
    assert!(bind(&served, "worker-1", &worker_chat(1)).await);
    let owner = served.agents.ownership().prime_owner(&worker_chat(1));
    assert!(owner.owned);
    assert_eq!(owner.prime_conversation_id, Some(prime_chat()));
    fill_context(&served, &worker_chat(1)).await;
    served
        .call_from(
            Some(&worker_chat(1)),
            json!({ "action": "finish", "result": "done" }),
        )
        .await;
    served
        .broker(|broker, _, now| {
            broker.release_quiescent_run(None, "no worker is currently running", now)
        })
        .await;
    let parked = served.agents.ownership();
    assert!(
        parked.is_worker(&worker_chat(1)),
        "a finished, parked worker is still a worker chat"
    );
    assert_eq!(
        parked.prime_owner(&worker_chat(1)).prime_conversation_id,
        Some(prime_chat())
    );
    assert!(!parked.is_worker(&prime_chat()));
    assert_eq!(parked.prime_owner(&conversation(9)), Default::default());
}
