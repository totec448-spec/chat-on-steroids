//! The Rust side of the cos-patch differential (`differential/run.mjs`): every case through a
//! real kernel on a fresh tree, written as JSON in the shape the TypeScript oracle writes.
//!
//!   cargo run -p cos-patch --example differential -- <cases.json> <out.json>

#[path = "../tests/support/mod.rs"]
mod support;

use std::fs;
use std::path::Path;

use serde_json::{Map, Value, json};
use support::{Harness, Tree, golden, read_json};

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let [_, cases, out] = args.as_slice() else {
        return Err("usage: differential <cases.json> <out.json>".to_owned());
    };
    let cases = read_json(Path::new(cases));
    let base = read_json(&golden().join("base/config.json"))["config"].clone();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .map_err(|error| error.to_string())?;
    let mut results = Map::new();
    for case in cases.as_array().ok_or("cases must be an array")? {
        let name = case["name"].as_str().unwrap_or_default().to_owned();
        results.insert(name, runtime.block_on(run_case(case, &base)));
    }
    fs::write(
        out,
        serde_json::to_string_pretty(&results).map_err(|e| e.to_string())?,
    )
    .map_err(|error| error.to_string())
}

async fn run_case(case: &Value, base: &Value) -> Value {
    let tree = Tree::new("diff");
    for dir in case["dirs"].as_array().into_iter().flatten() {
        fs::create_dir_all(tree.project.join(dir.as_str().unwrap_or_default())).expect("dir");
    }
    for (relative, text) in case["files"].as_object().into_iter().flatten() {
        tree.write(relative, text.as_str().unwrap_or_default());
    }
    for (relative, bytes) in case["binaryBytes"].as_object().into_iter().flatten() {
        let bytes: Vec<u8> = bytes
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_u64)
            .filter_map(|byte| u8::try_from(byte).ok())
            .collect();
        tree.write(relative, bytes);
    }
    for (relative, text) in case["secondFiles"].as_object().into_iter().flatten() {
        fs::write(
            tree.second.join(relative),
            text.as_str().unwrap_or_default(),
        )
        .expect("file");
    }
    for relative in case["readonly"].as_array().into_iter().flatten() {
        set_readonly(
            &tree.project.join(relative.as_str().unwrap_or_default()),
            true,
        );
    }

    let mut config = base.clone();
    for (key, value) in case["caps"].as_object().into_iter().flatten() {
        config["capabilities"][key] = value.clone();
    }
    let mut roots = vec![json!({ "name": "project", "path": "<PROJECT>" })];
    if case["second"] == true {
        roots.push(json!({ "name": "second", "path": "<SECOND>" }));
    }
    config["roots"] = Value::Array(roots);
    let project = tree.project.display().to_string();
    let second = tree.second.display().to_string();
    let harness = Harness::new(tree, &config);

    let mut calls = Vec::new();
    for call in case["calls"].as_array().into_iter().flatten() {
        let patch = call
            .as_str()
            .unwrap_or_default()
            .replace("<PROJECT_NATIVE>", &project)
            .replace("<PROJECT_FWD>", &project.replace('\\', "/"));
        calls.push(match harness.call(json!({ "patch": patch })).await {
            None => json!({ "error": "Tool apply_patch not found" }),
            Some(result) => {
                let value = serde_json::to_value(&result).expect("serializes");
                json!({ "text": value["content"][0]["text"], "isError": result.is_error })
            }
        });
    }
    let mut disk = Map::new();
    snapshot(&harness.tree.project, "project/", &mut disk);
    snapshot(&harness.tree.second, "second/", &mut disk);
    unlock(&harness.tree.run);
    json!({ "roots": [project, second], "calls": calls, "disk": disk })
}

fn snapshot(root: &Path, prefix: &str, out: &mut Map<String, Value>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let key = format!("{prefix}{name}");
        let path = entry.path();
        if path.is_dir() {
            out.insert(format!("{key}/"), json!("dir"));
            snapshot(&path, &format!("{key}/"), out);
        } else if let Ok(bytes) = fs::read(&path) {
            out.insert(key, describe(&bytes));
        }
    }
}

fn describe(bytes: &[u8]) -> Value {
    if bytes.len() > 1024 * 1024 {
        return json!({
            "len": bytes.len(),
            "head": base64(&bytes[..64]),
            "tail": base64(&bytes[bytes.len() - 64..]),
        });
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => json!(text),
        Err(_) => json!({ "base64": base64(bytes) }),
    }
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, &b)| n | (u32::from(b) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(ALPHABET[(n >> (18 - 6 * i)) as usize & 63]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn set_readonly(path: &Path, readonly: bool) {
    if let Ok(meta) = fs::metadata(path) {
        let mut permissions = meta.permissions();
        #[allow(clippy::permissions_set_readonly_false, reason = "test cleanup")]
        permissions.set_readonly(readonly);
        let _ = fs::set_permissions(path, permissions);
    }
}

fn unlock(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.is_dir() {
            unlock(&path);
        } else {
            set_readonly(&path, false);
        }
    }
}
