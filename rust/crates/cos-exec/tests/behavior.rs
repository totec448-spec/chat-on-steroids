//! What a model observes through `exec_command` and `write_stdin`, for each launcher: exit
//! codes, working folder, environment, isolation between calls, unicode, Ctrl-C, tree kill,
//! bounded shutdown, custody and the command policy.

#![cfg(windows)]

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use cos_exec::{
    CommandPolicy, ExecDeps, ExecManager, FreshProcess, Launcher, PolicyMode, PrestartedPowerShell,
};
use cos_fs::{ApprovedRoot, RootKind, RootName, Roots};
use cos_store::Platform;
use cos_tools::{
    CallContext, Caller, Capability, CapabilitySet, DynTool, FeatureSet, Grants, RequestId,
    SurfaceId, ToolError,
};
use serde_json::{Value, json};
use support::Project;

struct Exec {
    manager: Arc<ExecManager>,
    exec: Arc<dyn DynTool>,
    stdin: Arc<dyn DynTool>,
    project: Project,
}

impl Exec {
    fn new(launcher: Arc<dyn Launcher>) -> Self {
        Self::with_manager(ExecManager::new(ExecDeps { launcher }))
    }

    fn with_manager(manager: Arc<ExecManager>) -> Self {
        let mut tools = manager.tools();
        let stdin = tools.remove(1);
        let exec = tools.remove(0);
        Self {
            manager,
            exec,
            stdin,
            project: Project::new("behavior"),
        }
    }

    fn cx(&self, caller: Caller) -> CallContext {
        let grants = Grants {
            capabilities: CapabilitySet::EMPTY.with(Capability::Command),
            read_only: false,
            features: FeatureSet::default(),
            allow_unattributed: false,
            roots: Roots::new([ApprovedRoot {
                name: RootName::new("project"),
                folder: self.project.root.clone(),
                kind: RootKind::User,
            }]),
            platform: Platform::Windows,
        };
        CallContext::standalone(SurfaceId::Core, Arc::new(grants), caller)
    }

    async fn run_as(&self, caller: Caller, args: Value) -> Result<Value, ToolError> {
        let output = self.exec.call_json(&self.cx(caller), args).await?;
        Ok(output.result.structured_content.unwrap_or(Value::Null))
    }

    async fn run(&self, cmd: &str) -> Value {
        self.run_as(Caller::unattributed(None), json!({ "cmd": cmd }))
            .await
            .unwrap_or_else(|error| panic!("{cmd}: {error}"))
    }

    async fn poll_as(&self, caller: Caller, args: Value) -> Result<Value, ToolError> {
        let output = self.stdin.call_json(&self.cx(caller), args).await?;
        Ok(output.result.structured_content.unwrap_or(Value::Null))
    }

    /// Lets the pre-started launcher's spare finish starting, so the next call uses it.
    async fn warm(&self) {
        self.run("Write-Output warm").await;
        tokio::time::sleep(Duration::from_millis(1500)).await;
    }

    /// Writes `chars` to a running session, then polls until it ends. The sessions this is
    /// used on run ping for ten minutes, so one that ends within the wait was ended by `chars`,
    /// however slowly a loaded machine lets it go.
    async fn until_ended(&self, session: u64, chars: &str) -> Value {
        let ended = tokio::time::timeout(Duration::from_secs(120), async {
            let mut next = chars;
            loop {
                let polled = self
                    .poll_as(
                        Caller::unattributed(None),
                        json!({ "session_id": session, "chars": next }),
                    )
                    .await
                    .expect("polled");
                if polled.get("completed_session_id").is_some() {
                    return polled;
                }
                next = "";
            }
        })
        .await;
        ended.unwrap_or_else(|_| panic!("session {session} still running 120 s after {chars:?}"))
    }
}

