import type { InternalBrowserDockState } from '../shared/internal-browser.js';

/** Renderer-owned dock layout; the remote page itself lives in a native WebContentsView. */
export function initInternalBrowserDock(): void {
  const app = document.querySelector<HTMLElement>('.app')!;
  const dock = document.getElementById('browserDock')!;
  const slot = document.getElementById('browserDockSlot')!;
  const tabs = document.getElementById('browserDockTabs')!;
  const handle = document.getElementById('browserDockResize')!;
  const toggle = document.getElementById('browserDockToggle')!;
  const key = 'chat-on-steroids.browser-dock-width';
  const minimum = 280;
  const maximum = () => Math.max(minimum, Math.min(720, window.innerWidth * 0.62));
  let preferred: number | null = null;
  let open = false;
  let drag: { id: number; x: number; width: number } | null = null;
  let frame = 0;

  function tabLabel(title: string, url: string): string {
    const trimmed = title.trim().replace(/\s*[|·-]\s*ChatGPT\s*$/i, '');
    if (trimmed && trimmed.toLowerCase() !== 'chatgpt') return trimmed;
    try {
      const parsed = new URL(url);
      if (/^\/c\//.test(parsed.pathname)) return 'Chat';
      if (parsed.searchParams.has('clf')) return 'Worker';
    } catch { /* A just-created WebContents can have no URL yet. */ }
    return 'New chat';
  }

  function renderTabs(state: InternalBrowserDockState | null | undefined): void {
    if (!state || !Array.isArray(state.tabs)) return;
    const fragment = document.createDocumentFragment();
    for (const tab of state.tabs) {
      const pill = document.createElement('div');
      pill.className = `browser-tab-pill${tab.status === 'loading' ? ' is-loading' : ''}`;
      pill.dataset.tabId = String(tab.id);
      pill.setAttribute('role', 'tab');
      pill.tabIndex = 0;
      pill.setAttribute('aria-selected', String(tab.active));
      pill.title = tab.title || tab.url || 'ChatGPT';
      const title = document.createElement('span');
      title.className = 'browser-tab-title';
      title.textContent = tabLabel(tab.title, tab.url);
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'browser-tab-close';
      close.dataset.closeTabId = String(tab.id);
      close.setAttribute('aria-label', `Close ${title.textContent}`);
      close.textContent = '×';
      pill.append(title, close);
      fragment.append(pill);
    }
    tabs.replaceChildren(fragment);
    tabs.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  try {
    const saved = Number(localStorage.getItem(key));
    if (Number.isFinite(saved) && saved >= minimum) preferred = Math.min(720, saved);
  } catch { /* Layout persistence is optional. */ }

  function bounds() {
    const rect = slot.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }

  function paint(): void {
    app.classList.toggle('browser-dock-open', open);
    dock.hidden = !open;
    dock.inert = !open;
    toggle.classList.toggle('is-active', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.title = open ? 'Hide ChatGPT browser' : 'Show ChatGPT browser';
    if (preferred === null) app.style.removeProperty('--browser-dock-width');
    else app.style.setProperty('--browser-dock-width', `${Math.min(maximum(), preferred)}px`);
    handle.setAttribute('aria-valuemin', String(minimum));
    handle.setAttribute('aria-valuemax', String(Math.round(maximum())));
    if (open) handle.setAttribute('aria-valuenow', String(Math.round(dock.getBoundingClientRect().width)));
  }

  function syncLayout(show = false): void {
    if (!open) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      const rect = bounds();
      if (rect.width < 1 || rect.height < 1) return;
      void window.api.internalBrowser({ action: show ? 'show' : 'layout', bounds: rect });
    });
  }

  async function setOpen(next: boolean): Promise<void> {
    if (open === next) { if (next) syncLayout(); return; }
    if (!next) {
      // Hide the native view before collapsing the CSS track so it can never cover the app.
      await window.api.internalBrowser({ action: 'hide' });
      open = false;
      paint();
      return;
    }
    open = true;
    paint();
    syncLayout(true);
  }

  function setWidth(width: number): void {
    preferred = Math.round(Math.max(minimum, Math.min(maximum(), width)));
    paint();
    syncLayout();
  }

  toggle.addEventListener('click', () => { void setOpen(!open); });
  tabs.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    const close = target.closest<HTMLElement>('[data-close-tab-id]');
    if (close) {
      event.stopPropagation();
      const tabId = Number(close.dataset.closeTabId);
      if (Number.isInteger(tabId)) void window.api.internalBrowser({ action: 'close', tabId }).then(reply => { if (reply.ok) renderTabs(reply.data); });
      return;
    }
    const pill = target.closest<HTMLElement>('[data-tab-id]');
    const tabId = Number(pill?.dataset.tabId);
    if (Number.isInteger(tabId)) void window.api.internalBrowser({ action: 'select', tabId }).then(reply => { if (reply.ok) renderTabs(reply.data); });
  });
  tabs.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const pill = (event.target as HTMLElement).closest<HTMLElement>('[data-tab-id]');
    const tabId = Number(pill?.dataset.tabId);
    if (!Number.isInteger(tabId)) return;
    event.preventDefault();
    void window.api.internalBrowser({ action: 'select', tabId }).then(reply => { if (reply.ok) renderTabs(reply.data); });
  });
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    handle.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, x: event.clientX, width: dock.getBoundingClientRect().width };
    app.classList.add('is-resizing-browser-dock');
    event.preventDefault();
  });
  handle.addEventListener('pointermove', event => {
    if (drag?.id === event.pointerId) setWidth(drag.width + event.clientX - drag.x);
  });
  function finish(event: PointerEvent): void {
    if (drag?.id !== event.pointerId) return;
    drag = null;
    app.classList.remove('is-resizing-browser-dock');
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    try { if (preferred === null) localStorage.removeItem(key); else localStorage.setItem(key, String(preferred)); } catch { /* optional */ }
  }
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
  handle.addEventListener('lostpointercapture', finish);
  handle.addEventListener('dblclick', () => {
    preferred = null;
    paint();
    try { localStorage.removeItem(key); } catch { /* optional */ }
    syncLayout();
  });
  handle.addEventListener('keydown', event => {
    const width = dock.getBoundingClientRect().width;
    if (event.key === 'ArrowLeft') setWidth(width - 10);
    else if (event.key === 'ArrowRight') setWidth(width + 10);
    else if (event.key === 'Home') setWidth(minimum);
    else if (event.key === 'End') setWidth(maximum());
    else return;
    event.preventDefault();
  });

  // Electron/Chromium always supplies ResizeObserver. Keep renderer boot testable in DOM
  // environments that do not implement it; window resize and every explicit dock mutation still
  // synchronize bounds, while the real app also follows layout-only size changes immediately.
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => syncLayout()).observe(slot);
  window.addEventListener('resize', () => { paint(); syncLayout(); });
  window.api.onInternalBrowserShowRequested(() => { void setOpen(true); });
  window.api.onInternalBrowserStateChanged(renderTabs);
  paint();
  void window.api.internalBrowser({ action: 'query' }).then(reply => {
    if (!reply.ok || !reply.data) return;
    renderTabs(reply.data);
    if (reply.data.open) void setOpen(true);
  });
}
