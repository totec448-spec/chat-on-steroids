//! The recorded `exec` calls (`base/mcp/core/calls/84` to `94`, `unattributed` `06` to `16`)
//! replayed through a real kernel: request in, the whole `tools/call` result out, compared with
//! the corpus value for value.

mod support;

use support::{Fixture, golden, read_json};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_recorded_exec_call_answers_as_the_typescript_app_did() {
    let mut replayed = 0;
    for variant in ["base", "unattributed"] {
        let fixture = Fixture::unattributed(variant);
        let folder = golden().join(variant).join("mcp/core/calls");
        let mut cases: Vec<_> = std::fs::read_dir(&folder)
            .expect("calls folder")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.to_string_lossy().contains("-code-"))
            .collect();
        cases.sort();
        assert_eq!(cases.len(), 11, "{variant} records eleven code-mode calls");
        for path in cases {
            let case = read_json(&path);
            let request = &case["request"];
            assert_eq!(request["tool"], "exec");
            let code = request["arguments"]["code"].as_str().expect("code");
            let request_id = request["headers"]["x-request-id"].as_str();
            let result = fixture.exec(code, request_id).await;
            let actual = serde_json::to_value(&result).expect("result serializes");
            let expected = &case["response"]["messages"][0]["result"];
            assert_eq!(&actual, expected, "{}", path.display());
            replayed += 1;
        }
    }
    assert_eq!(replayed, 22);
}