/// Waits until `pid` has exited, for as long as a loaded machine needs.
async fn until_dead(pid: u32) {
    let started = Instant::now();
    while pid_alive(pid) {
        assert!(
            started.elapsed() < Duration::from_secs(60),
            "{pid} still alive after 60 s"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn launchers() -> Vec<(&'static str, Arc<dyn Launcher>)> {
    vec![
        ("fresh", Arc::new(FreshProcess)),
        ("prestarted", Arc::new(PrestartedPowerShell::new())),
    ]
}

fn output(value: &Value) -> &str {
    value["output"].as_str().unwrap_or_default()
}

fn pid_alive(pid: u32) -> bool {
    let out = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .expect("tasklist");
    String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn exit_codes_follow_the_powershell_host_rules() {
    for (name, launcher) in launchers() {
        let exec = Exec::new(launcher);
        exec.warm().await;
        for (cmd, code) in [
            ("exit 3", 3),
            ("cmd /c exit 5", 1),
            ("cmd /c exit 5; Write-Output after", 0),
            ("Get-Item C:\\definitely-missing-cos-exec", 1),
            (
                "Get-Item C:\\definitely-missing-cos-exec; Write-Output after",
                0,
            ),
            ("throw 'boom'", 1),
            ("Write-Output (1 +", 1),
            ("Write-Output before; exit 7; Write-Output never", 7),
        ] {
            let result = exec.run(cmd).await;
            assert_eq!(result["exit_code"], json!(code), "{name}: {cmd}: {result}");
        }
        exec.manager.terminate_all().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn commands_run_in_their_folder_with_the_exec_environment_and_utf8() {
    for (name, launcher) in launchers() {
        let exec = Exec::new(launcher);
        exec.warm().await;
        let folder = exec.project.root.join("src");
        let canonical = cos_fs::canonical(&folder).expect("folder");
        let result = exec
            .run_as(
                Caller::unattributed(None),
                json!({ "cmd": "(Get-Location).Path; [Environment]::CurrentDirectory; $env:NO_COLOR; $env:PAGER; Write-Output 'h\u{e9}llo \u{2713} \u{65e5}\u{672c}'", "workdir": "/project/src" }),
            )
            .await
            .expect("ran");
        let path = canonical.to_string_lossy();
        assert_eq!(
            output(&result),
            format!("{path}\r\n{path}\r\n1\r\ncat\r\nh\u{e9}llo \u{2713} \u{65e5}\u{672c}\r\n"),
            "{name}"
        );
        exec.manager.terminate_all().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn nothing_one_command_changes_reaches_the_next() {
    for (name, launcher) in launchers() {
        let exec = Exec::new(launcher);
        exec.warm().await;
        exec.run("$x = 41; $env:COS_LEAK = 'v'; cd ..; function global:cosf { 'f' }; [Console]::OutputEncoding = [Text.Encoding]::ASCII")
            .await;
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let result = exec
            .run("\"[$x][$env:COS_LEAK]\"; Split-Path -Leaf (Get-Location).Path; [bool](Get-Command cosf -ErrorAction SilentlyContinue); [Console]::OutputEncoding.WebName")
            .await;
        assert_eq!(
            output(&result),
            "[][]\r\nproject\r\nFalse\r\nutf-8\r\n",
            "{name}"
        );
        exec.manager.terminate_all().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_prestarted_launcher_really_uses_its_spare() {
    let exec = Exec::new(Arc::new(PrestartedPowerShell::new()));
    exec.warm().await;
    // Split, so the command's own text never matches.
    let names_a_pipe = "[Environment]::CommandLine -like ('*NamedPipe' + 'ServerStream*')";
    let result = exec.run(names_a_pipe).await;
    assert_eq!(
        output(&result),
        "True\r\n",
        "a spare's command line names its pipe"
    );
    let fresh = Exec::new(Arc::new(FreshProcess));
    let result = fresh.run(names_a_pipe).await;
    assert_eq!(
        output(&result),
        "False\r\n",
        "a fresh process names no pipe"
    );
    exec.manager.terminate_all().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_wall_time_covers_a_command_that_ends_quickly() {
    for (name, launcher) in launchers() {
        let exec = Exec::new(launcher);
        exec.warm().await;
        let result = exec.run("Start-Sleep -Milliseconds 100; 'slept'").await;
        assert_eq!(output(&result), "slept\r\n", "{name}");
        let wall = result["wall_time_seconds"].as_f64().unwrap_or_default();
        assert!(
            (0.1..30.0).contains(&wall),
            "{name}: a 100 ms command reports {wall} s"
        );
        exec.manager.terminate_all().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ctrl_c_ends_a_pipe_session_and_its_whole_tree() {
    for (name, launcher) in launchers() {
        let exec = Exec::new(launcher);
        exec.warm().await;
        let started = exec
            .run_as(
                Caller::unattributed(None),
                json!({ "cmd": "$p = Start-Process ping -ArgumentList '-n','600','127.0.0.1' -PassThru -WindowStyle Hidden; Write-Output $p.Id; Start-Sleep 600", "yield_time_ms": 3000 }),
            )
            .await
            .expect("started");
        let session = started["session_id"].as_u64().expect("still running");
        let child: u32 = output(&started).trim().parse().expect("child pid printed");
        assert!(pid_alive(child), "{name}: grandchild started");
        exec.until_ended(session, "\u{3}").await;
        until_dead(child).await;
        exec.manager.terminate_all().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ctrl_c_reaches_a_terminal_session() {
    cos_exec::restore_ctrl_c();
    let exec = Exec::new(Arc::new(FreshProcess));
    let started = exec
        .run_as(
            Caller::unattributed(None),
            json!({ "cmd": "ping -n 600 127.0.0.1", "tty": true, "yield_time_ms": 2000 }),
        )
        .await
        .expect("started");
    let session = started["session_id"].as_u64().expect("still running");
    // A loaded machine can take longer than the yield to start the shell; a Ctrl-C that
    // arrives before ping runs proves nothing either way.
    let mut seen = output(&started).to_owned();
    while !seen.contains("Reply from") {
        let polled = exec
            .poll_as(
                Caller::unattributed(None),
                json!({ "session_id": session, "chars": "" }),
            )
            .await
            .expect("polled");
        assert!(
            polled.get("session_id").is_some(),
            "ping ended early: {polled}"
        );
        seen.push_str(output(&polled));
    }
    exec.until_ended(session, "\u{3}").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_short_yield_returns_a_session_that_can_be_polled_to_its_end() {
    let exec = Exec::new(Arc::new(FreshProcess));
    let started = exec
        .run_as(
            Caller::unattributed(None),
            json!({ "cmd": "Start-Sleep -Milliseconds 1500; Write-Output done", "yield_time_ms": 300 }),
        )
        .await
        .expect("started");
    let session = started["session_id"]
        .as_u64()
        .expect("running after 300 ms");
    let mut last = Value::Null;
    let mut seen = output(&started).to_owned();
    for _ in 0..5 {
        last = exec
            .poll_as(
                Caller::unattributed(None),
                json!({ "session_id": session, "chars": "" }),
            )
            .await
            .expect("polled");
        seen.push_str(output(&last));
        if last.get("completed_session_id").is_some() {
            break;
        }
    }
    assert_eq!(last["exit_code"], json!(0), "{last}");
    assert_eq!(
        seen, "done\r\n",
        "each chunk is delivered to exactly one poll"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shutdown_ends_live_sessions_within_its_bound() {
    for (name, launcher) in launchers() {
        let exec = Exec::new(launcher);
        exec.warm().await;
        let mut pids = Vec::new();
        for _ in 0..3 {
            exec.run_as(
                Caller::unattributed(None),
                json!({ "cmd": "Start-Sleep 60", "yield_time_ms": 250 }),
            )
            .await
            .expect("started");
        }
        pids.extend(exec.manager.live_sessions().into_iter().map(|(_, pid)| pid));
        assert_eq!(pids.len(), 3, "{name}");
        let started = Instant::now();
        exec.manager.terminate_all().await;
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{name}: bounded"
        );
        assert!(exec.manager.live_sessions().is_empty(), "{name}");
        for pid in pids {
            assert!(!pid_alive(pid), "{name}: {pid} ended");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_session_answers_only_its_own_caller() {
    let exec = Exec::new(Arc::new(FreshProcess));
    let request = |id: &str| Caller::unattributed(RequestId::from_header(id));
    let anonymous = exec
        .run_as(
            Caller::unattributed(None),
            json!({ "cmd": "Start-Sleep 30", "yield_time_ms": 250 }),
        )
        .await
        .expect("started");
    let session = anonymous["session_id"].as_u64().expect("running");
    let refused = exec
        .poll_as(
            request("wfr_a"),
            json!({ "session_id": session, "chars": "" }),
        )
        .await
        .expect_err("a request cannot adopt an anonymous session");
    assert!(
        refused.to_string().contains("EXEC_SESSION_ANONYMOUS"),
        "{refused}"
    );

    let owned = exec
        .run_as(
            request("wfr_a"),
            json!({ "cmd": "Start-Sleep 30", "yield_time_ms": 250 }),
        )
        .await
        .expect("started");
    let session = owned["session_id"].as_u64().expect("running");
    let refused = exec
        .poll_as(
            request("wfr_b"),
            json!({ "session_id": session, "chars": "" }),
        )
        .await
        .expect_err("another request is not proven to own it");
    assert!(matches!(refused, ToolError::Identity(_)), "{refused:?}");
    assert!(refused.to_string().contains("EXEC_CALLER_UNIDENTIFIED"));
    let allowed = exec
        .poll_as(
            request("wfr_a"),
            json!({ "session_id": session, "chars": "", "yield_time_ms": 5000 }),
        )
        .await;
    assert!(allowed.is_ok(), "{allowed:?}");
    exec.manager.terminate_all().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_command_policy_refuses_before_anything_runs() {
    let policy = CommandPolicy {
        enabled: true,
        mode: PolicyMode::Allow,
        rules: vec!["git status".into()],
    };
    let exec = Exec::with_manager(ExecManager::with_policy(
        ExecDeps {
            launcher: Arc::new(FreshProcess),
        },
        Box::new(move || policy.clone()),
    ));
    let refused = exec
        .run_as(
            Caller::unattributed(None),
            json!({ "cmds": ["git status", "Remove-Item x"] }),
        )
        .await
        .expect_err("not on the list");
    assert!(
        refused.to_string().starts_with(
            "COMMAND_NOT_ALLOWED in command 2: the command did not match any allow rule."
        ),
        "{refused}"
    );
    let allowed = exec.run("git status").await;
    assert_eq!(allowed["exit_code"], json!(0), "{allowed}");
    assert!(exec.manager.live_sessions().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_search_that_finds_nothing_is_a_result_and_a_failed_program_is_not() {
    let exec = Exec::new(Arc::new(FreshProcess));
    let cx = exec.cx(Caller::unattributed(None));
    let call = |args: Value| {
        let (exec, cx) = (&exec, &cx);
        async move { exec.exec.call_json(cx, args).await.expect("ran") }
    };
    let failure = Some(json!("process_exit_nonzero"));
    let outcome = |output: &cos_tools::ToolOutput| {
        output
            .notes
            .outcome
            .map(|outcome| serde_json::to_value(outcome).expect("wire name"))
    };
    let process = |output: &cos_tools::ToolOutput| output.notes.process.clone().expect("noted");
    let text = |output: &cos_tools::ToolOutput| match &output.result.content[0] {
        cos_tools::Content::Text { text } => text.clone(),
        other => panic!("{other:?}"),
    };

    let search = call(json!({ "cmd": "rg -n cos-exec-absent-needle ." })).await;
    let structured = search
        .result
        .structured_content
        .clone()
        .expect("structured");
    assert_eq!(structured["exit_code"], 1, "{structured}");
    assert_eq!(structured["expected_exit"], true, "{structured}");
    assert!(
        text(&search).contains("Note: Exit code 1 from `rg` is a result, not a failure"),
        "{}",
        text(&search)
    );
    assert_eq!(outcome(&search), None);
    let noted = process(&search);
    assert_eq!((noted.exit_code, noted.benign_exit), (Some(1), true));
    assert_eq!((noted.running, noted.session_id), (Some(false), None));

    let session = structured["completed_session_id"]
        .as_u64()
        .expect("completed");
    let reread = exec
        .stdin
        .call_json(&cx, json!({ "session_id": session }))
        .await
        .expect("reread");
    assert_eq!(outcome(&reread), None);
    assert!(process(&reread).benign_exit);

    let batch =
        call(json!({ "cmds": ["rg -n cos-exec-absent-needle .", "Write-Output ok"] })).await;
    assert_eq!(outcome(&batch), None);
    assert!(process(&batch).benign_exit);
    assert!(
        text(&batch).contains("Note: Command 1: Exit code 1 from `rg` is a result"),
        "{}",
        text(&batch)
    );

    let mixed = call(json!({ "cmds": ["cmd /c exit 3", "Write-Output ok"] })).await;
    assert_eq!(outcome(&mixed), failure);
    assert!(
        text(&mixed).contains(
            "Note: Batch: command 1 exited 3; the other command exited 0. The top-line exit code is the first non-zero one."
        ),
        "{}",
        text(&mixed)
    );

    let failed = call(json!({ "cmd": "cmd /c exit 1" })).await;
    assert_eq!(outcome(&failed), failure);
    let noted = process(&failed);
    assert_eq!((noted.exit_code, noted.benign_exit), (Some(1), false));
    assert!(!text(&failed).contains("is a result"));

    let running = call(json!({ "cmd": "Start-Sleep 5", "yield_time_ms": 250 })).await;
    let noted = process(&running);
    assert_eq!((noted.exit_code, noted.running), (None, Some(true)));
    assert!(noted.session_id.is_some());
    exec.manager.terminate_all().await;
}
