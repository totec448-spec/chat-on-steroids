//! Times `exec_command` through the real tool, the way the Electron baseline timed it over MCP
//! (`echo bench-ok` and `rg -n quartz-lantern .`), minus HTTP.
//!
//!   cargo run --release -p cos-exec --example exec_bench -- spaced [calls] [gap_ms] [spares]
//!   cargo run --release -p cos-exec --example exec_bench -- burst [calls] [spares]
//!   cargo run --release -p cos-exec --example exec_bench -- first [runs] [delay_ms] [spares]
//!   cargo run --release -p cos-exec --example exec_bench -- regrow [runs] [spares]
//!
//! `spaced` alternates a fresh process and the pre-started pool call by call, with `gap_ms`
//! between calls, so warm-up and drift favour neither. `burst` makes every call of a workload
//! back to back with no gap, pool first, then fresh; each workload starts with a full pool. It
//! also prints the median of the first `spares` calls (served by spares that were ready) and of
//! the rest (served as fast as the pool refills). `first` starts a new pool, waits `delay_ms`,
//! and times the first call, which is what the first call after Core start sees: the pool holds
//! one spare until a call. `regrow` times three calls back to back on a pool of one (as at start
//! or after the quiet period), then three more once the pool has grown, which is what shrinking
//! costs the next burst.
//!
//! Every answer is checked for its output and exit code 0; a failure is counted, not timed.

use std::sync::Arc;
use std::time::{Duration, Instant};

use cos_exec::{
    DEFAULT_QUIET, DEFAULT_SPARES, ExecDeps, ExecManager, FreshProcess, Launcher,
    PrestartedPowerShell,
};
use cos_fs::{ApprovedRoot, RootKind, RootName, Roots};
use cos_store::Platform;
use cos_tools::{
    CallContext, Caller, Capability, CapabilitySet, DynTool, FeatureSet, Grants, SurfaceId,
};
use serde_json::json;

const WORKLOADS: [(&str, &str, &str); 2] = [
    ("echo", "echo bench-ok", "bench-ok"),
    ("rg", "rg -n quartz-lantern .", "quartz-lantern"),
];
/// Enough for a whole pool to start, even on a loaded machine.
const FILL: Duration = Duration::from_secs(4);

