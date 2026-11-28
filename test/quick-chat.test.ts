import { describe, expect, it } from 'vitest';
import { quickChatBounds, QUICK_CHAT_SHORTCUT } from '../src/shared/quick-chat.js';

describe('Quick chat placement', () => {
  it('opens near the top-right of the invoking monitor', () => {
    expect(QUICK_CHAT_SHORTCUT).toBe('CommandOrControl+Shift+E');
    expect(quickChatBounds({ x: -1920, y: 20, width: 1920, height: 1040 }, null))
      .toEqual({ x: -456, y: 36, width: 440, height: 580 });
  });
  it('keeps a previously resized panel reachable after a display changes', () => {
    expect(quickChatBounds({ x: 0, y: 0, width: 800, height: 500 }, { x: 650, y: 80, width: 600, height: 700 }))
      .toEqual({ x: 200, y: 0, width: 600, height: 500 });
  });
  it('moves a panel from a disconnected monitor and respects a small work area', () => {
    expect(quickChatBounds({ x: 0, y: 0, width: 320, height: 300 }, { x: 1920, y: 900, width: 440, height: 580 }))
      .toEqual({ x: 0, y: 0, width: 320, height: 300 });
  });
});
