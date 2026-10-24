//! The Compact & Resume transaction, from the cases of `test/continuation.test.ts`: the brief is
//! captured once, one replacement chat claims it, the commit lands completely or leaves the
//! session in chat A, and every phase survives a restart.

mod support;

use cos_continuation::{
    AUTOMATIC_HANDOVER_TTL_MS, CONTINUATION_TTL_MS, CONTINUATION_WRITING_TTL_MS, CommitResult,
    ContinuationSendState as Send, ContinuationState as State, RESUME_CLAIM_WINDOW_MS, handoff,
};
use serde_json::Value;
use support::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn answers_a_repeated_capture_with_the_handoff_it_already_wrote() {
    let profile = Profile::new("repeat");
    let process = start(&profile.0, &Offset::default()).await;
    let session = process.chat_session(CHAT_A).await;
    let opened = process
        .continuations
        .open(&session, CHAT_A, false, None)
        .await
        .unwrap();
    let first = process
        .continuations
        .attach_summary(&opened.token, SAMPLE_BRIEF)
        .await
        .expect("stored");
    let again = process
        .continuations
        .attach_summary(&opened.token, SAMPLE_BRIEF)
        .await
        .expect("answered");
    assert_eq!(again.id, first.id);
    assert_eq!(process.handoffs(&profile, &session), 1);
    let summary = process.sessions.summary(&session).await.unwrap();
    assert_eq!(summary.last_handoff_id.as_deref(), Some(first.id.as_str()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn writes_one_handoff_even_when_two_captures_race() {
    let profile = Profile::new("race");
    let process = start(&profile.0, &Offset::default()).await;
    let session = process.chat_session(CHAT_A).await;
    let opened = process
        .continuations
        .open(&session, CHAT_A, false, None)
        .await
        .unwrap();
    let (first, second) = tokio::join!(
        process
            .continuations
            .attach_summary(&opened.token, SAMPLE_BRIEF),
        process
            .continuations
            .attach_summary(&opened.token, SAMPLE_BRIEF)
    );
    assert_eq!(first.map(|h| h.id), second.map(|h| h.id));
    assert_eq!(process.handoffs(&profile, &session), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn does_not_publish_a_handoff_whose_wal_transition_was_rejected() {
    let profile = Profile::new("wal-rejected");
    let process = start(&profile.0, &Offset::default()).await;
    let session = process.chat_session(CHAT_A).await;
    let opened = process
        .continuations
        .open(&session, CHAT_A, false, None)
        .await
        .unwrap();
    block(&profile.wal());
    assert!(
        process
            .continuations
            .attach_summary(&opened.token, SAMPLE_BRIEF)
            .await
            .is_none()
    );
    assert_eq!(
        process.continuations.for_session(&session).map(|v| v.state),
        Some(State::AwaitingSummary)
    );
    assert_eq!(
        process
            .sessions
            .summary(&session)
            .await
            .unwrap()
            .last_handoff_id,
        None
    );
    unblock(&profile.wal());
    assert!(
        process
            .continuations
            .attach_summary(&opened.token, SAMPLE_BRIEF)
            .await
            .is_some(),
        "the same step can be redone"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_an_empty_or_too_short_brief_and_stays_in_chat_a() {
    let profile = Profile::new("empty");
    let process = start(&profile.0, &Offset::default()).await;
    let session = process.chat_session(CHAT_A).await;
    let opened = process
        .continuations
        .open(&session, CHAT_A, false, None)
        .await
        .unwrap();
    assert!(
        process
            .continuations
            .attach_summary(&opened.token, "   ")
            .await
            .is_none()
    );
    assert!(
        process
            .continuations
            .attach_summary(&opened.token, "TASK\nContinue implementing ")
            .await
            .is_none()
    );
    assert_eq!(process.handoffs(&profile, &session), 0);
    assert_eq!(process.attached(&session).await.as_deref(), Some(CHAT_A));
    assert_eq!(
        process.continuations.for_session(&session).map(|v| v.state),
        Some(State::AwaitingSummary)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn serves_one_claimant_and_refuses_a_second() {
    let profile = Profile::new("claim");
    let process = start(&profile.0, &Offset::default()).await;
    let (_, token) = process.ready().await;
    let claims = &process.continuations;
    assert!(
        claims
            .claim(&token, "tab-1")
            .await
            .unwrap()
            .unwrap()
            .contains(SAMPLE_BRIEF)
    );
    assert_eq!(claims.claim(&token, "tab-2").await.unwrap(), None);
    assert!(
        claims
            .claim(&token, "tab-1")
            .await
            .unwrap()
            .unwrap()
            .contains(SAMPLE_BRIEF)
    );
    assert!(claims.gate().opening_chat(cos_tools::EpochMs::now().0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn commits_the_session_to_chat_b_with_chat_a_as_lineage() {
    let profile = Profile::new("commit");
    let process = start(&profile.0, &Offset::default()).await;
    let (session, token) = process.ready().await;
    process.continuations.claim(&token, "tab-1").await.unwrap();
    let handoff = process.continuations.by_token(&token).unwrap().handoff_id;
    assert_eq!(
        process.continuations.commit(&token, CHAT_B).await,
        CommitResult::Committed(CHAT_B.into())
    );
    let moved = process.sessions.summary(&session).await.unwrap();
    assert_eq!(moved.conversation_id.as_deref(), Some(CHAT_B));
    assert_eq!(moved.chat_ids, vec![CHAT_A.to_owned(), CHAT_B.to_owned()]);
    assert_eq!(moved.context_tokens, 0);
    assert_eq!(moved.last_committed_resume_handoff_id, Some(handoff));
    assert_eq!(
        process.continuations.superseded_sources(),
        vec![CHAT_A.to_owned()]
    );
    assert!(
        !process
            .continuations
            .gate()
            .opening_chat(cos_tools::EpochMs::now().0)
    );
    assert_eq!(
        process.continuations.commit(&token, CHAT_B).await,
        CommitResult::AlreadyCommitted(CHAT_B.into()),
        "a repeated ack is the commit that already landed"
    );
    assert!(matches!(
        process.continuations.commit(&token, CHAT_C).await,
        CommitResult::Rejected(_)
    ));
    let moved = process.sessions.summary(&session).await.unwrap();
    assert_eq!(moved.chat_ids, vec![CHAT_A.to_owned(), CHAT_B.to_owned()]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_a_chat_b_that_is_not_a_distinct_conversation() {
    let profile = Profile::new("distinct");
    let process = start(&profile.0, &Offset::default()).await;
    let (session, token) = process.ready().await;
    process.continuations.claim(&token, "tab-1").await.unwrap();
    assert!(!process.continuations.commit(&token, "").await.landed());
    assert!(!process.continuations.commit(&token, CHAT_A).await.landed());
    assert_eq!(process.attached(&session).await.as_deref(), Some(CHAT_A));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn leaves_the_session_in_chat_a_when_the_durable_write_fails_and_stays_retryable() {
    let profile = Profile::new("rebind-fails");
    let process = start(&profile.0, &Offset::default()).await;
    let (session, token) = process.ready().await;
    process.continuations.claim(&token, "tab-1").await.unwrap();
    process.sessions.flush().await;
    let meta = profile
        .0
        .join("sessions")
        .join(session.as_str())
        .join("meta.json");
    block(&meta);
    assert!(matches!(
        process.continuations.commit(&token, CHAT_B).await,
        CommitResult::Retryable(_)
    ));
    assert_eq!(process.attached(&session).await.as_deref(), Some(CHAT_A));
    assert_eq!(
        process
            .sessions
            .summary(&session)
            .await
            .unwrap()
            .last_committed_resume_handoff_id
            .flatten(),
        None
    );
    assert_eq!(
        process.continuations.by_token(&token).map(|v| v.state),
        Some(State::Claimed)
    );
    unblock(&meta);
    assert_eq!(
        process.continuations.commit(&token, CHAT_B).await,
        CommitResult::Committed(CHAT_B.into())
    );
    assert_eq!(process.attached(&session).await.as_deref(), Some(CHAT_B));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_a_replacement_chat_another_session_already_owns() {
    let profile = Profile::new("collision");
    let process = start(&profile.0, &Offset::default()).await;
    let (session, token) = process.ready().await;
    process.continuations.claim(&token, "tab-1").await.unwrap();
    let chat_b = "0000aaaa-1111-4111-8111-000000000001";
    process.chat_session(chat_b).await;
    assert_eq!(
        process.continuations.commit(&token, chat_b).await,
        CommitResult::Rejected(
            "the replacement chat already belongs to another local session".into()
        )
    );
    assert_eq!(process.attached(&session).await.as_deref(), Some(CHAT_A));
    let view = process.continuations.by_token(&token).unwrap();
    assert_eq!(view.state, State::Claimed);
    assert_eq!(view.to, None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cannot_be_aborted_once_committed_or_while_committing() {
    let profile = Profile::new("abort");
    let process = start(&profile.0, &Offset::default()).await;
    let (_, token) = process.ready().await;
    process.continuations.claim(&token, "tab-1").await.unwrap();
    process.continuations.commit(&token, CHAT_B).await;
    assert!(!process.continuations.abort(&token, "late"));
    assert!(
        !process
            .continuations
            .abort_now(&token, "late")
            .await
            .unwrap()
    );
    assert_eq!(
        process.continuations.by_token(&token).map(|v| v.state),
        Some(State::Committed)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn source_checkpoints_hand_out_the_prompt_once_and_never_replay_a_dispatch() {
    let profile = Profile::new("source");
    let process = start(&profile.0, &Offset::default()).await;
    let session = process.chat_session(CHAT_A).await;
    let c = &process.continuations;
    let opened = c.open(&session, CHAT_A, false, None).await.unwrap();
    let token = opened.token.as_str();
    let first = c.begin_source_send(token, None).await.unwrap().unwrap();
    assert!(first.allowed);
    assert_eq!(first.checkpoint.state, Send::AttemptedUnresolved);
    assert!(
        c.begin_source_send(token, None)
            .await
            .unwrap()
            .unwrap()
            .allowed,
        "reclaimable"
    );
    assert!(
        c.dispatch_source_send(token, Some("prior-user-message"))
            .await
            .unwrap()
    );
    assert!(
        !c.dispatch_source_send(token, None).await.unwrap(),
        "exclusive"
    );
    let after = c.begin_source_send(token, None).await.unwrap().unwrap();
    assert!(!after.allowed);
    assert_eq!(after.checkpoint.state, Send::DispatchedUnresolved);
    assert!(
        !c.abort_source_before_send(token, "handoff_never_sent")
            .await
            .unwrap()
    );
    assert!(
        c.compacting(CHAT_A).is_some(),
        "chat A's tools are fenced once the brief is asked"
    );
    assert!(
        c.bind_source_message(token, "handoff-message", Some(10.0))
            .await
            .unwrap()
    );
    assert!(
        !c.bind_source_message(token, "other-message", None)
            .await
            .unwrap()
    );
    assert_eq!(c.by_token(token).unwrap().source_send.state, Send::Sent);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hands_back_an_armed_click_that_chatgpt_provably_never_received() {
    let profile = Profile::new("undelivered");
    let offset = Offset::default();
    let process = start(&profile.0, &offset).await;
    let session = process.chat_session(CHAT_A).await;
    let c = &process.continuations;
    let token = c.open(&session, CHAT_A, false, None).await.unwrap().token;
    c.begin_source_send(&token, None).await.unwrap();
    c.dispatch_source_send(&token, Some("before"))
        .await
        .unwrap();
    let dispatched_at = c
        .by_token(&token)
        .unwrap()
        .source_send
        .dispatched_at
        .unwrap();
    assert_eq!(
        c.release_undelivered_source(&token, Some("before"), dispatched_at as f64 + 1.0)
            .await
            .unwrap(),
        None,
        "too soon after the click"
    );
    offset.advance(16_000);
    assert_eq!(
        c.release_undelivered_source(&token, Some("other"), dispatched_at as f64 + 1.0)
            .await
            .unwrap(),
        None,
        "a different newest message may be the prompt"
    );
    let released = c
        .release_undelivered_source(&token, Some("before"), dispatched_at as f64 + 1.0)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(released.state, Send::AttemptedUnresolved);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn records_the_resume_message_of_a_chat_whose_first_call_committed_first() {
    let profile = Profile::new("late-message");
    let process = start(&profile.0, &Offset::default()).await;
    let (_, token) = process.ready().await;
    let c = &process.continuations;
    c.claim(&token, "tab-1").await.unwrap();
    assert!(
        c.begin_destination_send(&token)
            .await
            .unwrap()
            .unwrap()
            .allowed
    );
    assert!(c.dispatch_destination_send(&token).await.unwrap());
    assert!(c.commit(&token, CHAT_B).await.landed());
    assert!(
        !c.bind_destination_message(&token, CHAT_A, "resume-message-b")
            .await
            .unwrap()
    );
    assert!(
        !c.bind_destination_message(&token, "some-other-chat", "resume-message-b")
            .await
            .unwrap()
    );
    assert!(
        c.bind_destination_message(&token, CHAT_B, "resume-message-b")
            .await
            .unwrap()
    );
    let view = c.by_token(&token).unwrap();
    assert_eq!(view.state, State::Committed);
    assert_eq!(view.destination_send.send.state, Send::Sent);
    assert_eq!(
        view.destination_send.conversation_id.as_deref(),
        Some(CHAT_B)
    );
    assert!(
        !c.bind_destination_message(&token, CHAT_B, "another")
            .await
            .unwrap()
    );
    assert!(
        c.bind_destination_message(&token, CHAT_B, "resume-message-b")
            .await
            .unwrap()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn releases_an_unsent_destination_claim_so_a_fresh_chat_can_take_it() {
    let profile = Profile::new("release-destination");
    let process = start(&profile.0, &Offset::default()).await;
    let (_, token) = process.ready().await;
    let c = &process.continuations;
    c.claim(&token, "command-1").await.unwrap();
    c.begin_destination_send(&token).await.unwrap();
    c.dispatch_destination_send(&token).await.unwrap();
    assert!(c.release_destination_send(&token, None).await.unwrap());
    let view = c.by_token(&token).unwrap();
    assert_eq!(view.state, State::AwaitingChat);
    assert_eq!(view.destination_send.send.state, Send::NotAttempted);
    assert!(c.claim(&token, "command-2").await.unwrap().is_some());
    c.begin_destination_send(&token).await.unwrap();
    c.dispatch_destination_send(&token).await.unwrap();
    c.bind_destination_message(&token, CHAT_B, "m")
        .await
        .unwrap();
    assert!(
        !c.release_destination_send(&token, None).await.unwrap(),
        "never once sent"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_manual_handoff_that_never_progresses_expires_and_says_why() {
    let profile = Profile::new("expire");
    let offset = Offset::default();
    let process = start(&profile.0, &offset).await;
    let session = process.chat_session(CHAT_A).await;
    let token = process
        .continuations
        .open(&session, CHAT_A, false, None)
        .await
        .unwrap()
        .token;
    offset.advance(CONTINUATION_WRITING_TTL_MS);
    assert_eq!(process.continuations.for_session(&session), None);
    process.continuations.flush();
    assert_eq!(
        wal_entry(&profile, &token)["error"],
        "it took too long and was given up on"
    );
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let notes = process
        .sessions
        .recent_events(&session, 10, &["note"])
        .await
        .unwrap();
    assert_eq!(notes.len(), 1, "the abandonment is recorded in the session");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn keeps_an_automatic_ticket_open_until_it_is_asked_for() {
    let profile = Profile::new("automatic");
    let offset = Offset::default();
    let process = start(&profile.0, &offset).await;
    let session = process.chat_session(CHAT_A).await;
    let token = process
        .continuations
        .open(&session, CHAT_A, true, None)
        .await
        .unwrap()
        .token;
    offset.advance(CONTINUATION_WRITING_TTL_MS * 3);
    assert!(process.continuations.for_session(&session).is_some());
    process.stop().await;
    let restarted = start(&profile.0, &offset).await;
    assert!(
        restarted.continuations.for_session(&session).is_some(),
        "survives a restart"
    );
    let c = &restarted.continuations;
    c.begin_source_send(&token, None).await.unwrap();
    c.dispatch_source_send(&token, None).await.unwrap();
    offset.advance(AUTOMATIC_HANDOVER_TTL_MS);
    assert_eq!(c.for_session(&session), None);
    c.flush();
    assert_eq!(
        wal_entry(&profile, &token)["error"],
        "the handover never landed and was given up on"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_automatic_abort_refuses_its_turn_and_a_manual_one_does_not() {
    let profile = Profile::new("refusal");
    let process = start(&profile.0, &Offset::default()).await;
    let session = process.chat_session(CHAT_A).await;
    let ticket = process
        .continuations
        .open(&session, CHAT_A, true, None)
        .await
        .unwrap();
    assert!(
        process
            .continuations
            .abort_source_before_send(&ticket.token, "handoff_never_sent")
            .await
            .unwrap()
    );
    let refusal = process
        .sessions
        .summary(&session)
        .await
        .unwrap()
        .auto_compaction_refusal
        .expect("refused");
    assert_eq!(refusal.conversation_id, CHAT_A);

    let (manual, token) = process.ready_in(CHAT_B).await;
    assert!(
        process
            .continuations
            .abort_now(&token, "cancelled")
            .await
            .unwrap()
    );
    assert!(
        process
            .sessions
            .summary(&manual)
            .await
            .unwrap()
            .auto_compaction_refusal
            .is_none()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stores_a_fingerprint_of_the_token_in_the_handoff_never_the_token() {
    let profile = Profile::new("fingerprint");
    let process = start(&profile.0, &Offset::default()).await;
    let (session, token) = process.ready().await;
    let id = process
        .continuations
        .by_token(&token)
        .unwrap()
        .handoff_id
        .unwrap();
    let bytes = std::fs::read_to_string(
        profile
            .0
            .join("sessions")
            .join(session.as_str())
            .join("handoffs")
            .join(format!("{id}.json")),
    )
    .unwrap();
    assert!(!bytes.contains(&token));
    let stored: Value = serde_json::from_str(&bytes).unwrap();
    assert_eq!(
        stored["provenance"]["continuationId"].as_str(),
        handoff::continuation_id(&token).as_deref()
    );
    assert_eq!(stored["provenance"]["sourceConversationId"], CHAT_A);
    assert_eq!(stored["provenance"]["sourceGeneration"], 1);
    assert_eq!(stored["version"], 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reopens_chat_b_from_a_saved_summary_through_the_ordinary_claim_and_commit() {
    let profile = Profile::new("reopen");
    let process = start(&profile.0, &Offset::default()).await;
    let (session, token) = process.ready().await;
    let saved = process
        .continuations
        .by_token(&token)
        .unwrap()
        .handoff_id
        .unwrap();
    process
        .continuations
        .abort_now(&token, "cancelled")
        .await
        .unwrap();
    let reopened = process
        .continuations
        .reopen_with_handoff(&session, &saved)
        .await
        .expect("reopened");
    assert_ne!(reopened.token, token);
    assert_eq!(reopened.state, State::AwaitingChat);
    assert_eq!(reopened.source_send.state, Send::Sent);
    assert_ne!(reopened.handoff_id.as_deref(), Some(saved.as_str()));
    assert!(
        process
            .continuations
            .reopen_with_handoff(&session, &saved)
            .await
            .is_none(),
        "refused while a run is open, and for an older summary"
    );
    process
        .continuations
        .claim(&reopened.token, "tab")
        .await
        .unwrap();
    assert!(
        process
            .continuations
            .commit(&reopened.token, CHAT_B)
            .await
            .landed()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gate_expires_on_its_own_but_holds_a_dispatched_claim() {
    let gate = cos_continuation::ResumeGate::default();
    gate.note_claim("token-a", 1_000);
    assert!(gate.opening_chat(1_000 + RESUME_CLAIM_WINDOW_MS));
    assert!(!gate.opening_chat(1_001 + RESUME_CLAIM_WINDOW_MS));
    gate.note_dispatch("token-b", 1_000);
    assert!(gate.opening_chat(10 * RESUME_CLAIM_WINDOW_MS));
    gate.end("token-b");
    assert!(!gate.opening_chat(10 * RESUME_CLAIM_WINDOW_MS));
}

/// Every phase of the happy path, a crash right after it, and the restart that follows.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_phase_survives_a_restart_and_the_move_completes_afterwards() {
    for crash_after in 0..=9 {
        let profile = Profile::new(&format!("phase-{crash_after}"));
        let offset = Offset::default();
        let mut process = start(&profile.0, &offset).await;
        let session = process.chat_session(CHAT_A).await;
        let token = process
            .continuations
            .open(&session, CHAT_A, false, None)
            .await
            .unwrap()
            .token;
        let mut done = 0;
        let steps = 9;
        while done < steps {
            if done == crash_after {
                process.stop().await;
                process = start(&profile.0, &offset).await;
                let view = process.continuations.by_token(&token).expect("restored");
                assert_ne!(view.state, State::Aborted, "phase {crash_after}: {view:?}");
            }
            let c = &process.continuations;
            let ok = match done {
                0 => c
                    .begin_source_send(&token, None)
                    .await
                    .unwrap()
                    .is_some_and(|s| s.allowed),
                1 => c
                    .dispatch_source_send(&token, Some("before"))
                    .await
                    .unwrap(),
                2 => c
                    .bind_source_message(&token, "handoff-message", None)
                    .await
                    .unwrap(),
                3 => c.attach_summary(&token, SAMPLE_BRIEF).await.is_some(),
                4 => c.claim(&token, "command-1").await.unwrap().is_some(),
                5 => c
                    .begin_destination_send(&token)
                    .await
                    .unwrap()
                    .is_some_and(|s| s.allowed),
                6 => c.dispatch_destination_send(&token).await.unwrap(),
                7 => c
                    .bind_destination_message(&token, CHAT_B, "resume-message")
                    .await
                    .unwrap(),
                _ => c.commit(&token, CHAT_B).await.landed(),
            };
            assert!(ok, "phase {crash_after}: step {done} after the restart");
            done += 1;
        }
        if crash_after == 9 {
            process.stop().await;
            process = start(&profile.0, &offset).await;
        }
        let view = process.continuations.by_token(&token).unwrap();
        assert_eq!(view.state, State::Committed, "phase {crash_after}");
        assert_eq!(process.attached(&session).await.as_deref(), Some(CHAT_B));
        assert_eq!(
            process.handoffs(&profile, &session),
            1,
            "phase {crash_after}"
        );
        let handoffs = process
            .sessions
            .recent_events(&session, 10, &["handoff"])
            .await
            .unwrap();
        assert_eq!(handoffs.len(), 1, "phase {crash_after}: one handoff event");
    }
}

/// A crash inside the commit: the intent landed, and the session either moved or did not.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restart_resolves_a_committing_record_from_the_session_itself() {
    for moved in [false, true] {
        let profile = Profile::new(&format!("committing-{moved}"));
        let offset = Offset::default();
        let process = start(&profile.0, &offset).await;
        let (session, token) = process.ready().await;
        process
            .continuations
            .claim(&token, "command-1")
            .await
            .unwrap();
        let handoff = process.continuations.by_token(&token).unwrap().handoff_id;
        process.stop().await;
        let mut wal: Value =
            serde_json::from_str(&std::fs::read_to_string(profile.wal()).unwrap()).unwrap();
        wal["entries"][0]["state"] = "committing".into();
        wal["entries"][0]["to"] = CHAT_B.into();
        std::fs::write(profile.wal(), serde_json::to_vec(&wal).unwrap()).unwrap();
        if moved {
            assert!(
                process
                    .sessions
                    .rebind_session(&session, Some(CHAT_A), CHAT_B, None)
                    .await
            );
            process.sessions.flush().await;
        }
        drop(process);
        let restarted = start(&profile.0, &offset).await;
        let view = restarted.continuations.by_token(&token).unwrap();
        let summary = restarted.sessions.summary(&session).await.unwrap();
        if moved {
            assert_eq!(view.state, State::Committed);
            assert_eq!(summary.conversation_id.as_deref(), Some(CHAT_B));
            assert_eq!(
                summary.last_committed_resume_handoff_id,
                Some(handoff),
                "recovery names the handoff that carried the move"
            );
        } else {
            assert_eq!(view.state, State::Claimed);
            assert_eq!(view.to, None);
            assert_eq!(
                view.error.as_deref(),
                Some("Recovered before the durable session move; the continuation can be retried.")
            );
            assert_eq!(summary.conversation_id.as_deref(), Some(CHAT_A));
        }
        let on_disk: Value =
            serde_json::from_str(&std::fs::read_to_string(profile.wal()).unwrap()).unwrap();
        assert_eq!(
            on_disk["entries"][0]["state"],
            if moved { "committed" } else { "claimed" },
            "restore writes the repaired snapshot"
        );
        assert!(
            restarted
                .continuations
                .commit(&token, CHAT_B)
                .await
                .landed()
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn does_not_revive_an_expired_waiting_continuation_after_restart() {
    let profile = Profile::new("expired-restart");
    let offset = Offset::default();
    let process = start(&profile.0, &offset).await;
    let (_, token) = process.ready().await;
    process.stop().await;
    offset.advance(CONTINUATION_TTL_MS + 1);
    let restarted = start(&profile.0, &offset).await;
    let view = restarted.continuations.by_token(&token).unwrap();
    assert_eq!(view.state, State::Aborted);
    assert_eq!(
        view.error.as_deref(),
        Some("Recovery found the continuation had already expired.")
    );
    offset.advance(CONTINUATION_TTL_MS * 2);
    let again = start(&profile.0, &offset).await;
    assert_eq!(
        again.continuations.by_token(&token),
        None,
        "forgotten after twice the TTL"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn aborts_a_restart_whose_saved_handoff_belongs_to_another_continuation() {
    let profile = Profile::new("provenance");
    let offset = Offset::default();
    let process = start(&profile.0, &offset).await;
    let (_, token) = process.ready().await;
    process.stop().await;
    let mut wal: Value =
        serde_json::from_str(&std::fs::read_to_string(profile.wal()).unwrap()).unwrap();
    wal["entries"][0]["token"] = "another-token-of-sixteen".into();
    std::fs::write(profile.wal(), serde_json::to_vec(&wal).unwrap()).unwrap();
    let restarted = start(&profile.0, &offset).await;
    assert_eq!(restarted.continuations.by_token(&token), None);
    let view = restarted
        .continuations
        .by_token("another-token-of-sixteen")
        .unwrap();
    assert_eq!(view.state, State::Aborted);
    assert_eq!(
        view.error.as_deref(),
        Some("The saved handoff belongs to a different continuation.")
    );
}

#[test]
fn a_brief_that_cannot_be_the_whole_handoff_is_refused() {
    assert!(handoff::brief_shortfall("", 0).is_some());
    assert_eq!(
        handoff::brief_shortfall("TASK\nContinue implementing ", 318_422).as_deref(),
        Some(
            "ChatGPT wrote only 26 characters before its compaction turn looked finished, which is too little to continue any session from."
        )
    );
    let plausible = "x".repeat(600);
    assert_eq!(
        handoff::brief_shortfall(&plausible, 318_422).as_deref(),
        Some(
            "The brief is 600 characters for a session carrying about 318k tokens of work, so it cannot be the whole handoff."
        )
    );
    assert_eq!(handoff::brief_shortfall(&plausible, 1_000), None);
    assert_eq!(handoff::brief_shortfall(SAMPLE_BRIEF, 318_422), None);
}

impl Process {
    async fn ready_in(&self, conversation: &str) -> (cos_types::ids::SessionId, String) {
        let session = self.chat_session(conversation).await;
        let opened = self
            .continuations
            .open(&session, conversation, false, None)
            .await
            .unwrap();
        self.continuations
            .attach_summary(&opened.token, SAMPLE_BRIEF)
            .await
            .unwrap();
        (session, opened.token)
    }
}

fn wal_entry(profile: &Profile, token: &str) -> Value {
    let wal: Value =
        serde_json::from_str(&std::fs::read_to_string(profile.wal()).unwrap()).unwrap();
    wal["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["token"] == token)
        .cloned()
        .unwrap_or(Value::Null)
}
