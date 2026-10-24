//! `read` through the kernel, with the cases of `test/read-backend.test.ts` and the `read` cases
//! of `test/mcp.test.ts`.

mod support;

use std::fs;
use std::path::Path;

use serde_json::{Value, json};
use support::{Served, golden, read_json};

fn base() -> Served {
    Served::variant("base")
}

fn write(served: &Served, relative: &str, content: impl AsRef<[u8]>) {
    let path = served.dirs.project.join(relative);
    fs::create_dir_all(path.parent().expect("parent")).expect("folders");
    fs::write(path, content).expect("file");
}

fn notes(served: &Served) {
    let text: String = (1..=50).map(|i| format!("note line {i}\n")).collect();
    write(served, "notes.txt", text);
    write(served, "src/app.ts", "export const name = \"app\";\n");
    write(served, "src/lib/util.ts", "export const helper = 1;\n");
}

async fn read(served: &Served, arguments: Value) -> (String, bool) {
    served.text("read", arguments).await
}

#[tokio::test]
async fn reads_a_whole_small_file_with_its_total() {
    let served = base();
    notes(&served);
    let (text, failed) = read(&served, json!({ "paths": ["/project/notes.txt"] })).await;
    assert!(!failed);
    assert!(text.contains("lines 1-50 of 50"), "{text}");
    assert!(text.contains("1\tnote line 1\n") && text.contains("50\tnote line 50"));
    assert!(!text.contains("continue from line"));
}

#[tokio::test]
async fn a_ranged_read_states_the_file_total_and_what_follows() {
    let served = base();
    notes(&served);
    let (text, _) = read(
        &served,
        json!({ "paths": ["/project/notes.txt"], "start_line": 3, "end_line": 5 }),
    )
    .await;
    assert!(text.contains("lines 3-5 of 50"), "{text}");
    assert!(text.contains("(more lines follow — continue from line 6)"));
    assert!(!text.contains("note line 2\n") && !text.contains("note line 6"));

    let (to_end, _) = read(
        &served,
        json!({ "paths": ["/project/notes.txt"], "start_line": 48 }),
    )
    .await;
    assert!(
        to_end.contains("lines 48-50 of 50") && !to_end.contains("more lines follow"),
        "{to_end}"
    );

    let (exact, _) = read(
        &served,
        json!({ "paths": ["/project/notes.txt"], "start_line": 49, "end_line": 50 }),
    )
    .await;
    assert!(!exact.contains("more lines follow"), "{exact}");
}

#[tokio::test]
async fn an_inverted_range_is_refused() {
    let served = base();
    notes(&served);
    let (text, failed) = read(
        &served,
        json!({ "paths": ["/project/notes.txt"], "start_line": 5, "end_line": 3 }),
    )
    .await;
    assert!(failed);
    assert!(
        text.ends_with("ERROR ---\nendLine must be greater than or equal to startLine"),
        "{text}"
    );
}

#[tokio::test]
async fn max_bytes_bounds_the_answer_and_says_where_to_continue() {
    let served = base();
    notes(&served);
    let (text, failed) = read(
        &served,
        json!({ "paths": ["/project/notes.txt"], "max_bytes": 60 }),
    )
    .await;
    assert!(!failed);
    assert!(text.contains("lines 1-4 of 50"), "{text}");
    assert!(
        text.contains("(output cap reached; continue from line 5 or raise max_bytes up to 524288)")
    );
}

#[tokio::test]
async fn line_number_prefixes_spend_the_same_budget() {
    let served = base();
    write(&served, "empty-lines.txt", "\n".repeat(90_000));
    let (text, failed) = read(
        &served,
        json!({ "paths": ["/project/empty-lines.txt"], "max_bytes": 65536 }),
    )
    .await;
    assert!(!failed);
    assert!(text.len() < 72 * 1024, "{} bytes", text.len());
    assert!(text.contains("output cap reached"));
}

