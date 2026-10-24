//! Runs a list of store operations against one profile and prints one JSON result per
//! operation. `differential/roundtrip.mjs` runs the same list through `secrets.ts` in Electron
//! and requires the same results.
//!
//! ```text
//! secrets_ops <userData> <ops.json>
//! ```

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Duration, UNIX_EPOCH};

use cos_secrets::{Error, SecretKey, SecretStore};
use serde_json::{Value, json};

fn failure(error: Error) -> Value {
    let kind = match error {
        Error::Unavailable(_) => "unavailable",
        Error::Unreadable => "unreadable",
        Error::Io(_) => "io",
    };
    json!({ "error": kind })
}

fn outcome<T: Into<Value>>(result: Result<T, Error>) -> Value {
    result.map_or_else(failure, Into::into)
}

fn key(op: &Value) -> Result<SecretKey, String> {
    let name = op["key"].as_str().ok_or("operation has no key")?;
    SecretKey::parse(name).ok_or_else(|| format!("{name} is not a SecretKey"))
}

fn run(user_data: PathBuf, ops: &[Value]) -> Result<Vec<Value>, String> {
    let mut store = SecretStore::new(&user_data);
    let mut results = Vec::with_capacity(ops.len());
    for op in ops {
        results.push(match op["op"].as_str().unwrap_or_default() {
            "status" => serde_json::to_value(store.status()).map_err(|error| error.to_string())?,
            "get" => store.get(&key(op)?).into(),
            "has" => store.has(&key(op)?).into(),
            "set" => outcome(
                store
                    .set(&key(op)?, op["value"].as_str().ok_or("set has no value")?)
                    .map(|()| Value::Null),
            ),
            "clear" => outcome(store.clear(&key(op)?).map(|()| Value::Null)),
            "deleteAll" => outcome(store.delete_all().map(|()| Value::Null).map_err(Error::Io)),
            "setAside" => {
                let now = UNIX_EPOCH
                    + Duration::from_millis(op["now"].as_u64().ok_or("setAside has no now")?);
                outcome(store.set_aside_unreadable(now))
            }
            "unreadable" => store.unreadable().into(),
            "restart" => {
                store = SecretStore::new(&user_data);
                Value::Null
            }
            other => return Err(format!("unknown operation {other:?}")),
        });
    }
    Ok(results)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [user_data, ops] = args.as_slice() else {
        eprintln!("usage: secrets_ops <userData> <ops.json>");
        return ExitCode::FAILURE;
    };
    let ops: Vec<Value> = match std::fs::read(ops)
        .map_err(|e| e.to_string())
        .and_then(|bytes| serde_json::from_slice(&bytes).map_err(|e| e.to_string()))
    {
        Ok(ops) => ops,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    match run(PathBuf::from(user_data), &ops) {
        Ok(results) => {
            println!("{}", Value::from(results));
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
