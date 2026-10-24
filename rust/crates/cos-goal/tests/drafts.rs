//! One draft per finished turn, against a loopback provider that answers recorded replies.
//! Cases from `test/goal.test.ts` ("the reply", "one draft per generation", "when OpenRouter
//! refuses", "a custom OpenAI-compatible provider", "the loop that never stops").

mod support;

use cos_goal::{AcceptReply, DraftStart};
use cos_secrets::SecretKey;
use cos_types::bridge::GoalStage;
use cos_types::config::{GoalMode, GoalProviderKind, GoalReasoning};
use serde_json::json;
use support::{CHAT, Canned, World, answer, user};

async fn recorded(name: &str) -> (World, String) {
    let world = World::new(name).await;
    let session = world
        .record(
            CHAT,
            &[
                user("fix the parser and run the tests"),
                answer("I fixed the parser.", "g-1", "m-1"),
            ],
        )
        .await;
    (world, session)
}

fn start(session: &str, turn: &str) -> DraftStart {
    DraftStart {
        session_id: session.to_owned(),
        conversation_id: CHAT.to_owned(),
        turn_id: turn.to_owned(),
        client_id: "tab-1".to_owned(),
        defer_start: false,
    }
}

async fn draft(world: &World, session: &str, turn: &str) -> cos_types::bridge::GoalDraftView {
    world.goal.start_draft(start(session, turn)).expect("draft");
    world.settled(CHAT).await.expect("a view")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_strict_continuation_is_typed_with_its_wrappers_removed() {
    let (world, session) = recorded("strict").await;
    world.stub.reply(Canned::decision(
        "continue",
        "<|im_start|>what about the tests<|im_end|>",
    ));
    let view = draft(&world, &session, "g-1").await;
    assert_eq!(view.stage, GoalStage::Ready);
    assert_eq!(
        view.reply, "what about the tetss",
        "one slip, never in a short word"
    );
    assert_eq!(view.error, None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_same_turn_is_asked_once_and_answered_with_the_draft_that_exists() {
    let (world, session) = recorded("once").await;
    world.stub.reply(Canned::decision("continue", "keep going"));
    let first = draft(&world, &session, "g-1").await;
    let again = world
        .goal
        .start_draft(start(&session, "g-1"))
        .expect("same draft");
    assert_eq!(again.token, first.token);
    assert_eq!(world.stub.seen().len(), 1, "one provider request per turn");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn another_tab_cannot_take_an_unspent_draft() {
    let (world, session) = recorded("owner").await;
    world.stub.reply(Canned::decision("continue", "keep going"));
    draft(&world, &session, "g-1").await;
    let mut other = start(&session, "g-2");
    other.client_id = "tab-2".to_owned();
    assert!(world.goal.start_draft(other).is_err());
    assert!(world.goal.view_for(CHAT, Some("tab-2")).is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn goal_met_sends_nothing_and_discharges_the_owed_turn() {
    let (world, session) = recorded("met").await;
    world
        .goal
        .accept_reply_now(AcceptReply {
            conversation_id: CHAT.to_owned(),
            session_id: session.clone(),
            reply_id: "turn:g-1".to_owned(),
            turn_id: "g-1".to_owned(),
            ..AcceptReply::default()
        })
        .await
        .expect("accepted");
    assert!(world.goal.pending_reply_for(CHAT).is_some());
    world.stub.reply(Canned::decision("stop", ""));
    let view = draft(&world, &session, "g-1").await;
    assert_eq!(view.stage, GoalStage::NoReply);
    assert_eq!(view.reply, "");
    assert!(
        world.goal.pending_reply_for(CHAT).is_none(),
        "no page needs to acknowledge"
    );
    assert!(
        world.goal.outcome_for(CHAT).is_none(),
        "not acknowledged yet"
    );
    assert!(world.goal.ack_draft(CHAT, &view.token, Some("tab-1")));
    assert_eq!(
        world.goal.outcome_for(CHAT).map(|v| v.stage),
        Some(GoalStage::NoReply)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_continuation_keeps_the_turn_owed_until_the_page_acknowledges_it() {
    let (world, session) = recorded("owed").await;
    world
        .goal
        .accept_reply_now(AcceptReply {
            conversation_id: CHAT.to_owned(),
            session_id: session.clone(),
            reply_id: "turn:g-1".to_owned(),
            turn_id: "g-1".to_owned(),
            ..AcceptReply::default()
        })
        .await
        .expect("accepted");
    world
        .stub
        .reply(Canned::decision("continue", "now write the docs"));
    let view = draft(&world, &session, "g-1").await;
    assert_eq!(view.stage, GoalStage::Ready);
    assert!(world.goal.pending_reply_for(CHAT).is_some());
    assert!(
        world
            .goal
            .ack_draft_now(CHAT, &view.token, Some("tab-1"))
            .await
            .expect("durable")
    );
    assert!(world.goal.pending_reply_for(CHAT).is_none());
    assert!(
        world.goal.view_for(CHAT, Some("tab-1")).is_none(),
        "an acted-on draft is not offered again"
    );
    let ledger = world.state_file("goal-replies").expect("written");
    assert_eq!(ledger["replies"][0]["state"], "handled");
    assert_eq!(ledger["replies"][0]["replyId"], "turn:g-1");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn legacy_prose_around_the_stop_word_fails_closed_to_stop() {
    let (world, session) = recorded("legacy").await;
    world.stub.reply(Canned::sse(&[
        "data: {\"choices\":[{\"delta\":{\"content\":\"Counting flush: \"}}]}\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"NO_REPLY\"}}]}\n",
        "data: [DONE]\n",
    ]));
    assert_eq!(
        draft(&world, &session, "g-1").await.stage,
        GoalStage::NoReply
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stream_split_mid_line_and_closed_without_a_newline_keeps_every_token() {
    let (world, session) = recorded("split").await;
    world.stub.reply(Canned::sse(&[
        "data: {\"choices\":[{\"delta\":{\"content\":\"{\\\"action\\\":\\\"continue\\\",\"}}]}\n",
        ": keep-alive\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"\\\"reply\\\":\\\"ok go\\\"}\"}}]}",
    ]));
    let view = draft(&world, &session, "g-1").await;
    assert_eq!(
        (view.stage, view.reply.as_str()),
        (GoalStage::Ready, "ok go")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn records_after_done_are_ignored_and_a_streamed_error_fails_the_draft() {
    let (world, session) = recorded("done").await;
    world.stub.reply(Canned::sse(&[
        "data: {\"choices\":[{\"delta\":{\"content\":\"{\\\"action\\\":\\\"continue\\\",\\\"reply\\\":\\\"go on\\\"}\"}}]}\n",
        "data: [DONE]\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"junk\"}}]}\n",
    ]));
    assert_eq!(draft(&world, &session, "g-1").await.reply, "go on");
    world.stub.reply(Canned::sse(&[
        "data: {\"choices\":[{\"delta\":{\"content\":\"half a sen\"}}]}\n",
        "data: {\"error\":{\"message\":\"upstream\\nfailed\"}}\n",
    ]));
    let failed = draft(&world, &session, "g-2").await;
    assert_eq!(failed.stage, GoalStage::Failed);
    assert_eq!(
        failed.error.as_deref(),
        Some("request_failed: provider_stream_error: upstream failed")
    );
    assert!(failed.retryable);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unusable_answers_are_failures_not_messages() {
    let cases = [
        (
            Canned::decision("continue", "<|im_start|><|im_end|>"),
            "control_tokens_only",
        ),
        (
            Canned::completion("{\"action\":\"continue\",\"reply\":\"x\",\"extra\":1}"),
            "invalid_goal_decision_schema",
        ),
        (
            Canned::completion("I think {not json} works"),
            "invalid_goal_decision_json",
        ),
        (Canned::completion("   "), "empty_reply"),
        (
            Canned::json(json!({ "choices": [] })),
            "request_failed: malformed_completion_response",
        ),
    ];
    let (world, session) = recorded("unusable").await;
    for (turn, (canned, error)) in cases.into_iter().enumerate() {
        world.stub.reply(canned);
        let view = draft(&world, &session, &format!("g-{turn}")).await;
        assert_eq!(view.stage, GoalStage::Failed, "{error}");
        assert_eq!(view.error.as_deref(), Some(error));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_decision_is_read_from_behind_a_reasoning_block_a_fence_or_a_sentence() {
    let wrapped = [
        "<think>count the items</think>{\"action\":\"continue\",\"reply\":\"next step\"}",
        "```json\n{\"action\":\"continue\",\"reply\":\"next step\"}\n```",
        "Here it is: {\"action\":\"continue\",\"reply\":\"next step\"} done.",
    ];
    let (world, session) = recorded("wrapped").await;
    for (turn, content) in wrapped.into_iter().enumerate() {
        world.stub.reply(Canned::completion(content));
        let view = draft(&world, &session, &format!("w-{turn}")).await;
        assert_eq!(view.reply, "next step", "{content}");
    }
    for (turn, stop) in ["NO_REPLY", "no reply.", "No-Reply!"]
        .into_iter()
        .enumerate()
    {
        world.stub.reply(Canned::decision("continue", stop));
        assert_eq!(
            draft(&world, &session, &format!("s-{turn}")).await.stage,
            GoalStage::NoReply,
            "{stop}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refusal_names_the_reason_and_a_settings_failure_stays_on_screen() {
    let (world, session) = recorded("refused").await;
    world.stub.reply(Canned::status(
        401,
        json!({ "error": { "message": "No auth credentials found" } }),
    ));
    let view = draft(&world, &session, "g-1").await;
    assert_eq!(
        view.error.as_deref(),
        Some("auth_rejected: No auth credentials found")
    );
    assert!(!view.retryable);
    assert_eq!(view.message_key, Some(Some("auth_rejected".to_owned())));
    assert!(world.goal.ack_draft(CHAT, &view.token, Some("tab-1")));
    assert_eq!(
        world
            .goal
            .view_for(CHAT, Some("tab-1"))
            .and_then(|v| v.error),
        Some("auth_rejected: No auth credentials found".to_owned()),
        "#584: a settled failure is still the chat's Goal state"
    );
    let same = world
        .goal
        .start_draft(start(&session, "g-1"))
        .expect("view");
    assert_eq!(
        same.token, view.token,
        "a settings failure is not paid for again"
    );

    world.stub.reply(Canned::status(
        429,
        json!({ "error": { "message": "Provider returned error" } }),
    ));
    let limited = draft(&world, &session, "g-2").await;
    assert_eq!(
        limited.error.as_deref(),
        Some("rate_limited: Provider returned error")
    );
    assert!(limited.retryable);
    assert!(world.goal.ack_draft(CHAT, &limited.token, Some("tab-1")));
    world.stub.reply(Canned::decision("continue", "try again"));
    let retried = draft(&world, &session, "g-2").await;
    assert_ne!(
        retried.token, limited.token,
        "a retired weather failure draws a new draft"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openrouter_without_a_key_refuses_before_spending_anything() {
    let (world, session) = recorded("nokey").await;
    world.configure(|config| config.goal.provider.kind = GoalProviderKind::Openrouter);
    assert!(!world.goal.key_present(GoalMode::Goal).await);
    let view = draft(&world, &session, "g-1").await;
    assert_eq!(view.error.as_deref(), Some("no_api_key"));
    assert!(world.stub.seen().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nothing_recorded_to_continue_from_fails_settled_unless_the_chat_has_a_goal() {
    let world = World::new("empty").await;
    let session = world
        .record(CHAT, &[answer("orphan prose", "g-1", "m-1")])
        .await;
    let view = draft(&world, &session, "g-1").await;
    assert_eq!(view.error.as_deref(), Some("no_conversation"));
    assert!(world.stub.seen().is_empty());

    world
        .goal
        .set_objective_now(CHAT, "  ship the parser  ")
        .await
        .expect("saved");
    world
        .stub
        .reply(Canned::decision("continue", "Build the parser"));
    let view = draft(&world, &session, "g-2").await;
    assert_eq!(view.stage, GoalStage::Ready);
    let sent = &world.stub.seen()[0].body;
    let system: Vec<&str> = sent["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .filter(|m| m["role"] == "system")
        .filter_map(|m| m["content"].as_str())
        .collect();
    assert!(
        system.iter().any(|s| s.ends_with("\n\nship the parser")),
        "the goal itself is in the prompt"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_custom_keyless_provider_gets_plain_chat_completions() {
    let (world, session) = recorded("custom").await;
    world.stub.reply(Canned::decision("continue", "go"));
    draft(&world, &session, "g-1").await;
    let seen = world.stub.seen().remove(0);
    assert_eq!(seen.path, "/v1/chat/completions");
    assert_eq!(seen.header("authorization"), None, "keyless");
    assert_eq!(seen.header("x-title"), None);
    for vendor in ["provider", "plugins", "reasoning", "reasoning_effort"] {
        assert!(seen.body.get(vendor).is_none(), "{vendor}");
    }
    assert_eq!(seen.body["stream"], true);
    assert_eq!(seen.body["model"], "deepseek/deepseek-v4-flash");
    let messages = seen.body["messages"].as_array().expect("messages");
    let transcript = messages[messages.len() - 2]["content"]
        .as_str()
        .expect("transcript");
    assert!(transcript.ends_with(
        "\n\n[{\"role\":\"user\",\"content\":\"fix the parser and run the tests\"},{\"role\":\"assistant\",\"content\":\"I fixed the parser.\"}]"
    ));
    assert_eq!(
        seen.body["response_format"]["json_schema"]["schema"]["properties"]["action"]["enum"],
        json!(["stop", "continue"])
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openrouter_gets_its_key_attribution_and_excluded_reasoning() {
    let (world, session) = recorded("openrouter").await;
    world.configure(|config| {
        config.goal.provider.kind = GoalProviderKind::Openrouter;
        config.goal.reasoning = GoalReasoning::High;
    });
    world.set_key(SecretKey::OpenRouterApiKey, "sk-or-test");
    world.stub.reply(Canned::decision("continue", "go"));
    draft(&world, &session, "g-1").await;
    let seen = world.stub.seen().remove(0);
    assert_eq!(seen.header("authorization"), Some("Bearer sk-or-test"));
    assert_eq!(seen.header("x-title"), Some("Chat On Steroids"));
    assert_eq!(
        seen.header("http-referer"),
        Some("https://github.com/chat-on-steroids")
    );
    assert_eq!(seen.body["provider"], json!({ "require_parameters": true }));
    assert_eq!(
        seen.body["reasoning"],
        json!({ "effort": "high", "exclude": true })
    );
    assert!(
        seen.body.get("plugins").is_none(),
        "streaming requests get no response healing"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_invalid_custom_url_fails_settled_and_sends_nothing() {
    let (world, session) = recorded("badurl").await;
    world.configure(|config| config.goal.provider.base_url = "http://example.com/v1".to_owned());
    let view = draft(&world, &session, "g-1").await;
    assert_eq!(
        view.error.as_deref(),
        Some("invalid_provider: custom provider URL must be https, or http on localhost")
    );
    assert!(!view.retryable);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_loop_asks_again_when_it_tries_to_stop_and_uses_what_it_writes_next() {
    let world = World::new("loop-open").await;
    world.configure(|config| config.goal.loop_backend = Some(cos_types::config::LoopBackend::Api));
    world.stub.reply(Canned::decision("stop", ""));
    world
        .stub
        .reply(Canned::decision("continue", "Begin the rewrite"));
    let (reply, model) = world
        .goal
        .draft_opening("rewrite it", Some(GoalMode::Loop))
        .await
        .expect("opened");
    assert_eq!(model, "deepseek/deepseek-v4-flash");
    assert_eq!(reply, "Begin the rewirte");
    let seen = world.stub.seen();
    assert_eq!(seen.len(), 2);
    let retry_system: Vec<String> = seen[1].body["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .filter(|m| m["role"] == "system")
        .filter_map(|m| m["content"].as_str().map(str::to_owned))
        .collect();
    assert!(
        retry_system
            .iter()
            .any(|s| s.starts_with("Loop requires a continuation."))
    );
    assert_eq!(
        seen[0].body["response_format"]["json_schema"]["schema"]["properties"]["action"]["enum"],
        json!(["continue"])
    );

    for _ in 0..3 {
        world.stub.reply(Canned::decision("stop", ""));
    }
    let refused = world
        .goal
        .draft_opening("rewrite it", Some(GoalMode::Loop))
        .await;
    assert_eq!(
        refused.map_err(|f| f.error),
        Err("nothing_to_open_with".to_owned())
    );
    assert_eq!(world.stub.seen().len(), 5, "three attempts, then give up");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_opening_refusal_keeps_its_retry_classification() {
    let world = World::new("open-refused").await;
    let mut limited = Canned::status(
        429,
        json!({ "error": { "message": "Provider returned error" } }),
    );
    limited.headers.push(("retry-after", "2".to_owned()));
    world.stub.reply(limited);
    let failure = world
        .goal
        .draft_opening("rewrite the parser in rust", None)
        .await
        .expect_err("refused");
    assert_eq!(failure.error, "rate_limited: Provider returned error");
    assert_eq!(failure.retryable, Some(true));
    assert_eq!(failure.retry_after_ms, Some(2000));
    assert_eq!(
        world
            .goal
            .draft_opening("   ", None)
            .await
            .map_err(|f| f.error),
        Err("no_objective".to_owned())
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_spent_generation_stays_spent_after_its_payload_ages_out() {
    let (world, session) = recorded("ttl").await;
    world.stub.reply(Canned::decision("continue", "keep going"));
    let view = draft(&world, &session, "g-1").await;
    world.advance(10 * 60_000 + 1);
    assert!(
        world.goal.view_for(CHAT, Some("tab-1")).is_none(),
        "the payload expired"
    );
    let again = world
        .goal
        .start_draft(start(&session, "g-1"))
        .expect("tombstone");
    assert_eq!(again.token, view.token);
    assert_eq!(again.reply, "", "nothing to type a second time");
    assert_eq!(world.stub.seen().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn master_off_retires_drafts_and_discharges_owed_replies() {
    let (world, session) = recorded("master").await;
    world
        .goal
        .accept_reply_now(AcceptReply {
            conversation_id: CHAT.to_owned(),
            session_id: session.clone(),
            reply_id: "turn:g-1".to_owned(),
            turn_id: "g-1".to_owned(),
            ..AcceptReply::default()
        })
        .await
        .expect("accepted");
    world.stub.reply(Canned::decision("continue", "keep going"));
    draft(&world, &session, "g-1").await;
    assert_eq!(world.goal.retire_drafts(true), 1);
    assert!(world.goal.view_for(CHAT, None).is_none());
    assert!(world.goal.pending_reply_for(CHAT).is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_finish_owner_gets_one_decision_through_its_port() {
    use cos_goal::FinishGoal;
    let (world, session) = recorded("finish").await;
    let finish: &dyn FinishGoal = &world.goal;
    assert!(finish.automatic(CHAT));
    assert_eq!(finish.driving(CHAT), (GoalMode::Goal, String::new()));

    world
        .stub
        .reply(Canned::decision("continue", "now run the tests"));
    let next = finish.followup(session.clone(), None, GoalMode::Goal).await;
    assert_eq!(
        next,
        Ok(Some("now run the tests".to_owned())),
        "typed as written, no slips"
    );
    world.stub.reply(Canned::decision("stop", ""));
    assert_eq!(
        finish.followup(session.clone(), None, GoalMode::Goal).await,
        Ok(None)
    );

    let mut limited = Canned::status(429, json!({ "error": { "message": "slow down" } }));
    limited.headers.push(("retry-after", "3".to_owned()));
    world.stub.reply(limited);
    world.configure(|config| config.goal.provider.kind = GoalProviderKind::Openrouter);
    world.set_key(SecretKey::OpenRouterApiKey, "sk-or-test");
    let failure = finish
        .followup(session.clone(), None, GoalMode::Goal)
        .await
        .expect_err("refused");
    assert_eq!(
        (
            failure.error.as_str(),
            failure.retryable,
            failure.retry_after_ms
        ),
        ("rate_limited: slow down", true, Some(3000))
    );

    world.configure(|config| config.goal.loop_backend = Some(cos_types::config::LoopBackend::Api));
    assert_eq!(
        finish.followup(session, None, GoalMode::Loop).await,
        Ok(None),
        "Loop continues only from a turn with recorded MCP work"
    );
    assert_eq!(world.stub.seen().len(), 3);
}
