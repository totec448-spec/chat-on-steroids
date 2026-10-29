import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';
import { keyBelongsElsewhere, nextOwnMessage, pickOwnMessage } from '../src/renderer/message-jumps.js';

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

// CodeRabbit on #1889: when several messages fit in the view, the scroll cannot move the next one to
// the top, so "the one at the top" never changed and Alt+↓ kept choosing the same message.
it('goes on from the message it jumped to while that one is still in view', () => {
  // The view (40 to 800) holds three short messages; scrolling further is clamped at the end.
  const tops = [100, 220, 340];
  expect(nextOwnMessage(tops, 40, 800, 1, -1)).toBe(0);
  expect(nextOwnMessage(tops, 40, 800, 1, 0)).toBe(1);
  expect(nextOwnMessage(tops, 40, 800, 1, 1)).toBe(2);
  expect(nextOwnMessage(tops, 40, 800, 1, 2)).toBe(-1);
  expect(nextOwnMessage(tops, 40, 800, -1, 2)).toBe(1);
  expect(nextOwnMessage(tops, 40, 800, -1, 0)).toBe(-1);
  // The reader scrolled it out of view: the top of the view decides again.
  expect(nextOwnMessage([-900, -300, 900], 40, 800, 1, 0)).toBe(2);
  expect(nextOwnMessage([-900, -300, 900], 40, 800, -1, 2)).toBe(1);
});

// CodeRabbit on #1889: the first Alt+↑ in a short chat, with no message above the view, goes to the newest
// message in view instead of loading older history with nothing marked.
it('goes first to the newest message in view when none is above it', () => {
  expect(nextOwnMessage([100, 220, 340], 40, 800, -1, -1)).toBe(2);
  // One above the view: that one, as before.
  expect(nextOwnMessage([-300, 100, 220], 40, 800, -1, -1)).toBe(0);
  // None in view either: nothing on this page.
  expect(nextOwnMessage([900, 1200], 40, 800, -1, -1)).toBe(-1);
});

// CodeRabbit on #1889: a panel that is open (the context meter's) keeps its keys.
it('leaves the keys to an open panel, menu or list', () => {
  const dom = new JSDOM('<button id="meter" aria-expanded="true"></button><div role="dialog"><button id="inside"></button></div><button id="plain"></button>' +
    '<div contenteditable="plaintext-only"><span id="typing"></span></div><div contenteditable="false"><span id="locked"></span></div>');
  Object.assign(globalThis, { Element: dom.window.Element });
  const byId = (id: string) => dom.window.document.getElementById(id);
  expect(keyBelongsElsewhere(byId('meter'))).toBe(true);
  expect(keyBelongsElsewhere(byId('inside'))).toBe(true);
  expect(keyBelongsElsewhere(byId('plain'))).toBe(false);
  // CodeRabbit: any editable area keeps its keys, plaintext-only and inherited ones too; contenteditable=false is not one.
  expect(keyBelongsElsewhere(byId('typing'))).toBe(true);
  expect(keyBelongsElsewhere(byId('locked'))).toBe(false);
});
