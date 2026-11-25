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

it('keeps every translated tray and notice text within the bounds the main process accepts', () => {
  // `ui:mainTexts` refuses the whole set when one text is longer, leaving every main text in English.
  for (const file of readdirSync('src/renderer/locales').filter(name => name.endsWith('.json'))) {
    const catalog = JSON.parse(readFileSync(`src/renderer/locales/${file}`, 'utf8')) as Record<string, string>;
    for (const source of MAIN_TEXTS) {
      expect(source.length, source).toBeLessThanOrEqual(200);
      expect(catalog[source]?.length ?? 0, `${file}: ${source}`).toBeLessThanOrEqual(200);
    }
  }
});

it('gives every native dialog of the main process its texts in the interface language', () => {
  // Windows shows a file dialog's title, filter names and a message box's whole text; they used
  // to be English in every language (2.1.41 pass: "Export as Markdown" in a German app).
  const files = (readdirSync('src/main', { recursive: true }) as string[])
    .filter(name => name.endsWith('.ts')).map(name => `src/main/${name.replaceAll('\\', '/')}`);
  const literals: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const call of source.matchAll(/show(?:Open|Save)Dialog\(|showMessageBox\(/g)) {
      // The options object is written in the call or declared just above it.
      const around = source.slice(Math.max(0, call.index - 600), call.index + 900);
      for (const match of around.matchAll(/\b(?:title|message|name):\s*['`][^'`]+['`]|\bbuttons:\s*\[\s*['`][^'`]+['`]/g)) {
        literals.push(`${file}: ${match[0]}`);
      }
    }
  }
  expect([...new Set(literals)]).toEqual([]);
});

it('labels every file dialog where macOS shows it too', () => {
  // macOS open and save panels do not show `title`, only `message`: on the Mac, "Approve a folder
  // for ChatGPT" and the other pickers said nothing about what they were for (2.1.41 pass).
  const files = (readdirSync('src/main', { recursive: true }) as string[])
    .filter(name => name.endsWith('.ts')).map(name => `src/main/${name.replaceAll('\\', '/')}`);
  const unlabeled: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const call of source.matchAll(/show(?:Open|Save)Dialog\(/g)) {
      const around = source.slice(Math.max(0, call.index - 600), call.index + 400);
      if (!/dialogLabel\(/.test(around)) unlabeled.push(`${file}:${source.slice(0, call.index).split('\n').length}`);
    }
  }
  expect(unlabeled).toEqual([]);
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

it('publishes and restores all tunnel-loss notice texts in the selected language', async () => {
  const sources = [
    'Core connection lost',
    'Desktop connection lost',
    'Plugins connection lost',
    'The tunnel disconnected unexpectedly. Open Chat On Steroids to check the connection.'
  ] as const;
  expect(MAIN_TEXTS).toEqual(expect.arrayContaining([...sources]));
  window.localStorage.setItem('cos.ui.language', 'de');
  const { mainTexts } = await import('../src/renderer/main-texts.js');
  const before = await import('../src/main/main-texts.js');
  before.setMainTextTranslations(mainTexts());
  for (const source of sources) {
    expect(before.mainText(source)).toBe(de[source]);
    expect(before.mainText(source)).not.toBe(source);
  }
  const saved = JSON.parse(JSON.stringify(before.mainTextTranslations()));

  vi.resetModules();
  const after = await import('../src/main/main-texts.js');
  after.restoreMainTextTranslations(saved);
  for (const source of sources) expect(after.mainText(source)).toBe(de[source]);
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

it('gives a file dialog the same translated text as title and macOS message', async () => {
  const texts = await import('../src/main/main-texts.js');
  texts.setMainTextTranslations({ 'Attach files': 'Dateien anhängen' });
  try { expect(texts.dialogLabel('Attach files')).toEqual({ title: 'Dateien anhängen', message: 'Dateien anhängen' }); }
  finally { texts.setMainTextTranslations({}); }
});
