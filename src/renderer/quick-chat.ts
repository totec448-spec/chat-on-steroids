import type { QuickChatApi } from '../preload/index.js';
import type { AppState } from '../shared/types.js';
import { resolveTheme } from '../shared/appearance.js';
import { applyAppearance } from './appearance.js';
import { attachComposerContext, clearAutomaticComposerContext, chatApply, chatVisible, initChat, openChatSearch, prefillComposer, selectedChatId, setComposerContextPending } from './chat.js';
import { initLanguage, setLanguage, currentLanguage, t, ui } from './i18n.js';
import { icon, toast } from './dom.js';
import type { QuickChatAnswerRef } from '../shared/quick-chat.js';

const api = window.api;
const native = (window as unknown as { quickChat: QuickChatApi }).quickChat;
const top = document.querySelector<HTMLElement>('.app-topbar')!;
const input = document.getElementById('chatInput') as HTMLTextAreaElement;
let state: AppState | null = null;
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
let contextRevision = 0;
let captureRequest = 0;
let capturing: 'automatic' | 'manual' | null = null;
let invocation = -1;
let pendingInvocation: { epoch: number; automatic: boolean; direct: boolean } | null = null;

function failure(error: unknown): void {
  const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error);
  toast(t(message));
}

async function capture(kind: 'selection' | 'screenshot', prompt?: string, automaticEpoch?: number): Promise<void> {
  const automatic = automaticEpoch !== undefined;
  if (capturing === 'manual' || (automatic && capturing)) return;
  const request = ++captureRequest;
  capturing = automatic ? 'automatic' : 'manual';
  const revision = contextRevision;
  const stillCurrent = () => request === captureRequest && revision === contextRevision && !document.hidden;
  let replacementAvailable = false;
  let added = false;
  if (kind === 'selection') document.body.classList.remove('quick-selection-ready');
  contextMenu.setAttribute('aria-busy', 'true');
  refreshContext.disabled = true; refreshContext.setAttribute('aria-busy', 'true');
  captureStatus.textContent = t('Capturing context…'); captureStatus.hidden = false;
  if (kind === 'screenshot') setComposerContextPending(true);
  try {
    added = await attachComposerContext(async () => {
      const result = automaticEpoch === undefined ? await native.capture(kind) : await native.automatic(automaticEpoch);
      if (!result || !stillCurrent()) return null;
      // Generated names are unique even in the provider's existing upload history.
      const suffix = crypto.randomUUID().slice(0, 8);
      if (result.kind === 'selection') {
        replacementAvailable = result.replacementAvailable;
        const text = `${result.source}\n\nSelected text (verbatim):\n${result.text}`;
        return { files: [new File([text], `selected-text-${suffix}.txt`, { type: 'text/plain' })], preview: { kind: result.kind, title: result.title, application: result.application, text } };
      }
      const files = [new File([result.text], `window-context-${suffix}.txt`, { type: 'text/plain' })];
      if (result.base64) {
        const bytes = Uint8Array.from(atob(result.base64), char => char.charCodeAt(0));
        files.push(new File([bytes], `window-screenshot-${suffix}.png`, { type: 'image/png' }));
      }
      return { files, preview: { kind: result.kind, title: result.title, application: result.application, text: result.text, automatic } };
    }, stillCurrent);
    if (added && stillCurrent() && prompt) prefillComposer(t(prompt));
    if (added && replacementAvailable && stillCurrent()) document.body.classList.add('quick-selection-ready');
  } catch (error) { if (!automatic && stillCurrent()) failure(error); }
  finally {
    if (request === captureRequest) {
      capturing = null; contextMenu.removeAttribute('aria-busy');
      setComposerContextPending(false);
      refreshContext.disabled = false; refreshContext.removeAttribute('aria-busy');
      captureStatus.textContent = t('No window context'); captureStatus.hidden = added || !automatic || !stillCurrent();
    }
  }
}

// The same draft and normal Send path are used by all quick actions.
const contextMenu = document.createElement('details');
contextMenu.className = 'composer-menu quick-context-menu';
contextMenu.id = 'quickContext';
const contextTrigger = document.createElement('summary');
contextTrigger.append(icon('i-monitor'));
ui(contextTrigger, 'title', () => t('Desktop context')); ui(contextTrigger, 'aria-label', () => t('Desktop context'));
const contextChoices = document.createElement('div'); contextChoices.className = 'composer-popover';
function contextChoice(id: string, label: string, glyph: string, run: () => void): void {
  const choice = document.createElement('button'); choice.id = id; choice.type = 'button';
  const copy = document.createElement('span'); ui(copy, 'textContent', () => t(label));
  choice.append(icon(glyph), copy);
  choice.addEventListener('click', () => { contextMenu.open = false; run(); });
  contextChoices.append(choice);
}
contextChoice('quickCaptureWindow', 'Attach active window', 'i-image', () => void capture('screenshot'));
contextChoice('quickCaptureSelection', 'Attach selected text', 'i-file-text', () => void capture('selection'));
const separator = document.createElement('div'); separator.className = 'quick-context-divider'; contextChoices.append(separator);
for (const [id, label, glyph, prompt] of [
  ['quickExplain', 'Explain selection', 'i-chat', 'Explain the attached text clearly.'],
  ['quickSummarize', 'Summarize selection', 'i-steps', 'Summarize the attached text concisely.'],
  ['quickRewrite', 'Rewrite selection', 'i-pencil', 'Rewrite the attached text for clarity, preserving its meaning and language. Return only the revised text.'],
  ['quickTranslate', 'Translate selection', 'i-globe', 'Translate the attached text into [target language]. Return only the translation.']
] as const) contextChoice(id, label, glyph, () => void capture('selection', prompt));
contextMenu.append(contextTrigger, contextChoices);
document.querySelector('#attachmentMenu')!.after(contextMenu);
document.addEventListener('pointerdown', event => { if (!contextMenu.contains(event.target as Node)) contextMenu.open = false; }, true);
contextMenu.addEventListener('keydown', event => { if (event.key === 'Escape' && contextMenu.open) { event.preventDefault(); contextMenu.open = false; contextTrigger.focus(); } });

