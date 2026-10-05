import { JSDOM } from 'jsdom';
import { afterEach, expect, it } from 'vitest';
import { createSidebarPins, pinnedSortScope } from '../src/renderer/sidebar-pins.js';

let dom: JSDOM;
afterEach(() => dom?.window.close());

function fixture(saved?: string) {
  dom = new JSDOM('<div></div>', { url: 'https://local.test' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  if (saved !== undefined) dom.window.localStorage.setItem('chat-on-steroids.sidebar-pins', saved);
  return createSidebarPins();
}
const rows = (...ids: string[]) => ids.map(id => ({ id }));

it('puts pinned chats first and keeps the order inside each group', () => {
  const pins = fixture();
  expect(pins.toggle('c')).toBe(true);
  expect(pins.toggle('a')).toBe(true);
  expect(pins.first(rows('a', 'b', 'c', 'd')).map(row => row.id)).toEqual(['a', 'c', 'b', 'd']);
  expect(pins.toggle('a')).toBe(false);
  expect(pins.first(rows('a', 'b', 'c', 'd')).map(row => row.id)).toEqual(['c', 'a', 'b', 'd']);
});

it('remembers pins across a restart and ignores broken or oversized storage', () => {
  fixture().toggle('kept');
  const saved = dom.window.localStorage.getItem('chat-on-steroids.sidebar-pins')!;
  expect(fixture(saved).has('kept')).toBe(true);
  expect(fixture('{not json').has('kept')).toBe(false);
  expect(fixture(JSON.stringify(['ok', 7, '', 'x'.repeat(161)])).first(rows('x'.repeat(161), 'ok')).map(row => row.id.length)).toEqual([2, 161]);
});

it('never refuses a pin: the oldest one gives way at the bound', () => {
  const pins = fixture(JSON.stringify(Array.from({ length: 500 }, (_, index) => `chat-${index}`)));
  expect(pins.toggle('newest')).toBe(true);
  expect(pins.has('chat-0')).toBe(false);
  expect(pins.has('chat-1')).toBe(true);
});

it('orders pinned and unpinned chats of one list separately when dragging', () => {
  expect(pinnedSortScope('', false)).toBe('');
  expect(pinnedSortScope('', true)).toBe('pinned:');
  expect(pinnedSortScope('project-1', true)).toBe('pinned:project-1');
});
