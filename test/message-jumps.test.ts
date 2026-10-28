import { expect, it } from 'vitest';
import { pickOwnMessage } from '../src/renderer/message-jumps.js';

/**
 * #1884 (Haz): Alt+↑ / Alt+↓ moves the chat to your previous / next message. The rows' tops are in
 * window pixels; the reference is the top of the chat's view, where the last jump left a message.
 */
it('picks the nearest own message above or below the top of the view', () => {
  const tops = [-900, -300, 40, 600, 1400];
  // The view starts at 40 px: the message there is the current one.
  expect(pickOwnMessage(tops, 40, -1)).toBe(1);
  expect(pickOwnMessage(tops, 40, 1)).toBe(3);
  // Between messages, the next one up or down.
  expect(pickOwnMessage(tops, 200, -1)).toBe(2);
  expect(pickOwnMessage(tops, 200, 1)).toBe(3);
  // A few pixels of rounding after a scroll still count as "this one".
  expect(pickOwnMessage(tops, 43, 1)).toBe(3);
  expect(pickOwnMessage(tops, 37, -1)).toBe(1);
});

it('says when there is none in that direction', () => {
  expect(pickOwnMessage([100, 500], 100, -1)).toBe(-1);
  expect(pickOwnMessage([100, 500], 500, 1)).toBe(-1);
  expect(pickOwnMessage([], 0, 1)).toBe(-1);
});
