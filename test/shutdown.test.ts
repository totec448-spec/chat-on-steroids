/**
 * Quitting has to actually quit.
 *
 * `will-quit` calls `preventDefault()` and destroys the tray before teardown starts, so a
 * teardown task that never settles does not delay the exit — it strands an invisible main
 * process that still holds the single-instance lock, and every later attempt to start the app
 * silently does nothing. All three halves of that are covered here: the sequence itself must
 * always terminate, it must always end in the exit, and the terminal sessions it retires must
 * really die.
 */

import { describe, expect, it } from 'vitest';
import { runShutdownSequence, type ShutdownHooks } from '../src/main/shutdown.js';
import { UnifiedExecProcessManager, applyUnifiedExecEnv } from '../src/main/codex/unified-exec.js';
import { DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS } from '../src/main/codex/unified-exec-constants.js';
import { logInfo, logWarn, onLog } from '../src/main/logger.js';

interface Recorded extends ShutdownHooks {
  readonly progress: string[];
  readonly warnings: string[];
  readonly errors: string[];
  /** One entry per exit, holding whatever had last been logged when it ran. */
  readonly exits: string[];
}

function recordingHooks(overrides: Partial<ShutdownHooks> = {}): Recorded {
  const progress: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const exits: string[] = [];
  return {
    progress,
    warnings,
    errors,
    exits,
    info: (message) => void progress.push(message),
    warn: (message) => void warnings.push(message),
    error: (message) => void errors.push(message),
    exit: () => void exits.push(progress.at(-1) ?? 'nothing was logged'),
    ...overrides
  };
}

