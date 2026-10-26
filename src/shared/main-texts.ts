/**
 * English source of the texts the main process shows outside the window: the tray menu and its
 * tooltip, the Session finish desktop notice with its buttons, tunnel-loss notices, and the
 * one-time notice that the CoS browser hid to the tray, the window that says an update is installing,
 * native file dialogs, worker checkout removal and checkpoint Restore confirmation.
 *
 * Same contract as STOP_NOTICE_TEXTS (#855): the main process has no interface catalogs, so the
 * renderer translates exactly these strings and publishes them; anything else is refused, and a
 * text without a published translation is shown as written.
 */
export const MAIN_TEXTS = [
  'Open',
  'Show browser',
  'Hide browser',
  'Connect',
  'Disconnect',
  'Quit',
  'Updating Chat On Steroids',
  'Saving your work…',
  'Waiting for your permission in Windows…',
  'Starting the installer. Chat On Steroids opens again by itself.',
  'Connected',
  'No internet',
  'OpenAI outage',
  'Diagnostics report',
  'Not connected',
  'Core connection lost',
  'Desktop connection lost',
  'Plugins connection lost',
  'The tunnel disconnected unexpectedly. Open Chat On Steroids to check the connection.',
  'Astra is wrapping up',
  'Send an automatic Goal or write your next instruction.',
  'Send Automatic Goal',
  'Write Directly',
  'The Chat On Steroids browser is still running',
  'Your chats keep going. Choose Show browser in the tray icon’s menu to bring it back.',
  'Your chats keep going. Choose Show browser in the menu bar icon’s menu to bring it back.',
  'Restore files from this checkpoint?',
  'Files return to their checkpoint version; files added since are removed. Current files are saved first, so you can undo this in Review.',
  'More files are not shown.',
  'Keep current files',
  'Restore files',
  // Native file dialogs and the worker checkout removal confirmation.
  'Export as Markdown',
  'You',
  'Export as HTML',
  'Export usage as CSV',
  // Phone notifications (ntfy).
  'A chat is waiting for you.',
  'Something failed in Chat On Steroids.',
  'A chat finished.',
  'Finished after {0} min.',
  'This is a test from Chat On Steroids. Phone notifications work.',
  'Import CoS Pet folder',
  'Export settings',
  'Import settings',
  'Settings backups',
  'Import SKILL.md',
  'Markdown files',
  'HTML files',
  'Text files',
  'CSV files',
  'Save code',
  'Approve a folder for ChatGPT',
  'Import Skill folder',
  'Markdown skills',
  'Choose a project folder for ChatGPT',
  'Select the tunnel executable',
  'Programs',
  'Attach files',
  'Import MCP bundle',
  'MCP bundles',
  'Remove worker Git checkout?',
  'Review the worker checkout before removing it',
  'Checkout: {0}',
  'Uncommitted or ignored paths that would be discarded ({0}):',
  'No uncommitted or ignored paths were detected.',
  'Additional paths are not shown; review the checkout before confirming.',
  'Ignored files are included in the removal.',
  'Commits made only on this branch will remain in Git.',
  'This removes the entire checkout folder, including tracked working files, ignored files and uncommitted changes.',
  'The Git branch and its commits are kept. Uncommitted files cannot be recovered from Git.',
  'Keep checkout',
  'Remove checkout; preserve Git branch',
  // The turn-completion notice when an answer has no text to show.
  'ChatGPT finished.',
  // The Goal helper stopped without evidence that the requested work is complete.
  'Goal result needs review',
  'The Goal helper thinks the work is complete, but this has not been checked. Review the chat or send another instruction.',
  // A chat shared as a web page: the page's own labels ('You' is above).
  'New chat',
  'hidden',
  'Shared from Chat On Steroids'
] as const;

export type MainText = typeof MAIN_TEXTS[number];

export function isMainText(value: string): value is MainText {
  return (MAIN_TEXTS as readonly string[]).includes(value);
}
