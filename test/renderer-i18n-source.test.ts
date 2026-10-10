import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { RECOMMENDED_SKILLS } from '../src/shared/recommended-skills.js';

/**
 * The catalog tests compare the catalogs with each other, so a string that no catalog has
 * never failed anything: the Pets and Skills pages shipped 18 English-only labels that way,
 * most of them chosen with `t(cond ? 'a' : 'b')`. This reads the renderer sources instead.
 */
const LOCALES = ['de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'pt-PT', 'ru', 'tr', 'vi', 'zh-CN', 'zh-TW'];
// Not interface text: a Git ref name passed through t() alongside the branch.
const UNTRANSLATED = new Set(['HEAD']);

function sourceKeys(): Map<string, string> {
  const literal = String.raw`(['"])((?:\\.|(?!\1).)*)\1`;
  const direct = new RegExp(String.raw`\bt\(\s*` + literal, 'g');
  const chosen = new RegExp(String.raw`\bt\(\s*[^()'"]*?\?\s*` + literal + String.raw`\s*:\s*` + literal.replace('\\1', '\\3').replace('\\1', '\\3'), 'g');
  const keys = new Map<string, string>();
  for (const file of readdirSync('src/renderer').filter(name => name.endsWith('.ts'))) {
    const text = readFileSync(`src/renderer/${file}`, 'utf8');
    for (const match of text.matchAll(direct)) keys.set(match[2]!, file);
    for (const match of text.matchAll(chosen)) { keys.set(match[2]!, file); keys.set(match[4]!, file); }
  }
  for (const key of keys.keys()) if (key.includes('\\') || UNTRANSLATED.has(key)) keys.delete(key);
  return keys;
}

it('has every literal interface string of the renderer in every catalog', () => {
  const keys = sourceKeys();
  expect(keys.size).toBeGreaterThan(500);
  for (const locale of LOCALES) {
    const catalog = JSON.parse(readFileSync(`src/renderer/locales/${locale}.json`, 'utf8')) as Record<string, string>;
    expect([...keys].filter(([key]) => !Object.hasOwn(catalog, key)).map(([key, file]) => `${file}: ${key}`), locale).toEqual([]);
  }
});

it('keeps every catalog complete, nonempty and free of duplicate keys or changed placeholders', () => {
  const entries = LOCALES.map(locale => {
    const source = readFileSync(`src/renderer/locales/${locale}.json`, 'utf8');
    return { locale, source, catalog: JSON.parse(source) as Record<string, string> };
  });
  const union = [...new Set(entries.flatMap(({ catalog }) => Object.keys(catalog)))].sort();
  const args = (value: string) => (value.match(/\{\d+\}/g) ?? []).sort();
  for (const { locale, source, catalog } of entries) {
    expect(Object.keys(catalog).sort(), locale).toEqual(union);
    const rawKeys = [...source.matchAll(/^\s{2}("(?:[^"\\]|\\.)*")\s*:/gm)].map(match => JSON.parse(match[1]!));
    expect(rawKeys, locale).toHaveLength(Object.keys(catalog).length);
    expect(new Set(rawKeys).size, locale).toBe(rawKeys.length);
    for (const [key, value] of Object.entries(catalog)) {
      expect(value.trim(), `${locale}: ${key}`).not.toBe('');
      expect(args(value), `${locale}: ${key}`).toEqual(args(key));
    }
  }
});

it('keeps the sub-agent list labels translated in the Russian catalog', () => {
  const catalog = JSON.parse(readFileSync('src/renderer/locales/ru.json', 'utf8')) as Record<string, string>;
  // Health says only a problem now (Degraded); the states and the action count are the rest.
  for (const key of ['Degraded', 'Opening', 'Waking', 'No tab', 'Idle', '{0} actions']) {
    expect(catalog[key]?.trim(), key).toBeTruthy();
  }
});

it('translates every recommended skill description in every catalog', () => {
  for (const locale of LOCALES) {
    const catalog = JSON.parse(readFileSync(`src/renderer/locales/${locale}.json`, 'utf8')) as Record<string, string>;
    expect(RECOMMENDED_SKILLS.filter(skill => !Object.hasOwn(catalog, skill.description)).map(skill => skill.id), locale).toEqual([]);
  }
});

it('translates every delivery error a queued message can show', () => {
  // The timeline shows an input row's `error` through t(); these texts live in the main process,
  // so the renderer source scan above never sees them. Internal page-to-app reason codes and
  // markers never reach the timeline as written.
  const internal = new Set([
    'Native Send did not take the message.',
    'Native Send receipt was not confirmed.',
    'User authorized a new helper',
    'session-input',
    '\\n--- New instructions from the user ---\\n'
  ]);
  const source = readFileSync('src/main/session/input.ts', 'utf8');
  const texts = new Set<string>();
  for (const match of source.matchAll(/error:\s*'([^']{12,240})'/g)) texts.add(match[1]!);
  for (const match of source.matchAll(/const [A-Z_]+ = '([^']{12,240})'/g)) texts.add(match[1]!);
  const shown = [...texts].filter(text => !internal.has(text));
  expect(shown.length).toBeGreaterThanOrEqual(9);
  for (const locale of LOCALES) {
    const catalog = JSON.parse(readFileSync(`src/renderer/locales/${locale}.json`, 'utf8')) as Record<string, string>;
    expect(shown.filter(text => !Object.hasOwn(catalog, text)), locale).toEqual([]);
  }
});
