//! What the outbox admits, lists and cancels through `/v1/inputs`, over real loopback HTTP and
//! the real outbox and session store (`sending`, `starting a new chat` and `cancelling` in
//! `test/control-api-actions.test.ts`).

use serde_json::{Value, json};

use super::client::{Got, Sent, send};
use super::harness::{Harness, Options};

const CHAT: &str = "c1c1c1c1-0000-4000-8000-000000000001";
const FIRST: &str = "00000000-0000-4000-8000-0000000000a1";
const SECOND: &str = "00000000-0000-4000-8000-0000000000a2";

async fn harness() -> (Harness, String) {
    let harness = Harness::start(Options {
        allow_actions: true,
        real_store: true,
        ..Options::default()
    })
    .await;
    let session = harness
        .store
        .create_for_conversation(CHAT, Some("A chat"))
        .await
        .expect("a recorded chat");
    (harness, session.id.as_str().to_owned())
}

async fn post(harness: &Harness, target: &str, body: Option<Value>) -> Got {
    let mut sent = Sent::post(target).header("authorization", &harness.auth());
    if let Some(body) = body {
        sent = sent
            .header("content-type", "application/json")
            .body(body.to_string());
    }
    send(harness.port, &sent).await
}

async fn get(harness: &Harness, target: &str) -> Value {
    let got = send(
        harness.port,
        &Sent::get(target).header("authorization", &harness.auth()),
    )
    .await;
    assert_eq!(got.status, 200, "{target}: {}", got.json());
    got.json()
}

