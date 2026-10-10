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
  const decision = versionDecision(issue);
  const post = (body) => github(`${path}/comments`, token, { method: 'POST', body: JSON.stringify({ body }) });
  if (decision === 'close') {
    await post(CLOSE_COMMENT);
    await github(`${path}/labels`, token, { method: 'POST', body: JSON.stringify({ labels: [LABEL] }) });
    await github(path, token, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'not_planned' }) });
  } else if (decision === 'reopen') {
    await github(`${path}/labels/${LABEL}`, token, { method: 'DELETE' });
    await github(path, token, { method: 'PATCH', body: JSON.stringify({ state: 'open' }) });
    await post(REOPEN_COMMENT);
  }
  console.log(`#${number}: ${decision}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
