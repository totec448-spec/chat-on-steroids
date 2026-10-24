//! The RPC custody rules of `test/browser-control.test.ts`, through the broker's public API.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use cos_browser_control::{Broker, Check, OwnerProof};
use cos_types::mcp::{BrowserResult, BrowserTool};
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;

const BROWSER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";

fn args(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn allow() -> Check {
    Arc::new(|| Box::pin(async { true }))
}

fn value(value: Value) -> BrowserResult {
    BrowserResult {
        value: Some(value),
        image: None,
        error: None,
    }
}

fn error_of(result: &BrowserResult) -> &str {
    result.error.as_deref().unwrap_or_default()
}

struct Setup {
    broker: Broker,
    wakes: Arc<AtomicUsize>,
    epoch: String,
}

fn setup() -> Setup {
    let wakes = Arc::new(AtomicUsize::new(0));
    let counted = wakes.clone();
    let broker = Broker::new(Arc::new(move || {
        counted.fetch_add(1, Ordering::SeqCst);
    }));
    let epoch = broker
        .poll(BROWSER, "Test Chrome", true)
        .expect("room for a browser")
        .epoch;
    Setup {
        broker,
        wakes,
        epoch,
    }
}

/// Queues a call on its own task and returns once the browser can see it.
async fn queue(
    broker: &Broker,
    tool: BrowserTool,
    input: Value,
    owner: &str,
    conversation: Option<&str>,
    check: Check,
) -> (tokio::task::JoinHandle<BrowserResult>, String) {
    let task = {
        let broker = broker.clone();
        let owner = owner.to_owned();
        let conversation = conversation.map(str::to_owned);
        tokio::spawn(async move {
            broker
                .execute(tool, args(input), owner, conversation, check)
                .await
        })
    };
    for _ in 0..100 {
        let requests = broker
            .poll(BROWSER, "Test Chrome", true)
            .expect("polls")
            .requests;
        if let [request] = requests.as_slice() {
            return (task, request.clone());
        }
        tokio::task::yield_now().await;
    }
    panic!("the command was never queued");
}

#[tokio::test]
async fn hands_out_one_exact_browser_and_principal_claim_never_a_duplicate() {
    let Setup {
        broker,
        wakes,
        epoch,
    } = setup();
    let (work, request) = queue(
        &broker,
        BrowserTool::Action,
        json!({ "tabId": format!("{BROWSER}:12"), "action": "click" }),
        "session:A",
        Some("chat-A"),
        allow(),
    )
    .await;
    assert_eq!(wakes.load(Ordering::SeqCst), 1);
    assert_eq!(broker.claim(OTHER, &request, &epoch, &[]).await, None);
    let command = broker
        .claim(BROWSER, &request, &epoch, &[])
        .await
        .expect("the browser it was queued for claims it");
    assert_eq!(command.owner, "session:A");
    assert_eq!(command.conversation_id.as_deref(), Some("chat-A"));
    assert_eq!(command.args.get("tabId"), Some(&json!(12)));
    assert_eq!(command.args.get("action"), Some(&json!("click")));
    assert_eq!(broker.claim(BROWSER, &request, &epoch, &[]).await, None);
    assert!(
        broker
            .poll(BROWSER, "Test Chrome", true)
            .unwrap()
            .requests
            .is_empty()
    );
    assert!(!broker.result(OTHER, &request, &epoch, value(json!("foreign"))));
    assert!(broker.result(
        BROWSER,
        &request,
        &epoch,
        value(json!({ "accepted": true }))
    ));
    assert_eq!(work.await.unwrap(), value(json!({ "accepted": true })));
    assert!(!broker.result(BROWSER, &request, &epoch, value(json!("duplicate"))));
}

#[tokio::test]
async fn does_not_publish_a_claim_after_revocation_or_a_lifecycle_replacement() {
    let Setup { broker, epoch, .. } = setup();
    let (allow_tx, allow_rx) = oneshot::channel::<bool>();
    let allow_rx = Arc::new(std::sync::Mutex::new(Some(allow_rx)));
    let check: Check = Arc::new(move || {
        let receiver = allow_rx.lock().unwrap().take();
        Box::pin(async move {
            match receiver {
                Some(receiver) => receiver.await.unwrap_or(false),
                None => false,
            }
        })
    });
    let (work, request) = queue(
        &broker,
        BrowserTool::Tabs,
        json!({ "action": "new" }),
        "A",
        None,
        check,
    )
    .await;
    let claim = {
        let broker = broker.clone();
        let (request, epoch) = (request.clone(), epoch.clone());
        tokio::spawn(async move { broker.claim(BROWSER, &request, &epoch, &[]).await })
    };
    tokio::task::yield_now().await;
    broker.reset();
    broker.poll(BROWSER, "Chrome", true).unwrap();
    allow_tx.send(true).unwrap();
    assert_eq!(claim.await.unwrap(), None);
    assert!(error_of(&work.await.unwrap()).contains("NOT_DISPATCHED"));
}

#[tokio::test]
async fn aliases_only_request_owners_with_exact_proof_for_the_current_session() {
    let Setup { broker, epoch, .. } = setup();
    let (work, request) = queue(
        &broker,
        BrowserTool::Tabs,
        json!({ "action": "list" }),
        "session:A",
        Some("chat-A"),
        allow(),
    )
    .await;
    let proof = |owner: &str, session: &str| OwnerProof {
        owner: owner.to_owned(),
        session: session.to_owned(),
    };
    let command = broker
        .claim(
            BROWSER,
            &request,
            &epoch,
            &[
                proof("request:old-turn", "A"),
                proof("request:foreign", "B"),
                proof("unattributed", "A"),
                proof("session:B", "A"),
                proof("request:old-turn", "A"),
            ],
        )
        .await
        .expect("claimed");
    assert_eq!(
        command.owner_aliases,
        Some(vec!["request:old-turn".to_owned()])
    );
    assert_eq!(command.owner, "session:A");
    broker.result(BROWSER, &request, &epoch, value(json!(true)));
    work.await.unwrap();
}

#[tokio::test]
async fn rechecks_the_current_permission_after_handout_before_page_input() {
    let Setup { broker, epoch, .. } = setup();
    let allowed = Arc::new(AtomicBool::new(true));
    let live = allowed.clone();
    let check: Check = Arc::new(move || {
        let allowed = live.load(Ordering::SeqCst);
        Box::pin(async move { allowed })
    });
    let (work, request) = queue(
        &broker,
        BrowserTool::Evaluate,
        json!({ "tabId": format!("{BROWSER}:3") }),
        "A",
        None,
        check,
    )
    .await;
    assert!(
        !broker.check(BROWSER, &request, &epoch).await,
        "not claimed yet"
    );
    broker
        .claim(BROWSER, &request, &epoch, &[])
        .await
        .expect("claimed");
    assert!(broker.check(BROWSER, &request, &epoch).await);
    allowed.store(false, Ordering::SeqCst);
    assert!(!broker.check(BROWSER, &request, &epoch).await);
    broker.result(
        BROWSER,
        &request,
        &epoch,
        BrowserResult {
            value: None,
            image: None,
            error: Some("revoked".to_owned()),
        },
    );
    assert_eq!(error_of(&work.await.unwrap()), "revoked");
}

#[tokio::test]
async fn a_revoked_permission_at_claim_ends_the_call_undispatched() {
    let Setup { broker, epoch, .. } = setup();
    let deny: Check = Arc::new(|| Box::pin(async { false }));
    let (work, request) = queue(
        &broker,
        BrowserTool::Tabs,
        json!({ "action": "list" }),
        "A",
        None,
        deny,
    )
    .await;
    assert_eq!(broker.claim(BROWSER, &request, &epoch, &[]).await, None);
    assert_eq!(
        error_of(&work.await.unwrap()),
        "BROWSER_PERMISSION_REVOKED: request was not dispatched."
    );
}

#[tokio::test(start_paused = true)]
async fn tells_a_timeout_before_dispatch_from_an_unconfirmed_action_and_never_replays() {
    let Setup { broker, epoch, .. } = setup();
    let (first, _) = queue(
        &broker,
        BrowserTool::Tabs,
        json!({ "action": "new" }),
        "A",
        None,
        allow(),
    )
    .await;
    tokio::time::advance(Duration::from_millis(25_000)).await;
    assert_eq!(
        error_of(&first.await.unwrap()),
        "BROWSER_NOT_DISPATCHED: the extension did not claim this request before its deadline."
    );
    let (second, request) = queue(
        &broker,
        BrowserTool::Tabs,
        json!({ "action": "new" }),
        "A",
        None,
        allow(),
    )
    .await;
    broker
        .claim(BROWSER, &request, &epoch, &[])
        .await
        .expect("claimed");
    tokio::time::advance(Duration::from_millis(25_000)).await;
    assert!(error_of(&second.await.unwrap()).starts_with("BROWSER_RESULT_UNCONFIRMED: "));
    assert!(
        broker
            .poll(BROWSER, "Chrome", true)
            .unwrap()
            .requests
            .is_empty()
    );
    assert!(!broker.result(BROWSER, &request, &epoch, value(json!("late"))));
}

#[tokio::test]
async fn lists_competing_browsers_instead_of_guessing_and_rejects_old_tab_handles() {
    let Setup { broker, .. } = setup();
    broker.poll(OTHER, "Edge", true).unwrap();
    let list = broker
        .execute(
            BrowserTool::Tabs,
            args(json!({ "action": "list" })),
            "A".to_owned(),
            None,
            allow(),
        )
        .await;
    assert_eq!(
        list.value,
        Some(json!({
            "browsers": [
                { "id": BROWSER, "name": "Test Chrome", "enabled": true },
                { "id": OTHER, "name": "Edge", "enabled": true },
            ],
            "tabs": [],
            "message": "Choose browserId to list its tabs.",
        }))
    );
    let stale = broker
        .execute(
            BrowserTool::Action,
            args(json!({ "tabId": "123" })),
            "A".to_owned(),
            None,
            allow(),
        )
        .await;
    assert_eq!(
        error_of(&stale),
        "BROWSER_TAB_INVALID: use a tabId returned by browser_tabs."
    );
    let snapshot = broker
        .execute(
            BrowserTool::Snapshot,
            args(json!({})),
            "A".to_owned(),
            None,
            allow(),
        )
        .await;
    assert_eq!(
        error_of(&snapshot),
        "BROWSER_REQUIRED: list browsers, then specify the returned browserId."
    );
}

#[tokio::test]
async fn names_an_absent_browser_and_a_browser_without_permissions() {
    let broker = Broker::new(Arc::new(|| {}));
    let none = broker
        .execute(
            BrowserTool::Tabs,
            args(json!({ "action": "list" })),
            "A".to_owned(),
            None,
            allow(),
        )
        .await;
    assert_eq!(
        none.value,
        Some(
            json!({ "browsers": [], "tabs": [], "message": "Open Chrome with the companion extension connected." })
        )
    );
    let gone = broker
        .execute(
            BrowserTool::Snapshot,
            args(json!({ "tabId": format!("{OTHER}:1") })),
            "A".to_owned(),
            None,
            allow(),
        )
        .await;
    assert!(error_of(&gone).starts_with("BROWSER_OFFLINE: "));
    broker.poll(BROWSER, "Chrome", false).unwrap();
    let disabled = broker
        .execute(
            BrowserTool::Snapshot,
            args(json!({ "tabId": format!("{BROWSER}:1") })),
            "A".to_owned(),
            None,
            allow(),
        )
        .await;
    assert!(error_of(&disabled).starts_with("BROWSER_EXTENSION_PERMISSION: "));
}

#[tokio::test]
async fn bounds_result_bytes() {
    let Setup { broker, epoch, .. } = setup();
    let (work, request) = queue(
        &broker,
        BrowserTool::Snapshot,
        json!({ "tabId": format!("{BROWSER}:1") }),
        "A",
        None,
        allow(),
    )
    .await;
    broker
        .claim(BROWSER, &request, &epoch, &[])
        .await
        .expect("claimed");
    assert!(broker.result(
        BROWSER,
        &request,
        &epoch,
        value(json!("x".repeat(1_800_001)))
    ));
    assert!(error_of(&work.await.unwrap()).starts_with("BROWSER_RESULT_TOO_LARGE: "));
}

#[tokio::test]
async fn an_abandoned_call_withdraws_its_command() {
    let Setup { broker, .. } = setup();
    let (work, _) = queue(
        &broker,
        BrowserTool::Tabs,
        json!({ "action": "list" }),
        "A",
        None,
        allow(),
    )
    .await;
    work.abort();
    let _ = work.await;
    assert!(
        broker
            .poll(BROWSER, "Chrome", true)
            .unwrap()
            .requests
            .is_empty()
    );
}

#[tokio::test]
async fn refuses_a_ninth_browser_and_a_thirty_third_command() {
    let broker = Broker::new(Arc::new(|| {}));
    for n in 0..8 {
        broker
            .poll(
                &format!("00000000-0000-4000-8000-00000000000{n}"),
                "Chrome",
                true,
            )
            .expect("room");
    }
    assert!(broker.poll(OTHER, "Chrome", true).is_err());
    let browser = "00000000-0000-4000-8000-000000000000";
    let mut waiting = Vec::new();
    for _ in 0..32 {
        let broker = broker.clone();
        waiting.push(tokio::spawn(async move {
            broker
                .execute(
                    BrowserTool::Snapshot,
                    args(json!({ "tabId": format!("{browser}:1") })),
                    "A".to_owned(),
                    None,
                    Arc::new(|| Box::pin(async { true })),
                )
                .await
        }));
    }
    while broker.poll(browser, "Chrome", true).unwrap().requests.len() < 32 {
        tokio::task::yield_now().await;
    }
    let busy = broker
        .execute(
            BrowserTool::Snapshot,
            args(json!({ "tabId": format!("{browser}:1") })),
            "A".to_owned(),
            None,
            allow(),
        )
        .await;
    assert!(error_of(&busy).starts_with("BROWSER_BUSY: "));
    broker.reset();
    for call in waiting {
        assert_eq!(
            error_of(&call.await.unwrap()),
            "BROWSER_NOT_DISPATCHED: bridge stopped."
        );
    }
}