async function replaceAnswer(ref: QuickChatAnswerRef): Promise<void> {
  const revision = contextRevision;
  try {
    const answer = await native.answer(ref);
    if (revision !== contextRevision || selectedChatId() !== ref.id) return;
    // The user sees and can edit the exact text before it is inserted in the source application.
    const dialog = document.createElement('dialog'); dialog.className = 'quick-replace-dialog';
    const title = document.createElement('h2'); title.textContent = t('Replace selected text');
    const description = document.createElement('p'); description.textContent = t('Review the text before replacing the selection in the original window.');
    const source = document.createElement('div'); source.className = 'quick-replace-source';
    const sourceTitle = document.createElement('strong'); sourceTitle.textContent = answer.source.title;
    const sourceSelection = document.createElement('div'); sourceSelection.textContent = answer.source.selection;
    source.append(sourceTitle, sourceSelection);
    const editor = document.createElement('textarea'); editor.value = answer.text; editor.dir = 'auto'; editor.maxLength = 64000; editor.setAttribute('aria-label', t('Replacement text'));
    const actions = document.createElement('div'); actions.className = 'quick-replace-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn'; cancel.textContent = t('Cancel'); cancel.onclick = () => dialog.close();
    const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'btn btn-primary'; confirm.textContent = t('Replace');
    confirm.onclick = async () => {
      if (revision !== contextRevision || selectedChatId() !== ref.id) { dialog.close(); failure(new Error('The source window changed')); return; }
      confirm.disabled = true; cancel.disabled = true;
      try { await native.replace(editor.value, answer.epoch); dialog.close(); }
      catch (error) { dialog.close(); failure(error); }
    };
    actions.append(cancel, confirm); dialog.append(title, description, source, editor, actions);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    document.body.append(dialog); dialog.showModal(); editor.focus();
  } catch (error) { failure(error); }
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
const captureStatus = document.createElement('span'); captureStatus.className = 'quick-capture-status'; captureStatus.hidden = true; captureStatus.setAttribute('role', 'status');
title.append(titleText, captureStatus);
const pin = button('quickPin', 'Always on top', 'i-pin', () => {
  void native.pin(pin.getAttribute('aria-pressed') !== 'true').then(value => pin.setAttribute('aria-pressed', String(value)));
});
pin.setAttribute('aria-pressed', 'true');
const refreshContext = button('quickRefreshContext', 'Refresh window context', 'i-retry', () => void capture('screenshot'));
const expand = button('quickExpand', 'Open in workspace', 'i-out', () => { void native.expand(selectedChatId()); });
const close = button('quickClose', 'Close', 'i-x', () => { void native.hide(); });
top.append(search, fresh, title, refreshContext, pin, expand, close);

initLanguage();
ui(document.querySelector<HTMLElement>('#timelineEmpty > span')!, 'textContent', () => t('How can I help?'));
initChat({ compact: true, replaceAnswer: ref => void replaceAnswer(ref), state: () => state, save: async () => false, palette: {
  showChat: () => {}, actions: () => [], settings: () => []
} });
function appearance(): void {
  if (state) applyAppearance(resolveTheme(state.config.ui.theme, systemDark.matches), state.config.ui.appearance);
}
function apply(next: AppState): void {
  const previous = state;
  state = next;
  if (next.config.ui.quickChatAutoCapture === false && capturing === 'automatic') {
    ++captureRequest; capturing = null; contextMenu.removeAttribute('aria-busy');
    setComposerContextPending(false);
    refreshContext.disabled = false; refreshContext.removeAttribute('aria-busy'); captureStatus.hidden = true;
  }
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
function invalidateContext(): void {
  ++contextRevision; ++captureRequest; capturing = null; contextMenu.removeAttribute('aria-busy'); captureStatus.hidden = true; document.body.classList.remove('quick-selection-ready');
  refreshContext.disabled = false; refreshContext.removeAttribute('aria-busy');
  setComposerContextPending(false);
  document.querySelector<HTMLDialogElement>('.quick-replace-dialog[open]')?.close();
}
function captureInvocation(): void {
  if (pendingInvocation === null || document.hidden) return;
  const { epoch, automatic, direct } = pendingInvocation; pendingInvocation = null;
  if (!direct) clearAutomaticComposerContext();
  if (automatic) void capture('screenshot', undefined, epoch);
}
native.onShown((epoch, automatic, direct) => {
  if (epoch <= invocation) return;
  invocation = epoch; invalidateContext(); pendingInvocation = { epoch, automatic, direct }; shown(); captureInvocation();
});
document.addEventListener('visibilitychange', () => { if (document.hidden) { invalidateContext(); pendingInvocation = null; chatVisible(false); } else { captureInvocation(); if (state) chatVisible(true); } });
systemDark.addEventListener('change', appearance);
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing ||
      document.querySelector('dialog[open], .composer-menu[open]') ||
      (event.target as Element | null)?.closest('select')) return;
  event.preventDefault(); void native.hide();
});
// The native window stays hidden until the compact layout and actual user theme are applied.
void (async () => {
  try { await refresh(); } catch { /* Default styling still provides a usable panel. */ }
  await Promise.race([document.fonts.ready, new Promise<void>(resolve => window.setTimeout(resolve, 250))]);
  input.focus({ preventScroll: true });
  await native.ready();
})().catch(failure);
