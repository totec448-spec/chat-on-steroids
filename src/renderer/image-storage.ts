import { el, run, toast } from './dom.js';
import { t, ui } from './i18n.js';
import type { ImageStorageClearResult } from '../shared/session.js';

// Retain the one user-requested operation across dialog closure, without polling or rerunning it.
let cleanup: { pending: boolean; result: ImageStorageClearResult | null; done: Promise<void> } | null = null;

/** Cleanup is an explicit local UI choice; opening this dialog never removes bytes. */
export function imageStorageButton(): HTMLButtonElement {
  const button = el('button', 'btn small', () => t('Free image storage')) as HTMLButtonElement;
  button.type = 'button';
  button.addEventListener('click', () => void showImageStorage());
  return button;
}

function showImageStorage(): void {
  if (document.querySelector('.image-storage-dialog')) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'image-storage-dialog';
  dialog.setAttribute('aria-label', t('Free image storage'));
  const status = el('p', 'muted', () => t('Loading storage usage…'));
  status.setAttribute('role', 'status');
  const choices = el('div', 'image-storage-actions');
  const cancel = el('button', 'btn', () => t('Close')) as HTMLButtonElement;
  cancel.type = 'button'; cancel.addEventListener('click', () => dialog.close());
  dialog.append(el('h3', '', () => t('Free image storage')), status,
    el('p', '', () => t('Remove local recorded image copies. Chat text, original files and pending attachments stay. Removed previews will no longer be available in old chats.')),
    choices, cancel);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog); dialog.showModal();
  const renderCleanup = () => {
    if (!dialog.isConnected || !cleanup) return;
    dialog.toggleAttribute('aria-busy', cleanup.pending);
    if (cleanup.pending) dialog.setAttribute('aria-busy', 'true');
    for (const child of choices.querySelectorAll('button')) child.disabled = cleanup.pending;
    ui(status, 'textContent', () => cleanup!.pending
      ? t('Removing recorded images in the background. You can close this window.')
      : cleanupResultText(cleanup!.result));
  };
  for (const mode of ['oldest-gib', 'all'] as const) {
    const action = el('button', 'btn', () => mode === 'all' ? t('Remove all recorded images') : t('Free oldest 1 GB')) as HTMLButtonElement;
    action.type = 'button';
    action.addEventListener('click', () => {
      if (cleanup?.pending) return;
      if (!window.confirm(mode === 'all'
        ? t('Permanently remove all local recorded images? Chat text and original files will stay.')
        : t('Permanently remove about 1 GB of the oldest local recorded images? Chat text and original files will stay.'))) return;
      const job = { pending: true, result: null as ImageStorageClearResult | null, done: Promise.resolve() };
      cleanup = job;
      renderCleanup();
      job.done = run(window.api.clearImageStorage(mode)).catch(() => null).then(result => {
        job.result = result;
        job.pending = false;
        renderCleanup();
        toast(cleanupResultText(result));
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

function cleanupResultText(result: ImageStorageClearResult | null): string {
  return result
    ? t('Freed {0} MB. {1} GB of image storage is now available.', [(result.freedBytes / 2 ** 20).toFixed(1), (Math.max(0, result.limitBytes - result.usedBytes) / 2 ** 30).toFixed(2)])
    : t('Image cleanup failed. No further cleanup was requested.');
}
