//! apply_patch through a real kernel: the cases of `test/mcp.test.ts` (`apply_patch`) and
//! `test/codex-apply-patch-*.test.ts`, judged by the answer, the files on disk and the record.

mod support;

use std::sync::Arc;

use cos_patch::{ApplyPatch, ApplyPatchArgs};
use cos_store::Platform;
use cos_tools::{CallContext, Caller, CapabilitySet, FeatureSet, Grants, SurfaceId, Tool};
use cos_types::config::Capability;
use cos_types::session::ToolOutcome;
use serde_json::Value;
use support::{Harness, Tree, golden, read_json, wrap};

const OK_PREFIX: &str = "Exit code: 0\nWall time: <DURATION> seconds\nOutput:\n";

fn base_config() -> Value {
    read_json(&golden().join("base/config.json"))["config"].clone()
}

/// The base variant with some capabilities switched.
fn with_caps(changes: &[(&str, bool)]) -> Harness {
    let mut config = base_config();
    for (name, on) in changes {
        config["capabilities"][*name] = Value::Bool(*on);
    }
    Harness::new(Tree::new("caps").with_fixture(), &config)
}

#[tokio::test]
async fn each_operation_needs_its_own_permission_and_nothing_is_written_on_refusal() {
    let cases = [
        (
            "create",
            wrap("*** Add File: /project/new.txt\n+x"),
            "TOOL_DISABLED: this patch adds a file but Create files and folders is disabled.",
        ),
        (
            "edit",
            wrap("*** Update File: /project/src/greeting.txt\n@@\n-hello world\n+x"),
            "TOOL_DISABLED: this patch updates a file but Edit files is disabled.",
        ),
        (
            "move",
            wrap(
                "*** Update File: /project/src/greeting.txt\n*** Move to: /project/m.txt\n@@\n hello world",
            ),
            "TOOL_DISABLED: this patch moves a file but Move / rename is disabled.",
        ),
        (
            "deleteFile",
            wrap("*** Delete File: /project/src/greeting.txt"),
            "TOOL_DISABLED: this patch deletes a file but Delete files is disabled.",
        ),
    ];
    for (capability, patch, refusal) in cases {
        let harness = with_caps(&[(capability, false)]);
        assert_eq!(harness.patch(&patch).await, (refusal.to_owned(), true));
        assert_eq!(
            harness.tree.read("src/greeting.txt").as_deref(),
            Some("hello world\nsecond line\n")
        );
        assert_eq!(harness.tree.read("new.txt"), None);
        assert_eq!(harness.last_record().outcome, ToolOutcome::ToolRejected);
    }
}

#[tokio::test]
async fn replacing_existing_data_needs_edit_even_through_add_or_move() {
    let harness = with_caps(&[("edit", false)]);
    harness.tree.write("dest.txt", "kept\n");
    let add = wrap("*** Add File: /project/src/greeting.txt\n+x");
    assert_eq!(
        harness.patch(&add).await.0,
        "TOOL_DISABLED: this patch replaces an existing file but Edit files is disabled."
    );
    let onto = wrap(
        "*** Update File: /project/src/greeting.txt\n*** Move to: /project/dest.txt\n@@\n hello world",
    );
    assert_eq!(
        harness.patch(&onto).await.0,
        "TOOL_DISABLED: this patch replaces an existing move destination but Edit files is disabled."
    );
    assert_eq!(harness.tree.read("dest.txt").as_deref(), Some("kept\n"));

    // A rename onto a free name is Move alone, and keeps CRLF bytes because Edit is off.
    harness.tree.write("crlf.txt", "one\r\ntwo\r\n");
    let rename =
        wrap("*** Update File: /project/crlf.txt\n*** Move to: /project/renamed.txt\n@@\n one");
    let (text, is_error) = harness.patch(&rename).await;
    assert!(!is_error, "{text}");
    assert_eq!(
        harness.tree.bytes("renamed.txt"),
        Some(b"one\r\ntwo\r\n".to_vec())
    );
}

