//! The Desktop invocation boundary of `test/tools-browser.test.ts`, through the real kernel:
//! listing, permission, identity, the late checks a queued command carries, argument
//! refinements and result shapes.

mod support;

use std::sync::Arc;

use cos_types::mcp::{BrowserImage, BrowserResult, BrowserTool, ImageMimeType};
use serde_json::{Value, json};
use support::{BROWSER, Served, chat, first_text, ok};

const TAB: &str = "11111111-1111-4111-8111-111111111111:12";
const PAGE: &str = "22222222-2222-4222-8222-222222222222";
const SESSION: &str = "session-a";
const CONVERSATION: &str = "chat-a-0001";

fn unattributed_allowed(config: &mut cos_types::config::Config) {
    config.multi_agent.allow_unattributed_calls = true;
}

fn is_error(result: &Value) -> bool {
    result["isError"] == json!(true)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn admits_bounded_dom_inspection_with_screen_permission_alone() {
    let served = Arc::new(Served::new("dom", |config| {
        unattributed_allowed(config);
        config.capabilities.control = false;
    }));
    served.connect();
    let call = served.spawn_call(
        "browser_snapshot",
        json!({ "tabId": TAB, "mode": "inspect", "format": "dom", "selector": "main", "maxNodes": 30, "maxChars": 4000 }),
        None,
    );
    let (command, epoch) = served.claim_next().await;
    assert_eq!(command.tool, BrowserTool::Snapshot);
    for (key, value) in [
        ("format", json!("dom")),
        ("selector", json!("main")),
        ("maxNodes", json!(30)),
        ("maxChars", json!(4000)),
        ("tabId", json!(12)),
    ] {
        assert_eq!(command.args.get(key), Some(&value), "{key}");
    }
    served.answer(&command, &epoch, ok(json!({ "text": "page" })));
    let result = call.await.unwrap().unwrap();
    assert!(!is_error(&result), "{result}");

    for refused in [
        json!({ "tabId": TAB, "format": "script" }),
        json!({ "tabId": TAB, "format": "dom", "maxChars": 24001 }),
    ] {
        let result = served.call("browser_snapshot", refused).await.unwrap();
        assert!(
            first_text(&result).starts_with("Input validation error: "),
            "{result}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn applies_the_live_input_permission_to_new_and_close_tabs() {
    let served = Arc::new(Served::new("tabs-policy", |config| {
        unattributed_allowed(config);
        config.capabilities.control = false;
    }));
    served.connect();
    let list = served.spawn_call("browser_tabs", json!({ "action": "list" }), None);
    let (command, epoch) = served.claim_next().await;
    served.answer(&command, &epoch, ok(json!({ "tabs": [] })));
    assert!(!is_error(&list.await.unwrap().unwrap()));
    for arguments in [
        json!({ "action": "new" }),
        json!({ "action": "close", "tabId": TAB }),
    ] {
        let result = served.call("browser_tabs", arguments).await.unwrap();
        assert_eq!(
            first_text(&result),
            "TOOL_DISABLED: browser_tabs requires the \"Control mouse and keyboard\" permission. Ask the user to enable \"Control mouse and keyboard\" in the app, then retry."
        );
    }
    let broker = served.control.broker();
    assert!(
        broker
            .poll(BROWSER, "Test Chrome", true)
            .unwrap()
            .requests
            .is_empty()
    );
    let listed = served.kernel.list(cos_tools::SurfaceId::Desktop);
    let tabs = listed
        .iter()
        .find(|tool| tool["name"] == "browser_tabs")
        .expect("browser_tabs is listed with screen alone");
    assert_eq!(tabs["annotations"]["idempotentHint"], json!(false));
    assert!(
        !listed.iter().any(|tool| tool["name"] == "browser_navigate"),
        "navigation needs control"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn keeps_unattributed_permission_explicit_and_checks_it_again_at_dispatch() {
    let served = Arc::new(Served::new("unattributed", |_| {}));
    served.connect();
    let refused = served
        .call("browser_tabs", json!({ "action": "list" }))
        .await
        .unwrap();
    assert_eq!(
        first_text(&refused),
        "BROWSER_IDENTITY_REQUIRED: exact local session or Allow unattributed calls is required. No browser operation ran."
    );
    let broker = served.control.broker();
    assert!(
        broker
            .poll(BROWSER, "Test Chrome", true)
            .unwrap()
            .requests
            .is_empty()
    );

    served.configure(unattributed_allowed);
    let call = served.spawn_call("browser_tabs", json!({ "action": "list" }), None);
    let (command, epoch) = served.claim_next().await;
    assert_eq!(command.owner, "unattributed");
    assert_eq!(command.conversation_id, None);
    assert!(broker.check(BROWSER, &command.id, &epoch).await);
    served.configure(|config| config.multi_agent.allow_unattributed_calls = false);
    assert!(!broker.check(BROWSER, &command.id, &epoch).await);
    served.answer(&command, &epoch, ok(json!(null)));
    call.await.unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn keeps_exact_session_ownership_and_refuses_a_chat_that_can_no_longer_act() {
    let served = Arc::new(Served::new("exact", |_| {}));
    served.connect();
    served
        .proofs
        .proven
        .lock()
        .unwrap()
        .insert("wfr_proved".to_owned(), chat(CONVERSATION, SESSION));
    let call = served.spawn_call(
        "browser_tabs",
        json!({ "action": "attach", "tabId": TAB }),
        Some("wfr_proved/attempt-1"),
    );
    let (command, epoch) = served.claim_next().await;
    assert_eq!(command.owner, format!("session:{SESSION}"));
    assert_eq!(command.conversation_id.as_deref(), Some(CONVERSATION));
    let broker = served.control.broker();
    assert!(broker.check(BROWSER, &command.id, &epoch).await);
    served
        .proofs
        .dead
        .lock()
        .unwrap()
        .push(chat(CONVERSATION, SESSION));
    assert!(!broker.check(BROWSER, &command.id, &epoch).await);
    served.answer(&command, &epoch, ok(json!({ "attached": true })));
    let result = call.await.unwrap().unwrap();
    assert_eq!(
        result["content"],
        json!([{ "type": "text", "text": "{\"attached\":true}" }]),
        "an attributed call gets no identity notice"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gives_unproven_requests_their_own_principal_and_upgrades_only_with_exact_proof() {
    let served = Arc::new(Served::new("upgrade", unattributed_allowed));
    served.connect();
    let broker = served.control.broker();
    let attach = json!({ "action": "attach", "tabId": TAB });

    let first = served.spawn_call("browser_tabs", attach.clone(), Some("request-a"));
    let (original, epoch) = served.claim_next().await;
    assert_eq!(original.owner, "request:request-a");
    assert!(broker.check(BROWSER, &original.id, &epoch).await);

    let second = served.spawn_call("browser_tabs", attach.clone(), Some("request-b"));
    let (other, _) = served.claim_next().await;
    assert_eq!(other.owner, "request:request-b");
    served.answer(&other, &epoch, ok(json!(null)));
    second.await.unwrap().unwrap();

    served
        .proofs
        .proven
        .lock()
        .unwrap()
        .insert("request-a".to_owned(), chat(CONVERSATION, SESSION));
    let third = served.spawn_call("browser_tabs", attach, Some("request-a"));
    let (upgraded, _) = served.claim_next().await;
    assert_eq!(upgraded.owner, format!("session:{SESSION}"));
    assert_eq!(upgraded.conversation_id.as_deref(), Some(CONVERSATION));
    served.answer(&upgraded, &epoch, ok(json!(null)));
    third.await.unwrap().unwrap();

    // The first command was queued before the proof; its late check now follows that chat.
    served
        .proofs
        .dead
        .lock()
        .unwrap()
        .push(chat(CONVERSATION, SESSION));
    assert!(!broker.check(BROWSER, &original.id, &epoch).await);
    served.answer(&original, &epoch, ok(json!(null)));
    first.await.unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn validates_action_targets_and_required_values_before_queueing() {
    let served = Served::new("action-args", unattributed_allowed);
    let base = |extra: Value| {
        let mut args = json!({ "tabId": TAB, "pageId": PAGE });
        for (key, value) in extra.as_object().unwrap() {
            args[key] = value.clone();
        }
        args
    };
    let refused = [
        (
            base(json!({ "action": "click", "x": 20, "y": 20 })),
            "ref: Use a DOM ref or x/y with screenshotId",
        ),
        (
            base(json!({ "action": "fill", "ref": "r" })),
            "text: Text required (empty fill clears the field)",
        ),
        (
            base(json!({ "action": "key", "key": "w", "holdMs": 2001 })),
            "holdMs: Too big: expected number to be <=2000",
        ),
        (
            base(json!({ "action": "click", "ref": "r", "holdMs": 300 })),
            "holdMs: Only supported for key input",
        ),
        (
            base(json!({ "action": "drag", "ref": "r" })),
            "toRef: Destination ref or coordinates required",
        ),
        (
            base(json!({ "action": "select", "ref": "r" })),
            "values: Values required",
        ),
        (
            base(json!({ "action": "dialog" })),
            "accept: Specify accept",
        ),
        (base(json!({ "action": "key" })), "key: Key chord required"),
    ];
    for (arguments, issue) in refused {
        let result = served
            .call("browser_action", arguments.clone())
            .await
            .unwrap();
        assert_eq!(
            first_text(&result),
            format!("Input validation error: Invalid arguments for tool browser_action: {issue}"),
            "{arguments}"
        );
    }
    // A pageId that is not a bare UUID is refused before anything is queued, in the schema's
    // own words.
    let confused = served
        .call(
            "browser_action",
            base(json!({ "action": "key", "key": "ENTER", "pageId": format!("{PAGE}:frame") })),
        )
        .await
        .unwrap();
    assert_eq!(
        first_text(&confused),
        "Input validation error: Invalid arguments for tool browser_action: pageId: Copy the top-level pageId from the observation, not a frameId or element ref."
    );
    // The tabId pattern takes its property's place and survives another property's type error,
    // which stops the refinements.
    let snapshot = served
        .call("browser_snapshot", json!({ "tabId": "x", "maxNodes": "a" }))
        .await
        .unwrap();
    assert_eq!(
        first_text(&snapshot),
        "Input validation error: Invalid arguments for tool browser_snapshot: tabId: Invalid string: must match pattern /^[a-f\\d-]{36}:\\d+$/i, maxNodes: Invalid input: expected number, received string"
    );
    let navigate = served
        .call("browser_navigate", json!({ "tabId": "X", "pageId": PAGE }))
        .await
        .unwrap();
    assert_eq!(
        first_text(&navigate),
        "Input validation error: Invalid arguments for tool browser_navigate: tabId: Invalid string: must match pattern /^[a-f\\d-]{36}:\\d+$/i, url: URL required"
    );
    // Accepted arguments reach the browser: no browser is connected, so the broker answers.
    for accepted in [
        base(json!({ "action": "fill", "ref": "r", "text": "" })),
        base(json!({ "action": "click", "x": 20, "y": 20, "screenshotId": "s" })),
        base(json!({ "action": "key", "key": "w", "holdMs": 300 })),
        json!({ "tabId": "ABCDEF11-1111-4111-8111-111111111111:3", "pageId": PAGE, "action": "key", "key": "w" }),
    ] {
        let result = served
            .call("browser_action", accepted.clone())
            .await
            .unwrap();
        assert!(
            first_text(&result).starts_with("BROWSER_OFFLINE: "),
            "{accepted}: {result}"
        );
    }
}

/// A 1x1 PNG.
const PIXEL: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn returns_a_screenshot_once_as_a_native_image_block_after_the_pixel_check() {
    let served = Arc::new(Served::new("screenshot", unattributed_allowed));
    served.connect();
    let shot = |data: &str| BrowserResult {
        value: Some(json!({ "width": 1, "height": 1 })),
        image: Some(BrowserImage {
            data: data.to_owned(),
            mime_type: ImageMimeType::Jpeg,
        }),
        error: None,
    };

    let call = served.spawn_call("browser_screenshot", json!({ "tabId": TAB }), None);
    let (command, epoch) = served.claim_next().await;
    served.answer(&command, &epoch, shot(PIXEL));
    let result = call.await.unwrap().unwrap();
    assert_eq!(
        result["content"].as_array().unwrap()[..2],
        [
            json!({ "type": "text", "text": "{\"width\":1,\"height\":1}" }),
            json!({ "type": "image", "data": PIXEL, "mimeType": "image/png" }),
        ]
    );
    assert_eq!(
        result["structuredContent"],
        json!({ "value": { "width": 1, "height": 1 } })
    );

    let call = served.spawn_call("browser_screenshot", json!({ "tabId": TAB }), None);
    let (command, epoch) = served.claim_next().await;
    served.answer(&command, &epoch, shot("bm90IGFuIGltYWdl"));
    let result = call.await.unwrap().unwrap();
    assert!(is_error(&result));
    assert_eq!(
        first_text(&result),
        "unable to process image: invalid or unsupported image data"
    );

    let call = served.spawn_call("browser_screenshot", json!({ "tabId": TAB }), None);
    let (command, epoch) = served.claim_next().await;
    served.answer(&command, &epoch, shot("not base64!"));
    let result = call.await.unwrap().unwrap();
    assert_eq!(
        first_text(&result),
        "BROWSER_IMAGE_INVALID: screenshot exceeds its byte limit."
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_browser_error_is_a_refusal_with_its_own_text() {
    let served = Arc::new(Served::new("browser-error", unattributed_allowed));
    served.connect();
    let call = served.spawn_call("browser_console", json!({ "tabId": TAB }), None);
    let (command, epoch) = served.claim_next().await;
    assert_eq!(
        command.args.get("after"),
        Some(&json!(0)),
        "schema defaults reach the browser"
    );
    assert_eq!(command.args.get("limit"), Some(&json!(50)));
    served.answer(
        &command,
        &epoch,
        BrowserResult {
            value: None,
            image: None,
            error: Some("BROWSER_NOT_ATTACHED: attach first.".to_owned()),
        },
    );
    let result = call.await.unwrap().unwrap();
    assert!(is_error(&result));
    assert_eq!(first_text(&result), "BROWSER_NOT_ATTACHED: attach first.");
}
