/**
 * English source of the stopped-chat desktop notices (#855).
 *
 * The main process shows these notices but has no interface catalogs. The renderer translates
 * exactly these strings with its own catalogs and publishes the result; anything else is refused,
 * and a string without a published translation is shown as written.
 */
export const STOP_NOTICE_TEXTS = [
  'A chat stopped',
  'Its last turn produced nothing and nothing followed. Send a message there to start a fresh turn.',
  'Its last turn failed and nothing followed. Send a message there to start a fresh turn.',
  'Recovery stopped',
  "The browser did not pick up this chat's repair, so the app stopped retrying. Open its tab again and recovery resumes."
] as const;

export type StopNoticeText = typeof STOP_NOTICE_TEXTS[number];

export function isStopNoticeText(value: string): value is StopNoticeText {
  return (STOP_NOTICE_TEXTS as readonly string[]).includes(value);
}