#[tokio::test]
async fn a_tool_whose_writing_permissions_went_off_refuses_as_disabled() {
    let tree = Tree::new("disabled").with_fixture();
    let config = tree.config(&base_config());
    let grants = Grants {
        capabilities: CapabilitySet::EMPTY.with(Capability::Read),
        read_only: false,
        features: FeatureSet::default(),
        allow_unattributed: false,
        roots: cos_fs::Roots::from_config(&config.roots, &tree.profile.join("skills")),
        platform: Platform::Windows,
    };
    let cx = CallContext::standalone(
        SurfaceId::Core,
        Arc::new(grants),
        Caller::unattributed(None),
    );
    let args = ApplyPatchArgs {
        patch: wrap("*** Add File: /project/x.txt\n+x"),
    };
    let refusal = ApplyPatch.call(&cx, args).await.expect_err("refused");
    assert_eq!(
        refusal.to_string(),
        "TOOL_DISABLED: apply_patch is disabled by the current Chat On Steroids permissions. Ask the user to enable changing files in the app."
    );
}

#[tokio::test]
async fn add_over_an_existing_file_overwrites_it_and_records_the_replaced_text() {
    let harness = Harness::base();
    let (text, is_error) = harness
        .patch(&wrap("*** Add File: /project/src/greeting.txt\n+clobber"))
        .await;
    assert_eq!(
        (text, is_error),
        (
            format!(
                "{OK_PREFIX}Success. Updated the following files:\nA /project/src/greeting.txt\n"
            ),
            false
        )
    );
    assert_eq!(
        harness.tree.read("src/greeting.txt").as_deref(),
        Some("clobber\n")
    );
    let record = harness.last_record();
    assert_eq!(record.outcome, ToolOutcome::Ok);
    assert_eq!(record.changes.len(), 1);
    assert_eq!(record.changes[0].path, "/project/src/greeting.txt");
    assert_eq!((record.changes[0].added, record.changes[0].removed), (1, 2));
    assert!(!record.changes[0].approximate);
}

#[tokio::test]
async fn a_move_is_recorded_under_its_destination() {
    let harness = Harness::base();
    let patch = wrap(
        "*** Update File: /project/src/greeting.txt\n*** Move to: /project/src/moved.txt\n@@\n-hello world\n+moved",
    );
    let (text, _) = harness.patch(&patch).await;
    assert!(text.ends_with("M /project/src/moved.txt\n"), "{text}");
    assert_eq!(harness.tree.read("src/greeting.txt"), None);
    let changes = harness.last_record().changes;
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].path, "/project/src/moved.txt");
}

#[tokio::test]
async fn a_failure_part_way_rolls_back_and_records_nothing() {
    let harness = Harness::base();
    let patch = wrap(
        "*** Update File: /project/src/greeting.txt\n@@\n-hello world\n+changed\n*** Add File: /project/src/extra.txt\n+extra\n*** Add File: /project/src/greeting.txt/child.txt\n+child",
    );
    let (text, is_error) = harness.patch(&patch).await;
    assert!(is_error);
    assert_eq!(
        text,
        "Exit code: 1\nWall time: <DURATION> seconds\nOutput:\nFailed to create parent directories for /project/src/greeting.txt/child.txt\nAll file changes from this failed patch were rolled back.\n"
    );
    assert_eq!(
        harness.tree.read("src/greeting.txt").as_deref(),
        Some("hello world\nsecond line\n")
    );
    assert_eq!(harness.tree.read("src/extra.txt"), None);
    let record = harness.last_record();
    assert_eq!(record.outcome, ToolOutcome::ToolRejected);
    assert!(record.changes.is_empty());
}

