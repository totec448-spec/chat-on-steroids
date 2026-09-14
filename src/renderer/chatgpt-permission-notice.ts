import { t } from './i18n.js';
import type { ChatgptPermissionNotice } from '../shared/chatgpt-permission-notice.js';

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

export interface ChatgptPermissionNoticeApi {
  getChatgptPermissionNotice: () => Promise<Reply<ChatgptPermissionNotice>>;
  acknowledgeChatgptPermissionNotice: () => Promise<Reply<ChatgptPermissionNotice>>;
  onChatgptPermissionNotice: (listener: (state: ChatgptPermissionNotice) => void) => (() => void);
}

/**
 * Owns the app-side reminder for the provider's separate permission request.
 * The backend decides when the reminder is owed and persists acknowledgement;
 * this renderer only presents the newest revision and records an explicit dismiss.
 */
export function initChatgptPermissionNotice(api: ChatgptPermissionNoticeApi): () => void {
  const dialog = document.getElementById('chatgptPermissionNotice') as HTMLDialogElement | null;
  const acknowledge = document.getElementById('chatgptPermissionUnderstand') as HTMLButtonElement | null;
  const close = document.getElementById('chatgptPermissionClose') as HTMLButtonElement | null;
  const status = document.getElementById('chatgptPermissionStatus') as HTMLElement | null;
  if (!dialog || !acknowledge || !close || !status) return () => {};

  let current: ChatgptPermissionNotice | null = null;
  let acknowledging = false;
  let destroyed = false;
  let returnFocus: HTMLElement | null = null;

  const competingDialogOpen = (): boolean =>
    [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].some(candidate => candidate !== dialog);

  const restoreFocus = (): void => {
    const target = returnFocus;
    returnFocus = null;
    if (target?.isConnected && !target.hasAttribute('disabled')) target.focus();
  };

  const maybeShow = (): void => {
    if (destroyed || !current?.pending || dialog.open || competingDialogOpen()) return;
    returnFocus = document.activeElement instanceof window.HTMLElement ? document.activeElement : null;
    status.textContent = '';
    dialog.showModal();
    acknowledge.focus();
  };

  const publish = (next: ChatgptPermissionNotice): boolean => {
    if (!next || !Number.isSafeInteger(next.revision) || next.revision < 0 || typeof next.pending !== 'boolean') return false;
    if (current && next.revision < current.revision) return false;
    current = next;
    if (!next.pending) {
      if (dialog.open) dialog.close();
      return true;
    }
    maybeShow();
    return true;
  };

  const acknowledgePending = async (): Promise<void> => {
    if (acknowledging || !current?.pending) return;
    acknowledging = true;
    acknowledge.disabled = true;
    close.disabled = true;
    status.textContent = '';
    try {
      const result = await api.acknowledgeChatgptPermissionNotice();
      if (!result.ok) {
        status.textContent = t("Could not save this acknowledgement. Try again. {0}", [result.error]);
        return;
      }
      publish(result.data);
      // A stale successful acknowledgement cannot dismiss a newer pending revision.
      if (current?.pending) status.textContent = t("A newer permission notice is still pending.");
    } catch (error) {
      status.textContent = t("Could not save this acknowledgement. Try again. {0}", [error instanceof Error ? error.message : String(error)]);
    } finally {
      acknowledging = false;
      acknowledge.disabled = false;
      close.disabled = false;
    }
  };

  acknowledge.addEventListener('click', () => void acknowledgePending());
  close.addEventListener('click', () => void acknowledgePending());
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    void acknowledgePending();
  });
  dialog.addEventListener('close', restoreFocus);

  // Close does not bubble, so listen during capture. Any other dialog completing is
  // an opportunity to present a pending reminder without polling or replacing its form.
  const onDialogClose = (event: Event): void => {
    if (event.target === dialog) return;
    queueMicrotask(maybeShow);
  };
  document.addEventListener('close', onDialogClose, true);

  const unsubscribe = api.onChatgptPermissionNotice(next => { publish(next); });
  void api.getChatgptPermissionNotice().then(result => {
    if (!destroyed && result.ok) publish(result.data);
  }).catch(() => { /* A future push can still present the durable pending state. */ });

  return () => {
    destroyed = true;
    if (typeof unsubscribe === 'function') unsubscribe();
    document.removeEventListener('close', onDialogClose, true);
    if (dialog.open) dialog.close();
  };
}
