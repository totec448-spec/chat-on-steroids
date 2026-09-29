/* Pointer reordering for a horizontal strip of tabs. The dragged tab follows the pointer while its
   neighbours slide aside; on release the owner commits the new order and repaints, and the tab
   settles from where it was dropped into its slot. The owner's order stays the only authority. */
const SHIFT = '160ms cubic-bezier(.22, 1, .36, 1)';

export type TabReorder = {
  /** CSS selector of one tab (a direct child of the strip). */
  item: string;
  /** Stable key of a tab node. */
  key: (node: HTMLElement) => string | undefined;
  /** Move `key` to `index` in the owner's order and repaint the strip. */
  move: (key: string, index: number) => void;
};

function reducedMotion(node: HTMLElement): boolean {
  return !!node.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function enableTabReorder(strip: HTMLElement, options: TabReorder): void {
  let press: { id: number; x: number; node: HTMLElement } | null = null;
  let drag: { node: HTMLElement; key: string; from: number; to: number; nodes: HTMLElement[]; centers: number[]; step: number; min: number; max: number } | null = null;
  const tabs = (): HTMLElement[] => ([...strip.children] as HTMLElement[]).filter(node => node.matches(options.item));

  strip.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    const node = (event.target as HTMLElement).closest<HTMLElement>(options.item);
    // The close control keeps its own click; only the tab body starts a drag.
    if (!node || node.parentElement !== strip || (event.target as HTMLElement).closest('.btn-icon') || tabs().length < 2) return;
    press = { id: event.pointerId, x: event.clientX, node };
  });
  strip.addEventListener('pointermove', event => {
    if (press?.id !== event.pointerId) return;
    const dx = event.clientX - press.x;
    if (!drag) {
      if (Math.abs(dx) < 5) return;
      const nodes = tabs(), from = nodes.indexOf(press.node), key = options.key(press.node);
      if (from < 0 || key === undefined) { press = null; return; }
      const rects = nodes.map(node => node.getBoundingClientRect());
      const gap = rects.length > 1 ? rects[1]!.left - rects[0]!.right : 0;
      drag = { node: press.node, key, from, to: from, nodes, centers: rects.map(rect => rect.left + rect.width / 2),
        step: rects[from]!.width + gap, min: rects[0]!.left - rects[from]!.left, max: rects.at(-1)!.right - rects[from]!.right };
      strip.setPointerCapture(event.pointerId);
      strip.classList.add('is-reordering'); drag.node.classList.add('is-dragging');
      for (const node of nodes) if (node !== drag.node && !reducedMotion(node)) node.style.transition = `transform ${SHIFT}`;
    }
    const offset = Math.max(drag.min, Math.min(drag.max, dx));
    drag.node.style.transform = `translateX(${offset}px)`;
    const center = drag.centers[drag.from]! + offset;
    let to = drag.from;
    while (to < drag.nodes.length - 1 && center >= drag.centers[to + 1]!) to++;
    while (to > 0 && center <= drag.centers[to - 1]!) to--;
    if (to === drag.to) return;
    drag.to = to;
    drag.nodes.forEach((node, index) => {
      if (node === drag!.node) return;
      const shift = drag!.from < index && index <= to ? -drag!.step : to <= index && index < drag!.from ? drag!.step : 0;
      node.style.transform = shift ? `translateX(${shift}px)` : '';
    });
  });
  const finish = (event: PointerEvent): void => {
    if (press?.id !== event.pointerId) return;
    press = null;
    const current = drag; drag = null;
    if (!current) return;
    if (strip.hasPointerCapture(event.pointerId)) strip.releasePointerCapture(event.pointerId);
    // A drag ends on the tab it moved; the click that follows must not also activate it.
    strip.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => strip.removeEventListener('click', swallow, { capture: true }), 0);
    const dropped = current.node.getBoundingClientRect().left;
    for (const node of current.nodes) { node.style.transition = ''; node.style.transform = ''; }
    strip.classList.remove('is-reordering'); current.node.classList.remove('is-dragging');
    if (current.to !== current.from) options.move(current.key, current.to);
    const settled = tabs().find(node => options.key(node) === current.key);
    if (!settled || typeof settled.animate !== 'function' || reducedMotion(settled)) return;
    const delta = dropped - settled.getBoundingClientRect().left;
    if (Math.abs(delta) > .5) settled.animate([{ transform: `translateX(${delta}px)` }, { transform: 'none' }], { duration: 160, easing: 'cubic-bezier(.22, 1, .36, 1)' });
  };
  const swallow = (event: Event): void => { event.stopPropagation(); event.preventDefault(); };
  strip.addEventListener('pointerup', finish);
  strip.addEventListener('pointercancel', finish);
}

/** Keyboard reordering: Ctrl+Shift+Left/Right moves the focused tab one place. */
export function reorderKey(event: KeyboardEvent): -1 | 1 | 0 {
  if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return 0;
  return event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
}
