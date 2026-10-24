//! Opt-in real Windows UIA provider test. The fixture lives in this repo's
//! Rust build directory, never activates itself, and accepts semantic UIA
//! patterns only. Run with: cargo test -p cos-windows-uia --test native_semantic -- --ignored
#![cfg(windows)]

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use cos_sidecar_runtime::DesktopError;
use cos_windows_uia::{UiaInputHost, UiaState};
use serde_json::{Value, json};

const FIXTURE_CS: &str = r#"
using System;
using System.Threading;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Interop;
public static class OwnedUiaFixture {
    [STAThread] public static void Main() {
        // A WindowsApplication has no console; assigning Console.OutputEncoding
        // throws when no console codepage exists. Write redirected stdout bytes
        // as explicit UTF-8 instead, matching the helper's wire contract.
        var standardOut = Console.OpenStandardOutput();
        Action<string> reply = delegate(string value) {
            var bytes = new System.Text.UTF8Encoding(false).GetBytes(value + "\n");
            standardOut.Write(bytes, 0, bytes.Length);
            standardOut.Flush();
        };
        var app = new Application();
        app.ShutdownMode = ShutdownMode.OnMainWindowClose;
        var window = new Window {
            Title = "Owned CoS Rust UIA fixture",
            Left = -10000, Top = -10000, Width = 500, Height = 300,
            ShowActivated = false, ShowInTaskbar = false
        };
        var panel = new StackPanel();
        window.Content = panel;
        var invoke = new Button { Content = "Invoke fixture", Height = 30 };
        AutomationProperties.SetAutomationId(invoke, "invoke");
        panel.Children.Add(invoke);
        int invocations = 0;
        invoke.Click += delegate { invocations++; };
        var toggle = new CheckBox { Content = "Toggle fixture", Height = 30 };
        AutomationProperties.SetAutomationId(toggle, "toggle");
        panel.Children.Add(toggle);
        var edit = new TextBox {
            Height = 40, Text = "first" + new string('x', 12000)
        };
        AutomationProperties.SetAutomationId(edit, "editor");
        panel.Children.Add(edit);
        var disabled = new Button { Content = "Disabled fixture", IsEnabled = false };
        AutomationProperties.SetAutomationId(disabled, "disabled");
        panel.Children.Add(disabled);
        window.Loaded += delegate {
            reply(new WindowInteropHelper(window).Handle.ToInt64().ToString());
            var commands = new Thread(delegate() {
                string command;
                while ((command = Console.ReadLine()) != null) {
                    if (command == "quit") {
                        window.Dispatcher.Invoke(new Action(delegate { window.Close(); }));
                        return;
                    }
                    window.Dispatcher.Invoke(new Action(delegate {
                        reply((toggle.IsChecked == true ? "1" : "0") + "|" +
                            invocations + "|" + edit.Text);
                    }));
                }
            });
            commands.IsBackground = true;
            commands.Start();
        };
        app.Run(window);
    }
}
"#;

const COMPILE_PS: &str = r#"
$ErrorActionPreference='Stop'
$runtime=[System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
$wpf=Join-Path $runtime 'WPF'
$refs=@('System.dll',(Join-Path $runtime 'System.Xaml.dll'),(Join-Path $wpf 'PresentationFramework.dll'),(Join-Path $wpf 'PresentationCore.dll'),(Join-Path $wpf 'WindowsBase.dll'),(Join-Path $wpf 'UIAutomationProvider.dll'),(Join-Path $wpf 'UIAutomationTypes.dll'))
Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'fixture.cs'))) -ReferencedAssemblies $refs -OutputAssembly (Join-Path $PSScriptRoot 'fixture.exe') -OutputType WindowsApplication
"#;

struct Fixture {
    child: Child,
    output: BufReader<std::process::ChildStdout>,
    dir: PathBuf,
}

