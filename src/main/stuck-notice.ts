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
let notify: ((title: string, body: string, sessionId: string) => boolean | void) | null = null;

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
export function noticeChatStopped(title: string, body: string, sessionId: string): void {
  try {
    notify?.(title, body, sessionId);
  } catch {
    // A desktop that cannot show a notice still has the timeline note beside this call.
  }
}
