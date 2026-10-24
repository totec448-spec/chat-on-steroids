//! Compares `find`'s two possible content-search backends on the golden fixture project:
//! the bundled `rg` run as `search.ts` runs it (a process per search, JSON events on stdout),
//! and this crate's in-process ripgrep engine behind the real kernel. It checks that both
//! give the same hits, `files_scanned` and stop reason, then times each.
//!
//! ```sh
//! cargo run --release -p cos-files --example find_backends -- --rg <path to rg.exe> [--runs 50]
//! ```

#[path = "../tests/support/mod.rs"]
mod support;

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Instant;

use serde_json::{Value, json};
use support::Served;

/// One search, in `find`'s arguments.
struct Case {
    label: &'static str,
    arguments: Value,
}

fn cases() -> Vec<Case> {
    let case = |label, arguments| Case { label, arguments };
    vec![
        case(
            "golden find-content",
            json!({ "query": "quartz-lantern", "path": "/project", "mode": "content" }),
        ),
        case(
            "golden find-no-match",
            json!({ "query": "absent-needle-zz", "path": "/project", "mode": "content" }),
        ),
        case(
            "ignore-case, many hits",
            json!({ "query": "LINE 0001", "path": "/project", "mode": "content", "max_results": 500 }),
        ),
        case(
            "case-sensitive",
            json!({ "query": "Golden", "path": "/project", "mode": "content", "case_sensitive": true }),
        ),
        case(
            "regex",
            json!({ "query": "line 0{3}1\\d", "path": "/project", "mode": "content", "regex": true, "max_results": 500 }),
        ),
        case(
            "include",
            json!({ "query": "e", "path": "/project", "mode": "content", "include": "*.md" }),
        ),
        case(
            "no excludes",
            json!({ "query": "refs", "path": "/project", "mode": "content", "exclude": [] }),
        ),
        case(
            "binary skipped",
            json!({ "query": "x", "path": "/project/src", "mode": "content", "include": "*.bin" }),
        ),
        case(
            "utf-16",
            json!({ "query": "wide needle", "path": "/project", "mode": "content" }),
        ),
        case(
            "excluded folder",
            json!({ "query": "dependency needle", "path": "/project", "mode": "content" }),
        ),
        case(
            "include inside an excluded folder",
            json!({ "query": "needle", "path": "/project", "mode": "content", "include": "*.js" }),
        ),
        case(
            "excludes ignore case and prefixes",
            json!({ "query": "needle", "path": "/project", "mode": "content", "exclude": ["build", "release-*"] }),
        ),
        case(
            "limit",
            json!({ "query": "line", "path": "/project/src", "mode": "content", "max_results": 3 }),
        ),
    ]
}

/// What `find` reports for one search, comparable across backends.
#[derive(Debug, PartialEq)]
struct Report {
    hits: Vec<String>,
    files_scanned: Option<u64>,
    truncated: Option<String>,
}

fn parse_answer(text: &str) -> Report {
    let mut hits: Vec<String> = if text.starts_with("No matches") {
        Vec::new()
    } else {
        text.lines()
            .skip(1)
            .take_while(|line| !line.is_empty())
            .map(str::to_owned)
            .collect()
    };
    hits.sort();
    let field = |key: &str| {
        text.lines()
            .find_map(|line| line.strip_prefix(&format!("{key}: ")))
            .map(str::to_owned)
    };
    Report {
        hits,
        files_scanned: field("files_scanned").and_then(|value| value.parse().ok()),
        truncated: field("truncated"),
    }
}

