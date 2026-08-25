/**
 * The app's teardown sequence, as an ordered list of phases with individual deadlines.
 *
 * This lives outside `index.ts` for one reason: `index.ts` is the Electron entry point and
 * cannot be imported by a test without booting Electron, and the property that matters here
 * is precisely the one that only shows up when something goes wrong.
 *
 * **The process must always reach `app.quit()`.** `will-quit` calls `preventDefault()` and
 * then owns the decision to quit, and by that point the tray icon is already destroyed and
 * the window is gone. So a teardown task that never settles does not merely delay the exit —
 * it leaves an invisible main process running, still holding the single-instance lock, which
 * makes every later attempt to start Chat On Steroids do nothing at all. The user's only way
 * out is Task Manager. Every task below is individually bounded (the bridge force-closes
 * wedged sockets, the MCP endpoint forces its drain, tunnel teardown races a timer), but
 * "each piece is bounded" is not the same claim as "the sequence terminates", and it is the
 * sequence that decides whether the app can be started again.
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
  readonly warn: (message: string) => void;
  readonly error: (message: string) => void;
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
 * Runs every phase in order and always resolves.
 *
 * Failures and overruns are reported through `hooks` and never propagate: the caller's job
 * after this returns is to quit, and there is no outcome here that should stop it.
 */
export async function runShutdownSequence(
  phases: readonly ShutdownPhase[],
  hooks: ShutdownHooks
): Promise<void> {
  for (const phase of phases) {
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
  }
}
