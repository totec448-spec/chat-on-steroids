//! Usage limits (`test/session-usage.test.ts`, passive limits), the extension's preference
//! requests and its diagnostics (`test/bridge.test.ts`, who is allowed to talk to it).

mod support;

use std::time::Duration;

use cos_companion::{Diagnostics, PreferenceError, PreferenceRequests, UsageLimits};
use cos_types::config::BrowserPreferences;
use serde_json::{Value, json};
use support::{ManualClock, Wakes};

const NOW: f64 = 1_767_225_600_000.0;

fn limit(overrides: Value) -> Value {
    let mut row = json!({ "model": "Shared ChatGPT usage", "scope": "shared", "remaining": null,
        "remainingPercent": 40, "resetAt": null, "windowSeconds": 18000 });
    for (key, value) in overrides.as_object().expect("overrides") {
        row[key] = value.clone();
    }
    row
}

fn fresh(usage: &UsageLimits, now: f64) -> Value {
    serde_json::to_value(usage.watch().borrow().fresh(now)).expect("serializes")
}

#[test]
fn keeps_shared_windows_distinct_and_does_not_manufacture_model_specific_counts() {
    let usage = UsageLimits::new();
    let rows = json!([
        limit(json!({})),
        limit(json!({ "windowSeconds": 604800, "remainingPercent": 70 })),
        limit(
            json!({ "model": "gpt-example", "scope": "model", "remaining": 3, "remainingPercent": null })
        )
    ]);
    usage.observe(Some(&rows), None, NOW).expect("accepted");
    let limits = fresh(&usage, NOW);
    assert_eq!(limits.as_array().map(Vec::len), Some(3));
    assert_eq!(
        limits[2],
        json!({ "model": "gpt-example", "scope": "model", "remaining": 3, "remainingPercent": null,
            "resetAt": null, "windowSeconds": 18000, "observedAt": NOW as u64 })
    );
}

#[test]
fn rejects_a_malformed_batch_whole() {
    for bad in [
        json!({ "remaining": -1 }),
        json!({ "remainingPercent": 101 }),
        json!({ "resetAt": -1 }),
        json!({ "windowSeconds": 0 }),
        json!({ "scope": "guessed" }),
        json!({ "model": "" }),
        json!({ "model": "x".repeat(101) }),
    ] {
        let usage = UsageLimits::new();
        usage
            .observe(Some(&json!([limit(json!({}))])), None, NOW)
            .expect("accepted");
        let batch = json!([limit(json!({ "remainingPercent": 10 })), limit(bad.clone())]);
        assert!(
            usage.observe(Some(&batch), None, NOW + 1.0).is_err(),
            "{bad}"
        );
        assert_eq!(fresh(&usage, NOW + 1.0)[0]["remainingPercent"], 40);
    }
    let usage = UsageLimits::new();
    let mut missing = limit(json!({}));
    missing.as_object_mut().expect("row").remove("resetAt");
    assert!(
        usage.observe(Some(&json!([missing])), None, NOW).is_err(),
        "a nullable field is still required"
    );
    assert!(usage.observe(None, None, NOW).is_err(), "rows are required");
}

#[test]
fn rejects_an_oversized_row_batch_without_replacing_the_current_snapshot() {
    let usage = UsageLimits::new();
    usage
        .observe(Some(&json!([limit(json!({}))])), None, NOW)
        .expect("accepted");
    let many: Vec<Value> = (0..81)
        .map(|index| limit(json!({ "model": format!("model-{index}") })))
        .collect();
    assert!(usage.observe(Some(&json!(many)), None, NOW).is_err());
    assert_eq!(fresh(&usage, NOW).as_array().map(Vec::len), Some(1));
}

#[test]
fn expires_a_snapshot_on_read_and_drops_a_limit_past_its_reset() {
    let usage = UsageLimits::new();
    usage
        .observe(Some(&json!([limit(json!({}))])), None, NOW)
        .expect("accepted");
    assert_eq!(fresh(&usage, NOW + 10.0 * 60_000.0 + 1.0), json!([]));
    let exhausted = json!([limit(
        json!({ "model": "gpt-example", "scope": "model", "remaining": 0,
        "remainingPercent": null, "resetAt": NOW + 1000.0 })
    )]);
    usage
        .observe(Some(&exhausted), None, NOW + 1.0)
        .expect("accepted");
    assert_eq!(fresh(&usage, NOW + 1001.0), json!([]));
}

