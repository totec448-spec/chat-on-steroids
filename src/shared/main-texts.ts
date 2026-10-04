/**
 * English source of the texts the main process shows outside the window: the tray menu and its
 * tooltip, and the Session finish desktop notice with its buttons.
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
  'Write Directly'
] as const;

export type MainText = typeof MAIN_TEXTS[number];

export function isMainText(value: string): value is MainText {
  return (MAIN_TEXTS as readonly string[]).includes(value);
}
