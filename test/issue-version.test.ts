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

// 2026-10-15, user: reports opened from now on need the diagnostics report and a check on the
// latest release, so a first answer needs no follow-up questions. Older reports keep the old rule.
// @ts-expect-error The check is a plain Node script without type declarations.
import { INTAKE_LABEL, INTAKE_SINCE, intakeDecision as intake, missingComment as missingText } from '../scripts/issue-version.mjs';

type Intake = Issue & { created_at: string };
const intakeDecision = intake as (issue: Intake, context: { latest: string | null; opened: boolean }) => { decision: 'close' | 'reopen' | 'none'; missing: string[] };
const missingComment = missingText as (missing: string[]) => string;
const attached = '[chat-on-steroids-diagnostics-2026-10-15.txt](https://github.com/user-attachments/files/23456789/chat-on-steroids-diagnostics-2026-10-15.txt)';
const fullReport = ({ version = '2.1.38', diagnostics = attached, latest = '- [X] I reproduced this on the latest release' } = {}) =>
  `### App version\n\n${version}\n\n### Operating system and version\n\nWindows 11 24H2\n\n### Latest release\n\n${latest}\n\n` +
  `### What happened\n\nIt broke.\n\n### Diagnostics report\n\n${diagnostics}\n\n### Anything else\n\n_No response_`;
const fresh = (body: string, extra: Partial<Intake> = {}): Intake =>
  ({ body, state: 'open', author_association: 'NONE', labels: [{ name: 'bug' }], created_at: '2026-10-16T09:00:00Z', ...extra });
const opened = { latest: '2.1.38', opened: true };

it('accepts a new report with the version, the attached diagnostics file and the latest-release check', () => {
  expect(Date.parse(INTAKE_SINCE)).toBeLessThan(Date.parse('2026-10-16T09:00:00Z'));
  expect(intakeDecision(fresh(fullReport()), opened)).toEqual({ decision: 'none', missing: [] });
  // Pasted instead of attached still carries the whole report.
  const pasted = '```\n# Chat On Steroids diagnostics report\n\nCreated 2026-10-15T10:00:00.000Z.\n```';
  expect(intakeDecision(fresh(fullReport({ diagnostics: pasted })), opened).missing).toEqual([]);
});

it('closes a new report that lacks the diagnostics file, the check or a current version, and names each', () => {
  expect(intakeDecision(fresh(fullReport({ diagnostics: '_No response_' })), opened)).toEqual({ decision: 'close', missing: ['diagnostics'] });
  // A screenshot is not the report.
  expect(intakeDecision(fresh(fullReport({ diagnostics: '![shot](https://github.com/user-attachments/assets/8f596a5e-deb4-47aa-90a4-a52b0419d347)' })), opened).missing).toEqual(['diagnostics']);
  expect(intakeDecision(fresh(fullReport({ latest: '- [ ] I reproduced this on the latest release' })), opened).missing).toEqual(['latest']);
  expect(intakeDecision(fresh(fullReport({ version: '2.1.32' })), opened).missing).toEqual(['latest']);
  expect(intakeDecision(fresh(fullReport({ version: 'latest', diagnostics: '' })), opened).missing).toEqual(['version', 'diagnostics']);
});

it('does not close an open report on a later edit only because a newer release came out', () => {
  expect(intakeDecision(fresh(fullReport()), { latest: '2.1.39', opened: false }).decision).toBe('none');
  // Still checked while the bot holds it closed: the reporter has to retry on the newest one.
  const held = fresh(fullReport(), { state: 'closed', labels: [{ name: INTAKE_LABEL }] });
  expect(intakeDecision(held, { latest: '2.1.39', opened: false })).toEqual({ decision: 'none', missing: ['latest'] });
});

it('reopens a held report once everything is there, and never fights a maintainer', () => {
  const held = fresh(fullReport(), { state: 'closed', labels: [{ name: 'bug' }, { name: INTAKE_LABEL }] });
  expect(intakeDecision(held, { latest: '2.1.38', opened: false }).decision).toBe('reopen');
  expect(intakeDecision(fresh(fullReport({ diagnostics: '' }), { labels: [{ name: INTAKE_LABEL }] }), opened).decision).toBe('none');
  expect(intakeDecision(fresh(fullReport({ diagnostics: '' }), { author_association: 'OWNER' }), opened).decision).toBe('none');
  // Without a known latest release only the release check is skipped.
  expect(intakeDecision(fresh(fullReport({ version: '2.1.30' })), { latest: null, opened: true }).missing).toEqual([]);
});

