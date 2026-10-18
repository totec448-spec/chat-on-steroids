import { pathToFileURL } from 'node:url';

/**
 * Contributor PRs whose CI or checklist failed go back to draft (user, 2026-10-15), so no review
 * is spent on a red PR. The author fixes it and clicks "Ready for review"; the label then lets the
 * waiting-PR reminder treat the draft as waiting on its author.
 */
const API = 'https://api.github.com';
export const NOT_READY_SINCE = '2026-10-15T16:00:00Z';
export const NOT_READY_LABEL = 'not-ready';
const MAINTAINER = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * 'draft' a red ready PR (label, comment, convert), 'redraft' one that is labeled already (only
 * the conversion: CI and the checklist fail separately, and each must not comment again),
 * 'clear' the label off a green ready one, else nothing.
 */
export function notReadyDecision(pr, conclusion) {
  const labeled = (pr.labels ?? []).some(label => label.name === NOT_READY_LABEL);
  if (conclusion === 'success') return labeled && !pr.draft ? 'clear' : 'none';
  if (conclusion !== 'failure' || pr.draft || MAINTAINER.has(pr.author_association) || pr.user?.type === 'Bot') return 'none';
  if (Date.parse(pr.created_at) < Date.parse(NOT_READY_SINCE)) return 'none';
  return labeled ? 'redraft' : 'draft';
}

export const NOT_READY_COMMENT = `A check failed, so this PR is a draft again and not in the review queue yet. The failed check's log says what is missing (see CONTRIBUTING.md). Once everything is green, click **Ready for review** and it goes back into the queue.`;
/** When GitHub refuses the conversion, the comment must not claim one (live, #1548). */
// A maintainer job turns such a PR into a draft a few minutes later, so the text fits both states.
export const NOT_READY_COMMENT_UNDRAFTED = `A check failed, so this PR is not in the review queue yet and will be turned into a draft. The failed check's log says what is missing (see CONTRIBUTING.md). Once everything is green, click **Ready for review** and it goes back into the queue.`;

/**
 * Carries out one decision through \`request(path, init)\`. GraphQL reports a refused mutation with
 * HTTP 200 and an \`errors\` list, so the conversion counts only when GitHub returns the draft. A
 * label comes off only when each check's latest run has passed (success, neutral or skipped): CI
 * and the checklist finish separately, and one green run said nothing about the other (live
 * 2026-10-15).
 */
export async function applyNotReady(request, { repository, sha, pr, decision }, draftRequest = request) {
  const path = `/repos/${repository}/issues/${pr.number}`;
  if (decision === 'draft' || decision === 'redraft') {
    const reply = await draftRequest('/graphql', { method: 'POST', body: JSON.stringify({
      query: 'mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }',
      variables: { id: pr.node_id } }) });
    const drafted = reply?.data?.convertPullRequestToDraft?.pullRequest?.isDraft === true;
    const refused = `labeled (draft refused: ${(reply?.errors ?? []).map(error => error.message).join('; ') || 'no draft in the reply'})`;
    if (decision === 'redraft') return drafted ? 'draft' : refused;
    await request(`${path}/labels`, { method: 'POST', body: JSON.stringify({ labels: [NOT_READY_LABEL] }) });
    await request(`${path}/comments`, { method: 'POST', body: JSON.stringify({ body: drafted ? NOT_READY_COMMENT : NOT_READY_COMMENT_UNDRAFTED }) });
    return drafted ? 'draft' : refused;
  }
  if (decision === 'clear') {
    const runs = [];
    for (let page = 1; ; page++) {
      const pageRuns = (await request(`/repos/${repository}/commits/${sha}/check-runs?per_page=100&filter=all&page=${page}`))?.check_runs ?? [];
      runs.push(...pageRuns);
      if (pageRuns.length < 100) break;
    }
    // Each check's latest run per app (highest id) decides: a rerun that passed replaces its old failure,
    // while one still running or cancelled blocks the label until it passes. `filter=all` and every page list
    // all runs: the default keeps runs by completion time and can drop a newer one.
    const latest = runs.filter(run => !runs.some(other => other.name === run.name && other.app?.id === run.app?.id && other.id > run.id));
    const running = latest.filter(run => !run.conclusion).map(run => run.name);
    const failing = latest.filter(run => run.conclusion && !['success', 'neutral', 'skipped'].includes(run.conclusion)).map(run => run.name);
    const blocked = [failing.length && `${failing.join(', ')} still failing`, running.length && `${running.join(', ')} still running`].filter(Boolean);
    if (blocked.length) return `kept (${blocked.join('; ')})`;
    await request(`${path}/labels/${NOT_READY_LABEL}`, { method: 'DELETE' });
    return 'clear';
  }
  return decision;
}

async function github(path, token, init = {}) {
  const response = await fetch(`${API}${path}`, { ...init, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'chat-on-steroids-pr-not-ready', ...(init.headers ?? {}) } });
  if (!response.ok) throw new Error(`GitHub ${path} failed with HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  const sha = process.env.HEAD_SHA;
  const conclusion = process.env.RUN_CONCLUSION;
  if (!repository || !token || !sha || !conclusion) throw new Error('GITHUB_REPOSITORY, GH_TOKEN, HEAD_SHA and RUN_CONCLUSION are required');
  // A run from a fork lists no pull requests, so match the open PRs by their head commit.
  const prs = (await github(`/repos/${repository}/pulls?state=open&per_page=100`, token)).filter(pr => pr.head?.sha === sha);
  // The workflow token cannot convert a PR to a draft; an optional token with that right can.
  const draftToken = process.env.DRAFT_TOKEN || token;
  for (const pr of prs) {
    const outcome = await applyNotReady((path, init) => github(path, token, init), { repository, sha, pr, decision: notReadyDecision(pr, conclusion) },
      (path, init) => github(path, draftToken, init));
    console.log(outcome.startsWith('labeled') ? `::warning::#${pr.number}: ${outcome}` : `#${pr.number}: ${outcome}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
