import { currentLanguage, t } from './i18n.js';

/**
 * A chat list's date section (#1919): Today, Yesterday, Previous 7 days, Previous 30 days, then the
 * months of this year by name, then earlier years. `rank` grows with age, so a list sorted newest
 * first meets each section once, in order.
 */
export type DateSection = { rank: number; label: () => string };

const DAY_MS = 86_400_000;

/** Midnight of the local calendar day holding `atMs`. */
function dayStart(atMs: number): Date {
  const at = new Date(atMs);
  return new Date(at.getFullYear(), at.getMonth(), at.getDate());
}

export function dateSection(atMs: number, now = Date.now()): DateSection | null {
  // A chat without a usable time (a damaged record) has no section: it stays under the one before it.
  if (!Number.isFinite(atMs) || !Number.isFinite(now) || Number.isNaN(new Date(atMs).getTime())) return null;
  const today = dayStart(now), day = dayStart(atMs);
  // Calendar days, not 24-hour spans: rounding absorbs a daylight-saving hour. A time ahead of
  // this computer's clock (another device's clock) counts as today.
  const days = Math.max(0, Math.round((today.getTime() - day.getTime()) / DAY_MS));
  if (days === 0) return { rank: 0, label: () => t('Today') };
  if (days === 1) return { rank: 1, label: () => t('Yesterday') };
  if (days < 7) return { rank: 2, label: () => t('Previous 7 days') };
  if (days < 30) return { rank: 3, label: () => t('Previous 30 days') };
  if (day.getFullYear() === today.getFullYear()) {
    return { rank: 4 + today.getMonth() - day.getMonth(), label: () => new Intl.DateTimeFormat(currentLanguage(), { month: 'long' }).format(day) };
  }
  return { rank: 16 + today.getFullYear() - day.getFullYear(), label: () => new Intl.DateTimeFormat(currentLanguage(), { year: 'numeric' }).format(day) };
}

/**
 * Hands out the headings for one list, walked in its shown order: a heading when a chat is older than
 * every section shown so far. A chat the person dragged above older ones stays under the heading
 * before it, so no heading repeats and the person's order is kept.
 */
export function dateSections(now = Date.now()): (atMs: number) => DateSection | null {
  let shown = -1;
  return atMs => {
    const section = dateSection(atMs, now);
    if (!section || section.rank <= shown) return null;
    shown = section.rank;
    return section;
  };
}
