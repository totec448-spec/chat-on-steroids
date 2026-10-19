import { pathToFileURL } from 'node:url';

const API = 'https://api.github.com';
/** The label this check puts on a report it closed; it is also how the check knows to reopen it. */
export const LABEL = 'needs-version';
/** Issues opened by the project's own people are never checked. */
const MAINTAINERS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** The bug form's "App version" answer, or null when the issue was not written with that form. */
export function appVersionField(body) {
  const match = /^###\s+App version\s*\r?\n([\s\S]*?)(?=^###\s|(?![\s\S]))/m.exec(String(body ?? ''));
  return match ? match[1].trim() : null;
}

/** "latest", "newest" or an empty answer say nothing about the build; only a real number does. */
export function hasVersionNumber(value) {
  return /\bv?\d+\.\d+\.\d+\b/.test(String(value ?? ''));
}

/**
 * What to do with an opened or edited issue: close a report without a version number once, and
 * reopen it when the reporter adds one. A report a maintainer reopened keeps the label and is
 * left alone, so the check never fights a person.
 */
export function versionDecision(issue) {
  const value = appVersionField(issue.body);
  if (value === null || MAINTAINERS.has(issue.author_association)) return 'none';
  const labeled = (issue.labels ?? []).some(label => (typeof label === 'string' ? label : label.name) === LABEL);
  if (hasVersionNumber(value)) return labeled && issue.state === 'closed' ? 'reopen' : 'none';
  return issue.state === 'open' && !labeled ? 'close' : 'none';
}

export const CLOSE_COMMENT = `Thanks for the report! The **App version** field needs the exact version number, for example \`2.1.32\`. "latest" or similar can't be used: it changes with every release, so we can't tell which build you ran, and many problems are already fixed in a newer one. We can only look into reports with a version number, so this issue is closed for now.

You'll find the number in the app under **Settings → Activity** ("Up to date! Chat On Steroids 2.1.32"), or in the browser extension's popup. Please **edit this issue** and put it in the App version field: the issue reopens by itself once it has a version number. If you're not on the newest release, please update first and check whether the problem is still there.`;

export const REOPEN_COMMENT = 'Thanks for adding the version number! The issue is open again.';

/**
 * Reports opened from here on (user, 2026-10-15) also need the diagnostics report and a check on
 * the latest release, so the first answer needs no follow-up questions. Older reports keep the
 * version-only rule above.
 */
export const INTAKE_SINCE = '2026-10-15T16:00:00Z';
/** The label on a new report this check closed; it is also how the check knows to reopen it. */
export const INTAKE_LABEL = 'incomplete-report';

/** A bug-form answer by its heading, or null when the issue has no such field. */
function formField(body, label) {
  const lines = String(body ?? '').split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === `### ${label}`);
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /^###\s/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

/** An attached text file, or the report pasted whole; a screenshot is not the report. */
export function hasDiagnostics(value) {
  const text = String(value ?? '');
  return /https:\/\/github\.com\/user-attachments\/files\/\d+\/[^\s)]+\.(?:txt|log|md)\b/i.test(text) ||
    text.includes('# Chat On Steroids diagnostics report');
}

const versionOf = value => /\bv?(\d+)\.(\d+)\.(\d+)\b/.exec(String(value ?? ''))?.slice(1).map(Number) ?? null;
function olderThan(value, latest) {
  const mine = versionOf(value), newest = versionOf(latest);
  if (!mine || !newest) return false;
  for (let index = 0; index < 3; index += 1) if (mine[index] !== newest[index]) return mine[index] < newest[index];
  return false;
}

/**
 * Like `versionDecision`, for every requirement at once. `latest` is the newest release's version
 * (null when unknown); `opened` is true for the event that created the issue. A newer release
 * coming out never closes an open report on a later edit, but a report this check holds closed
 * reopens only once it was retried on the newest one.
 */
export function intakeDecision(issue, { latest, opened }) {
  if (MAINTAINERS.has(issue.author_association)) return { decision: 'none', missing: [] };
  if (appVersionField(issue.body) === null) return freeFormDecision(issue, { latest, opened });
  const version = appVersionField(issue.body);
  if (!(Date.parse(issue.created_at) >= Date.parse(INTAKE_SINCE))) {
    const decision = versionDecision(issue);
    return { decision, missing: decision === 'close' ? ['version'] : [] };
  }
  const labeled = (issue.labels ?? []).some(label => (typeof label === 'string' ? label : label.name) === INTAKE_LABEL);
  const held = labeled && issue.state === 'closed';
  const missing = [];
  if (!hasVersionNumber(version)) missing.push('version');
  if (!hasDiagnostics(formField(issue.body, 'Diagnostics report'))) missing.push('diagnostics');
  const checked = /^\s*[-*]\s+\[[xX]\]\s+I reproduced this on the latest release/m.test(formField(issue.body, 'Latest release') ?? '');
  if (!checked || ((opened || held) && olderThan(version, latest))) missing.push('latest');
  if (missing.length) return { decision: issue.state === 'open' && !labeled ? 'close' : 'none', missing };
  return { decision: held ? 'reopen' : 'none', missing };
}

/**
 * A bug report written without the form (#1643): no bug-form field, not the feature form, and either the
 * bug label or a title that starts with "Bug". Its own headings ("### 1. What we saw") don't make it a
 * form. Ideas and questions written freely are left alone.
 */
