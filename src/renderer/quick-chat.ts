import type { QuickChatApi } from '../preload/index.js';
import type { AppState } from '../shared/types.js';
import { resolveTheme } from '../shared/appearance.js';
import { applyAppearance } from './appearance.js';
import { chatApply, chatVisible, initChat, openChatSearch, selectedChatId } from './chat.js';
import { initLanguage, setLanguage, currentLanguage, t, ui } from './i18n.js';
import { icon, toast } from './dom.js';

const api = window.api;
const native = (window as unknown as { quickChat: QuickChatApi }).quickChat;
const top = document.querySelector<HTMLElement>('.app-topbar')!;
const input = document.getElementById('chatInput') as HTMLTextAreaElement;
let state: AppState | null = null;
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

function failure(error: unknown): void {
  const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error);
  toast(t(message));
}


function button(id: string, label: string, glyph: string, action: () => void): HTMLButtonElement {
  const control = document.createElement('button');
  control.type = 'button'; control.className = 'btn compact-action'; control.id = id;
  control.append(icon(glyph));
  ui(control, 'title', () => t(label)); ui(control, 'aria-label', () => t(label));
  control.addEventListener('click', action);
  return control;
}
const search = button('quickSearch', 'History', 'i-clock', () => openChatSearch(true));
search.setAttribute('aria-haspopup', 'dialog'); search.setAttribute('aria-controls', 'searchDialog');
const fresh = button('quickNew', 'New chat', 'i-pencil', () => document.getElementById('newChat')?.click());
const title = document.createElement('div'); title.className = 'compact-title';
const titleText = document.getElementById('chatTitle')!;
title.append(titleText);
const pin = button('quickPin', 'Always on top', 'i-pin', () => {
  void native.pin(pin.getAttribute('aria-pressed') !== 'true').then(value => pin.setAttribute('aria-pressed', String(value))).catch(failure);
});
pin.setAttribute('aria-pressed', 'true');
const expand = button('quickExpand', 'Open in workspace', 'i-out', () => {
  void native.expand(selectedChatId()).then(opened => { if (!opened) toast(t('Quick chat is not available')); }).catch(failure);
});
const close = button('quickClose', 'Close', 'i-x', () => { void native.hide().catch(failure); });
top.append(search, fresh, title, pin, expand, close);

initLanguage();
ui(document.querySelector<HTMLElement>('#timelineEmpty > span')!, 'textContent', () => t('How can I help?'));
initChat({ compact: true, state: () => state, save: async () => false, palette: {
  showChat: () => {}, actions: () => [], settings: () => []
} });
function appearance(): void {
  if (state) applyAppearance(resolveTheme(state.config.ui.theme, systemDark.matches), state.config.ui.appearance);
}
function apply(next: AppState): void {
  const previous = state;
  state = next;
  if (next.config.ui.language && next.config.ui.language !== currentLanguage()) setLanguage(next.config.ui.language);
  appearance();
  chatApply(next, previous?.config);
}
let revision = 0;
api.onStateChanged(next => { ++revision; apply(next); });
async function refresh(): Promise<void> {
  const generation = ++revision;
  const result = await api.getState();
  if (generation === revision && result.ok) apply(result.data);
  if (state && !document.hidden) chatVisible(true);
}
function shown(): void { void refresh().catch(() => undefined); if (document.activeElement === document.body) input.focus({ preventScroll: true }); }
native.onShown(shown);
document.addEventListener('visibilitychange', () => { if (document.hidden) chatVisible(false); else if (state) chatVisible(true); });
systemDark.addEventListener('change', appearance);
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing ||
      document.querySelector('dialog[open], .composer-menu[open]') ||
      (event.target as Element | null)?.closest('select')) return;
  event.preventDefault(); void native.hide().catch(failure);
});
// The native window stays hidden until the compact layout and actual user theme are applied.
void (async () => {
  try { await refresh(); } catch { /* Default styling still provides a usable panel. */ }
  await Promise.race([document.fonts.ready, new Promise<void>(resolve => window.setTimeout(resolve, 250))]);
  input.focus({ preventScroll: true });
  await native.ready();
})().catch(failure);
