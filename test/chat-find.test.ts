import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM('<div id="timeline"></div>', { url: 'https://local.test/' });
  for (const key of ['window', 'document', 'Node', 'NodeFilter'] as const) vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key]);
});
afterEach(() => { vi.unstubAllGlobals(); dom.window.close(); });

it('marks a match as the chat shows it, across formatting and without accents', async () => {
  // Find in chat found "File: /kunden" in a message but marked nothing: the words sit in <strong>
  // and <code>, and only single text nodes were searched (2.1.41 pass).
  const { rangesIn } = await import('../src/renderer/chat-find.js');
  const timeline = document.getElementById('timeline')!;
  timeline.innerHTML = '<div class="said"><ul><li><strong>File:</strong> <code>/kunden/goal.txt</code></li><li>Die   Prüfung läuft</li></ul></div>';
  expect(rangesIn(timeline, 'file: /kunden').map(range => range.toString())).toEqual(['File: /kunden']);
  expect(rangesIn(timeline, 'die prufung').map(range => range.toString())).toEqual(['Die   Prüfung']);
  expect(rangesIn(timeline, 'goal.txt die')).toHaveLength(1);
  expect(rangesIn(timeline, 'missing')).toEqual([]);
});

it('marks the match it stepped to as the current one', async () => {
  // The current match was looked up by a row key of its own making that no timeline row has,
  // so it was never marked apart from the others (2.1.41 pass).
  document.body.innerHTML = '<div class="app" data-screen="chat"><div id="chatFind" hidden><input id="chatFindField"><span id="chatFindCount"></span>' +
    '<button id="chatFindPrev"></button><button id="chatFindNext"></button><button id="chatFindClose"></button></div>' +
    '<div id="timeline"><div data-timeline-key="message:assistant_message\u0000m1"><div class="said">first goal</div></div>' +
    '<div data-timeline-key="input:i2"><div class="said">second goal</div></div></div></div>';
  const sets = new Map<string, Range[]>();
  vi.stubGlobal('Highlight', class { ranges: Range[]; constructor(...ranges: Range[]) { this.ranges = ranges; } });
  vi.stubGlobal('CSS', { highlights: { set: (name: string, value: { ranges: Range[] }) => sets.set(name, value.ranges), delete: (name: string) => sets.delete(name) } });
  vi.stubGlobal('MutationObserver', undefined);
  const { initChatFind } = await import('../src/renderer/chat-find.js');
  const second = { seq: 2, kind: 'user_message' as const, messageId: null, position: 2 };
  initChatFind({
    selectedId: () => 'chat', reveal: async () => undefined,
    find: async () => [{ seq: 1, kind: 'assistant_message' as const, messageId: 'm1', position: 1 }, second],
    row: location => document.querySelector<HTMLElement>(location.seq === 2 ? '[data-timeline-key="input:i2"]' : '[data-timeline-key^="message:"]')
  });
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }));
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
  expect(document.getElementById('chatFind')!.hidden).toBe(false);
  const field = document.getElementById('chatFindField') as HTMLInputElement;
  field.value = 'goal';
  field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await vi.waitFor(() => expect(sets.get('chat-find-current')?.map(range => range.startContainer.textContent)).toEqual(['second goal']));
  expect(sets.get('chat-find')).toHaveLength(2);
});
