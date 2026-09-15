import type { BrowserUseTabState } from '../shared/browser-use.js';
import { el, icon } from './dom.js';
import { t, ui } from './i18n.js';

export interface BrowserTabStrip {
  root: HTMLElement;
  render(tabs: readonly BrowserUseTabState[], activeTabId: number | null): void;
  refresh(): void;
}

export function createBrowserTabStrip(options: {
  onSelect: (tabId: number) => void;
  onClose: (tabId: number) => void;
  onCreate: () => void;
  onClosePanel: () => void;
}): BrowserTabStrip {
  const root = el('div', 'browser-use-tabbar');

  const viewport = el('div', 'browser-use-tabs-viewport');
  const track = el('div', 'browser-use-tabs');
  track.setAttribute('role', 'tablist');
  ui(track, 'aria-label', () => t('Browser tabs'));
  viewport.append(track);

  const actions = el('div', 'browser-use-tab-actions');
  const add = el('button', 'btn btn-icon browser-use-add') as HTMLButtonElement;
  add.type = 'button';
  add.append(icon('i-plus'));
  ui(add, 'aria-label', () => t('New browser tab'));
  const closePanel = el('button', 'btn btn-icon browser-use-close') as HTMLButtonElement;
  closePanel.type = 'button';
  closePanel.append(icon('i-x'));
  ui(closePanel, 'aria-label', () => t('Close Browser'));
  actions.append(add, closePanel);

  root.append(viewport, actions);

  let drag: { pointerId: number; startX: number; startScrollLeft: number; moved: boolean } | null = null;
  let suppressClick = false;
  let lastActiveTabId: number | null = null;

  function updateOverflow(): void {
    const maxScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    root.classList.toggle('has-overflow', maxScrollLeft > 1);
  }

  function render(tabs: readonly BrowserUseTabState[], activeTabId: number | null): void {
    const previousScrollLeft = viewport.scrollLeft;
    const fragment = document.createDocumentFragment();

    for (const tab of tabs) {
      const pill = el('div', `browser-use-tab${tab.loading ? ' is-loading' : ''}`);
      pill.dataset.browserTabId = String(tab.id);
      pill.setAttribute('role', 'tab');
      pill.tabIndex = 0;
      pill.setAttribute('aria-selected', String(tab.active));
      pill.title = tab.title || tab.url || t('New tab');
      const label = el('span', 'browser-use-tab-title', tab.title.trim() || (() => {
        try { return new URL(tab.url).hostname || t('New tab'); } catch { return t('New tab'); }
      })());
      const close = el('button', 'browser-use-tab-close') as HTMLButtonElement;
      close.type = 'button';
      close.dataset.closeBrowserTabId = String(tab.id);
      close.append(icon('i-x'));
      ui(close, 'aria-label', () => t('Close browser tab'));
      pill.append(label, close);
      fragment.append(pill);
    }

    track.replaceChildren(fragment);
    viewport.scrollLeft = previousScrollLeft;

    window.requestAnimationFrame(() => {
      const max = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      viewport.scrollLeft = Math.min(viewport.scrollLeft, max);
      if (activeTabId !== lastActiveTabId) {
        const active = track.querySelector<HTMLElement>(`[data-browser-tab-id="${activeTabId ?? ''}"]`);
        if (active && typeof active.scrollIntoView === 'function') {
          active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      }
      lastActiveTabId = activeTabId;
      updateOverflow();
    });
  }

  track.addEventListener('click', event => {
    if (suppressClick) {
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const target = event.target as HTMLElement;
    const close = target.closest<HTMLElement>('[data-close-browser-tab-id]');
    if (close) {
      event.stopPropagation();
      const tabId = Number(close.dataset.closeBrowserTabId);
      if (Number.isInteger(tabId)) options.onClose(tabId);
      return;
    }
    const pill = target.closest<HTMLElement>('[data-browser-tab-id]');
    const tabId = Number(pill?.dataset.browserTabId);
    if (Number.isInteger(tabId)) options.onSelect(tabId);
  });

  track.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const pill = (event.target as HTMLElement).closest<HTMLElement>('[data-browser-tab-id]');
    const tabId = Number(pill?.dataset.browserTabId);
    if (!Number.isInteger(tabId)) return;
    event.preventDefault();
    options.onSelect(tabId);
  });

  track.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag || (event.target as HTMLElement).closest('button')) return;
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: viewport.scrollLeft,
      moved: false
    };
  });

  window.addEventListener('pointermove', event => {
    if (drag?.pointerId !== event.pointerId) return;
    const delta = event.clientX - drag.startX;
    if (!drag.moved && Math.abs(delta) < 4) return;
    drag.moved = true;
    viewport.classList.add('is-dragging');
    viewport.scrollLeft = drag.startScrollLeft - delta;
    event.preventDefault();
    updateOverflow();
  });

  function finishDrag(event: PointerEvent, cancelled = false): void {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const moved = drag.moved;
    drag = null;
    viewport.classList.remove('is-dragging');
    if (moved && !cancelled) {
      suppressClick = true;
      window.setTimeout(() => { suppressClick = false; }, 0);
    }
    updateOverflow();
  }

  window.addEventListener('pointerup', event => finishDrag(event));
  window.addEventListener('pointercancel', event => finishDrag(event, true));

  viewport.addEventListener('scroll', updateOverflow, { passive: true });
  viewport.addEventListener('wheel', event => {
    const max = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    if (max <= 1) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (!delta) return;
    const before = viewport.scrollLeft;
    viewport.scrollLeft = Math.max(0, Math.min(max, before + delta));
    if (viewport.scrollLeft === before) return;
    event.preventDefault();
    updateOverflow();
  }, { passive: false });

  add.addEventListener('click', options.onCreate);
  closePanel.addEventListener('click', options.onClosePanel);

  if (typeof ResizeObserver === 'function') new ResizeObserver(updateOverflow).observe(viewport);
  window.addEventListener('resize', updateOverflow);

  return { root, render, refresh: updateOverflow };
}
