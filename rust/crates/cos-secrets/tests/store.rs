//! `SecretStore` against real files and the current Windows user's DPAPI, in throwaway profiles
//! under Cargo's test temp folder. Values are dummies.
#![cfg(windows)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, UNIX_EPOCH};

use cos_secrets::{Error, SecretKey, SecretStore, Unavailable};

fn profile(name: &str) -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join("cos-secrets")
        .join(format!(
            "{}-{name}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
    let _ = fs::remove_dir_all(&dir);
    dir
}

fn secrets(dir: &Path) -> Vec<u8> {
    fs::read(dir.join("secrets.bin")).unwrap()
}

/// A profile whose `secrets.bin` holds the bridge token and an OpenAI key.
fn saved_profile(name: &str) -> PathBuf {
    let dir = profile(name);
    let mut store = SecretStore::new(&dir);
    store.set(&SecretKey::BridgeToken, "dummy-bridge").unwrap();
    store
        .set(&SecretKey::OpenaiApiKey, "sk-dummy-openai")
        .unwrap();
    dir
}

fn files(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

#[test]
fn a_fresh_profile_gets_a_key_and_its_values_survive_a_new_store() {
    let dir = profile("fresh");
    let mut store = SecretStore::new(&dir);
    assert_eq!(store.get(&SecretKey::OpenaiApiKey), None);
    assert!(store.status().available);
    store
        .set(&SecretKey::OpenaiApiKey, " sk-\u{ad}dummy\u{200b} ")
        .unwrap();
    store
        .set(&SecretKey::BridgeToken, "\u{feff} dummy token \n")
        .unwrap();
    store
        .set(&SecretKey::Plugin("github:token".into()), "dummy-plugin")
        .unwrap();
    assert_eq!(files(&dir), ["Local State", "secrets.bin"]);

    let mut reopened = SecretStore::new(&dir);
    assert_eq!(
        reopened.get(&SecretKey::OpenaiApiKey).as_deref(),
        Some("sk-dummy")
    );
    assert_eq!(
        reopened.get(&SecretKey::BridgeToken).as_deref(),
        Some("dummy token")
    );
    assert_eq!(
        reopened
            .get(&SecretKey::Plugin("github:token".into()))
            .as_deref(),
        Some("dummy-plugin")
    );
    assert!(!reopened.unreadable());
}

#[test]
fn an_empty_value_removes_the_key_and_has_follows_get() {
    let dir = saved_profile("clear");
    let mut store = SecretStore::new(&dir);
    assert!(store.has(&SecretKey::OpenaiApiKey));
    store.set(&SecretKey::OpenaiApiKey, " \u{200b} ").unwrap();
    assert!(!store.has(&SecretKey::OpenaiApiKey));
    store.clear(&SecretKey::BridgeToken).unwrap();
    assert_eq!(SecretStore::new(&dir).get(&SecretKey::BridgeToken), None);
}

#[test]
fn a_damaged_file_reads_as_empty_refuses_writes_and_is_left_untouched() {
    let dir = saved_profile("damaged");
    let mut damaged = secrets(&dir);
    *damaged.last_mut().unwrap() ^= 1;
    fs::write(dir.join("secrets.bin"), &damaged).unwrap();

    let mut store = SecretStore::new(&dir);
    assert_eq!(store.get(&SecretKey::BridgeToken), None);
    assert!(store.unreadable());
    assert!(store.status().available);
    assert!(matches!(
        store.set(&SecretKey::BridgeToken, "new"),
        Err(Error::Unreadable)
    ));
    assert!(matches!(
        store.clear(&SecretKey::OpenaiApiKey),
        Err(Error::Unreadable)
    ));
    assert_eq!(secrets(&dir), damaged);
}

#[test]
fn a_file_from_another_profile_is_unreadable() {
    let source = saved_profile("source");
    let dir = saved_profile("target");
    fs::copy(source.join("secrets.bin"), dir.join("secrets.bin")).unwrap();
    let mut store = SecretStore::new(&dir);
    assert_eq!(store.get(&SecretKey::BridgeToken), None);
    assert!(store.unreadable());
}

#[test]
fn truncated_and_foreign_prefix_files_are_unreadable() {
    for (name, bytes) in [
        ("empty", &b""[..]),
        ("short", b"v10\0\0"),
        ("v20", b"v20aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ] {
        let dir = saved_profile(name);
        fs::write(dir.join("secrets.bin"), bytes).unwrap();
        let mut store = SecretStore::new(&dir);
        assert_eq!(store.get(&SecretKey::BridgeToken), None, "{name}");
        assert!(store.unreadable(), "{name}");
    }
}

#[test]
fn set_aside_renames_an_unreadable_file_and_starts_empty() {
    let dir = saved_profile("set-aside");
    fs::write(
        dir.join("secrets.bin"),
        b"v10 damaged beyond repair, longer than a tag",
    )
    .unwrap();
    let mut store = SecretStore::new(&dir);
    assert!(!store.has(&SecretKey::BridgeToken));

    let now = UNIX_EPOCH + Duration::from_millis(1_760_918_399_999);
    let name = store.set_aside_unreadable(now).unwrap();
    assert_eq!(
        name.as_deref(),
        Some("secrets.unreadable-20251019-235959-999.bin")
    );
    assert_eq!(
        files(&dir),
        ["Local State", "secrets.unreadable-20251019-235959-999.bin"]
    );
    assert!(!store.unreadable());
    assert_eq!(store.get(&SecretKey::BridgeToken), None);

    store.set(&SecretKey::BridgeToken, "after").unwrap();
    assert_eq!(
        SecretStore::new(&dir)
            .get(&SecretKey::BridgeToken)
            .as_deref(),
        Some("after")
    );
}

#[test]
fn set_aside_changes_nothing_when_the_file_reads() {
    let dir = saved_profile("readable");
    let before = secrets(&dir);
    let mut store = SecretStore::new(&dir);
    assert_eq!(store.set_aside_unreadable(UNIX_EPOCH).unwrap(), None);
    assert_eq!(secrets(&dir), before);
    assert_eq!(files(&dir), ["Local State", "secrets.bin"]);
}

#[test]
fn set_aside_reads_once_more_before_renaming() {
    let dir = saved_profile("recovered");
    let good = secrets(&dir);
    fs::write(dir.join("secrets.bin"), b"").unwrap();
    let mut store = SecretStore::new(&dir);
    assert_eq!(store.get(&SecretKey::BridgeToken), None);
    assert!(store.unreadable());
    fs::write(dir.join("secrets.bin"), &good).unwrap();
    assert_eq!(store.set_aside_unreadable(UNIX_EPOCH).unwrap(), None);
    assert_eq!(
        store.get(&SecretKey::BridgeToken).as_deref(),
        Some("dummy-bridge")
    );
}

#[test]
fn delete_all_removes_even_an_unreadable_file() {
    let dir = saved_profile("delete");
    fs::write(dir.join("secrets.bin"), b"junk").unwrap();
    let mut store = SecretStore::new(&dir);
    assert!(!store.has(&SecretKey::BridgeToken));
    store.delete_all().unwrap();
    store.delete_all().unwrap();
    assert_eq!(files(&dir), ["Local State"]);
    assert!(!store.unreadable());
    store.set(&SecretKey::BridgeToken, "again").unwrap();
    assert!(SecretStore::new(&dir).has(&SecretKey::BridgeToken));
}

#[test]
fn a_write_keeps_every_other_key() {
    let dir = saved_profile("unknown");
    let mut store = SecretStore::new(&dir);
    store
        .set(&SecretKey::Setup("profile-1".into()), "sk-setup")
        .unwrap();
    store.set(&SecretKey::BridgeToken, "rotated").unwrap();
    let mut reread = SecretStore::new(&dir);
    assert_eq!(
        reread.get(&SecretKey::BridgeToken).as_deref(),
        Some("rotated")
    );
    assert_eq!(
        reread.get(&SecretKey::OpenaiApiKey).as_deref(),
        Some("sk-dummy-openai")
    );
    assert_eq!(
        reread.get(&SecretKey::Setup("profile-1".into())).as_deref(),
        Some("sk-setup")
    );
}

fn local_state(dir: &Path) -> serde_json::Value {
    serde_json::from_slice(&fs::read(dir.join("Local State")).unwrap()).unwrap()
}

/// A profile whose `secrets.bin` was sealed with a key that `Local State` no longer holds,
/// after `replace` rewrote `Local State`.
fn profile_with_local_state(
    name: &str,
    replace: impl FnOnce(serde_json::Value) -> Vec<u8>,
) -> PathBuf {
    let dir = saved_profile(name);
    let bytes = replace(local_state(&dir));
    fs::write(dir.join("Local State"), bytes).unwrap();
    dir
}

/// What Electron does after it stores a new key: the old `secrets.bin` is unreadable until the
/// user sets it aside, and the new key then seals and reopens.
fn assert_new_key_then_set_aside(dir: &Path) {
    let mut store = SecretStore::new(dir);
    assert!(store.status().available);
    assert_eq!(store.get(&SecretKey::BridgeToken), None);
    assert!(store.unreadable());
    assert!(matches!(
        store.set(&SecretKey::BridgeToken, "x"),
        Err(Error::Unreadable)
    ));
    let now = UNIX_EPOCH + Duration::from_millis(1_760_918_399_999);
    assert!(store.set_aside_unreadable(now).unwrap().is_some());
    store.set(&SecretKey::BridgeToken, "after").unwrap();

    let local_state = fs::read(dir.join("Local State")).unwrap();
    let mut reopened = SecretStore::new(dir);
    assert_eq!(
        reopened.get(&SecretKey::BridgeToken).as_deref(),
        Some("after")
    );
    assert_eq!(
        fs::read(dir.join("Local State")).unwrap(),
        local_state,
        "the new key is usable, so Local State is not written again"
    );
}

#[test]
fn a_usable_key_never_writes_local_state() {
    let dir = saved_profile("usable");
    let before = fs::read(dir.join("Local State")).unwrap();
    let mut store = SecretStore::new(&dir);
    assert!(store.status().available);
    store.set(&SecretKey::BridgeToken, "rotated").unwrap();
    store.delete_all().unwrap();
    assert_eq!(fs::read(dir.join("Local State")).unwrap(), before);
}

#[test]
fn a_local_state_without_a_key_gets_one_and_keeps_every_other_entry() {
    let dir = profile_with_local_state("no-key", |_| {
        br#"{"browser":{"enabled_labs_experiments":["a"]},"os_crypt":{"audit_enabled":false,"other":"keep"},"n":2.5}"#.to_vec()
    });
    assert_new_key_then_set_aside(&dir);
    let mut state = local_state(&dir);
    let key = state["os_crypt"]
        .as_object_mut()
        .unwrap()
        .remove("encrypted_key")
        .unwrap();
    assert!(
        key.as_str().unwrap().starts_with("RFBBUEk"),
        "base64 of DPAPI"
    );
    assert_eq!(
        state,
        serde_json::json!({
            "browser": {"enabled_labs_experiments": ["a"]},
            "os_crypt": {"audit_enabled": true, "other": "keep"},
            "n": 2.5
        })
    );
}

#[test]
fn a_key_that_dpapi_cannot_unwrap_is_replaced_in_place() {
    let mut old_key = String::new();
    let dir = profile_with_local_state("dpapi", |mut state| {
        use base64::Engine;
        let engine = base64::engine::general_purpose::STANDARD;
        let mut wrapped = engine
            .decode(state["os_crypt"]["encrypted_key"].as_str().unwrap())
            .unwrap();
        *wrapped.last_mut().unwrap() ^= 1;
        old_key = engine.encode(wrapped);
        state["os_crypt"]["encrypted_key"] = old_key.clone().into();
        state["kept"] = "yes".into();
        state.to_string().into_bytes()
    });
    assert_new_key_then_set_aside(&dir);
    let state = local_state(&dir);
    assert_ne!(state["os_crypt"]["encrypted_key"], old_key.as_str());
    assert_eq!(state["kept"], "yes");
}

#[test]
fn a_local_state_that_is_not_json_moves_to_local_state_bad() {
    let dir = profile_with_local_state("not-json", |_| b"{\"a\":1,}".to_vec());
    assert_new_key_then_set_aside(&dir);
    assert_eq!(
        fs::read(dir.join("Local State.bad")).unwrap(),
        b"{\"a\":1,}"
    );
    let os_crypt = local_state(&dir)["os_crypt"].take();
    assert_eq!(local_state(&dir).as_object().unwrap().len(), 1);
    assert_eq!(os_crypt["audit_enabled"], true);
}

#[test]
fn a_local_state_that_electron_cannot_use_or_replace_is_left_alone() {
    for text in [
        &br#"[1,2]"#[..],
        br#"{"os_crypt":"str"}"#,
        br#"{"os_crypt":{"encrypted_key":5}}"#,
        br#"{"os_crypt":{"encrypted_key":""}}"#,
        br#"{"os_crypt":{"encrypted_key":"!!notbase64"}}"#,
        br#"{"os_crypt":{"encrypted_key":"WFhYWFhhYmM="}}"#,
    ] {
        let label = String::from_utf8_lossy(text);
        let dir = profile_with_local_state("unusable", |_| text.to_vec());
        let before = fs::read(dir.join("secrets.bin")).unwrap();
        let mut store = SecretStore::new(&dir);
        assert!(!store.status().available, "{label}");
        assert_eq!(store.get(&SecretKey::BridgeToken), None, "{label}");
        assert!(
            matches!(
                store.set(&SecretKey::BridgeToken, "x"),
                Err(Error::Unavailable(Unavailable::LocalState(_)))
            ),
            "{label}"
        );
        assert!(
            matches!(
                store.set_aside_unreadable(UNIX_EPOCH),
                Err(Error::Unavailable(_))
            ),
            "{label}"
        );
        assert_eq!(fs::read(dir.join("Local State")).unwrap(), text, "{label}");
        assert_eq!(secrets(&dir), before, "{label}");
        assert_eq!(files(&dir), ["Local State", "secrets.bin"], "{label}");
    }
}