#[test]
fn replaces_an_account_snapshot_and_accepts_an_explicit_empty_reset() {
    let usage = UsageLimits::new();
    let first = json!([
        limit(json!({})),
        limit(json!({ "model": "gpt-old", "scope": "model", "remaining": 0 }))
    ]);
    usage.observe(Some(&first), None, NOW).expect("accepted");
    let next = json!([limit(
        json!({ "model": "gpt-new", "scope": "model", "remaining": 5 })
    )]);
    usage
        .observe(Some(&next), None, NOW + 1.0)
        .expect("accepted");
    assert_eq!(fresh(&usage, NOW + 1.0)[0]["model"], "gpt-new");
    usage
        .observe(Some(&json!([])), None, NOW + 2.0)
        .expect("accepted");
    assert_eq!(fresh(&usage, NOW + 2.0), json!([]));
}

#[test]
fn ignores_older_stale_and_future_snapshots_and_keeps_the_capture_time() {
    let usage = UsageLimits::new();
    usage
        .observe(Some(&json!([limit(json!({}))])), Some(&json!(NOW)), NOW)
        .expect("accepted");
    for at in [
        json!(NOW - 1.0),
        json!(NOW - 11.0 * 60_000.0),
        json!(NOW + 6000.0),
        json!("invalid"),
        json!(null),
    ] {
        usage
            .observe(
                Some(&json!([limit(json!({ "remainingPercent": 99 }))])),
                Some(&at),
                NOW,
            )
            .expect("accepted and ignored");
        assert_eq!(fresh(&usage, NOW)[0]["remainingPercent"], 40, "{at}");
    }
    let later = NOW + 9.0 * 60_000.0;
    usage
        .observe(Some(&json!([limit(json!({}))])), Some(&json!(NOW)), later)
        .expect("accepted");
    assert_eq!(fresh(&usage, later)[0]["observedAt"], NOW as u64);
    assert_eq!(fresh(&usage, later + 60_001.0), json!([]));
}

fn preferences() -> (PreferenceRequests, ManualClock, Wakes) {
    let clock = ManualClock::at(NOW as u64);
    let wakes = Wakes::default();
    (
        PreferenceRequests::new(clock.clock(), wakes.wake()),
        clock,
        wakes,
    )
}

#[tokio::test]
async fn a_preference_request_rides_status_and_resolves_with_the_extensions_answer() {
    let (requests, _clock, wakes) = preferences();
    let asking = {
        let requests = requests.clone();
        tokio::spawn(async move { requests.request(&json!({ "overwrite": false })).await })
    };
    let pending = loop {
        if let Some(pending) = requests.pending() {
            break pending;
        }
        tokio::task::yield_now().await;
    };
    assert_eq!(wakes.count(), 1, "the extension is woken to read it");
    assert_eq!(
        serde_json::to_value(pending.patch).expect("patch"),
        json!({ "overwrite": false })
    );
    assert_eq!(pending.expires_at, NOW as u64 + 65_000);
    assert!(
        requests
            .request(&json!({}))
            .await
            .is_err_and(|error| error == PreferenceError::AlreadyPending)
    );
    assert!(
        !requests.acknowledge(&json!({ "nonce": "5e9140f2-1bcd-4df8-b48c-cd3cd8c8141b",
        "values": { "overwrite": false, "durations": true } }))
    );
    assert!(
        !requests.acknowledge(&json!({ "nonce": pending.nonce, "values": { "overwrite": false } }))
    );
    assert!(requests.acknowledge(&json!({ "nonce": pending.nonce,
        "values": { "overwrite": false, "durations": true } })));
    let answer = asking.await.expect("joined");
    assert_eq!(
        answer,
        Ok(BrowserPreferences {
            overwrite: false,
            durations: true
        })
    );
    assert_eq!(requests.pending(), None);
    assert!(
        !requests.acknowledge(&json!({ "nonce": pending.nonce,
        "values": { "overwrite": false, "durations": true } })),
        "answered once"
    );
}

#[tokio::test]
async fn an_extension_that_cannot_apply_a_change_says_why() {
    let (requests, _clock, _) = preferences();
    let asking = {
        let requests = requests.clone();
        tokio::spawn(async move { requests.request(&json!({ "durations": true })).await })
    };
    let nonce = loop {
        if let Some(pending) = requests.pending() {
            break pending.nonce;
        }
        tokio::task::yield_now().await;
    };
    assert!(
        requests.acknowledge(
            &json!({ "nonce": nonce, "values": null, "error": "storage unavailable" })
        )
    );
    assert_eq!(
        asking.await.expect("joined"),
        Err(PreferenceError::Refused("storage unavailable".into()))
    );
}

