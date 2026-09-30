import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
// @ts-expect-error The reporter is a plain Node module without type declarations.
import Reporter from '../scripts/flaky-reporter.mjs';

type Case = { fullName: string; module: { moduleId: string }; diagnostic: () => { flaky: boolean; retryCount: number } };
const FlakyReporter = Reporter as new (options: { output: (line: string) => void; summary: string | undefined }) =>
  { onTestCaseResult(testCase: Case): void; onTestRunEnd(): void };

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });
const testCase = (name: string, flaky: boolean) => ({
  fullName: name,
  module: { moduleId: path.join(process.cwd(), 'test', 'bridge.test.ts') },
  diagnostic: () => ({ flaky, retryCount: flaky ? 1 : 0 })
});

it('turns every test that passed only on its retry into a warning and a summary line', () => {
  dir = mkdtempSync(path.join(tmpdir(), 'flaky-'));
  const summary = path.join(dir, 'summary.md');
  const lines: string[] = [];
  const reporter = new FlakyReporter({ output: line => lines.push(line), summary });
  reporter.onTestCaseResult(testCase('unattributed activity recovery > refuses a handed action', true));
  reporter.onTestCaseResult(testCase('pairs the extension', false));
  reporter.onTestRunEnd();
  expect(lines).toEqual(['::warning title=Flaky test::test/bridge.test.ts > unattributed activity recovery > refuses a handed action failed once and passed on retry']);
  expect(readFileSync(summary, 'utf8')).toContain('- test/bridge.test.ts > unattributed activity recovery > refuses a handed action');
});

it('stays silent when nothing needed a retry', () => {
  const lines: string[] = [];
  const reporter = new FlakyReporter({ output: line => lines.push(line), summary: undefined });
  reporter.onTestCaseResult(testCase('pairs the extension', false));
  reporter.onTestRunEnd();
  expect(lines).toEqual([]);
});
