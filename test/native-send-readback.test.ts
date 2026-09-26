import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';
import { normalizeUserPromptFrame, prependUserPrompt, userPromptText } from '../src/shared/user-prompt.js';

const source = readFileSync('extension/content.js', 'utf8');
const section = source.slice(source.indexOf('  function matchesSubmittedUser('), source.indexOf('  /** An app-owned bootstrap'));
const expected = '[[COS_CONTEXT:7]]\n# rules\n[[/COS_CONTEXT]]\n\nUse C:\\tools\\file.ts';
const serialized = expected.replace(/\\/g, '\\\\').replace(/^#/gm, '\\#').replace(/\n/g, '\\\n');
function matcher(canonical = true, exact = true) {
  const context = vm.createContext({ userMessageSource: () => ({ text: serialized, canonical }),
    CLF_DOM: { userMessageReadback: (message: { text: string }) => exact ? message.text : null },
    sendText: (text: string) => text.replace(/\s+/g, '') });
  vm.runInContext(section + ';globalThis.check = matchesSubmittedUser;', context);
  return { check: context.check, message: { id: 'native-user', text: expected } };
}
it('accepts native literal readback only after canonical identity and exact slot proof', () => {
  const f = matcher(); expect(f.check(f.message, expected)).toBe(true);
});
it.each([[false, true], [true, false]])('rejects unproved readback (canonical=%s, exact=%s)', (canonical, exact) => {
  const f = matcher(canonical, exact); expect(f.check(f.message, expected)).toBe(false);
});
it('does not erase literal path backslashes or accept an edited visible message', () => {
  const f = matcher(); f.message.text = 'Use C:toolsfile.ts'; expect(f.check(f.message, expected)).toBe(false);
});
it('normalizes only a complete length-validated native context frame', () => {
  expect(userPromptText(serialized)).toBe('Use C:\\tools\\file.ts');
  expect(userPromptText(serialized.replace('COS_CONTEXT:7', 'COS_CONTEXT:6'))).toBeNull();
  expect(normalizeUserPromptFrame('ordinary \\# Markdown\\\nline')).toBe('ordinary \\# Markdown\\\nline');
  expect(userPromptText(prependUserPrompt('Keep \\# literal', '# rules'))).toBe('Keep \\# literal');
});
