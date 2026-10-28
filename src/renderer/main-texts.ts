import { onLanguageChange, t } from './i18n.js';
import type { MainText } from '../shared/main-texts.js';

/**
 * The tray menu, Session finish notice, tunnel-loss notices and CoS browser tray notice in the
 * selected language, including native update restart confirmation. The main process has no
 * catalogs, so this document translates the exact source texts and hands them over.
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
    'Updating Chat On Steroids': t('Updating Chat On Steroids'),
    'Saving your work…': t('Saving your work…'),
    'Waiting for your permission in Windows…': t('Waiting for your permission in Windows…'),
    'Starting the installer. Chat On Steroids opens again by itself.':
      t('Starting the installer. Chat On Steroids opens again by itself.'),
    'Connected': t('Connected'),
    'No internet': t('No internet'),
    'OpenAI outage': t('OpenAI outage'),
    'Diagnostics report': t('Diagnostics report'),
    'Not connected': t('Not connected'),
    'Core connection lost': t('Core connection lost'),
    'Desktop connection lost': t('Desktop connection lost'),
    'Plugins connection lost': t('Plugins connection lost'),
    'The tunnel disconnected unexpectedly. Open Chat On Steroids to check the connection.':
      t('The tunnel disconnected unexpectedly. Open Chat On Steroids to check the connection.'),
    'Astra is wrapping up': t('Astra is wrapping up'),
    'Send an automatic Goal or write your next instruction.': t('Send an automatic Goal or write your next instruction.'),
    'Send Automatic Goal': t('Send Automatic Goal'),
    'Write Directly': t('Write Directly'),
    'The Chat On Steroids browser is still running': t('The Chat On Steroids browser is still running'),
    'Your chats keep going. Choose Show browser in the tray icon’s menu to bring it back.':
      t('Your chats keep going. Choose Show browser in the tray icon’s menu to bring it back.'),
    'Your chats keep going. Choose Show browser in the menu bar icon’s menu to bring it back.':
      t('Your chats keep going. Choose Show browser in the menu bar icon’s menu to bring it back.'),
    'Restore files from this checkpoint?': t('Restore files from this checkpoint?'),
    'Files return to their checkpoint version; files added since are removed. Current files are saved first, so you can undo this in Review.':
      t('Files return to their checkpoint version; files added since are removed. Current files are saved first, so you can undo this in Review.'),
    'More files are not shown.': t('More files are not shown.'),
    'Keep current files': t('Keep current files'),
    'Restore files': t('Restore files'),
    'Export as Markdown': t('Export as Markdown'),
    'You': t('You'),
    'Export as HTML': t('Export as HTML'),
    'Export usage as CSV': t('Export usage as CSV'),
    'A chat is waiting for you.': t('A chat is waiting for you.'),
    'Something failed in Chat On Steroids.': t('Something failed in Chat On Steroids.'),
    'A chat finished.': t('A chat finished.'),
    'Finished after {0} min.': t('Finished after {0} min.'),
    'This is a test from Chat On Steroids. Phone notifications work.': t('This is a test from Chat On Steroids. Phone notifications work.'),
    'Import CoS Pet folder': t('Import CoS Pet folder'),
    'Export settings': t('Export settings'),
    'Import settings': t('Import settings'),
    'Settings backups': t('Settings backups'),
    'Import SKILL.md': t('Import SKILL.md'),
    'Markdown files': t('Markdown files'),
    'HTML files': t('HTML files'),
    'Text files': t('Text files'),
    'CSV files': t('CSV files'),
    'Save code': t('Save code'),
    'Approve a folder for ChatGPT': t('Approve a folder for ChatGPT'),
    'Import Skill folder': t('Import Skill folder'),
    'Markdown skills': t('Markdown skills'),
    'Choose a project folder for ChatGPT': t('Choose a project folder for ChatGPT'),
    'Select the tunnel executable': t('Select the tunnel executable'),
    'Programs': t('Programs'),
    'Attach files': t('Attach files'),
    'Import MCP bundle': t('Import MCP bundle'),
    'MCP bundles': t('MCP bundles'),
    'Remove worker Git checkout?': t('Remove worker Git checkout?'),
    'Review the worker checkout before removing it': t('Review the worker checkout before removing it'),
    'Checkout: {0}': t('Checkout: {0}'),
    'Uncommitted or ignored paths that would be discarded ({0}):': t('Uncommitted or ignored paths that would be discarded ({0}):'),
    'No uncommitted or ignored paths were detected.': t('No uncommitted or ignored paths were detected.'),
    'Additional paths are not shown; review the checkout before confirming.': t('Additional paths are not shown; review the checkout before confirming.'),
    'Ignored files are included in the removal.': t('Ignored files are included in the removal.'),
    'Commits made only on this branch will remain in Git.': t('Commits made only on this branch will remain in Git.'),
    'This removes the entire checkout folder, including tracked working files, ignored files and uncommitted changes.': t('This removes the entire checkout folder, including tracked working files, ignored files and uncommitted changes.'),
    'The Git branch and its commits are kept. Uncommitted files cannot be recovered from Git.': t('The Git branch and its commits are kept. Uncommitted files cannot be recovered from Git.'),
    'Keep checkout': t('Keep checkout'),
    'Remove checkout; preserve Git branch': t('Remove checkout; preserve Git branch'),
    'ChatGPT finished.': t('ChatGPT finished.'),
    'Goal result needs review': t('Goal result needs review'),
    'The Goal helper thinks the work is complete, but this has not been checked. Review the chat or send another instruction.':
      t('The Goal helper thinks the work is complete, but this has not been checked. Review the chat or send another instruction.'),
    'New chat': t('New chat'),
    'hidden': t('hidden'),
    'Shared from Chat On Steroids': t('Shared from Chat On Steroids'),
  };
}

/** Publishes now and after every language change; a failed hand-over leaves English texts. */
export function publishMainTexts(send: (texts: Record<string, string>) => unknown): void {
  const publish = () => { try { void Promise.resolve(send(mainTexts())).catch(() => undefined); } catch { /* English stays. */ } };
  publish();
  onLanguageChange(publish);
}
