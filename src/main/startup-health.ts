/**
 * Startup health: telling "the UI came up" apart from "the window loaded".
 *
 * On 2026-09-17 a freshly installed build came up as a blank window. Every signal the app had
 * said it was fine: `did-finish-load` fired and the log recorded `window loaded` at 11:20:47Z,
 * there was not one `did-fail-load` in either log file, no renderer console error and no crash
 * dump. The renderer had genuinely loaded — nothing was ever presented. The only reason the
 * episode was explained at all is that a human looked at the screen.
 *
 * `did-finish-load` means the document finished loading. It says nothing about whether a frame
 * reached the screen, so on its own it is an actively misleading success signal: the one state
 * we most need to detect is the one where it still fires. This module adds the missing second
 * question — did the compositor ever produce a frame — and makes the answer explicit in the log
 * either way, so the next occurrence is diagnosable from evidence instead of from memory.
 *
 * It deliberately does not decide *why* a frame never arrived, and nothing here disables GPU
 * acceleration. The 2026-09-17 cache-clearing recovery is confounded by the restart that came
 * with it, so treating it as a proven cause would be inventing evidence. What this does is
 * record the failure and put something in front of the user that is drawn by the OS rather than
 * by the compositor that just failed them.
 *
 * Pure and dependency-injected so the state machine is unit-testable without Electron.
 */

export type StartupHealthFailure =
  /** Navigation itself failed; `did-fail-load` reported a code. */
  | 'renderer-load-failed'
  /** The renderer process died. */
  | 'renderer-process-gone'
  /** The document loaded and the window was visible, but no frame was ever produced. */
  | 'renderer-never-painted';

export interface StartupHealthReport {
  reason: StartupHealthFailure;
  detail: string;
}

export interface StartupHealthHooks {
  logInfo(message: string): void;
  logError(message: string): void;
  /**
   * The visible fail-safe. A blank window is by definition one the compositor is not drawing,
   * so this must not be an in-page overlay — the renderer cannot paint an apology for not
   * painting. Callers pass something the OS draws itself.
   */
  onUnhealthy(report: StartupHealthReport): void;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface StartupHealthMonitor {
  markLoaded(): void;
  markLoadFailed(code: number, description: string): void;
  markVisible(): void;
  markHidden(): void;
  markPainted(): void;
  markRenderProcessGone(detail: string): void;
  /** Whether a first frame has been confirmed. Exposed for acceptance tooling and tests. */
  hasPainted(): boolean;
  dispose(): void;
}

/**
 * Generous on purpose. A cold first run on a slow disk can take seconds to reach its first
 * frame, and a false alarm that interrupts a working launch would be worse than the silence
 * this replaces. We are catching "never", not "slow".
 */
export const FIRST_FRAME_TIMEOUT_MS = 12_000;

export function createStartupHealthMonitor(
  hooks: StartupHealthHooks,
  firstFrameTimeoutMs: number = FIRST_FRAME_TIMEOUT_MS
): StartupHealthMonitor {
  let loaded = false;
  let visible = false;
  let painted = false;
  let reported = false;
  let timer: unknown = null;

  function clear(): void {
    if (timer !== null) {
      hooks.clearTimer(timer);
      timer = null;
    }
  }

  function report(reason: StartupHealthFailure, detail: string): void {
    // One report per window lifetime. A renderer that dies after a failed paint would
    // otherwise queue a second dialog behind the first one the user is already reading.
    if (reported) return;
    reported = true;
    clear();
    hooks.logError(`startup health: ${reason}: ${detail}`);
    hooks.onUnhealthy({ reason, detail });
  }

  /**
   * Only arm once the window is both loaded and actually on screen. `requestAnimationFrame`
   * is driven by the compositor, and a window that is hidden or minimized to tray legitimately
   * stops receiving frames — arming then would report a healthy background launch as broken.
   */
  function arm(): void {
    if (painted || reported || !loaded || !visible || timer !== null) return;
    timer = hooks.setTimer(() => {
      timer = null;
      report(
        'renderer-never-painted',
        `the renderer reported a finished load and the window is visible, but no frame was produced within ${firstFrameTimeoutMs} ms`
      );
    }, firstFrameTimeoutMs);
  }

  return {
    markLoaded(): void {
      loaded = true;
      arm();
    },
    markLoadFailed(code: number, description: string): void {
      report('renderer-load-failed', `window failed to load (${code}): ${description}`);
    },
    markVisible(): void {
      visible = true;
      arm();
    },
    markHidden(): void {
      // Not a failure, and not permanent: cancel the deadline and re-arm when it returns.
      visible = false;
      clear();
    },
    markPainted(): void {
      if (painted) return;
      painted = true;
      clear();
      // The counterpart to `window loaded`. Between the two, a blank window is now visible
      // in the log as a load with no frame after it, instead of looking like a clean start.
      hooks.logInfo('renderer first frame confirmed');
    },
    markRenderProcessGone(detail: string): void {
      report('renderer-process-gone', detail);
    },
    hasPainted(): boolean {
      return painted;
    },
    dispose(): void {
      clear();
    }
  };
}
