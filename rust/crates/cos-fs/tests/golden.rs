//! Replays the path decisions of the golden corpus (`rust/golden`) through the sandbox: each
//! case's model-supplied path, resolved for the access its tool needs, must give the recorded
//! refusal text or the recorded virtual path.

mod common;

use std::path::{Path, PathBuf};

use common::Scratch;
use cos_fs::{Access, Roots, resolve};
use serde_json::Value;

/// The fixture project every variant records against (`rust/golden/README.md`).
struct Fixture {
    scratch: Scratch,
}

impl Fixture {
    fn new() -> Self {
        let scratch = Scratch::new("golden");
        scratch.write("project/README.md", b"# fixture\n");
        scratch.write("project/src/greeting.txt", b"hello world\nsecond line\n");
        scratch.write("project/src/notes.md", b"notes\n");
        scratch.write("project/src/data.bin", &(0..=255).collect::<Vec<u8>>());
        scratch.write("project/src/pixel.png", b"png");
        scratch.write("project/src/large.txt", b"large\n");
        scratch.write("second/other.txt", b"second root file\n");
        scratch.dir("second/src");
        scratch.dir("profile/skills");
        Self { scratch }
    }

    fn placeholders(&self, text: &str) -> String {
        let native = |name: &str| self.scratch.join(name).to_string_lossy().into_owned();
        text.replace("<PROJECT>", &native("project"))
            .replace("<SECOND>", &native("second"))
            .replace("<PROFILE>", &native("profile"))
    }

    fn roots(&self, variant: &str) -> Roots {
        let config: Value = read_json(&corpus().join(variant).join("config.json"));
        let roots: Vec<cos_types::config::Root> =
            serde_json::from_value(config["config"]["roots"].clone()).unwrap();
        let roots: Vec<cos_types::config::Root> = roots
            .into_iter()
            .map(|mut root| {
                root.path = self.placeholders(&root.path);
                root
            })
            .collect();
        Roots::from_config(&roots, &self.scratch.join("profile/skills"))
    }
}

fn corpus() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../golden")
}

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

