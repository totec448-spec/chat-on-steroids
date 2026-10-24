//! The bridge's lifecycle ends browser work as `bridge.ts` does: a stop, a port change and a
//! Disconnect each reset the broker, and Disconnect also revokes the sign-in offer.

mod support;

use std::sync::Arc;

use cos_browser_control::{CookieWriter, ExternalBrowser, SignInCookie};
use cos_tools::BoxFuture;
use cos_types::app_state::BridgeStatus;
use serde_json::json;
use support::{BROWSER, Served};
use tokio::sync::watch;

fn status(port: Option<u16>, paired: bool) -> Arc<BridgeStatus> {
    Arc::new(BridgeStatus {
        port_overridden: Some(false),
        error: Some(None),
        running: port.is_some(),
        port,
        paired,
        present: false,
        last_seen_at: None,
        extension_version: None,
        external_extension: Some(None),
        cos_extension: None,
    })
}

struct Never;

impl CookieWriter for Never {
    fn write(
        &self,
        _cookies: Vec<SignInCookie>,
        _current: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> BoxFuture<'static, Result<(), ()>> {
        Box::pin(async { Err(()) })
    }
}

async fn queued_call(
    served: &Arc<Served>,
) -> tokio::task::JoinHandle<Result<serde_json::Value, String>> {
    served.connect();
    let call = served.spawn_call(
        "browser_snapshot",
        json!({ "tabId": format!("{BROWSER}:1") }),
        None,
    );
    while served
        .control
        .broker()
        .poll(BROWSER, "Chrome", true)
        .unwrap()
        .requests
        .is_empty()
    {
        tokio::task::yield_now().await;
    }
    call
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_port_change_and_a_disconnect_end_waiting_calls_and_the_offer() {
    let served = Arc::new(Served::new("lifecycle", |config| {
        config.multi_agent.allow_unattributed_calls = true;
    }));
    let (bridge, receiver) = watch::channel(status(Some(40001), true));
    let follower = tokio::spawn(served.control.clone().follow_bridge(receiver));

    let call = queued_call(&served).await;
    let epoch = served
        .control
        .broker()
        .poll(BROWSER, "Chrome", true)
        .unwrap()
        .epoch;
    bridge.send_replace(status(Some(40002), true));
    let result = call.await.unwrap().unwrap();
    assert!(
        result["content"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with("BROWSER_NOT_DISPATCHED: bridge stopped."),
        "{result}"
    );
    let after = served
        .control
        .broker()
        .poll(BROWSER, "Chrome", true)
        .unwrap()
        .epoch;
    assert_ne!(epoch, after, "old claims and receipts are stale");

    let offer = served
        .control
        .sign_in()
        .begin(ExternalBrowser::Chrome, Arc::new(|| true), Arc::new(Never))
        .unwrap();
    assert_eq!(served.control.sign_in().pending(), Some(offer));
    let call = queued_call(&served).await;
    bridge.send_replace(status(Some(40002), false));
    let result = call.await.unwrap().unwrap();
    assert!(result["isError"] == json!(true));
    assert_eq!(served.control.sign_in().pending(), None);

    drop(bridge);
    follower.await.unwrap();
}
