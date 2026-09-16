import { el, run } from './dom.js';
import { t } from './i18n.js';

/** Cleanup is an explicit local UI choice; opening this dialog never removes bytes. */
export function imageStorageButton(): HTMLButtonElement {
  const button = el('button', 'btn small', () => t('Free image storage')) as HTMLButtonElement;
  button.type = 'button';
  button.addEventListener('click', () => void showImageStorage());
  return button;
}

async function showImageStorage(): Promise<void> {
  if (document.querySelector('.image-storage-dialog')) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'image-storage-dialog';
  dialog.setAttribute('aria-label', t('Free image storage'));
  const status = el('p', 'muted', () => t('Loading storage usage…'));
  const choices = el('div', 'image-storage-actions');
  const cancel = el('button', 'btn', () => t('Cancel')) as HTMLButtonElement;
  cancel.type = 'button'; cancel.addEventListener('click', () => dialog.close());
  dialog.append(el('h3', '', () => t('Free image storage')), status,
    el('p', '', () => t('Remove local recorded image copies. Chat text, original files and pending attachments stay. Removed previews will no longer be available in old chats.')),
    choices, cancel);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog); dialog.showModal();
  const usage = await run(window.api.getImageStorage());
  if (!dialog.isConnected) return;
  if (!usage) { status.textContent = t('Storage usage could not be read.'); return; }
  status.textContent = t('{0} GB used of {1} GB', [(usage.usedBytes / 2 ** 30).toFixed(2), (usage.limitBytes / 2 ** 30).toFixed(0)]);
  for (const mode of ['oldest-gib', 'all'] as const) {
    const action = el('button', 'btn', () => mode === 'all' ? t('Remove all recorded images') : t('Free oldest 1 GB')) as HTMLButtonElement;
    action.type = 'button'; action.disabled = usage.usedBytes === 0;
    action.addEventListener('click', async () => {
      if (!window.confirm(mode === 'all'
        ? t('Permanently remove all local recorded images? Chat text and original files will stay.')
        : t('Permanently remove about 1 GB of the oldest local recorded images? Chat text and original files will stay.'))) return;
      for (const child of choices.querySelectorAll('button')) child.disabled = true;
      cancel.disabled = true;
      const result = await run(window.api.clearImageStorage(mode));
      cancel.disabled = false;
      if (!dialog.isConnected) return;
      status.textContent = result
        ? t('Freed {0} MB. {1} GB of image storage is now available.', [(result.freedBytes / 2 ** 20).toFixed(1), (Math.max(0, result.limitBytes - result.usedBytes) / 2 ** 30).toFixed(2)])
        : t('Image cleanup failed. No further cleanup was requested.');
      cancel.textContent = t('Close');
    });
    choices.append(action);
  }
}
