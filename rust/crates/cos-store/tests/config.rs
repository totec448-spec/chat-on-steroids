//! config.json against the TypeScript loader and the `settings:save` handler.

mod common;

use std::fs;

use common::{Mismatches, Scratch, contents, oracle};
use cos_store::{BridgePortOverride, ConfigError, ConfigStore, Logger, Platform};
use cos_types::config::BrowserBridgePort;
use serde_json::Value;

fn platform(name: &str) -> Platform {
    match name {
        "win32" => Platform::Windows,
        "darwin" => Platform::Macos,
        _ => Platform::Linux,
    }
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).expect("serializes")
}

#[test]
fn loads_and_saves_every_recorded_config_like_typescript() {
    let doc = oracle("config-load");
    let version = doc["appVersion"].as_str().expect("version");
    let cases = doc["cases"].as_object().expect("cases");
    let mut mismatches = Mismatches::default();
    for (name, case) in cases {
        let scratch = Scratch::new("config");
        let file = scratch.path().join("config.json");
        match &case["input"] {
            Value::Null => {}
            input if input.get("directory").is_some() => fs::create_dir(&file).expect("folder"),
            input => fs::write(&file, contents(input)).expect("input"),
        }
        let store = ConfigStore::new(
            &file,
            platform(doc["platform"].as_str().expect("platform")),
            Logger::new(),
        );
        let loaded = serde_json::to_value(store.load(version)).expect("serializes");
        mismatches.check(name, "loaded config", loaded == case["loaded"], || {
            format!("\nrust {}\nts   {}", loaded, case["loaded"])
        });
        mismatches.check(
            name,
            "recovered",
            store.recovered() == case["recovered"].as_bool().expect("bool"),
            || format!("rust {}", store.recovered()),
        );
        let kept: Vec<_> = fs::read_dir(scratch.path())
            .expect("list")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("config.json.unreadable-")
            })
            .map(|entry| fs::read(entry.path()).expect("copy"))
            .collect();
        let expected_copy =
            (!case["keptUnreadableCopy"].is_null()).then(|| contents(&case["keptUnreadableCopy"]));
        mismatches.check(
            name,
            "kept copy",
            kept.first() == expected_copy.as_ref() && kept.len() <= 1,
            || format!("rust kept {} copies", kept.len()),
        );
        if !case["saved"].is_null() {
            let saved = store
                .save(store.get())
                .map(|_| fs::read(&file).expect("saved file"));
            let expected = contents(&case["saved"]);
            mismatches.check(
                name,
                "saved bytes",
                saved.as_ref().ok() == Some(&expected),
                || match &saved {
                    Ok(bytes) => format!(
                        "\nrust {}\nts   {}",
                        String::from_utf8_lossy(bytes),
                        String::from_utf8_lossy(&expected)
                    ),
                    Err(error) => format!("save failed: {error}"),
                },
            );
        }
    }
    mismatches.assert_none(cases.len());
}

#[test]
fn merges_settings_saves_like_the_typescript_handler() {
    let doc = oracle("settings-save");
    let cases = doc["cases"].as_object().expect("cases");
    let mut mismatches = Mismatches::default();
    for (name, case) in cases {
        let scratch = Scratch::new("settings");
        let file = scratch.path().join("config.json");
        fs::write(&file, pretty(&case["current"])).expect("current");
        let store = ConfigStore::new(&file, Platform::Windows, Logger::new());
        let loaded = serde_json::to_value(store.load("0.0.0")).expect("serializes");
        mismatches.check(name, "starting config", loaded == case["current"], || {
            format!("rust {loaded}")
        });
        let bridge_ports = case["env"].as_str().and_then(BridgePortOverride::parse);
        let result = store.save_settings(&case["payload"], bridge_ports.as_ref(), |_| Ok(()));
        let ok = case["ok"].as_bool().expect("ok");
        mismatches.check(name, "accepted", result.is_ok() == ok, || {
            format!("rust {result:?}")
        });
        let config = serde_json::to_value(store.get()).expect("serializes");
        let saved = fs::read(&file).expect("file");
        match intended_difference(case) {
            None => {
                mismatches.check(name, "config", config == case["config"], || {
                    format!("\nrust {config}\nts   {}", case["config"])
                });
                mismatches.check(
                    name,
                    "saved bytes",
                    saved == contents(&case["saved"]),
                    || String::from_utf8_lossy(&saved).into_owned(),
                );
            }
            Some(intended) => {
                mismatches.check(name, "config", config == intended, || {
                    format!("\nrust     {config}\nintended {intended}")
                });
                let saved: Value = serde_json::from_slice(&saved).expect("saved JSON");
                mismatches.check(name, "saved file", saved == intended, || {
                    format!("rust {saved}")
                });
            }
        }
    }
    mismatches.assert_none(cases.len());
}

/// The TypeScript result with this crate's deliberate differences applied, or `None` when the
/// crate matches it exactly. TypeScript rebuilds `ui` without `lastSeenVersion`, so What's New
/// shows again after every Settings save; this crate keeps the saved value.
fn intended_difference(case: &Value) -> Option<Value> {
    let kept = case["current"]["ui"].get("lastSeenVersion")?;
    if !case["ok"].as_bool().expect("ok") {
        return None;
    }
    assert!(
        case["config"]["ui"].get("lastSeenVersion").is_none(),
        "TypeScript keeps lastSeenVersion now; drop this difference"
    );
    let mut config = case["config"].clone();
    config["ui"]["lastSeenVersion"] = kept.clone();
    Some(config)
}

