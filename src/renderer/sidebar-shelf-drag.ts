/** Cross-shelf dragging is separate from the existing same-shelf order sorter. */
export type SidebarDragShelf = 'active' | 'pinned' | 'settled' | 'snoozed';
export const SIDEBAR_SHELF_MIME = 'application/x-chat-on-steroids-sidebar-shelf';
export type SidebarDragAction = { shelf: SidebarDragShelf; label: string };

export function sidebarDragAction(source: SidebarDragShelf, target: SidebarDragShelf | null): SidebarDragAction | null {
  // Snoozing requires an explicit deadline chosen through the menu, not an accidental drop.
  if (!target || target === source || target === 'snoozed') return null;
  if (target === 'pinned') return { shelf: 'pinned', label: 'Pin' };
  if (target === 'settled') return { shelf: 'settled', label: 'Settle · Sidebar only' };
  return { shelf: 'active', label: source === 'pinned' ? 'Unpin' : source === 'settled' ? 'Un-settle' : 'Wake' };
}

export function initSidebarShelfDrag(options: {
  list: HTMLElement;
  zones: HTMLElement;
  shelfFor: (id: string) => SidebarDragShelf | null;
  change: (id: string, target: SidebarDragAction) => void;
  localizeLabel?: (source: string) => string;
}): void {
  const { list, zones, shelfFor, change } = options;
  type Drag = { pointerId: number | null; id: string; source: SidebarDragShelf; x: number; y: number;
    active: boolean; row: HTMLElement | null };
  let drag: Drag | null = null;
  let marked: HTMLElement | null = null;

  function reset(): void {
    drag?.row?.classList.remove('is-sidebar-row-dragging');
    drag?.row?.querySelector<HTMLElement>('.sidebar-row-drag-preview')?.setAttribute('hidden', '');
    marked?.classList.remove('is-shelf-drop-target');
    marked = null; drag = null; zones.hidden = true;
    list.classList.remove('is-sidebar-shelf-dragging');
  }
  function targetAt(element: Element | null): { shelf: SidebarDragShelf; element: HTMLElement } | null {
    const target = element?.closest<HTMLElement>('[data-sidebar-shelf-target]');
    const shelf = target?.dataset.sidebarShelfTarget;
    return target && (shelf === 'active' || shelf === 'pinned' || shelf === 'settled' || shelf === 'snoozed')
      ? { shelf, element: target } : null;
  }
  function show(target: { shelf: SidebarDragShelf; element: HTMLElement } | null): SidebarDragAction | null {
    if (!drag) return null;
    const action = sidebarDragAction(drag.source, target?.shelf ?? null);
    const highlight = action ? target!.element : null;
    if (highlight !== marked) {
      marked?.classList.remove('is-shelf-drop-target');
      marked = highlight;
      marked?.classList.add('is-shelf-drop-target');
    }
    const preview = drag.row?.querySelector<HTMLElement>('.sidebar-row-drag-preview');
    if (preview) {
      preview.hidden = !action;
      if (action) preview.textContent = options.localizeLabel?.(action.label) ?? action.label;
    }
    return action;
  }
  function start(id: string, source: SidebarDragShelf, row: HTMLElement | null, pointerId: number | null, x: number, y: number): void {
    drag = { pointerId, id, source, x, y, row, active: pointerId === null };
    if (drag.active) { zones.hidden = false; list.classList.add('is-sidebar-shelf-dragging'); row?.classList.add('is-sidebar-row-dragging'); }
  }

  // Pointer gesture on the actual row, leaving the existing sorter responsible for ordinary reordering.
  document.addEventListener('pointerdown', event => {
    if (drag || !event.isPrimary || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target instanceof Element ? event.target : null;
    const row = target?.closest<HTMLElement>('.sess[data-id]');
    if (!row || !list.contains(row) || !target?.closest('[data-session-select]') ||
        target.closest('button, input, select, textarea, a, .sess-actions, .sidebar-row-drag-preview')) return;
    const id = row.dataset.id!; const source = shelfFor(id);
    if (source) start(id, source, row, event.pointerId, event.clientX, event.clientY);
  }, true);
  document.addEventListener('pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
      drag.active = true; zones.hidden = false; list.classList.add('is-sidebar-shelf-dragging');
      drag.row?.classList.add('is-sidebar-row-dragging');
    }
    const hit = document.elementFromPoint?.(event.clientX, event.clientY) ?? (event.target instanceof Element ? event.target : null);
    show(targetAt(hit));
  }, true);
  document.addEventListener('pointerup', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const current = drag;
    const hit = document.elementFromPoint?.(event.clientX, event.clientY) ?? (event.target instanceof Element ? event.target : null);
    const action = current.active ? show(targetAt(hit)) : null;
    reset();
    if (!action || shelfFor(current.id) !== current.source) return;
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
    // The in-shelf sorter captured the same pointer. Cancel it before committing a shelf switch.
    const cancel = new Event('pointercancel');
    Object.defineProperty(cancel, 'pointerId', { value: event.pointerId });
    window.dispatchEvent(cancel);
    change(current.id, action);
  }, true);
  document.addEventListener('pointercancel', event => { if (drag?.pointerId === event.pointerId) reset(); }, true);
  window.addEventListener('blur', reset);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && drag) reset(); }, true);

  // A dedicated native drag handle also supplies keyboard/OS drag APIs; no file MIME is intercepted.
  list.addEventListener('dragstart', event => {
    const handle = (event.target as Element | null)?.closest<HTMLElement>('.sidebar-shelf-drag-handle');
    const row = handle?.closest<HTMLElement>('.sess[data-id]');
    const id = row?.dataset.id, source = id ? shelfFor(id) : null;
    if (!handle || !row || !source || !event.dataTransfer) return;
    reset(); start(id!, source, row, null, 0, 0);
    event.dataTransfer.setData(SIDEBAR_SHELF_MIME, id!);
    event.dataTransfer.effectAllowed = 'move';
  });
  document.addEventListener('dragover', event => {
    if (!drag || !event.dataTransfer?.types.includes(SIDEBAR_SHELF_MIME)) return;
    const target = targetAt(event.target instanceof Element ? event.target : null);
    const action = show(target);
    if (action) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }
    else event.dataTransfer.dropEffect = 'none';
  }, true);
  document.addEventListener('drop', event => {
    if (!drag || !event.dataTransfer?.types.includes(SIDEBAR_SHELF_MIME)) return;
    const current = drag;
    const action = show(targetAt(event.target instanceof Element ? event.target : null));
    const exact = event.dataTransfer.getData(SIDEBAR_SHELF_MIME) === current.id;
    reset();
    if (!action || !exact || shelfFor(current.id) !== current.source) return;
    event.preventDefault(); event.stopPropagation();
    change(current.id, action);
  }, true);
  document.addEventListener('dragend', reset, true);
}
