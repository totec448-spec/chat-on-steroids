//! A scratch profile with one approved folder, a Core on it, and `tools/call` over HTTP.

#![allow(dead_code)]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::Duration;

use cos_core::{Core, Launch};
use cos_store::{Acquired, AppPaths, BridgePortOverride, Instance, LaunchArgs};
use cos_types::app_state::SurfaceId;
use serde_json::{Value, json};

pub struct Scratch(pub PathBuf);

impl Scratch {
    /// A profile whose `config.json` approves `project` for commands under `allowlist`.
    pub fn new(name: &str, allowlist: Value) -> Self {
        let dir = std::env::temp_dir().join(format!("cos-headless-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("profile")).expect("profile folder");
        std::fs::create_dir_all(dir.join("project")).expect("project folder");
        let config = json!({
            "roots": [{ "name": "project", "path": dir.join("project") }],
            "capabilities": {
                "browse": false, "search": false, "read": false, "metadata": false,
                "create": false, "edit": false, "move": false, "deleteFile": false,
                "command": true, "screen": false, "control": false,
                "clipboardRead": false, "clipboardWrite": false
            },
            "readOnly": false,
            "multiAgent": { "enabled": false, "allowUnattributedCalls": false },
            "tunnel": {
                "kind": "manual", "tunnelId": "", "desktopTunnelId": "",
                "pluginsTunnelId": "", "binaryPath": ""
            },
            "ui": {
                "minimizeToTray": false, "autoConnect": true, "language": "en",
                "turnNotifications": false, "keepAwake": false, "startAtLogin": false,
                "localAppUsage": false, "autoRefreshPlugins": false,
                "autoRefreshPluginsAsked": true
            },
            "controlApi": { "enabled": false },
            "commandAllowlist": allowlist
        });
        std::fs::write(
            dir.join("profile").join("config.json"),
            serde_json::to_vec_pretty(&config).expect("serializes"),
        )
        .expect("seeds config.json");
        Self(dir)
    }

    pub fn profile(&self) -> PathBuf {
        self.0.join("profile")
    }

    /// Starts a Core in this process and waits for its Core MCP URL.
    pub fn start(&self) -> (Core, String) {
        let paths = AppPaths::at(self.profile());
        let argv = vec!["cos-headless-test".to_owned()];
        let Acquired::Primary(instance) =
            Instance::acquire(paths.user_data(), &argv).expect("locks")
        else {
            panic!("a fresh profile has no other owner");
        };
        // Port 0: a test never listens where a real extension looks.
        let core = Core::start_with_bridge_ports(
            Launch {
                args: LaunchArgs::parse(&argv),
                paths,
            },
            instance,
            BridgePortOverride::parse("0"),
        )
        .expect("starts");
        let mut connection = core.app().watches().connection;
        let url = core.block_on(async {
            let published = connection.wait_for(|status| status.local_url.is_some());
            let status = tokio::time::timeout(Duration::from_secs(30), published)
                .await
                .expect("the Core publishes a URL in time")
                .expect("the Core publishes a URL");
            status
                .surfaces
                .iter()
                .find(|surface| surface.id == SurfaceId::Core)
                .and_then(|surface| surface.local_url.clone())
                .expect("the Core URL")
        });
        (core, url)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn allow_only(rule: &str) -> Value {
    json!({ "enabled": true, "mode": "allow", "rules": [rule] })
}

pub fn no_policy() -> Value {
    json!({ "enabled": false, "mode": "allow", "rules": [] })
}

/// One `tools/call` over HTTP/1.1, answered as JSON or as one SSE message.
pub fn call(url: &str, id: u64, tool: &str, arguments: Value) -> Value {
    let rest = url.strip_prefix("http://").expect("an http URL");
    let (host, path) = rest.split_at(rest.find('/').expect("a path"));
    let body = json!({
        "jsonrpc": "2.0", "id": id, "method": "tools/call",
        "params": { "name": tool, "arguments": arguments }
    })
    .to_string();
    let mut stream = TcpStream::connect(host).expect("connects to the MCP endpoint");
    stream
        .set_read_timeout(Some(Duration::from_secs(60)))
        .expect("sets a read timeout");
    write!(
        stream,
        "POST {path} HTTP/1.1\r\nhost: {host}\r\ncontent-type: application/json\r\naccept: application/json, text/event-stream\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
    )
    .expect("sends");
    let mut reply = String::new();
    stream.read_to_string(&mut reply).expect("reads the reply");
    let payload = reply
        .lines()
        .find_map(|line| line.strip_prefix("data: "))
        .or_else(|| reply.split("\r\n\r\n").nth(1))
        .unwrap_or_else(|| panic!("no JSON-RPC message in {reply}"));
    let message: Value = serde_json::from_str(payload).expect("JSON-RPC message");
    message["result"].clone()
}

pub fn exec(url: &str, id: u64, arguments: Value) -> Value {
    call(url, id, "exec_command", arguments)
}

pub fn first_text(result: &Value) -> &str {
    result["content"][0]["text"].as_str().unwrap_or_default()
}
