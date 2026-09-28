import { expect, it } from 'vitest';
import { hasContentReference, modelFacingText, plainTextOfHtml } from '../src/shared/content-reference.js';

const pointer = '::chatgpt-content-reference{index="0" source_message_id="d2b82e00-509e-4a87-aa93-00bcde251680"}';

it('reads a pointer-only reply from the page capture that resolved it (#574)', () => {
  const capture = { text: '<p>Hi! How can I <strong>help</strong> you today?</p><ul><li>Plan &amp; build</li><li>Fix a bug</li></ul>', truncated: false };
  expect(hasContentReference(pointer)).toBe(true);
  expect(modelFacingText(pointer, capture)).toBe('Hi! How can I help you today?\nPlan & build\nFix a bug');
});

it('keeps ordinary text and falls back safely without a usable capture', () => {
  expect(modelFacingText('A normal reply', { text: '<p>ignored</p>' })).toBe('A normal reply');
  expect(modelFacingText(`Intro\n${pointer}\nOutro`)).toBe('Intro\n\nOutro');
  expect(modelFacingText(pointer)).toBe('[This reply points to content from another message that was not recorded.]');
  expect(modelFacingText(pointer, { text: `<p>${pointer}</p>` })).not.toContain('::chatgpt-content-reference');
  expect(modelFacingText(pointer, { text: '<p>cut</p>', truncated: true })).not.toContain('cut');
  // Quoted in code it is text, not a pointer.
  expect(hasContentReference(`Use \`${pointer}\` in docs`)).toBe(false);
  expect(plainTextOfHtml('<p>a&#39;b &#x41; &nbsp;c</p><script>x()</script>')).toBe("a'b A  c");
});
