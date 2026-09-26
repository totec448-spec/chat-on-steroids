import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { continuationMarkerOf, unescapeMarkdown } from '../src/shared/session.js';

// The unbundled browser reader must agree with the main/store/renderer reader.
const content = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const begin = content.indexOf('  const unescapeMarkdown =');
const end = content.indexOf('  /** Receipt, transcript', begin);
const declarations = content.split('\n').filter(line => /^\s*const CONTINUATION_MARKER(?:_ESCAPED)? =/.test(line));
if (begin < 0 || end < 0 || declarations.length !== 2) throw new Error('Continuation reader not found');
const pageMarker = vm.runInNewContext(`${declarations.join('\n')}\n${content.slice(begin, end)}\nmarkedAs`) as
  (text: string) => RegExpMatchArray | null;
const pageUnescape = vm.runInNewContext(`${declarations.join('\n')}\n${content.slice(begin, end)}\nunescapeMarkdown`) as
  (text: string) => string;
const token = '_0123456789abc-def';
const clean = `[[CLF-RESUME:${token}]]`;

describe('continuation markers from native readback', () => {
  it.each([
    clean,
    clean.replace(':', '\\:'),
    clean.replace('_', '\\_'),
    clean.replace(/([\[\]:_-])/g, '\\$1'),
    `\n${clean.replace(':', '\\:')}`
  ])('keeps the same token and exact removable marker for %s', marker => {
    const text = `${marker}\n\nKeep C:\\_work and the rest of the brief unchanged.`;
    const parsed = continuationMarkerOf(text);
    expect(parsed).toMatchObject({ kind: 'RESUME', token, marker: `${marker}\n` });
    expect(pageMarker(text)?.[2]).toBe(token);
    expect(text.slice(parsed!.marker.length)).toBe('\nKeep C:\\_work and the rest of the brief unchanged.');
  });

  it.each([
    clean.replace('0', '\\0'),
    clean.replace('a', '\\a'),
    clean.replace('_', '\\\\_'),
    `prefix ${clean}`,
    `[[CLF-RESUME:${'a'.repeat(15)}]]`,
    `[[CLF-RESUME:${'a'.repeat(65)}]]`,
    `${clean}extra`,
    clean.replace('_', 'é')
  ])('refuses malformed or non-leading marker %s in both readers', text => {
    expect(continuationMarkerOf(text)).toBeNull();
    expect(pageMarker(text)).toBeNull();
  });
});

describe('page readback unescaping', () => {
  // #426: ChatGPT stores composer hard breaks as `\<newline>`; both readers must drop them.
  it.each([
    ['[[COS_CONTEXT:34]]\\\nYou are worker-1.\\\nRun it.', '[[COS_CONTEXT:34]]\nYou are worker-1.\nRun it.'],
    ['a\\\r\nb', 'a\nb'],
    ['Keep C:\\_work and \\* unchanged', 'Keep C:_work and * unchanged'],
    ['no escapes here', 'no escapes here']
  ])('reads %j as %j in both readers', (raw, typed) => {
    expect(unescapeMarkdown(raw)).toBe(typed);
    expect(pageUnescape(raw)).toBe(typed);
  });
});
