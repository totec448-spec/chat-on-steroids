//! `COS_MCP_URLS_FILE`: how the golden recorder and the benchmarks find the surface URLs
//! (`rust/golden/README.md`, item 5). The file holds `{ "core": url, "desktop": url,
//! "plugins": url }`, `null` for a surface without a URL, and is rewritten each time the
//! published URLs change, from the first time Core has one. After a disconnect every value is
//! `null`, so the file never names a dead endpoint.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use cos_store::Logger;
use cos_types::app_state::{ConnectionStatus, SurfaceId};
use serde_json::{Map, Value};
use tokio::sync::watch;

const ENV: &str = "COS_MCP_URLS_FILE";

/// The file `COS_MCP_URLS_FILE` names, when it is set.
pub(crate) fn from_env() -> Option<PathBuf> {
    std::env::var_os(ENV).map(PathBuf::from)
}

pub(crate) async fn publish(
    mut status: watch::Receiver<Arc<ConnectionStatus>>,
    file: PathBuf,
    logger: Logger,
) {
    let mut written = None;
    loop {
        let urls = surface_urls(&status.borrow_and_update());
        let published = urls.get("core").is_some_and(|url| !url.is_null());
        if (published || written.is_some()) && written.as_ref() != Some(&urls) {
            // A failed write is retried at the next change; nothing else depends on the file.
            if let Err(error) = write_atomically(&file, &urls) {
                logger.warn(&format!("could not write {}: {error}", file.display()));
            }
            written = Some(urls);
        }
        if status.changed().await.is_err() {
            return;
        }
    }
}

fn surface_urls(status: &ConnectionStatus) -> Value {
    let mut urls = Map::new();
    for &surface in SurfaceId::ALL {
        let url = status
            .surfaces
            .iter()
            .find(|described| described.id == surface)
            .and_then(|described| described.local_url.clone());
        urls.insert(
            surface.as_str().to_owned(),
            url.map_or(Value::Null, Value::String),
        );
    }
    Value::Object(urls)
}

fn write_atomically(file: &Path, value: &Value) -> std::io::Result<()> {
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(value)?)?;
    std::fs::rename(tmp, file)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use cos_store::Logger;
    use cos_types::app_state::{
        ConnectionState, ConnectionStatus, SurfaceConnectionState, SurfaceId, SurfaceStatus,
    };
    use serde_json::{Value, json};
    use tokio::sync::watch;

    fn status(urls: [Option<&str>; 3]) -> Arc<ConnectionStatus> {
        let surfaces = [SurfaceId::Core, SurfaceId::Desktop, SurfaceId::Plugins]
            .into_iter()
            .zip(urls)
            .map(|(id, url)| SurfaceStatus {
                id,
                connector_name: String::new(),
                chatgpt_name: None,
                description: String::new(),
                card_summary: String::new(),
                optional: id != SurfaceId::Core,
                available: true,
                local_url: url.map(str::to_owned),
                public_url: None,
                tools: Vec::new(),
                state: SurfaceConnectionState::Off,
                detail: String::new(),
                last_request_at: None,
                last_tool_call_at: None,
                proof: None,
            })
            .collect();
        Arc::new(ConnectionStatus {
            state: ConnectionState::Disconnected,
            detail: String::new(),
            public_url: None,
            local_url: urls[0].map(str::to_owned),
            handshake_at: None,
            last_request_at: None,
            last_tool_call_at: None,
            health: None,
            route_settling_until: None,
            surfaces,
        })
    }

    async fn settled(file: &std::path::Path, expected: &Value) {
        for _ in 0..200 {
            if let Ok(bytes) = std::fs::read(file)
                && serde_json::from_slice::<Value>(&bytes).ok().as_ref() == Some(expected)
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("{} never held {expected}", file.display());
    }

    #[tokio::test]
    async fn the_urls_file_follows_the_published_generation() {
        let dir = std::env::temp_dir().join(format!("cos-core-urls-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch folder");
        let file = dir.join("mcp-urls.json");
        let (publish, receiver) = watch::channel(status([None; 3]));
        let writer = tokio::spawn(super::publish(receiver, file.clone(), Logger::new()));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!file.exists(), "nothing is written before Core has a URL");

        let core = "http://127.0.0.1:1/mcp/core/a";
        let desktop = "http://127.0.0.1:1/mcp/desktop/b";
        let plugins = "http://127.0.0.1:1/mcp/plugins/c";
        publish.send_replace(status([Some(core), Some(desktop), Some(plugins)]));
        settled(
            &file,
            &json!({ "core": core, "desktop": desktop, "plugins": plugins }),
        )
        .await;

        publish.send_replace(status([None; 3]));
        settled(
            &file,
            &json!({ "core": null, "desktop": null, "plugins": null }),
        )
        .await;

        drop(publish);
        tokio::time::timeout(Duration::from_secs(5), writer)
            .await
            .expect("the writer ends with the status")
            .expect("joins");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
