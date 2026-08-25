/**
 * Process-lifetime maintenance for recorded-session retention.
 *
 * Retention governs files already on disk, not whether new recording is enabled. The app can
 * stay in the tray for days, so a startup-only prune lets expired history live forever until
 * the next restart. A coarse six-hour sweep bounds that drift without turning filesystem
 * maintenance into another hot poll, and every sweep reads the current configured window.
 */

export const SESSION_RETENTION_SWEEP_MS = 6 * 60 * 60 * 1000;

interface SessionRetentionOptions {
  retainDays: () => number;
  prune: (retainDays: number) => Promise<number>;
  onRemoved?: (removed: number) => void;
  onError?: (error: Error) => void;
  intervalMs?: number;
}

/** Starts one immediate prune plus coarse recurring maintenance. Returns its stop hook. */
export function startSessionRetentionMaintenance(options: SessionRetentionOptions): () => void {
  const intervalMs = options.intervalMs ?? SESSION_RETENTION_SWEEP_MS;
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const sweep = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;

    const run = Promise.resolve()
      .then(() => options.prune(options.retainDays()))
      .then((removed) => {
        if (removed > 0) options.onRemoved?.(removed);
      })
      .catch((error: unknown) => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      });
    const tracked = run.finally(() => {
      if (inFlight === tracked) inFlight = null;
    });
    inFlight = tracked;
    return tracked;
  };

  // Stored history is governed by retention even when recording was disabled before launch.
  void sweep();
  const timer = setInterval(() => void sweep(), intervalMs);
  timer.unref?.();

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}
