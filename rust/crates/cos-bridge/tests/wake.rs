//! The wake socket, case by case from `test/browser-wake.test.ts` and the wake cases of
//! `test/bridge.test.ts`.

mod support;

use std::time::Duration;

use cos_types::bridge::{WAKE_MAX_CLIENTS, WakeHost, WakeSignal};
use support::{Fixture, Opened, Options, Socket};

const SHORT: Duration = Duration::from_secs(3);

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn signals_current_and_newly_published_work_without_carrying_any() {
    let bridge = Fixture::start(Options::default()).await;
    let token = bridge.pair().await;
    let wake = bridge.bridge.wake();
    let mut socket = Socket::open_ok(bridge.port(), "/wake?host=browser").await;
    assert!(
        !wake.connected(None),
        "an unauthenticated socket is not reachability"
    );
    socket.send_text(&token).await;
    assert_eq!(socket.next_text(SHORT).await.as_deref(), Some("wake"));
    assert!(wake.connected(None));
    assert!(wake.connected(Some(WakeHost::Browser)));
    assert!(!wake.connected(Some(WakeHost::Cos)));
    wake.signal(WakeSignal::Wake);
    assert_eq!(socket.next_text(SHORT).await.as_deref(), Some("wake"));
    wake.signal(WakeSignal::BrowserControl);
    assert_eq!(
        socket.next_text(SHORT).await.as_deref(),
        Some("browser-control")
    );
    socket.send_text("pong").await;
    bridge.bridge.disconnect().await.expect("disconnects");
    assert!(
        socket.closed_within(SHORT).await,
        "Disconnect left the socket open"
    );
    assert!(!wake.connected(None));
    bridge.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn presence_follows_an_authenticated_socket_with_no_request_at_all() {
    let bridge = Fixture::start(Options::default()).await;
    let token = bridge.pair().await;
    // Forget the pairing's own sighting, so only the socket can make the browser present.
    let mut restarted = bridge;
    let dir = restarted.dir.clone();
    if let Some(task) = restarted.task.take() {
        task.shutdown().await;
    }
    let bridge = Fixture::start_in(dir, Options::default()).await;
    assert!(!bridge.status().present);
    let mut cos = Socket::open_ok(bridge.port(), "/wake?host=cos").await;
    cos.send_text(&token).await;
    assert_eq!(cos.next_text(SHORT).await.as_deref(), Some("wake"));
    let status = bridge.wait(|status| status.present).await;
    assert_eq!(
        status.cos_extension.as_ref().map(|cos| cos.present),
        Some(true)
    );
    assert!(status.last_seen_at.is_none());
    drop(cos);
    let gone = bridge.wait(|status| !status.present).await;
    assert_eq!(
        gone.cos_extension.as_ref().map(|cos| cos.present),
        Some(false)
    );
    let lines = bridge.log_lines();
    assert!(
        lines
            .iter()
            .any(|line| line == "bridge: browser wake channel authenticated")
    );
    assert!(
        lines
            .iter()
            .any(|line| line == "bridge: browser wake channel disconnected")
    );
    bridge.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_web_origins_and_other_paths_before_authentication() {
    let bridge = Fixture::start(Options::default()).await;
    assert!(matches!(
        Socket::open(bridge.port(), "/wake", Some("https://chatgpt.com")).await,
        Opened::Refused(403)
    ));
    assert!(matches!(
        Socket::open(bridge.port(), "/hello", Some(support::EXTENSION_ORIGIN)).await,
        Opened::Refused(404)
    ));
    assert!(matches!(
        Socket::open(bridge.port(), "/wake", None).await,
        Opened::Open(_)
    ));
    bridge.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closes_on_a_wrong_token_and_on_anything_but_pong_after_it() {
    let bridge = Fixture::start(Options::default()).await;
    let token = bridge.pair().await;
    let mut wrong = Socket::open_ok(bridge.port(), "/wake").await;
    wrong.send_text("wrong").await;
    assert!(wrong.closed_within(SHORT).await);

    let mut chatty = Socket::open_ok(bridge.port(), "/wake").await;
    chatty.send_text(&token).await;
    assert_eq!(chatty.next_text(SHORT).await.as_deref(), Some("wake"));
    chatty.send_text("send this user message").await;
    assert!(chatty.closed_within(SHORT).await);

    let mut binary = Socket::open_ok(bridge.port(), "/wake").await;
    binary.send_frame(0x2, &token.clone().into_bytes()).await;
    assert!(binary.closed_within(SHORT).await);

    let mut long = Socket::open_ok(bridge.port(), "/wake").await;
    long.send_text(&"x".repeat(513)).await;
    assert!(long.closed_within(SHORT).await);
    bridge.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn admits_eight_sockets_at_once() {
    let bridge = Fixture::start(Options::default()).await;
    let mut open = Vec::new();
    for _ in 0..WAKE_MAX_CLIENTS {
        open.push(Socket::open_ok(bridge.port(), "/wake").await);
    }
    assert!(matches!(
        Socket::open(bridge.port(), "/wake", Some(support::EXTENSION_ORIGIN)).await,
        Opened::Refused(503)
    ));
    drop(open.pop());
    let mut admitted = false;
    for _ in 0..50 {
        if let Opened::Open(_) =
            Socket::open(bridge.port(), "/wake", Some(support::EXTENSION_ORIGIN)).await
        {
            admitted = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(admitted, "a closed socket kept its slot");
    bridge.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_socket_that_never_authenticates_is_closed_after_five_seconds() {
    let bridge = Fixture::start(Options::default()).await;
    let mut silent = Socket::open_ok(bridge.port(), "/wake").await;
    assert!(
        !silent.closed_within(Duration::from_secs(4)).await,
        "closed before the deadline"
    );
    assert!(
        silent.closed_within(Duration::from_secs(3)).await,
        "open after the deadline"
    );
    bridge.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_closes_every_socket() {
    let bridge = Fixture::start(Options::default()).await;
    let token = bridge.pair().await;
    let mut socket = Socket::open_ok(bridge.port(), "/wake").await;
    socket.send_text(&token).await;
    assert_eq!(socket.next_text(SHORT).await.as_deref(), Some("wake"));
    let wake = bridge.bridge.wake();
    bridge.shutdown().await;
    assert!(socket.closed_within(SHORT).await);
    assert!(!wake.connected(None));
}
