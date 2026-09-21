export type SlideDirection = 'left' | 'right' | 'down';

function offscreenTransform(direction: SlideDirection): string {
  if (direction === 'left') return 'translate3d(-100%, 0, 0)';
  if (direction === 'right') return 'translate3d(100%, 0, 0)';
  return 'translate3d(0, 100%, 0)';
}

/** Runs a cosmetic slide without owning the caller's visibility/state semantics. */
export function slideTransition(
  node: HTMLElement,
  direction: SlideDirection,
  entering: boolean,
  finish: () => void
): Animation | null {
  const view = node.ownerDocument.defaultView;
  const reduced = view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  if (reduced || typeof node.animate !== 'function') {
    finish();
    return null;
  }

  const offscreen = offscreenTransform(direction);
  const resting = 'translate3d(0, 0, 0)';
  const animation = node.animate(
    entering
      ? [{ transform: offscreen }, { transform: resting }]
      : [{ transform: resting }, { transform: offscreen }],
    { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' }
  );
  animation.addEventListener('finish', () => {
    animation.cancel();
    finish();
  }, { once: true });
  return animation;
}