#[tokio::test]
async fn a_bad_patch_is_refused_before_anything_is_asked() {
    let (requests, _, wakes) = preferences();
    assert_eq!(
        requests.request(&json!({ "theme": "dark" })).await,
        Err(PreferenceError::InvalidPatch)
    );
    assert_eq!(
        requests.request(&json!({ "overwrite": "yes" })).await,
        Err(PreferenceError::InvalidPatch)
    );
    assert_eq!(wakes.count(), 0);
}

#[tokio::test(start_paused = true)]
async fn an_unanswered_request_ends_after_65_seconds() {
    let (requests, clock, _) = preferences();
    let asking = {
        let requests = requests.clone();
        tokio::spawn(async move { requests.request(&json!({})).await })
    };
    tokio::task::yield_now().await;
    let nonce = requests.pending().expect("pending").nonce;
    clock.advance(65_000);
    assert_eq!(
        requests.pending(),
        None,
        "an expired request is not handed out"
    );
    assert!(!requests.acknowledge(&json!({ "nonce": nonce, "values": null })));
    assert_eq!(
        asking.await.expect("joined"),
        Err(PreferenceError::NotConfirmed)
    );
}

fn diagnostics_body() -> Value {
    json!({ "capturedAt": NOW, "status": { "connected": true, "paired": true, "appVersion": "v".repeat(200) },
        "preferences": { "overwrite": true, "durations": false }, "transcript": "must not be forwarded",
        "tab": { "tab": 17, "page": { "text": "must not be forwarded", "requestId": "r".repeat(500),
            "trace": (0..30).map(|_| json!({ "requestId": "r", "read": true, "text": "must not be forwarded" })).collect::<Vec<_>>() } } })
}

#[tokio::test(start_paused = true)]
async fn bounds_companion_diagnostics_and_clears_them() {
    let diagnostics = Diagnostics::new();
    let waiting = {
        let diagnostics = diagnostics.clone();
        tokio::spawn(async move { diagnostics.fresh(true, || {}).await })
    };
    tokio::task::yield_now().await;
    assert_eq!(
        diagnostics.record(&diagnostics_body()),
        None,
        "nothing stored, nothing kept"
    );
    let snapshot = waiting.await.expect("joined").expect("a snapshot");
    assert_eq!(
        snapshot.status.app_version.as_deref().map(str::len),
        Some(32)
    );
    let page = snapshot
        .tab
        .as_ref()
        .and_then(|tab| tab.page.as_ref())
        .expect("a page");
    assert_eq!(page.request_id.as_deref().map(str::len), Some(160));
    assert_eq!(page.trace.len(), 16);
    let text = serde_json::to_string(&snapshot).expect("serializes");
    assert!(!text.contains("must not be forwarded"));
    diagnostics.clear();
    assert_eq!(diagnostics.fresh(false, || {}).await, None);
}

#[tokio::test(start_paused = true)]
async fn a_fresh_snapshot_waits_at_most_two_and_a_half_seconds() {
    let diagnostics = Diagnostics::new();
    diagnostics.record(&diagnostics_body());
    let started = tokio::time::Instant::now();
    let snapshot = diagnostics.fresh(true, || {}).await;
    assert!(snapshot.is_some(), "the last snapshot after the wait");
    assert_eq!(started.elapsed(), Duration::from_millis(2_500));
    let started = tokio::time::Instant::now();
    diagnostics.fresh(false, || {}).await;
    assert_eq!(started.elapsed(), Duration::ZERO, "no browser, no wait");
}

#[test]
fn only_preferences_the_extension_stored_are_kept() {
    let diagnostics = Diagnostics::new();
    let report = |preferences: Value, stored: bool| {
        json!({ "capturedAt": NOW, "status": { "connected": true, "paired": true },
            "preferences": preferences, "preferencesStored": stored, "tab": null })
    };
    assert_eq!(
        diagnostics.record(&report(
            json!({ "overwrite": true, "durations": false }),
            false
        )),
        None
    );
    assert_eq!(
        diagnostics.record(&report(
            json!({ "overwrite": false, "durations": true }),
            true
        )),
        Some(BrowserPreferences {
            overwrite: false,
            durations: true
        })
    );
    assert_eq!(
        diagnostics.record(&json!({ "status": {} })),
        None,
        "no preferences, no record"
    );
}
