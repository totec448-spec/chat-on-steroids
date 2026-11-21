import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { clickFinishedChatNotification, createFinishedNoticeRetention } from '../src/main/finished-notification-click.js';

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

describe('retaining native finished-chat notifications', () => {
  it('keeps each notification bound to its own chat while several chats finish', async () => {
    const active = createFinishedNoticeRetention();
    const selected: string[] = [];
    const first = new EventEmitter();
    const second = new EventEmitter();
    for (const [notice, id] of [[first, 'chat-a'], [second, 'chat-b']] as const) {
      notice.on('click', () => clickFinishedChatNotification('linux', {
        openAppChat: () => { throw new Error('Must not select CoS window'); },
        openBrowserChat: async () => { selected.push(id); },
        onBrowserFailure: () => { throw new Error('Must not fail'); }
      }));
      active.retain(notice);
    }
    second.emit('click');
    await Promise.resolve();
    expect(selected).toEqual(['chat-b']);
    expect(active.has(first)).toBe(true);
    first.emit('click');
    await Promise.resolve();
    expect(selected).toEqual(['chat-b', 'chat-a']);
  });

  it('keeps two different chats until their own notifications are activated', () => {
    const active = createFinishedNoticeRetention();
    const first = new EventEmitter();
    const second = new EventEmitter();
    active.retain(first);
    active.retain(second);
    expect(active.has(first)).toBe(true);
    expect(active.has(second)).toBe(true);
    first.emit('click');
    expect(active.has(first)).toBe(false);
    expect(active.has(second)).toBe(true);
    second.emit('action');
    expect(active.has(second)).toBe(false);
  });

  it('does not lose a notification simply because GNOME dismisses its transient banner', () => {
    const active = createFinishedNoticeRetention();
    const notice = new EventEmitter();
    active.retain(notice);
    notice.emit('close');
    expect(active.has(notice)).toBe(true);
    notice.emit('click');
    expect(active.has(notice)).toBe(false);
  });

  it('bounds retained notifications and expires even when GNOME never sends close', () => {
    vi.useFakeTimers();
    try {
      const logDecision = vi.fn();
      const active = createFinishedNoticeRetention(2, 1_000, logDecision);
      const first = new EventEmitter(), second = new EventEmitter(), third = new EventEmitter();
      active.retain(first);
      active.retain(first);
      active.retain(second);
      active.retain(third);
      expect(active.has(first)).toBe(false);
      expect(active.has(second)).toBe(true);
      expect(active.has(third)).toBe(true);
      vi.advanceTimersByTime(1_000);
      expect(active.has(second)).toBe(false);
      expect(active.has(third)).toBe(false);
      expect(logDecision.mock.calls.map(([message]) => message)).toEqual([
        'finished notice retention: skipped (already retained)',
        'finished notice retention: evicted (capacity limit)',
        'finished notice retention: expired (age limit)',
        'finished notice retention: expired (age limit)'
      ]);
    } finally { vi.useRealTimers(); }
  });

  it('logs an activated notice once and never logs its title or chat identifier', () => {
    const logDecision = vi.fn();
    const active = createFinishedNoticeRetention(2, 1_000, logDecision);
    const notice = Object.assign(new EventEmitter(), { title: 'PRIVATE_TITLE', sessionId: 'PRIVATE_CHAT_ID' });
    active.retain(notice);
    notice.emit('click');
    notice.emit('action');
    expect(active.has(notice)).toBe(false);
    expect(logDecision).toHaveBeenCalledExactlyOnceWith('finished notice retention: released (clicked)');
    expect(logDecision.mock.calls.flat().join(' ')).not.toMatch(/PRIVATE_TITLE|PRIVATE_CHAT_ID/);
  });

  it('logs an action release once even when the click arrives afterwards', () => {
    const logDecision = vi.fn();
    const active = createFinishedNoticeRetention(2, 1_000, logDecision);
    const notice = new EventEmitter();
    active.retain(notice);
    notice.emit('action');
    notice.emit('click');
    expect(active.has(notice)).toBe(false);
    expect(logDecision).toHaveBeenCalledExactlyOnceWith('finished notice retention: released (action selected)');
  });
});
