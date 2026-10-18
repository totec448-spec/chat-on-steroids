import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const extension = path.join(root, 'extension');
const expectedLocales = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt_BR', 'pt_PT', 'ru', 'tr', 'vi', 'zh_CN', 'zh_TW'];

type MessageEntry = {
  message: string;
  description?: string;
  placeholders?: Record<string, { content: string; example?: string }>;
};

type Catalog = Record<string, MessageEntry>;

function substitutionTokens(message: string): string[] {
  return [...message.matchAll(/\$([1-9])/g)].map((match) => match[0]).sort();
}

async function catalog(locale: string): Promise<Catalog> {
  return JSON.parse(await readFile(path.join(extension, '_locales', locale, 'messages.json'), 'utf8')) as Catalog;
}

function codeKeys(source: string): string[] {
  const keys = new Set<string>();
  for (const match of source.matchAll(/\bt\(\s*['"]([A-Za-z0-9_]+)['"]/g)) keys.add(match[1]!);
  for (const key of pluralCodeKeys(source)) keys.add(key);
  return [...keys].sort();
}

/** Keys counted with `tn(key, count, …)`: each has a form per plural category of each language. */
function pluralCodeKeys(source: string): string[] {
  return [...new Set([...source.matchAll(/\btn\(\s*['"]([A-Za-z0-9_]+)['"]/g)].map(match => match[1]!))].sort();
}
const PLURAL_FORM = /__(zero|one|two|few|many)$/;

function markupKeys(source: string): string[] {
  const keys = new Set<string>();
  for (const match of source.matchAll(/\bdata-i18n(?:-title|-aria-label)?=["']([A-Za-z0-9_]+)["']/g)) keys.add(match[1]!);
  return [...keys].sort();
}

function manifestKeys(value: unknown): string[] {
  const keys = new Set<string>();
  const visit = (item: unknown) => {
    if (typeof item === 'string') {
      const match = /^__MSG_([A-Za-z0-9_]+)__$/.exec(item);
      if (match) keys.add(match[1]!);
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) visit(child);
    }
  };
  visit(value);
  return [...keys].sort();
}

describe('extension localization catalogs', () => {
  it('ships the supported companion languages with Chrome locale names', async () => {
    const localesRoot = path.join(extension, '_locales');
    const found = (await readdir(localesRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(found).toEqual(expectedLocales.slice().sort());
  });

  it('keeps manifest and isolated-world localization ordered and resolvable', async () => {
    const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8')) as Record<string, any>;
    expect(manifest.default_locale).toBe('en');
    const isolated = manifest.content_scripts.find((entry: any) => (entry.world ?? 'ISOLATED') === 'ISOLATED');
    expect(isolated?.js).toEqual(expect.arrayContaining(['i18n.js', 'chatgpt-dom.js', 'content.js']));
    expect(isolated?.js.indexOf('i18n.js')).toBeLessThan(isolated?.js.indexOf('chatgpt-dom.js'));
    expect(isolated?.js.indexOf('chatgpt-dom.js')).toBeLessThan(isolated?.js.indexOf('content.js'));

    const english = await catalog('en');
    for (const key of manifestKeys(manifest)) expect(english[key], `manifest message ${key}`).toBeDefined();
  });

  it('keeps every locale key and placeholder-compatible with English', async () => {
    const english = await catalog('en');
    // Plural forms differ by language by design; the plural test holds each language to its own.
    const englishKeys = Object.keys(english).filter(key => !PLURAL_FORM.test(key)).sort();
    expect(englishKeys.length).toBeGreaterThan(0);

    for (const locale of expectedLocales) {
      const messages = await catalog(locale);
      expect(Object.keys(messages).filter(key => !PLURAL_FORM.test(key)).sort(), locale).toEqual(englishKeys);
      for (const key of Object.keys(messages)) {
        const entry = messages[key]!;
        const source = english[key.replace(PLURAL_FORM, '')]!;
        expect(entry.message.trim(), `${locale}:${key}`).not.toBe('');
        expect(Object.keys(entry.placeholders ?? {}).sort(), `${locale}:${key}:placeholders`).toEqual(
          Object.keys(source.placeholders ?? {}).sort()
        );
        expect(substitutionTokens(entry.message), `${locale}:${key}:substitutions`).toEqual(
          substitutionTokens(source.message)
        );
      }
    }
  });

  it('words every counted message in each language\'s own plural forms, and keeps no form a language does not have', async () => {
    const sources = await Promise.all(['popup.js', 'content.js'].map(file => readFile(path.join(extension, file), 'utf8')));
    const counted = [...new Set(sources.flatMap(pluralCodeKeys))].sort();
    expect(counted.length).toBeGreaterThan(10);
    for (const locale of expectedLocales) {
      const messages = await catalog(locale);
      const forms = new Intl.PluralRules(locale.replace('_', '-')).resolvedOptions().pluralCategories.filter(form => form !== 'other');
      expect(Object.keys(messages).filter(key => PLURAL_FORM.test(key)).sort(), locale)
        .toEqual(counted.flatMap(key => forms.map(form => `${key}__${form}`)).sort());
    }
  });

  it('covers every literal popup/content t() key in every locale', async () => {
    const [popupHtml, popup, content, english] = await Promise.all([
      readFile(path.join(extension, 'popup.html'), 'utf8'),
      readFile(path.join(extension, 'popup.js'), 'utf8'),
      readFile(path.join(extension, 'content.js'), 'utf8'),
      catalog('en')
    ]);
    const used = [...new Set([...markupKeys(popupHtml), ...codeKeys(popup), ...codeKeys(content)])].sort();
    expect(used.length).toBeGreaterThan(0);
    for (const key of used) expect(english[key], `missing English extension message ${key}`).toBeDefined();
  });

  // #1086: two different failures shared one key, so the page that never got a message box reported
  // "after model selection" in every language. A key names one text, and English says what the code says.
  it('gives every content t() key one English text, the one its call site falls back to', async () => {
    const content = await readFile(path.join(extension, 'content.js'), 'utf8');
    const english = await catalog('en');
    const fallbacks = new Map<string, Set<string>>();
    for (const match of content.matchAll(/\bt\(\s*'([a-z0-9_]+)'\s*,\s*'((?:[^'\\]|\\.)*)'/g)) {
      const text = match[2]!.replace(/\\'/g, "'");
      fallbacks.set(match[1]!, (fallbacks.get(match[1]!) ?? new Set()).add(text));
    }
    expect(fallbacks.size).toBeGreaterThan(10);
    for (const [key, texts] of fallbacks) {
      expect([...texts], `${key} is used for different texts`).toHaveLength(1);
      expect((english[key] as { message: string }).message, `${key}: English differs from its fallback`).toBe([...texts][0]);
    }
  });
});
