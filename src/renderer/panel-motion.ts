/* Work docks move as drawers. A dock's grid tracks are read as resolved pixels on both sides of
   a layout change and interpolated, so every CSS track form animates (a stored size, the default
   percentage, the expanded layout, and a track that only exists while the dock is open). CSS
   owns the resting layout; `hidden` stays the logical state throughout.

   Opening and closing keep the dock's content at its resting size on the leading edge, so it
   slides in and out whole and a terminal or editor lays out once. Expanding and restoring the
   right dock resize its content like a divider drag, while the chat keeps its readable width and
   fades underneath instead of wrapping into a sliver. */
const DOCK_ENTER = { duration: 320, easing: 'cubic-bezier(.22, 1, .36, 1)' };
const DOCK_EXIT = { duration: 240, easing: 'cubic-bezier(.4, 0, .2, 1)' };
type DockMotion = { animation: Animation; frozen: number; cleanup: () => void };
const dockMotion = new WeakMap<HTMLElement, DockMotion>();

/** `x`: the right dock is the host's last column. `y`: the bottom dock is the host's last row. */
export type DockAxis = 'x' | 'y';
const TRACKS = { x: 'gridTemplateColumns', y: 'gridTemplateRows' } as const;

function tracks(host: HTMLElement, axis: DockAxis): number[] {
  const view = host.ownerDocument.defaultView;
  return (view?.getComputedStyle(host)[TRACKS[axis]] ?? '').split(/\s+/).map(Number.parseFloat).filter(Number.isFinite);
}

function motionAllowed(host: HTMLElement, axis: DockAxis): boolean {
  const view = host.ownerDocument.defaultView;
  return typeof host.animate === 'function' && host.getClientRects().length > 0
    && !view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    // A narrow window overlays the right dock on the chat; there is no track to move.
    && !(axis === 'x' && view?.matchMedia?.('(max-width: 850px)').matches);
}

/** `settled` runs once the move ends or is superseded (immediately when there is no motion). */
export function moveWorkDock(host: HTMLElement, pane: HTMLElement, change: () => void, settled?: () => void, axis: DockAxis = 'x'): void {
  const running = dockMotion.get(host);
  // A running motion reports its current frame, so an interruption continues from where it is.
  let from = tracks(host, axis);
  const frozen = running?.frozen ?? 0;
  running?.animation.cancel(); running?.cleanup(); dockMotion.delete(host);
  const wasShown = !pane.hidden;
  change();
  const shown = !pane.hidden;
  pane.inert = !shown;
  let to = tracks(host, axis);
  // A dock track that exists only while open is the same list with a trailing zero.
  if (from.length + 1 === to.length) from = [...from, 0];
  if (to.length + 1 === from.length) to = [...to, 0];
  const dock = to.length - 1, main = to.length - 2;
  const moving = motionAllowed(host, axis) && from.length === to.length && main >= 0
    && (Math.abs(from[dock]! - to[dock]!) > .5 || Math.abs(from[main]! - to[main]!) > .5);
  if (!moving) { pane.classList.remove('is-closing'); settled?.(); return; }

  const sliding = wasShown !== shown || frozen > 0;
  const size = sliding ? Math.max(frozen, from[dock]!, to[dock]!) : 0;
  const closing = wasShown && !shown;
  const timing = closing ? DOCK_EXIT : DOCK_ENTER;
  const chat = axis === 'x' ? host.querySelector<HTMLElement>(':scope > .is-session') : null;
  const handover = !!chat && Math.min(from[main]!, to[main]!) < 1 && Math.min(from[dock]!, to[dock]!) >= 1;
  if (closing) pane.classList.add('is-closing');
  pane.classList.add('is-moving');
  if (sliding) { pane.classList.add('is-sliding'); pane.style.setProperty('--work-dock-motion-size', `${size}px`); }
  if (handover) {
    host.classList.add('is-dock-handover');
    host.style.setProperty('--chat-motion-width', `${Math.max(from[main]!, to[main]!)}px`);
  }
  const fade = handover && chat?.animate ? chat.animate([{ opacity: from[main]! < 1 ? 0 : 1 }, { opacity: to[main]! < 1 ? 0 : 1 }],
    { duration: timing.duration * (to[main]! < 1 ? .6 : 1), easing: timing.easing, fill: 'forwards' }) : null;
  const frame = (list: number[]) => ({ [TRACKS[axis]]: list.map(value => `${value}px`).join(' ') });
  const animation = host.animate([frame(from), frame(to)], timing);
  const cleanup = (): void => {
    fade?.cancel();
    pane.classList.remove('is-moving', 'is-sliding');
    pane.style.removeProperty('--work-dock-motion-size');
    host.classList.remove('is-dock-handover');
    host.style.removeProperty('--chat-motion-width');
    if (pane.hidden) pane.classList.remove('is-closing');
    settled?.();
  };
  dockMotion.set(host, { animation, frozen: size, cleanup });
  void animation.finished.catch(() => undefined).then(() => {
    if (dockMotion.get(host)?.animation !== animation) return;
    dockMotion.delete(host); animation.cancel(); cleanup();
  });
}
