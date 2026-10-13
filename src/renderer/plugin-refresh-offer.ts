import type { AppApi } from '../preload/index.js';
import type { AppState } from '../shared/types.js';
import { toast } from './dom.js';
import { t } from './i18n.js';

let busy = false;

/**
 * Asks once to turn Automatic plugin refresh on. Installs from before the setting existed have it
 * saved as off, usually without anyone having chosen that; new installs have it on and never see
 * this. Either answer is kept by the main process, so the card does not come back.
 */
export function paintPluginRefreshOffer(
  state: AppState,
  api: Pick<AppApi, 'answerPluginRefreshOffer'>,
  apply: (next: AppState) => void
): void {
  const card = document.getElementById('pluginRefreshOffer')!;
  const accept = document.getElementById('pluginRefreshOfferAccept') as HTMLButtonElement;
  const later = document.getElementById('pluginRefreshOfferLater') as HTMLButtonElement;
  card.hidden = state.config.ui.autoRefreshPlugins === true || state.config.ui.autoRefreshPluginsAsked === true;
  accept.disabled = later.disabled = busy;
  const answer = async (turnOn: boolean): Promise<void> => {
    if (busy) return;
    busy = true;
    accept.disabled = later.disabled = true;
    try {
      const reply = await api.answerPluginRefreshOffer(turnOn);
      if (!reply.ok) { toast(t(reply.error)); return; }
      card.hidden = true;
      apply(reply.data);
      if (turnOn) toast(t('Automatic plugin refresh is on.'));
    } catch {
      toast(t('Could not save settings.'));
    } finally {
      busy = false;
      accept.disabled = later.disabled = false;
    }
  };
  accept.onclick = () => void answer(true);
  later.onclick = () => void answer(false);
}
