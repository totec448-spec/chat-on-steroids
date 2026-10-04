import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';

// Settings and controls explain themselves in the user's words. These internal terms reached the
// interface before ("no conversation selection", "without chat attribution", "surfaces") and read as
// jargon to users. Names the interface shows as labels ("Unattributed activity") stay allowed.
const INTERNAL = /\b(conversation selection|chat attribution|provenance|ledger|epoch|custody|tombstone|surfaces|swarm|account-observed)\b/i;

it('keeps internal terms out of the text users read in the app', () => {
  const dom = new JSDOM(readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8'));
  try {
    const doc = dom.window.document;
    const texts: string[] = [];
    const walker = doc.createTreeWalker(doc.body, dom.window.NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest('script, style')) continue;
      const text = node.textContent!.replace(/\s+/g, ' ').trim();
      if (text) texts.push(text);
    }
    for (const element of doc.querySelectorAll('[title], [placeholder], [aria-label]')) {
      for (const name of ['title', 'placeholder', 'aria-label']) {
        const value = element.getAttribute(name);
        if (value) texts.push(value);
      }
    }
    expect(texts.filter(text => INTERNAL.test(text))).toEqual([]);
  } finally { dom.window.close(); }
});
