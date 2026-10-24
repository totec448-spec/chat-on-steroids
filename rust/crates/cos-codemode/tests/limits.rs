//! Limits the corpus cannot show one case at a time: scripts running at once, a child that
//! outlives its script, and a wall-time stop that must interrupt JavaScript still computing.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use cos_codemode::{Invoke, LIMITS, Limits, NestedTool, Options, run};
use cos_tools::{BoxFuture, ToolResult};
use serde_json::Value;
use tokio::sync::{Mutex, Semaphore};

/// The tests count against the one process-wide limit on scripts at once.
static SERIAL: Mutex<()> = Mutex::const_new(());

struct NoTools;

impl Invoke for NoTools {
    fn invoke(&self, tool: String, _arguments: Value) -> BoxFuture<'static, ToolResult> {
        Box::pin(async move { panic!("{tool} was not expected to run") })
    }
}

fn texts(result: &ToolResult) -> String {
    serde_json::to_string(&result.content).expect("content serializes")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fifth_script_at_once_is_refused_and_a_finished_one_frees_its_place() {
    let _serial = SERIAL.lock().await;
    let waiting = Limits {
        wall: Duration::from_millis(400),
        ..LIMITS
    };
    let pending = "await new Promise(() => {})";
    let (a, b, c, d, fifth) = tokio::join!(
        run(pending, &[], &NoTools, &waiting, Options::default()),
        run(pending, &[], &NoTools, &waiting, Options::default()),
        run(pending, &[], &NoTools, &waiting, Options::default()),
        run(pending, &[], &NoTools, &waiting, Options::default()),
        async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            run("text(1)", &[], &NoTools, &LIMITS, Options::default()).await
        }
    );
    for held in [a, b, c, d] {
        assert!(
            texts(&held).contains("CODE_MODE_TIME_LIMIT"),
            "{}",
            texts(&held)
        );
    }
    assert_eq!(
        texts(&fifth),
        r#"[{"type":"text","text":"CODE_MODE_BUSY: too many code executions or unsettled nested calls."}]"#
    );
    let after = run("text(1)", &[], &NoTools, &LIMITS, Options::default()).await;
    assert_eq!(texts(&after), r#"[{"type":"text","text":"1"}]"#);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_wall_limit_interrupts_a_script_that_is_still_computing() {
    let _serial = SERIAL.lock().await;
    let limits = Limits {
        cpu: Duration::from_secs(30),
        wall: Duration::from_millis(200),
        ..LIMITS
    };
    let started = Instant::now();
    let result = run(
        "while (true) {}",
        &[],
        &NoTools,
        &limits,
        Options::default(),
    )
    .await;
    let elapsed = started.elapsed();
    assert!(
        texts(&result).contains("CODE_MODE_TIME_LIMIT"),
        "{}",
        texts(&result)
    );
    assert!(
        elapsed < Duration::from_secs(5),
        "the interpreter stopped at the wall limit, not the CPU budget ({elapsed:?})"
    );
}

/// A child that finishes only when the test opens its gate.
struct Held {
    gate: Arc<Semaphore>,
    finished: Arc<AtomicBool>,
}

impl Invoke for Held {
    fn invoke(&self, _tool: String, _arguments: Value) -> BoxFuture<'static, ToolResult> {
        let gate = self.gate.clone();
        let finished = self.finished.clone();
        Box::pin(async move {
            let _open = gate.acquire().await;
            finished.store(true, Ordering::SeqCst);
            ToolResult::text("late")
        })
    }
}

/// TypeScript answers before an unawaited child finishes and lets the child run to its end.
/// Until it does, the child holds its script's place among the scripts allowed at once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_script_answers_before_its_unawaited_child_which_still_finishes() {
    let _serial = SERIAL.lock().await;
    let held = Held {
        gate: Arc::new(Semaphore::new(0)),
        finished: Arc::default(),
    };
    let tools = [NestedTool {
        name: "slow".to_owned(),
        description: String::new(),
    }];
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        run(
            r#"tools.slow({}); text("done")"#,
            &tools,
            &held,
            &LIMITS,
            Options::default(),
        ),
    )
    .await
    .expect("the script answers while its child still runs");
    assert!(result.is_error);
    assert_eq!(
        texts(&result),
        r#"[{"type":"text","text":"CODE_MODE_UNAWAITED_CALLS: dispatched tool calls are still running and remain recorded. Side effects were not cancelled."},{"type":"text","text":"done"}]"#
    );
    assert!(!held.finished.load(Ordering::SeqCst));

    let one_at_once = Limits {
        active_runs: 1,
        ..LIMITS
    };
    let busy = run("text(1)", &[], &NoTools, &one_at_once, Options::default()).await;
    assert!(texts(&busy).contains("CODE_MODE_BUSY"), "{}", texts(&busy));

    held.gate.add_permits(1);
    let freed = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let after = run("text(1)", &[], &NoTools, &one_at_once, Options::default()).await;
            if !texts(&after).contains("CODE_MODE_BUSY") {
                return after;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the place is freed once the child settles");
    assert!(
        held.finished.load(Ordering::SeqCst),
        "the child was not cancelled"
    );
    assert_eq!(texts(&freed), r#"[{"type":"text","text":"1"}]"#);
}

/// A child that panics is a rejected call: the script sees `CODE_MODE_TOOL_ERROR` and goes on.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_child_that_panics_reaches_the_script_as_a_tool_error() {
    let _serial = SERIAL.lock().await;
    let tools = [NestedTool {
        name: "broken".to_owned(),
        description: String::new(),
    }];
    let result = run(
        "const r = await tools.broken({}); text(r.content[0].text);",
        &tools,
        &NoTools,
        &LIMITS,
        Options::default(),
    )
    .await;
    assert_eq!(
        texts(&result),
        r#"[{"type":"text","text":"CODE_MODE_TOOL_ERROR"}]"#
    );
}
