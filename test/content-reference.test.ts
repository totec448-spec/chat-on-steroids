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

it('handles directives ChatGPT adds later without a new fix per name', async () => {
  const { hasProviderDirective, withoutProviderDirectives, resolvedCapture } = await import('../src/shared/content-reference.js');
  // An unknown leaf directive: the page's rendering wins, otherwise the line is dropped.
  const leaf = 'Here you go:\n::chatgpt-entity{type="place" id="42"}\nDone.';
  expect(hasProviderDirective(leaf)).toBe(true);
  expect(modelFacingText(leaf, { text: '<p>Here you go:</p><p>Berlin</p><p>Done.</p>' })).toBe('Here you go:\nBerlin\nDone.');
  expect(withoutProviderDirectives(leaf)).toBe('Here you go:\n\nDone.');
  // An unknown container keeps its inner text when nothing better is recorded.
  const container = ':::canvas{title="Plan"}\nStep one\nStep two\n:::';
  expect(hasProviderDirective(container)).toBe(true);
  expect(modelFacingText(container)).toBe('Step one\nStep two');
  // A capture that still shows raw directives is not a resolution.
  expect(resolvedCapture({ text: '<p>::chatgpt-entity{id="1"}</p>' })).toBe(false);
  // Not directives: the writing card (drawn by the app), emoji shortcodes, prose with colons.
  expect(hasProviderDirective(':::writing{title="x"}\nText\n:::')).toBe(false);
  expect(hasProviderDirective('Great :smile: work')).toBe(false);
  expect(hasProviderDirective('Note: the ratio is 3::1 here')).toBe(false);
});
