//! The blocked and trusted chat lists, with the cases of `test/blocked-chats.test.ts` and
//! `test/trusted-chats.test.ts`.

use std::path::{Path, PathBuf};

use cos_sessions::{BLOCKED_CHAT_REFUSAL, BlockedChatsLedger, ChatListError, TrustedChatsLedger};
use cos_store::{AppPaths, DurableStore, Logger};
use serde_json::{Value, json};

const ROGUE: &str = "conv-rogue-turn-01";
const TRUSTED: &str = "conv-trusted-chat-01";
const OTHER: &str = "conv-other-chat-01";

fn profile(name: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("cos-sessions-chats-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("profile");
    dir
}

fn state(profile: &Path) -> DurableStore {
    DurableStore::new(AppPaths::at(profile).state(), Logger::new())
}

/// A fresh process on the same profile.
fn blocks(profile: &Path) -> BlockedChatsLedger {
    let ledger = BlockedChatsLedger::new(&state(profile));
    ledger.restore();
    ledger
}

fn trust(profile: &Path) -> TrustedChatsLedger {
    let ledger = TrustedChatsLedger::new(&state(profile));
    ledger.restore();
    ledger
}

fn write_state(profile: &Path, name: &str, value: &Value) {
    let dir = AppPaths::at(profile).state();
    std::fs::create_dir_all(&dir).expect("state");
    std::fs::write(
        dir.join(format!("{name}.json")),
        serde_json::to_vec(value).expect("encode"),
    )
    .expect("write");
}

#[test]
fn blocks_and_releases_exactly_the_conversation_it_was_told_about() {
    let blocked = blocks(&profile("exact"));
    blocked.set(&[ROGUE], true).expect("block");
    assert!(blocked.is_blocked(Some(ROGUE)));
    assert!(!blocked.is_blocked(Some(OTHER)));
    assert!(
        !blocked.is_blocked(None),
        "unattributed work is never the blocked chat"
    );
    assert!(blocked.any());
    blocked.set(&[ROGUE], false).expect("release");
    assert!(!blocked.is_blocked(Some(ROGUE)));
    assert!(blocked.ids().is_empty());
    assert!(!blocked.any());
}

#[test]
fn blocking_is_idempotent_in_both_directions() {
    let blocked = blocks(&profile("idempotent"));
    blocked.set(&[ROGUE], true).expect("block");
    let at = blocked.blocked_at(ROGUE);
    blocked.set(&[ROGUE, ROGUE], true).expect("again");
    assert_eq!(blocked.ids(), [ROGUE]);
    assert_eq!(
        blocked.blocked_at(ROGUE),
        at,
        "a second press keeps the first time"
    );
    blocked.set(&[ROGUE], false).expect("release");
    blocked.set(&[ROGUE], false).expect("again");
    assert!(blocked.ids().is_empty());
}

#[test]
fn a_block_survives_a_restart_and_a_release_or_a_junk_id_does_not_come_back() {
    let dir = profile("restart");
    let blocked = blocks(&dir);
    blocked.set(&[ROGUE], true).expect("block");
    blocked.set(&[OTHER], true).expect("block");
    blocked.set(&[ROGUE], false).expect("release");
    blocked.flush();
    let restarted = blocks(&dir);
    assert_eq!(restarted.ids(), [OTHER]);
    assert!(!restarted.is_blocked(Some(ROGUE)));

    assert_eq!(
        restarted.set(&["nope"], true),
        Err(ChatListError::NotAConversation)
    );
    assert_eq!(
        restarted.set(&["has spaces and !"], true),
        Err(ChatListError::NotAConversation)
    );
    assert_eq!(restarted.ids(), [OTHER]);
    assert_eq!(
        ChatListError::NotAConversation.to_string(),
        "Not a ChatGPT conversation id"
    );

    write_state(
        &dir,
        "blocked-chats",
        &json!({ "version": 1, "entries": [
            { "conversationId": ROGUE, "blockedAt": 5 },
            { "conversationId": "bad ! id", "blockedAt": 6 },
            7
        ] }),
    );
    let restored = blocks(&dir);
    assert_eq!(restored.ids(), [ROGUE]);
    assert_eq!(restored.blocked_at(ROGUE), Some(5));
}

#[test]
fn the_refusal_tells_the_model_to_stop_rather_than_merely_that_it_failed() {
    for phrase in [
        "CHAT_BLOCKED",
        "no tool was run",
        "no further tool calls",
        "final answer",
        "The user explicitly asked for this",
    ] {
        assert!(BLOCKED_CHAT_REFUSAL.contains(phrase), "{phrase}");
    }
}

#[test]
fn blocks_refuse_to_grow_without_bound_rather_than_unblocking_the_oldest_chat() {
    let blocked = blocks(&profile("bound"));
    for index in 0..200 {
        blocked
            .set(&[format!("conv-bulk-{index:04}").as_str()], true)
            .expect("block");
    }
    assert_eq!(blocked.ids().len(), 200);
    let refused = blocked.set(&[ROGUE], true);
    assert_eq!(refused, Err(ChatListError::TooManyBlocked));
    assert!(
        refused
            .err()
            .is_some_and(|error| error.to_string().contains("Too many blocked chats"))
    );
    assert!(blocked.is_blocked(Some("conv-bulk-0000")));
}

#[tokio::test]
async fn trusts_and_untrusts_only_the_exact_conversation() {
    let trusted = trust(&profile("trust-exact"));
    trusted.set(&[TRUSTED], true).await.expect("trust");
    assert!(trusted.is_trusted(Some(TRUSTED)));
    assert!(!trusted.is_trusted(Some(OTHER)));
    assert!(!trusted.is_trusted(None));
    trusted.set(&[TRUSTED], false).await.expect("untrust");
    assert!(trusted.ids().is_empty());
}

#[tokio::test]
async fn trust_is_on_disk_before_it_answers_without_a_later_flush() {
    let dir = profile("trust-durable");
    trust(&dir).set(&[TRUSTED], true).await.expect("trust");
    assert_eq!(trust(&dir).ids(), [TRUSTED]);
    trust(&dir).set(&[TRUSTED], false).await.expect("untrust");
    assert!(trust(&dir).ids().is_empty());
}

#[tokio::test]
async fn revokes_a_trust_lineage_in_one_durable_change() {
    let dir = profile("trust-lineage");
    let trusted = trust(&dir);
    trusted.set(&[TRUSTED], true).await.expect("trust");
    trusted.set(&[OTHER], true).await.expect("trust");
    trusted
        .set(&[TRUSTED, OTHER, TRUSTED], false)
        .await
        .expect("revoke");
    assert!(trusted.ids().is_empty());
    assert!(trust(&dir).ids().is_empty());
}

#[tokio::test]
async fn invalid_entries_and_unknown_versions_trust_nothing() {
    let dir = profile("trust-invalid");
    write_state(
        &dir,
        "trusted-chats",
        &json!({ "version": 1, "entries": [OTHER, "bad ! id"] }),
    );
    assert_eq!(trust(&dir).ids(), [OTHER]);
    write_state(
        &dir,
        "trusted-chats",
        &json!({ "version": 999, "entries": [TRUSTED] }),
    );
    assert!(trust(&dir).ids().is_empty());
}

#[tokio::test]
async fn a_failed_trust_is_superseded_so_a_later_retry_cannot_grant_it() {
    let dir = profile("trust-failed");
    let state_dir = AppPaths::at(&dir).state();
    // A folder holds the file's place, so the write fails.
    std::fs::create_dir_all(state_dir.join("trusted-chats.json")).expect("blocker");
    let trusted = trust(&dir);
    assert!(matches!(
        trusted.set(&[TRUSTED], true).await,
        Err(ChatListError::Storage(_))
    ));
    assert!(!trusted.is_trusted(Some(TRUSTED)));
    std::fs::remove_dir(state_dir.join("trusted-chats.json")).expect("unblock");
    trusted.flush();
    assert!(
        trust(&dir).ids().is_empty(),
        "the retry wrote the list as it was"
    );
}

#[tokio::test]
async fn trust_is_bounded_without_evicting_older_trusted_chats() {
    let trusted = trust(&profile("trust-bound"));
    for index in 0..200 {
        trusted
            .set(&[format!("conv-trusted-{index:04}").as_str()], true)
            .await
            .expect("trust");
    }
    assert_eq!(trusted.ids().len(), 200);
    assert_eq!(
        trusted.set(&[TRUSTED], true).await,
        Err(ChatListError::TooManyTrusted)
    );
    assert!(trusted.is_trusted(Some("conv-trusted-0000")));
}