/// `searchWithRipgrep` from `search.ts`: the same flags, the same event handling.
fn ripgrep(rg: &Path, real: &Path, shown: &str, arguments: &Value) -> Report {
    let mut args: Vec<String> = [
        "--json",
        "--line-number",
        "--color",
        "never",
        "--hidden",
        "--no-ignore",
        "--max-filesize",
        "2097152",
    ]
    .map(str::to_owned)
    .to_vec();
    let case_sensitive = arguments["case_sensitive"] == true;
    if !case_sensitive {
        args.push("--ignore-case".to_owned());
    }
    if arguments["regex"] != true {
        args.push("--fixed-strings".to_owned());
    }
    if let Some(include) = arguments["include"].as_str() {
        args.push(if case_sensitive { "--glob" } else { "--iglob" }.to_owned());
        args.push(include.to_owned());
    }
    let defaults: Vec<String> = DEFAULT_EXCLUDES
        .iter()
        .map(|name| (*name).to_owned())
        .collect();
    let excludes: Vec<String> = match arguments["exclude"].as_array() {
        Some(list) => list
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        None => defaults,
    };
    for name in excludes {
        args.push("--iglob".to_owned());
        let (literal, star) = name
            .strip_suffix('*')
            .map_or((name.as_str(), ""), |literal| (literal, "*"));
        args.push(format!("!**/{literal}{star}/**"));
    }
    args.extend([
        "--".to_owned(),
        arguments["query"].as_str().unwrap_or_default().to_owned(),
        ".".to_owned(),
    ]);
    let max_results = arguments["max_results"].as_u64().unwrap_or(50) as usize;
    let output = Command::new(rg)
        .args(&args)
        .current_dir(real)
        .stdin(Stdio::null())
        .output()
        .expect("rg runs");
    let mut hits = Vec::new();
    let mut files_scanned = 0;
    let mut stopped = false;
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if event["type"] == "summary" {
            files_scanned = event["data"]["stats"]["searches"]
                .as_u64()
                .unwrap_or_default();
            continue;
        }
        if event["type"] != "match" || stopped {
            continue;
        }
        let data = &event["data"];
        let path = data["path"]["text"]
            .as_str()
            .unwrap_or_default()
            .replace('\\', "/");
        let path = path.strip_prefix("./").unwrap_or(&path);
        let text = data["lines"]["text"].as_str().unwrap_or_default();
        let text = text.strip_suffix('\n').unwrap_or(text);
        let text = text.strip_suffix('\r').unwrap_or(text).trim();
        hits.push(format!("{shown}/{path}:{}: {text}", data["line_number"]));
        if hits.len() >= max_results {
            stopped = true;
        }
    }
    hits.sort();
    Report {
        hits,
        files_scanned: Some(files_scanned),
        truncated: stopped.then(|| "limit".to_owned()),
    }
}

const DEFAULT_EXCLUDES: &[&str] = &[
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "dist",
    "build",
    "out",
    "target",
    ".next",
    ".nuxt",
    ".gradle",
    ".gradle-user",
    ".idea",
    ".vs",
    ".vscode",
    "__pycache__",
    ".venv",
    "venv",
    "coverage",
    ".cache",
    ".turbo",
    ".go-build-cache",
    ".go-module-cache",
    ".go-tools",
    ".gopath",
    ".tmp",
    ".tmp-go-cache",
    ".tmp-go-path",
    ".android",
    ".bun",
    ".claude",
    ".claude-*",
    ".codex",
    ".cursor",
    ".gemini",
    ".npm",
    ".pnpm-store",
    ".yarn",
    "release",
    "release-*",
    "appdata",
];