#[tokio::test]
async fn a_dry_run_refusal_writes_nothing_even_for_earlier_hunks() {
    let harness = Harness::base();
    harness.tree.write("src/folder/keep.txt", "k\n");
    let patch = wrap(
        "*** Add File: /project/first.txt\n+first\n*** Update File: /project/src/greeting.txt\n*** Move to: /project/src/folder\n@@\n hello world",
    );
    assert_eq!(
        harness.patch(&patch).await,
        (
            "apply_patch verification failed: Filesystem error (EINVAL)".to_owned(),
            true
        )
    );
    assert_eq!(harness.tree.read("first.txt"), None);

    let onto_itself = wrap(
        "*** Update File: /project/src/greeting.txt\n*** Move to: /project/src/greeting.txt\n@@\n hello world",
    );
    assert_eq!(
        harness.patch(&onto_itself).await.0,
        "apply_patch verification failed: Filesystem error (EINVAL)"
    );
    assert_eq!(
        harness.tree.read("src/greeting.txt").as_deref(),
        Some("hello world\nsecond line\n")
    );
}

#[tokio::test]
async fn later_hunks_see_what_earlier_hunks_of_the_same_patch_left() {
    let harness = Harness::base();
    harness.tree.write("twice.txt", "one\ntwo\nthree\n");
    harness.tree.write("doc.md", "old\n");
    let patch = wrap(concat!(
        "*** Update File: /project/twice.txt\n@@\n-three\n+THREE\n",
        "*** Update File: /project/twice.txt\n@@\n-one\n+ONE\n",
        "*** Delete File: /project/doc.md\n",
        "*** Add File: /project/doc.md\n+new\n",
        "*** Add File: /project/fresh.txt\n+draft\n",
        "*** Update File: /project/fresh.txt\n@@\n-draft\n+final",
    ));
    let (text, is_error) = harness.patch(&patch).await;
    assert!(!is_error, "{text}");
    assert_eq!(
        harness.tree.read("twice.txt").as_deref(),
        Some("ONE\ntwo\nTHREE\n")
    );
    assert_eq!(harness.tree.read("doc.md").as_deref(), Some("new\n"));
    assert_eq!(harness.tree.read("fresh.txt").as_deref(), Some("final\n"));

    let stale =
        wrap("*** Delete File: /project/doc.md\n*** Update File: /project/doc.md\n@@\n-new\n+x");
    let doc = harness.tree.project.join("doc.md");
    assert_eq!(
        harness.patch(&stale).await.0,
        "apply_patch verification failed: Failed to read file to update /project/doc.md: an earlier hunk in this patch removed it"
    );
    assert!(doc.exists());
}

#[tokio::test]
async fn native_and_relative_spellings_resolve_through_the_sandbox_and_never_echo_host_paths() {
    let harness = Harness::base();
    let native = harness.tree.project.join("src").join("greeting.txt");
    let patch = wrap(&format!(
        "*** Update File: {}\n@@\n-hello world\n+native",
        native.display()
    ));
    let (text, _) = harness.patch(&patch).await;
    assert!(text.ends_with("M /project/src/greeting.txt\n"), "{text}");

    let miss = wrap(&format!(
        "*** Update File: {}\n@@\n-absent\n+x",
        native.display()
    ));
    let (text, is_error) = harness.patch(&miss).await;
    assert!(is_error);
    assert!(text.contains("Failed to find expected lines in /project/src/greeting.txt:"));
    let host = harness.tree.project.display().to_string();
    assert!(!text.contains(&host), "{text}");

    let relative = wrap("*** Add File: docs/new.md\n+# New");
    let (text, _) = harness.patch(&relative).await;
    assert!(text.ends_with("A docs/new.md\n"), "{text}");
    assert_eq!(harness.tree.read("docs/new.md").as_deref(), Some("# New\n"));
}

#[tokio::test]
async fn a_mismatch_shows_a_source_excerpt_only_with_read() {
    let source = "unrelated\nfor (const tab of exact) {\n  try {\n    reload(tab.id);\n  } catch { /* actual */ }\n}\n";
    let patch = wrap(
        "*** Update File: /project/loop.ts\n@@\n for (const tab of exact) {\n-  try { reload(tab.id); } catch { /* guessed */ }\n+  fixed();\n }",
    );
    for (read, excerpt) in [(true, true), (false, false)] {
        let harness = with_caps(&[("read", read)]);
        harness.tree.write("loop.ts", source);
        let (text, is_error) = harness.patch(&patch).await;
        assert!(is_error);
        assert_eq!(text.contains("Source excerpt"), excerpt, "{text}");
        assert!(text.starts_with(
            "apply_patch verification failed: Failed to find expected lines in /project/loop.ts:"
        ));
    }
}

