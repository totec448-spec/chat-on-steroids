//! Replays the recorded `multi-agent` Core calls of `agents` (cases 01 to 06) through the real
//! kernel and tool, and compares each result with the corpus. The recorded app had no browser
//! connected and "Allow unattributed calls" off, so every call is unplaceable.

mod support;

use std::fs;

use support::{Served, golden, read_json};

#[tokio::test]
async fn recorded_agents_calls_match_the_corpus() {
    let served = Served::new("golden", |_| {});
    let folder = golden().join("multi-agent/mcp/core/calls");
    let mut names: Vec<_> = fs::read_dir(&folder)
        .expect("multi-agent calls")
        .map(|entry| entry.expect("entry").path())
        .collect();
    names.sort();
    let mut compared = 0;
    for path in names {
        let case = read_json(&path);
        if case["request"]["tool"] != "agents" {
            continue;
        }
        let result = served.call(case["request"]["arguments"].clone()).await;
        let expected = &case["response"]["messages"][0]["result"];
        assert_eq!(&result, expected, "{}", path.display());
        compared += 1;
    }
    assert_eq!(compared, 6);
    assert!(served.tabs.spawns.lock().unwrap().is_empty());
    assert_eq!(
        served.swarm_file(),
        None,
        "an unplaceable spawn writes no run"
    );
}
