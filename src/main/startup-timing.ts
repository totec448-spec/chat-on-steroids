/**
 * How long the app takes to start, step by step, so a slow start can be seen and compared.
 *
 * Each step is stamped once, in milliseconds since the process started. When the app window has
 * its state ("app window ready") the app is usable, and one log line says how long each step took.
 * The last ten starts are kept, and the Diagnostics report shows this start beside the earlier ones.
 * Steps that come later (the browser extension, the ChatGPT tunnel) are added as they arrive.
 * Numbers only: nothing here names a chat, a folder or a person.
 */

export const STARTUP_STEPS = ['ready', 'config', 'restored', 'window', 'renderer', 'tunnel', 'extension'] as const;
export type StartupStep = typeof STARTUP_STEPS[number];
export interface StartupRun { at: number; version: string; steps: Partial<Record<StartupStep, number>> }

export const STARTUP_STATE = 'startup-timing';
const MAX_RUNS = 10;
/** The step that makes the app usable; the ones after it are reported apart. */
const USABLE: StartupStep = 'renderer';
const LABELS: Record<StartupStep, string> = {
  ready: 'Electron ready', config: 'settings', restored: 'chats restored', window: 'window loaded',
  renderer: 'app window ready', tunnel: 'ChatGPT tunnel', extension: 'browser extension'
};

const seconds = (ms: number): string => `${(ms / 1000).toFixed(2)} s`;

function validRun(value: unknown): StartupRun | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.at !== 'number' || typeof row.version !== 'string' || !row.steps || typeof row.steps !== 'object') return null;
  const steps: StartupRun['steps'] = {};
  for (const step of STARTUP_STEPS) {
    const ms = (row.steps as Record<string, unknown>)[step];
    if (ms === undefined) continue;
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
    steps[step] = ms;
  }
  // Saved only from "usable" on (see mark), so a run without that step is damage, not a start.
  if (steps[USABLE] === undefined) return null;
  return { at: row.at, version: row.version.slice(0, 40), steps };
}

export function createStartupTiming(deps: {
  /** Milliseconds since the process started. */
  clock: () => number;
  now: () => number;
  version: string;
  log: (line: string) => void;
  save: (runs: StartupRun[]) => void;
}) {
  const run: StartupRun = { at: deps.now(), version: deps.version, steps: {} };
  let earlier: StartupRun[] = [];

  // In the order they happened, which differs between starts (the window often loads after the app is usable).
  const stepsText = (keep: (ms: number) => boolean): string => STARTUP_STEPS
    .filter(step => run.steps[step] !== undefined && keep(run.steps[step]!))
    .sort((a, b) => run.steps[a]! - run.steps[b]!)
    .map(step => `${LABELS[step]} ${seconds(run.steps[step]!)}`).join(', ');
  const usableAt = (): number => run.steps[USABLE] ?? Infinity;
  const before = (ms: number): boolean => ms <= usableAt();
  const after = (ms: number): boolean => ms > usableAt();

  return {
    /** The starts saved by earlier runs; anything damaged is left out. */
    restore(saved: unknown): void {
      earlier = Array.isArray(saved) ? saved.map(validRun).filter((row): row is StartupRun => row !== null).slice(-(MAX_RUNS - 1)) : [];
    },
    mark(step: StartupStep): void {
      if (run.steps[step] !== undefined) return;
      run.steps[step] = Math.round(deps.clock());
      if (run.steps[USABLE] === undefined) return;
      if (step === USABLE) deps.log(`startup: usable after ${seconds(run.steps[USABLE]!)} (${stepsText(before)})`);
      deps.save([...earlier, run]);
    },
    current(): StartupRun { return run; },
    /** For the Diagnostics report: this start, then the earlier ones it can be compared with. */
    lines(): string[] {
      const usable = run.steps[USABLE];
      const later = stepsText(after);
      const out = [usable === undefined
        ? `This start: not usable yet (${stepsText(before)})`
        : `This start: usable after ${seconds(usable)} (${stepsText(before)})${later ? `; ${later}` : ''}`];
      const times = earlier.map(row => row.steps[USABLE]).filter((ms): ms is number => ms !== undefined).sort((a, b) => a - b);
      if (times.length) {
        const middle = times[Math.floor(times.length / 2)]!;
        out.push(`Earlier starts (${times.length}): usable after ${seconds(middle)} typically, ${seconds(times[0]!)} at the fastest, ${seconds(times.at(-1)!)} at the slowest`);
      }
      return out;
    }
  };
}

let active: ReturnType<typeof createStartupTiming> | null = null;
/** The app's one timing, set up once at startup; marks before that, and in tests, do nothing. */
export function installStartupTiming(timing: ReturnType<typeof createStartupTiming>): void { active = timing; }
export function markStartup(step: StartupStep): void { active?.mark(step); }
export function startupLines(): string[] { return active?.lines() ?? []; }
