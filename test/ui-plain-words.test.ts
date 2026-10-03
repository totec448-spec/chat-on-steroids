import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// Settings and controls explain themselves in the user's words. These internal terms reached the
// interface before ("no conversation selection", "without chat attribution", "surfaces") and read as
// jargon to users. Names the interface shows as labels ("Unattributed activity") stay allowed.
const INTERNAL = /\b(conversation selection|chat attribution|provenance|ledger|epoch|custody|tombstone|surfaces)\b/i;

it('keeps internal terms out of the text users read in the app', () => {
  const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8')
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '');
  const texts = [...html.matchAll(/>([^<>]{8,})</g), ...html.matchAll(/(?:title|placeholder|aria-label)="([^"]{8,})"/g)]
    .map(match => match[1]!.replace(/\s+/g, ' ').trim());
  expect(texts.filter(text => INTERNAL.test(text))).toEqual([]);
});
