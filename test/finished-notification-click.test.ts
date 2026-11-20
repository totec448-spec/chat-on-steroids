import { describe, expect, it, vi } from 'vitest';
import { clickFinishedChatNotification } from '../src/main/finished-notification-click.js';

function setup() {
  const openAppChat = vi.fn();
  const openBrowserChat = vi.fn(async () => {});
  const onBrowserFailure = vi.fn();
  return { openAppChat, openBrowserChat, onBrowserFailure };
}

describe('native finished-chat notification clicks', () => {
  it('opens the selected browser chat on Linux, without focusing the CoS window', async () => {
    const actions = setup();
    clickFinishedChatNotification('linux', actions);
    expect(actions.openBrowserChat).toHaveBeenCalledOnce();
    expect(actions.openAppChat).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(actions.onBrowserFailure).not.toHaveBeenCalled();
  });

  it.each(['win32', 'darwin'] as const)('preserves the existing app action on %s', platform => {
    const actions = setup();
    clickFinishedChatNotification(platform, actions);
    expect(actions.openAppChat).toHaveBeenCalledOnce();
    expect(actions.openBrowserChat).not.toHaveBeenCalled();
  });

  it('logs a Linux browser refusal without trying another tab or opening the app', async () => {
    const actions = setup();
    const refusal = new Error('missing conversation');
    actions.openBrowserChat.mockRejectedValueOnce(refusal);
    clickFinishedChatNotification('linux', actions);
    await Promise.resolve();
    expect(actions.onBrowserFailure).toHaveBeenCalledExactlyOnceWith(refusal);
    expect(actions.openBrowserChat).toHaveBeenCalledOnce();
    expect(actions.openAppChat).not.toHaveBeenCalled();
  });
});
