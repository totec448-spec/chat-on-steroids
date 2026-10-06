/**
 * The one place the app says out loud that a chat has stopped and will not be retried.
 *
 * The watchdog's verdict was durable and invisible: a note in the session's own timeline, which
 * is exactly where nobody is looking when a chat has been silent for ten minutes. Measured on
 * 2026-09-13, on one machine, in one day: 24 + 53 + 76 minutes of standstill, every one of them
 * ended by the user happening to glance at the app.
 *
 * Deliberately not a message sent into the conversation. The app can deliver an instruction the
 * user queued, and does; inventing one and submitting it under their name is a different act,
 * and a wedged chat is not permission for it. Telling the person is.
 */
import { isStopNoticeText, type StopNoticeText } from '../shared/stop-notice.js';

/** `browser` opens the chat's ChatGPT page on click instead of the chat in the app. */
let notify: ((title: string, body: string, sessionId: string, open?: 'app' | 'browser') => boolean | void) | null = null;

/** The renderer's current translations of the notice texts; English until it publishes them. */
let translations = new Map<StopNoticeText, string>();

/** Registered by the main process, which owns the platform's notification surface. */
export function setStuckNotifier(listener: typeof notify): void {
  notify = listener;
}

/**
 * Reports one stopped chat.
 *
 * Callers own the "once per episode" decision — the silence verdict already keeps that flag —
 * so this stays a plain report and never a second budget to reason about. Never throws: a
 * notification surface that refuses is not a reason to change what the watchdog does.
 */
export function noticeChatStopped(title: StopNoticeText, body: StopNoticeText, sessionId: string): void {
  try {
    notify?.(translations.get(title) ?? title, translations.get(body) ?? body, sessionId);
  } catch {
    // A desktop that cannot show a notice still has the timeline note beside this call.
  }
}

/**
 * Reports one chat whose ChatGPT page waits for the user to answer a tool approval card.
 * The caller notices once per card; the click opens the page where the card is answered.
 */
export function noticeApprovalWaiting(sessionId: string): void {
  const title = 'ChatGPT is waiting for your approval';
  const body = 'A chat is paused until you allow or deny a tool call in ChatGPT. Click to open it.';
  try {
    notify?.(translations.get(title) ?? title, translations.get(body) ?? body, sessionId, 'browser');
  } catch {
    // The chat's timeline row still says it.
  }
}

/**
 * Takes the renderer's translations for the selected interface language (#855). Only known
 * source texts are kept, each bounded; the whole set replaces the previous language.
 */
export function setStopNoticeTranslations(texts: Readonly<Record<string, string>>): void {
  const next = new Map<StopNoticeText, string>();
  for (const [source, text] of Object.entries(texts)) {
    const value = typeof text === 'string' ? text.trim() : '';
    if (isStopNoticeText(source) && value && value.length <= 400) next.set(source, value);
  }
  translations = next;
}
