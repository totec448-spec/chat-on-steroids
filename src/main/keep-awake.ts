import type { SessionSummary } from '../shared/session.js';
import { sessionWorkingAt } from '../shared/session-activity.js';

/**
 * Keeps the computer awake while a chat is working (Codex: "Prevent sleep while running").
 *
 * A computer that sleeps in the middle of a long run stops it: the browser tab freezes and the
 * tunnel drops. Long Windows runs in #1086 needed sleep switched off by hand. The hold uses the
 * same notion of "working" as the sidebar and the pet, whose deadlines run out by themselves, so a
 * chat that died mid-turn cannot keep the computer awake. The screen may still turn off.
 */

/** Whether any chat is working now, and when the earliest one's activity runs out. */
export function keepAwakeState(sessions: readonly SessionSummary[], now: number): { awake: boolean; nextAt: number | null } {
  let nextAt: number | null = null;
  for (const session of sessions) {
    if (!sessionWorkingAt(session, now)) continue;
    const until = session.activityExpiresAt;
    if (typeof until === 'number') nextAt = nextAt === null ? until : Math.min(nextAt, until);
    else nextAt ??= now + 60_000;
  }
  return { awake: nextAt !== null, nextAt };
}

/** `screen` also keeps the display on: some Windows laptops (Modern Standby) sleep once it turns off. */
export type KeepAwakeKind = 'computer' | 'screen';
export interface SleepBlocker {
  start(kind: KeepAwakeKind): number;
  stop(id: number): void;
}

export function createKeepAwake(options: { sessions: () => Promise<readonly SessionSummary[]>; enabled: () => boolean; screen?: () => boolean; blocker: SleepBlocker }) {
  let hold: number | null = null;
  let holdKind: KeepAwakeKind | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let disposed = false;
  const release = () => { if (hold !== null) { options.blocker.stop(hold); hold = null; holdKind = null; } };
  const once = async (): Promise<void> => {
    if (timer) { clearTimeout(timer); timer = null; }
    const { awake, nextAt } = options.enabled() ? keepAwakeState(await options.sessions(), Date.now()) : { awake: false, nextAt: null };
    if (disposed) return;
    const kind: KeepAwakeKind = options.screen?.() === true ? 'screen' : 'computer';
    if (awake && hold !== null && holdKind !== kind) release();
    if (awake && hold === null) { hold = options.blocker.start(kind); holdKind = kind; }
    else if (!awake) release();
    if (nextAt !== null) {
      timer = setTimeout(() => { void refresh(); }, Math.max(1_000, nextAt - Date.now() + 100));
      timer.unref?.();
    }
  };
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (running) { again = true; return running; }
    running = once().catch(() => undefined).finally(() => {
      running = null;
      if (again) { again = false; void refresh(); }
    });
    return running;
  };
  return {
    refresh,
    dispose(): void {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      release();
    }
  };
}

let installed: ReturnType<typeof createKeepAwake> | null = null;
/** The app's one instance, so a settings change applies at once. */
export function installKeepAwake(instance: ReturnType<typeof createKeepAwake>): void { installed = instance; }
export function refreshKeepAwake(): void { void installed?.refresh(); }
