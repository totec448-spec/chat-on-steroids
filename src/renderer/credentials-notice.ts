import type { AppApi } from '../preload/index.js';
import type { AppState } from '../shared/types.js';
import { toast } from './dom.js';
import { t } from './i18n.js';

let busy = false;

/**
 * The way out when the saved keys can no longer be read (a keychain reset, a profile moved to
 * another computer): until this existed, every key save failed and nothing in the app could
 * change that. Starting fresh loses the other saved keys, so it is asked first; the old file is
 * kept, and main sets nothing aside when the file can be read after all.
 */
export function paintCredentialsNotice(
  state: AppState,
  api: Pick<AppApi, 'startFreshCredentials'>,
  apply: (next: AppState) => void
): void {
  const notice = document.getElementById('credentialsUnreadable')!;
  const button = document.getElementById('credentialsStartFresh') as HTMLButtonElement;
  notice.hidden = state.credentialsUnreadable !== true;
  button.disabled = busy;
  button.onclick = async () => {
    if (busy) return;
    if (!window.confirm(t('Set the unreadable file aside and start with no saved keys? Your API keys and plugin secrets have to be entered again, and the browser extension may have to be connected again. The old file is kept as a backup.'))) return;
    busy = true;
    button.disabled = true;
    try {
      const reply = await api.startFreshCredentials();
      if (!reply.ok) { toast(t(reply.error)); return; }
      apply(reply.data.state);
      toast(reply.data.setAside
        ? t('Started fresh. Enter your keys again.')
        : t('The saved keys can be read again. Nothing was changed.'));
    } catch {
      toast(t('Could not start fresh.'));
    } finally {
      busy = false;
      button.disabled = false;
    }
  };
}
