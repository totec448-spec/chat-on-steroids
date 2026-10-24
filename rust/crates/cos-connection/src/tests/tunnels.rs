//! The tunnel adapters through the lifecycle, with `examples/fake_tunnel.rs` installed as
//! `tunnel-client` and `cloudflared` on a fake `PATH`. No real tunnel starts and no real
//! key is used.

use std::path::PathBuf;

use cos_types::app_state::TunnelHealth;
use cos_types::config::TunnelKind;
use cos_types::json::JsNumber;

use super::*;

const CORE_ID: &str = "tunnel_0123456789abcdef0123456789abcdef";
const DESKTOP_ID: &str = "tunnel_fedcba9876543210fedcba9876543210";
const KEY: &str = "sk-test-not-a-real-key";
const CORE_URL: &str = "http://127.0.0.1:45671/mcp/core/core-token-1";

struct Tools {
    dir: PathBuf,
}

impl Tools {
    fn install(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "cos-connection-tools-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("tools folder");
        let deps = std::env::current_exe().expect("test binary");
        let fake = deps
            .parent()
            .and_then(Path::parent)
            .expect("target folder")
            .join("examples")
            .join(format!("fake_tunnel{}", std::env::consts::EXE_SUFFIX));
        for program in ["tunnel-client", "cloudflared"] {
            let target = dir.join(format!("{program}{}", std::env::consts::EXE_SUFFIX));
            std::fs::copy(&fake, target).expect("cargo test builds examples/fake_tunnel");
        }
        Self { dir }
    }

    fn host(&self, extra: &[(&str, &str)]) -> Host {
        let mut host = Host::isolated(Some(&self.dir));
        // Work folders go under this test's own folder, so even a failed test leaves none.
        host.temp_dir = self.dir.join("tmp");
        std::fs::create_dir_all(&host.temp_dir).expect("scratch temp");
        host.env.extend(
            extra
                .iter()
                .map(|(name, value)| ((*name).into(), (*value).into())),
        );
        host
    }

