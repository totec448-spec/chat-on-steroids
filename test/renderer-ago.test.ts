import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * 2.1.47 round (the user): the chat list said "389h ago". Ages go on to days, weeks, months and
 * years, in the person's language; seconds, minutes and hours keep their catalog wording.
 */
let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 28, 12, 0));
});
afterEach(() => { vi.useRealTimers(); dom.window.close(); });

const hour = 3_600_000, day = 24 * hour;
async function inLanguage(locale: 'en' | 'de' | 'fr' | 'ja') {
  const i18n = await import('../src/renderer/i18n.js');
  i18n.initLanguage(); i18n.setLanguage(locale);
  return import('../src/renderer/dom.js');
}

it('says days, weeks, months and years in English, short like the hours', async () => {
  const { ago, shortAgo } = await inLanguage('en');
  const at = (ms: number) => Date.now() - ms;
  expect(ago(at(3 * hour))).toBe('3h ago');
  expect(ago(at(16 * day + 5 * hour))).toBe('2w ago');
  expect(ago(at(2 * day))).toBe('2d ago');
  expect(ago(at(120 * day))).toBe('4mo ago');
  expect(ago(at(800 * day))).toBe('2y ago');
  expect([shortAgo(at(3 * hour)), shortAgo(at(2 * day)), shortAgo(at(16 * day)), shortAgo(at(120 * day)), shortAgo(at(800 * day))])
    .toEqual(['3h', '2d', '2w', '4mo', '2y']);
});

it('says them in the chosen language, never with a bare minus sign', async () => {
  const de = await inLanguage('de');
  expect(de.ago(Date.now() - 2 * day)).toBe('vor 2 Tagen');
  expect(de.ago(Date.now() - 3 * hour)).toBe('vor 3 h');
  vi.resetModules();
  const fr = await inLanguage('fr');
  const said = fr.ago(Date.now() - 16 * day);
  expect(said).toMatch(/^il y a 2 sem/);
  expect(said.startsWith('-')).toBe(false);
});

it('writes the compact tokens from the catalogs, so months never read like minutes (CodeRabbit)', async () => {
  const ja = await inLanguage('ja' as never);
  expect([ja.shortAgo(Date.now() - 4 * 60_000), ja.shortAgo(Date.now() - 120 * day), ja.shortAgo(Date.now() - 16 * day)]).toEqual(['4分', '4か月', '2週']);
  vi.resetModules();
  const de = await inLanguage('de');
  expect([de.shortAgo(Date.now() - 2 * day), de.shortAgo(Date.now() - 800 * day)]).toEqual(['2 T.', '2 J.']);
});

it('says "never" for a time that is missing or not a number, and never throws (2.1.47: UI checks)', async () => {
  // Fixtures without an updatedAt made RelativeTimeFormat throw and the whole chat list stayed empty.
  const { ago, shortAgo } = await inLanguage('de');
  for (const missing of [undefined, Number.NaN, Number.POSITIVE_INFINITY] as never[]) {
    expect(() => ago(missing)).not.toThrow();
    expect(ago(missing)).toBe('nie');
    expect(shortAgo(missing)).toBe('—');
  }
});

// CodeRabbit on #1904: the worker panel, background processes and tunnel uptime showed the
// English unit letters ("3d 4h") in every language. They take the catalogs' tokens too.
it('writes elapsed durations with the chosen language\'s unit tokens', async () => {
  const en = await inLanguage('en');
  expect(en.elapsedDurationText(3 * 86_400 + 4 * 3600 + 59, 2)).toBe('3d 4h');
  expect(en.elapsedDurationText(86_400, 1)).toBe('1d');
  expect(en.elapsedDurationText(0, 2)).toBe('0s');
  vi.resetModules();
  const de = await inLanguage('de');
  expect(de.elapsedDurationText(3 * 86_400 + 4 * 3600, 2)).toBe('3 T. 4 h');
  expect(de.elapsedDurationText(86_400, 1)).toBe('1 T.');
  expect(de.elapsedDurationText(Number.NaN, 2)).toBe('0 s');
});
