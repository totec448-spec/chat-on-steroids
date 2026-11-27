/**
 * The Setup rail shows every step side by side, so in a compact window or a language with long step names its
 * labels were cut to four letters ("Брау…", "Дост…"). A label is useful whole or not at all: when any label of the
 * steps shown does not fit, the rail marks itself `is-compact` and the labels move off screen. They stay in the
 * page, so every step keeps its name for a screen reader.
 */
export function watchSetupRailLabels(rail: HTMLElement | null): (() => void) | null {
  // Test pages and older shells may lack the observers; the rail then keeps its labels as before.
  if (!rail || typeof ResizeObserver !== 'function' || typeof MutationObserver !== 'function') return null;
  let frame = 0, width = -1;
  const fit = (): void => {
    frame = 0;
    rail.classList.remove('is-compact');
    const labels = [...rail.querySelectorAll<HTMLElement>('li:not([hidden]) .setup-rail-label')];
    if (labels.some(label => label.scrollWidth > label.clientWidth + 1)) rail.classList.add('is-compact');
  };
  const schedule = (): void => { if (!frame) frame = requestAnimationFrame(fit); };
  // Only the rail's width matters to the resize watch: showing or hiding the labels changes its height.
  new ResizeObserver(() => { if (rail.clientWidth !== width) { width = rail.clientWidth; schedule(); } }).observe(rail);
  new MutationObserver(schedule).observe(rail, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'aria-current'] });
  // A font that arrives after the first measurement (swap) changes every label's width, with the rail's unchanged.
  const fonts = rail.ownerDocument.fonts;
  void fonts?.ready.then(schedule);
  fonts?.addEventListener?.('loadingdone', schedule);
  schedule();
  return schedule;
}
