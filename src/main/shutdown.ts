/**
 * The app's teardown sequence, as an ordered list of phases with individual deadlines.
 *
 * This lives outside `index.ts` for one reason: `index.ts` is the Electron entry point and
 * cannot be imported by a test without booting Electron, and the property that matters here
 * is precisely the one that only shows up when something goes wrong.
 *
 * **The process must always exit.** `will-quit` calls `preventDefault()` and then owns the
 * decision to quit, and by that point the tray icon is already destroyed and the window is
 * gone. So a teardown task that never settles does not merely delay the exit — it leaves an
 * invisible main process running, still holding the single-instance lock, which makes every
 * later attempt to start Chat On Steroids do nothing at all. The user's only way out is Task
 * Manager. Every task below is individually bounded (the bridge force-closes wedged sockets,
 * the MCP endpoint forces its drain, tunnel teardown races a timer), but "each piece is
 * bounded" is not the same claim as "the sequence terminates", and it is the sequence that
 * decides whether the app can be started again. Ending the process is therefore part of this
 * sequence rather than something its caller is trusted to remember: `exit` runs after the last
 * phase whatever happened in the phases before it.
 *
 * Phases are ordered and strictly sequential: a phase's work is not created until the phase
 * is reached, so a later phase cannot start early by having built its promises up front.
 * Within a phase the tasks run concurrently and independently — one rejection must never
 * skip its siblings, which is why every phase settles rather than short-circuits.
 *
 * When a phase overruns its budget its tasks are *abandoned*, not aborted. They keep running
 * on their own; the process is about to exit and take them with it. What must not happen is
 * the sequence stopping there forever.
 */

export interface ShutdownPhase {
  /** Named in the log line if this phase overruns or one of its tasks rejects. */
  readonly name: string;
  /** How long this phase alone may take before the sequence gives up on it and moves on. */
  readonly budgetMs: number;
  /** Starts the phase's work. Called once, only when the phase is reached. */
  readonly run: () => Array<Promise<unknown>>;
}

export interface ShutdownHooks {
  /** Progress, so a teardown that stalls says where. Nothing else reports from here. */
  readonly info: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly error: (message: string) => void;
  /**
   * Ends the process. Runs once, after the last phase, whatever the phases did.
   *
   * In the app this is `app.exit(0)`, and it deliberately is not `app.quit()`. Measured on
   * Windows, in the promise continuation that finishes this sequence: `app.quit()` returns
   * having emitted nothing at all — not even `before-quit` — and the process stays up; the
   * identical call from the next macrotask emits `before-quit`, `will-quit`, `quit` and exits;
   * and `app.exit(0)` from that same continuation emits `quit` and exits. So the quit is
   * simply dropped from here, and leaning on that timing is how a fully drained teardown still
   * ended with the app sitting there with no window, no tray, and the single-instance lock
   * still held. `app.exit` unwinds the same shutdown path without the veto, so it is the one
   * that lands.
   */
  readonly exit: () => void;
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Resolves `true` if the deadline won, `false` if the work settled first. */
function raceDeadline(work: Promise<unknown>, budgetMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(true), Math.max(0, budgetMs));
    // A shutdown timer must never be the reason the event loop stays alive.
    timer.unref?.();
    void work.then(
      () => {
        clearTimeout(timer);
        resolve(false);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      }
    );
  });
}

/**
 * Runs every phase in order, then exits.
 *
 * Failures and overruns are reported through `hooks` and never propagate: what follows this
 * is the end of the process, and there is no outcome here that should stop it.
 */
export async function runShutdownSequence(
  phases: readonly ShutdownPhase[],
  hooks: ShutdownHooks
): Promise<void> {
  try {
    await runPhases(phases, hooks);
  } finally {
    // The one line the whole module exists for.
    hooks.exit();
  }
}

async function runPhases(phases: readonly ShutdownPhase[], hooks: ShutdownHooks): Promise<void> {
  for (const phase of phases) {
    hooks.info(`shutdown ${phase.name} starting`);
    let tasks: Array<Promise<unknown>>;
    try {
      tasks = phase.run();
    } catch (error) {
      // A phase that throws while merely starting its work has produced nothing to wait for.
      hooks.error(`shutdown ${phase.name} failed: ${describe(error)}`);
      continue;
    }
    const settled = Promise.allSettled(tasks);
    if (await raceDeadline(settled, phase.budgetMs)) {
      hooks.warn(`shutdown ${phase.name} did not finish within ${phase.budgetMs}ms; continuing to quit`);
      continue;
    }
    for (const result of await settled) {
      if (result.status === 'rejected') hooks.error(`shutdown ${phase.name} failed: ${describe(result.reason)}`);
    }
    hooks.info(`shutdown ${phase.name} done`);
  }
  hooks.info('shutdown sequence complete');
}
