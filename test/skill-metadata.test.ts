import { expect, it } from 'vitest';
import { parseSkillConfiguration, parseSkillFrontmatter, parseSkillInterface } from '../src/main/skill-metadata.js';

it('treats block and inline YAML policy identically and preserves folded descriptions', () => {
  expect(parseSkillInterface('policy:\n  allow_implicit_invocation: false')).toEqual({ allowImplicitInvocation: false });
  expect(parseSkillInterface('policy: { allow_implicit_invocation: false }')).toEqual({ allowImplicitInvocation: false });
  expect(parseSkillFrontmatter('---\nname: Review\ndescription: >-\n  Read code\n  before editing.\n---\nBody')).toEqual({ name: 'Review', description: 'Read code before editing.' });
});
it('rejects ambiguous, executable and malformed policy metadata instead of enabling it', () => {
  for (const text of ['policy: { allow_implicit_invocation: "false" }', 'policy: false',
    'policy:\n  allow_implicit_invocation: false\n  allow_implicit_invocation: true', 'policy: !!js/function function() {}'])
    expect(() => parseSkillInterface(text)).toThrow();
  expect(() => parseSkillInterface('a: '.repeat(30) + 'false')).toThrow();
  expect(() => parseSkillInterface(Array.from({ length: 2100 }, (_, index) => `key${index}: value`).join('\n')))
    .toThrow(/too many values/);
  expect(() => parseSkillInterface('policy: &policy { allow_implicit_invocation: false }\ncopy: *policy'))
    .toThrow();
});
it('reads TOML controls with ordinary TOML string, comment and inline-table syntax', () => {
  expect(parseSkillConfiguration('[skills]\ninclude_instructions = false\nmax_context_tokens = 2_000\nbundled = { enabled = false }\n[[skills.config]]\nname = "Review #1" # literal hash\nenabled = false')).toEqual({
    includeInstructions: false, maxContextTokens: 2000, bundledEnabled: false, rules: [{ name: 'Review #1', enabled: false }]
  });
  expect(() => parseSkillConfiguration('[skills]\nconfig = [{ name = "review", path = "other", enabled = true }]')).toThrow();
});
