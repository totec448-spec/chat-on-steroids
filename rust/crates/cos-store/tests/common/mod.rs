//! Shared by the differential tests: the recorded TypeScript output and scratch folders.
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use serde_json::Value;

/// A recorded oracle document, with every `"$shipped:<pointer>"` string expanded.
pub fn oracle(area: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("oracle")
        .join(format!("{area}.json"));
    let text =
        fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    let shipped: Value =
        serde_json::from_str(include_str!("../../src/shipped.json")).expect("shipped.json");
    expand(serde_json::from_str(&text).expect("oracle JSON"), &shipped)
}

fn expand(value: Value, shipped: &Value) -> Value {
    match value {
        Value::String(text) => match text.strip_prefix("$shipped:") {
            Some(pointer) => shipped
                .pointer(pointer)
                .cloned()
                .unwrap_or_else(|| panic!("no shipped value at {pointer}")),
            None => Value::String(text),
        },
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| expand(item, shipped))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, item)| (key, expand(item, shipped)))
                .collect(),
        ),
        other => other,
    }
}

/// File contents as the oracle records them: `{ json }`, `{ text }` or `{ bytes }`.
pub fn contents(recorded: &Value) -> Vec<u8> {
    if let Some(json) = recorded.get("json") {
        return serde_json::to_string_pretty(json)
            .expect("serializes")
            .into_bytes();
    }
    if let Some(text) = recorded.get("text").and_then(Value::as_str) {
        return text.as_bytes().to_vec();
    }
    recorded["bytes"]
        .as_array()
        .expect("text, json or bytes")
        .iter()
        .map(|byte| byte.as_u64().expect("byte") as u8)
        .collect()
}

/// A fresh folder under the system temp folder, removed on drop.
pub struct Scratch(PathBuf);

impl Scratch {
    pub fn new(label: &str) -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let n = NEXT.fetch_add(1, Ordering::SeqCst);
        let dir =
            std::env::temp_dir().join(format!("cos-store-test-{}-{n}-{label}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch folder");
        Self(dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Collects mismatches so one run reports every failing case.
#[derive(Default)]
pub struct Mismatches(Vec<String>);

impl Mismatches {
    pub fn check(&mut self, case: &str, what: &str, ok: bool, detail: impl FnOnce() -> String) {
        if !ok {
            self.0.push(format!("{case}: {what}: {}", detail()));
        }
    }

    pub fn assert_none(self, total: usize) {
        assert!(
            self.0.is_empty(),
            "{} of {total} cases differ from TypeScript:\n{}",
            self.0.len(),
            self.0.join("\n")
        );
    }
}
