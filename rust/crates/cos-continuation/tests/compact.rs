//! `POST /compact` and `POST /repairs/claim`, from the Compact & Resume cases of
//! `test/bridge.test.ts` and `test/resume.test.ts` that need no browser command ledger.

mod support;

use std::sync::{Arc, Mutex};

use cos_continuation::compact::{CommandView, Compact, CompactChats, ResumeCommands};
use cos_continuation::repairs::{ChatFences, NoRepairCheck, Repairs};
use cos_types::ids::SessionId;
use serde_json::{Value, json};
use support::*;

const CHAT: &str = "c0c0c0c0-7870-4000-8000-000000000001";
const OTHER: &str = "c0c0c0c0-7870-4000-8000-000000000002";

#[derive(Default)]
struct Chats {
    blocked: Mutex<Vec<String>>,
}

impl CompactChats for Chats {
    fn live_session(&self, _conversation: &str) -> Option<SessionId> {
        None
    }
    fn worker(&self, _conversation: &str) -> bool {
        false
    }
    fn blocked(&self, conversation: &str) -> bool {
        self.blocked
            .lock()
            .unwrap()
            .iter()
            .any(|chat| chat == conversation)
    }
}

impl ChatFences for Chats {
    fn blocked(&self, conversation: &str) -> bool {
        CompactChats::blocked(self, conversation)
    }
    fn stop_requested(&self, _conversation: &str) -> bool {
        false
    }
}

/// A command ledger that queues one resume command per session and never leases it.
#[derive(Default)]
struct Commands {
    queued: Mutex<Vec<(SessionId, String)>>,
}

impl ResumeCommands for Commands {
    fn queue(&self, session: &SessionId, token: &str) -> Option<String> {
        let mut queued = self.queued.lock().unwrap();
        queued.retain(|(known, _)| known != session);
        queued.push((session.clone(), token.to_owned()));
        Some(format!("command-{}", queued.len()))
    }
    fn retire(&self, token: &str, _reason: &str) {
        self.queued
            .lock()
            .unwrap()
            .retain(|(_, known)| known != token);
    }
    fn withdraw(&self, session: &SessionId) -> bool {
        let mut queued = self.queued.lock().unwrap();
        let before = queued.len();
        queued.retain(|(known, _)| known != session);
        before != queued.len()
    }
    fn command(&self, session: &SessionId) -> Option<CommandView> {
        self.queued
            .lock()
            .unwrap()
            .iter()
            .position(|(known, _)| known == session)
            .map(|index| CommandView {
                id: format!("command-{}", index + 1),
                leased: false,
            })
    }
    fn leased_to(&self, _id: &str, _token: &str, _client: Option<&str>) -> bool {
        false
    }
    fn deliver(&self, _collector: Option<&str>) -> Option<Value> {
        None
    }
}

struct Route {
    process: Process,
    compact: Compact,
    chats: Arc<Chats>,
    commands: Arc<Commands>,
}

async fn route(profile: &Profile) -> Route {
    let process = start(&profile.0, &Offset::default()).await;
    let chats = Arc::new(Chats::default());
    let commands = Arc::new(Commands::default());
    let compact = Compact::new(
        process.continuations.clone(),
        commands.clone(),
        chats.clone(),
    );
    Route {
        process,
        compact,
        chats,
        commands,
    }
}

