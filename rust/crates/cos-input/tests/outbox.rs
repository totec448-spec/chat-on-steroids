//! The outbox through what its callers see: the rows it answers, the bridge answers, the ledger
//! on disk and the chat's session. Cases from `test/session-input.test.ts` and the input routes
//! of `test/bridge.test.ts`.

mod support;

use cos_input::{DeliveryProof, delivery_proof};
use cos_types::state::{InputEntry, InputState, TransportIntent};
use serde_json::{Value, json};
use support::{CHAT, OTHER, START, World, read_json, row as ledger_row, uuid};

async fn claim(world: &World, id: &str, owner: &str, conversation: Value) -> Value {
    let answer = world
        .outbox
        .answer(
            "/input/claim",
            &json!({ "id": id, "owner": owner, "conversationId": conversation, "requiresAuthorization": true }),
        )
        .await;
    assert_eq!(answer.status, 200, "{:?}", answer.body);
    answer.body["input"].clone()
}

async fn authorize(world: &World, id: &str, owner: &str) -> bool {
    let answer = world
        .outbox
        .answer(
            "/input/claim",
            &json!({ "id": id, "owner": owner, "conversationId": CHAT, "authorize": true }),
        )
        .await;
    answer.body["ok"] == true
}

async fn ack(world: &World, id: &str, owner: &str, message: &str) -> Value {
    world
        .outbox
        .answer(
            "/input/ack",
            &json!({ "id": id, "owner": owner, "conversationId": CHAT, "messageId": message }),
        )
        .await
        .body
}

async fn fail(world: &World, id: &str, owner: &str, error: &str) -> bool {
    world
        .outbox
        .answer(
            "/input/fail",
            &json!({ "id": id, "owner": owner, "error": error }),
        )
        .await
        .body["ok"]
        == true
}

async fn listed(world: &World, id: &str) -> InputEntry {
    world
        .outbox
        .list()
        .await
        .expect("list")
        .into_iter()
        .find(|row| row.id == id)
        .expect("row")
}