fn median(samples: &[f64]) -> f64 {
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    let n = sorted.len();
    if n == 0 {
        return f64::NAN;
    }
    if n % 2 == 1 {
        sorted[n / 2]
    } else {
        (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
    }
}

/// The nearest-rank `p`th percentile.
fn percentile(samples: &[f64], p: f64) -> f64 {
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    sorted
        .get(rank.saturating_sub(1))
        .copied()
        .unwrap_or(f64::NAN)
}

/// Median and range, plus mean and p90: back to back, a pool serves most calls at once and
/// makes a few wait, so the median alone hides the waits the mean carries.
fn summary(samples: &[f64], failed: usize) -> String {
    let low = samples.iter().copied().fold(f64::INFINITY, f64::min);
    let high = samples.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let mean = samples.iter().sum::<f64>() / samples.len() as f64;
    format!(
        "n={:<3} median {:>6.1} ms  range {low:>6.1}-{high:>6.1}  mean {mean:>6.1}  p90 {:>6.1}  failed {failed}",
        samples.len(),
        median(samples),
        percentile(samples, 90.0)
    )
}

struct Side {
    name: &'static str,
    tool: Arc<dyn DynTool>,
    manager: Arc<ExecManager>,
}

impl Side {
    fn new(name: &'static str, launcher: Arc<dyn Launcher>) -> Self {
        let manager = ExecManager::new(ExecDeps { launcher });
        manager.prestart();
        let tool = manager.tools().remove(0);
        Self {
            name,
            tool,
            manager,
        }
    }

    fn pool(spares: usize) -> Self {
        Self::new(
            "prestarted",
            Arc::new(PrestartedPowerShell::with_pool(spares, DEFAULT_QUIET)),
        )
    }

    fn fresh() -> Self {
        Self::new("fresh", Arc::new(FreshProcess))
    }

    async fn call(&self, cx: &CallContext, cmd: &str, expect: &str) -> Option<f64> {
        let started = Instant::now();
        let output = self
            .tool
            .call_json(cx, json!({ "cmd": cmd, "workdir": "/project" }))
            .await
            .ok()?;
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        let structured = output.result.structured_content?;
        let ok = structured["exit_code"] == json!(0)
            && structured["output"]
                .as_str()
                .is_some_and(|text| text.contains(expect))
            && structured.get("session_id").is_none();
        ok.then_some(elapsed)
    }
}

fn arg<T: std::str::FromStr>(args: &[String], index: usize, default: T) -> T {
    args.get(index)
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map_or("spaced", String::as_str).to_owned();

    let project = std::env::temp_dir().join(format!("cos-exec-bench-{}", std::process::id()));
    std::fs::create_dir_all(project.join("src")).expect("bench project");
    std::fs::write(
        project.join("src/notes.md"),
        "The needle phrase is quartz-lantern.\n",
    )
    .expect("bench file");
    let grants = Arc::new(Grants {
        capabilities: CapabilitySet::EMPTY.with(Capability::Command),
        read_only: false,
        features: FeatureSet::default(),
        allow_unattributed: false,
        roots: Roots::new([ApprovedRoot {
            name: RootName::new("project"),
            folder: project.clone(),
            kind: RootKind::User,
        }]),
        platform: Platform::Windows,
    });
    let cx = CallContext::standalone(SurfaceId::Core, grants, Caller::unattributed(None));

    match mode.as_str() {
        "burst" => burst(&cx, arg(&args, 2, 50), arg(&args, 3, DEFAULT_SPARES)).await,
        "regrow" => regrow(&cx, arg(&args, 2, 10), arg(&args, 3, DEFAULT_SPARES)).await,
        "first" => {
            first(
                &cx,
                arg(&args, 2, 10),
                Duration::from_millis(arg(&args, 3, 1000)),
                arg(&args, 4, DEFAULT_SPARES),
            )
            .await;
        }
        _ => {
            spaced(
                &cx,
                arg(&args, 2, 30),
                Duration::from_millis(arg(&args, 3, 1500)),
                arg(&args, 4, DEFAULT_SPARES),
            )
            .await;
        }
    }
    let _ = std::fs::remove_dir_all(&project);
}

async fn spaced(cx: &CallContext, calls: usize, gap: Duration, spares: usize) {
    let sides = [Side::fresh(), Side::pool(spares)];
    tokio::time::sleep(FILL).await;
    for (_, cmd, expect) in WORKLOADS {
        for _ in 0..5 {
            for side in &sides {
                let _ = side.call(cx, cmd, expect).await;
                tokio::time::sleep(gap).await;
            }
        }
    }
    println!(
        "spaced: {calls} calls per side and workload, gap {} ms, {spares} spares",
        gap.as_millis()
    );
    for (label, cmd, expect) in WORKLOADS {
        let mut samples: Vec<Vec<f64>> = vec![Vec::new(); sides.len()];
        let mut failures = vec![0usize; sides.len()];
        for _ in 0..calls {
            for (index, side) in sides.iter().enumerate() {
                match side.call(cx, cmd, expect).await {
                    Some(ms) => samples[index].push(ms),
                    None => failures[index] += 1,
                }
                tokio::time::sleep(gap).await;
            }
        }
        for (index, side) in sides.iter().enumerate() {
            println!(
                "{label:<5} {:<11} {}",
                side.name,
                summary(&samples[index], failures[index])
            );
        }
    }
    for side in &sides {
        side.manager.terminate_all().await;
    }
}

async fn burst(cx: &CallContext, calls: usize, spares: usize) {
    println!("burst: {calls} calls back to back per side and workload, {spares} spares");
    let pool = Side::pool(spares);
    let fresh = Side::fresh();
    for (label, cmd, expect) in WORKLOADS {
        for side in [&pool, &fresh] {
            // Warm the side's code paths, then give the pool time to fill again.
            let _ = side.call(cx, cmd, expect).await;
            tokio::time::sleep(FILL).await;
            let mut samples = Vec::new();
            let mut failed = 0;
            let started = Instant::now();
            for _ in 0..calls {
                match side.call(cx, cmd, expect).await {
                    Some(ms) => samples.push(ms),
                    None => failed += 1,
                }
            }
            let total = started.elapsed().as_secs_f64();
            println!(
                "{label:<5} {:<11} {}  {:.1} calls/s",
                side.name,
                summary(&samples, failed),
                calls as f64 / total
            );
            if side.name == "prestarted" && samples.len() > spares {
                let (ready, refilled) = samples.split_at(spares);
                println!(
                    "      first {spares} (ready spares) median {:.1} ms, rest median {:.1} ms",
                    median(ready),
                    median(refilled)
                );
            }
        }
    }
    pool.manager.terminate_all().await;
    fresh.manager.terminate_all().await;
}

async fn first(cx: &CallContext, runs: usize, delay: Duration, spares: usize) {
    println!(
        "first: {runs} new pools, first call {} ms after prestart, {spares} spares",
        delay.as_millis()
    );
    let (label, cmd, expect) = WORKLOADS[0];
    let mut samples = Vec::new();
    let mut failed = 0;
    for _ in 0..runs {
        let side = Side::pool(spares);
        tokio::time::sleep(delay).await;
        match side.call(cx, cmd, expect).await {
            Some(ms) => samples.push(ms),
            None => failed += 1,
        }
        side.manager.terminate_all().await;
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    println!(
        "{label:<5} {:<11} {}",
        "prestarted",
        summary(&samples, failed)
    );
}

async fn regrow(cx: &CallContext, runs: usize, spares: usize) {
    println!("regrow: {runs} new pools, three calls back to back idle then grown, {spares} spares");
    let (label, cmd, expect) = WORKLOADS[0];
    let mut idle: Vec<Vec<f64>> = vec![Vec::new(); 3];
    let mut grown: Vec<Vec<f64>> = vec![Vec::new(); 3];
    let mut failed = 0;
    for _ in 0..runs {
        let side = Side::pool(spares);
        for samples in [&mut idle, &mut grown] {
            tokio::time::sleep(FILL).await;
            for position in samples.iter_mut() {
                match side.call(cx, cmd, expect).await {
                    Some(ms) => position.push(ms),
                    None => failed += 1,
                }
            }
        }
        side.manager.terminate_all().await;
    }
    for (name, samples) in [("idle pool", &idle), ("grown pool", &grown)] {
        for (index, position) in samples.iter().enumerate() {
            println!(
                "{label:<5} {name:<10} call {} {}",
                index + 1,
                summary(position, 0)
            );
        }
    }
    println!("failed {failed}");
}