#[tokio::test]
async fn grammar_refusals_match_the_recorded_texts() {
    let harness = Harness::base();
    let cases = [
        (
            "*** Begin Patch\n*** Environment ID: remote\n*** Add File: /project/x.txt\n+x\n*** End Patch",
            "apply_patch environment selection is unavailable for this turn",
        ),
        (
            "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: /project/x.txt\n+x\n*** End Patch\nEOF\n",
            "apply_patch verification failed: invalid patch: The first line of the patch must be '*** Begin Patch'",
        ),
        (
            "*** Begin Patch\n*** Frobnicate File: x\n*** End Patch",
            "apply_patch verification failed: invalid hunk at line 2, '*** Frobnicate File: x' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'",
        ),
        (
            "*** Begin Patch\n*** Update File: /project/src/greeting.txt\n*** End Patch",
            "apply_patch verification failed: invalid hunk at line 2, Update file hunk for path '/project/src/greeting.txt' is empty",
        ),
    ];
    for (patch, refusal) in cases {
        assert_eq!(harness.patch(patch).await, (refusal.to_owned(), true));
    }
    assert_eq!(harness.tree.read("x.txt"), None);

    // The gpt-4.1 heredoc wrapper without a command is accepted.
    let wrapper =
        "<<'EOF'\n*** Begin Patch\n*** Add File: /project/x.txt\n+x\n*** End Patch\nEOF\n";
    assert!(!harness.patch(wrapper).await.1);
    assert_eq!(harness.tree.read("x.txt").as_deref(), Some("x\n"));
}

#[tokio::test]
async fn an_empty_patch_body_runs_and_reports_that_nothing_changed() {
    let harness = Harness::base();
    assert_eq!(
        harness.patch("*** Begin Patch\n*** End Patch\n").await,
        (
            "Exit code: 1\nWall time: <DURATION> seconds\nOutput:\nNo files were modified.\nAll file changes from this failed patch were rolled back.\n".to_owned(),
            true
        )
    );
}

#[tokio::test]
async fn a_byte_order_mark_and_unicode_punctuation_are_handled_like_codex() {
    let harness = Harness::base();
    harness
        .tree
        .write("Program.cs", "\u{feff}using System;\nclass Program {}\n");
    harness
        .tree
        .write("quote.txt", "He said \u{201c}hello\u{201d} \u{2014} bye\n");
    let patch = wrap(concat!(
        "*** Update File: /project/Program.cs\n@@\n-using System;\n+using System.Text;\n class Program {}\n",
        "*** Update File: /project/quote.txt\n@@\n-He said \"hello\" - bye\n+replaced",
    ));
    let (text, is_error) = harness.patch(&patch).await;
    assert!(!is_error, "{text}");
    assert_eq!(
        harness.tree.read("Program.cs").as_deref(),
        Some("\u{feff}using System.Text;\nclass Program {}\n")
    );
    assert_eq!(
        harness.tree.read("quote.txt").as_deref(),
        Some("replaced\n")
    );
}

#[tokio::test]
async fn binary_files_are_refused_before_anything_is_written() {
    let harness = Harness::base();
    assert_eq!(
        harness.patch(&wrap("*** Delete File: /project/src/data.bin")).await,
        (
            "apply_patch verification failed: Failed to read /project/src/data.bin: stream did not contain valid UTF-8".to_owned(),
            true
        )
    );
    assert!(harness.tree.bytes("src/data.bin").is_some());
}

#[tokio::test]
async fn a_patch_with_no_approved_folder_has_nowhere_to_go() {
    let mut config = base_config();
    config["roots"] = Value::Array(Vec::new());
    let harness = Harness::new(Tree::new("no-roots"), &config);
    assert_eq!(
        harness.patch(&wrap("*** Add File: x.txt\n+x")).await,
        (
            "No folder is approved, so there is nowhere to apply the patch.".to_owned(),
            true
        )
    );
}
