import { onLanguageChange, t } from './i18n.js';
import { STOP_NOTICE_TEXTS } from '../shared/stop-notice.js';

/**
 * The stopped-chat desktop notices in the selected language (#855).
 *
 * The main process shows them and has no catalogs, so this document translates the exact source
 * texts and hands them over. Literal `t()` calls keep the catalog audit able to see each key.
 */
export function stopNoticeTexts(): Record<(typeof STOP_NOTICE_TEXTS)[number], string> {
  return {
    'A chat stopped': t('A chat stopped'),
    'Its last turn produced nothing and nothing followed. Send a message there to start a fresh turn.':
      t('Its last turn produced nothing and nothing followed. Send a message there to start a fresh turn.'),
    'Its last turn failed and nothing followed. Send a message there to start a fresh turn.':
      t('Its last turn failed and nothing followed. Send a message there to start a fresh turn.'),
    'Recovery stopped': t('Recovery stopped'),
    "The browser did not pick up this chat's repair, so the app stopped retrying. Open its tab again and recovery resumes.":
      t("The browser did not pick up this chat's repair, so the app stopped retrying. Open its tab again and recovery resumes."),
    'ChatGPT is waiting for your approval': t('ChatGPT is waiting for your approval'),
    'A chat is paused until you allow or deny a tool call in ChatGPT. Click to open it.':
      t('A chat is paused until you allow or deny a tool call in ChatGPT. Click to open it.')
  };
}

/** Publishes now and after every language change; a failed hand-over leaves English notices. */
export function publishStopNoticeTexts(send: (texts: Record<string, string>) => unknown): void {
  const publish = () => { try { void Promise.resolve(send(stopNoticeTexts())).catch(() => undefined); } catch { /* English stays. */ } };
  publish();
  onLanguageChange(publish);
}