    /// The fake's recorded launches, once at least `count` exist.
    async fn calls(&self, count: usize) -> Vec<Value> {
        for _ in 0..500 {
            let mut files: Vec<PathBuf> = std::fs::read_dir(&self.dir)
                .expect("tools folder")
                .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                .filter(|path| {
                    path.file_name()
                        .is_some_and(|name| name.to_string_lossy().starts_with("call-"))
                })
                .collect();
            files.sort();
            let calls: Vec<Value> = files
                .iter()
                .filter_map(|file| serde_json::from_slice(&std::fs::read(file).ok()?).ok())
                .collect();
            if calls.len() >= count {
                return calls;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the fake was launched fewer than {count} times");
    }
}

impl Drop for Tools {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn args(call: &Value) -> Vec<String> {
    call["args"]
        .as_array()
        .expect("args")
        .iter()
        .map(|arg| arg.as_str().expect("text").to_owned())
        .collect()
}

/// Every spelling of `name` in the child's environment, as Windows matches names.
fn env_values(call: &Value, name: &str) -> Vec<String> {
    call["env"]
        .as_object()
        .expect("env")
        .iter()
        .filter(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str().expect("text").to_owned())
        .collect()
}

fn fake_with(tools: &Tools, extra: &[(&str, &str)], key: Option<&str>) -> Fake {
    let fake = Fake::default();
    *fake.0.host.lock().unwrap() = Arc::new(tools.host(extra));
    *fake.0.api_key.lock().unwrap() = key.map(str::to_owned);
    fake
}

fn openai(tunnel_id: &str) -> Config {
    let mut config = base_config();
    config.tunnel.kind = TunnelKind::Openai;
    config.tunnel.tunnel_id = tunnel_id.to_owned();
    config
}

async fn unanswered(base: &str) -> bool {
    crate::tunnel::health_get(base, "/readyz").await.is_none()
}

#[tokio::test]
async fn tunnel_client_gets_its_argv_and_env_and_is_watched_until_disconnect() {
    let tools = Tools::install("openai");
    let fake = fake_with(
        &tools,
        &[
            ("OPENAI_API_KEY", "inherited-from-a-terminal"),
            ("control_plane_api_key", "inherited-too"),
            ("FAKE_TUNNEL_MODE", "ready"),
        ],
        Some(KEY),
    );
    let mut harness = Harness::start_with(fake, openai(CORE_ID));
    let status = harness
        .until("verified", |status| {
            status.state == ConnectionState::Connected && status.handshake_at.is_some()
        })
        .await;
    assert_eq!(
        status.detail,
        "Connected. Last verified handshake with OpenAI just now. Pick the tunnel in ChatGPT."
    );
    assert_eq!(
        status.health,
        Some(TunnelHealth {
            poll_errors: Some(2),
            uptime_seconds: Some(JsNumber(12.0)),
            route: Some("api.openai.com:443 \u{b7} direct".to_owned()),
            probe: Some("ok".to_owned()),
            client_version: Some("0.9.0-fake".to_owned()),
        })
    );
    assert!(matches!(status.route_settling_until, Some(Some(_))));
    assert_eq!(
        surface(&status, SurfaceId::Core).state,
        SurfaceConnectionState::Live
    );
    // Plugins needs its own Secure Tunnel on OpenAI.
    let plugins = surface(&status, SurfaceId::Plugins);
    assert_eq!(plugins.state, SurfaceConnectionState::Off);
    assert!(plugins.detail.starts_with("Not published yet."));
    assert!(harness.logged("core tunnel connected"));

    let calls = tools.calls(1).await;
    let call = &calls[0];
    let argv = args(call);
    assert_eq!(argv.len(), 11);
    assert_eq!(
        argv[..6],
        [
            "run",
            "--control-plane.tunnel-id",
            CORE_ID,
            "--health.listen-addr",
            "127.0.0.1:0",
            "--health.url-file"
        ]
    );
    let health_file = PathBuf::from(&argv[6]);
    assert_eq!(
        health_file.file_name().and_then(|n| n.to_str()),
        Some("health.url")
    );
    assert_eq!(argv[7..], ["--log.format", "json", "--log.level", "info"]);
    assert!(
        !argv
            .iter()
            .any(|arg| arg.contains(KEY) || arg.contains("core-token"))
    );
    assert_eq!(env_values(call, "CONTROL_PLANE_API_KEY"), [KEY]);
    assert_eq!(
        env_values(call, "MCP_SERVER_URL"),
        [format!("url={CORE_URL},channel=main")]
    );
    assert_eq!(
        env_values(call, "MCP_DISCOVERY_EXTRA_HEADERS"),
        ["x-cos-tunnel-probe: probe-1"]
    );
    assert!(env_values(call, "OPENAI_API_KEY").is_empty());
    assert_eq!(*harness.fake.0.key_lookups.lock().unwrap(), [None]);

    let base = std::fs::read_to_string(&health_file).expect("the fake wrote its health url");
    let base = base.trim().trim_end_matches('/').to_owned();
    assert!(!unanswered(&base).await);
    harness.connection.disconnect();
    harness.disconnected("").await;
    assert!(unanswered(&base).await, "the client process tree is gone");
    let work_dir = health_file.parent().expect("work folder");
    assert!(!work_dir.exists(), "the work folder is removed");
}

#[tokio::test]
async fn tunnel_client_refusals_name_what_to_fix() {
    let tools = Tools::install("refusals");
    for (config, key, detail) in [
        (
            openai("tunnel_123"),
            Some(KEY),
            "Enter a tunnel ID that looks like tunnel_ followed by 32 hex characters.",
        ),
        (
            openai(CORE_ID),
            None,
            "Add your OpenAI tunnel API key first.",
        ),
    ] {
        let fake = fake_with(&tools, &[], key);
        let mut harness = Harness::start_with(fake, config);
        let status = harness
            .until(detail, |status| {
                status.state == ConnectionState::TunnelUnavailable
            })
            .await;
        assert_eq!(status.detail, detail);
        assert_eq!(status.local_url, None, "the endpoint is stopped again");
        assert!(harness.logged(&format!("connect failed: {detail}")));
    }
    let mut harness = Harness::start(openai(CORE_ID));
    let status = harness
        .until("not found", |status| {
            status.state == ConnectionState::TunnelUnavailable
        })
        .await;
    assert!(status.detail.starts_with("tunnel-client was not found."));
}

#[tokio::test]
async fn a_rejected_tunnel_key_reports_auth_failed() {
    let tools = Tools::install("auth");
    let fake = fake_with(&tools, &[("FAKE_TUNNEL_MODE", "auth")], Some(KEY));
    let mut harness = Harness::start_with(fake, openai(CORE_ID));
    let status = harness
        .until("auth failed", |status| {
            status.state == ConnectionState::AuthFailed
        })
        .await;
    assert_eq!(
        status.detail,
        "OpenAI refused access to this tunnel. Check its account, organization, API key and tunnel ID in Connection settings."
    );
    assert_eq!(
        surface(&status, SurfaceId::Core).state,
        SurfaceConnectionState::Error
    );
    harness.connection.disconnect();
    harness.disconnected("").await;
}

#[tokio::test]
async fn an_exited_client_is_replaced_after_backoff() {
    let tools = Tools::install("exit");
    let fake = fake_with(&tools, &[("FAKE_TUNNEL_MODE", "exit")], Some(KEY));
    let mut harness = Harness::start_with(fake, openai(CORE_ID));
    let status = harness
        .until("reconnecting", |status| {
            status.detail.contains("Reconnecting in 2s")
        })
        .await;
    assert_eq!(status.state, ConnectionState::ConnectingTunnel);
    assert_eq!(
        status.detail,
        "ERROR mcp probe failed: boom Reconnecting in 2s\u{2026}"
    );
    assert_eq!(
        tools.calls(2).await.len(),
        2,
        "a second client was launched"
    );
    harness.connection.disconnect();
    harness.disconnected("").await;
}

#[tokio::test]
async fn desktop_gets_its_own_tunnel_on_openai_and_shared_ids_are_named() {
    let tools = Tools::install("optional");
    let fake = fake_with(&tools, &[], Some(KEY));
    let mut config = openai(CORE_ID);
    set(&mut config.capabilities, Capability::Screen, true);
    config.tunnel.desktop_tunnel_id = DESKTOP_ID.to_owned();
    config.tunnel.plugins_tunnel_id = Some(CORE_ID.to_owned());
    let mut harness = Harness::start_with(fake, config);
    // Each tunnel reports on its own schedule, so Core is awaited too: the optional cards can
    // go live before Core's first readiness poll answers.
    harness
        .until("every tunnel live", |status| {
            status.state == ConnectionState::Connected
                && !status.surfaces.is_empty()
                && surface(status, SurfaceId::Desktop).state == SurfaceConnectionState::Live
                && surface(status, SurfaceId::Plugins).state == SurfaceConnectionState::Live
        })
        .await;
    let calls = tools.calls(3).await;
    let desktop = calls
        .iter()
        .find(|call| args(call)[2] == DESKTOP_ID)
        .expect("a desktop tunnel ran");
    assert_eq!(
        env_values(desktop, "MCP_SERVER_URL"),
        ["url=http://127.0.0.1:45671/mcp/desktop/desktop-token-1,channel=main"]
    );
    assert!(harness.logged(
        "connection: core and plugins are configured on the same Secure Tunnel ID. OpenAI dispatches round-robin across every client on one ID, so roughly one call in 2 will reach the wrong connector and come back as UNKNOWN_TOOL for a tool that exists. Give each connector its own tunnel ID."
    ));

    harness.edit(|config| set(&mut config.capabilities, Capability::Screen, false));
    let status = harness
        .until("desktop withdrawn", |status| {
            surface(status, SurfaceId::Desktop).state == SurfaceConnectionState::Off
        })
        .await;
    assert_eq!(status.state, ConnectionState::Connected);
    harness.until_logged("desktop connector unpublished").await;
    assert_eq!(
        tools.calls(3).await.len(),
        3,
        "withdrawing Desktop launches no client"
    );
    harness.connection.disconnect();
    harness.disconnected("").await;
}

#[tokio::test]
async fn cloudflared_publishes_every_surface_on_its_quick_tunnel() {
    let tools = Tools::install("cloudflared");
    let fake = fake_with(
        &tools,
        &[("CLOUDFLARED_TOKEN", "inherited-from-a-terminal")],
        None,
    );
    let mut config = base_config();
    config.tunnel.kind = TunnelKind::Cloudflared;
    let mut harness = Harness::start_with(fake, config);
    let status = harness.connected().await;
    assert_eq!(
        status.detail,
        "Connected. Paste the URL below into ChatGPT as a custom connector."
    );
    assert_eq!(
        status.public_url.as_deref(),
        Some("https://fake-quick.trycloudflare.com/mcp/core/core-token-1")
    );
    assert_eq!(
        surface(&status, SurfaceId::Plugins).public_url.as_deref(),
        Some("https://fake-quick.trycloudflare.com/mcp/plugins/plugins-token-1")
    );
    assert_eq!(surface(&status, SurfaceId::Desktop).public_url, None);
    let calls = tools.calls(1).await;
    assert_eq!(
        args(&calls[0]),
        [
            "tunnel",
            "--no-autoupdate",
            "--url",
            "http://127.0.0.1:45671",
            "--http-host-header",
            "127.0.0.1:45671"
        ]
    );
    assert!(env_values(&calls[0], "CLOUDFLARED_TOKEN").is_empty());
    assert!(harness.logged("quick tunnel connected"));
    harness.connection.disconnect();
    let status = harness.disconnected("").await;
    assert_eq!(status.public_url, None);
}

#[tokio::test]
async fn a_cloudflared_that_exits_says_why() {
    let tools = Tools::install("cloudflared-exit");
    let fake = fake_with(&tools, &[("FAKE_TUNNEL_MODE", "exit")], None);
    let mut config = base_config();
    config.tunnel.kind = TunnelKind::Cloudflared;
    let mut harness = Harness::start_with(fake, config);
    let status = harness
        .until("unavailable", |status| {
            status.state == ConnectionState::TunnelUnavailable
        })
        .await;
    assert_eq!(
        status.detail,
        "2026-10-20T00:00:00Z ERR failed to reach the edge: connection refused"
    );
    assert_eq!(
        surface(&status, SurfaceId::Core).state,
        SurfaceConnectionState::Error
    );
    // No public URL was ever reported, so the shared-origin cards were never published.
    assert_eq!(
        surface(&status, SurfaceId::Plugins).state,
        SurfaceConnectionState::Off
    );
}
