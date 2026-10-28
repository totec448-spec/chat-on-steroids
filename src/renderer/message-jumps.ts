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

/** Whether a key on this element belongs to it rather than to the chat. */
export function keyBelongsElsewhere(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  if (!element) return false;
  return !!element.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], .xterm, .cm-editor, dialog[open], .queued-input, .pending-message, .sidebar');
}
