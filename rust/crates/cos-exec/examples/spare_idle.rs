//! What the pre-started pool costs while it waits: the private working set, private bytes and
//! handle count of every waiting spare together, after the pool has sat idle.
//!
//!   cargo run --release -p cos-exec --example spare_idle -- [runs] [idle_seconds] [used]
//!
//! Each run starts a default pool and prestarts it as the Core does at start (one spare). With
//! `used` set to 1 it then makes one call, which grows the pool to its busy size. It leaves the
//! pool idle (within the quiet period), then reads the spares' counters by process id. Only
//! numbers are printed.

#[cfg(windows)]
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    use std::sync::Arc;
    use std::time::Duration;

    use cos_exec::{ExecDeps, ExecManager, PrestartedPowerShell};
    use cos_fs::{ApprovedRoot, RootKind, RootName, Roots};
    use cos_store::Platform;
    use cos_tools::{
        CallContext, Caller, Capability, CapabilitySet, FeatureSet, Grants, SurfaceId,
    };
    use serde_json::json;

    let args: Vec<String> = std::env::args().collect();
    let runs: usize = args.get(1).and_then(|n| n.parse().ok()).unwrap_or(5);
    let idle = Duration::from_secs(args.get(2).and_then(|n| n.parse().ok()).unwrap_or(30));
    let used = args.get(3).is_some_and(|flag| flag == "1");
    let grants = Arc::new(Grants {
        capabilities: CapabilitySet::EMPTY.with(Capability::Command),
        read_only: false,
        features: FeatureSet::default(),
        allow_unattributed: false,
        roots: Roots::new([ApprovedRoot {
            name: RootName::new("temp"),
            folder: std::env::temp_dir(),
            kind: RootKind::User,
        }]),
        platform: Platform::Windows,
    });
    let cx = CallContext::standalone(SurfaceId::Core, grants, Caller::unattributed(None));

    let mut working_set = Vec::new();
    let mut private_bytes = Vec::new();
    let mut handles = Vec::new();
    for run in 1..=runs {
        let manager = ExecManager::new(ExecDeps {
            launcher: Arc::new(PrestartedPowerShell::new()),
        });
        manager.prestart();
        if used {
            tokio::time::sleep(Duration::from_secs(2)).await;
            manager
                .tools()
                .remove(0)
                .call_json(
                    &cx,
                    json!({ "cmd": "Write-Output warm", "workdir": "/temp" }),
                )
                .await
                .expect("the call runs");
        }
        tokio::time::sleep(idle).await;
        let Some(sample) = spare_counters() else {
            println!("run {run}: no spares found");
            manager.terminate_all().await;
            continue;
        };
        println!(
            "run {run}, {} spares: private working set {} KiB, private bytes {} KiB, handles {} ({})",
            sample.spares,
            sample.working_set_private / 1024,
            sample.private_bytes / 1024,
            sample.handles,
            sample.processes.join(", ")
        );
        working_set.push(sample.working_set_private as f64 / 1024.0 / 1024.0);
        private_bytes.push(sample.private_bytes as f64 / 1024.0 / 1024.0);
        handles.push(sample.handles as f64);
        manager.terminate_all().await;
    }
    for (name, unit, samples) in [
        ("private working set", "MiB", &mut working_set),
        ("private bytes", "MiB", &mut private_bytes),
        ("handles", "", &mut handles),
    ] {
        if samples.is_empty() {
            continue;
        }
        samples.sort_by(f64::total_cmp);
        let n = samples.len();
        let median = if n % 2 == 1 {
            samples[n / 2]
        } else {
            (samples[n / 2 - 1] + samples[n / 2]) / 2.0
        };
        println!(
            "{name}: median {median:.1} {unit} (range {:.1} to {:.1}), {n} runs, {} s idle",
            samples[0],
            samples[n - 1],
            idle.as_secs()
        );
    }
}

#[cfg(windows)]
struct Sample {
    /// The waiting PowerShells.
    spares: usize,
    working_set_private: u64,
    private_bytes: u64,
    handles: u64,
    /// Each process counted: the spares and any they started (their console hosts).
    processes: Vec<String>,
}

/// The spares are this process's PowerShell children still waiting on their pipes; the querying
/// PowerShell excludes itself by `$PID`. Their descendants count toward their cost.
#[cfg(windows)]
fn spare_counters() -> Option<Sample> {
    let script = format!(
        r#"$all = Get-CimInstance Win32_Process
$spares = @($all | Where-Object {{ $_.ParentProcessId -eq {parent} -and $_.ProcessId -ne $PID -and $_.CommandLine -like '*WaitForConnection*' }} | ForEach-Object {{ $_.ProcessId }})
if ($spares.Count -eq 0) {{ exit 1 }}
$ids = $spares + @($all | Where-Object {{ $spares -contains $_.ParentProcessId }} | ForEach-Object {{ $_.ProcessId }})
$perf = Get-CimInstance Win32_PerfRawData_PerfProc_Process | Where-Object {{ $ids -contains [int]$_.IDProcess }}
$perf | ForEach-Object {{ "$($_.Name) $($_.WorkingSetPrivate) $($_.PrivateBytes) $($_.HandleCount)" }}"#,
        parent = std::process::id()
    );
    let out = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut sample = Sample {
        spares: 0,
        working_set_private: 0,
        private_bytes: 0,
        handles: 0,
        processes: Vec::new(),
    };
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let [name, ws, pb, h] = fields[..] else {
            continue;
        };
        let (Ok(ws), Ok(pb), Ok(h)) = (ws.parse::<u64>(), pb.parse::<u64>(), h.parse::<u64>())
        else {
            continue;
        };
        sample.spares += usize::from(name.starts_with("powershell"));
        sample.working_set_private += ws;
        sample.private_bytes += pb;
        sample.handles += h;
        sample
            .processes
            .push(format!("{name} {} KiB {h} handles", ws / 1024));
    }
    (!sample.processes.is_empty()).then_some(sample)
}

#[cfg(not(windows))]
fn main() {
    println!("The pre-started PowerShell is Windows only.");
}
