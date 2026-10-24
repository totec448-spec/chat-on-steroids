import type { AppApi } from '../preload/index.js';
import { currentLanguage, onLanguageChange, t, tn } from './i18n.js';

/**
 * Share a chat as a web page. The dialog always shows the page before anything is saved, in a frame
 * that runs nothing. Keys and tokens are always hidden; "Hide email addresses and user names" starts on
 * (sharing takes the chat outside the app), and a line says how many details the page hides. Save
 * writes the page shown, not a newer one: main keeps it by its preview id.
 */
export function initSharePage(api: Pick<AppApi, 'sharePage'>, saved: (name: string) => void): { open(sessionId: string): void } {
  const dialog = document.getElementById('sharePageDialog') as HTMLDialogElement;
  const form = document.getElementById('sharePageForm') as HTMLFormElement;
  const preview = document.getElementById('sharePagePreview')!;
  const frame = document.getElementById('sharePageFrame') as HTMLIFrameElement;
  const loading = document.getElementById('sharePageLoading')!;
  const hide = document.getElementById('sharePageHide') as HTMLInputElement;
  const count = document.getElementById('sharePageCount')!;
  const error = document.getElementById('sharePageError')!;
  const save = document.getElementById('sharePageSave') as HTMLButtonElement;
  let sessionId = '';
  let shown: { preview: string; hidden: number } | null = null;
  // Each preview request and each opening gets a new number; an answer for an older one is dropped.
  let generation = 0;
  let saving = false;

  // How many details the page shown hides; with the switch on and none found, it says so.
  const paintNote = () => {
    const text = !shown ? '' : shown.hidden
      ? tn('{0} detail is hidden on this page.', '{0} details are hidden on this page.', shown.hidden)
      : hide.checked ? t('Nothing to hide was found in this chat.') : '';
    count.hidden = !text;
    count.textContent = text;
  };
  const showError = (message: string | null) => {
    error.hidden = !message;
    error.textContent = message ? t(message) : '';
  };
  const paintControls = () => {
    save.disabled = saving || !shown;
    hide.disabled = saving;
    preview.setAttribute('aria-busy', String(!shown));
    loading.hidden = Boolean(shown) || !error.hidden;
  };
  const close = () => {
    generation += 1;
    if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
    frame.srcdoc = '';
  };

  const load = async () => {
    const asked = ++generation;
    shown = null;
    showError(null);
    paintNote();
    paintControls();
    try {
      const reply = await api.sharePage({ id: sessionId, target: 'preview', hide: hide.checked, lang: currentLanguage() });
      if (asked !== generation) return;
      if (!reply.ok) { frame.srcdoc = ''; showError(reply.error); return; }
      if (reply.data.done !== 'preview') return;
      // A link in the preview would open inside the frame; with nowhere to go it does nothing.
      frame.srcdoc = reply.data.html.replace('<head>', '<head>\n<base target="_blank">');
      shown = { preview: reply.data.preview, hidden: reply.data.hidden };
    } catch (failure) {
      if (asked === generation) { frame.srcdoc = ''; showError(failure instanceof Error ? failure.message : String(failure)); }
    } finally {
      if (asked === generation) { paintNote(); paintControls(); }
    }
  };

  hide.addEventListener('change', () => void load());
  onLanguageChange(() => { if (dialog.open) paintNote(); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving || !shown) return;
    saving = true;
    showError(null);
    paintControls();
    const opened = generation;
    try {
      const reply = await api.sharePage({ id: sessionId, target: 'file', preview: shown.preview });
      if (opened !== generation) return;
      if (!reply.ok) { showError(reply.error); return; }
      if (reply.data.done === 'saved') { close(); saved(reply.data.name); }
    } catch (failure) {
      if (opened === generation) showError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      saving = false;
      paintControls();
      // Save was disabled while it ran, which took the focus off it; a keyboard user carries on from Save.
      if (dialog.open && !save.disabled && (document.activeElement === document.body || !dialog.contains(document.activeElement))) save.focus();
    }
  });
  for (const id of ['sharePageCancel', 'sharePageClose']) document.getElementById(id)!.addEventListener('click', () => close());
  // Escape while the save dialog is open belongs to that dialog; here it closes like Cancel.
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!saving) close(); });

  return {
    open(id: string) {
      sessionId = id;
      // Sharing takes the chat outside the app: hiding starts on, and showing them is a choice.
      hide.checked = true;
      saving = false;
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
      void load();
      hide.focus();
    }
  };
}
