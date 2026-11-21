import { logInfo } from './logger.js';

/**
 * A native finish notification is an explicit user request to see that chat.
 * On Linux it should reveal the recorded ChatGPT tab, not just the CoS window.
 * The existing browser opener owns tab identity, selection and fallback opening.
 */
export function clickFinishedChatNotification(platform: NodeJS.Platform, actions: {
  openAppChat(): void;
  openBrowserChat(): Promise<void>;
  onBrowserFailure(error: unknown): void;
}): void {
  if (platform !== 'linux') {
    actions.openAppChat();
    return;
  }
  // A failed/ambiguous browser activation is not permission to attempt another route.
  void actions.openBrowserChat().catch(actions.onBrowserFailure);
}

/**
 * Keep native notices alive after the method that showed them has returned. Without a strong
 * reference, Electron can collect the object that owns the click listener while GNOME still
 * displays the notification. Do not release on `close`: the banner may be dismissed while the
 * notice is still available in Notification Center. Bound both age and count instead.
 */
type NativeNotice = { once(event: 'click' | 'action', listener: () => void): unknown };

export function createFinishedNoticeRetention(
  maxNotices = 128,
  keepMs = 24 * 60 * 60 * 1_000,
  logDecision: (message: string) => void = logInfo
) {
  const retained = new Map<NativeNotice, NodeJS.Timeout>();
  const release = (notice: NativeNotice, reason: 'click' | 'action' | 'capacity' | 'age'): void => {
    const timer = retained.get(notice);
    if (!timer) return;
    clearTimeout(timer);
    retained.delete(notice);
    const decision = {
      click: 'released (clicked)',
      action: 'released (action selected)',
      capacity: 'evicted (capacity limit)',
      age: 'expired (age limit)'
    }[reason];
    logDecision(`finished notice retention: ${decision}`);
  };
  return {
    retain(notice: NativeNotice): void {
      if (retained.has(notice)) {
        logDecision('finished notice retention: skipped (already retained)');
        return;
      }
      if (retained.size >= maxNotices) {
        const oldest = retained.keys().next().value;
        if (oldest) release(oldest, 'capacity');
      }
      const timer = setTimeout(() => release(notice, 'age'), keepMs);
      timer.unref?.();
      retained.set(notice, timer);
      notice.once('click', () => release(notice, 'click'));
      notice.once('action', () => release(notice, 'action'));
    },
    has(notice: NativeNotice): boolean { return retained.has(notice); }
  };
}

export const finishedNoticeRetention = createFinishedNoticeRetention();