impl Fixture {
    fn launch() -> Self {
        // This is a run-owned build directory, never a live user profile or
        // another process's window. Parent Cargo target directory already exists.
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target");
        let dir = root.join(format!("uia-live-fixture-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("create own test fixture directory");
        fs::write(dir.join("fixture.cs"), FIXTURE_CS).expect("write C# fixture");
        fs::write(dir.join("compile.ps1"), COMPILE_PS).expect("write compiler script");
        let compiler = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(dir.join("compile.ps1"))
            .output()
            .expect("start WPF fixture compiler");
        assert!(
            compiler.status.success(),
            "WPF fixture compile failed: {}",
            String::from_utf8_lossy(&compiler.stderr)
        );
        let mut child = Command::new(dir.join("fixture.exe"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("start owned WPF fixture");
        let output = BufReader::new(child.stdout.take().expect("fixture stdout"));
        Self { child, output, dir }
    }

    fn line(&mut self) -> String {
        let mut line = String::new();
        self.output.read_line(&mut line).expect("fixture line");
        assert!(!line.is_empty(), "fixture terminated before reply");
        line.trim().to_string()
    }

    fn state(&mut self) -> String {
        self.child
            .stdin
            .as_mut()
            .expect("fixture stdin")
            .write_all(b"state\n")
            .expect("send fixture state");
        self.child
            .stdin
            .as_mut()
            .expect("fixture stdin")
            .flush()
            .expect("flush fixture stdin");
        self.line()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(input) = self.child.stdin.as_mut() {
            let _ = input.write_all(b"quit\n");
            let _ = input.flush();
        }
        // A single owned process can be killed safely if WPF does not exit.
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

struct SemanticHost {
    window: i64,
    checks: usize,
}

impl UiaInputHost for SemanticHost {
    fn assert_input_owner(&mut self, request: &Value) -> Result<(), DesktopError> {
        self.checks += 1;
        if request.get("id").and_then(Value::as_i64) == Some(self.window) {
            Ok(())
        } else {
            Err(DesktopError::new(
                "WINDOW_APP_MISMATCH",
                "wrong fixture window",
            ))
        }
    }
    fn assert_focused(&mut self, _: i64) -> Result<(), DesktopError> {
        Err(DesktopError::new("FOCUS_FAILED", "fixture never activates"))
    }
    fn click(&mut self, _: i32, _: i32, _: &str, _: u32) -> Result<(), DesktopError> {
        Err(DesktopError::new(
            "BAD_ACTION",
            "physical input forbidden in fixture",
        ))
    }
}

#[test]
#[ignore = "requires a run-owned WPF window and explicitly assigned native desktop fixture lane"]
fn native_wpf_observe_and_semantic_actions_without_foreground_input() {
    let mut fixture = Fixture::launch();
    let window: i64 = fixture.line().parse().expect("numeric owned fixture HWND");
    let mut uia = UiaState::new().expect("MTA COM starts");
    uia.warm().expect("UIA service available");
    let observed = uia
        .find(&json!({"id":window,"maxResults":100}))
        .expect("native WPF UIA provider observed");
    let rows = observed["elements"].as_array().expect("elements array");
    let get = |id: &str| {
        rows.iter()
            .find(|row| row["automationId"] == id)
            .expect("native control must have expected automationId")
    };
    let invoke = get("invoke");
    let toggle = get("toggle");
    let editor = get("editor");
    let disabled = get("disabled");
    assert!(
        invoke["actions"]
            .as_array()
            .expect("invoke actions")
            .contains(&json!("invoke"))
    );
    assert!(
        toggle["actions"]
            .as_array()
            .expect("toggle actions")
            .contains(&json!("toggle"))
    );
    assert_eq!(disabled["enabled"], false);
    let snapshot = observed["snapshotId"].as_u64().expect("snapshot");
    assert!(snapshot > 0);
    let mut host = SemanticHost { window, checks: 0 };
    let act = |row: &Value, action: &str| {
        json!({
            "id":window,"snapshotId":snapshot,"runtimeKey":row["runtimeKey"],"action":action
        })
    };
    let invoked = uia.act(&act(invoke, "invoke"), &mut host).expect("invoke");
    assert_eq!(invoked["route"], "uia");
    assert_eq!(invoked["name"], invoke["name"]);
    assert_eq!(invoked["runtimeKey"], invoke["runtimeKey"]);
    assert_eq!(
        uia.act(&act(toggle, "click"), &mut host)
            .expect("semantic click")["route"],
        "uia"
    );
    assert_eq!(
        uia.act(&act(toggle, "invoke"), &mut host)
            .expect_err("unsupported invoke")
            .code,
        "UI_ACTION_UNSUPPORTED"
    );
    assert_eq!(
        uia.act(&act(disabled, "invoke"), &mut host)
            .expect_err("disabled")
            .code,
        "UI_ELEMENT_DISABLED"
    );
    let setter = json!({
        "id":window, "snapshotId":snapshot,"runtimeKey":editor["runtimeKey"],"action":"set_value",
        "value":"unicode — نص 😀"
    });
    assert_eq!(
        uia.act(&setter, &mut host).expect("semantic edit")["route"],
        "uia"
    );
    let state = fixture.state();
    assert_eq!(state, "1|1|unicode — نص 😀");
    assert!(
        host.checks >= 5,
        "native effects must recheck owner identity"
    );
    let filtered = uia
        .find(&json!({"id":window,"query":"invoke","role":"button","maxResults":1}))
        .expect("fresh filtered observation");
    assert_eq!(
        filtered["elements"]
            .as_array()
            .expect("filtered controls")
            .len(),
        1
    );
    assert_eq!(filtered["elements"][0]["automationId"], "invoke");
}
