import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createStartupHealthMonitor,
  FIRST_FRAME_TIMEOUT_MS,
  type StartupHealthReport
} from '../src/main/startup-health.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A controllable clock. The monitor only ever schedules one deadline at a time, but the harness
 * keeps a map so a stray second timer would show up as a test failure rather than silently work.
 */
function harness(timeoutMs: number = FIRST_FRAME_TIMEOUT_MS) {
  const timers = new Map<number, { at: number; callback: () => void }>();
  const info: string[] = [];
  const errors: string[] = [];
  const unhealthy: StartupHealthReport[] = [];
  let now = 0;
  let next = 1;

  const monitor = createStartupHealthMonitor({
    logInfo: (message) => info.push(message),
    logError: (message) => errors.push(message),
    onUnhealthy: (report) => unhealthy.push(report),
    setTimer: (callback, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimer: (handle) => { timers.delete(handle as number); }
  }, timeoutMs);

  return {
    monitor, info, errors, unhealthy, timers,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.callback(); }
      }
    }
  };
}

describe('startup health', () => {
  it('confirms a first frame and never reports a healthy start', () => {
    const h = harness();
    h.monitor.markLoaded();
    h.monitor.markVisible();
    h.monitor.markPainted();
    h.advance(FIRST_FRAME_TIMEOUT_MS * 10);

    expect(h.monitor.hasPainted()).toBe(true);
    expect(h.info).toContain('renderer first frame confirmed');
    expect(h.unhealthy).toEqual([]);
    expect(h.errors).toEqual([]);
    expect(h.timers.size).toBe(0);
  });

  it('reports a window that finished loading and became visible but never produced a frame', () => {
    const h = harness();
    h.monitor.markLoaded();
    h.monitor.markVisible();

    // The exact 2026-09-17 shape: the load succeeded, so nothing else in the app complains.
    expect(h.unhealthy).toEqual([]);
    h.advance(FIRST_FRAME_TIMEOUT_MS);

    expect(h.unhealthy).toHaveLength(1);
    expect(h.unhealthy[0]!.reason).toBe('renderer-never-painted');
    expect(h.errors[0]).toContain('startup health: renderer-never-painted');
    expect(h.monitor.hasPainted()).toBe(false);
  });

  it('does not arm until the window is both loaded and visible', () => {
    const loadedOnly = harness();
    loadedOnly.monitor.markLoaded();
    loadedOnly.advance(FIRST_FRAME_TIMEOUT_MS * 2);
    expect(loadedOnly.unhealthy).toEqual([]);

    const visibleOnly = harness();
    visibleOnly.monitor.markVisible();
    visibleOnly.advance(FIRST_FRAME_TIMEOUT_MS * 2);
    expect(visibleOnly.unhealthy).toEqual([]);
  });

  it('treats a hidden window as a paused deadline, not a failure, and re-arms when it returns', () => {
    const h = harness();
    h.monitor.markLoaded();
    h.monitor.markVisible();
    h.advance(FIRST_FRAME_TIMEOUT_MS / 2);

    // A background/tray launch genuinely stops receiving frames; reporting it would be a false alarm.
    h.monitor.markHidden();
    h.advance(FIRST_FRAME_TIMEOUT_MS * 3);
    expect(h.unhealthy).toEqual([]);
    expect(h.timers.size).toBe(0);

    h.monitor.markVisible();
    h.advance(FIRST_FRAME_TIMEOUT_MS);
    expect(h.unhealthy).toHaveLength(1);
    expect(h.unhealthy[0]!.reason).toBe('renderer-never-painted');
  });

  it('reports a failed load and a dead renderer immediately', () => {
    const failed = harness();
    failed.monitor.markLoadFailed(-6, 'ERR_FILE_NOT_FOUND');
    expect(failed.unhealthy).toHaveLength(1);
    expect(failed.unhealthy[0]!.reason).toBe('renderer-load-failed');
    expect(failed.unhealthy[0]!.detail).toContain('ERR_FILE_NOT_FOUND');

    const gone = harness();
    gone.monitor.markLoaded();
    gone.monitor.markVisible();
    gone.monitor.markRenderProcessGone('renderer process gone (crashed, exit 5)');
    expect(gone.unhealthy).toHaveLength(1);
    expect(gone.unhealthy[0]!.reason).toBe('renderer-process-gone');
    // The pending frame deadline must not fire a second dialog behind the first.
    gone.advance(FIRST_FRAME_TIMEOUT_MS * 2);
    expect(gone.unhealthy).toHaveLength(1);
  });

  it('reports at most once and stops reporting after a confirmed frame', () => {
    const h = harness();
    h.monitor.markLoaded();
    h.monitor.markVisible();
    h.advance(FIRST_FRAME_TIMEOUT_MS);
    h.monitor.markLoadFailed(-2, 'ERR_FAILED');
    h.monitor.markRenderProcessGone('crashed');
    expect(h.unhealthy).toHaveLength(1);

    const painted = harness();
    painted.monitor.markLoaded();
    painted.monitor.markVisible();
    painted.monitor.markPainted();
    painted.monitor.markPainted();
    expect(painted.info.filter((line) => line === 'renderer first frame confirmed')).toHaveLength(1);
  });

  it('cancels its deadline when disposed so a closed window cannot report later', () => {
    const h = harness();
    h.monitor.markLoaded();
    h.monitor.markVisible();
    h.monitor.dispose();
    h.advance(FIRST_FRAME_TIMEOUT_MS * 2);
    expect(h.unhealthy).toEqual([]);
  });
});

describe('startup health wiring', () => {
  const source = readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');

  it('asks the compositor for a frame rather than trusting did-finish-load alone', () => {
    expect(source).toContain("requestAnimationFrame(() => resolve(true))");
    expect(source).toContain('health.markLoaded()');
    expect(source).toContain('health.markPainted()');
  });

  it('records the process-loss events that left the blank window unexplained', () => {
    expect(source).toContain("app.on('child-process-gone'");
    expect(source).toContain("window.webContents.on('render-process-gone'");
    expect(source).toContain("window.webContents.on('preload-error'");
  });

  it('keeps the fail-safe outside the compositor and never disables GPU acceleration', () => {
    expect(source).toContain('dialog.showMessageBox');
    expect(source).not.toContain('disableHardwareAcceleration');
    expect(source).not.toContain('disable-gpu');
  });
});
