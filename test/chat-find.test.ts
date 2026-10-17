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
