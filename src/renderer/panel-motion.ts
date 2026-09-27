/** Keep a closing pane painted while its grid track contracts; `hidden` remains the logical state. */
const closing = new WeakMap<HTMLElement, Animation>();

function motionAllowed(pane: HTMLElement, direction: 'left' | 'right' | 'up'): boolean {
  const view = pane.ownerDocument.defaultView;
  return typeof pane.animate === 'function'
    && !view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    && !(direction === 'right' && view?.matchMedia?.('(max-width: 850px)').matches);
}

function offsetFor(direction: 'left' | 'right' | 'up'): string {
  return direction === 'up' ? 'translateY(14px)' : `translateX(${direction === 'left' ? -14 : 14}px)`;
}

export function showSlidingPanel(pane: HTMLElement, direction: 'left' | 'right' | 'up', animate = true): void {
  closing.get(pane)?.cancel();
  closing.delete(pane);
  pane.classList.remove('is-closing');
  pane.hidden = false;
  pane.inert = false;
  if (!animate || !motionAllowed(pane, direction)) return;
  const offset = offsetFor(direction);
  pane.animate([
    { opacity: 0.55, transform: offset },
    { opacity: 1, transform: 'translate(0, 0)' }
  ], { duration: 220, easing: 'cubic-bezier(.16, 1, .3, 1)' });
}

export function hideSlidingPanel(pane: HTMLElement, direction: 'left' | 'right' | 'up', instant = false): void {
  closing.get(pane)?.cancel();
  closing.delete(pane);
  pane.inert = true;
  if (instant || !motionAllowed(pane, direction)) {
    pane.classList.remove('is-closing');
    pane.hidden = true;
    return;
  }
  pane.classList.add('is-closing');
  pane.hidden = true;
  const offset = offsetFor(direction);
  const animation = pane.animate([
    { opacity: 1, transform: 'translate(0, 0)' },
    { opacity: 0, transform: offset }
  ], { duration: 170, easing: 'ease-in', fill: 'forwards' });
  closing.set(pane, animation);
  void animation.finished.catch(() => undefined).then(() => {
    if (closing.get(pane) !== animation) return;
    closing.delete(pane);
    pane.classList.remove('is-closing');
    animation.cancel();
  });
}
