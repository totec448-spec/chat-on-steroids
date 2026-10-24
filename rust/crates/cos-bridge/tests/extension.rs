//! The extension folder, case by case from `test/extension-path.test.ts`. The folder's identity
//! is its creation time: Windows gives a recreated folder a new one.

mod support;

use std::fs;
use std::path::Path;
use std::time::SystemTime;

use cos_bridge::{ExtensionFolder, PreparedUpdate, UpdateOffer};

fn write(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("a folder");
    }
    fs::write(path, text).expect("writes");
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).expect("reads")
}

fn identity(dir: &Path) -> SystemTime {
    fs::metadata(dir)
        .and_then(|meta| meta.created())
        .expect("a creation time")
}

#[test]
fn mirrors_a_packaged_extension_into_a_stable_per_user_folder() {
    let base = support::scratch("cos-extension-path");
    let bundled = base
        .join("ephemeral-mount")
        .join("resources")
        .join("extension");
    let user_data = base.join("user-data");
    write(&bundled.join("manifest.json"), r#"{"version":"9.9.9"}"#);
    write(&bundled.join("background.js"), "current package");
    write(&bundled.join("icons").join("icon128.png"), "icon");
    let folder = ExtensionFolder::packaged(bundled.clone(), &user_data);

    let first = folder.dir().expect("a folder");
    assert_eq!(first, user_data.join("extension"));
    assert_eq!(read(&first.join("background.js")), "current package");
    assert_eq!(read(&first.join("icons").join("icon128.png")), "icon");
    let published = identity(&first);

    // An update refreshes files at the same path instead of asking for Load unpacked again.
    write(&bundled.join("background.js"), "updated package");
    assert_eq!(folder.dir(), Some(first.clone()));
    assert_eq!(identity(&first), published);
    assert_eq!(read(&first.join("background.js")), "updated package");
    assert_eq!(
        folder.dir(),
        Some(first.clone()),
        "a second run with nothing new changes nothing"
    );

    // A damaged package does not take away the copy the user loaded.
    fs::remove_file(bundled.join("manifest.json")).expect("removes");
    assert_eq!(folder.dir(), Some(first.clone()));
    assert_eq!(read(&first.join("background.js")), "updated package");
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn repairs_a_stale_destination_shape_with_a_complete_staged_copy() {
    let base = support::scratch("cos-extension-repair");
    let bundled = base.join("resources").join("extension");
    let user_data = base.join("user-data");
    let stable = user_data.join("extension");
    write(&bundled.join("manifest.json"), r#"{"version":"2.0.2"}"#);
    write(&bundled.join("background.js"), "new background");
    write(&bundled.join("icons").join("icon128.png"), "new icon");
    write(&stable.join("manifest.json"), r#"{"version":"1.0.0"}"#);
    write(&stable.join("background.js"), "old background");
    write(
        &stable.join("icons"),
        "stale file where a directory belongs",
    );
    let published = identity(&stable);

    let folder = ExtensionFolder::packaged(bundled, &user_data);
    assert_eq!(folder.dir(), Some(stable.clone()));
    assert_eq!(identity(&stable), published);
    assert_eq!(read(&stable.join("background.js")), "new background");
    assert_eq!(read(&stable.join("icons").join("icon128.png")), "new icon");
    assert!(!user_data.join("extension.new").exists());
    assert!(!user_data.join("extension.old").exists());
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn recovers_an_interrupted_promotion_from_the_old_copy_before_stale_staging() {
    let base = support::scratch("cos-extension-crash");
    let bundled = base.join("resources").join("extension");
    let user_data = base.join("user-data");
    let stable = user_data.join("extension");
    write(&bundled.join("background.js"), "package without manifest");
    write(&stable.join("background.js"), "corrupt stable");
    let published = identity(&stable);
    write(
        &user_data.join("extension.old").join("manifest.json"),
        r#"{"version":"1.9.9"}"#,
    );
    write(
        &user_data.join("extension.old").join("background.js"),
        "last known good",
    );
    write(
        &user_data.join("extension.new").join("manifest.json"),
        r#"{"version":"2.0.2"}"#,
    );
    write(
        &user_data.join("extension.new").join("background.js"),
        "uncommitted staging",
    );

    let folder = ExtensionFolder::packaged(bundled, &user_data);
    assert_eq!(folder.dir(), Some(stable.clone()));
    assert_eq!(identity(&stable), published);
    assert_eq!(read(&stable.join("background.js")), "last known good");
    assert_eq!(
        read(&stable.join("manifest.json")),
        r#"{"version":"1.9.9"}"#
    );
    assert!(!user_data.join("extension.old").exists());
    assert!(!user_data.join("extension.new").exists());
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn restores_an_interrupted_in_place_update_then_applies_the_package() {
    let base = support::scratch("cos-extension-in-place");
    let bundled = base.join("resources").join("extension");
    let user_data = base.join("user-data");
    let stable = user_data.join("extension");
    write(&bundled.join("manifest.json"), r#"{"version":"2.0.3"}"#);
    write(&bundled.join("background.js"), "next package");
    write(&stable.join("manifest.json"), r#"{"version":"2.0.2"}"#);
    write(&stable.join("background.js"), "partially replaced");
    let published = identity(&stable);
    write(
        &user_data.join("extension.old").join("manifest.json"),
        r#"{"version":"2.0.2"}"#,
    );
    write(
        &user_data.join("extension.old").join("background.js"),
        "last complete package",
    );
    let stage = user_data.join("extension.new");
    write(&stage.join("manifest.json"), r#"{"version":"2.0.3"}"#);
    write(&stage.join("background.js"), "next package");
    write(&stage.join(".chat-on-steroids-source"), "complete-stage");

    let folder = ExtensionFolder::packaged(bundled, &user_data);
    assert_eq!(folder.dir(), Some(stable.clone()));
    assert_eq!(identity(&stable), published);
    assert_eq!(read(&stable.join("background.js")), "next package");
    assert_eq!(
        read(&stable.join("manifest.json")),
        r#"{"version":"2.0.3"}"#
    );
    assert!(!user_data.join("extension.old").exists());
    assert!(!stage.exists());
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn offers_a_newer_build_without_touching_the_folder_until_an_idle_extension_asks() {
    let base = support::scratch("cos-extension-offer");
    let bundled = base.join("resources").join("extension");
    let user_data = base.join("user-data");
    write(&bundled.join("manifest.json"), r#"{"version":"9.9.9"}"#);
    write(&bundled.join("build-stamp.txt"), "bbbbbbbbbbbb\n");
    let folder = ExtensionFolder::packaged(bundled, &user_data);
    assert_eq!(
        folder.update_offer(None),
        None,
        "an unstamped extension cannot be compared"
    );
    assert_eq!(folder.update_offer(Some("bbbbbbbbbbbb")), None);
    assert_eq!(
        folder.update_offer(Some("aaaaaaaaaaaa")),
        Some(UpdateOffer {
            build: "bbbbbbbbbbbb".into()
        })
    );
    assert_eq!(
        folder.materialized_build(),
        None,
        "offering replaced the folder"
    );
    assert_eq!(folder.prepare_update(Some("bbbbbbbbbbbb")), None);
    assert_eq!(
        folder.prepare_update(Some("aaaaaaaaaaaa")),
        Some(PreparedUpdate {
            build: "bbbbbbbbbbbb".into(),
            ready: true
        })
    );
    assert_eq!(folder.materialized_build().as_deref(), Some("bbbbbbbbbbbb"));
    assert_eq!(folder.shipped_build().as_deref(), Some("bbbbbbbbbbbb"));
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn a_checkout_is_used_in_place_and_offers_nothing() {
    let base = support::scratch("cos-extension-checkout");
    let checkout = base.join("extension");
    write(&checkout.join("manifest.json"), "{}");
    write(&checkout.join("build-stamp.txt"), "cccccccccccc");
    let folder = ExtensionFolder::checkout(checkout.clone(), &base.join("user-data"));
    assert_eq!(folder.dir(), Some(checkout));
    assert_eq!(folder.update_offer(Some("aaaaaaaaaaaa")), None);
    assert!(!base.join("user-data").join("extension").exists());
    let _ = fs::remove_dir_all(&base);
}
