import { describe, expect, it } from 'vitest';
// @ts-expect-error The planner is a plain Node script without type declarations.
import { planFailFirst } from '../scripts/pr-fail-first.mjs';

const plan = planFailFirst as (nameStatus: string) => { tests: string[]; restore: string[]; remove: string[] };

describe('fail-first proof plan', () => {
  it('runs changed tests against base code: restores changed code and removes added code', () => {
    expect(plan([
      'M\tsrc/main/bridge.ts',
      'A\tsrc/main/new-owner.ts',
      'M\ttest/bridge.test.ts',
      'A\ttest/new-owner.test.ts',
      'M\tAGENTS.md',
      'M\tsrc/renderer/locales/de.json'
    ].join('\n'))).toEqual({
      tests: ['test/bridge.test.ts', 'test/new-owner.test.ts'],
      restore: ['src/main/bridge.ts', 'src/renderer/locales/de.json'],
      remove: ['src/main/new-owner.ts']
    });
  });

  it('keeps test support code and deleted files out, and follows renames', () => {
    expect(plan([
      'M\tscripts/verify-chat-switch.cjs',
      'M\tscripts/fixtures/composer-ui.js',
      'D\tsrc/main/old.ts',
      'R087\tsrc/main/a.ts\tsrc/main/b.ts',
      'M\ttest/helpers.ts'
    ].join('\n'))).toEqual({ tests: [], restore: ['src/main/a.ts'], remove: ['src/main/b.ts'] });
  });
});
