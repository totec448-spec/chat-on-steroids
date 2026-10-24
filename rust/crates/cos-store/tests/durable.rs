//! state/<name>.json against durable.ts, one ledger owner's row tolerance, and crash safety.

mod common;

use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use common::{Mismatches, Scratch, contents, oracle};
use cos_store::{DurableStore, Logger, logger::LogLevel};
use serde_json::{Value, json};

fn open(dir: &Path) -> (DurableStore, Logger) {
    let logger = Logger::new();
    (DurableStore::new(dir.join("state"), logger.clone()), logger)
}

#[test]
fn reads_every_recorded_file_like_typescript() {
    let doc = oracle("durable-read");
    let cases = doc["cases"].as_object().expect("cases");
    let mut mismatches = Mismatches::default();
    for (name, case) in cases {
        let scratch = Scratch::new("read");
        let file = scratch.path().join("state").join("probe.json");
        fs::create_dir_all(file.parent().expect("parent")).expect("state");
        match &case["input"] {
            Value::Null => {}
            input if input.get("directory").is_some() => fs::create_dir(&file).expect("folder"),
            input => fs::write(&file, contents(input)).expect("input"),
        }
        let (store, logger) = open(scratch.path());
        let ledger = store.ledger::<Value>("probe").expect("name");
        let plain = ledger.read().unwrap_or(Value::Null);
        mismatches.check(name, "plain read", plain == case["plain"], || {
            format!("rust {plain}")
        });
        let strict = match ledger.read_strict() {
            Ok(value) => json!({ "value": value }),
            Err(error) => json!({ "error": error.to_string() }),
        };
        mismatches.check(name, "strict read", strict == case["strict"], || {
            format!("rust {strict}")
        });
        let warned = logger.entries().iter().any(|entry| {
            entry.level == LogLevel::Warn
                && entry.message.starts_with("could not read probe state: ")
        });
        mismatches.check(
            name,
            "warning",
            warned == case["warned"].as_bool().expect("bool"),
            || format!("rust {warned}"),
        );
    }
    mismatches.assert_none(cases.len());
}

#[test]
fn writes_the_same_bytes_as_typescript() {
    let doc = oracle("durable-write");
    let cases = doc["cases"].as_object().expect("cases");
    let mut mismatches = Mismatches::default();
    for (name, case) in cases {
        let scratch = Scratch::new("write");
        let state = scratch.path().join("state");
        fs::create_dir_all(&state).expect("state");
        fs::write(state.join("probe.json"), "\"previous\"").expect("previous");
        let (store, _) = open(scratch.path());
        store
            .ledger::<Value>("probe")
            .expect("name")
            .write_now(&case["value"])
            .expect("writes");
        let file = fs::read_to_string(state.join("probe.json")).ok();
        let expected = case["file"].as_str().map(str::to_owned);
        mismatches.check(name, "file", file == expected, || {
            format!("\nrust {file:?}\nts   {expected:?}")
        });
        let leftovers: Vec<String> = fs::read_dir(&state)
            .expect("list")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|entry| entry != "probe.json")
            .collect();
        mismatches.check(name, "leftovers", leftovers.is_empty(), || {
            format!("{leftovers:?}")
        });
    }
    mismatches.assert_none(cases.len());
}

#[test]
fn accepts_the_same_names_and_recovers_like_typescript() {
    let doc = oracle("durable-names");
    let scratch = Scratch::new("names");
    let (store, _) = open(scratch.path());
    for (name, accepted) in doc["names"].as_object().expect("names") {
        let rust = store
            .ledger::<Value>(name)
            .and_then(|ledger| ledger.write_now(&json!({ "ok": true })))
            .is_ok();
        assert_eq!(rust, accepted.as_bool().expect("bool"), "name {name:?}");
    }

    let recovery = &doc["recovery"];
    let scratch = Scratch::new("recovery");
    let state = scratch.path().join("state");
    fs::create_dir_all(&state).expect("state");
    fs::write(
        state.join("probe.json"),
        recovery["original"].as_str().expect("original"),
    )
    .expect("damaged");
    let (store, _) = open(scratch.path());
    store
        .ledger::<Value>("probe")
        .expect("name")
        .recover(&recovery["replacement"])
        .expect("recovers");
    assert_eq!(
        fs::read_to_string(state.join("probe.json")).expect("file"),
        recovery["file"].as_str().expect("file")
    );
    let files: Vec<String> = fs::read_dir(&state)
        .expect("list")
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        files.len(),
        recovery["fileCount"].as_u64().expect("count") as usize,
        "{files:?}"
    );
    let copy = files
        .iter()
        .find(|file| file.starts_with("probe.recovery-"))
        .expect("a recovery copy");
    let id = &copy["probe.recovery-".len()..copy.len() - ".json".len()];
    let shape = id.len() == 36 && id.split('-').map(str::len).eq([8, 4, 4, 4, 12]);
    assert!(
        shape && id.bytes().all(|b| b == b'-' || b.is_ascii_hexdigit()),
        "{copy}"
    );
    assert_eq!(recovery["copyPattern"], "probe.recovery-<uuid>.json");
    assert_eq!(
        fs::read_to_string(state.join(copy)).expect("copy"),
        recovery["copy"].as_str().expect("copy")
    );
}