impl Route {
    async fn post(&self, body: Value) -> (u16, Value) {
        let answer = self.compact.answer(&body).await;
        (answer.status, answer.body)
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn opens_once_hands_out_the_prompt_and_answers_the_same_press_again() {
    let profile = Profile::new("route-open");
    let route = route(&profile).await;
    let session = route.process.chat_session(CHAT).await;
    let (status, opened) = route.post(json!({ "conversationId": CHAT })).await;
    assert_eq!(status, 202);
    assert_eq!(opened["started"], true);
    assert_eq!(opened["sessionId"], session.as_str());
    let token = opened["token"].as_str().unwrap().to_owned();
    let prompt = opened["prompt"].as_str().unwrap();
    assert!(prompt.starts_with(&format!(
        "[[CLF-HANDOFF:{token}]]\n\nChat On Steroids is compacting this conversation"
    )));
    assert_eq!(opened["job"]["stage"], "handoff-pending");
    assert_eq!(opened["job"]["busy"], true);

    let (status, again) = route.post(json!({ "conversationId": CHAT })).await;
    assert_eq!(status, 202, "the prompt stays available before any Send");
    assert_eq!(again["started"], false);
    assert_eq!(again["token"], token.as_str());

    let fence = |key: &str| json!({ "conversationId": CHAT, "token": token, key: true });
    let (status, attempt) = route.post(fence("sourceAttempt")).await;
    assert_eq!(status, 200);
    assert_eq!(attempt["allowed"], true);
    assert_eq!(attempt["sourceSend"]["state"], "attempted-unresolved");
    let (status, armed) = route.post(fence("sourceDispatch")).await;
    assert_eq!((status, armed), (200, json!({ "armed": true })));
    let (status, reclaimed) = route.post(fence("sourceDispatch")).await;
    assert_eq!(
        (status, reclaimed),
        (409, json!({ "error": "source_send_reclaimed" }))
    );
    let (status, pressed) = route.post(json!({ "conversationId": CHAT })).await;
    assert_eq!(status, 200, "once armed no page may submit it again");
    assert_eq!(pressed["prompt"], Value::Null);
    let (status, bound) = route
        .post(
            json!({ "conversationId": CHAT, "token": token, "sourceMessageId": "handoff-message" }),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(bound["bound"], true);
    assert_eq!(bound["job"]["sourceSend"]["state"], "sent");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stores_the_brief_and_queues_the_replacement_chat() {
    let profile = Profile::new("route-capture");
    let route = route(&profile).await;
    let session = route.process.chat_session(CHAT).await;
    let (_, opened) = route.post(json!({ "conversationId": CHAT })).await;
    let token = opened["token"].as_str().unwrap();
    let (status, stored) = route
        .post(json!({ "conversationId": CHAT, "token": token, "summary": SAMPLE_BRIEF }))
        .await;
    assert_eq!(status, 200, "{stored}");
    assert_eq!(stored["stored"], true);
    assert_eq!(stored["commandId"], "command-1");
    assert_eq!(stored["job"]["stage"], "waiting-for-browser");
    let handoff = stored["handoffId"].as_str().unwrap();
    assert_eq!(
        route
            .process
            .sessions
            .summary(&session)
            .await
            .unwrap()
            .last_handoff_id
            .as_deref(),
        Some(handoff)
    );
    let (status, again) = route
        .post(json!({ "conversationId": CHAT, "token": token, "summary": "a re-observed variant" }))
        .await;
    assert_eq!(status, 200, "a retry is answered with the stored brief");
    assert_eq!(again["handoffId"], handoff);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_a_brief_that_cannot_be_the_whole_handoff_and_stays_in_the_chat() {
    let profile = Profile::new("route-short");
    let route = route(&profile).await;
    let session = route.process.chat_session(CHAT).await;
    let (_, opened) = route.post(json!({ "conversationId": CHAT })).await;
    let token = opened["token"].as_str().unwrap();
    let (status, refused) = route
        .post(json!({ "conversationId": CHAT, "token": token, "summary": "TASK\nContinue implementing " }))
        .await;
    assert_eq!(status, 409);
    assert_eq!(refused["error"], "brief_incomplete");
    assert!(
        refused["message"]
            .as_str()
            .unwrap()
            .ends_with("Nothing was compacted — this chat still has its session.")
    );
    assert_eq!(refused["job"]["stage"], "failed");
    assert_eq!(
        route.process.attached(&session).await.as_deref(),
        Some(CHAT)
    );
    assert!(route.commands.queued.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancels_and_withdraws_the_queued_chat() {
    let profile = Profile::new("route-cancel");
    let route = route(&profile).await;
    route.process.chat_session(CHAT).await;
    let (_, opened) = route.post(json!({ "conversationId": CHAT })).await;
    let token = opened["token"].as_str().unwrap();
    route
        .post(json!({ "conversationId": CHAT, "token": token, "summary": SAMPLE_BRIEF }))
        .await;
    let (status, cancelled) = route
        .post(json!({ "conversationId": CHAT, "cancel": true }))
        .await;
    assert_eq!(status, 200);
    assert_eq!(cancelled["cancelled"], true);
    assert_eq!(cancelled["job"]["stage"], "failed");
    assert_eq!(cancelled["job"]["error"], "cancelled");
    assert!(route.commands.queued.lock().unwrap().is_empty());
    let (status, nothing) = route
        .post(json!({ "conversationId": CHAT, "cancel": true }))
        .await;
    assert_eq!(status, 200);
    assert_eq!(
        nothing["cancelled"], true,
        "an aborted transaction reports its cancellation"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_what_it_cannot_compact() {
    let profile = Profile::new("route-refusals");
    let route = route(&profile).await;
    assert_eq!(
        route.post(json!({ "conversationId": "not a chat" })).await,
        (400, json!({ "error": "bad_conversation_id" }))
    );
    let (status, unknown) = route.post(json!({ "conversationId": OTHER })).await;
    assert_eq!(
        (status, &unknown["error"]),
        (409, &json!("session_not_recorded"))
    );
    route.process.chat_session(CHAT).await;
    route.chats.blocked.lock().unwrap().push(CHAT.into());
    let (status, blocked) = route.post(json!({ "conversationId": CHAT })).await;
    assert_eq!((status, &blocked["error"]), (409, &json!("chat_blocked")));
    route.chats.blocked.lock().unwrap().clear();
    assert_eq!(
        route
            .post(json!({ "conversationId": CHAT, "token": "unknown-token-0000", "sourceAttempt": true }))
            .await,
        (409, json!({ "error": "no_such_continuation" }))
    );
    assert_eq!(
        route
            .post(json!({ "token": "unknown-token-0000", "destinationAttempt": true, "commandId": "x" }))
            .await,
        (409, json!({ "error": "destination_send_not_available" })),
        "a destination fence needs the command leased to this page"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn files_a_ticket_without_handing_out_the_prompt() {
    let profile = Profile::new("route-ticket");
    let route = route(&profile).await;
    route.process.chat_session(CHAT).await;
    let (status, filed) = route
        .post(json!({ "conversationId": CHAT, "ticket": true }))
        .await;
    assert_eq!(status, 202);
    assert_eq!(filed["filed"], true);
    assert_eq!(filed["started"], true);
    assert_eq!(filed["prompt"], Value::Null);
    let (_, again) = route
        .post(json!({ "conversationId": CHAT, "ticket": true }))
        .await;
    assert_eq!(again["started"], false);
    assert_eq!(again["token"], filed["token"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_repair_claim_with_nothing_handed_out_is_refused() {
    let profile = Profile::new("repairs");
    let process = start(&profile.0, &Offset::default()).await;
    let repairs = Repairs::new(
        process.sessions.clone(),
        Arc::new(NoRepairCheck),
        Arc::new(Chats::default()),
    );
    let answer = repairs
        .claim(false, Some(&json!({ "token": "TTTTTTTTTTTT" })))
        .await;
    assert_eq!(
        (answer.status, answer.body),
        (200, json!({ "allowed": false }))
    );
    let answer = repairs.claim(false, Some(&json!({}))).await;
    assert_eq!(
        (answer.status, answer.body),
        (400, json!({ "error": "bad_request" }))
    );
    let answer = repairs.claim(false, None).await;
    assert_eq!(answer.status, 400);
    let answer = repairs.claim(true, None).await;
    assert_eq!(
        (answer.status, answer.body),
        (200, json!({ "allowed": false }))
    );
}
