/**
 * Alt+↑ / Alt+↓ (⌥ on macOS) moves the chat to your previous / next message (#1884, Haz's review):
 * keyboard only, no new chrome, the search results' own highlight. It never takes keys from a text
 * field, the terminal, an editor, an open dialog, a focused queued task or the sidebar (where Alt+↑/↓
 * moves a queued task or a chat).
 */

/** A few pixels of rounding after a scroll still count as the message the view starts with. */
const SLACK = 6;

/**
 * Which own message to go to: the nearest one whose top is above (-1) or below (1) the top of the
 * view, the message the view starts with not counted; -1 when there is none that way.
 */
export function pickOwnMessage(tops: readonly number[], viewTop: number, direction: -1 | 1): number {
  if (direction < 0) {
    for (let at = tops.length - 1; at >= 0; at--) if (tops[at]! < viewTop - SLACK) return at;
    return -1;
  }
  return tops.findIndex(top => top > viewTop + SLACK);
}

/**
 * The message to go to, going on from the one the last jump went to (`last`, or -1) while that one is
 * still in view (viewTop..viewBottom): when several fit, the scroll cannot bring the next to the top,
 * so the top of the view would keep naming the same one. Out of view, the top of the view decides.
 */
export function nextOwnMessage(tops: readonly number[], viewTop: number, viewBottom: number, direction: -1 | 1, last: number): number {
  const top = last >= 0 ? tops[last] : undefined;
  if (top === undefined || top < viewTop - SLACK || top > viewBottom) {
    const picked = pickOwnMessage(tops, viewTop, direction);
    // Nothing above the view on a first Alt+↑: the newest message in view, before any older page.
    if (picked >= 0 || direction > 0 || top !== undefined) return picked;
    for (let at = tops.length - 1; at >= 0; at--) if (tops[at]! >= viewTop - SLACK && tops[at]! <= viewBottom) return at;
    return -1;
  }
  const next = last + direction;
  return next >= 0 && next < tops.length ? next : -1;
}

/** Whether a key on this element belongs to it rather than to the chat. */
export function keyBelongsElsewhere(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  if (!element) return false;
  // Any editable area, whatever its contenteditable value (plaintext-only too) and inherited ones.
  if ((element as HTMLElement).isContentEditable || element.closest('[contenteditable]:not([contenteditable="false"])')) return true;
  // An open panel, menu or list (the context meter's, a row menu) keeps its keys too.
  return !!element.closest('input, textarea, select, .xterm, .cm-editor, dialog[open], ' +
    '[role="dialog"], [role="menu"], [role="listbox"], [aria-expanded="true"], .queued-input, .pending-message, .sidebar');
}
