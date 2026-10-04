/**
 * English source of the texts the main process shows outside the window: the tray menu and its
 * tooltip, the Session finish desktop notice with its buttons, and the one-time notice that the
 * CoS browser hid to the tray.
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
  'Connected',
  'No internet',
  'Not connected',
  'Astra is wrapping up',
  'Send an automatic Goal or write your next instruction.',
  'Send Automatic Goal',
  'Write Directly',
  'The Chat On Steroids browser is still running',
  'Your chats keep going. Choose Show browser in the tray icon’s menu to bring it back.',
  'Your chats keep going. Choose Show browser in the menu bar icon’s menu to bring it back.'
] as const;

export type MainText = typeof MAIN_TEXTS[number];

export function isMainText(value: string): value is MainText {
  return (MAIN_TEXTS as readonly string[]).includes(value);
}
