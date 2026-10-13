import { el, run, toast } from './dom.js';
import { t, ui } from './i18n.js';
import type { ImageStorageClearMode, ImageStorageClearResult } from '../shared/session.js';

// Retain the one user-requested operation across dialog closure, without polling or rerunning it.
let cleanup: { mode: ImageStorageClearMode; pending: boolean; result: ImageStorageClearResult | null; done: Promise<void> } | null = null;

/** Cleanup is an explicit local UI choice; opening this dialog never removes bytes. */
export function imageStorageButton(): HTMLButtonElement {
  const button = el('button', 'btn small', () => t('Free storage')) as HTMLButtonElement;
  button.type = 'button';
  button.addEventListener('click', () => void showImageStorage());
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

function showImageStorage(): void {
  if (document.querySelector('.image-storage-dialog')) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'image-storage-dialog';
  ui(dialog, 'aria-label', () => t('Free recording storage'));
  const status = el('p', 'muted', () => t('Loading storage usage…'));
  status.setAttribute('role', 'status');
  const choices = el('div', 'image-storage-actions');
  const cancel = el('button', 'btn', () => t('Close')) as HTMLButtonElement;
  cancel.type = 'button'; cancel.addEventListener('click', () => dialog.close());
  dialog.append(el('h3', '', () => t('Free recording storage')), status,
    el('p', '', () => t('Remove local recorded image copies. Chat text, original files and pending attachments stay. Removed previews will no longer be available in old chats.')),
    el('p', '', () => t('Long texts can be freed from old chats too: chats unused for a week, oldest first. Long messages and tool results then keep only their beginning.')),
    choices, cancel);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog); dialog.showModal();
  const renderCleanup = () => {
    if (!dialog.isConnected || !cleanup) return;
    dialog.toggleAttribute('aria-busy', cleanup.pending);
    if (cleanup.pending) dialog.setAttribute('aria-busy', 'true');
    for (const child of choices.querySelectorAll('button')) child.disabled = cleanup.pending;
    ui(status, 'textContent', () => cleanup!.pending
      ? cleanup!.mode === 'old-chats-gib'
        ? t('Freeing space in the background. You can close this window.')
        : t('Removing recorded images in the background. You can close this window.')
      : cleanupResultText(cleanup!.result, cleanup!.mode));
  };
  const labels: Record<ImageStorageClearMode, () => string> = {
    'oldest-gib': () => t('Free oldest 1 GB'),
    all: () => t('Remove all recorded images'),
    'old-chats-gib': () => t('Free 1 GB from old chats')
  };
  const questions: Record<ImageStorageClearMode, () => string> = {
    'oldest-gib': () => t('Permanently remove about 1 GB of the oldest local recorded images? Chat text and original files will stay.'),
    all: () => t('Permanently remove all local recorded images? Chat text and original files will stay.'),
    'old-chats-gib': () => t('Permanently remove about 1 GB of images and full long texts from chats unused for a week, oldest first? The chats stay, and long messages and tool results keep their beginning.')
  };
  for (const mode of ['oldest-gib', 'all', 'old-chats-gib'] as const) {
    const action = el('button', 'btn', labels[mode]) as HTMLButtonElement;
    action.type = 'button';
    action.addEventListener('click', () => {
      if (cleanup?.pending) return;
      if (!window.confirm(questions[mode]())) return;
      const job = { mode, pending: true, result: null as ImageStorageClearResult | null, done: Promise.resolve() };
      cleanup = job;
      renderCleanup();
      job.done = run(window.api.clearImageStorage(mode)).catch(() => null).then(result => {
        job.result = result;
        job.pending = false;
        renderCleanup();
        toast(cleanupResultText(result, mode));
      });
    });
    choices.append(action);
  }
  if (cleanup) {
    renderCleanup();
    void cleanup.done.then(renderCleanup);
  } else {
    // Choices and Close are usable immediately; usage is informational, never an admission gate.
    void run(window.api.getImageStorage()).catch(() => null).then(usage => {
      if (!dialog.isConnected || cleanup) return;
      ui(status, 'textContent', () => usage
        ? t('{0} GB used of {1} GB', [(usage.usedBytes / 2 ** 30).toFixed(2), (usage.limitBytes / 2 ** 30).toFixed(0)])
        : t('Storage usage could not be read.'));
    });
  }
}

function cleanupResultText(result: ImageStorageClearResult | null, mode: ImageStorageClearMode): string {
  if (!result) return t('Image cleanup failed. No further cleanup was requested.');
  const freed = [(result.freedBytes / 2 ** 20).toFixed(1), (Math.max(0, result.limitBytes - result.usedBytes) / 2 ** 30).toFixed(2)];
  return mode === 'old-chats-gib'
    ? t('Freed {0} MB. {1} GB of recording storage is now available.', freed)
    : t('Freed {0} MB. {1} GB of image storage is now available.', freed);
}