#[tokio::test]
async fn decodes_text_as_typescript_does() {
    let served = base();
    write(&served, "crlf.txt", "one\r\ntwo\r\n");
    write(&served, "bom.txt", b"\xef\xbb\xbfhello\n");
    let utf16le: Vec<u8> = [0xff, 0xfe]
        .into_iter()
        .chain("hi\nthere\n".encode_utf16().flat_map(u16::to_le_bytes))
        .collect();
    write(&served, "le.txt", utf16le);
    let utf16be: Vec<u8> = [0xfe, 0xff]
        .into_iter()
        .chain("big\n".encode_utf16().flat_map(u16::to_be_bytes))
        .collect();
    write(&served, "be.txt", utf16be);
    write(&served, "no-newline.txt", "a\nb");
    write(&served, "empty.txt", "");
    write(&served, "leading-empty.txt", "\nsecond\n");
    let section = |text: &str, path: &str| {
        text.split("\n\n")
            .find(|part| part.starts_with(&format!("--- /project/{path} ")))
            .map(str::to_owned)
            .unwrap_or_default()
    };
    let (text, _) = read(
        &served,
        json!({ "paths": [
        "/project/crlf.txt", "/project/bom.txt", "/project/le.txt", "/project/be.txt",
        "/project/no-newline.txt", "/project/empty.txt"
    ] }),
    )
    .await;
    assert!(
        section(&text, "crlf.txt").ends_with("---\n1\tone\n2\ttwo"),
        "{text}"
    );
    assert!(section(&text, "bom.txt").ends_with("---\n1\thello"));
    assert!(
        section(&text, "le.txt").contains("lines 1-2 of 2")
            && section(&text, "le.txt").ends_with("1\thi\n2\tthere")
    );
    assert!(section(&text, "be.txt").ends_with("1\tbig"));
    assert!(
        section(&text, "no-newline.txt").contains("lines 1-2 of 2")
            && section(&text, "no-newline.txt").ends_with("2\tb")
    );
    assert!(
        section(&text, "empty.txt").contains("no lines in that range; the file has 0"),
        "{text}"
    );

    let (first, _) = read(
        &served,
        json!({ "paths": ["/project/leading-empty.txt"], "start_line": 1, "end_line": 1 }),
    )
    .await;
    assert!(
        first.contains("lines 1-1 of 2")
            && first.ends_with("\n1\t\n(more lines follow — continue from line 2)"),
        "{first:?}"
    );
}

#[tokio::test]
async fn a_line_too_long_for_max_bytes_names_the_remedy() {
    let served = base();
    write(&served, "wide.txt", format!("{}\n", "w".repeat(100)));
    let (text, failed) = read(
        &served,
        json!({ "paths": ["/project/wide.txt"], "max_bytes": 10 }),
    )
    .await;
    assert!(failed);
    assert!(text.contains("Line 1 is larger than max_bytes=10. Increase max_bytes (up to 524288) or use exec_command to transform it."));
}

#[tokio::test]
async fn honours_a_line_range_across_every_file_and_says_so() {
    let served = base();
    notes(&served);
    let (text, failed) = read(&served, json!({ "paths": ["/project/notes.txt", "/project/src/app.ts"], "start_line": 10, "end_line": 12 })).await;
    assert!(!failed);
    assert!(text.contains("/project/notes.txt — lines 10-12 of 50"));
    assert!(text.contains("/project/src/app.ts — no lines in that range; the file has 1"));
    assert!(text.ends_with("(start_line/end_line applied to each of the 2 files this call resolved to; every header states the lines actually returned)"), "{text}");

    let (single, _) = read(
        &served,
        json!({ "paths": ["/project/notes.txt"], "start_line": 10, "end_line": 12 }),
    )
    .await;
    assert!(!single.contains("applied to each"));
}

#[tokio::test]
async fn reads_a_per_path_range_spelled_after_a_colon() {
    let served = base();
    notes(&served);
    let (text, failed) = read(
        &served,
        json!({
            "paths": ["/project/notes.txt:3-4", "/project/notes.txt:48", "/project/src/app.ts"],
            "start_line": 1, "end_line": 1
        }),
    )
    .await;
    assert!(!failed, "{text}");
    assert!(text.contains("lines 3-4 of 50") && text.contains("4\tnote line 4"));
    assert!(text.contains("lines 48-50 of 50") && !text.contains("note line 47"));
    assert!(text.contains("export const name = \"app\";"));
    assert!(!text.contains("applied to each of"));
    let (_, backwards) = read(&served, json!({ "paths": ["/project/notes.txt:9-3"] })).await;
    assert!(backwards);
}

