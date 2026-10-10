import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
// @ts-expect-error The check is a plain Node script without type declarations.
import { appVersionField as field, CLOSE_COMMENT, hasVersionNumber as numbered, LABEL, versionDecision as decide } from '../scripts/issue-version.mjs';

type Issue = { body: string | null; state: 'open' | 'closed'; author_association: string; labels?: Array<string | { name: string }> };
const appVersionField = field as (body: string | null) => string | null;
const hasVersionNumber = numbered as (value: string) => boolean;
const versionDecision = decide as (issue: Issue) => 'close' | 'reopen' | 'none';

/** The shape GitHub writes for the bug form, as in real reports. */
const report = (version: string) =>
  `### App version\n\n${version}\n\n### Operating system and version\n\nWindows 11 24H2\n\n### Architecture\n\nx64`;
const issue = (version: string, extra: Partial<Issue> = {}): Issue =>
  ({ body: report(version), state: 'open', author_association: 'NONE', labels: [{ name: 'bug' }], ...extra });

it('reads the App version answer of the bug form', () => {
  expect(appVersionField(report('2.1.32'))).toBe('2.1.32');
  expect(appVersionField(report('_No response_'))).toBe('_No response_');
  expect(appVersionField('### App version\n\nlatest')).toBe('latest');
  expect(appVersionField('Free text without the form')).toBeNull();
});

it('accepts only a real version number', () => {
  for (const value of ['2.1.32', 'v2.1.31', '2.1.32 (extension 2.1.32)', 'Chat On Steroids 2.1.29']) expect(hasVersionNumber(value)).toBe(true);
  // Answers seen in real reports.
  for (const value of ['latest', 'lastest linux', 'last', '21.0', '2.01', '.9', '_No response_', '']) expect(hasVersionNumber(value)).toBe(false);
});

it('closes a report without a version number once', () => {
  expect(versionDecision(issue('latest'))).toBe('close');
  expect(versionDecision(issue('latest', { state: 'closed', labels: [LABEL] }))).toBe('none');
});

it('reopens the report when the reporter adds the number', () => {
  expect(versionDecision(issue('2.1.32', { state: 'closed', labels: [{ name: 'bug' }, { name: LABEL }] }))).toBe('reopen');
  // Closed for another reason: not this check's to reopen.
  expect(versionDecision(issue('2.1.32', { state: 'closed' }))).toBe('none');
  expect(versionDecision(issue('2.1.32'))).toBe('none');
});

it('leaves maintainers, other forms and reports a maintainer reopened alone', () => {
  expect(versionDecision(issue('latest', { author_association: 'OWNER' }))).toBe('none');
  expect(versionDecision(issue('main', { author_association: 'COLLABORATOR' }))).toBe('none');
  expect(versionDecision({ body: '### Problem or workflow\n\nIdea', state: 'open', author_association: 'NONE' })).toBe('none');
  expect(versionDecision(issue('latest', { labels: [LABEL] }))).toBe('none');
});

it('tells the reporter where the number is and that an edit reopens the issue', () => {
  expect(CLOSE_COMMENT).toContain('Settings → Activity');
  expect(CLOSE_COMMENT).toContain('reopens by itself');
  expect(readFileSync('.github/ISSUE_TEMPLATE/bug_report.yml', 'utf8')).toContain('"latest" is not accepted');
  const workflow = readFileSync('.github/workflows/issue-version.yml', 'utf8');
  expect(workflow).toContain('types: [opened, edited]');
  expect(workflow).toContain('node scripts/issue-version.mjs');
});
