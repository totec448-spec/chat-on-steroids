/** Tab strip of a CoS browser window. It only paints state from main and reports clicks. */
interface ToolbarTab { id: number; title: string; url: string; favicon: string | null; active: boolean; loading: boolean; working: boolean }
interface ToolbarState {
  tabs: ToolbarTab[];
  navigation: { back: boolean; forward: boolean; loading: boolean };
  connected: boolean | null;
  companionIcon: string | null;
  tokens: Record<string, string>;
  insets: { left: number; right: number };
}
type ToolbarAction = 'activate' | 'close' | 'reload' | 'stop' | 'back' | 'forward' | 'extension';

const api = (window as unknown as {
  cosBrowser: { act(action: ToolbarAction, tabId?: number): void; onState(listener: (state: ToolbarState) => void): void };
}).cosBrowser;

const strip = document.getElementById('tabs')!;
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
const tabs = new Map<number, { root: HTMLElement; glyph: HTMLElement; title: HTMLElement; close: HTMLButtonElement; key: string }>();
let activeId: number | null = null;
let loading = false;

function createTab(id: number) {
  const root = document.createElement('div');
  root.className = 'tab';
  root.setAttribute('role', 'tab');
  root.addEventListener('mousedown', event => { if (event.button === 0) api.act('activate', id); });
  // Middle click closes a tab, as in every browser.
  root.addEventListener('auxclick', event => { if (event.button === 1) { event.preventDefault(); api.act('close', id); } });
  const glyph = document.createElement('span');
  glyph.className = 'glyph';
  const title = document.createElement('span');
  title.className = 'title';
  const close = document.createElement('button');
  close.className = 'close';
  close.type = 'button';
  close.innerHTML = '<i class="ph ph-x" aria-hidden="true"></i>';
  close.addEventListener('mousedown', event => event.stopPropagation());
  close.addEventListener('click', event => { event.stopPropagation(); api.act('close', id); });
  root.append(glyph, title, close);
  return { root, glyph, title, close, key: '' };
}

/** The favicon, or a spinner while loading, under the dot that marks a tab the companion works in. */
function paintGlyph(glyph: HTMLElement, tab: ToolbarTab): void {
  const icon = tab.loading ? document.createElement('span') : tab.favicon ? document.createElement('img') : document.createElement('i');
  if (icon instanceof HTMLImageElement) { icon.src = tab.favicon!; icon.alt = ''; icon.className = 'favicon'; icon.draggable = false; }
  else if (tab.loading) icon.className = 'spinner';
  else { icon.className = 'ph ph-chat-circle'; icon.setAttribute('aria-hidden', 'true'); }
  const dot = document.createElement('span');
  dot.className = 'activity';
  glyph.replaceChildren(icon, dot);
}

function paint(state: ToolbarState): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(state.tokens)) root.style.setProperty(name, value);
  root.style.setProperty('--inset-left', `${state.insets.left}px`);
  root.style.setProperty('--inset-right', `${state.insets.right}px`);

  const seen = new Set<number>();
  state.tabs.forEach((tab, index) => {
    seen.add(tab.id);
    let item = tabs.get(tab.id);
    if (!item) { item = createTab(tab.id); tabs.set(tab.id, item); }
    if (strip.children[index] !== item.root) strip.insertBefore(item.root, strip.children[index] ?? null);
    item.root.setAttribute('aria-selected', String(tab.active));
    item.root.dataset.working = String(tab.working);
    item.root.title = tab.title;
    item.title.textContent = tab.title;
    item.close.setAttribute('aria-label', `Close ${tab.title}`);
    item.close.title = 'Close tab';
    const key = `${tab.loading}|${tab.favicon}`;
    if (key !== item.key) { item.key = key; paintGlyph(item.glyph, tab); }
  });
  for (const [id, item] of tabs) if (!seen.has(id)) { item.root.remove(); tabs.delete(id); }

  activeId = state.tabs.find(tab => tab.active)?.id ?? null;
  loading = state.navigation.loading;
  button('back').disabled = activeId === null || !state.navigation.back;
  button('forward').disabled = activeId === null || !state.navigation.forward;
  button('reload').disabled = activeId === null;
  // Reload becomes Stop while the page loads.
  document.getElementById('reloadGlyph')!.className = `ph ${loading ? 'ph-x' : 'ph-arrow-clockwise'}`;
  button('reload').title = loading ? 'Stop' : 'Reload';
  button('reload').setAttribute('aria-label', button('reload').title);

  // The companion's own glyph, tinted like every other toolbar icon through a mask.
  const mark = document.getElementById('companionMark')!;
  const image = state.companionIcon ? `url("${state.companionIcon}")` : '';
  if (mark.style.maskImage !== image) { mark.style.maskImage = image; mark.style.webkitMaskImage = image; }
  mark.hidden = !state.companionIcon;
  document.getElementById('companionFallback')!.hidden = Boolean(state.companionIcon);
  document.getElementById('companionStatus')!.dataset.state = state.connected === null ? 'unknown' : state.connected ? 'connected' : 'disconnected';
}

api.onState(paint);
button('back').addEventListener('click', () => { if (activeId !== null) api.act('back', activeId); });
button('forward').addEventListener('click', () => { if (activeId !== null) api.act('forward', activeId); });
button('reload').addEventListener('click', () => { if (activeId !== null) api.act(loading ? 'stop' : 'reload', activeId); });
button('companion').addEventListener('click', () => api.act('extension'));