describe('shutdown sequence', () => {
  it('runs phases strictly in order and does not start a later phase early', async () => {
    const order: string[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hooks = recordingHooks();

    const sequence = runShutdownSequence(
      [
        {
          name: 'first',
          budgetMs: 5_000,
          run: () => {
            order.push('first:start');
            return [gate.then(() => void order.push('first:settled'))];
          }
        },
        {
          name: 'second',
          budgetMs: 5_000,
          run: () => {
            order.push('second:start');
            return [Promise.resolve()];
          }
        }
      ],
      hooks
    );

    // The second phase must not have been built yet: `run` is what creates the work, and
    // building every phase up front is exactly how a teardown ordering guarantee gets lost.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['first:start']);

    // And nothing has exited yet either: the process outlives the phases, not the reverse.
    expect(hooks.exits).toEqual([]);

    release();
    await sequence;
    expect(order).toEqual(['first:start', 'first:settled', 'second:start']);
    expect(hooks.warnings).toEqual([]);
    expect(hooks.errors).toEqual([]);
    expect(hooks.exits).toEqual(['shutdown sequence complete']);
  });

  it('abandons a phase that never settles instead of stranding the process', async () => {
    const hooks = recordingHooks();
    let laterPhaseRan = false;

    await runShutdownSequence(
      [
        // The real-world shape of this: a wedged localhost client, a tunnel child that never
        // reports exit, a durable writer waiting on a lock nobody releases.
        { name: 'wedged', budgetMs: 25, run: () => [new Promise<void>(() => {})] },
        {
          name: 'durable flush',
          budgetMs: 5_000,
          run: () => {
            laterPhaseRan = true;
            return [Promise.resolve()];
          }
        }
      ],
      hooks
    );

    expect(hooks.warnings).toHaveLength(1);
    expect(hooks.warnings[0]).toContain('shutdown wedged did not finish within 25ms');
    // Losing one phase must not cost the flushes that come after it, nor the exit.
    expect(laterPhaseRan).toBe(true);
    expect(hooks.exits).toEqual(['shutdown sequence complete']);
  });

  it('reports a rejected task without skipping its siblings or the phases after it', async () => {
    const hooks = recordingHooks();
    let siblingSettled = false;
    let laterPhaseRan = false;

    await runShutdownSequence(
      [
        {
          name: 'process cleanup',
          budgetMs: 5_000,
          run: () => [
            Promise.reject(new Error('taskkill refused')),
            new Promise<void>((resolve) =>
              setTimeout(() => {
                siblingSettled = true;
                resolve();
              }, 10)
            )
          ]
        },
        {
          name: 'durable flush',
          budgetMs: 5_000,
          run: () => {
            laterPhaseRan = true;
            return [Promise.resolve()];
          }
        }
      ],
      hooks
    );

    expect(siblingSettled).toBe(true);
    expect(laterPhaseRan).toBe(true);
    expect(hooks.errors).toEqual(['shutdown process cleanup failed: taskkill refused']);
    expect(hooks.warnings).toEqual([]);
  });

  it('survives a phase that throws while starting its own work', async () => {
    const hooks = recordingHooks();
    let laterPhaseRan = false;

    await runShutdownSequence(
      [
        {
          name: 'admission/drain',
          budgetMs: 5_000,
          run: () => {
            throw new Error('listener already gone');
          }
        },
        {
          name: 'durable flush',
          budgetMs: 5_000,
          run: () => {
            laterPhaseRan = true;
            return [Promise.resolve()];
          }
        }
      ],
      hooks
    );

    expect(hooks.errors).toEqual(['shutdown admission/drain failed: listener already gone']);
    expect(laterPhaseRan).toBe(true);
  });
});

describe('ending the process', () => {
  it('exits once with nothing to tear down', async () => {
    const hooks = recordingHooks();
    await runShutdownSequence([], hooks);
    expect(hooks.exits).toEqual(['shutdown sequence complete']);
  });

  it('exits even when reporting progress is what breaks', async () => {
    // Whatever goes wrong above, the last thing this sequence does is end the process.
    // Skipping it does not leave a running app the user can quit again — `will-quit` has
    // already prevented the default and destroyed the tray, so there is nothing left to
    // click and the single-instance lock is still held.
    const hooks = recordingHooks({
      info: () => {
        throw new Error('log sink is gone');
      }
    });
    let laterPhaseRan = false;

    await expect(
      runShutdownSequence(
        [
          { name: 'admission/drain', budgetMs: 5_000, run: () => [Promise.resolve()] },
          {
            name: 'durable flush',
            budgetMs: 5_000,
            run: () => {
              laterPhaseRan = true;
              return [Promise.resolve()];
            }
          }
        ],
        hooks
      )
    ).rejects.toThrow('log sink is gone');

    expect(laterPhaseRan).toBe(false);
    expect(hooks.exits).toHaveLength(1);
  });

  it('exits after the phases, never before them', async () => {
    const hooks = recordingHooks();
    const seen: string[] = [];

    await runShutdownSequence(
      [
        {
          name: 'durable flush',
          budgetMs: 5_000,
          run: () => [
            new Promise<void>((resolve) =>
              setTimeout(() => {
                seen.push('flushed');
                resolve();
              }, 20)
            )
          ]
        }
      ],
      { ...hooks, exit: () => void seen.push('exited') }
    );

    // A flush that is still writing when the process ends is a flush that did not happen.
    expect(seen).toEqual(['flushed', 'exited']);
  });
});

describe('logging during teardown', () => {
  it('does not let a log listener throw into the code that wrote the line', () => {
    // This is the failure that actually stranded the app. The renderer push listener reads
    // `webContents` off a BrowserWindow that Electron has already destroyed, which throws.
    // `onLog` listeners run synchronously on the writer's stack, so the throw landed inside
    // the MCP drain's force-close timer — before `closeAllConnections()` — and the drain that
    // was supposed to be forced simply never was. The app then held a half-closed tunnel
    // socket open forever with no window, no tray and the single-instance lock still taken.
    const seen: string[] = [];
    const dropThrower = onLog(() => {
      throw new Error('Object has been destroyed');
    });
    const dropWitness = onLog((entry) => void seen.push(entry.message));

    try {
      expect(() => logWarn('server drain timed out; forcing remaining connections closed')).not.toThrow();
      expect(() => logInfo('server stopped')).not.toThrow();
      // A broken listener must not cost the healthy ones their entries either.
      expect(seen).toEqual([
        'server drain timed out; forcing remaining connections closed',
        'server stopped'
      ]);
    } finally {
      dropThrower();
      dropWitness();
    }
  });
});

describe('terminal sessions at shutdown', () => {
  const truncationPolicy = { kind: 'tokens' as const, tokens: 10_000 };

  it('reports the real pid of a tty session, which ConPTY only supplies after connect', async () => {
    // node-pty's Windows backend returns a handle whose `pid` is 0 and fills it in when the
    // conout pipe is ready — long after the 150ms early-exit grace period. Snapshotting it at
    // spawn stored 0 forever, which both lied to `list_processes` and made `terminate()` skip
    // `terminateProcessTree` under its own `pid > 0` guard.
    const manager = new UnifiedExecProcessManager(DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS);
    const processId = manager.allocateProcessId();
    const started = manager.execCommand({
      command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      shellType: process.platform === 'win32' ? 'powershell' : 'bash',
      hookCommand: 'tty pid probe',
      processId,
      yieldTimeMs: 250,
      maxOutputTokens: undefined,
      truncationPolicy,
      cwd: process.cwd(),
      displayCwd: process.cwd(),
      env: applyUnifiedExecEnv(process.env),
      tty: true
    });

    try {
      await started;
      const deadline = Date.now() + 10_000;
      let entry = manager.listProcesses().find((item) => item.processId === processId);
      while ((!entry || entry.pid <= 0) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        entry = manager.listProcesses().find((item) => item.processId === processId);
      }
      expect(entry).toBeDefined();
      expect(entry?.tty).toBe(true);
      expect(entry?.pid).toBeGreaterThan(0);
    } finally {
      await manager.terminateAllProcesses();
    }
  });

  it('terminates every live session even when one termination rejects, and skips the exited ones', async () => {
    const manager = new UnifiedExecProcessManager(DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS);
    const terminated: string[] = [];
    const makeEntry = (name: string, exited: boolean, reject = false): unknown => ({
      processId: manager.allocateProcessId(),
      process: {
        hasExited: () => exited,
        terminate: async () => {
          terminated.push(name);
          if (reject) throw new Error(`${name} refused`);
        }
      }
    });

    const store = (manager as unknown as { processes: Map<number, unknown> }).processes;
    store.set(1, makeEntry('rejects', false, true));
    store.set(2, makeEntry('live', false));
    store.set(3, makeEntry('already-exited', true));

    await expect(manager.terminateAllProcesses()).resolves.toBeUndefined();

    // A rejection from the first entry used to abandon everything queued behind it, which at
    // shutdown means live shells and their console hosts outliving the app.
    expect(terminated).toContain('rejects');
    expect(terminated).toContain('live');
    expect(terminated).not.toContain('already-exited');
    expect(store.size).toBe(0);
  });
});