export function freeFormBug(issue) {
  if (/^###\s+(?:Problem or workflow|Proposed change)\s*$/m.test(String(issue.body ?? ''))) return false;
  const labeled = (issue.labels ?? []).some(label => (typeof label === 'string' ? label : label.name) === 'bug');
  return labeled || /^\s*\[?bug\b/i.test(String(issue.title ?? ''));
}

/**
 * The app's version where the text names it ("CoS application: 2.1.40", "Chat On Steroids 2.1.40", "[Bug] 2.1.40:").
 * Never three parts of a longer number: "Edge 141.0.3537.71" holds no app version, not 0.3537.71.
 */
export function freeFormVersion(issue) {
  const text = `${issue.title ?? ''}\n${issue.body ?? ''}`;
  const named = /\b(?:chat on steroids|cos|app(?:lication)?|version)\b[^\n]{0,40}?(?<![.\d])\bv?(\d+\.\d+\.\d+)(?![.\d])/i.exec(text);
  const titled = /^\s*\[?bug\]?[:\s-]*v?(\d+\.\d+\.\d+)(?![.\d])/i.exec(String(issue.title ?? ''));
  return named?.[1] ?? titled?.[1] ?? null;
}

/**
 * The same three requirements, read from the whole text. Without the form there is no checkbox: a
 * report on the newest release says so by its version number, an older one still has to be retried.
 */
function freeFormDecision(issue, { latest, opened }) {
  if (!freeFormBug(issue) || !(Date.parse(issue.created_at) >= Date.parse(INTAKE_SINCE))) return { decision: 'none', missing: [] };
  const labeled = (issue.labels ?? []).some(label => (typeof label === 'string' ? label : label.name) === INTAKE_LABEL);
  const held = labeled && issue.state === 'closed';
  const version = freeFormVersion(issue);
  const missing = [];
  if (!version) missing.push('version');
  if (!hasDiagnostics(issue.body)) missing.push('diagnostics');
  const checked = /^\s*[-*]\s+\[[xX]\]\s+I reproduced this on the latest release/m.test(String(issue.body ?? ''));
  if (latest && !checked && (!version || ((opened || held) && olderThan(version, latest)))) missing.push('latest');
  if (missing.length) return { decision: issue.state === 'open' && !labeled ? 'close' : 'none', missing, freeForm: true };
  return { decision: held ? 'reopen' : 'none', missing, freeForm: true };
}

const MISSING_TEXT = {
  version: '**App version**: the exact number, for example `2.1.38`. It is in the app under **Settings → Activity**, or in the browser extension\'s popup.',
  diagnostics: '**Diagnostics report**: in the app, open **Activity** and click **Diagnostics report**, then drag the saved file into that field. Personal details are already replaced in it; please read it before you attach it. If the app does not open at all, attach its `app.log` instead.',
  latest: '**Latest release**: please update to the latest release (Settings → Activity), check that the problem is still there, then tick "I reproduced this on the latest release" and put the new version number in.'
};

/** A report written without the bug form has no fields to fill: the same parts go into its text. */
const FREE_FORM_TEXT = {
  version: '**App version**: the exact number, for example `2.1.38`. It is in the app under **Settings → Activity**, or in the browser extension\'s popup.',
  diagnostics: '**Diagnostics report**: in the app, open **Activity** and click **Diagnostics report**, then drag the saved file into the issue text. Personal details are already replaced in it; please read it before you attach it. If the app does not open at all, attach its `app.log` instead.',
  latest: '**Latest release**: please update to the latest release (Settings → Activity), check that the problem is still there, and put the new version number in.'
};

/** The comment on a closed new report: every missing part and where it comes from. */
export function missingComment(missing, { freeForm = false } = {}) {
  const texts = freeForm ? FREE_FORM_TEXT : MISSING_TEXT;
  return `Thanks for the report! So we can look into it without back-and-forth, a few things are needed first:

${missing.map(item => `- ${texts[item]}`).join('\n')}

This issue is closed until then. Please **edit this issue** and add them${freeForm ? ' to the issue text (the **Bug report** form has a field for each)' : ''}: it reopens by itself once everything is there.`;
}

export const INTAKE_REOPEN_COMMENT = 'Thanks, everything is there now! The issue is open again.';

async function github(path, token, init = {}) {
  const response = await fetch(`${API}${path}`, { ...init, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'chat-on-steroids-issue-version', ...(init.headers ?? {}) } });
  if (!response.ok) throw new Error(`GitHub ${path} failed with HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  const number = Number(process.env.ISSUE_NUMBER);
  if (!repository || !token || !Number.isInteger(number)) throw new Error('GITHUB_REPOSITORY, GH_TOKEN and ISSUE_NUMBER are required');
  // Re-read the issue: the event payload can be older than a quick follow-up edit.
  const path = `/repos/${repository}/issues/${number}`;
  const issue = await github(path, token);
  if (issue.pull_request) return;
  const latest = await github(`/repos/${repository}/releases/latest`, token).then(release => release?.tag_name ?? null, () => null);
  const { decision, missing, freeForm } = intakeDecision(issue, { latest, opened: process.env.ISSUE_ACTION === 'opened' });
  const fresh = Date.parse(issue.created_at) >= Date.parse(INTAKE_SINCE);
  const label = fresh ? INTAKE_LABEL : LABEL;
  const post = (body) => github(`${path}/comments`, token, { method: 'POST', body: JSON.stringify({ body }) });
  if (decision === 'close') {
    await post(fresh ? missingComment(missing, { freeForm }) : CLOSE_COMMENT);
    await github(`${path}/labels`, token, { method: 'POST', body: JSON.stringify({ labels: [label] }) });
    await github(path, token, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'not_planned' }) });
  } else if (decision === 'reopen') {
    await github(`${path}/labels/${label}`, token, { method: 'DELETE' });
    await github(path, token, { method: 'PATCH', body: JSON.stringify({ state: 'open' }) });
    await post(fresh ? INTAKE_REOPEN_COMMENT : REOPEN_COMMENT);
  }
  console.log(`#${number}: ${decision}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
