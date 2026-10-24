//! The durable command ledger through its routes and its file. Cases from the command tests of
//! `test/bridge.test.ts` that need no agent broker or continuation.

mod support;

use serde_json::{Value, json};
use support::{CHAT, START, World};

async fn running_chat(world: &World) -> String {
    world.idle_chat(CHAT, START - 9_000).await;
    world
        .page(
            CHAT,
            json!([
                { "kind": "user_message", "messageId": "m-u1", "text": "Long job", "time": START - 8_000, "authoredNow": true },
                { "kind": "turn_start", "turnId": "t1", "time": START - 7_900 }
            ]),
        )
        .await
}

async fn post(world: &World, route: &str, body: Value) -> (u16, Value) {
    let answer = world.commands.answer(route, &body).await;
    (answer.status, answer.body)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_is_leased_by_one_page_and_its_receipt_answers_a_lost_ack() {
    let world = World::new("stop").await;
    let session = running_chat(&world).await;
    let wakes = world.wakes();
    let id = world
        .commands
        .queue_stop(&session, "t1")
        .await
        .expect("queued");
    assert!(world.wakes() > wakes);
    assert_eq!(
        world.command_ledger()["commands"][0]["phase"],
        "leased",
        "status never hands out an unsaved stop"
    );
    let stops = world.commands.pending_stops().await;
    assert_eq!(
        stops,
        vec![
            json!({ "id": id, "conversationId": CHAT, "turnId": "t1", "expiresAt": START + 120_000 })
        ]
    );
    assert_eq!(
        world
            .commands
            .queue_stop(&session, "t1")
            .await
            .expect("again"),
        id,
        "one stop per turn"
    );

    let (status, redeemed) = post(
        &world,
        "/commands/redeem",
        json!({ "id": id, "client": "doc-1", "conversationId": CHAT }),
    )
    .await;
    assert_eq!(status, 200, "{redeemed}");
    assert_eq!(redeemed["command"]["kind"], "stop-turn");
    assert_eq!(redeemed["command"]["type"], "stop");
    assert_eq!(redeemed["command"]["turnId"], "t1");
    assert_eq!(redeemed["command"]["userMessageId"], "m-u1");
    assert_eq!(redeemed["command"]["text"], "");
    assert_eq!(
        post(
            &world,
            "/commands/redeem",
            json!({ "id": id, "client": "doc-2", "conversationId": CHAT })
        )
        .await,
        (409, json!({ "error": "stop_not_owned" }))
    );
    assert_eq!(
        post(
            &world,
            "/commands/step",
            json!({ "id": id, "client": "doc-1", "step": "sending" })
        )
        .await,
        (200, json!({ "ok": true }))
    );
    assert_eq!(
        post(
            &world,
            "/commands/step",
            json!({ "id": id, "client": "doc-2", "step": "sending" })
        )
        .await,
        (200, json!({ "ok": false }))
    );
    assert_eq!(
        post(
            &world,
            "/commands/ack",
            json!({ "id": id, "client": "doc-1", "conversationId": CHAT, "turnId": "other" })
        )
        .await,
        (409, json!({ "error": "stop_identity_changed" }))
    );
    let receipt = json!({ "ok": true, "final": true, "committed": true, "outcome": "committed",
        "conversationId": CHAT, "error": null });
    let ack = json!({ "id": id, "client": "doc-1", "conversationId": CHAT, "turnId": "t1", "status": "sent" });
    assert_eq!(
        post(&world, "/commands/ack", ack.clone()).await,
        (200, receipt.clone())
    );
    let ledger = world.command_ledger();
    assert_eq!(ledger["commands"], json!([]));
    assert_eq!(ledger["receipts"][0]["id"], id.as_str());

    let world = world.restart().await;
    assert_eq!(
        post(&world, "/commands/ack", ack).await,
        (200, receipt),
        "the receipt answers a repeated ACK, across restart"
    );
    assert_eq!(
        post(
            &world,
            "/commands/ack",
            json!({ "id": id, "client": "doc-2", "conversationId": CHAT, "turnId": "t1" })
        )
        .await,
        (409, json!({ "error": "receipt_client_changed" }))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_for_a_turn_that_ended_is_retired_and_cannot_be_redeemed() {
    let world = World::new("stop-ended").await;
    let session = running_chat(&world).await;
    let id = world
        .commands
        .queue_stop(&session, "t1")
        .await
        .expect("queued");
    world
        .page(
            CHAT,
            json!([{ "kind": "turn_end", "turnId": "t1", "outcome": "stopped", "time": START - 7_000 }]),
        )
        .await;
    assert_eq!(
        post(
            &world,
            "/commands/redeem",
            json!({ "id": id, "client": "doc", "conversationId": CHAT })
        )
        .await,
        (409, json!({ "error": "stop_turn_changed" }))
    );
    assert!(world.commands.pending_stops().await.is_empty());
    assert_eq!(
        post(
            &world,
            "/commands/redeem",
            json!({ "id": id, "client": "doc", "conversationId": CHAT })
        )
        .await,
        (404, json!({ "error": "no_such_command" }))
    );
    assert_eq!(
        world.commands.queue_stop(&session, "t1").await,
        Err("active_turn_changed".to_owned())
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_keeps_only_what_still_has_an_owner_and_rewrites_version_4() {
    let world = World::new("restore").await;
    let session = running_chat(&world).await;
    let stop = |id: &str, created: u64| {
        json!({ "id": id, "spec": { "type": "stop", "sessionId": session, "conversationId": CHAT, "turnId": "t1" },
            "createdAt": created, "phase": "leased", "claimedAt": created, "owner": "doc-9", "lastError": null })
    };
    let saved = json!({
        "version": 4,
        "commands": [
            stop("fresh-stop", START - 1_000),
            { "id": "old-stop", "spec": { "type": "stop", "sessionId": session, "conversationId": CHAT, "turnId": "t0" },
              "createdAt": START - 31 * 60_000, "phase": "queued", "claimedAt": null, "owner": null, "lastError": null },
            { "id": "worker", "spec": { "type": "worker", "agent": "w1", "task": "Do it", "model": null,
              "reasoningEffort": null, "runId": "run-1" }, "createdAt": START - 1_000, "phase": "queued",
              "claimedAt": null, "owner": null, "lastError": null },
            { "id": "resume", "spec": { "type": "resume", "sessionId": session, "token": "tok" },
              "createdAt": START - 1_000, "phase": "queued", "claimedAt": null, "owner": null, "lastError": null }
        ],
        "receipts": [
            { "id": "kept", "client": "doc", "conversationId": CHAT, "outcome": "committed", "committed": true,
              "error": null, "completedAt": START - 60_000 },
            { "id": "expired", "client": "doc", "conversationId": CHAT, "outcome": "committed", "committed": true,
              "error": null, "completedAt": START - 31 * 60_000 },
            { "id": "inconsistent", "client": "doc", "conversationId": CHAT, "outcome": "committed", "committed": false,
              "error": null, "completedAt": START - 60_000 }
        ]
    });
    std::fs::create_dir_all(world.dir.join("state")).expect("state");
    std::fs::write(
        world.dir.join("state").join("bridge-commands.json"),
        serde_json::to_vec(&saved).expect("json"),
    )
    .expect("seed");
    let world = world.restart().await;
    let ledger = world.command_ledger();
    assert_eq!(ledger["version"], 4);
    let ids: Vec<&str> = ledger["commands"]
        .as_array()
        .expect("commands")
        .iter()
        .filter_map(|command| command["id"].as_str())
        .collect();
    assert_eq!(ids, ["fresh-stop"]);
    assert_eq!(
        ledger["commands"][0]["owner"], "doc-9",
        "the lease survives"
    );
    let receipts: Vec<&str> = ledger["receipts"]
        .as_array()
        .expect("receipts")
        .iter()
        .filter_map(|receipt| receipt["id"].as_str())
        .collect();
    assert_eq!(receipts, ["kept"]);
    assert_eq!(world.commands.ids().await, ["fresh-stop"]);
    assert_eq!(
        post(
            &world,
            "/commands/redeem",
            json!({ "id": "fresh-stop", "client": "doc-other", "conversationId": CHAT })
        )
        .await,
        (409, json!({ "error": "stop_not_owned" }))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_command_routes_refuse_what_bridge_ts_refuses() {
    let world = World::new("command-routes").await;
    assert_eq!(
        post(&world, "/commands/revivals/pending", json!({})).await,
        (400, json!({ "error": "bad_revival_entries" }))
    );
    let many: Vec<Value> = (0..101)
        .map(|n| json!({ "id": format!("c{n}"), "conversationId": CHAT }))
        .collect();
    assert_eq!(
        post(
            &world,
            "/commands/revivals/pending",
            json!({ "entries": many })
        )
        .await,
        (400, json!({ "error": "bad_revival_entries" }))
    );
    assert_eq!(
        post(
            &world,
            "/commands/revivals/pending",
            json!({ "entries": [{ "id": "c1", "conversationId": CHAT }] })
        )
        .await,
        (200, json!({ "pending": [] }))
    );
    assert_eq!(
        post(
            &world,
            "/commands/redeem",
            json!({ "id": "nothing", "client": "doc", "conversationId": "x" })
        )
        .await,
        (400, json!({ "error": "bad_conversation_id" }))
    );
    assert_eq!(
        post(
            &world,
            "/commands/redeem",
            json!({ "id": "nothing", "client": "doc" })
        )
        .await,
        (404, json!({ "error": "no_such_command" }))
    );
    assert_eq!(
        post(
            &world,
            "/commands/step",
            json!({ "id": "nothing", "step": "sending" })
        )
        .await,
        (200, json!({ "ok": false }))
    );
    assert_eq!(
        post(
            &world,
            "/commands/ack",
            json!({ "id": "nothing", "client": "doc" })
        )
        .await,
        (404, json!({ "error": "no_such_command" }))
    );
    assert_eq!(
        post(&world, "/commands/ack", json!({ "id": "nothing" })).await,
        (200, json!({ "ok": true })),
        "a legacy page without a document id gets the old idempotent answer"
    );
}
