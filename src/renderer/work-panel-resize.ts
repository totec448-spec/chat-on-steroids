const STORAGE_KEY = 'chat-on-steroids.work-panel-width';
const DEFAULT_WIDTH = 500;
const MIN_WIDTH = DEFAULT_WIDTH;
const MIN_MAIN_WIDTH = 360;

function hostWidth(host: HTMLElement): number {
  const measured = host.getBoundingClientRect().width || host.clientWidth || host.ownerDocument.defaultView?.innerWidth || 0;
  return Math.max(MIN_WIDTH + MIN_MAIN_WIDTH, measured);
}

function maximum(host: HTMLElement): number {
  return Math.max(MIN_WIDTH, hostWidth(host) - MIN_MAIN_WIDTH);
}

function currentWidth(host: HTMLElement, pane: HTMLElement): number {
  const explicit = Number.parseFloat(host.style.getPropertyValue('--work-panel-width'));
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const measured = pane.getBoundingClientRect().width;
  if (measured > 0) return measured;
  return Math.min(maximum(host), DEFAULT_WIDTH);
}

function setWidth(host: HTMLElement, width: number, persist = false): number {
  const next = Math.round(Math.max(MIN_WIDTH, Math.min(maximum(host), width)));
  host.style.setProperty('--work-panel-width', `${next}px`);
  // Files and Sub-agents are two projections of the same work slot. Keep both separators'
  // accessibility state synchronized even while one pane is hidden.
  for (const handle of host.querySelectorAll<HTMLElement>('.work-panel-resize')) {
    handle.setAttribute('aria-valuemin', String(MIN_WIDTH));
    handle.setAttribute('aria-valuemax', String(Math.round(maximum(host))));
    handle.setAttribute('aria-valuenow', String(next));
  }
  if (persist) {
    try { host.ownerDocument.defaultView?.localStorage.setItem(STORAGE_KEY, String(next)); } catch { /* Layout persistence is optional. */ }
  }
  return next;
}

/**
 * Adds the shared horizontal resize affordance used by right-side work panes.
 * The width belongs to the work slot, not to either pane, so switching tools preserves it.
 * Native surfaces keep the same hit target but render their visible rail wholly on the DOM
 * side of the compositor boundary, where a WebContentsView cannot occlude it.
 */
export function attachWorkPanelResize(
  host: HTMLElement,
  pane: HTMLElement,
  options: { onResize?: () => void; nativeBoundary?: boolean } = {}
): HTMLElement {
  const view = host.ownerDocument.defaultView;
  if (!host.style.getPropertyValue('--work-panel-width')) {
    try {
      const saved = Number(view?.localStorage.getItem(STORAGE_KEY));
      if (Number.isFinite(saved) && saved >= MIN_WIDTH) setWidth(host, saved);
    } catch { /* Corrupt/unavailable layout storage must not block the pane. */ }
  }

  const handle = document.createElement('div');
  handle.className = `work-panel-resize${options.nativeBoundary ? ' is-native-boundary' : ''}`;
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', 'Resize work panel');
  if (options.nativeBoundary) {
    const rail = document.createElement('span');
    rail.className = 'work-panel-resize-rail';
    rail.setAttribute('aria-hidden', 'true');
    handle.append(rail);
  }
  pane.prepend(handle);

  let drag: { id: number; x: number; width: number } | null = null;
  const resize = (width: number, persist = false): number => {
    const next = setWidth(host, width, persist);
    options.onResize?.();
    return next;
  };
  const paintAria = () => resize(currentWidth(host, pane));
  paintAria();

  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    handle.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, x: event.clientX, width: currentWidth(host, pane) };
    host.classList.add('is-resizing-work-panel');
    event.preventDefault();
  });
  handle.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return;
    // The handle is the panel's left edge, so moving it left makes the right panel wider.
    resize(drag.width + drag.x - event.clientX);
  });
  const finish = (event: PointerEvent): void => {
    if (drag?.id !== event.pointerId) return;
    drag = null;
    host.classList.remove('is-resizing-work-panel');
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    resize(currentWidth(host, pane), true);
  };
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
  handle.addEventListener('lostpointercapture', finish);

  handle.addEventListener('dblclick', () => {
    host.style.removeProperty('--work-panel-width');
    try { view?.localStorage.removeItem(STORAGE_KEY); } catch { /* optional */ }
    paintAria();
  });
  handle.addEventListener('keydown', event => {
    const width = currentWidth(host, pane);
    if (event.key === 'ArrowLeft') resize(width + 10, true);
    else if (event.key === 'ArrowRight') resize(width - 10, true);
    else if (event.key === 'Home') resize(MIN_WIDTH, true);
    else if (event.key === 'End') resize(maximum(host), true);
    else return;
    event.preventDefault();
  });
  view?.addEventListener('resize', paintAria);
  return handle;
}
