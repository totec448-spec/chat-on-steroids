/**
 * Asking before a desktop step takes the real mouse or keyboard (#1804, Haz's review).
 *
 * Off (the default) never asks. "Ask while I'm using the computer" asks when the person's own
 * input is under 30 s old. "Always ask" asks whenever the chat holds no grant. Go ahead grants
 * that chat 2 minutes of steps, which the person's next own input ends early. The app's own steps
 * reset the system's idle time too, so input counts as the person's only when it came after the
 * app's last step ended. A system that cannot say when it was last used asks: someone who turned
 * this on is better asked once too often than taken over.
 */
import { contrastRatio, effectivePalette, paletteTokens, type AppearanceSettings, type AppearanceTheme } from './appearance.js';

export type DesktopAskMode = 'off' | 'active' | 'always';

/** The question while it waits, as the app's own window shows it too (keyboard and screen readers). */
export interface DesktopAskPending { id: string; title: string; step: string; chat: string }
export const DESKTOP_ASK_MODES: readonly DesktopAskMode[] = ['off', 'active', 'always'];

/** Input this recent means the person is at the computer. */
export const ASK_ACTIVE_MS = 30_000;
/** How long Go ahead lets one chat's steps run without asking again, at most. */
export const ASK_GRANT_MS = 120_000;
/** How long a question waits for an answer before the step is refused. */
export const ASK_ANSWER_MS = 60_000;
/**
 * The system's idle time is counted in whole seconds, so the last input it implies can be up to a
 * second earlier than it was. Input within that second after the app's step is the step's own.
 */
const IDLE_RESOLUTION_MS = 1_000;

export interface DesktopAskInput {
  mode: DesktopAskMode;
  now: number;
  /** When the system last saw input from anyone, or null when it cannot say. */
  lastPersonInputAt: number | null;
  /** The screen is locked or the screen saver runs. */
  locked: boolean;
  /** When the app's own last desktop step ended, or null when it has made none. */
  lastAppStepEndedAt: number | null;
  /** This chat's Go ahead, if any. */
  grant: { since: number; until: number } | null;
}

export type DesktopAskWhy = 'off' | 'grant' | 'locked' | 'away' | 'active' | 'always' | 'unknown';

export function desktopAskDecision(input: DesktopAskInput): { ask: boolean; why: DesktopAskWhy } {
  if (input.mode === 'off') return { ask: false, why: 'off' };
  const appInputUntil = input.lastAppStepEndedAt === null ? -Infinity : input.lastAppStepEndedAt + IDLE_RESOLUTION_MS;
  const personInputAt = input.lastPersonInputAt !== null && input.lastPersonInputAt > appInputUntil ? input.lastPersonInputAt : null;
  if (input.grant && input.now < input.grant.until && input.lastPersonInputAt !== null &&
      (personInputAt === null || personInputAt <= input.grant.since)) return { ask: false, why: 'grant' };
  if (input.mode === 'always') return { ask: true, why: 'always' };
  if (input.locked) return { ask: false, why: 'locked' };
  if (input.lastPersonInputAt === null) return { ask: true, why: 'unknown' };
  return personInputAt !== null && input.now - personInputAt < ASK_ACTIVE_MS ? { ask: true, why: 'active' } : { ask: false, why: 'away' };
}

/**
 * The question's colors, from the app's own palette (Haz on #1864): its ink is the app's readable ink
 * for that background, and the app's high-contrast setting carries over, so the small window reads
 * as well as the app does on any background.
 */
export function desktopAskColors(appearance: AppearanceSettings, theme: AppearanceTheme): {
  background: string; accent: string; ink: string; soft: string; edge: string; hover: string;
} {
  const palette = effectivePalette(appearance, theme);
  const tokens = paletteTokens(palette.background, palette.accent, palette.contrast, appearance.highContrast === true);
  const background = tokens['--page'] ?? palette.background, ink = tokens['--ink']!;
  // A hover shade that would make the ink hard to read (a mid-grey background) is left out: the
  // button's border shows the hover instead (CodeRabbit on #1864).
  const hover = contrastRatio(ink, tokens['--hover']!) >= 4.5 ? tokens['--hover']! : background;
  return { background, accent: tokens['--blue'] ?? palette.accent, ink, soft: tokens['--soft']!, edge: tokens['--edge']!, hover };
}
