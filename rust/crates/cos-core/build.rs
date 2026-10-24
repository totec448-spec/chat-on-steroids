//! Takes the product version from the repository's `package.json`, the one place it is set, so
//! `serverInfo.version` and `appVersion` match the TypeScript build they replace.

use std::path::Path;

fn main() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let package = manifest.join("../../../package.json");
    println!("cargo::rerun-if-changed={}", package.display());
    let text = std::fs::read_to_string(&package)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", package.display()));
    let json: serde_json::Value = serde_json::from_str(&text).expect("package.json is JSON");
    let version = json["version"]
        .as_str()
        .expect("package.json has a string version");
    println!("cargo::rustc-env=COS_APP_VERSION={version}");
}
