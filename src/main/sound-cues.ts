/**
 * #1802: a short sound when a chat needs you, something failed, or a chat finished while the
 * window is in the background. The window plays it (renderer/sound-cues.ts); this decides
 * whether. Off by default, quiet during the quiet hours (the one setting under Phone
 * notifications, even while those are off), and one sound per chat and kind in two minutes, so a
 * burst of events never turns into a burst of sounds. Every decision writes one log line, never
 * with the chat in it (the setting being off is said once).
 */

import { inQuietHours } from './phone-push.js';
import type { QuietHours } from '../shared/phone-push.js';
import type { SoundCue } from '../shared/sound-cues.js';
import type { Config } from '../shared/types.js';

export type SoundCueResult = 'played' | 'off' | 'at-window' | 'quiet-hours' | 'repeat' | 'no-window';

export interface SoundCueDeps {
  enabled(): boolean;
  /** Whether the app's window has the focus: a finished chat there is already in view. */
  focused(): boolean;
  /** The quiet hours (set under Phone notifications, kept even while those are off), or null. */
  quietHours(): QuietHours | null;
  now(): number;
  /** Hands the cue to the window; false when no window could receive it. */
  play(kind: SoundCue): boolean;
  log(line: string): void;
}

const REPEAT_MS = 2 * 60_000;

export function createSoundCues(deps: SoundCueDeps): (kind: SoundCue, sessionId?: string) => SoundCueResult {
  const lastPlayed = new Map<string, number>();
  const decide = (kind: SoundCue, sessionId?: string): SoundCueResult => {
    if (!deps.enabled()) return 'off';
    if (kind === 'finished' && deps.focused()) return 'at-window';
    const now = deps.now();
    if (inQuietHours(deps.quietHours(), new Date(now))) return 'quiet-hours';
    const key = `${kind}:${sessionId ?? ''}`;
    const last = lastPlayed.get(key);
    if (last !== undefined && now - last < REPEAT_MS) return 'repeat';
    // A cue no window received is not counted, so the next one plays once a window is there.
    if (!deps.play(kind)) return 'no-window';
    lastPlayed.set(key, now);
    for (const [entry, at] of lastPlayed) if (now - at >= REPEAT_MS) lastPlayed.delete(entry);
    return 'played';
  };
  // The setting being off is the normal case: said once, not for every event, until it is on again.
  let saidOff = false;
  return (kind, sessionId) => {
    const result = decide(kind, sessionId);
    if (result === 'off') {
      if (!saidOff) deps.log(`sound: ${kind} not played (off; sounds are off, later cues are not logged until they are on)`);
      saidOff = true;
      return result;
    }
    saidOff = false;
    deps.log(result === 'played' ? `sound: ${kind} played` : `sound: ${kind} not played (${result})`);
    return result;
  };
}

/** What a window's page is to the readiness below: something that says when it reloads or dies. */
export interface SoundPage { on(event: 'did-start-loading' | 'render-process-gone', run: () => void): unknown }

/**
 * Whether the window's page can play a sound: it says so once it listens (`sound:ready`), and a
 * reload or a crashed page has no listener until it says so again. A cue sent before that is lost,
 * so it is not counted as played and the next one plays (#1830).
 */
export function createSoundReadiness(): { mark(page: SoundPage): void; ready(page: SoundPage | null | undefined): boolean } {
  const ready = new WeakSet<SoundPage>(), watched = new WeakSet<SoundPage>();
  return {
    mark(page) {
      ready.add(page);
      // Once per page, however often it reloads.
      if (watched.has(page)) return;
      watched.add(page);
      page.on('did-start-loading', () => ready.delete(page));
      page.on('render-process-gone', () => ready.delete(page));
    },
    ready: page => !!page && ready.has(page)
  };
}

/** The quiet hours sounds follow: the one setting under Phone notifications, whether or not those are on. */
export function soundQuietHours(ui: Pick<Config['ui'], 'phonePush'>): QuietHours | null {
  return ui.phonePush?.quietHours ?? null;
}

let installed: ((kind: SoundCue, sessionId?: string) => SoundCueResult) | null = null;
export function installSoundCues(deps: SoundCueDeps): void { installed = createSoundCues(deps); }
/** Plays the cue when the setting and its rules allow; before installation nothing happens. */
export function soundCue(kind: SoundCue, sessionId?: string): SoundCueResult { return installed?.(kind, sessionId) ?? 'off'; }
