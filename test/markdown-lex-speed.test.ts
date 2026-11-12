import { expect, it } from 'vitest';
import { Marked } from 'marked';
import { markdownVisibleText } from '../src/shared/markdown-text.js';

// marked 18.1.2 took 4 to 13 seconds on 48,000 characters of unmatched emphasis markers in one
// paragraph, and every message is drawn through it, so a long paragraph froze the window. 18.2.0 is
// linear; the 2 s ceiling is far above its ~20 ms and far below the old time.
// (Alternating '*' and '_' markers, '*a_' repeated, are still quadratic in 18.2.0; that input does not
// occur in prose, so it is not asserted here.)
const unmatched = ['_x ', '**bold '];

it.each(unmatched)('reads 48,000 characters of unmatched emphasis (%s) without stalling', unit => {
  const text = unit.repeat(Math.ceil(48_000 / unit.length));
  const started = performance.now();
  const html = new Marked({ gfm: true, breaks: true }).parse(text, { async: false });
  const visible = markdownVisibleText(text);
  expect(performance.now() - started).toBeLessThan(2_000);
  expect(html.length).toBeGreaterThan(0);
  expect(visible.length).toBeGreaterThan(0);
});
