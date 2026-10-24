//! A new chat's reserved session: what `create_reserved` leaves on disk, what a repeat or a
//! restart finds, and when `bind_conversation` attaches a chat (`createSession` with
//! `reservedId` and `rebindSession(id, null, chat)` in `store.ts`).

use std::path::{Path, PathBuf};

use cos_sessions::SessionStore;
use cos_store::{AppPaths, Logger};
use cos_types::ids::SessionId;
use serde_json::Value;

const CHAT: &str = "c1c1c1c1-0000-4000-8000-000000000001";

fn profile(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cos-reserved-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("profile");
    dir
}

async fn open(profile: &Path) -> SessionStore {
    let store = SessionStore::open(&AppPaths::at(profile), Logger::new());
    store.restore().await;
    store
}

fn meta(profile: &Path, id: &str) -> Value {
    let path = profile.join("sessions").join(id).join("meta.json");
    serde_json::from_slice(&std::fs::read(path).expect("meta.json")).expect("json")
}

fn id(text: &str) -> SessionId {
    SessionId::parse(text).expect("a session id")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reservation_is_one_desktop_session_without_a_chat_however_often_it_is_made() {
    let dir = profile("create");
    let store = open(&dir).await;
    let reserved = id("0f8fad5b-d9cb-469f-a165-70867728950e");
    let first = store
        .create_reserved(&reserved, "  Build the thing  ")
        .await
        .expect("reserved");
    assert_eq!(first.title, "Build the thing");
    let on_disk = meta(&dir, reserved.as_str());
    assert_eq!(on_disk["origin"]["kind"], "desktop");
    assert_eq!(on_disk["titleSource"], "fallback");
    assert_eq!(on_disk["conversationId"], Value::Null);
    assert_eq!(on_disk["events"], 0);
    assert_eq!(
        std::fs::read_to_string(
            dir.join("sessions")
                .join(reserved.as_str())
                .join("events.jsonl")
        )
        .expect("journal"),
        ""
    );

    let again = store
        .create_reserved(&reserved, "Other words")
        .await
        .expect("the same session");
    assert_eq!(again.title, "Build the thing");
    drop(store);
    let store = open(&dir).await;
    assert_eq!(
        store
            .create_reserved(&reserved, "After a restart")
            .await
            .expect("still the same")
            .started_at,
        first.started_at
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_this_app_did_not_open_for_a_new_chat_is_not_taken_over() {
    let dir = profile("foreign");
    let store = open(&dir).await;
    let recorded = store
        .create_for_conversation(CHAT, Some("Recorded"))
        .await
        .expect("a recorded chat");
    let error = store
        .create_reserved(&recorded.id, "Take it")
        .await
        .expect_err("refused");
    assert_eq!(error, "Reserved opening session belongs to different work");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn binding_attaches_one_chat_once_and_never_a_chat_another_session_owns() {
    let dir = profile("bind");
    let store = open(&dir).await;
    let owner = store
        .create_for_conversation(CHAT, Some("Owner"))
        .await
        .expect("owner");
    let reserved = id("0f8fad5b-d9cb-469f-a165-70867728950f");
    store
        .create_reserved(&reserved, "New chat")
        .await
        .expect("reserved");
    assert!(
        !store
            .bind_conversation(&reserved, CHAT)
            .await
            .expect("answered"),
        "{CHAT} belongs to {}",
        owner.id
    );
    assert_eq!(meta(&dir, reserved.as_str())["conversationId"], Value::Null);

    let chat = "c2c2c2c2-0000-4000-8000-000000000002";
    assert!(
        store
            .bind_conversation(&reserved, chat)
            .await
            .expect("bound")
    );
    let bound = meta(&dir, reserved.as_str());
    assert_eq!(bound["conversationId"], chat);
    assert_eq!(bound["chatIds"], serde_json::json!([chat]));
    assert_eq!(
        store
            .find_by_conversation(chat, true)
            .map(|session| session.id),
        Some(reserved.clone())
    );
    assert!(
        !store
            .bind_conversation(&reserved, "c3c3c3c3-0000-4000-8000-000000000003")
            .await
            .expect("answered"),
        "a bound session keeps its chat"
    );
    drop(store);
    let store = open(&dir).await;
    assert_eq!(
        store
            .summary(&reserved)
            .await
            .and_then(|summary| summary.conversation_id)
            .as_deref(),
        Some(chat)
    );
}
