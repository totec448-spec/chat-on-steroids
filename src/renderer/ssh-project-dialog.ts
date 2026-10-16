import type { AppApi } from '../preload/index.js';
import type { LocalProject } from '../shared/projects.js';
import { t } from './i18n.js';

/**
 * Adding a folder on a server as a project (#1469). The main process connects with the person's
 * own ssh and checks the folder before anything is saved; its sentence for a failure (a host key
 * not trusted yet, a key the server refused, a folder that is a file) is shown as it is.
 */
export function initSshProjectDialog(
  api: Pick<AppApi, 'addRemoteProject'>,
  onAdded: (project: LocalProject) => void
): { open(): void } {
  const dialog = document.getElementById('sshProjectDialog') as HTMLDialogElement;
  const form = document.getElementById('sshProjectForm') as HTMLFormElement;
  const address = document.getElementById('sshProjectAddress') as HTMLInputElement;
  const folder = document.getElementById('sshProjectFolder') as HTMLInputElement;
  const error = document.getElementById('sshProjectError')!;
  const submit = document.getElementById('sshProjectSubmit') as HTMLButtonElement;
  let busy = false;

  const close = () => { if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open'); };
  const showError = (message: string | null) => {
    error.hidden = !message;
    error.textContent = message ?? '';
  };
  const setBusy = (next: boolean) => {
    busy = next;
    submit.disabled = next;
    submit.textContent = next ? t('Connecting…') : t('Test and add');
  };

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    showError(null);
    setBusy(true);
    try {
      const reply = await api.addRemoteProject(address.value.trim(), folder.value.trim());
      if (!reply.ok) { showError(reply.error); return; }
      close();
      onAdded(reply.data);
    } catch (failure) {
      showError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  });
  for (const id of ['sshProjectCancel', 'sshProjectClose']) document.getElementById(id)!.addEventListener('click', () => close());

  return {
    open() {
      form.reset();
      showError(null);
      setBusy(false);
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
      address.focus();
    }
  };
}