#[tokio::test]
async fn one_failed_path_keeps_the_reads_that_worked_but_all_failed_is_an_error() {
    let served = base();
    notes(&served);
    let (partial, failed) = read(
        &served,
        json!({ "paths": ["/project/src/app.ts", "/project/nope.txt"] }),
    )
    .await;
    assert!(!failed);
    assert!(
        partial.contains("export const name")
            && partial.contains("--- /project/nope.txt — ERROR ---\nNot found: /project/nope.txt")
    );
    assert_eq!(
        served.last_count(),
        Some(1),
        "only the path that was read counts (noteCount)"
    );
    let (all, failed) = read(
        &served,
        json!({ "paths": ["/project/nope-a.txt", "/project/nope-b.txt"] }),
    )
    .await;
    assert!(failed);
    assert!(
        all.contains("/project/nope-a.txt — ERROR") && all.contains("/project/nope-b.txt — ERROR")
    );
}

#[tokio::test]
async fn a_missing_path_lists_the_nearest_folder_or_the_root_it_names() {
    let served = base();
    notes(&served);
    let (text, failed) = read(
        &served,
        json!({ "paths": ["/project/src/lib/nested/util.ts"] }),
    )
    .await;
    assert!(failed);
    assert!(
        text.contains("The nearest existing folder is /project/src/lib; it contains: f util.ts"),
        "{text}"
    );
    let (top, _) = read(&served, json!({ "paths": ["/project/lib/util.ts"] })).await;
    assert!(top.contains("The nearest existing folder is /project; it contains: d .git, d src, f notes.txt, f README.md"), "{top}");

    let two = Served::variant("two-roots");
    let (meant, _) = read(
        &two,
        json!({ "paths": ["/second/projects/project/src/greeting.txt"] }),
    )
    .await;
    assert!(meant.contains("Did you mean /project/src/greeting.txt? It exists under the approved root of that name."), "{meant}");
    assert!(!meant.contains("nearest existing folder"));
}

#[tokio::test]
async fn the_virtual_root_lists_the_shared_folders() {
    let served = base();
    let (text, failed) = read(&served, json!({ "paths": ["/", "/project/README.md"] })).await;
    assert!(!failed);
    assert!(
        text.starts_with("--- / — 2 entries, one level ---\nd project\nd skills\n\n"),
        "{text}"
    );
}

#[tokio::test]
async fn a_folder_lists_one_level_folders_first_in_locale_order() {
    let served = base();
    write(&served, "list/b.txt", "b");
    write(&served, "list/A.txt", "a");
    write(&served, "list/_x.txt", "x");
    write(&served, "list/Zeta/inner.txt", "z");
    write(&served, "list/alpha/inner.txt", "z");
    let (text, _) = read(&served, json!({ "paths": ["/project/list"] })).await;
    assert_eq!(
        text,
        "--- /project/list — 5 entries, one level ---\nd alpha\nd Zeta\nf _x.txt  1 B\nf A.txt  1 B\nf b.txt  1 B"
    );
}

#[tokio::test]
async fn a_folder_link_is_listed_but_not_classified() {
    let served = base();
    let outside = served.dirs.run.join("outside");
    fs::create_dir_all(&outside).expect("outside");
    let link = served.dirs.project.join("linked");
    if !dir_link(&outside, &link) {
        return;
    }
    let (text, _) = read(&served, json!({ "paths": ["/project"] })).await;
    assert!(text.contains("\n? linked"), "{text}");
}

fn dir_link(target: &Path, link: &Path) -> bool {
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }
    #[cfg(not(windows))]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
}

