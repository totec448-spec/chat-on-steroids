import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { beforeAll, afterAll, expect, it } from 'vitest';

let dom: JSDOM;
let renderedMarkdown: typeof import('../src/renderer/chat.js').renderedMarkdown;

beforeAll(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://local.test/' });
  Object.defineProperty(dom.window, 'api', { value: {}, configurable: true });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node
  });
  ({ renderedMarkdown } = await import('../src/renderer/chat.js'));
});
afterAll(() => dom.window.close());

it('produces actual renderer output for the offscreen real-Electron visual check', () => {
  const screenshotExample = renderedMarkdown(
    '## Examples from sample data\n\n' +
    '✅ **Strong matching candidate**\n\nCSV: `Sample product 20mg 30 tablets`\n\n' +
    'Existing: `SAMPLE PRODUCT 20MG 30 TABLETS`\n\n98% name similarity.\n\n---\n\n' +
    '⚠️ **Must not merge automatically**\n\nCSV: `Example product 70mg 60 tablets`\n\n' +
    'Existing: `EXAMPLE PRODUCT 50MG 60 TABLETS`\n\nStrength differs.'
  );
  const form = '<p>Review these candidates.</p><form><fieldset><legend>How should I proceed?</legend>' +
    '<label><input type="radio" name="choice">Merge strong matches only</label>' +
    '<label><input type="radio" name="choice">Review all matches</label>' +
    '<button type="submit" onclick="alert(1)">Continue</button></fieldset></form>';
  const question = renderedMarkdown(
    '::chatgpt-content-reference{index="0" source_message_id="synthetic-message"}',
    { text: form, truncated: false, chars: form.length }
  );
  const choiceCapture = '<p>Which option should we use?</p><div role="radiogroup" aria-label="Which option should we use?">' +
    '<div role="radio">Keep the original</div><div role="radio">Merge the records</div></div>';
  const choices = renderedMarkdown('**Which option should we use?**',
    { text: choiceCapture, truncated: false, chars: choiceCapture.length });
  const sections = [screenshotExample, question, choices];
  expect(screenshotExample.querySelectorAll('code')).toHaveLength(4);
  expect(question.textContent).toContain('How should I proceed?');
  expect(choices.textContent).toContain('Merge the records');
  expect(sections.every(section => !section.querySelector('form, input, button, textarea, select, [role="radio"], [onclick]'))).toBe(true);

  // This is an opt-in local visual artifact, not a fixture containing real chat/account data.
  const dir = process.env.COS_PROMPT_VISUAL_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'actual-renderer-fragments.html'),
      sections.map((section, i) => `<section class="qa-section" data-test="${i + 1}">${section.outerHTML}</section>`).join('\n'), 'utf8');
  }
});