/// What the sandbox must decide for one case.
enum Expect {
    /// The refusal text, read from the recorded response.
    Refused,
    /// Resolves; the recorded `read` header names this virtual path.
    ResolvesAsHeader,
    /// Resolves to this virtual path (tools whose output does not name it).
    Resolves(&'static str),
}

struct Case {
    variant: &'static str,
    file: &'static str,
    access: Access,
    expect: Expect,
}

const CASES: &[Case] = &[
    case(
        "base",
        "13-read-native-inside",
        Access::Read,
        Expect::ResolvesAsHeader,
    ),
    case(
        "base",
        "14-read-skills-root",
        Access::Read,
        Expect::ResolvesAsHeader,
    ),
    case("base", "15-read-missing", Access::Read, Expect::Refused),
    case("base", "16-read-traversal", Access::Read, Expect::Refused),
    case(
        "base",
        "17-read-outside-native",
        Access::Read,
        Expect::Refused,
    ),
    case(
        "base",
        "18-read-unknown-root",
        Access::Read,
        Expect::Refused,
    ),
    case("base", "19-read-relative", Access::Read, Expect::Refused),
    case(
        "base",
        "29-view-image-missing",
        Access::Read,
        Expect::Refused,
    ),
    case(
        "base",
        "30-view-image-outside",
        Access::Read,
        Expect::Refused,
    ),
    case(
        "base",
        "35-patch-add",
        Access::Create,
        Expect::Resolves("/project/src/added.txt"),
    ),
    case(
        "base",
        "41-patch-update-missing",
        Access::Write,
        Expect::Refused,
    ),
    case(
        "base",
        "42-patch-delete-missing",
        Access::Delete,
        Expect::Refused,
    ),
    case("base", "43-patch-outside", Access::Create, Expect::Refused),
    case(
        "base",
        "44-patch-traversal",
        Access::Create,
        Expect::Refused,
    ),
    case(
        "base",
        "60-exec-workdir-subfolder",
        Access::WorkingFolder,
        Expect::Resolves("/project/src"),
    ),
    case(
        "base",
        "61-exec-workdir-native",
        Access::WorkingFolder,
        Expect::Resolves("/project"),
    ),
    case(
        "base",
        "62-exec-workdir-outside",
        Access::WorkingFolder,
        Expect::Refused,
    ),
    case(
        "base",
        "63-exec-workdir-traversal",
        Access::WorkingFolder,
        Expect::Refused,
    ),
    case(
        "base",
        "64-exec-workdir-missing",
        Access::WorkingFolder,
        Expect::Refused,
    ),
    case(
        "no-command",
        "04-find-outside",
        Access::Read,
        Expect::Refused,
    ),
    case(
        "no-command",
        "05-find-missing-path",
        Access::Read,
        Expect::Refused,
    ),
    case(
        "two-roots",
        "01-read-second-root",
        Access::Read,
        Expect::ResolvesAsHeader,
    ),
    case(
        "two-roots",
        "02-read-second-file",
        Access::Read,
        Expect::ResolvesAsHeader,
    ),
    // `read` globs from the folder before the first wildcard, here the virtual root `/`.
    case(
        "two-roots",
        "04-read-glob-across",
        Access::Read,
        Expect::Refused,
    ),
    case(
        "two-roots",
        "05-patch-second",
        Access::Create,
        Expect::Resolves("/second/new.txt"),
    ),
    case(
        "two-roots",
        "07-exec-second-workdir",
        Access::WorkingFolder,
        Expect::Resolves("/second"),
    ),
    case(
        "two-roots",
        "08-read-outside",
        Access::Read,
        Expect::Refused,
    ),
];

const fn case(variant: &'static str, file: &'static str, access: Access, expect: Expect) -> Case {
    Case {
        variant,
        file,
        access,
        expect,
    }
}

/// The one path a case sends to the sandbox, as the tool would pick it.
fn requested_path(tool: &str, arguments: &Value) -> String {
    let text = |key: &str| arguments[key].as_str().unwrap().to_owned();
    match tool {
        "read" => {
            let path = arguments["paths"][0].as_str().unwrap();
            if path.contains(['*', '?']) {
                let base: Vec<&str> = path
                    .split('/')
                    .take_while(|s| !s.contains(['*', '?']))
                    .collect();
                let base = base.join("/");
                if base.is_empty() {
                    "/".to_owned()
                } else {
                    base
                }
            } else {
                path.to_owned()
            }
        }
        "view_image" | "find" => text("path"),
        "exec_command" => text("workdir"),
        "apply_patch" => text("patch")
            .lines()
            .find_map(|line| {
                ["*** Add File: ", "*** Update File: ", "*** Delete File: "]
                    .iter()
                    .find_map(|prefix| line.strip_prefix(prefix))
            })
            .unwrap()
            .to_owned(),
        other => panic!("no path rule for {other}"),
    }
}

/// The first text block of the recorded answer, without `read`'s per-path header.
fn recorded_body(response: &Value) -> (Option<String>, String) {
    let text = response["messages"][0]["result"]["content"][0]["text"]
        .as_str()
        .unwrap();
    let (first, rest) = text.split_once('\n').unwrap_or((text, ""));
    match first
        .strip_prefix("--- ")
        .and_then(|header| header.split_once(" \u{2014} "))
    {
        Some((path, _)) => (
            Some(path.to_owned()),
            rest.lines().next().unwrap_or("").to_owned(),
        ),
        None => (None, first.to_owned()),
    }
}

#[test]
fn every_recorded_path_decision_replays_through_the_sandbox() {
    let fixture = Fixture::new();
    let mut failures = Vec::new();
    for case in CASES {
        let file = corpus()
            .join(case.variant)
            .join("mcp/core/calls")
            .join(format!("{}.json", case.file));
        let recorded = read_json(&file);
        let tool = recorded["request"]["tool"].as_str().unwrap();
        let path = fixture.placeholders(&requested_path(tool, &recorded["request"]["arguments"]));
        let (header, body) = recorded_body(&recorded["response"]);
        let outcome = resolve(&fixture.roots(case.variant), &path, case.access);
        let label = format!("{}/{}", case.variant, case.file);
        match (&case.expect, outcome) {
            (Expect::Refused, Err(error)) if error.to_string() == body => {}
            (Expect::ResolvesAsHeader, Ok(resolved))
                if Some(resolved.virtual_path.as_str()) == header.as_deref() => {}
            (Expect::Resolves(expected), Ok(resolved))
                if resolved.virtual_path.as_str() == *expected => {}
            (_, outcome) => failures.push(format!(
                "{label}: path {path:?} gave {outcome:?}; recorded {header:?} / {body:?}"
            )),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
