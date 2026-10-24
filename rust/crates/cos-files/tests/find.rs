//! `find` through the kernel, with the cases of `test/search.test.ts` and the `find` cases of
//! `test/mcp.test.ts`.

mod support;

use std::fs;

use serde_json::{Value, json};
use support::Served;

fn served() -> Served {
    let served = Served::variant("no-command");
    for (path, content) in [
        (
            "w/src/app.ts",
            "const name = 'app';\nexport const Needle = 1;\n",
        ),
        ("w/src/lib/util.ts", "export const helper = 1;\n"),
        ("w/notes.txt", "first\nthe needle is here\n"),
        ("w/node_modules/dep/index.js", "needle in a dependency\n"),
        ("w/.claude-cache/x.txt", "needle in tooling\n"),
        ("w/BUILD/out.txt", "needle in build output\n"),
        ("w/Target.TXT", "needle upper\n"),
    ] {
        write(&served, path, content);
    }
    served
}

fn write(served: &Served, relative: &str, content: impl AsRef<[u8]>) {
    let path = served.dirs.project.join(relative);
    fs::create_dir_all(path.parent().expect("parent")).expect("folders");
    fs::write(path, content).expect("file");
}

async fn find(served: &Served, arguments: Value) -> (String, bool) {
    served.text("find", arguments).await
}

/// The hit lines of an answer, sorted: ripgrep searches files in parallel, so the TypeScript
/// order across files was never fixed.
fn hits(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = text
        .lines()
        .skip(1)
        .take_while(|line| !line.is_empty())
        .map(str::to_owned)
        .collect();
    lines.sort();
    lines
}

fn meta<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    text.lines()
        .find_map(|line| line.strip_prefix(&format!("{key}: ")))
}

#[tokio::test]
async fn finds_files_by_name_substring_with_virtual_paths() {
    let served = served();
    let (text, failed) = find(&served, json!({ "query": "UTIL", "path": "/project/w" })).await;
    assert!(!failed);
    assert_eq!(hits(&text), ["/project/w/src/lib/util.ts"]);
    assert_eq!(
        served.last_count(),
        Some(1),
        "the hits, for the session summary"
    );
    assert!(!text.contains(&*served.dirs.project.to_string_lossy()));
    assert_eq!(meta(&text, "files_scanned"), Some("4"), "{text}");
    assert!(meta(&text, "content_file_limit").is_none());
}

#[tokio::test]
async fn skips_build_dependency_and_prefixed_tooling_folders_unless_told_otherwise() {
    let served = served();
    let (text, _) = find(
        &served,
        json!({ "query": "needle", "path": "/project/w", "mode": "content" }),
    )
    .await;
    assert_eq!(
        hits(&text),
        [
            "/project/w/Target.TXT:1: needle upper",
            "/project/w/notes.txt:2: the needle is here",
            "/project/w/src/app.ts:2: export const Needle = 1;",
        ]
    );
    assert_eq!(meta(&text, "content_file_limit"), Some("2.0 MB"));
    let (everywhere, _) = find(
        &served,
        json!({ "query": "needle", "path": "/project/w", "mode": "content", "exclude": [] }),
    )
    .await;
    assert_eq!(hits(&everywhere).len(), 6, "{everywhere}");
    let (names, _) = find(
        &served,
        json!({ "query": "x", "path": "/project/w", "exclude": [] }),
    )
    .await;
    assert!(
        names.contains("/project/w/.claude-cache/x.txt")
            && names.contains("/project/w/node_modules/dep/index.js")
    );
}

#[tokio::test]
async fn applies_include_globs_and_case_rules() {
    let served = served();
    let (slashed, _) = find(&served, json!({ "query": "needle", "path": "/project/w", "mode": "content", "include": "src/**/*.ts" })).await;
    assert_eq!(
        hits(&slashed),
        ["/project/w/src/app.ts:2: export const Needle = 1;"]
    );
    let (bare, _) = find(
        &served,
        json!({ "query": "t", "path": "/project/w", "include": "*.ts" }),
    )
    .await;
    assert_eq!(
        hits(&bare),
        ["/project/w/src/app.ts", "/project/w/src/lib/util.ts"]
    );
    let (sensitive, _) = find(&served, json!({ "query": "Needle", "path": "/project/w", "mode": "content", "case_sensitive": true })).await;
    assert_eq!(
        hits(&sensitive),
        ["/project/w/src/app.ts:2: export const Needle = 1;"]
    );
    let (upper, _) = find(
        &served,
        json!({ "query": "x", "path": "/project/w", "mode": "content", "include": "*.txt" }),
    )
    .await;
    assert_eq!(
        hits(&upper),
        Vec::<String>::new(),
        "a case-insensitive include matches Target.TXT; its text has no x: {upper}"
    );
}

#[tokio::test]
async fn ripgrep_only_glob_syntax_is_literal() {
    let served = served();
    write(&served, "w/[a].txt", "needle\n");
    write(&served, "w/a.txt", "needle\n");
    let (text, _) = find(
        &served,
        json!({ "query": "needle", "path": "/project/w", "mode": "content", "include": "[a].txt" }),
    )
    .await;
    assert_eq!(hits(&text), ["/project/w/[a].txt:1: needle"]);
}

#[tokio::test]
async fn stops_at_max_results_and_says_why() {
    let served = served();
    let (text, _) = find(
        &served,
        json!({ "query": "e", "path": "/project/w", "max_results": 1 }),
    )
    .await;
    assert_eq!(hits(&text).len(), 1);
    assert_eq!(meta(&text, "truncated"), Some("limit"));
    let (content, _) = find(
        &served,
        json!({ "query": "e", "path": "/project/w", "mode": "content", "max_results": 2 }),
    )
    .await;
    assert_eq!(hits(&content).len(), 2);
    assert_eq!(meta(&content, "results_returned"), Some("2"));
    assert_eq!(meta(&content, "truncated"), Some("limit"));
    let (all, _) = find(&served, json!({ "query": "util", "path": "/project/w" })).await;
    assert!(meta(&all, "truncated").is_none());
}

