const HEIGHT_EPSILON = 0.5;
const HEIGHT_DURATION_MS = 220;
const HEIGHT_EASING = 'cubic-bezier(.16, 1, .3, 1)';

/**
 * Smooths changes to the composer's native content-sized height.
 *
 * CSS remains the height owner. The observer only bridges the previous and next
 * border-box sizes, then releases the animation so hidden panels, wrapping and
 * `field-sizing: content` keep their normal layout behavior.
 */
export function installComposerHeightMotion(composer: HTMLElement): () => void {
  if (typeof ResizeObserver !== 'function') return () => undefined;

  const view = composer.ownerDocument.defaultView;
  const reducedMotion = view?.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
  let settledHeight: number | null = null;
  let active: Animation | null = null;
  let disposed = false;

  const measure = (): number => composer.getBoundingClientRect().height;
  const isVisible = (height: number): boolean => !composer.hidden && composer.isConnected && height > HEIGHT_EPSILON;

  const stopActive = (): void => {
    const animation = active;
    active = null;
    if (animation) animation.cancel();
    composer.classList.remove('is-resizing');
  };

  function settle(animation: Animation, target: number): void {
    if (disposed || active !== animation) return;
    active = null;
    animation.cancel();
    const naturalHeight = measure();
    if (!isVisible(naturalHeight)) {
      settledHeight = null;
      composer.classList.remove('is-resizing');
      return;
    }
    settledHeight = target;
    if (Math.abs(naturalHeight - target) > HEIGHT_EPSILON && !reducedMotion?.matches) {
      animateHeight(target, naturalHeight);
      return;
    }
    settledHeight = naturalHeight;
    composer.classList.remove('is-resizing');
  }

  function animateHeight(from: number, to: number): void {
    if (Math.abs(from - to) <= HEIGHT_EPSILON || reducedMotion?.matches || typeof composer.animate !== 'function') {
      settledHeight = to;
      composer.classList.remove('is-resizing');
      return;
    }
    composer.classList.add('is-resizing');
    const animation = composer.animate([
      { height: `${from}px` },
      { height: `${to}px` }
    ], { duration: HEIGHT_DURATION_MS, easing: HEIGHT_EASING });
    active = animation;
    void animation.finished.then(
      () => settle(animation, to),
      () => {
        if (active !== animation) return;
        active = null;
        const naturalHeight = measure();
        settledHeight = isVisible(naturalHeight) ? naturalHeight : null;
        composer.classList.remove('is-resizing');
      }
    );
  }

  const observer = new ResizeObserver(() => {
    if (disposed) return;
    const height = measure();
    if (!isVisible(height)) {
      stopActive();
      settledHeight = null;
      return;
    }
    if (active) return;
    if (settledHeight === null) {
      settledHeight = height;
      return;
    }
    animateHeight(settledHeight, height);
  });
  observer.observe(composer);

  const reduce = (): void => {
    if (!reducedMotion?.matches) return;
    stopActive();
    const height = measure();
    settledHeight = isVisible(height) ? height : null;
  };
  reducedMotion?.addEventListener?.('change', reduce);

  return () => {
    disposed = true;
    observer.disconnect();
    reducedMotion?.removeEventListener?.('change', reduce);
    stopActive();
  };
}
