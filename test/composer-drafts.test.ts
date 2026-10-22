import { JSDOM } from 'jsdom';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { createComposerDrafts, type ComposerDraftOptions } from '../src/renderer/composer-drafts.js';

const KEY = 'chat-on-steroids.composer-drafts';
let dom: JSDOM;
afterEach(() => dom?.window.close());

function fixture(saved?: string, options?: ComposerDraftOptions) {
  dom = new JSDOM('<div></div>', { url: 'https://local.test' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  if (saved !== undefined) dom.window.localStorage.setItem(KEY, saved);
  return createComposerDrafts(options);
}
/** What a restart reads back, after the window is about to close. */
function stored(): Array<[string, string]> {
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  return JSON.parse(dom.window.localStorage.getItem(KEY)!);
}

it('keeps draft text across a restart, and forgets sent or emptied drafts', () => {
  const drafts = fixture();
  drafts.set('chat-a', 'Unsent idea');
  drafts.set('new', 'A new chat');
  drafts.set('chat-b', '   ');
  drafts.set('chat-c', 'Sent already'); drafts.delete('chat-c');
  const saved = stored();
  expect(saved).toEqual([['chat-a', 'Unsent idea'], ['new', 'A new chat']]);
  const again = fixture(JSON.stringify(saved));
  expect(again.get('chat-a')).toBe('Unsent idea');
  expect(again.has('new')).toBe(true);
  expect(again.has('chat-b')).toBe(false);
});

it('writes a typed draft after a short pause without waiting for a quit', () => {
  vi.useFakeTimers();
  try {
    const drafts = fixture();
    drafts.set('chat-a', 'U'); drafts.set('chat-a', 'Unsent');
    expect(dom.window.localStorage.getItem(KEY)).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(JSON.parse(dom.window.localStorage.getItem(KEY)!)).toEqual([['chat-a', 'Unsent']]);
  } finally { vi.useRealTimers(); }
});

it('ignores broken storage and keeps only the newest drafts that fit', () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  onTestFinished(() => logged.mockRestore());
  expect(fixture('{not json').has('chat-a')).toBe(false);
  expect(fixture('{"chat-a":"an older shape"}').has('chat-a')).toBe(false);
  const mixed = fixture(JSON.stringify([['ok', 'text'], ['', 'no key'], ['bad', 7], 'loose', ['x'.repeat(201), 'long key']]));
  expect(mixed.has('ok')).toBe(true);
  expect(mixed.has('bad')).toBe(false);
  expect(mixed.has('x'.repeat(201))).toBe(false);

  const many = fixture(JSON.stringify(Array.from({ length: 100 }, (_, index) => [`chat-${index}`, `draft ${index}`])));
  many.set('newest', 'kept');
  const saved = stored();
  expect(saved).toHaveLength(100);
  expect(saved[0]![0]).toBe('chat-1');
  expect(saved.at(-1)).toEqual(['newest', 'kept']);

  // Visiting chats records their blank composers; only drafts with text count toward the 100.
  const visited = fixture();
  visited.set('older', 'kept');
  for (let index = 0; index < 150; index++) visited.set(`visited-${index}`, '');
  expect(stored()).toEqual([['older', 'kept']]);

  const huge = fixture();
  huge.set('older', 'short');
  huge.set('pasted', 'x'.repeat(1_000_001));
  expect(stored()).toEqual([['older', 'short']]);
  stored();
  // Why a draft did not come back is in the app log, once, with no draft text.
  expect(logged.mock.calls).toEqual([
    ['Composer drafts: the saved drafts could not be read, so none came back.'],
    ['Composer drafts: the saved drafts were not a list, so none came back.'],
    ['Composer drafts: a draft too long for the 1000000 stored characters stays in this window only.']
  ]);

  // Under the bound as typed, six times over it as stored: it must not cost the older drafts their restart.
  const escaped = fixture();
  escaped.set('older', 'short');
  escaped.set('pasted', '\u0001'.repeat(700_000));
  expect(fixture(JSON.stringify(stored())).get('older')).toBe('short');
});

it('says when a key starts or stops holding a draft, not on every keystroke', () => {
  const onDraftedChange = vi.fn();
  const drafts = fixture(undefined, { onDraftedChange });
  drafts.set('chat-a', 'U'); drafts.set('chat-a', 'Un'); drafts.set('chat-a', ' ');
  drafts.set('chat-a', 'Again'); drafts.delete('chat-a'); drafts.delete('chat-a');
  expect(onDraftedChange.mock.calls).toEqual([['chat-a'], ['chat-a'], ['chat-a'], ['chat-a']]);
});

it('saves the text a restart should give back in place of what the composer holds', () => {
  const drafts = fixture(undefined, { savedText: (key, text) => key === 'chat-a' ? 'Before the edit' : text });
  drafts.set('chat-a', 'The question being edited');
  drafts.set('chat-b', 'Plain draft');
  expect(stored()).toEqual([['chat-a', 'Before the edit'], ['chat-b', 'Plain draft']]);
  expect(drafts.get('chat-a')).toBe('The question being edited');
});