#[test]
fn revisions_change_when_typescript_revisions_change() {
    let doc = oracle("durable-revisions");
    let scratch = Scratch::new("revisions");
    let state = scratch.path().join("state");
    fs::create_dir_all(&state).expect("state");
    let ledgers =
        |store: &DurableStore| ["a", "b"].map(|name| store.ledger::<Value>(name).expect("name"));
    let mut store = open(scratch.path()).0;
    let mut ledger = ledgers(&store);
    let mut seen = ledger.each_ref().map(|ledger| ledger.revision());
    for step in doc["steps"].as_array().expect("steps") {
        let label = step.to_string();
        let index = match step["name"].as_str() {
            Some("b") => 1,
            _ => 0,
        };
        let target = &ledger[index];
        let failed = match step["step"].as_str().expect("step") {
            "start" => false,
            "write-soon" => target.write_soon(&json!({ "v": 2 })).is_err(),
            "write-now" | "write-now-same-value" => target.write_now(&json!({ "v": 1 })).is_err(),
            "flush" => ledger.iter().any(|ledger| ledger.flush().is_err()),
            "remove-now" | "remove-now-missing" => target.remove_now().is_err(),
            "recover" => target.recover(&json!({ "v": 3 })).is_err(),
            "recover-missing" => target.recover(&json!({ "v": 4 })).is_err(),
            "write-now-blocked-by-folder" => {
                let folder = state.join(format!("{}.json", target.name()));
                fs::create_dir(&folder).expect("folder");
                fs::write(folder.join("keep"), "").expect("keep");
                target.write_now(&json!({ "v": 5 })).is_err()
            }
            "unblock-and-flush" => {
                fs::remove_dir_all(state.join(format!("{}.json", target.name()))).expect("unblock");
                target.flush().is_err()
            }
            "reopen" => {
                store = open(scratch.path()).0;
                ledger = ledgers(&store);
                false
            }
            other => panic!("unknown step {other}"),
        };
        let now = ledger.each_ref().map(|ledger| ledger.revision());
        let changed = json!({ "a": now[0] != seen[0], "b": now[1] != seen[1] });
        assert_eq!(Value::Bool(failed), step["failed"], "failed, {label}");
        assert_eq!(changed, step["changed"], "{label}");
        seen = now;
    }
    let mut files: Vec<String> = fs::read_dir(&state)
        .expect("list")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|file| !file.contains(".recovery-"))
        .collect();
    files.sort();
    assert_eq!(json!(files), doc["files"]);
}

/// `restoreBlockedChats` in `session/blocked-chats.ts`: skip each bad row, keep the rest.
fn restore_blocked(saved: Option<Value>, now: u64) -> Vec<(String, Value)> {
    let mut blocked: Vec<(String, Value)> = Vec::new();
    let Some(saved) = saved else { return blocked };
    let entries = match (
        saved.get("version").and_then(Value::as_f64),
        saved.get("entries"),
    ) {
        (Some(1.0), Some(Value::Array(entries))) => entries,
        _ => return blocked,
    };
    for entry in entries.iter().take(200) {
        let Some(id) = entry.get("conversationId").and_then(Value::as_str) else {
            continue;
        };
        let valid = (8..=64).contains(&id.len())
            && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
        if !valid {
            continue;
        }
        let at = entry
            .get("blockedAt")
            .filter(|at| at.is_number())
            .cloned()
            .unwrap_or_else(|| json!(now));
        match blocked.iter_mut().find(|(known, _)| known == id) {
            Some(row) => row.1 = at,
            None => blocked.push((id.to_owned(), at)),
        }
    }
    blocked
}

#[test]
fn a_ledger_owner_keeps_the_valid_rows_of_a_damaged_file() {
    let doc = oracle("blocked-chats");
    let now = doc["now"].as_u64().expect("now");
    for (name, case) in doc["cases"].as_object().expect("cases") {
        let scratch = Scratch::new("blocked");
        let state = scratch.path().join("state");
        fs::create_dir_all(&state).expect("state");
        fs::write(
            state.join("blocked-chats.json"),
            serde_json::to_string(&case["file"]).expect("json"),
        )
        .expect("file");
        let (store, _) = open(scratch.path());
        let restored = restore_blocked(
            store.ledger::<Value>("blocked-chats").expect("name").read(),
            now,
        );
        let rust: Value = restored
            .into_iter()
            .map(|(id, at)| json!([id, at]))
            .collect();
        assert_eq!(rust, case["restored"], "{name}");
    }
}

