import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Language } from '../src/renderer/i18n.js';

const languages: Language[] = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'pt-PT', 'ru', 'tr', 'vi', 'zh-CN', 'zh-TW'];
let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM('<body></body>', { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
});
afterEach(() => { vi.unstubAllGlobals(); dom.window.close(); });

// These reasons originate outside the renderer's literal t() scan. Exercise the public
// strings from updater/read-state failures, including interpolated asset and HTTP reasons.
const reasons = [
  'GitHub could not be reached',
  'There is no downloaded update to install yet',
  'Could not read plugin-refresh state',
  'the latest release has no usable version tag',
  'the release page named no usable version tag',
  'it is not the published file',
  'the staged artifact changed after verification',
  'the release page answered 503',
  'latest answered 401',
  'SHA256SUMS.txt answered 404',
  'release 99.0.0 publishes no fixture.AppImage',
  'downloading fixture.exe returned no content',
  'fixture.exe is not the published file: sha256 ' + 'a'.repeat(64) + ' instead of ' + 'b'.repeat(64)
];
it('covers the authored fixed updater errors outside the renderer source scan', () => {
  for (const file of ['src/main/update.ts', 'src/main/update-all.ts']) {
    const source = readFileSync(file, 'utf8');
    const fixed = [...source.matchAll(/throw new Error\('([^']+)'\)/g)].map(match => match[1]!);
    expect(fixed.length).toBeGreaterThan(0);
    expect(fixed.filter(reason => !reasons.includes(reason)), file).toEqual([]);
  }
});
it.each(languages)('localizes the main-process update reasons and recovery guidance in %s', async locale => {
  const { setLanguage, t } = await import('../src/renderer/i18n.js');
  const { updateErrorText, updateErrorNextStep } = await import('../src/renderer/update-error.js');
  setLanguage('en');
  const english = reasons.map(updateErrorText);
  const englishRecovery = updateErrorNextStep('Could not read plugin-refresh state');
  setLanguage(locale);
  for (let i = 0; i < reasons.length; i++) {
    const text = updateErrorText(reasons[i]!);
    expect(text.trim()).not.toBe('');
    expect(text).not.toMatch(/\{\d+\}/);
    if (locale !== 'en') expect(text, reasons[i]).not.toBe(english[i]);
  }
  expect(updateErrorText('SHA256SUMS.txt answered 404')).toContain('SHA256SUMS.txt');
  expect(updateErrorText('SHA256SUMS.txt answered 404')).toContain('404');
  expect(updateErrorText('release 99.0.0 publishes no fixture.AppImage')).toContain('99.0.0');
  expect(updateErrorText('release 99.0.0 publishes no fixture.AppImage')).toContain('fixture.AppImage');
  const recovery = updateErrorNextStep('Could not read plugin-refresh state');
  expect(recovery).toContain(t('Activity'));
  expect(recovery.toLowerCase()).toContain(t('Diagnostics report').toLowerCase());
  if (locale !== 'en') expect(recovery).not.toBe(englishRecovery);
  expect(recovery).not.toContain(t('Choose Update all to retry.'));
});
it('keeps unknown external diagnostics intact and offers explicit retry', async () => {
  const { setLanguage, t } = await import('../src/renderer/i18n.js');
  const { updateErrorText, updateErrorNextStep } = await import('../src/renderer/update-error.js');
  setLanguage('ja');
  const authored = 'fixture-provider: unexpected reply {0}';
  expect(updateErrorText(authored)).toBe(authored);
  expect(updateErrorText('fetch failed')).toBe('fetch failed');
  expect(updateErrorNextStep(authored)).toBe(t('Choose Update all to retry.'));
});
