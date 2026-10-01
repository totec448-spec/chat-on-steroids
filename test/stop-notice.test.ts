import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { STOP_NOTICE_TEXTS } from '../src/shared/stop-notice.js';

// #855: the stopped-chat desktop notices follow the selected interface language.
const de = JSON.parse(readFileSync('src/renderer/locales/de.json', 'utf8')) as Record<string, string>;

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement'] as const) {
    vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key]);
  }
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); dom.window.close(); });

it('publishes every notice text in the selected language, and again after a language change', async () => {
  window.localStorage.setItem('cos.ui.language', 'de');
  const { initLanguage, setLanguage } = await import('../src/renderer/i18n.js');
  const { publishStopNoticeTexts } = await import('../src/renderer/stop-notices.js');
  initLanguage();
  const sent: Array<Record<string, string>> = [];
  publishStopNoticeTexts(texts => { sent.push(texts); });
  expect(Object.keys(sent[0]!).sort()).toEqual([...STOP_NOTICE_TEXTS].sort());
  for (const source of STOP_NOTICE_TEXTS) expect(sent[0]![source]).toBe(de[source]);

  setLanguage('en');
  expect(sent).toHaveLength(2);
  for (const source of STOP_NOTICE_TEXTS) expect(sent[1]![source]).toBe(source);
});

it('shows the published translation and keeps English for anything it does not know', async () => {
  const notice = await import('../src/main/stuck-notice.js');
  const shown: Array<[string, string]> = [];
  notice.setStuckNotifier((title, body) => { shown.push([title, body]); });

  notice.noticeChatStopped('A chat stopped', 'Its last turn failed and nothing followed. Send a message there to start a fresh turn.', 's1');
  expect(shown.at(-1)).toEqual(['A chat stopped', 'Its last turn failed and nothing followed. Send a message there to start a fresh turn.']);

  notice.setStopNoticeTranslations({
    'A chat stopped': de['A chat stopped']!,
    'Its last turn failed and nothing followed. Send a message there to start a fresh turn.': '  ',
    'Unrelated text': 'Fremder Text'
  });
  notice.noticeChatStopped('A chat stopped', 'Its last turn failed and nothing followed. Send a message there to start a fresh turn.', 's1');
  // A blank translation is refused, and an unknown source cannot be smuggled in.
  expect(shown.at(-1)).toEqual([de['A chat stopped'], 'Its last turn failed and nothing followed. Send a message there to start a fresh turn.']);

  // A new language replaces the whole set; nothing of the previous one lingers.
  notice.setStopNoticeTranslations({ 'Recovery stopped': 'Recuperación detenida' });
  notice.noticeChatStopped('A chat stopped', 'Recovery stopped', 's1');
  expect(shown.at(-1)).toEqual(['A chat stopped', 'Recuperación detenida']);
});
