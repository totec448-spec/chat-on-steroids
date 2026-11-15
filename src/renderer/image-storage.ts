import { el, run, toast } from './dom.js';
import { t, ui } from './i18n.js';
import type { ImageStorageClearMode, ImageStorageClearResult, SessionImageStorageInfo } from '../shared/session.js';

// Retain the one user-requested operation across dialog closure, without polling or rerunning it.
let cleanup: {
  mode: ImageStorageClearMode;
  sessionId?: string;
  pending: boolean;
  result: ImageStorageClearResult | null;
  sessionUsage: SessionImageStorageInfo | null;
  done: Promise<void>;
} | null = null;

/** Cleanup is an explicit local UI choice; opening this dialog never removes bytes. */
export function imageStorageButton(sessionId?: string): HTMLButtonElement {
  const button = el('button', 'btn small', () => t('Free storage')) as HTMLButtonElement;
  button.type = 'button';
  button.addEventListener('click', () => void showImageStorage(sessionId));
  return button;
}

// Dismissing lasts while the store stays full; a store that fills up again says so again.
let noticeDismissed = false;

/** The notice for a full recording store (#1406): before it, only the log knew. */
export function paintRecordingStorageNotice(full: boolean): void {
  const notice = document.getElementById('recordingStorageFull')!;
  if (!full) noticeDismissed = false;
  notice.hidden = !full || noticeDismissed;
  document.getElementById('freeRecordingStorage')!.onclick = () => showImageStorage();
  document.getElementById('dismissRecordingStorageFull')!.onclick = () => { noticeDismissed = true; notice.hidden = true; };
}

/** The clean-up's place in Settings → Agents & automation → Browser & history (#1406). */
export function initRecordingStorageSetting(): void {
  document.getElementById('settingsFreeImageStorage')!.onclick = () => showImageStorage();
}

/** Usage, read when Settings opens; the description stays when it cannot be read. */
export async function paintRecordingStorageUsage(): Promise<void> {
  const reply = await window.api.getImageStorage().catch(() => null);
  // A reply without data (an older main, a test fixture) leaves the description too.
  const usage = reply?.ok ? reply.data : null;
  if (!usage) return;
  ui(document.getElementById('recordingStorageUsage')!, 'textContent', () =>
    t('{0} GB used of {1} GB', [(usage.usedBytes / 2 ** 30).toFixed(2), (usage.limitBytes / 2 ** 30).toFixed(0)]));
}

function formatSessionUsage(session: SessionImageStorageInfo): string {
  const mb = (bytes: number, digits: number) => (bytes / 2 ** 20).toFixed(digits);
  return t('This chat: {0} MB of {1} MB ({2} MB images, {3} MB long texts).', [
    mb(session.usedBytes, 1),
    mb(session.limitBytes, 0),
    mb(session.imageBytes, 1),
    mb(session.textBytes, 1)
  ]);
}