#[tokio::test]
async fn counts_files_searched_not_files_that_matched_and_skips_binary_files() {
    let served = Served::variant("no-command");
    write(&served, "c/a.txt", "needle\n");
    write(&served, "c/b.txt", "nothing\n");
    write(&served, "c/bin.dat", b"needle\0\x01\x02");
    let (text, _) = find(
        &served,
        json!({ "query": "needle", "path": "/project/c", "mode": "content" }),
    )
    .await;
    assert_eq!(hits(&text), ["/project/c/a.txt:1: needle"]);
    assert_eq!(meta(&text, "files_scanned"), Some("3"));
}

#[tokio::test]
async fn searches_utf16_and_cuts_long_lines() {
    let served = Served::variant("no-command");
    let utf16: Vec<u8> = [0xff, 0xfe]
        .into_iter()
        .chain(
            "one\nwide needle\n"
                .encode_utf16()
                .flat_map(u16::to_le_bytes),
        )
        .collect();
    write(&served, "u/wide.txt", utf16);
    write(
        &served,
        "u/long.txt",
        format!("  needle{}  \n", "z".repeat(400)),
    );
    let (text, _) = find(
        &served,
        json!({ "query": "needle", "path": "/project/u", "mode": "content" }),
    )
    .await;
    let found = hits(&text);
    assert_eq!(found[1], "/project/u/wide.txt:2: wide needle");
    assert_eq!(
        found[0],
        format!("/project/u/long.txt:1: needle{}…", "z".repeat(294))
    );
}

#[tokio::test]
async fn searches_one_named_file() {
    let served = served();
    let (text, failed) = find(
        &served,
        json!({ "query": "needle", "path": "/project/w/notes.txt", "mode": "content" }),
    )
    .await;
    assert!(!failed);
    assert_eq!(
        text,
        "1 matches\n/project/w/notes.txt:2: the needle is here"
    );
    assert_eq!(served.last_count(), Some(1));
    let (filtered, _) = find(&served, json!({ "query": "needle", "path": "/project/w/notes.txt", "mode": "content", "include": "*.ts" })).await;
    assert_eq!(filtered, "No matches");
    assert_eq!(served.last_count(), Some(0));
    let (named, _) = find(
        &served,
        json!({ "query": "NOTES", "path": "/project/w/notes.txt" }),
    )
    .await;
    assert_eq!(named, "1 matches\n/project/w/notes.txt");
}

#[tokio::test]
async fn an_oversized_named_file_is_not_searched_and_says_so() {
    let served = served();
    let big = fs::File::create(served.dirs.project.join("w/big.log")).expect("big");
    big.set_len(2 * 1024 * 1024 + 1).expect("size");
    let (text, failed) = find(
        &served,
        json!({ "query": "needle", "path": "/project/w/big.log", "mode": "content" }),
    )
    .await;
    assert!(failed);
    assert_eq!(
        text,
        "File was not searched: content search skips files over 2.0 MB. Narrow it with read start_line/end_line, or use exec_command when command execution is available."
    );
}

#[tokio::test]
async fn regex_search_and_its_refusals() {
    let served = served();
    let (text, _) = find(
        &served,
        json!({ "query": "help(er)?\\b", "path": "/project/w", "mode": "content", "regex": true }),
    )
    .await;
    assert_eq!(
        hits(&text),
        ["/project/w/src/lib/util.ts:1: export const helper = 1;"]
    );
    let (broken, failed) = find(
        &served,
        json!({ "query": "(", "path": "/project/w", "mode": "content", "regex": true }),
    )
    .await;
    assert!(failed);
    assert_eq!(broken, "ripgrep search failed (exit 2)");
    let (literal, _) = find(
        &served,
        json!({ "query": "(", "path": "/project/w", "mode": "content" }),
    )
    .await;
    assert!(literal.starts_with("No matches"));
}

#[tokio::test]
async fn refines_arguments_the_schema_cannot_express() {
    let served = served();
    let (blank, failed) = find(&served, json!({ "query": "   ", "mode": "content" })).await;
    assert!(failed);
    assert_eq!(
        blank,
        "Input validation error: Invalid arguments for tool find: query: query must contain non-whitespace text"
    );
    let (regex, _) = find(
        &served,
        json!({ "query": "notes", "mode": "name", "regex": true }),
    )
    .await;
    assert_eq!(
        regex,
        "Input validation error: Invalid arguments for tool find: regex: regex=true is only valid with mode=content"
    );
    let (exclude, _) = find(
        &served,
        json!({ "query": "x", "exclude": ["a/b", "pre*", "*x"] }),
    )
    .await;
    assert_eq!(
        exclude,
        "Input validation error: Invalid arguments for tool find: exclude.0: exclude entries must be folder names with at most one trailing * prefix wildcard, exclude.2: exclude entries must be folder names with at most one trailing * prefix wildcard"
    );
}

#[tokio::test]
async fn without_a_path_every_root_is_searched() {
    let served = Served::variant("no-command");
    let (text, _) = find(
        &served,
        json!({ "query": "quartz-lantern", "mode": "content" }),
    )
    .await;
    assert_eq!(
        hits(&text),
        ["/project/src/notes.md:1: The needle phrase is quartz-lantern."]
    );
    assert_eq!(meta(&text, "files_scanned"), Some("6"));
}
