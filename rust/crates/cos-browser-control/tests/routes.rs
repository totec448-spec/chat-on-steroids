//! `POST /browser-control` and `/cos-browser/sign-in` as the extension sees them: statuses and
//! bodies of `bridge.ts`, and the sign-in transfer of `test/cos-browser-sign-in.test.ts`.

mod support;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use cos_browser_control::{
    CookieWriter, ExternalBrowser, SignInCookie, SignInError, SignInMethod, SignInTransfer,
    sign_in_cookies,
};
use cos_tools::BoxFuture;
use cos_types::config::ChatBrowser;
use serde_json::{Value, json};
use support::{BROWSER, Served, chat};
use tokio::sync::Notify;

async fn post(served: &Served, body: Value) -> (u16, Value) {
    let answer = served.control.answer(&body).await;
    (answer.status, answer.body)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_poll_reports_the_epoch_the_queue_and_the_live_policy() {
    let served = Served::new("poll", |config| config.capabilities.control = false);
    let (status, body) = post(
        &served,
        json!({ "action": "poll", "browserId": BROWSER, "name": "Chrome", "enabled": true }),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["requests"], json!([]));
    assert_eq!(body["policy"], json!({ "read": true, "write": false }));
    assert_eq!(
        body.as_object().unwrap().keys().collect::<Vec<_>>(),
        ["epoch", "requests", "policy"]
    );
    served.configure(|config| config.read_only = true);
    served.configure(|config| config.capabilities.control = true);
    let (_, body) = post(
        &served,
        json!({ "action": "poll", "browserId": BROWSER, "name": "Chrome", "enabled": true }),
    )
    .await;
    assert_eq!(
        body["policy"],
        json!({ "read": true, "write": false }),
        "read-only turns control off"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn malformed_requests_are_refused_with_the_bridge_words() {
    let served = Served::new("refusals", |_| {});
    let epoch = served
        .control
        .broker()
        .poll(BROWSER, "Chrome", true)
        .unwrap()
        .epoch;
    let cases = [
        (
            json!(null),
            400,
            json!({ "error": "invalid_browser_request" }),
        ),
        (
            json!([]),
            400,
            json!({ "error": "invalid_browser_request" }),
        ),
        (
            json!({ "action": "poll", "browserId": "not-a-browser", "name": "x", "enabled": true }),
            400,
            json!({ "error": "invalid_browser_request" }),
        ),
        (
            json!({ "action": "poll", "browserId": BROWSER, "name": "x" }),
            400,
            json!({ "error": "invalid_browser_request" }),
        ),
        (
            json!({ "action": "claim", "browserId": BROWSER, "id": "x".repeat(101), "epoch": epoch }),
            400,
            json!({ "error": "invalid_browser_request" }),
        ),
        (
            json!({ "action": "claim", "browserId": BROWSER, "id": "x", "epoch": epoch, "owners": ["session:a"] }),
            400,
            json!({ "error": "invalid_browser_owners" }),
        ),
        (
            json!({ "action": "claim", "browserId": BROWSER, "id": "x", "epoch": epoch, "owners": "request:a" }),
            400,
            json!({ "error": "invalid_browser_owners" }),
        ),
        (
            json!({ "action": "claim", "browserId": BROWSER, "id": "x", "epoch": epoch }),
            409,
            json!({ "command": null }),
        ),
        (
            json!({ "action": "check", "browserId": BROWSER, "id": "x", "epoch": epoch }),
            200,
            json!({ "allowed": false }),
        ),
        (
            json!({ "action": "result", "browserId": BROWSER, "id": "x", "epoch": epoch, "result": { "error": 5 } }),
            400,
            json!({ "error": "invalid_browser_result" }),
        ),
        (
            json!({ "action": "result", "browserId": BROWSER, "id": "x", "epoch": epoch, "result": { "image": { "data": "AA==", "mimeType": "image/gif" } } }),
            400,
            json!({ "error": "invalid_browser_result" }),
        ),
        (
            json!({ "action": "result", "browserId": BROWSER, "id": "x", "epoch": epoch, "result": { "value": 1 } }),
            409,
            json!({ "ok": false }),
        ),
        (
            json!({ "action": "result", "browserId": BROWSER, "id": "x", "epoch": epoch, "result": [] }),
            400,
            json!({ "error": "invalid_browser_request" }),
        ),
        (
            json!({ "action": "other", "browserId": BROWSER, "id": "x", "epoch": epoch }),
            400,
            json!({ "error": "invalid_browser_request" }),
        ),
    ];
    for (body, status, expected) in cases {
        assert_eq!(
            post(&served, body.clone()).await,
            (status, expected),
            "{body}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_whole_round_trip_over_the_route_with_proven_owner_aliases() {
    let served = Arc::new(Served::new("round-trip", |_| {}));
    served
        .proofs
        .proven
        .lock()
        .unwrap()
        .insert("wfr_turn".to_owned(), chat("chat-a-0001", "session-a"));
    let (_, polled) = post(
        &served,
        json!({ "action": "poll", "browserId": BROWSER, "name": "Chrome", "enabled": true }),
    )
    .await;
    let epoch = polled["epoch"].as_str().unwrap().to_owned();
    let call = served.spawn_call(
        "browser_tabs",
        json!({ "action": "list" }),
        Some("wfr_turn/1"),
    );
    let request = loop {
        let (_, polled) = post(
            &served,
            json!({ "action": "poll", "browserId": BROWSER, "name": "Chrome", "enabled": true }),
        )
        .await;
        if let Some(request) = polled["requests"][0].as_str() {
            break request.to_owned();
        }
        tokio::task::yield_now().await;
    };
    let (status, claimed) = post(
        &served,
        json!({ "action": "claim", "browserId": BROWSER, "id": request, "epoch": epoch,
                "owners": ["request:wfr_turn", "request:unknown"] }),
    )
    .await;
    assert_eq!(status, 200);
    let command = &claimed["command"];
    assert_eq!(command["owner"], "session:session-a");
    assert_eq!(command["ownerAliases"], json!(["request:wfr_turn"]));
    assert_eq!(command["conversationId"], "chat-a-0001");
    assert_eq!(command["tool"], "browser_tabs");
    assert_eq!(command["epoch"], json!(epoch));
    let (_, checked) = post(
        &served,
        json!({ "action": "check", "browserId": BROWSER, "id": request, "epoch": epoch }),
    )
    .await;
    assert_eq!(checked, json!({ "allowed": true }));
    let result = json!({ "action": "result", "browserId": BROWSER, "id": request, "epoch": epoch,
                         "result": { "value": { "tabs": [{ "tabId": format!("{BROWSER}:1") }] } } });
    assert_eq!(
        post(&served, result.clone()).await,
        (200, json!({ "ok": true }))
    );
    assert_eq!(
        post(&served, result).await,
        (409, json!({ "ok": false })),
        "a receipt is accepted once"
    );
    let answered = call.await.unwrap().unwrap();
    assert_eq!(
        answered["structuredContent"]["value"]["tabs"][0]["tabId"],
        json!(format!("{BROWSER}:1"))
    );
}

const COOKIE: &str = r#"{"name":"__Secure-next-auth.session-token","value":"synthetic-test-session","domain":".chatgpt.com","path":"/","secure":true,"httpOnly":true,"hostOnly":false,"sameSite":"lax"}"#;

fn cookie() -> Value {
    serde_json::from_str(COOKIE).unwrap()
}

fn with(base: Value, change: Value) -> Value {
    let mut out = base;
    for (key, value) in change.as_object().unwrap() {
        out[key] = value.clone();
    }
    out
}

fn chunk(index: usize) -> Value {
    with(
        cookie(),
        json!({ "name": format!("__Secure-next-auth.session-token.{index}") }),
    )
}

const NOW: u64 = 1_000_000;

#[test]
fn accepts_complete_session_tokens_only_including_out_of_order_chunks() {
    let names =
        |cookies: Vec<SignInCookie>| cookies.into_iter().map(|c| c.name).collect::<Vec<_>>();
    assert_eq!(
        names(sign_in_cookies(&json!([cookie()]), NOW).unwrap()),
        ["__Secure-next-auth.session-token"]
    );
    assert_eq!(
        names(sign_in_cookies(&json!([chunk(1), chunk(0)]), NOW).unwrap()),
        [
            "__Secure-next-auth.session-token.0",
            "__Secure-next-auth.session-token.1"
        ]
    );
    let refused = [
        json!([]),
        json!([chunk(1)]),
        json!([chunk(0), chunk(0)]),
        json!([chunk(0), chunk(2)]),
        json!([cookie(), chunk(0)]),
        json!([with(cookie(), json!({ "domain": ".google.com" }))]),
        json!([with(cookie(), json!({ "httpOnly": false }))]),
        json!([with(cookie(), json!({ "path": "/other" }))]),
        json!([with(cookie(), json!({ "expirationDate": 1 }))]),
        json!([with(cookie(), json!({ "value": "x".repeat(4097) }))]),
        json!([with(cookie(), json!({ "extra": true }))]),
        json!([
            chunk(0),
            with(
                chunk(1),
                json!({ "domain": "chatgpt.com", "hostOnly": true })
            )
        ]),
        json!({ "not": "a list" }),
    ];
    for batch in refused {
        assert_eq!(
            sign_in_cookies(&batch, NOW),
            Err(SignInError::InvalidSession),
            "{batch}"
        );
    }
}

type Current = Arc<dyn Fn() -> bool + Send + Sync>;

/// A cookie jar that counts writes and can be held open.
#[derive(Default)]
struct Jar {
    writes: AtomicUsize,
    hold: Option<Arc<Notify>>,
    fail: bool,
    current: Mutex<Option<Current>>,
}

struct Writer(Arc<Jar>);

impl CookieWriter for Writer {
    fn write(
        &self,
        cookies: Vec<SignInCookie>,
        current: Current,
    ) -> BoxFuture<'static, Result<(), ()>> {
        let jar = self.0.clone();
        Box::pin(async move {
            assert!(!cookies.is_empty());
            jar.writes.fetch_add(1, Ordering::SeqCst);
            *jar.current.lock().unwrap() = Some(current);
            if let Some(hold) = &jar.hold {
                hold.notified().await;
            }
            if jar.fail { Err(()) } else { Ok(()) }
        })
    }
}

fn yes() -> Arc<dyn Fn() -> bool + Send + Sync> {
    Arc::new(|| true)
}

#[tokio::test]
async fn requires_an_explicit_offer_and_deduplicates_only_the_same_browser_receipt() {
    let transfer = SignInTransfer::new();
    let jar = Arc::new(Jar::default());
    assert_eq!(transfer.pending(), None);
    assert_eq!(
        transfer
            .accept("missing", "browser-a", &json!([cookie()]), || true)
            .await,
        Err(SignInError::TransferExpired)
    );
    let offer = transfer
        .begin(ExternalBrowser::Brave, yes(), Arc::new(Writer(jar.clone())))
        .unwrap();
    assert_eq!(transfer.pending(), Some(offer.clone()));
    assert_eq!(
        transfer
            .accept("foreign", "browser-a", &json!([cookie()]), || true)
            .await,
        Err(SignInError::TransferExpired)
    );
    transfer
        .accept(&offer.id, "browser-a", &json!([cookie()]), || true)
        .await
        .unwrap();
    transfer
        .accept(&offer.id, "browser-a", &json!([cookie()]), || true)
        .await
        .unwrap();
    assert_eq!(
        transfer
            .accept(&offer.id, "browser-b", &json!([cookie()]), || true)
            .await,
        Err(SignInError::TransferExpired)
    );
    assert_eq!(jar.writes.load(Ordering::SeqCst), 1);
    assert_eq!(transfer.pending(), None);
}

#[tokio::test]
async fn blocks_concurrent_imports_and_cannot_publish_a_late_result_after_revocation() {
    let transfer = SignInTransfer::new();
    let hold = Arc::new(Notify::new());
    let jar = Arc::new(Jar {
        hold: Some(hold.clone()),
        ..Jar::default()
    });
    let offer = transfer
        .begin(ExternalBrowser::Edge, yes(), Arc::new(Writer(jar.clone())))
        .unwrap();
    let importing = {
        let transfer = transfer.clone();
        let id = offer.id.clone();
        tokio::spawn(async move {
            transfer
                .accept(&id, "browser-a", &json!([cookie()]), || true)
                .await
        })
    };
    while jar.writes.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    assert_eq!(
        transfer
            .accept(&offer.id, "browser-b", &json!([cookie()]), || true)
            .await,
        Err(SignInError::TransferBusy)
    );
    assert_eq!(
        transfer
            .begin(
                ExternalBrowser::Chrome,
                yes(),
                Arc::new(Writer(Arc::new(Jar::default())))
            )
            .unwrap_err(),
        SignInError::TransferBusy
    );
    transfer.cancel(None);
    let owns = jar.current.lock().unwrap().clone().unwrap();
    assert!(!owns());
    hold.notify_one();
    assert_eq!(importing.await.unwrap(), Err(SignInError::TransferExpired));
    assert_eq!(transfer.pending(), None);
}

#[tokio::test]
async fn expires_without_a_timer_and_never_echoes_a_cookie_api_failure() {
    let now = Arc::new(AtomicUsize::new(1000));
    let clock = now.clone();
    let transfer =
        SignInTransfer::with_clock(Arc::new(move || clock.load(Ordering::SeqCst) as u64));
    let jar = Arc::new(Jar {
        fail: true,
        ..Jar::default()
    });
    let offer = transfer
        .begin(ExternalBrowser::Chrome, yes(), Arc::new(Writer(jar)))
        .unwrap();
    assert_eq!(
        transfer
            .accept(&offer.id, "browser-a", &json!([cookie()]), || true)
            .await,
        Err(SignInError::TransferFailed)
    );
    now.store(offer.expires_at as usize, Ordering::SeqCst);
    assert_eq!(transfer.pending(), None);
    assert_eq!(
        transfer
            .accept(&offer.id, "browser-a", &json!([cookie()]), || true)
            .await,
        Err(SignInError::TransferExpired)
    );
}

const PEER: &str = "abcdefabcdef0123";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_sign_in_route_answers_as_bridge_ts_does() {
    let served = Served::new("sign-in", |_| {});
    let control = &served.control;
    let answer = |method, browser: Option<&'static str>, body: Option<Value>| {
        let control = control.clone();
        async move {
            let answer = control
                .sign_in_answer(method, browser, async move { body })
                .await;
            (answer.status, answer.body)
        }
    };
    let expired = (409, json!({ "error": "transfer_expired" }));
    assert_eq!(
        answer(SignInMethod::Get, Some(PEER), None).await,
        expired,
        "not the CoS browser"
    );

    served.configure(|config| config.ui.chat_browser = Some(ChatBrowser::Cos));
    assert_eq!(
        answer(SignInMethod::Get, Some(PEER), None).await,
        (200, json!({ "offer": null }))
    );
    assert_eq!(
        answer(SignInMethod::Other, Some(PEER), None).await,
        (405, json!({ "error": "method_not_allowed" }))
    );
    assert_eq!(
        answer(SignInMethod::Post, None, Some(json!({}))).await,
        (400, json!({ "error": "invalid_browser_request" }))
    );
    let bad = (400, json!({ "error": "bad_request" }));
    for body in [
        None,
        Some(json!([])),
        Some(json!({ "id": "short" })),
        Some(json!({ "id": "11111111-1111-4111-8111-111111111111", "x": 1 })),
    ] {
        assert_eq!(
            answer(SignInMethod::Post, Some(PEER), body.clone()).await,
            bad,
            "{body:?}"
        );
    }
    let id = "11111111-1111-4111-8111-111111111111";
    assert_eq!(
        answer(
            SignInMethod::Post,
            Some(PEER),
            Some(json!({ "id": id, "cookies": [cookie()] }))
        )
        .await,
        expired,
        "no offer is open"
    );

    let wrote = Arc::new(AtomicBool::new(false));
    struct Flag(Arc<AtomicBool>);
    impl CookieWriter for Flag {
        fn write(
            &self,
            _cookies: Vec<SignInCookie>,
            _current: Arc<dyn Fn() -> bool + Send + Sync>,
        ) -> BoxFuture<'static, Result<(), ()>> {
            self.0.store(true, Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        }
    }
    let offer = control
        .sign_in()
        .begin(
            ExternalBrowser::Chrome,
            yes(),
            Arc::new(Flag(wrote.clone())),
        )
        .unwrap();
    let (status, body) = answer(SignInMethod::Get, Some(PEER), None).await;
    assert_eq!(status, 200);
    assert_eq!(body["offer"]["id"], json!(offer.id));
    assert_eq!(body["offer"]["browser"], "chrome");
    assert_eq!(body["offer"]["expiresAt"], json!(offer.expires_at));
    assert_eq!(
        answer(
            SignInMethod::Post,
            Some(PEER),
            Some(json!({ "id": offer.id, "cookies": [] }))
        )
        .await,
        (400, json!({ "error": "invalid_session" }))
    );
    assert_eq!(
        answer(
            SignInMethod::Post,
            Some(PEER),
            Some(json!({ "id": offer.id, "cookies": [cookie()] }))
        )
        .await,
        (200, json!({ "ok": true, "imported": true }))
    );
    assert!(wrote.load(Ordering::SeqCst));
}