#[test]
fn a_settings_save_keeps_the_last_seen_version() {
    let doc = oracle("settings-save");
    let case = &doc["cases"]["last-seen-version-on-save"];
    assert_eq!(case["current"]["ui"]["lastSeenVersion"], "2.1.30");
    let scratch = Scratch::new("last-seen");
    let file = scratch.path().join("config.json");
    fs::write(&file, pretty(&case["current"])).expect("current");
    let store = ConfigStore::new(&file, Platform::Windows, Logger::new());
    store.load("9.9.9");
    store
        .save_settings(&case["payload"], None, |_| Ok(()))
        .expect("saves");
    let reloaded = ConfigStore::new(&file, Platform::Windows, Logger::new()).load("9.9.9");
    assert_eq!(reloaded.ui.last_seen_version.as_deref(), Some("2.1.30"));
}

#[test]
fn a_save_that_moves_the_bridge_to_a_taken_port_is_refused_and_changes_nothing() {
    let doc = oracle("settings-save");
    let case = &doc["cases"]["edit-theme"];
    let scratch = Scratch::new("bridge-port");
    let file = scratch.path().join("config.json");
    fs::write(&file, pretty(&case["current"])).expect("current");
    let store = ConfigStore::new(&file, Platform::Windows, Logger::new());
    store.load("0.0.0");
    let before = fs::read(&file).expect("file");

    store
        .save_settings(&case["payload"], None, |_| {
            panic!("a save that keeps the port does not probe it")
        })
        .expect("saves");
    let kept = fs::read(&file).expect("file");

    let mut moves = case["payload"].clone();
    moves["patch"]["ui"]["browserBridgePort"] = 8767.into();
    let mut asked = None;
    let refused = store.save_settings(&moves, None, |choice| {
        asked = Some(choice);
        Err("Port 8767 is already in use (EADDRINUSE).".to_owned())
    });
    assert_eq!(asked, Some(BrowserBridgePort::Fixed(8767)));
    let error = refused.expect_err("a taken port refuses the save");
    assert!(matches!(error, ConfigError::BridgePortUnavailable(_)));
    assert_eq!(
        error.to_string(),
        "Port 8767 is already in use (EADDRINUSE)."
    );
    assert_eq!(fs::read(&file).expect("file"), kept, "nothing was written");
    assert_eq!(
        store.get().ui.browser_bridge_port,
        Some(BrowserBridgePort::Auto)
    );

    let saved = store
        .save_settings(&moves, None, |_| Ok(()))
        .expect("a free port saves");
    assert_eq!(
        saved.ui.browser_bridge_port,
        Some(BrowserBridgePort::Fixed(8767))
    );
    assert_ne!(fs::read(&file).expect("file"), before);
}

#[test]
fn reads_clf_bridge_ports_like_typescript() {
    let doc = oracle("bridge-ports");
    for case in doc["cases"].as_array().expect("cases") {
        let raw = case["raw"].as_str().expect("raw");
        let ports = BridgePortOverride::parse(raw).map(|ports| ports.ports().to_vec());
        let expected = case["overridden"]
            .as_bool()
            .expect("overridden")
            .then(|| serde_json::from_value(case["ports"].clone()).expect("ports"));
        assert_eq!(ports, expected, "CLF_BRIDGE_PORTS={raw:?}");
    }
}

#[test]
fn concurrent_updates_each_see_the_previous_one() {
    let scratch = Scratch::new("concurrent");
    let store = ConfigStore::new(
        scratch.path().join("config.json"),
        Platform::Windows,
        Logger::new(),
    );
    store.load("0.0.0");
    let threads: Vec<_> = (0..8)
        .map(|n| {
            let store = store.clone();
            std::thread::spawn(move || {
                store
                    .update(|latest| {
                        let mut next = latest.clone();
                        next.roots.push(cos_types::config::Root {
                            name: format!("root-{n}"),
                            path: format!("C:\\root-{n}"),
                            extra: Default::default(),
                        });
                        Ok(next)
                    })
                    .expect("saves");
            })
        })
        .collect();
    for thread in threads {
        thread.join().expect("joins");
    }
    let reloaded = ConfigStore::new(
        scratch.path().join("config.json"),
        Platform::Windows,
        Logger::new(),
    );
    assert_eq!(
        reloaded.load("0.0.0").roots.len(),
        8,
        "no update overwrote another"
    );
}

#[test]
fn an_invalid_update_leaves_config_and_file_unchanged() {
    let scratch = Scratch::new("invalid-update");
    let file = scratch.path().join("config.json");
    let store = ConfigStore::new(&file, Platform::Windows, Logger::new());
    let before = store.save(store.load("0.0.0")).expect("first save");
    let bytes = fs::read(&file).expect("file");
    let result = store.update(|latest| {
        let mut next = latest.clone();
        next.roots.push(cos_types::config::Root {
            name: "Bad Name".into(),
            path: "C:\\x".into(),
            extra: Default::default(),
        });
        Ok(next)
    });
    assert!(matches!(result, Err(cos_store::ConfigError::Invalid(_))));
    assert_eq!(store.get(), before);
    assert_eq!(fs::read(&file).expect("file"), bytes);
}