#[tokio::test]
async fn globs_expand_and_report_their_bounds() {
    let served = base();
    notes(&served);
    let (text, failed) = read(&served, json!({ "paths": ["/project/src/**/*.ts"] })).await;
    assert!(!failed);
    assert!(text.contains("export const name") && text.contains("export const helper"));

    let (none, failed) = read(&served, json!({ "paths": ["/project/**/*.nothing"] })).await;
    assert!(!failed);
    assert_eq!(none, "/project/**/*.nothing: no matches");

    for index in 0..20 {
        write(&served, &format!("cap/match-{index:02}.ts"), "x\n");
    }
    let (exact, _) = read(&served, json!({ "paths": ["/project/cap/*.ts"] })).await;
    assert!(!exact.contains("more than 20 matches"));
    write(&served, "cap/match-20.ts", "x\n");
    let (over, _) = read(&served, json!({ "paths": ["/project/cap/*.ts"] })).await;
    assert!(
        over.ends_with("/project/cap/*.ts: more than 20 matches, narrow the pattern"),
        "{over}"
    );
}

#[tokio::test]
async fn an_exhausted_glob_scan_is_reported_instead_of_no_matches() {
    let served = base();
    let folder = served.dirs.project.join("scan");
    fs::create_dir_all(&folder).expect("scan");
    for index in 0..5_000 {
        fs::write(folder.join(format!("{index:05}.txt")), "").expect("file");
    }
    fs::write(
        folder.join("zzzzz.needle.ts"),
        "export const needle = true;\n",
    )
    .expect("needle");
    let (text, failed) = read(
        &served,
        json!({ "paths": ["/project/scan/**/*.needle.ts"] }),
    )
    .await;
    assert!(!failed);
    assert!(
        text.contains("glob scan stopped after 5000 entries"),
        "{text}"
    );
    assert!(!text.contains(": no matches"));
}

#[tokio::test]
async fn a_walk_past_the_depth_ceiling_is_truncated() {
    let served = base();
    let mut deep = String::from("deep");
    for _ in 0..65 {
        deep.push_str("/d");
    }
    write(&served, &format!("{deep}/x.md"), "x\n");
    let (text, _) = read(&served, json!({ "paths": ["/project/deep/**/*.md"] })).await;
    assert!(
        text.contains("glob scan stopped after 5000 entries before finding a match"),
        "{text}"
    );
}

#[tokio::test]
async fn metadata_only_and_no_browse_answer_what_was_granted() {
    let mut config = read_json(&golden().join("base/config.json"))["config"].clone();
    config["capabilities"]["read"] = json!(false);
    config["capabilities"]["browse"] = json!(false);
    let served = Served::with_config("metadata", &config);
    let (file, failed) = read(&served, json!({ "paths": ["/project/src/greeting.txt"] })).await;
    assert!(!failed);
    assert!(
        file.contains("type: file\nsize: 24 B")
            && file.contains(
                "binary: false\nlines: 2\n(file contents need the Read files permission)"
            ),
        "{file}"
    );
    let (folder, _) = read(&served, json!({ "paths": ["/project/src", "/"] })).await;
    assert!(folder.starts_with(
        "--- /project/src ---\nTOOL_DISABLED: listing folders needs the Browse folders permission."
    ));
    assert!(folder.contains("--- / ---\nTOOL_DISABLED"));

    config["capabilities"]["metadata"] = json!(false);
    let none = Served::with_config("none", &config);
    // With search still on, `read` is unlisted; a call is the kernel's unknown tool.
    assert!(
        none.call("read", json!({ "paths": ["/project"] }))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn images_have_their_own_budget() {
    let served = base();
    let png = support::decode_base64(support::TINY_PNG);
    for index in 0..5 {
        write(&served, &format!("img/{index}.png"), &png);
    }
    let result = served
        .call("read", json!({ "paths": ["/project/img/*.png"] }))
        .await
        .expect("listed");
    let images = result["content"]
        .as_array()
        .expect("content")
        .iter()
        .filter(|part| part["type"] == "image")
        .count();
    assert_eq!(images, 4);
    let text = result["content"][0]["text"].as_str().expect("text");
    assert!(text.contains("--- /project/img/4.png — ERROR ---\nRead image output cap reached; read remaining images in another call or use view_image."), "{text}");
}

#[tokio::test]
async fn a_file_that_is_not_an_image_but_named_like_one_fails_its_section() {
    let served = base();
    write(&served, "fake.png", "not an image");
    let (text, failed) = read(&served, json!({ "paths": ["/project/fake.png"] })).await;
    assert!(failed);
    assert!(
        text.ends_with("ERROR ---\nunable to process image: invalid or unsupported image data")
    );
}
