/**
 * #1802: a short sound when a chat needs you, something failed, or a chat finished while the
 * window is in the background. The window plays it (renderer/sound-cues.ts); this decides
 * whether. Off by default, quiet during phone notifications' quiet hours, and one sound per chat
 * and kind in two minutes, so a burst of events never turns into a burst of sounds. Every decision
 * writes one log line, never with the chat in it.
 */

import { inQuietHours } from './phone-push.js';
import type { QuietHours } from '../shared/phone-push.js';
import type { SoundCue } from '../shared/sound-cues.js';

export type SoundCueResult = 'played' | 'off' | 'at-window' | 'quiet-hours' | 'repeat' | 'no-window';

export interface SoundCueDeps {
  enabled(): boolean;
  /** Whether the app's window has the focus: a finished chat there is already in view. */
  focused(): boolean;
  /** Phone notifications' quiet hours while those are on, else null. */
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
  return (kind, sessionId) => {
    const result = decide(kind, sessionId);
    // The setting being off is the normal case: it says nothing.
    if (result !== 'off') deps.log(result === 'played' ? `sound: ${kind} played` : `sound: ${kind} not played (${result})`);
    return result;
  };
}

let installed: ((kind: SoundCue, sessionId?: string) => SoundCueResult) | null = null;
export function installSoundCues(deps: SoundCueDeps): void { installed = createSoundCues(deps); }
/** Plays the cue when the setting and its rules allow; before installation nothing happens. */
export function soundCue(kind: SoundCue, sessionId?: string): SoundCueResult { return installed?.(kind, sessionId) ?? 'off'; }
