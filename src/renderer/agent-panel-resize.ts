/** Renderer-only width preference for the right sub-agent panel. */
export function initAgentPanelResize(app: HTMLElement, panel: HTMLElement, handle: HTMLElement): void {
  const doc = panel.ownerDocument;
  const view = doc.defaultView;
  const key = 'chat-on-steroids.agent-panel-width';
  const minimum = 340;
  const defaultWidth = 400;
  const centerMinimum = 360;
  const hardMaximum = 720;
  let preferred: number | null = null;
  let drag: { id: number; x: number; width: number } | null = null;
  let storage: Storage | null = null;

  try {
    storage = view?.localStorage ?? null;
    const saved = Number(storage?.getItem(key));
    if (Number.isFinite(saved) && saved >= minimum) preferred = Math.min(hardMaximum, saved);
  } catch { /* Layout remains usable when storage is unavailable. */ }

  function maximum(): number {
    const left = app.classList.contains('is-sidebar-collapsed')
      ? 0
      : (doc.getElementById('sidebar')?.getBoundingClientRect().width ?? 0);
    return Math.max(minimum, Math.min(hardMaximum, (view?.innerWidth ?? 1280) - left - centerMinimum));
  }

  function render(): void {
    const width = Math.min(maximum(), preferred ?? defaultWidth);
    app.style.setProperty('--agent-panel-width', `${width}px`);
    handle.setAttribute('aria-valuemin', String(minimum));
    handle.setAttribute('aria-valuemax', String(maximum()));
    handle.setAttribute('aria-valuenow', String(Math.round(width)));
  }

  function save(): void {
    try {
      if (preferred === null) storage?.removeItem(key);
      else storage?.setItem(key, String(preferred));
    } catch { /* Keep the current width for this window. */ }
  }

  function setWidth(width: number): void {
    preferred = Math.round(Math.max(minimum, Math.min(maximum(), width)));
    render();
  }

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || drag || panel.inert) return;
    handle.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, x: event.clientX, width: panel.getBoundingClientRect().width };
    app.classList.add('is-resizing-agent-panel');
    event.preventDefault();
  });
  handle.addEventListener('pointermove', (event) => {
    if (drag?.id === event.pointerId) setWidth(drag.width + drag.x - event.clientX);
  });
  function finish(event: PointerEvent): void {
    if (drag?.id !== event.pointerId) return;
    drag = null;
    app.classList.remove('is-resizing-agent-panel');
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    save();
  }
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
  handle.addEventListener('lostpointercapture', finish);
  handle.addEventListener('dblclick', () => { preferred = null; render(); save(); });
  handle.addEventListener('keydown', (event) => {
    const width = panel.getBoundingClientRect().width;
    if (event.key === 'ArrowLeft') setWidth(width + 10);
    else if (event.key === 'ArrowRight') setWidth(width - 10);
    else if (event.key === 'Home') setWidth(minimum);
    else if (event.key === 'End') setWidth(maximum());
    else return;
    event.preventDefault();
    save();
  });
  view?.addEventListener('resize', render);
  if (view?.ResizeObserver) {
    const left = doc.getElementById('sidebar');
    if (left) new view.ResizeObserver(render).observe(left);
  }
  render();
}
