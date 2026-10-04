import { pathToFileURL } from 'node:url';

const API = 'https://api.github.com';
const DAY = 86_400_000;
export const REMIND_AFTER_DAYS = 3;
export const CLOSE_AFTER_REMINDER_DAYS = 3;
export const MARK = '<!-- waiting-on-author -->';
const MAINTAINER = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * What to do with one open PR from an outside contributor: nothing, one reminder, or close.
 *
 * It waits on its author when a maintainer's review or comment, or a failed check, is newer than the
 * author's last push or comment. Only quiet time counts: any word or push from the author resets it.
 * `events` are { at, by: 'author' | 'maintainer' | 'checks' | 'reminder' }.
 */
export function decide(events, now) {
  const last = kind => Math.max(0, ...events.filter(event => event.by === kind).map(event => Date.parse(event.at)));
  const author = last('author');
  const ask = Math.max(last('maintainer'), last('checks'));
  if (ask <= author) return null;
  const reminder = last('reminder');
  if (reminder > ask) return now - reminder >= CLOSE_AFTER_REMINDER_DAYS * DAY ? 'close' : null;
  return now - ask >= REMIND_AFTER_DAYS * DAY ? 'remind' : null;
}

export const REMINDER = `${MARK}
Friendly nudge: this PR has been waiting for an answer or a fix for ${REMIND_AFTER_DAYS} days. Anything from you (a push, a reply, or "I need more time") keeps it open. Without that it will be closed in ${CLOSE_AFTER_REMINDER_DAYS} days. It can be reopened any time, nothing is lost.`;
export const CLOSING = 'Closing this for now since it has been quiet for a while. Thanks for the work! Reopen it whenever you pick it up again, or push to the branch and ask us to reopen.';

async function github(path, token, init = {}) {
  const response = await fetch(`${API}${path}`, { ...init, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'chat-on-steroids-waiting-prs', ...(init.headers ?? {}) } });
  if (!response.ok) throw new Error(`GitHub ${path} failed with HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function eventsFor(repository, pr, token) {
  const [commits, comments, reviews, checks] = await Promise.all([
    github(`/repos/${repository}/pulls/${pr.number}/commits?per_page=100`, token),
    github(`/repos/${repository}/issues/${pr.number}/comments?per_page=100`, token),
    github(`/repos/${repository}/pulls/${pr.number}/reviews?per_page=100`, token),
    github(`/repos/${repository}/commits/${pr.head.sha}/check-runs?per_page=100`, token)
  ]);
  const events = [{ at: pr.created_at, by: 'author' }];
  for (const commit of commits) events.push({ at: commit.commit.committer.date, by: 'author' });
  for (const comment of comments) {
    if (comment.body?.includes(MARK)) events.push({ at: comment.created_at, by: 'reminder' });
    else if (comment.user.login === pr.user.login) events.push({ at: comment.created_at, by: 'author' });
    else if (MAINTAINER.has(comment.author_association)) events.push({ at: comment.created_at, by: 'maintainer' });
  }
  for (const review of reviews) {
    if (review.user.login === pr.user.login) events.push({ at: review.submitted_at, by: 'author' });
    else if (MAINTAINER.has(review.author_association) && review.state !== 'APPROVED') events.push({ at: review.submitted_at, by: 'maintainer' });
  }
  for (const run of checks.check_runs) if (run.conclusion === 'failure' && run.completed_at) events.push({ at: run.completed_at, by: 'checks' });
  return events;
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repository || !token) throw new Error('GITHUB_REPOSITORY and GH_TOKEN are required');
  const prs = await github(`/repos/${repository}/pulls?state=open&per_page=100`, token);
  for (const pr of prs) {
    if (pr.draft || MAINTAINER.has(pr.author_association) || pr.user.type === 'Bot') continue;
    const action = decide(await eventsFor(repository, pr, token), Date.now());
    if (!action) continue;
    const body = action === 'remind' ? REMINDER : CLOSING;
    await github(`/repos/${repository}/issues/${pr.number}/comments`, token, { method: 'POST', body: JSON.stringify({ body }) });
    if (action === 'close') await github(`/repos/${repository}/pulls/${pr.number}`, token, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
    console.log(`#${pr.number}: ${action}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
