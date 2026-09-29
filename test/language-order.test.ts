import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';

// Languages read as a list people scan by their own language's name: Latin-script names in
// alphabetical order, then Japanese and Chinese. A new language is sorted in, not appended.
const ORDER = ['de', 'en', 'es', 'fr', 'pt-BR', 'pt-PT', 'tr', 'ja', 'ko', 'zh-CN', 'zh-TW'];

it('lists languages in the same native-name order in Appearance and Setup', () => {
  const page = new JSDOM(readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8'));
  const doc = page.window.document;
  expect([...doc.querySelectorAll<HTMLOptionElement>('#uiLanguage option')].map(option => option.value)).toEqual(ORDER);
  expect([...doc.querySelectorAll<HTMLElement>('.language-tabs [data-language]')].map(button => button.dataset.language)).toEqual(ORDER);
  page.window.close();
});
