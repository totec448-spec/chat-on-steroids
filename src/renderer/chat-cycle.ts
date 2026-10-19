/**
 * Ctrl+Tab opens the next chat and Ctrl+Shift+Tab the previous one, in the order the sidebar draws
 * them (tree or Inbox), wrapping at the ends as a browser's tabs do. Ctrl on every system, macOS
 * included, as in browsers. Rows inside a closed group (a collapsed project, Settled) are skipped;
 * the step is the row's own click, so it selects and shows the chat exactly as a click does.
 */
export function initChatCycle(list: HTMLElement, selected: () => string | null): void {
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || !event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
    // The terminal and the file editor keep their keys, a rename keeps its field, a dialog or a
    // popup (the pickers are role="dialog" divs) its focus.
    const target = event.target as Element | null;
    if (target?.closest?.('.xterm, .cm-editor, .sess-rename, [role="dialog"]') || document.querySelector('dialog[open]')) return;
    // Settings hides the chat list: there is no drawn order to walk.
    if (list.closest('[hidden]')) return;
    const rows = [...list.querySelectorAll<HTMLElement>('[data-id] > [data-session-select]')]
      .filter(control => !control.closest('details:not([open])'));
    if (!rows.length) return;
    event.preventDefault();
    if (event.repeat) return;
    const at = rows.findIndex(control => control.parentElement!.dataset.id === selected());
    const step = event.shiftKey ? -1 : 1;
    const next = rows[at < 0 ? (step > 0 ? 0 : rows.length - 1) : (at + step + rows.length) % rows.length]!;
    const id = next.parentElement!.dataset.id;
    const focused = list.contains(document.activeElement);
    next.click();
    // The click repaints the list: bring the new row of the chat now open into view, and keyboard
    // focus with it when it was in the list, so Enter does not reopen the chat before.
    const row = [...list.querySelectorAll<HTMLElement>('[data-id]')].find(entry => entry.dataset.id === id);
    row?.scrollIntoView({ block: 'nearest' });
    if (focused) row?.querySelector<HTMLElement>(':scope > [data-session-select]')?.focus({ preventScroll: true });
  });
}
