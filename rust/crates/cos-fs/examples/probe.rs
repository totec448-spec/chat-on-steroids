//! Resolves a batch of paths for the differential check in `differential/run.mjs`.
//!
//! Reads `[{ "roots": [{ "name", "path" }], "path", "allowMissing", "base" }]` from stdin and
//! prints one `{ "ok": [virtual, real] }` or `{ "err": text, "kind": "sandbox" | "os" }` each.

use std::error::Error;
use std::io::Read;
use std::path::PathBuf;

use cos_fs::{Access, ApprovedRoot, RootKind, RootName, Roots, SandboxError};
use serde_json::{Value, json};

fn main() -> Result<(), Box<dyn Error>> {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let cases: Vec<Value> = serde_json::from_str(&input)?;
    let results = cases.iter().map(run).collect::<Result<Vec<_>, _>>()?;
    println!("{}", Value::Array(results));
    Ok(())
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .ok_or_else(|| format!("missing string {key}"))
}

fn run(case: &Value) -> Result<Value, String> {
    let mut roots = Vec::new();
    for root in case["roots"].as_array().ok_or("missing roots")? {
        roots.push(ApprovedRoot {
            name: RootName::new(text(root, "name")?),
            folder: PathBuf::from(text(root, "path")?),
            kind: RootKind::User,
        });
    }
    let roots = Roots::new(roots);
    let path = text(case, "path")?;
    let access = if case["allowMissing"].as_bool() == Some(true) {
        Access::Create
    } else {
        Access::Read
    };
    let outcome = match case["base"].as_str() {
        Some(base) => cos_fs::resolve(&roots, base, Access::Read)
            .and_then(|base| cos_fs::resolve_from(&roots, &base.virtual_path, path, access)),
        None => cos_fs::resolve(&roots, path, access),
    };
    Ok(match outcome {
        Ok(resolved) => json!({
            "ok": [resolved.virtual_path.as_str(), resolved.real.to_string_lossy()]
        }),
        Err(SandboxError::Os(error)) => {
            json!({ "err": error.to_io_error().to_string(), "kind": "os" })
        }
        Err(error) => json!({ "err": error.to_string(), "kind": "sandbox" }),
    })
}