async fn offered(world: &World) -> Vec<String> {
    world
        .outbox
        .pending()
        .await
        .expect("pending")
        .iter()
        .map(|offer| offer["id"].as_str().unwrap_or_default().to_owned())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_message_for_an_idle_chat_is_claimed_authorized_acknowledged_and_recorded() {
    let world = World::new("lifecycle").await;
    let session = world.idle_chat(CHAT, START - 5_000).await;
    let wakes = world.wakes();
    let row = world
        .outbox
        .enqueue(&world.args(Some(&session), "  Read one file  "))
        .await
        .expect("enqueued");
    assert_eq!(row.text, "Read one file");
    assert_eq!(row.state, InputState::Queued);
    assert_eq!(row.transport_intent, Some(TransportIntent::Browser));
    assert_eq!(row.conversation_id.as_deref(), Some(CHAT));
    assert!(world.wakes() > wakes, "queuing wakes the extension");
    assert_eq!(
        ledger_row(&world.ledger(), &row.id)["state"],
        "queued",
        "on disk before the answer"
    );

    let offers = world.outbox.pending().await.expect("pending");
    assert_eq!(
        offers,
        vec![json!({ "id": row.id, "conversationId": CHAT })]
    );

    let claimed = claim(&world, &row.id, "page-1", json!(CHAT)).await;
    assert_eq!(claimed["owner"], "page-1");
    assert_eq!(claimed["state"], "browser");
    assert_eq!(claimed["text"], "Read one file");
    assert_eq!(claimed["model"], Value::Null);
    let on_disk = ledger_row(&world.ledger(), &row.id).clone();
    assert_eq!(
        on_disk["owner"], "page-1",
        "the claim is durable before the page has it"
    );
    // The turn ended before this message existed, so the claim spends no completion.
    assert_eq!(on_disk["completedTurnId"], Value::Null);
    assert_eq!(on_disk["deliveryText"], "Read one file");

    assert!(authorize(&world, &row.id, "page-1").await);
    assert!(
        !authorize(&world, &row.id, "page-1").await,
        "Send is granted once"
    );
    let receipt = ack(&world, &row.id, "page-1", "native-1").await;
    assert_eq!(receipt, json!({ "ok": true }));
    let sent = listed(&world, &row.id).await;
    assert_eq!(sent.state, InputState::Sent);
    assert_eq!(sent.message_id.as_deref(), Some("native-1"));
    assert_eq!(sent.history_recorded, Some(true));
    assert_eq!(delivery_proof(&sent), DeliveryProof::Sent);
    world.sessions.flush().await;
    let recorded = world
        .messages(&session)
        .into_iter()
        .find(|message| message["inputId"] == row.id.as_str())
        .expect("the sent message is in its chat");
    assert_eq!(recorded["kind"], "user_message");
    assert_eq!(recorded["source"], "app");
    assert_eq!(recorded["messageId"], "native-1");
    assert_eq!(recorded["inputDelivery"], "confirmed");
    assert_eq!(recorded["message"]["text"], "Read one file");
    assert!(offered(&world).await.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_same_id_answers_the_same_row_and_changed_input_is_refused() {
    let world = World::new("idempotent").await;
    let session = world.idle_chat(CHAT, START - 5_000).await;
    let args = world.args(Some(&session), "Same words");
    let first = world.outbox.enqueue(&args).await.expect("first");
    let again = world.outbox.enqueue(&args).await.expect("again");
    assert_eq!(first, again);
    let mut changed = args.clone();
    changed["text"] = json!("Other words");
    assert_eq!(
        world.outbox.enqueue(&changed).await.expect_err("changed").0,
        "Message id already belongs to different input"
    );
    let mut second = args.clone();
    second["id"] = json!(uuid());
    assert_eq!(
        world.outbox.enqueue(&second).await.expect_err("second").0,
        "One message is already awaiting delivery. Cancel it before sending another."
    );
    assert_eq!(world.outbox.list().await.expect("list").len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_claim_never_authorized_is_offered_again_after_restart_and_only_its_new_owner_sends() {
    let world = World::new("reclaim").await;
    let session = world.idle_chat(CHAT, START - 5_000).await;
    let row = world
        .outbox
        .enqueue(&world.args(Some(&session), "Restart me"))
        .await
        .expect("enqueued");
    claim(&world, &row.id, "lost-page", json!(CHAT)).await;
    let world = world.restart().await;
    assert_eq!(
        offered(&world).await,
        vec![row.id.clone()],
        "a pre-Send claim is re-offered"
    );
    let replacement = claim(&world, &row.id, "replacement-page", json!(CHAT)).await;
    assert_eq!(replacement["owner"], "replacement-page");
    assert!(!authorize(&world, &row.id, "lost-page").await);
    assert!(authorize(&world, &row.id, "replacement-page").await);
    assert!(offered(&world).await.is_empty());
    assert_eq!(
        claim(&world, &row.id, "late-page", json!(CHAT)).await,
        Value::Null
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_authorized_claim_stays_inert_across_restart_and_its_late_receipt_still_lands() {
    let world = World::new("inert").await;
    let session = world.idle_chat(CHAT, START - 5_000).await;
    let row = world
        .outbox
        .enqueue(&world.args(Some(&session), "Clicked once"))
        .await
        .expect("enqueued");
    claim(&world, &row.id, "page", json!(CHAT)).await;
    assert!(authorize(&world, &row.id, "page").await);
    let world = world.restart().await;
    assert!(
        offered(&world).await.is_empty(),
        "an authorized Send is never offered again"
    );
    assert_eq!(
        claim(&world, &row.id, "other-page", json!(CHAT)).await,
        Value::Null
    );
    let held = listed(&world, &row.id).await;
    assert_eq!(held.state, InputState::Browser);
    assert_eq!(delivery_proof(&held), DeliveryProof::Unconfirmed);
    assert_eq!(
        ack(&world, &row.id, "page", "native-late").await,
        json!({ "ok": true })
    );
    assert_eq!(listed(&world, &row.id).await.state, InputState::Sent);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unconfirmed_send_is_released_after_fifteen_minutes_and_never_resent() {
    let world = World::new("uncertain").await;
    let session = world.idle_chat(CHAT, START - 5_000).await;
    let row = world
        .outbox
        .enqueue(&world.args(Some(&session), "Did it go?"))
        .await
        .expect("enqueued");
    claim(&world, &row.id, "page", json!(CHAT)).await;
    assert!(authorize(&world, &row.id, "page").await);
    world.advance(15 * 60_000);
    let released = listed(&world, &row.id).await;
    assert_eq!(released.state, InputState::Cancelled);
    assert!(
        released
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("will not be resent")
    );
    assert!(offered(&world).await.is_empty());
    let receipt = ack(&world, &row.id, "page", "native-very-late").await;
    assert_eq!(
        receipt,
        json!({ "ok": true }),
        "a late exact receipt still confirms it"
    );
    let confirmed = listed(&world, &row.id).await;
    assert_eq!(confirmed.state, InputState::Cancelled);
    assert_eq!(
        confirmed.error.as_deref(),
        Some("Cancelled locally; delivery was later confirmed in ChatGPT.")
    );
    assert_eq!(delivery_proof(&confirmed), DeliveryProof::Sent);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preparation_expires_after_a_minute_and_revokes_the_late_page() {
    let world = World::new("prepare").await;
    let session = world.idle_chat(CHAT, START - 5_000).await;
    let row = world
        .outbox
        .enqueue(&world.args(Some(&session), "Slow page"))
        .await
        .expect("enqueued");
    claim(&world, &row.id, "page", json!(CHAT)).await;
    world.advance(60_000);
    let expired = listed(&world, &row.id).await;
    assert_eq!(expired.state, InputState::Cancelled);
    assert!(
        expired
            .error
            .as_deref()
            .unwrap_or_default()
            .starts_with("Not sent")
    );
    assert_eq!(delivery_proof(&expired), DeliveryProof::NotSent);
    assert!(!authorize(&world, &row.id, "page").await);
    assert!(offered(&world).await.is_empty());
    world
        .outbox
        .enqueue(&world.args(Some(&session), "Next one"))
        .await
        .expect("the chat takes a new message");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_message_no_browser_picks_up_fails_after_sixty_seconds() {
    let world = World::new("pickup").await;
    let session = world.idle_chat(CHAT, START - 5_000).await;
    let row = world
        .outbox
        .enqueue(&world.args(Some(&session), "Anyone there?"))
        .await
        .expect("enqueued");
    world.advance(59_999);
    assert_eq!(listed(&world, &row.id).await.state, InputState::Queued);
    world.advance(2);
    let world = world.restart().await;
    let failed = listed(&world, &row.id).await;
    assert_eq!(failed.state, InputState::Failed);
    assert!(
        failed
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("did not pick up this message")
    );
    assert_eq!(failed.pickup_failed_at, Some(world.now()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_send_chatgpt_did_not_take_is_queued_once_more_then_reported() {
    let world = World::new("not-taken").await;
    let session = world.idle_chat(CHAT, START - 5_000).await;
    let row = world
        .outbox
        .enqueue(&world.args(Some(&session), "Take it"))
        .await
        .expect("enqueued");
    claim(&world, &row.id, "page", json!(CHAT)).await;
    assert!(authorize(&world, &row.id, "page").await);
    assert!(
        fail(
            &world,
            &row.id,
            "page",
            "Native Send did not take the message."
        )
        .await
    );
    let requeued = listed(&world, &row.id).await;
    assert_eq!(requeued.state, InputState::Queued);
    assert_eq!(requeued.owner, None);
    assert_eq!(requeued.not_taken_retries, Some(1));
    assert_eq!(requeued.send_authorized_at, None);
    assert_eq!(offered(&world).await, vec![row.id.clone()]);
    claim(&world, &row.id, "page", json!(CHAT)).await;
    assert!(authorize(&world, &row.id, "page").await);
    assert!(
        fail(
            &world,
            &row.id,
            "page",
            "Native Send did not take the message."
        )
        .await
    );
    let failed = listed(&world, &row.id).await;
    assert_eq!(failed.state, InputState::Failed);
    assert_eq!(
        failed.error.as_deref(),
        Some("Not sent: ChatGPT did not accept the message.")
    );
    assert!(offered(&world).await.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_click_whose_result_the_page_cannot_prove_is_never_replayed() {
    let world = World::new("unproven").await;
    let session = world.idle_chat(CHAT, START - 5_000).await;
    let row = world
        .outbox
        .enqueue(&world.args(Some(&session), "Maybe sent"))
        .await
        .expect("enqueued");
    claim(&world, &row.id, "page", json!(CHAT)).await;
    assert!(authorize(&world, &row.id, "page").await);
    assert!(
        fail(
            &world,
            &row.id,
            "page",
            "Native Send receipt was not confirmed."
        )
        .await
    );
    let cancelled = listed(&world, &row.id).await;
    assert_eq!(cancelled.state, InputState::Cancelled);
    assert_eq!(delivery_proof(&cancelled), DeliveryProof::Unconfirmed);
    assert!(offered(&world).await.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pre_send_failure_is_bounded_and_cancel_before_send_reports_not_sent() {
    let world = World::new("cancel").await;
    let session = world.idle_chat(CHAT, START - 5_000).await;
    let first = world
        .outbox
        .enqueue(&world.args(Some(&session), "Fails"))
        .await
        .expect("enqueued");
    claim(&world, &first.id, "page", json!(CHAT)).await;
    assert!(fail(&world, &first.id, "page", &"x".repeat(500)).await);
    let failed = listed(&world, &first.id).await;
    assert_eq!(failed.state, InputState::Failed);
    assert_eq!(failed.error.as_deref().map(str::len), Some(200));

    let second = world
        .outbox
        .enqueue(&world.args(Some(&session), "Withdrawn"))
        .await
        .expect("enqueued");
    claim(&world, &second.id, "page", json!(CHAT)).await;
    assert!(world.outbox.cancel(&second.id).await.expect("cancel"));
    let cancelled = listed(&world, &second.id).await;
    assert_eq!(
        cancelled.error.as_deref(),
        Some("Not sent: this delivery was cancelled before Send was authorized.")
    );
    assert_eq!(delivery_proof(&cancelled), DeliveryProof::NotSent);
    assert!(!authorize(&world, &second.id, "page").await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_follow_up_waits_for_the_running_turn_and_goes_after_it() {
    let world = World::new("after-turn").await;
    let session = world.idle_chat(CHAT, START - 9_000).await;
    world
        .page(
            CHAT,
            json!([
                { "kind": "user_message", "messageId": "m-u1", "text": "Go", "time": START - 8_000, "authoredNow": true },
                { "kind": "turn_start", "turnId": "t1", "time": START - 7_900 }
            ]),
        )
        .await;
    let mut args = world.args(Some(&session), "Then do this");
    args["mode"] = json!("after-turn");
    let row = world.outbox.enqueue(&args).await.expect("enqueued");
    assert_eq!(
        row.queued_turn.as_ref().map(|turn| turn.turn_id.as_str()),
        Some("t1")
    );
    assert!(
        offered(&world).await.is_empty(),
        "it waits while the turn runs"
    );
    assert_eq!(
        claim(&world, &row.id, "page", json!(CHAT)).await,
        Value::Null
    );
    world
        .page(
            CHAT,
            json!([
                { "kind": "assistant_message", "messageId": "m-a1", "turnId": "t1", "text": "Done", "state": "final", "final": true, "time": START - 7_000 },
                { "kind": "turn_end", "turnId": "t1", "outcome": "completed", "time": START - 6_900 }
            ]),
        )
        .await;
    assert_eq!(offered(&world).await, vec![row.id.clone()]);
    let claimed = claim(&world, &row.id, "page", json!(CHAT)).await;
    assert_eq!(claimed["completedTurnId"], "t1");
    // The queue's own wait never times out.
    world.advance(10 * 60_000);
    assert_ne!(listed(&world, &row.id).await.state, InputState::Failed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_correction_for_a_running_non_pro_turn_goes_through_the_composer() {
    let world = World::new("direct").await;
    world.idle_chat(CHAT, START - 9_000).await;
    let session = world
        .page(
            CHAT,
            json!([
                { "kind": "user_message", "messageId": "m-u1", "text": "Go", "time": START - 8_000, "authoredNow": true },
                { "kind": "turn_start", "turnId": "plain-turn", "time": START - 7_900 }
            ]),
        )
        .await;
    let row = world
        .outbox
        .enqueue(&world.args(Some(&session), "Actually, stop and do X"))
        .await
        .expect("enqueued");
    assert_eq!(row.transport_intent, Some(TransportIntent::Browser));
    let direct = row.direct_turn.clone().expect("joins the running turn");
    assert_eq!(direct.id, "plain-turn");
    assert_eq!(direct.started_at, START - 7_900);
    let offers = world.outbox.pending().await.expect("pending");
    assert_eq!(offers[0]["directTurn"]["id"], "plain-turn");
    let claimed = claim(&world, &row.id, "page", json!(CHAT)).await;
    assert_eq!(claimed["directTurn"]["id"], "plain-turn");
    assert!(authorize(&world, &row.id, "page").await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deleted_chat_ends_its_waiting_messages_and_leaves_others() {
    let world = World::new("deleted").await;
    let first = world.idle_chat(CHAT, START - 5_000).await;
    let second = world.idle_chat(OTHER, START - 5_000).await;
    let gone = world
        .outbox
        .enqueue(&world.args(Some(&first), "For the deleted chat"))
        .await
        .expect("enqueued");
    let kept = world
        .outbox
        .enqueue(&world.args(Some(&second), "For the other chat"))
        .await
        .expect("enqueued");
    let answer = world
        .outbox
        .deleted_answer(&json!({ "conversationId": CHAT }))
        .await;
    assert_eq!(answer.body, json!({ "ok": true, "ended": 1 }));
    let ended = listed(&world, &gone.id).await;
    assert_eq!(ended.state, InputState::Failed);
    assert_eq!(
        ended.error.as_deref(),
        Some(cos_input::CONVERSATION_DELETED)
    );
    assert_eq!(listed(&world, &kept.id).await.state, InputState::Queued);
    let refused = world
        .outbox
        .deleted_answer(&json!({ "conversationId": "nope" }))
        .await;
    assert_eq!(
        (refused.status, refused.body),
        (400, json!({ "error": "invalid_request" }))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_orphan_goal_helper_is_cancelled_on_restart_before_it_is_offered() {
    let world = World::new("orphan").await;
    std::fs::create_dir_all(world.dir.join("state")).expect("state");
    let helper = json!([{ "id": uuid(), "sessionId": null, "text": "Plan the next step", "mode": "after-turn",
        "dueAt": 0, "model": "gpt-6", "reasoningEffort": "high", "purpose": "decision", "state": "queued",
        "owner": null, "createdAt": START - 10, "conversationId": null }]);
    std::fs::write(
        world.dir.join("state").join("session-input.json"),
        serde_json::to_vec(&helper).expect("json"),
    )
    .expect("seed");
    let world = world.restart().await;
    assert!(offered(&world).await.is_empty());
    let rows = world.outbox.list().await.expect("list");
    assert_eq!(rows[0].state, InputState::Cancelled);
    assert_eq!(world.ledger()[0]["state"], "cancelled");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_outbox_it_cannot_read_safely_refuses_instead_of_starting_empty() {
    let world = World::new("corrupt").await;
    std::fs::create_dir_all(world.dir.join("state")).expect("state");
    std::fs::write(
        world.dir.join("state").join("session-input.json"),
        b"[{\"id\":1}]",
    )
    .expect("seed");
    let world = world.restart().await;
    assert_eq!(
        world.outbox.list().await.expect_err("refused").0,
        "The message outbox could not be read safely"
    );
    let answer = world
        .outbox
        .answer(
            "/input/claim",
            &json!({ "id": uuid(), "owner": "page", "conversationId": CHAT }),
        )
        .await;
    assert_eq!(
        (answer.status, answer.body),
        (500, json!({ "error": "internal" }))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_input_routes_refuse_what_bridge_ts_refuses() {
    let world = World::new("routes").await;
    let session = world.idle_chat(CHAT, START - 5_000).await;
    let row = world
        .outbox
        .enqueue(&world.args(Some(&session), "Routes"))
        .await
        .expect("enqueued");
    let answer = |route: &'static str, body: Value| {
        let outbox = world.outbox.clone();
        async move {
            let answer = outbox.answer(route, &body).await;
            (answer.status, answer.body)
        }
    };
    assert_eq!(
        answer("/input/claim", json!({ "id": "short", "owner": "p" })).await,
        (400, json!({ "error": "invalid_input_claim" }))
    );
    assert_eq!(
        answer(
            "/input/claim",
            json!({ "id": row.id, "owner": "p".repeat(161) })
        )
        .await,
        (400, json!({ "error": "invalid_input_claim" }))
    );
    assert_eq!(
        answer("/input/claim", json!({ "id": row.id, "owner": "p" })).await,
        (400, json!({ "error": "bad_conversation_id" }))
    );
    assert_eq!(
        answer(
            "/input/bind",
            json!({ "id": row.id, "owner": "p", "conversationId": "x" })
        )
        .await,
        (400, json!({ "error": "bad_conversation_id" }))
    );
    assert_eq!(
        answer(
            "/input/ack",
            json!({ "id": row.id, "owner": "stranger", "conversationId": CHAT })
        )
        .await,
        (409, json!({ "error": "input_not_owned" }))
    );
    assert_eq!(
        answer(
            "/input/attachment",
            json!({ "id": row.id, "owner": "p", "conversationId": CHAT, "attachmentId": uuid(), "offset": 0 })
        )
        .await,
        (409, json!({ "error": "attachment_not_owned" }))
    );
    claim(&world, &row.id, "p", json!(CHAT)).await;
    assert_eq!(
        answer(
            "/input/ack",
            json!({ "id": row.id, "owner": "p", "conversationId": OTHER })
        )
        .await,
        (409, json!({ "error": "input_not_pending" }))
    );
    assert_eq!(
        answer(
            "/input/progress",
            json!({ "id": row.id, "owner": "p", "conversationId": CHAT, "partial": "x" })
        )
        .await,
        (200, json!({ "ok": false }))
    );
}

/// What a page sends for a new chat: no chat id yet, until the receipt names the one ChatGPT made.
async fn page_answer(world: &World, route: &str, body: Value) -> Value {
    world.outbox.answer(route, &body).await.body
}

fn meta(world: &World, session: &str) -> Value {
    read_json(&world.dir.join("sessions").join(session).join("meta.json"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_chat_reserves_its_session_and_binds_it_on_the_first_receipt() {
    let world = World::new("opening").await;
    let args = world.args(None, "Start a new chat");
    let row = world.outbox.enqueue(&args).await.expect("admitted");
    let id = row.id.clone();
    assert_eq!(
        row.session_id.as_deref(),
        Some(id.as_str()),
        "filed under its own id"
    );
    assert_eq!(row.opening, Some(cos_types::json::True));
    assert_eq!(row.transport_intent, Some(TransportIntent::Browser));
    assert_eq!(row.conversation_id, None);
    let reserved = meta(&world, &id);
    assert_eq!(reserved["origin"]["kind"], "desktop");
    assert_eq!(reserved["conversationId"], Value::Null);
    assert_eq!(reserved["title"], "Start a new chat");
    assert_eq!(reserved["events"], 0);
    assert!(
        world.journal(&id).is_empty(),
        "a reservation records nothing"
    );

    let again = world.outbox.enqueue(&args).await.expect("the same id");
    assert_eq!(
        (again.id.as_str(), again.state),
        (id.as_str(), InputState::Queued)
    );
    assert_eq!(world.outbox.list().await.expect("list").len(), 1);
    assert_eq!(
        world.outbox.pending().await.expect("pending"),
        vec![json!({ "id": id, "conversationId": null })]
    );

    let claimed = page_answer(
        &world,
        "/input/claim",
        json!({ "id": id, "owner": "page", "conversationId": null, "requiresAuthorization": true }),
    )
    .await;
    assert_eq!(claimed["input"]["state"], "browser", "{claimed}");
    let granted = page_answer(
        &world,
        "/input/claim",
        json!({ "id": id, "owner": "page", "conversationId": null, "authorize": true }),
    )
    .await;
    assert_eq!(granted, json!({ "ok": true }));
    let ack = |owner: &str, conversation: Option<&str>| {
        let mut body = json!({ "id": id, "owner": owner, "messageId": "native-1" });
        if let Some(conversation) = conversation {
            body["conversationId"] = json!(conversation);
        }
        body
    };
    assert_eq!(
        page_answer(&world, "/input/ack", ack("page", None)).await,
        json!({ "error": "input_not_pending" }),
        "a new chat is not sent until ChatGPT names it"
    );
    assert_eq!(
        page_answer(&world, "/input/ack", ack("other", Some(CHAT))).await,
        json!({ "error": "input_not_owned" })
    );
    assert_eq!(
        page_answer(&world, "/input/ack", ack("page", Some(CHAT))).await,
        json!({ "ok": true })
    );

    let sent = listed(&world, &id).await;
    assert_eq!(sent.state, InputState::Sent);
    assert_eq!(sent.conversation_id.as_deref(), Some(CHAT));
    assert_eq!(sent.session_id.as_deref(), Some(id.as_str()));
    assert_eq!(sent.delivered_session_id, Some(Some(id.clone())));
    let bound = meta(&world, &id);
    assert_eq!(bound["conversationId"], CHAT);
    assert_eq!(bound["chatIds"], json!([CHAT]));
    world.sessions.flush().await;
    assert!(
        world.messages(&id).iter().any(|message| {
            message["inputId"] == id.as_str() && message["messageId"] == "native-1"
        }),
        "the first message is in the new chat's session"
    );
    assert_eq!(
        page_answer(&world, "/input/ack", ack("page", Some(OTHER))).await,
        json!({ "error": "input_not_pending" }),
        "a later receipt for another chat cannot move it"
    );

    let world = world.restart().await;
    assert_eq!(listed(&world, &id).await.state, InputState::Sent);
    assert_eq!(
        world.outbox.enqueue(&args).await.expect("replayed").state,
        InputState::Sent
    );
    assert_eq!(
        world
            .sessions
            .find_by_conversation(CHAT, true)
            .map(|session| session.id.as_str().to_owned()),
        Some(id)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reservation_lost_before_a_restart_is_made_again_under_the_same_id() {
    let world = World::new("opening-repair").await;
    let row = world
        .outbox
        .enqueue(&world.args(None, "Open after a crash"))
        .await
        .expect("admitted");
    world.sessions.flush().await;
    std::fs::remove_dir_all(world.dir.join("sessions").join(&row.id)).expect("lost");
    let world = world.restart().await;
    let listed = listed(&world, &row.id).await;
    assert_eq!((listed.state, listed.error), (InputState::Queued, None));
    assert_eq!(meta(&world, &row.id)["origin"]["kind"], "desktop");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_bind_route_attaches_a_new_chat_once_send_is_authorized() {
    let world = World::new("opening-bind").await;
    let row = world
        .outbox
        .enqueue(&world.args(None, "Bind me early"))
        .await
        .expect("admitted");
    let id = row.id.clone();
    let bind = || json!({ "id": id, "owner": "page", "conversationId": CHAT });
    page_answer(
        &world,
        "/input/claim",
        json!({ "id": id, "owner": "page", "conversationId": null, "requiresAuthorization": true }),
    )
    .await;
    assert_eq!(
        page_answer(&world, "/input/bind", bind()).await,
        json!({ "ok": false }),
        "not before Send is authorized"
    );
    page_answer(
        &world,
        "/input/claim",
        json!({ "id": id, "owner": "page", "conversationId": null, "authorize": true }),
    )
    .await;
    assert_eq!(
        page_answer(&world, "/input/bind", bind()).await,
        json!({ "ok": true })
    );
    assert_eq!(meta(&world, &id)["conversationId"], CHAT);
    assert_eq!(
        listed(&world, &id).await.conversation_id.as_deref(),
        Some(CHAT)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_chat_in_a_project_is_refused_without_a_projects_owner() {
    let world = World::new("opening-project").await;
    let mut args = world.args(None, "In a project");
    args["projectId"] = json!("5b0c8f2e-1d2a-4c3b-9e8f-0a1b2c3d4e5f");
    let error = world.outbox.enqueue(&args).await.expect_err("refused");
    assert!(error.0.contains("in a project"), "{error}");
    assert!(world.outbox.list().await.expect("list").is_empty());
}
