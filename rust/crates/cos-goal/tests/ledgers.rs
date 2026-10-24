//! The per-chat ledgers through what their callers see: switches, objectives and owed replies,
//! read back from memory and from `state/` after a restart. Cases from `test/goal.test.ts`
//! ("a chat driven towards a specific goal", switches, reply obligations).

mod support;

use cos_goal::{AcceptReply, Endpoint, resolve_base_url};
use cos_types::config::{GoalMode, GoalProviderKind};
use serde_json::json;
use support::{CHAT, OTHER, World};

fn accept(session: &str, turn: &str, seq: u64) -> AcceptReply {
    AcceptReply {
        conversation_id: CHAT.to_owned(),
        session_id: session.to_owned(),
        reply_id: if seq == 0 {
            format!("turn:{turn}")
        } else {
            format!("reply-{turn}")
        },
        turn_id: turn.to_owned(),
        event_seq: seq,
        ..AcceptReply::default()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_chat_answers_the_switch_for_itself_and_the_rest_inherit() {
    let world = World::new("switch").await;
    assert!(
        world.goal.switch_for(CHAT).enabled,
        "inherits the app-wide On"
    );
    let held = world
        .goal
        .set_switch_now(CHAT, GoalMode::Goal, false, None)
        .await
        .expect("saved");
    assert_eq!(held, (false, GoalMode::Goal));
    let own = world.goal.switch_for(CHAT);
    assert!(own.own && !own.enabled);
    assert!(world.goal.switch_for(OTHER).enabled && !world.goal.switch_for(OTHER).own);
    let file = world
        .state_file("goal-switches")
        .expect("written before the answer");
    assert_eq!(file["version"], 1);
    assert_eq!(file["switches"][0]["conversationId"], CHAT);
    assert_eq!(file["switches"][0]["enabled"], false);
    assert_eq!(file["switches"][0]["afterTurn"], false);

    let world = world.restart().await;
    assert!(world.goal.switch_for(CHAT).own && !world.goal.switch_for(CHAT).enabled);
    assert!(world.goal.move_switch(CHAT, OTHER).await.expect("moved"));
    assert!(!world.goal.switch_for(CHAT).own);
    assert!(
        !world.goal.switch_for(OTHER).enabled,
        "the chosen Off follows the replacement chat"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn turning_loop_on_names_the_mode_and_off_only_stops_the_mode_running() {
    let world = World::new("modes").await;
    assert_eq!(
        world
            .goal
            .set_switch_now(CHAT, GoalMode::Loop, true, None)
            .await
            .expect("on"),
        (true, GoalMode::Loop)
    );
    assert_eq!(world.goal.driving_mode(Some(CHAT)), GoalMode::Loop);
    assert_eq!(
        world
            .goal
            .set_switch_now(CHAT, GoalMode::Goal, false, None)
            .await
            .expect("goal off"),
        (true, GoalMode::Loop),
        "Goal off while Loop runs changes nothing"
    );
    assert_eq!(
        world
            .goal
            .set_switch_now(CHAT, GoalMode::Loop, false, None)
            .await
            .expect("off"),
        (false, GoalMode::Loop)
    );
    assert_eq!(world.goal.driving_mode(Some(CHAT)), GoalMode::Goal);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_saved_goal_arms_a_chat_that_never_answered_for_itself() {
    let world = World::new("armed").await;
    world.configure(|config| config.goal.enabled = false);
    assert!(!world.goal.armed_for(CHAT));
    let stored = world
        .goal
        .set_objective_now(CHAT, "\n  finish the migration  \n")
        .await
        .expect("saved");
    assert_eq!(stored, "finish the migration", "reports what it stored");
    assert!(world.goal.armed_for(CHAT));
    assert_eq!(
        world.goal.driving_mode(Some(CHAT)),
        GoalMode::Goal,
        "Loop is never inherited from a goal"
    );
    world
        .goal
        .set_switch_now(CHAT, GoalMode::Goal, false, None)
        .await
        .expect("off");
    assert!(!world.goal.armed_for(CHAT), "the chat's own Off means off");

    let world = world.restart().await;
    assert_eq!(world.goal.objective_for(CHAT), "finish the migration");
    assert!(
        world.goal.view_for(CHAT, None).is_none(),
        "restoring creates no draft"
    );
    assert!(world.goal.move_objective(CHAT, OTHER).await.expect("moved"));
    assert_eq!(world.goal.objective_for(OTHER), "finish the migration");
    assert_eq!(world.goal.objective_for(CHAT), "");
    world
        .goal
        .set_objective_now(OTHER, "   ")
        .await
        .expect("cleared");
    assert_eq!(
        world.state_file("goal-objectives").expect("file")["objectives"],
        json!([])
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_helper_chat_is_durable_identity_that_never_drives() {
    let world = World::new("helper").await;
    world
        .goal
        .register_decision_chat(CHAT, Some("2026-01-01-a070c609"))
        .await
        .expect("registered");
    assert!(world.goal.is_decision_chat(CHAT));
    assert_eq!(
        world
            .goal
            .set_switch_now(CHAT, GoalMode::Loop, true, None)
            .await
            .expect("refused"),
        (false, GoalMode::Goal)
    );
    let error = world
        .goal
        .register_decision_chat(OTHER, Some("2026-01-01-a070c609"))
        .await
        .expect_err("bound");
    assert_eq!(error.0, "goal_helper_already_bound");
    world.goal.clear_all_switches().await.expect("master off");
    let world = world.restart().await;
    assert!(
        world.goal.is_decision_chat(CHAT),
        "master Off keeps helper identity"
    );
    assert!(!world.goal.switch_for(CHAT).enabled);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_accepted_reply_survives_a_restart_and_its_stable_id_upgrades_the_provisional_row() {
    let world = World::new("accept").await;
    let session = world.record(CHAT, &[support::user("go")]).await;
    world
        .goal
        .accept_reply_now(accept(&session, "g-1", 0))
        .await
        .expect("provisional");
    let accepted_at = world
        .goal
        .pending_reply_for(CHAT)
        .expect("owed")
        .accepted_at;
    world.advance(5_000);
    let mut stable = accept(&session, "g-1", 7);
    stable.reply_id = "m-final".to_owned();
    world.goal.accept_reply_now(stable).await.expect("upgraded");
    let pending = world.goal.pending_reply_for(CHAT).expect("still owed");
    assert_eq!(
        (pending.reply_id.as_str(), pending.event_seq),
        ("m-final", 7)
    );
    assert_eq!(
        pending.accepted_at, accepted_at,
        "the upgrade does not reopen the decision"
    );

    world
        .goal
        .accept_reply_now(accept(&session, "g-0", 3))
        .await
        .expect("older");
    assert_eq!(
        world.goal.pending_reply_for(CHAT).expect("kept").reply_id,
        "m-final",
        "an older reply never replaces a newer one"
    );

    let world = world.restart().await;
    assert_eq!(
        world.goal.pending_reply_for(CHAT).map(|p| p.reply_id),
        Some("m-final".to_owned())
    );
    world.advance(12 * 60 * 60_000);
    assert!(
        world.goal.pending_reply_for(CHAT).is_none(),
        "twelve hours retire the pickup"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reply_accepted_while_goal_is_off_is_a_handled_tombstone_that_on_rearms() {
    let world = World::new("tombstone").await;
    let session = world.record(CHAT, &[support::user("go")]).await;
    world
        .goal
        .set_switch_now(CHAT, GoalMode::Goal, false, None)
        .await
        .expect("off");
    world
        .goal
        .accept_reply_now(accept(&session, "g-1", 4))
        .await
        .expect("accepted");
    assert!(world.goal.pending_reply_for(CHAT).is_none());
    assert_eq!(
        world.state_file("goal-replies").expect("file")["replies"][0]["state"],
        "handled"
    );
    world
        .goal
        .set_switch_now(CHAT, GoalMode::Goal, true, None)
        .await
        .expect("on");
    assert!(
        world
            .goal
            .set_reply_active_now(CHAT, true)
            .await
            .expect("re-armed")
    );
    let pending = world.goal.pending_reply_for(CHAT).expect("owed again");
    assert_eq!(pending.explicit_activation, Some(cos_types::json::True));
    assert!(
        world
            .goal
            .set_reply_active_now(CHAT, false)
            .await
            .expect("closed")
    );
    assert!(world.goal.pending_reply_for(CHAT).is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_drops_damaged_rows_and_keeps_the_rest() {
    let world = World::new("restore").await;
    let state = world.dir.join("state");
    std::fs::create_dir_all(&state).expect("state");
    std::fs::write(
        state.join("goal-replies.json"),
        json!({ "version": 1, "savedAt": 1, "replies": [
            { "conversationId": CHAT, "sessionId": "s", "replyId": "elsewhere", "turnId": "g-1", "eventSeq": 0, "acceptedAt": support::START, "state": "pending" },
            { "conversationId": OTHER, "sessionId": "s", "replyId": "turn:g-2", "turnId": "g-2", "eventSeq": 0, "acceptedAt": support::START, "state": "pending", "pickupAttempts": 9 },
            { "conversationId": "bad id!", "sessionId": "s", "replyId": "r", "turnId": "t", "eventSeq": 1, "acceptedAt": 1, "state": "pending" }
        ] })
        .to_string(),
    )
    .expect("write");
    std::fs::write(
        state.join("goal-switches.json"),
        json!({ "version": 1, "savedAt": 1, "switches": [
            { "conversationId": CHAT, "enabled": true, "mode": "loop", "at": 0, "afterTurn": true },
            { "conversationId": OTHER, "enabled": true, "mode": "sideways", "at": 5 }
        ] })
        .to_string(),
    )
    .expect("write");
    let world = world.restart().await;
    assert!(
        world.goal.pending_reply_for(CHAT).is_none(),
        "a zero-sequence row needs its exact provisional id"
    );
    let other = world.goal.pending_reply_for(OTHER).expect("kept");
    assert_eq!(other.pickup_attempts, Some(3));
    assert_eq!(
        other.pickup_stopped_at,
        Some(support::START),
        "an exhausted budget restores as stopped"
    );
    let held = world.goal.switch_for(CHAT);
    assert!(held.own && held.enabled && held.after_turn && held.mode == GoalMode::Loop);
    assert!(
        !world.goal.switch_for(OTHER).own,
        "an unknown mode drops the row"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_pickup_budget_stops_after_three_reloads_and_persists() {
    let world = World::new("pickup").await;
    let session = world.record(CHAT, &[support::user("go")]).await;
    world
        .goal
        .accept_reply_now(accept(&session, "g-1", 2))
        .await
        .expect("accepted");
    let reply = world.goal.pending_reply_for(CHAT).expect("owed").reply_id;
    for attempt in 1..=3 {
        let at = support::START + attempt;
        let recorded = world
            .goal
            .record_pickup_attempt_now(CHAT, &reply, at, Some(at + 60_000))
            .await
            .expect("durable");
        assert_eq!(recorded.map(|r| r.0), Some(attempt));
    }
    assert_eq!(
        world
            .goal
            .record_pickup_attempt_now(CHAT, &reply, support::START + 9, None)
            .await
            .expect("read"),
        None
    );
    let world = world.restart().await;
    let pending = world.goal.pending_reply_for(CHAT).expect("owed");
    assert_eq!(
        (pending.pickup_attempts, pending.pickup_stopped_at),
        (Some(3), Some(support::START + 3))
    );
}

#[test]
fn custom_base_urls_are_https_or_loopback_http() {
    let custom = |url: &str| Endpoint {
        kind: GoalProviderKind::Custom,
        base_url: url.to_owned(),
    };
    for (url, resolved) in [
        ("https://api.example.com/v1/", "https://api.example.com/v1"),
        (" http://localhost:11434/v1 ", "http://localhost:11434/v1"),
        ("http://127.0.0.1:8080", "http://127.0.0.1:8080"),
        ("http://[::1]:9000/v1", "http://[::1]:9000/v1"),
    ] {
        assert_eq!(
            resolve_base_url(&custom(url)).as_deref(),
            Ok(resolved),
            "{url}"
        );
    }
    for url in [
        "http://example.com/v1",
        "https://user:pw@example.com",
        "https://example.com/v1?x=1",
        "ftp://localhost/",
    ] {
        assert_eq!(
            resolve_base_url(&custom(url)),
            Err(
                "invalid_provider: custom provider URL must be https, or http on localhost"
                    .to_owned()
            ),
            "{url}"
        );
    }
    assert_eq!(
        resolve_base_url(&custom("not a url")),
        Err("invalid_provider: custom provider URL is invalid".to_owned())
    );
}
