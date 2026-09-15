import type { BrowserUseBounds, BrowserUseState } from '../shared/browser-use.js';
import { el, icon, run, toast } from './dom.js';
import { t, ui } from './i18n.js';
import { attachWorkPanelResize } from './work-panel-resize.js';
import { createBrowserTabStrip } from './browser-tab-strip.js';

/** Browser chrome lives in the renderer; only the page rectangle is a native WebContentsView. */
export function createBrowserPanel(options: {
  host: HTMLElement;
  toggle: HTMLButtonElement;
  onShow?: () => void;
}) {
  const pane = el('aside', 'browser-use-panel');
  pane.hidden = true;
  ui(pane, 'aria-label', () => t('Browser'));

  const tabStrip = createBrowserTabStrip({
    onSelect: tabId => void window.api.browserUse({ action: 'select', tabId }).then(reply => { if (reply.ok) render(reply.data); }),
    onClose: tabId => void window.api.browserUse({ action: 'close', tabId }).then(reply => { if (reply.ok) render(reply.data); }),
    onCreate: () => void window.api.browserUse({ action: 'create' }).then(reply => { if (reply.ok) render(reply.data); else toast(reply.error); }),
    onClosePanel: () => { void hide(); options.toggle.focus(); }
  });

  const nav = el('form', 'browser-use-nav') as HTMLFormElement;
  const back = el('button', 'btn btn-icon browser-use-nav-button browser-use-back') as HTMLButtonElement;
  back.append(icon('i-chev'));
  const forward = el('button', 'btn btn-icon browser-use-nav-button browser-use-forward') as HTMLButtonElement;
  forward.append(icon('i-chev'));
  const reload = el('button', 'btn btn-icon browser-use-nav-button browser-use-reload') as HTMLButtonElement;
  reload.append(icon('i-retry'));
  const address = document.createElement('input');
  address.className = 'browser-use-address';
  address.type = 'text'; address.autocomplete = 'off'; address.spellcheck = false;
  address.maxLength = 4096;
  ui(address, 'placeholder', () => t('URL or search'));
  back.type = forward.type = reload.type = 'button';
  ui(back, 'aria-label', () => t('Back'));
  ui(forward, 'aria-label', () => t('Forward'));
  ui(reload, 'aria-label', () => t('Reload'));
  nav.append(back, forward, reload, address);

  const permission = el('div', 'browser-use-permission');
  permission.hidden = true;
  const permissionText = el('span', 'browser-use-permission-text');
  const once = el('button', 'btn', () => t('Allow once')) as HTMLButtonElement;
  const always = el('button', 'btn', () => t('Always allow')) as HTMLButtonElement;
  const deny = el('button', 'btn', () => t('Deny')) as HTMLButtonElement;
  for (const button of [once, always, deny]) button.type = 'button';
  permission.append(permissionText, once, always, deny);

  const surface = el('div', 'browser-use-surface');
  pane.append(tabStrip.root, nav, permission, surface);
  options.host.append(pane);

  let state: BrowserUseState | null = null;
  let frame = 0;
  let open = false;
  let lastLayout: BrowserUseBounds | null = null;

  function activeTab() {
    return state?.tabs.find(tab => tab.id === state?.activeTabId) ?? null;
  }

  function bounds() {
    const rect = surface.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      width: Math.max(0, rect.width),
      height: Math.max(0, rect.height)
    };
  }

  function sameBounds(left: BrowserUseBounds | null, right: BrowserUseBounds): boolean {
    return !!left && left.x === right.x && left.y === right.y &&
      left.width === right.width && left.height === right.height;
  }

  function sendLayoutNow(): void {
    if (!open || pane.hidden) return;
    window.cancelAnimationFrame(frame);
    frame = 0;
    const rect = bounds();
    if (rect.width < 1 || rect.height < 1 || sameBounds(lastLayout, rect)) return;
    if (window.api.browserUseLayoutSync(rect)) {
      lastLayout = rect;
    } else {
      // A destroyed/recreating native host must not strand the renderer at geometry main never
      // accepted. Let the ordinary one-way reconciliation retry on the next frame.
      lastLayout = null;
      syncLayout();
    }
  }

  function syncLayout(show = false): void {
    if (!open || pane.hidden) return;
    window.cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      const rect = bounds();
      if (rect.width < 1 || rect.height < 1) return;
      if (show) {
        lastLayout = rect;
        void window.api.browserUse({ action: 'show', bounds: rect });
      } else if (!sameBounds(lastLayout, rect)) {
        lastLayout = rect;
        window.api.browserUseLayout(rect);
      }
    });
  }

  // The remote page lives in a native View subtree, not in the DOM. During a drag, commit that
  // native host synchronously from the same pointer event that changes --work-panel-width so the
  // two compositor trees cannot paint different panel widths for one frame.
  attachWorkPanelResize(options.host, pane, { onResize: sendLayoutNow, nativeBoundary: true });

  function render(next: BrowserUseState): void {
    state = next;
    pane.classList.toggle('is-agent-active', next.agentActive);
    tabStrip.render(next.tabs, next.activeTabId);
    const active = activeTab();
    back.disabled = !active?.canGoBack;
    forward.disabled = !active?.canGoForward;
    reload.disabled = !active;
    if (document.activeElement !== address) address.value = active?.url === 'about:blank' ? '' : (active?.url ?? '');

    permission.hidden = !next.permission;
    if (next.permission) {
      permission.dataset.permissionId = next.permission.id;
      permissionText.textContent = `${t('Allow Browser Use to open')} ${next.permission.origin}?`;
    } else {
      delete permission.dataset.permissionId;
      permissionText.textContent = '';
    }
    if (open) syncLayout();
  }

  async function show(): Promise<void> {
    options.onShow?.();
    pane.hidden = false; open = true;
    options.host.classList.add('has-browser-panel');
    options.toggle.setAttribute('aria-expanded', 'true');
    window.requestAnimationFrame(tabStrip.refresh);
    syncLayout(true);
  }

  async function hide(): Promise<void> {
    if (open) await window.api.browserUse({ action: 'hide' });
    open = false; pane.hidden = true;
    lastLayout = null;
    options.host.classList.remove('has-browser-panel');
    options.toggle.setAttribute('aria-expanded', 'false');
  }

  options.toggle.addEventListener('click', () => { void (open ? hide() : show()); });
  back.addEventListener('click', () => { const tab = activeTab(); if (tab) void window.api.browserUse({ action: 'back', tabId: tab.id }).then(reply => { if (reply.ok) render(reply.data); }); });
  forward.addEventListener('click', () => { const tab = activeTab(); if (tab) void window.api.browserUse({ action: 'forward', tabId: tab.id }).then(reply => { if (reply.ok) render(reply.data); }); });
  reload.addEventListener('click', () => { const tab = activeTab(); if (tab) void window.api.browserUse({ action: 'reload', tabId: tab.id }).then(reply => { if (reply.ok) render(reply.data); }); });
  nav.addEventListener('submit', event => {
    event.preventDefault();
    const value = address.value.trim(); if (!value) return;
    const tab = activeTab();
    const action = tab ? window.api.browserUse({ action: 'navigate', tabId: tab.id, url: value }) : window.api.browserUse({ action: 'create', url: value });
    void action.then(reply => { if (reply.ok) render(reply.data); else toast(reply.error); });
  });

  function decide(decision: 'once' | 'always' | 'deny'): void {
    const id = permission.dataset.permissionId; if (!id) return;
    void window.api.browserUse({ action: 'approve', id, decision }).then(reply => { if (reply.ok) render(reply.data); else toast(reply.error); });
  }
  once.addEventListener('click', () => decide('once'));
  always.addEventListener('click', () => decide('always'));
  deny.addEventListener('click', () => decide('deny'));

  pane.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || document.activeElement === address) return;
    event.preventDefault(); void hide(); options.toggle.focus();
  });
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => sendLayoutNow()).observe(surface);
  window.addEventListener('resize', () => syncLayout());
  window.api.onBrowserUseShowRequested(() => { void show(); });
  window.api.onBrowserUseStateChanged(render);
  void run(window.api.browserUse({ action: 'query' })).then(next => { if (next) { render(next); if (next.open) void show(); } });

  return { hide, show };
}