#[test]
fn background_writes_coalesce_and_the_newest_value_lands() {
    let scratch = Scratch::new("coalesce");
    let (store, _) = open(scratch.path());
    let ledger = store.ledger::<u32>("counter").expect("name");
    for n in 0..100 {
        ledger.write_soon(&n).expect("queues");
    }
    let file = scratch.path().join("state").join("counter.json");
    assert!(!file.exists(), "nothing is written before the delay");
    thread::sleep(cos_store::durable::WRITE_DELAY * 4);
    assert_eq!(fs::read_to_string(&file).expect("written"), "99");
    ledger.write_soon(&100).expect("queues");
    ledger.flush().expect("flushes");
    assert_eq!(fs::read_to_string(&file).expect("written"), "100");
    ledger.remove_now().expect("removes");
    assert!(!file.exists());
}

#[test]
fn a_snapshot_is_built_once_when_the_write_happens() {
    let scratch = Scratch::new("snapshot");
    let (store, _) = open(scratch.path());
    let ledger = store.ledger::<Vec<u32>>("snap").expect("name");
    let built = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    for n in 0..5 {
        let built = built.clone();
        ledger.write_snapshot_soon(move || {
            built.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            vec![n]
        });
    }
    ledger.flush().expect("flushes");
    assert_eq!(built.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(
        fs::read_to_string(scratch.path().join("state").join("snap.json")).expect("file"),
        "[4]"
    );
}

#[test]
fn a_crash_after_the_temp_write_leaves_the_old_file_and_the_next_write_converges() {
    let scratch = Scratch::new("torn-temp");
    let (store, _) = open(scratch.path());
    let ledger = store.ledger::<Value>("ledger").expect("name");
    ledger
        .write_now(&json!({ "generation": 1 }))
        .expect("first");
    // What a process killed between the temp write and the rename leaves behind.
    let state = scratch.path().join("state");
    fs::write(state.join("ledger.json.tmp"), "{\"generation\": 2, \"half").expect("torn temp");

    let (restarted, _) = open(scratch.path());
    let ledger = restarted.ledger::<Value>("ledger").expect("name");
    assert_eq!(
        ledger.read_strict().expect("intact"),
        Some(json!({ "generation": 1 }))
    );
    ledger
        .write_now(&json!({ "generation": 3 }))
        .expect("next write");
    assert_eq!(ledger.read(), Some(json!({ "generation": 3 })));
    assert!(!state.join("ledger.json.tmp").exists());
}

const WRITER_ENV: &str = "COS_STORE_DURABLE_WRITER";

/// Child mode for the kill test: rewrites one ledger as fast as it can until killed.
#[test]
fn durable_writer_child() {
    let Ok(dir) = std::env::var(WRITER_ENV) else {
        return;
    };
    let (store, _) = open(Path::new(&dir));
    let ledger = store.ledger::<Value>("ledger").expect("name");
    for generation in 0..=u64::MAX {
        let pad = char::from(b'a' + (generation % 26) as u8)
            .to_string()
            .repeat(256 * 1024);
        ledger
            .write_now(&json!({ "generation": generation, "pad": pad }))
            .expect("writes");
    }
}

#[test]
fn a_writer_killed_at_any_moment_never_leaves_a_torn_file() {
    let scratch = Scratch::new("kill");
    let exe = std::env::current_exe().expect("test binary");
    let mut seen = Vec::new();
    for round in 0..12u64 {
        let mut command = Command::new(&exe);
        command
            .args([
                "durable_writer_child",
                "--exact",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(WRITER_ENV, scratch.path())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
        let mut child = command.spawn().expect("spawns");
        thread::sleep(Duration::from_millis(150 + round * 37 % 200));
        child.kill().expect("kills");
        child.wait().expect("exits");
        let (store, _) = open(scratch.path());
        let Some(value) = store
            .ledger::<Value>("ledger")
            .expect("name")
            .read_strict()
            .expect("never torn")
        else {
            continue;
        };
        let generation = value["generation"].as_u64().expect("generation");
        let pad = value["pad"].as_str().expect("pad");
        let letter = char::from(b'a' + (generation % 26) as u8);
        assert!(
            pad.len() == 256 * 1024 && pad.chars().all(|c| c == letter),
            "round {round}: a mixed file"
        );
        seen.push(generation);
    }
    assert!(
        seen.len() >= 10,
        "the writer wrote in most rounds: {seen:?}"
    );
}
