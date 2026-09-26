import type { BrowserUseBounds, BrowserUseState } from '../shared/browser-use.js';
import { el, icon, run, toast } from './dom.js';
import { t, ui } from './i18n.js';
import { attachWorkPanelResize } from './work-panel-resize.js';
import { createBrowserTabStrip } from './browser-tab-strip.js';
import type { BrowserUseDesignContext } from '../shared/browser-use.js';

/** Browser chrome lives in the renderer; only the page rectangle is a native WebContentsView. */
export function createBrowserPanel(options: {
  host: HTMLElement;
  toggle: HTMLButtonElement;
  onShow?: () => void;
  captureAskAgent?: () => ((context: BrowserUseDesignContext) => boolean);
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
  const inspect = el('button', 'btn btn-icon browser-use-nav-button browser-use-inspect') as HTMLButtonElement;
  inspect.append(icon('i-inspect'));
  const address = document.createElement('input');
  address.className = 'browser-use-address';
  address.type = 'text'; address.autocomplete = 'off'; address.spellcheck = false;
  address.maxLength = 4096;
  ui(address, 'placeholder', () => t('URL or search'));
  back.type = forward.type = reload.type = inspect.type = 'button';
  ui(back, 'aria-label', () => t('Back'));
  ui(forward, 'aria-label', () => t('Forward'));
  ui(reload, 'aria-label', () => t('Reload'));
  ui(inspect, 'aria-label', () => t('Inspect page design'));
  ui(inspect, 'title', () => t('Inspect page design'));
  inspect.setAttribute('aria-pressed', 'false');
  nav.append(back, forward, reload, address, inspect);

  const permission = el('div', 'browser-use-permission');
  permission.hidden = true;
  permission.setAttribute('role', 'alert');
  permission.setAttribute('aria-live', 'polite');
  const permissionText = el('span', 'browser-use-permission-text');
  const once = el('button', 'btn', () => t('Allow once')) as HTMLButtonElement;
  const always = el('button', 'btn', () => t('Always allow')) as HTMLButtonElement;
  const deny = el('button', 'btn', () => t('Deny')) as HTMLButtonElement;
  for (const button of [once, always, deny]) button.type = 'button';
  permission.append(permissionText, once, always, deny);

  const design = el('div', 'browser-use-design');
  design.hidden = true;
  const designSummary = el('div', 'browser-use-design-summary');
  designSummary.setAttribute('role', 'status');
  designSummary.setAttribute('aria-live', 'polite');
  designSummary.append(icon('i-inspect', 'ico browser-use-design-icon'));
  const designCopy = el('div', 'browser-use-design-copy');
  const designHeading = el('div', 'browser-use-design-heading');
  const designTag = el('code', 'browser-use-design-tag');
  const designName = el('span', 'browser-use-design-name');
  designHeading.append(designTag, designName);
  const designSelector = el('code', 'browser-use-design-selector');
  designCopy.append(designHeading, designSelector);
  const designSize = el('span', 'browser-use-design-size');
  const designAsk = el('button', 'btn browser-use-design-ask') as HTMLButtonElement;
  designAsk.type = 'button';
  designAsk.hidden = true;
  designAsk.append(icon('i-chat'), el('span', '', () => t('Ask agent')));
  ui(designAsk, 'title', () => t('Add this element and its screenshot to the composer'));
  ui(designAsk, 'aria-label', () => t('Ask the agent about this element'));
  designSummary.append(designCopy, designSize, designAsk);
  const designDetails = el('div', 'browser-use-design-details');
  designDetails.hidden = true;
  const designSources = el('div', 'browser-use-design-row browser-use-design-sources-row');
  designSources.hidden = true;
  designSources.append(el('span', 'browser-use-design-label', () => t('Source')));
  const designSourcesValue = el('code', 'browser-use-design-value browser-use-design-sources');
  designSources.append(designSourcesValue);
  const designClasses = el('div', 'browser-use-design-row');
  designClasses.append(el('span', 'browser-use-design-label', () => t('Classes')));
  const designClassesValue = el('code', 'browser-use-design-value');
  designClasses.append(designClassesValue);
  const designBox = el('div', 'browser-use-design-row');
  designBox.append(el('span', 'browser-use-design-label', () => t('Box model')));
  const designBoxValue = el('code', 'browser-use-design-value');
  designBox.append(designBoxValue);
  const designComputed = el('div', 'browser-use-design-computed');
  designComputed.append(el('span', 'browser-use-design-label', () => t('Computed')));
  const designStyles = el('dl', 'browser-use-design-styles');
  designComputed.append(designStyles);
  designDetails.append(designSources, designClasses, designBox, designComputed);
  design.append(designSummary, designDetails);

  const surface = el('div', 'browser-use-surface');
  pane.append(tabStrip.root, nav, permission, design, surface);
  options.host.append(pane);

  let state: BrowserUseState | null = null;
  let frame = 0;
  let open = false;
  let lastLayout: BrowserUseBounds | null = null;
  let revealPending = false;
  let askingSelectionId: number | null = null;

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

  function edgeSummary(edges: [string, string, string, string]): string {
    const [top, right, bottom, left] = edges;
    if (top === right && top === bottom && top === left) return top;
    if (top === bottom && right === left) return `${top} ${right}`;
    if (right === left) return `${top} ${right} ${bottom}`;
    return edges.join(' ');
  }

  function sourceLocation(url: string, line: number | null, column: number | null): string {
    const path = url.replace(/[?#].*$/, '').replace(/\\/g, '/');
    const parts = path.split('/').filter(Boolean);
    const file = parts.slice(-2).join('/') || url;
    return `${file}${line === null ? '' : `:${line}${column === null ? '' : `:${column}`}`}`;
  }

  function requestShow(rect: BrowserUseBounds): void {
    revealPending = false;
    lastLayout = rect;
    void window.api.browserUse({ action: 'show', bounds: rect }).then(reply => {
      if (!open || pane.hidden) return;
      if (reply.ok) render(reply.data);
      else {
        lastLayout = null;
        toast(reply.error);
      }
    });
  }

  function sendLayoutNow(): void {
    if (!open || pane.hidden) return;
    window.cancelAnimationFrame(frame);
    frame = 0;
    const rect = bounds();
    if (rect.width < 1 || rect.height < 1) return;
    if (revealPending) {
      requestShow(rect);
      return;
    }
    if (sameBounds(lastLayout, rect)) return;
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
    if (show) revealPending = true;
    window.cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      const rect = bounds();
      if (rect.width < 1 || rect.height < 1) return;
      if (revealPending) {
        requestShow(rect);
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
    const inspecting = next.design.active && next.design.tabId === active?.id;
    // Once Inspect owns the page, its exit control must stay available even if the inspected
    // document starts loading before the navigation lifecycle retires that ownership.
    inspect.disabled = !active || (active.loading && !inspecting);
    inspect.setAttribute('aria-pressed', String(inspecting));
    if (document.activeElement !== address) address.value = active?.url === 'about:blank' ? '' : (active?.url ?? '');

    design.hidden = !inspecting;
    if (inspecting) {
      const selection = next.design.selection;
      designTag.textContent = selection ? `<${selection.tag || 'element'}>` : t('Inspecting page');
      designName.textContent = selection
        ? [selection.role, selection.name].filter(Boolean).join(' · ')
        : t('Hover to highlight, then click an element.');
      designSelector.textContent = selection?.selector ?? t('Selection stays bound to this page.');
      designSize.hidden = !selection;
      designSize.textContent = selection ? `${selection.width} × ${selection.height}` : '';
      designAsk.hidden = !selection || !options.captureAskAgent;
      designAsk.disabled = askingSelectionId !== null;
      designAsk.setAttribute('aria-busy', String(askingSelectionId !== null));
      designDetails.hidden = !selection;
      if (selection) {
        designSources.hidden = selection.sources.length === 0;
        designSourcesValue.textContent = selection.sources
          .map(source => `${source.framework} ${sourceLocation(source.url, source.line, source.column)}`)
          .join(' · ');
        designSourcesValue.title = selection.sources
          .map(source => `${source.framework}${source.label ? ` ${source.label}` : ''}: ${source.url}${source.line === null ? '' : `:${source.line}${source.column === null ? '' : `:${source.column}`}`}`)
          .join('\n');
        designClassesValue.textContent = selection.classes.length
          ? selection.classes.map(name => `.${name}`).join(' ')
          : t('None');
        designBoxValue.textContent = [
          `margin ${edgeSummary(selection.boxModel.margin)}`,
          `border ${edgeSummary(selection.boxModel.border)}`,
          `padding ${edgeSummary(selection.boxModel.padding)}`,
          `content ${selection.boxModel.contentWidth} × ${selection.boxModel.contentHeight}`
        ].join(' · ');
        designClassesValue.title = designClassesValue.textContent;
        designBoxValue.title = designBoxValue.textContent;
        designStyles.replaceChildren(...selection.styles.map(style => {
          const item = el('div', 'browser-use-design-style');
          item.title = `${style.property}: ${style.value || '—'}`;
          item.append(el('dt', '', style.property), el('dd', '', style.value || '—'));
          return item;
        }));
      } else {
        designSources.hidden = true;
        designSourcesValue.textContent = '';
        designSourcesValue.removeAttribute('title');
        designClassesValue.textContent = '';
        designBoxValue.textContent = '';
        designClassesValue.removeAttribute('title');
        designBoxValue.removeAttribute('title');
        designStyles.replaceChildren();
      }
    } else {
      designTag.textContent = '';
      designName.textContent = '';
      designSelector.textContent = '';
      designSize.textContent = '';
      designSize.hidden = true;
      designAsk.hidden = true;
      designAsk.disabled = false;
      designAsk.setAttribute('aria-busy', 'false');
      designDetails.hidden = true;
      designSources.hidden = true;
      designSourcesValue.textContent = '';
      designSourcesValue.removeAttribute('title');
      designClassesValue.textContent = '';
      designBoxValue.textContent = '';
      designClassesValue.removeAttribute('title');
      designBoxValue.removeAttribute('title');
      designStyles.replaceChildren();
    }

    permission.hidden = !next.permission;
    if (next.permission) {
      permission.dataset.permissionId = next.permission.id;
      permissionText.textContent = t(
        'Allow access to {0}? The agent must retry navigation after approval.',
        [next.permission.origin]
      );
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
    revealPending = false;
    window.cancelAnimationFrame(frame);
    frame = 0;
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
  inspect.addEventListener('click', () => {
    const tab = activeTab(); if (!tab) return;
    const enabled = !(state?.design.active && state.design.tabId === tab.id);
    void window.api.browserUse({ action: 'inspect', tabId: tab.id, enabled }).then(reply => {
      if (reply.ok) render(reply.data);
      else toast(reply.error);
    });
  });
  designAsk.addEventListener('click', async () => {
    const tab = activeTab();
    const selection = state?.design.selection;
    if (!tab || !selection || askingSelectionId !== null) return;
    const accept = options.captureAskAgent?.();
    if (!accept) return;
    askingSelectionId = selection.id;
    designAsk.disabled = true;
    designAsk.setAttribute('aria-busy', 'true');
    try {
      const reply = await window.api.browserUseDesignContext(tab.id, selection.id);
      if (!reply.ok) { toast(reply.error); return; }
      if (!accept(reply.data)) toast(t('The selection was not added because the composer changed.'));
    } finally {
      if (askingSelectionId === selection.id) askingSelectionId = null;
      designAsk.disabled = false;
      designAsk.setAttribute('aria-busy', 'false');
    }
  });
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
    if (event.key !== 'Escape') return;
    const tab = activeTab();
    if (tab && state?.design.active && state.design.tabId === tab.id) {
      event.preventDefault();
      void window.api.browserUse({ action: 'inspect', tabId: tab.id, enabled: false }).then(reply => {
        if (reply.ok) render(reply.data);
      });
      inspect.focus();
      return;
    }
    if (document.activeElement === address) return;
    event.preventDefault(); void hide(); options.toggle.focus();
  });
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => sendLayoutNow()).observe(surface);
  window.addEventListener('resize', () => syncLayout());
  window.api.onBrowserUseShowRequested(() => { void show(); });
  window.api.onBrowserUseStateChanged(render);
  void run(window.api.browserUse({ action: 'query' })).then(next => { if (next) { render(next); if (next.open) void show(); } });

  return { hide, show };
}
