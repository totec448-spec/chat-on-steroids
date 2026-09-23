import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const extension = path.join(root, 'extension');
const expectedLocales = ['en', 'es', 'fr', 'ja', 'tr', 'zh_CN', 'zh_TW'];

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
  return [...keys].sort();
}

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
  it('ships the supported renderer languages plus English with Chrome locale names', async () => {
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
    const englishKeys = Object.keys(english).sort();
    expect(englishKeys.length).toBeGreaterThan(0);

    for (const locale of expectedLocales) {
      const messages = await catalog(locale);
      expect(Object.keys(messages).sort(), locale).toEqual(englishKeys);
      for (const key of englishKeys) {
        const entry = messages[key]!;
        const source = english[key]!;
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
});
