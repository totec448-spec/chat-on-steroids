//! The pre-started pool as the operating system sees it: which process ran a command, which
//! spares wait, and which processes are still alive after shutdown or after their owner is
//! killed, and how many wait as the pool grows, shrinks and follows the commands toggle.

#![cfg(windows)]

mod support;

use std::collections::BTreeSet;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cos_exec::{DEFAULT_QUIET, ExecDeps, ExecManager, PrestartedPowerShell};
use cos_fs::{ApprovedRoot, RootKind, RootName, Roots};
use cos_store::Platform;
use cos_tools::{
    CallContext, Caller, Capability, CapabilitySet, DynTool, FeatureSet, Grants, SurfaceId,
};
use serde_json::json;
use support::Project;

const SPARES: usize = 3;
/// Long enough for the test to watch the grown pool refill before it shrinks.
const QUIET: Duration = Duration::from_secs(10);
/// Set in the child process that owns a pool for `spares_die_with_a_killed_owner`.
const OWNER: &str = "COS_EXEC_POOL_OWNER";

struct Exec {
    manager: Arc<ExecManager>,
    exec: Arc<dyn DynTool>,
    cx: CallContext,
    _project: Project,
}

impl Exec {
    fn pool(quiet: Duration) -> Self {
        let manager = ExecManager::new(ExecDeps {
            launcher: Arc::new(PrestartedPowerShell::with_pool(SPARES, quiet)),
        });
        let exec = manager.tools().remove(0);
        let project = Project::new("pool");
        let grants = Grants {
            capabilities: CapabilitySet::EMPTY.with(Capability::Command),
            read_only: false,
            features: FeatureSet::default(),
            allow_unattributed: false,
            roots: Roots::new([ApprovedRoot {
                name: RootName::new("project"),
                folder: project.root.clone(),
                kind: RootKind::User,
            }]),
            platform: Platform::Windows,
        };
        let cx = CallContext::standalone(
            SurfaceId::Core,
            Arc::new(grants),
            Caller::unattributed(None),
        );
        Self {
            manager,
            exec,
            cx,
            _project: project,
        }
    }

    /// The process id of the PowerShell that ran the call.
    async fn pid_of_call(&self) -> u32 {
        let output = self
            .exec
            .call_json(&self.cx, json!({ "cmd": "$PID" }))
            .await
            .expect("the call runs");
        let structured = output.result.structured_content.expect("structured output");
        assert_eq!(structured["exit_code"], json!(0), "{structured}");
        structured["output"]
            .as_str()
            .and_then(|text| text.trim().parse().ok())
            .unwrap_or_else(|| panic!("a process id: {structured}"))
    }
}

/// The PowerShell children of `parent` still waiting for a command. The querying PowerShell
/// matches its own filter text, so it leaves itself out by `$PID`.
fn waiting_spares(parent: u32) -> BTreeSet<u32> {
    let script = format!(
        "Get-CimInstance Win32_Process -Filter 'ParentProcessId={parent}' | Where-Object {{ $_.ProcessId -ne $PID -and $_.CommandLine -like '*WaitForConnection*' }} | ForEach-Object {{ $_.ProcessId }}"
    );
    let out = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .expect("process query");
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| line.trim().parse().ok())
        .collect()
}

/// Waits until exactly `count` spares of `parent` wait, for as long as a loaded machine needs.
async fn until_waiting(parent: u32, count: usize) -> BTreeSet<u32> {
    let started = Instant::now();
    loop {
        let spares = waiting_spares(parent);
        if spares.len() == count {
            return spares;
        }
        assert!(
            started.elapsed() < Duration::from_secs(60),
            "{} spares of {parent} wait after 60 s, not {count}: {spares:?}",
            spares.len()
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

fn pid_alive(pid: u32) -> bool {
    let out = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .expect("tasklist");
    String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
}

async fn until_dead(pids: &BTreeSet<u32>) {
    let started = Instant::now();
    while let Some(pid) = pids.iter().find(|pid| pid_alive(**pid)) {
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "{pid} still alive after 30 s"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_pool_grows_on_use_shrinks_when_quiet_follows_the_toggle_and_ends_with_its_owner() {
    let me = std::process::id();
    let exec = Exec::pool(QUIET);
    exec.manager.prestart();
    let idle = until_waiting(me, 1).await;
    assert!(
        idle.contains(&exec.pid_of_call().await),
        "the first call ran in the one spare started before it"
    );

    let grown = until_waiting(me, SPARES).await;
    assert!(grown.is_disjoint(&idle), "the first call grew the pool");
    let mut served = BTreeSet::new();
    for _ in 0..SPARES {
        served.insert(exec.pid_of_call().await);
    }
    let last_call = Instant::now();
    assert_eq!(
        served, grown,
        "calls back to back each ran in a waiting spare"
    );
    let refilled = until_waiting(me, SPARES).await;
    assert!(
        refilled.is_disjoint(&grown),
        "the pool refilled with new processes: {refilled:?} after {grown:?}"
    );

    let kept = until_waiting(me, 1).await;
    assert!(
        last_call.elapsed() >= QUIET,
        "the pool shrank only after {QUIET:?} without a call"
    );
    assert!(
        kept.is_subset(&refilled),
        "the shrunk pool kept a waiting spare"
    );
    let ended: BTreeSet<u32> = refilled.difference(&kept).copied().collect();
    until_dead(&ended).await;

    exec.manager.release_prestarted();
    until_dead(&kept).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(
        waiting_spares(me).is_empty(),
        "commands off: no spare waits"
    );
    exec.manager.prestart();
    let on = until_waiting(me, 1).await;

    exec.manager.terminate_all().await;
    until_dead(&on).await;
    assert!(waiting_spares(me).is_empty(), "shutdown ended every spare");
    let after = exec.pid_of_call().await;
    assert!(
        !on.contains(&after),
        "a call after shutdown runs in a fresh process"
    );
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(
        waiting_spares(me).is_empty(),
        "nothing is started for later calls after shutdown"
    );

    let dropped = Exec::pool(QUIET);
    dropped.manager.prestart();
    let spares = until_waiting(me, 1).await;
    drop(dropped);
    until_dead(&spares).await;
}

/// Kills the owner process if the test fails before it does.
struct Owner(Child);

impl Drop for Owner {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn spares_die_with_a_killed_owner() {
    if std::env::var_os(OWNER).is_some() {
        let exec = Exec::pool(DEFAULT_QUIET);
        exec.manager.prestart();
        exec.pid_of_call().await;
        tokio::time::sleep(Duration::from_secs(120)).await;
        return;
    }
    let child = Command::new(std::env::current_exe().expect("test binary"))
        .args([
            "--exact",
            "spares_die_with_a_killed_owner",
            "--test-threads=1",
        ])
        .env(OWNER, "1")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("owner process");
    let mut owner = Owner(child);
    let spares = until_waiting(owner.0.id(), SPARES).await;

    owner.0.kill().expect("killed the owner");
    owner.0.wait().expect("owner ended");
    until_dead(&spares).await;
}