fn median_and_range(mut samples: Vec<f64>) -> String {
    samples.sort_by(f64::total_cmp);
    let n = samples.len();
    let median = if n % 2 == 1 {
        samples[n / 2]
    } else {
        (samples[n / 2 - 1] + samples[n / 2]) / 2.0
    };
    format!(
        "median {median:.3} ms, range {:.3}-{:.3} ms, n={n}",
        samples[0],
        samples[n - 1]
    )
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let flag = |name: &str| {
        argv.iter()
            .position(|arg| arg == name)
            .and_then(|at| argv.get(at + 1))
            .cloned()
    };
    let rg = flag("--rg").expect("--rg <path to rg.exe>");
    let rg = Path::new(&rg);
    let runs: usize = flag("--runs")
        .and_then(|value| value.parse().ok())
        .unwrap_or(50);

    let served = Served::variant("no-command");
    let project = served.dirs.project.clone();
    let utf16: Vec<u8> = [0xff, 0xfe]
        .into_iter()
        .chain(
            "one\nwide needle\n"
                .encode_utf16()
                .flat_map(u16::to_le_bytes),
        )
        .collect();
    std::fs::write(project.join("src/wide.txt"), utf16).expect("utf-16 file");
    std::fs::create_dir_all(project.join("node_modules/dep")).expect("dependency folder");
    std::fs::write(
        project.join("node_modules/dep/index.js"),
        "dependency needle\n",
    )
    .expect("dependency file");
    for folder in ["BUILD", "release-2", "releases"] {
        std::fs::create_dir_all(project.join(folder)).expect("excluded folder");
        std::fs::write(project.join(folder).join("x.txt"), "excluded needle\n")
            .expect("excluded file");
    }

    let mut same = 0;
    for case in cases() {
        let path = case.arguments["path"].as_str().unwrap_or("/project");
        let real = if path == "/project" {
            project.clone()
        } else {
            project.join(path.trim_start_matches("/project/"))
        };
        let external = ripgrep(rg, &real, path, &case.arguments);
        let (text, _) = served.text("find", case.arguments.clone()).await;
        let internal = parse_answer(&text);
        // `search.ts` loses the summary when it kills `rg` at the limit, so its count is not
        // comparable then; compare the hits and the stop reason.
        let comparable = |report: &Report| Report {
            hits: report.hits.clone(),
            files_scanned: if report.truncated.is_some() {
                None
            } else {
                report.files_scanned
            },
            truncated: report.truncated.clone(),
        };
        let equal = if case.label == "limit" {
            internal.hits.len() == external.hits.len() && internal.truncated == external.truncated
        } else {
            comparable(&internal) == comparable(&external)
        };
        println!(
            "{:<26} {} ({} hits, files_scanned in-process {:?} rg {:?})",
            case.label,
            if equal { "same" } else { "DIFFERENT" },
            internal.hits.len(),
            internal.files_scanned,
            external.files_scanned
        );
        if !equal {
            println!("  in-process: {internal:?}\n  rg:         {external:?}");
        }
        same += usize::from(equal);
    }
    println!("{same} of {} cases equal\n", cases().len());

    let golden = json!({ "query": "quartz-lantern", "path": "/project", "mode": "content" });
    for _ in 0..5 {
        let _ = ripgrep(rg, &project, "/project", &golden);
        let _ = served.text("find", golden.clone()).await;
    }
    let mut external = Vec::new();
    let mut internal = Vec::new();
    for _ in 0..runs {
        let started = Instant::now();
        let _ = ripgrep(rg, &project, "/project", &golden);
        external.push(started.elapsed().as_secs_f64() * 1000.0);
        let started = Instant::now();
        let _ = served.text("find", golden.clone()).await;
        internal.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    println!(
        "golden find-content, rg process (search.ts's backend): {}",
        median_and_range(external)
    );
    println!(
        "golden find-content, in-process through the kernel:   {}",
        median_and_range(internal)
    );

    for (label, arguments) in [
        (
            "find, no exclude globs",
            (
                "find",
                json!({ "query": "quartz-lantern", "path": "/project", "mode": "content", "exclude": [] }),
            ),
        ),
        (
            "find, one small file",
            (
                "find",
                json!({ "query": "quartz-lantern", "path": "/project/src/notes.md", "mode": "content" }),
            ),
        ),
        (
            "find, names",
            ("find", json!({ "query": "notes", "path": "/project" })),
        ),
        (
            "read (file)",
            ("read", json!({ "paths": ["/project/src/greeting.txt"] })),
        ),
        (
            "read (directory)",
            ("read", json!({ "paths": ["/project/src"] })),
        ),
    ] {
        let (tool, arguments) = arguments;
        for _ in 0..5 {
            let _ = served.call(tool, arguments.clone()).await;
        }
        let mut samples = Vec::new();
        for _ in 0..runs {
            let started = Instant::now();
            let _ = served.call(tool, arguments.clone()).await;
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        println!(
            "{label:<24} through the kernel: {}",
            median_and_range(samples)
        );
    }
}
