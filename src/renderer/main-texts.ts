import { onLanguageChange, t } from './i18n.js';
import type { MainText } from '../shared/main-texts.js';

/**
 * The tray menu and Session finish notice in the selected language. The main process shows them
 * and has no catalogs, so this document translates the exact source texts and hands them over.
 * Literal `t()` calls keep the catalog audit able to see each key.
 */
export function mainTexts(): Record<MainText, string> {
  return {
    'Open': t('Open'),
    'Show browser': t('Show browser'),
    'Hide browser': t('Hide browser'),
    'Connect': t('Connect'),
    'Disconnect': t('Disconnect'),
    'Quit': t('Quit'),
    'Connected': t('Connected'),
    'No internet': t('No internet'),
    'Not connected': t('Not connected'),
    'Astra is wrapping up': t('Astra is wrapping up'),
    'Send an automatic Goal or write your next instruction.': t('Send an automatic Goal or write your next instruction.'),
    'Send Automatic Goal': t('Send Automatic Goal'),
    'Write Directly': t('Write Directly')
  };
}

/** Publishes now and after every language change; a failed hand-over leaves English texts. */
export function publishMainTexts(send: (texts: Record<string, string>) => unknown): void {
  const publish = () => { try { void Promise.resolve(send(mainTexts())).catch(() => undefined); } catch { /* English stays. */ } };
  publish();
  onLanguageChange(publish);
}
