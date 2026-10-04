import { readFileSync, readdirSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MAIN_TEXTS } from '../src/shared/main-texts.js';

// The tray menu and Session finish notice follow the selected interface language, like #855.
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

it('has every tray and notice text in every interface catalog', () => {
  for (const file of readdirSync('src/renderer/locales').filter(name => name.endsWith('.json'))) {
    const catalog = JSON.parse(readFileSync(`src/renderer/locales/${file}`, 'utf8')) as Record<string, string>;
    for (const source of MAIN_TEXTS) expect(catalog[source]?.trim(), `${file}: ${source}`).toBeTruthy();
  }
});

it('publishes every tray and notice text in the selected language, and again after a language change', async () => {
  window.localStorage.setItem('cos.ui.language', 'de');
  const { initLanguage, setLanguage } = await import('../src/renderer/i18n.js');
  const { publishMainTexts } = await import('../src/renderer/main-texts.js');
  initLanguage();
  const sent: Array<Record<string, string>> = [];
  publishMainTexts(texts => { sent.push(texts); });
  expect(Object.keys(sent[0]!).sort()).toEqual([...MAIN_TEXTS].sort());
  for (const source of MAIN_TEXTS) expect(sent[0]![source]).toBe(de[source]);

  setLanguage('en');
  expect(sent).toHaveLength(2);
  for (const source of MAIN_TEXTS) expect(sent[1]![source]).toBe(source);
});

it('shows the published translation, keeps English for anything unknown, and repaints the tray', async () => {
  const texts = await import('../src/main/main-texts.js');
  const repaint = vi.fn();
  texts.onMainTextsChange(repaint);
  expect(texts.mainText('Quit')).toBe('Quit');

  texts.setMainTextTranslations({ Quit: de.Quit!, Open: '  ', 'Unrelated text': 'Fremder Text' });
  expect(repaint).toHaveBeenCalledTimes(1);
  expect(texts.mainText('Quit')).toBe(de.Quit);
  // A blank translation is refused, and an unknown source cannot be smuggled in.
  expect(texts.mainText('Open')).toBe('Open');

  // A new language replaces the whole set; nothing of the previous one lingers.
  texts.setMainTextTranslations({ Open: 'Abrir' });
  expect(texts.mainText('Quit')).toBe('Quit');
  expect(texts.mainText('Open')).toBe('Abrir');
});

it('starts a launch to the tray in the last language, before any window has published', async () => {
  // A background launch builds the tray without a window, so the renderer never publishes; the
  // main process keeps the last set it received and takes it back at startup.
  const before = await import('../src/main/main-texts.js');
  before.setMainTextTranslations({ Quit: de.Quit!, Open: de.Open! });
  const saved = JSON.parse(JSON.stringify(before.mainTextTranslations()));

  vi.resetModules();
  const after = await import('../src/main/main-texts.js');
  expect(after.mainText('Quit')).toBe('Quit');
  after.restoreMainTextTranslations(saved);
  expect(after.mainText('Quit')).toBe(de.Quit);
  expect(after.mainText('Open')).toBe(de.Open);

  // A missing or damaged file leaves English, and cannot smuggle in other texts.
  for (const damaged of [null, 'Beenden', ['Beenden'], { Quit: 5 }, { 'Unrelated text': 'x' }]) {
    vi.resetModules();
    const fresh = await import('../src/main/main-texts.js');
    fresh.restoreMainTextTranslations(damaged);
    expect(fresh.mainText('Quit')).toBe('Quit');
  }
});
