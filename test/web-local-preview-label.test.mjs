import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { WEB_LOCAL_MESSAGES } from '../src/main/web-local/messages.mjs';

const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');

test('developer Settings has exactly one honest read-only Web Local preview row', () => {
  const html = read('src/renderer/index.html');
  const row = html.match(/<div class="setting"><span class="setting-text"><b>Web Local[^<]*<\/b>[\s\S]*?<button class="btn" id="webLocalOpen"[^>]*>[^<]*<\/button>[\s\S]*?<\/div>/);
  assert.ok(row, 'Settings must have a Web Local row');
  assert.equal((html.match(/id="webLocalOpen"/g) ?? []).length, 1, 'only one activation button');
  assert.match(row[0], /Web Local preview \(read-only\)/);
  assert.match(row[0], /Preview up to 50 local Project names in your browser\. No chats, actions or remote access\./);
  assert.match(row[0], />Open preview<\/button>/);
  assert.equal(row[0].includes('ico '), false, 'no new icon is needed for the preview');
});

test('every Desktop locale translates the same preview labels without stale full-feature keys', () => {
  const locales = ['de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'pt-PT', 'ru', 'tr', 'vi', 'zh-CN', 'zh-TW'];
  const keys = [
    'Web Local preview (read-only)',
    'Preview up to 50 local Project names in your browser. No chats, actions or remote access.',
    'Open preview'
  ];
  for (const locale of locales) {
    const translations = JSON.parse(read(`src/renderer/locales/${locale}.json`));
    for (const key of keys) assert.ok(typeof translations[key] === 'string' && translations[key].trim(), `${locale}: ${key}`);
    assert.equal(Object.hasOwn(translations, 'Web Local (read-only)'), false, `${locale}: old title removed`);
    assert.equal(Object.hasOwn(translations, 'Open Web Local'), false, `${locale}: old button removed`);
  }
  assert.match(WEB_LOCAL_MESSAGES.en.title, /Web Local preview/);
});
