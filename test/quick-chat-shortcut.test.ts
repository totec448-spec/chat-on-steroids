import { describe, expect, it, vi } from 'vitest';
import { createQuickChatShortcut } from '../src/main/quick-chat-shortcut.js';
import { normalizeQuickChatShortcut, QUICK_CHAT_SHORTCUT } from '../src/shared/quick-chat-shortcut.js';

describe('Quick Chat global shortcut', () => {
  it('normalizes aliases and ordering and rejects shortcuts without a modifier or with ambiguous syntax', () => {
    expect(normalizeQuickChatShortcut('shift + ctrl + e')).toBe('Control+Shift+E');
    expect(normalizeQuickChatShortcut('CmdOrCtrl+Alt+F12')).toBe('CommandOrControl+Alt+F12');
    for (const invalid of ['', 'E', 'Shift+E', 'Ctrl+Control+E', 'Ctrl+Shift', 'CmdOrCtrl+Ctrl+E', 'Ctrl+E+F', 'Ctrl+Unknown']) {
      expect(normalizeQuickChatShortcut(invalid), invalid).toBeNull();
    }
  });

  it('registers once, replaces the old shortcut, unregisters on opt-out and restores the chosen key when enabled', () => {
    const registry = { register: vi.fn(() => true), unregister: vi.fn() };
    const toggle = vi.fn();
    const shortcut = createQuickChatShortcut(registry, toggle);
    shortcut.apply({});
    shortcut.apply({});
    expect(registry.register).toHaveBeenCalledExactlyOnceWith(QUICK_CHAT_SHORTCUT, toggle);
    expect(shortcut.status()).toBe('registered');
    shortcut.apply({ quickChatShortcut: 'ctrl+alt+k' });
    expect(registry.unregister).toHaveBeenCalledWith(QUICK_CHAT_SHORTCUT);
    expect(registry.register).toHaveBeenLastCalledWith('Control+Alt+K', toggle);
    shortcut.apply({ quickChatShortcutEnabled: false, quickChatShortcut: 'Control+Alt+K' });
    expect(shortcut.status()).toBe('disabled');
    expect(registry.unregister).toHaveBeenLastCalledWith('Control+Alt+K');
    expect(registry.register).toHaveBeenCalledTimes(2);
    shortcut.apply({ quickChatShortcutEnabled: true, quickChatShortcut: 'Control+Alt+K' });
    expect(shortcut.status()).toBe('registered');
    shortcut.dispose();
    expect(registry.unregister).toHaveBeenCalledTimes(3);
    expect(shortcut.status()).toBe('pending');
  });

  it('reports native refusal or exceptions without retaining a stale registered key or retrying on unrelated saves', () => {
    const register = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false).mockImplementationOnce(() => { throw Error('unsupported'); }).mockReturnValueOnce(true);
    const registry = { register, unregister: vi.fn() };
    const warn = vi.fn();
    const shortcut = createQuickChatShortcut(registry, vi.fn(), warn);
    shortcut.apply({});
    shortcut.apply({ quickChatShortcut: 'Alt+E' });
    expect(shortcut.status()).toBe('unavailable');
    shortcut.apply({ quickChatShortcut: 'Alt+E' });
    expect(register).toHaveBeenCalledTimes(2);
    shortcut.apply({ quickChatShortcut: 'Alt+K' });
    expect(shortcut.status()).toBe('unavailable');
    expect(registry.unregister).toHaveBeenCalledExactlyOnceWith(QUICK_CHAT_SHORTCUT);
    expect(warn).toHaveBeenCalledTimes(2);
    shortcut.apply({ quickChatShortcut: 'Alt+J' });
    expect(shortcut.status()).toBe('registered');
  });
});
