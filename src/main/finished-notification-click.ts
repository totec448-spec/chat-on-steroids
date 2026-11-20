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

export function createFinishedNoticeRetention(maxNotices = 128, keepMs = 24 * 60 * 60 * 1_000) {
  const retained = new Map<NativeNotice, NodeJS.Timeout>();
  const release = (notice: NativeNotice): void => {
    const timer = retained.get(notice);
    if (timer) clearTimeout(timer);
    retained.delete(notice);
  };
  return {
    retain(notice: NativeNotice): void {
      if (retained.has(notice)) return;
      if (retained.size >= maxNotices) {
        const oldest = retained.keys().next().value;
        if (oldest) release(oldest);
      }
      const timer = setTimeout(() => release(notice), keepMs);
      timer.unref?.();
      retained.set(notice, timer);
      notice.once('click', () => release(notice));
      notice.once('action', () => release(notice));
    },
    has(notice: NativeNotice): boolean { return retained.has(notice); }
  };
}

export const finishedNoticeRetention = createFinishedNoticeRetention();
