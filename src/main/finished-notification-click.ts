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