async fn page(harness: &Harness, route: &str, body: Value) -> Value {
    harness.outbox.answer(route, &body).await.body
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_message_to_a_chat_is_admitted_once_and_reported_by_what_its_row_proves() {
    let (harness, session) = harness().await;
    let body = json!({ "id": FIRST, "sessionId": session, "text": "  Read one file  " });
    let admitted = post(&harness, "/v1/inputs", Some(body.clone())).await;
    assert_eq!(admitted.status, 202, "{}", admitted.json());
    let input = &admitted.json()["input"];
    assert_eq!(admitted.json()["replayed"], false);
    assert_eq!(
        (
            &input["id"],
            &input["sessionId"],
            &input["conversationId"],
            &input["state"],
            &input["delivery"],
            &input["transportIntent"],
            &input["text"],
        ),
        (
            &json!(FIRST),
            &json!(session),
            &json!(CHAT),
            &json!("queued"),
            &json!("pending"),
            &json!("browser"),
            &json!({ "text": "Read one file", "chars": 13, "truncated": false }),
        )
    );

    let replayed = post(&harness, "/v1/inputs", Some(body)).await;
    assert_eq!(
        (replayed.status, replayed.json()["replayed"].clone()),
        (200, json!(true)),
        "the same id answers the row that exists"
    );
    let changed = post(
        &harness,
        "/v1/inputs",
        Some(json!({ "id": FIRST, "sessionId": session, "text": "Something else" })),
    )
    .await;
    assert_eq!(
        (changed.status, changed.json()),
        (
            409,
            json!({ "error": "id_conflict", "detail": "this id belongs to a different message" })
        )
    );
    let busy = post(
        &harness,
        "/v1/inputs",
        Some(json!({ "id": SECOND, "sessionId": session, "text": "And this" })),
    )
    .await;
    assert_eq!(
        (busy.status, busy.json()),
        (
            409,
            json!({ "error": "busy", "detail": "another message for this chat is still awaiting delivery" })
        )
    );

    let listed = get(&harness, "/v1/inputs").await;
    assert_eq!(listed["total"], 1);
    assert_eq!(listed["inputs"][0]["id"], FIRST);
    assert_eq!(
        get(&harness, "/v1/inputs?state=sent,cancelled").await,
        json!({ "inputs": [], "total": 0 })
    );
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_message_with_no_session_starts_a_new_chat_named_by_its_id() {
    let harness = Harness::start(Options {
        allow_actions: true,
        real_store: true,
        ..Options::default()
    })
    .await;
    let admitted = post(
        &harness,
        "/v1/inputs",
        Some(json!({ "id": FIRST, "text": "Start fresh" })),
    )
    .await;
    assert_eq!(admitted.status, 202, "{}", admitted.json());
    let input = admitted.json()["input"].clone();
    assert_eq!(
        (
            &input["sessionId"],
            &input["conversationId"],
            &input["state"]
        ),
        (&json!(FIRST), &Value::Null, &json!("queued"))
    );
    let session = get(&harness, &format!("/v1/sessions/{FIRST}")).await;
    assert_eq!(session["session"]["origin"]["kind"], "desktop");
    assert_eq!(session["session"]["conversationId"], Value::Null);

    let refused = post(&harness, &format!("/v1/inputs/{FIRST}/cancel"), None).await;
    assert_eq!(refused.status, 409);
    assert_eq!(
        (
            refused.json()["error"].clone(),
            refused.json()["detail"].clone()
        ),
        (
            json!("not_cancellable"),
            json!("a new chat is opening; cancel it in the app")
        )
    );
    assert_eq!(refused.json()["input"], input);
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_withdraws_only_what_provably_was_not_sent() {
    let (harness, session) = harness().await;
    let send_one = |id: &str| json!({ "id": id, "sessionId": session, "text": "Withdraw me" });
    assert_eq!(
        post(&harness, "/v1/inputs", Some(send_one(FIRST)))
            .await
            .status,
        202
    );
    let cancelled = post(&harness, &format!("/v1/inputs/{FIRST}/cancel"), None).await;
    assert_eq!(cancelled.status, 200, "{}", cancelled.json());
    assert_eq!(cancelled.json()["cancelled"], true);
    assert_eq!(cancelled.json()["input"]["delivery"], "not_sent");
    let again = post(&harness, &format!("/v1/inputs/{FIRST}/cancel"), None).await;
    assert_eq!(
        (again.status, again.json()["cancelled"].clone()),
        (200, json!(false))
    );

    assert_eq!(
        post(&harness, "/v1/inputs", Some(send_one(SECOND)))
            .await
            .status,
        202
    );
    page(
        &harness,
        "/input/claim",
        json!({ "id": SECOND, "owner": "page", "conversationId": CHAT, "requiresAuthorization": true }),
    )
    .await;
    let claimed = post(
        &harness,
        &format!("/v1/inputs/{SECOND}/cancel"),
        Some(json!({})),
    )
    .await;
    assert_eq!(
        (claimed.status, claimed.json()["input"]["delivery"].clone()),
        (200, json!("not_sent")),
        "a claim before Send is authorized is withdrawn: {}",
        claimed.json()
    );
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_refuses_what_send_may_already_have_delivered() {
    let (harness, session) = harness().await;
    post(
        &harness,
        "/v1/inputs",
        Some(json!({ "id": FIRST, "sessionId": session, "text": "Send me" })),
    )
    .await;
    page(
        &harness,
        "/input/claim",
        json!({ "id": FIRST, "owner": "page", "conversationId": CHAT, "requiresAuthorization": true }),
    )
    .await;
    page(
        &harness,
        "/input/claim",
        json!({ "id": FIRST, "owner": "page", "conversationId": CHAT, "authorize": true }),
    )
    .await;
    let authorized = post(&harness, &format!("/v1/inputs/{FIRST}/cancel"), None).await;
    assert_eq!(
        (
            authorized.status,
            authorized.json()["error"].clone(),
            authorized.json()["detail"].clone(),
            authorized.json()["input"]["delivery"].clone()
        ),
        (
            409,
            json!("not_cancellable"),
            json!("Send was authorized; it may already be in ChatGPT"),
            json!("unconfirmed")
        )
    );
    page(
        &harness,
        "/input/ack",
        json!({ "id": FIRST, "owner": "page", "conversationId": CHAT, "messageId": "native-1" }),
    )
    .await;
    let sent = post(&harness, &format!("/v1/inputs/{FIRST}/cancel"), None).await;
    assert_eq!(
        (
            sent.status,
            sent.json()["detail"].clone(),
            sent.json()["input"]["delivery"].clone()
        ),
        (409, json!("already handed to ChatGPT"), json!("sent"))
    );
    let listed = get(&harness, "/v1/inputs?state=sent&limit=1").await;
    assert_eq!(
        (
            listed["total"].clone(),
            listed["inputs"][0]["messageId"].clone()
        ),
        (json!(1), json!("native-1"))
    );
    harness.shutdown().await;
}
