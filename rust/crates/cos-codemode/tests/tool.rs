//! Code mode as a kernel tool: caller proof, child calls through the kernel's nested path, and
//! the note for tools another connector owns (`test/code-mode-mcp.test.ts`).

mod support;

use std::sync::Arc;

use cos_tools::{Attribution, BoxFuture, Caller, EpochMs, RequestId};
use cos_types::ids::{ConversationId, SessionId};
use support::{Fixture, golden, read_json, texts};

/// Places every call in one chat, with or without the request id that names it.
struct Proven;

impl Attribution for Proven {
    fn resolve<'a>(
        &'a self,
        _tool: &'a str,
        _started_at: EpochMs,
        request_id: Option<&'a RequestId>,
    ) -> BoxFuture<'a, Caller> {
        let caller = Caller {
            request_id: request_id.cloned(),
            chat: Some((
                ConversationId::parse("conversation-1").expect("id"),
                SessionId::parse("2026-10-20-abcdef12").expect("id"),
            )),
        };
        Box::pin(async move { caller })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_script_needs_exact_chat_proof_or_allow_unattributed_calls() {
    let proven = Fixture::variant("base", Arc::new(Proven));
    let ran = proven.exec("text(1 + 1)", Some("wfr_proof/1")).await;
    assert!(!ran.is_error);
    assert_eq!(texts(&ran), ["2"], "an attributed result carries no notice");

    let no_request = proven.exec("text(1 + 1)", None).await;
    assert!(no_request.is_error);
    assert!(texts(&no_request)[0].starts_with("CALLER_IDENTITY_REQUIRED"));

    let anonymous = Fixture::unattributed("base")
        .exec("text(1 + 1)", Some("r-1"))
        .await;
    assert!(texts(&anonymous)[0].starts_with("CALLER_IDENTITY_REQUIRED"));
    let allowed = Fixture::unattributed("unattributed")
        .exec("text(1 + 1)", None)
        .await;
    assert_eq!(texts(&allowed)[0], "2");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn children_run_through_the_kernel_and_are_recorded_beside_the_script() {
    let fixture = Fixture::unattributed("unattributed");
    let listed = fixture
        .exec(
            "text([typeof tools.computer, typeof tools.exec, typeof tools.session_finish, typeof tools.read]);",
            None,
        )
        .await;
    assert_eq!(
        texts(&listed)[0],
        r#"["undefined","undefined","undefined","function"]"#,
        "only what Core lists, without exec"
    );

    let invalid = fixture
        .exec("text(await tools.read({paths: 1}))", None)
        .await;
    assert!(
        texts(&invalid)[0].contains("INVALID_ARGUMENTS: paths: Invalid input: expected array"),
        "{:?}",
        texts(&invalid)
    );
    let records = fixture.records();
    let filed: Vec<(&str, bool)> = records
        .iter()
        .map(|call| (call.tool, call.nested))
        .collect();
    assert_eq!(filed, [("exec", false), ("read", true), ("exec", false)]);
    assert_eq!(records[1].arguments, serde_json::json!({"paths": 1}));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn calling_another_connectors_tool_names_that_connector() {
    let fixture = Fixture::unattributed("unattributed");
    let result = fixture
        .exec(
            "try { await tools.read_clipboard({}); } catch (error) { text(String(error)); }",
            Some("r-1"),
        )
        .await;
    let all = texts(&result).join("\n");
    assert!(all.contains("not a function"), "{all}");
    assert!(
        all.contains("UNKNOWN_TOOL_NAMES: this script used tools.read_clipboard (a Chat On Steroids Desktop tool), which Chat On Steroids Core does not offer"),
        "{all}"
    );
    let checked = fixture
        .exec(
            "text(typeof tools.read_clipboard); if (tools[\"view_image\"]) {}",
            None,
        )
        .await;
    assert_eq!(
        texts(&checked).len(),
        2,
        "checking for a tool is not calling it"
    );
}

/// The recorded note, with this computer's connector suffix and two connectors on one Secure
/// Tunnel ID. The shared-ID sentence is `unknownToolNote`'s wording in `code-mode-tool.ts`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_unknown_tool_note_names_suffixed_connectors_and_a_shared_tunnel_id() {
    let recorded =
        read_json(&golden().join("unattributed/mcp/core/calls/10-code-unknown-tool.json"));
    let corpus_note = recorded["response"]["messages"][0]["result"]["content"][1]["text"]
        .as_str()
        .expect("recorded note");
    let code = recorded["request"]["arguments"]["code"]
        .as_str()
        .expect("recorded script");
    let fixture = Fixture::unattributed("unattributed");
    fixture.edit(|config| config.connector_suffix = Some("Work PC".to_owned()));
    let suffixed = corpus_note.replace("Chat On Steroids Core", "Chat On Steroids Core (Work PC)");
    assert_ne!(suffixed, corpus_note, "the corpus note names Core");
    assert_eq!(texts(&fixture.exec(code, Some("r-1")).await)[1], suffixed);

    let id = "tunnel_0123456789abcdef0123456789abcdef";
    fixture.edit(|config| {
        config.tunnel.tunnel_id = format!(" {id} ");
        config.tunnel.plugins_tunnel_id = Some(id.to_owned());
    });
    assert_eq!(
        texts(&fixture.exec(code, Some("r-1")).await)[1],
        format!(
            "{suffixed} Chat On Steroids Core (Work PC) shares its Secure Tunnel ID with Chat On Steroids Plugins (Work PC), so ChatGPT sends calls to either connector and a script meant for one can run on the other. Give each connector its own tunnel ID in Setup."
        )
    );

    let other = fixture
        .exec("await tools.read_clipboard({});", Some("r-1"))
        .await;
    assert!(
        texts(&other)[1].starts_with("UNKNOWN_TOOL_NAMES: this script used tools.read_clipboard (a Chat On Steroids Desktop (Work PC) tool), which Chat On Steroids Core (Work PC) does not offer"),
        "{:?}",
        texts(&other)
    );
}

/// `ALL_TOOLS` is what Core lists now, minus `exec`, with the listed descriptions. The fixture
/// registers `read` and `view_image`, so the corpus list is narrowed to those two.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn all_tools_is_the_live_listing_without_exec() {
    let listed = read_json(&golden().join("unattributed/mcp/core/tools-list.json"));
    let expected: Vec<serde_json::Value> = listed["response"]["messages"][0]["result"]["tools"]
        .as_array()
        .expect("recorded tools")
        .iter()
        .filter(|tool| tool["name"] == "read" || tool["name"] == "view_image")
        .map(|tool| serde_json::json!({ "name": tool["name"], "description": tool["description"] }))
        .collect();
    let fixture = Fixture::unattributed("unattributed");
    let script = "text(JSON.stringify(ALL_TOOLS)); text(Object.keys(tools).join());";
    let all = fixture.exec(script, None).await;
    let seen: serde_json::Value = serde_json::from_str(&texts(&all)[0]).expect("json");
    assert_eq!(seen, serde_json::Value::Array(expected));
    assert_eq!(texts(&all)[1], "read,view_image");

    fixture.edit(|config| config.capabilities.read = false);
    let narrowed = fixture.exec(script, None).await;
    assert_eq!(
        texts(&narrowed)[1],
        "read",
        "view_image left with the Read permission"
    );
}