function showImageStorage(sessionId?: string): void {
  if (document.querySelector('.image-storage-dialog')) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'image-storage-dialog';
  ui(dialog, 'aria-label', () => t('Free recording storage'));
  const status = el('p', 'image-storage-global-status', () => t('Loading storage usage…'));
  status.setAttribute('role', 'status');
  const sessionStatus = sessionId ? el('p', 'muted image-storage-chat-status', () => t('Loading chat storage usage…')) : null;
  const summary = el('div', 'image-storage-summary');
  summary.append(status, ...(sessionStatus ? [sessionStatus] : []));
  let latestSession: SessionImageStorageInfo | null = null;
  const paintSessionStatus = (session: SessionImageStorageInfo | null) => {
    if (!sessionStatus) return;
    sessionStatus.hidden = !session;
    if (session) ui(sessionStatus, 'textContent', () => formatSessionUsage(session));
  };
  const choices = el('div', 'image-storage-actions');
  const cancel = el('button', 'btn btn-solid image-storage-close', () => t('Close')) as HTMLButtonElement;
  cancel.type = 'button'; cancel.addEventListener('click', () => dialog.close());
  dialog.append(el('h3', '', () => t('Free recording storage')), summary,
    el('p', 'image-storage-note', () => t('Remove local recorded image copies. Chat text, original files and pending attachments stay. Removed previews will no longer be available in old chats.')),
    el('p', 'image-storage-note', () => t('Long texts can be freed from old chats too: chats unused for a week, oldest first. Long messages and tool results then keep only their beginning.')),
    ...(sessionId
      ? [el('p', 'image-storage-note', () => t('Global image cleanups do not remove long texts in active chats. You can clear images or long texts for this chat below.'))]
      : []),
    choices, cancel);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog); dialog.showModal();
  // Reopen with fresh usage unless showing a global completed job in global Settings or an active job.
  if (cleanup && !cleanup.pending && (sessionId || cleanup.sessionId)) cleanup = null;
  const cleanupBelongsHere = (job: NonNullable<typeof cleanup>): boolean =>
    !job.sessionId || job.sessionId === sessionId;
  let usageSeq = 0;
  const loadUsage = () => {
    const seq = ++usageSeq;
    // Choices and Close are usable immediately; usage is informational, never an admission gate.
    const request = sessionId ? window.api.getImageStorage(sessionId) : window.api.getImageStorage();
    void run(request).catch(() => null).then(usage => {
      if (!dialog.isConnected || seq !== usageSeq) return;
      if (cleanup) {
        if (sessionId && (cleanup.pending ? cleanup.sessionId !== sessionId : !cleanup.sessionId)) {
          latestSession = usage?.session ?? null;
          paintSessionStatus(latestSession);
        }
        return;
      }
      ui(status, 'textContent', () => usage
        ? t('{0} GB used of {1} GB', [(usage.usedBytes / 2 ** 30).toFixed(2), (usage.limitBytes / 2 ** 30).toFixed(0)])
        : t('Storage usage could not be read.'));
      latestSession = usage?.session ?? null;
      paintSessionStatus(latestSession);
    });
  };
  const renderCleanup = () => {
    if (!dialog.isConnected || !cleanup) return;
    if (!cleanup.pending && !cleanupBelongsHere(cleanup)) {
      cleanup = null;
      dialog.removeAttribute('aria-busy');
      for (const child of choices.querySelectorAll('button')) child.disabled = false;
      loadUsage();
      return;
    }
    dialog.toggleAttribute('aria-busy', cleanup.pending);
    if (cleanup.pending) dialog.setAttribute('aria-busy', 'true');
    for (const child of choices.querySelectorAll('button')) child.disabled = cleanup.pending;
    ui(status, 'textContent', () => cleanup!.pending
      ? cleanup!.mode === 'old-chats-gib' || cleanup!.mode === 'session-texts'
        ? t('Freeing space in the background. You can close this window.')
        : t('Removing recorded images in the background. You can close this window.')
      : cleanupResultText(cleanup!.result, cleanup!.mode));
    if (sessionId && (cleanup.sessionId === sessionId || !cleanup.sessionId)) {
      if (cleanup.sessionId === sessionId) {
        const updated = cleanup.result?.session?.sessionId === sessionId
          ? cleanup.result.session
          : cleanup.sessionUsage;
        latestSession = updated;
        paintSessionStatus(updated);
      } else if (!cleanup.pending) {
        loadUsage();
      }
    }
  };
  const labels: Record<ImageStorageClearMode, () => string> = {
    'oldest-gib': () => t('Free oldest 1 GB'),
    all: () => t('Remove all recorded images'),
    'old-chats-gib': () => t('Free 1 GB from old chats'),
    'session-images': () => t('Free images in this chat'),
    'session-texts': () => t('Free long texts in this chat')
  };
  const questions: Record<ImageStorageClearMode, () => string> = {
    'oldest-gib': () => t('Permanently remove about 1 GB of the oldest local recorded images? Chat text and original files will stay.'),
    all: () => t('Permanently remove all local recorded images? Chat text and original files will stay.'),
    'old-chats-gib': () => t('Permanently remove about 1 GB of images and full long texts from chats unused for a week, oldest first? The chats stay, and long messages and tool results keep their beginning.'),
    'session-images': () => t('Permanently remove all local recorded images from this chat? Chat text, original files and long texts will stay.'),
    'session-texts': () => t('Permanently remove all full long texts saved in this chat? Messages and tool results will keep their beginning.')
  };
  const appendAction = (mode: ImageStorageClearMode, extraClass = '') => {
    const action = el('button', `btn btn-solid${extraClass ? ` ${extraClass}` : ''}`, labels[mode]) as HTMLButtonElement;
    action.type = 'button';
    action.addEventListener('click', () => {
      if (cleanup?.pending) return;
      if (!window.confirm(questions[mode]())) return;
      const targetSessionId = sessionId;
      const job = {
        mode,
        sessionId: targetSessionId,
        pending: true,
        result: null as ImageStorageClearResult | null,
        sessionUsage: latestSession,
        done: Promise.resolve()
      };
      cleanup = job;
      renderCleanup();
      const request = targetSessionId
        ? window.api.clearImageStorage(mode, targetSessionId)
        : window.api.clearImageStorage(mode);
      job.done = run(request).catch(() => null).then(result => {
        job.result = result;
        job.sessionUsage = result?.session ?? job.sessionUsage;
        job.pending = false;
        renderCleanup();
        toast(cleanupResultText(result, mode));
      });
    });
    choices.append(action);
  };
  appendAction('oldest-gib');
  appendAction('all');
  appendAction('old-chats-gib', 'image-storage-span');
  if (sessionId) {
    choices.append(el('span', 'image-storage-group-label', () => t('This chat')));
    for (const mode of ['session-images', 'session-texts'] as const) appendAction(mode);
  }
  if (cleanup) {
    renderCleanup();
    if (cleanup.pending && cleanup.sessionId !== sessionId && sessionId) loadUsage();
    void cleanup.done.then(renderCleanup);
  } else {
    loadUsage();
  }
}

function cleanupResultText(result: ImageStorageClearResult | null, mode: ImageStorageClearMode): string {
  if (!result) return t('Image cleanup failed. No further cleanup was requested.');
  if ((mode === 'session-images' || mode === 'session-texts') && result.session) {
    return t('Freed {0} MB from this chat. {1} MB of {2} MB is now used here.', [
      (result.freedBytes / 2 ** 20).toFixed(1),
      (result.session.usedBytes / 2 ** 20).toFixed(1),
      (result.session.limitBytes / 2 ** 20).toFixed(0)
    ]);
  }
  const freed = [(result.freedBytes / 2 ** 20).toFixed(1), (Math.max(0, result.limitBytes - result.usedBytes) / 2 ** 30).toFixed(2)];
  return mode === 'old-chats-gib' || mode === 'session-texts' || mode === 'session-images'
    ? t('Freed {0} MB. {1} GB of recording storage is now available.', freed)
    : t('Freed {0} MB. {1} GB of image storage is now available.', freed);
}