it('keeps the old version-only rule for reports opened before the change', () => {
  const old = fresh(fullReport({ version: 'latest', diagnostics: '' }), { created_at: '2026-10-14T09:00:00Z' });
  expect(intakeDecision(old, opened)).toEqual({ decision: 'close', missing: ['version'] });
  expect(intakeDecision(fresh(fullReport({ diagnostics: '' }), { created_at: '2026-10-14T09:00:00Z' }), opened).decision).toBe('none');
  expect(intakeDecision({ ...fresh('### Problem or workflow\n\nIdea'), created_at: '2026-10-16T09:00:00Z' }, opened).decision).toBe('none');
});

it('tells the reporter exactly where each missing part comes from', () => {
  const text = missingComment(['version', 'diagnostics', 'latest']);
  expect(text).toContain('Settings → Activity');
  expect(text).toContain('Diagnostics report');
  expect(text).toContain('latest release');
  expect(text).toContain('reopens by itself');
  const form = readFileSync('.github/ISSUE_TEMPLATE/bug_report.yml', 'utf8');
  expect(form).toMatch(/id: diagnostics[\s\S]*?required: true/);
  expect(form).toMatch(/id: latest[\s\S]*?I reproduced this on the latest release[\s\S]*?required: true/);
});

// #1643 (2026-10-18): a careful bug report written without the bug form (no "### App version" field)
// got no notice at all, because the check returned "none" for anything without the form's fields.
// A report without any form heading is read from its text instead, when it says it is a bug.
const freeForm = (extra = '') => '## Summary\n\nAutomatic compaction waited 47 minutes.\n\n## Environment\n\n' +
  '- CoS application: **2.1.40** (installed executable reports `2.1.40.0`).\n- Browser: Chrome 155.0.8059.85.\n' +
  '\n### 1. `resumed` did not establish that a summary request had been sent\n\nObservations.\n' + extra;
const freeIssue = (body: string, extra: Partial<Intake> & { title?: string } = {}): Intake & { title: string } =>
  ({ ...fresh(body, { labels: [] }), title: '[Bug] 2.1.40: automatic compaction waited ~47 minutes', ...extra });
const current = { latest: 'v2.1.40', opened: true };

it('reads a bug report written without the form from its text, and asks for what is missing', () => {
  expect(intakeDecision(freeIssue(freeForm()), current)).toEqual({ decision: 'close', missing: ['diagnostics'], freeForm: true });
  expect(intakeDecision(freeIssue(freeForm(`\n${attached}\n`)), current).missing).toEqual([]);
  // Chrome's four-part number is not the app's version; an older app version needs the latest release.
  expect(intakeDecision(freeIssue(freeForm(attached).replace(/2\.1\.40/g, '2.1.38')), current).missing).toEqual(['latest']);
  expect(intakeDecision(freeIssue('## Summary\n\nIt broke on Chrome 155.0.8059.85.', { title: '[Bug] it broke' }), current).missing)
    .toEqual(['version', 'diagnostics', 'latest']);
  // The bug label says it too; an idea or a question without either is left alone.
  expect(intakeDecision(freeIssue(freeForm(), { title: 'Compaction waits long', labels: [{ name: 'bug' }] }), current).decision).toBe('close');
  expect(intakeDecision(freeIssue(freeForm(), { title: 'Consider adding CodeRabbit' }), current).decision).toBe('none');
  expect(intakeDecision(freeIssue(freeForm(), { author_association: 'OWNER' }), current).decision).toBe('none');
});

it('does not read the end of a browser version as the app version', () => {
  // "Browser version: Edge 141.0.3537.71" was read as app version 0.3537.71, an old release.
  const body = `## Environment\n\n- Browser version: Edge 141.0.3537.71\n\n${attached}\n`;
  expect(intakeDecision(freeIssue(body), current).missing).toEqual([]);
  expect(intakeDecision(freeIssue(body, { title: '[Bug] it broke' }), current).missing).toEqual(['version', 'latest']);
});

it('does not close an open free-form report on a later edit only because a newer release came out', () => {
  expect(intakeDecision(freeIssue(freeForm(attached)), { latest: 'v2.1.41', opened: false }).decision).toBe('none');
});

it('reopens a free-form report held for its diagnostics once they are in the text', () => {
  const held = freeIssue(freeForm(attached), { state: 'closed', labels: [{ name: INTAKE_LABEL }] });
  expect(intakeDecision(held, { latest: 'v2.1.40', opened: false }).decision).toBe('reopen');
});

it('tells a free-form reporter to add the missing parts to the text', () => {
  const text = (missingText as (missing: string[], options?: { freeForm?: boolean }) => string)(['diagnostics'], { freeForm: true });
  expect(text).toContain('Diagnostics report');
  expect(text).toMatch(/to the issue text/);
  expect(text).not.toMatch(/into that field|tick/);
});
