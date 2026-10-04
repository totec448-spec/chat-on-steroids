import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The planner is a plain Node script without type declarations.
import { planFailFirst, runnerForFailFirst } from '../scripts/pr-fail-first.mjs';

const plan = planFailFirst as (nameStatus: string) => { tests: string[]; restore: string[]; remove: string[] };
const runner = runnerForFailFirst as (nameStatus: string) => string;

describe('fail-first proof plan', () => {
  it('bounds the workflow runner to the two named hosted platforms', () => {
    const workflow = readFileSync(new URL('../.github/workflows/pr-checklist.yml', import.meta.url), 'utf8');
    expect(workflow).toContain("runs-on: ${{ needs.fail-first-platform.outputs.runner == 'windows-2025' && 'windows-2025' || 'ubuntu-24.04' }}");
    expect(workflow).not.toContain('runs-on: ${{ needs.fail-first-platform.outputs.runner }}');
  });

  it.each(['windows-capture', 'computer', 'computer-own-windows', 'computer-windows-input'])(
    'runs changed %s native tests on Windows instead of treating skipped Linux tests as proof', name => {
      expect(runner(`M\ttest/${name}.test.ts`)).toBe('windows-2025');
    }
  );

  it('keeps ordinary tests on Linux and ignores removed or support-only Windows files', () => {
    expect(runner('M\ttest/projects.test.ts\nD\ttest/windows-capture.test.ts\nM\ttest/fixtures/windows-desktop/capture.cs')).toBe('ubuntu-24.04');
    expect(runner('M\tsrc/main/computer/windows-capture.ts\nM\tAGENTS.md')).toBe('ubuntu-24.04');
  });

  it('uses the destination of a renamed test when selecting the native runner', () => {
    expect(runner('R100\ttest/old.test.ts\ttest/windows-capture.test.ts')).toBe('windows-2025');
    expect(runner('R100\ttest/windows-capture.test.ts\ttest/ordinary.test.ts')).toBe('ubuntu-24.04');
  });

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
