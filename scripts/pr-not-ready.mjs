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

/** 'draft' a red ready PR, 'clear' the label off a green ready one, else nothing. */
export function notReadyDecision(pr, conclusion) {
  const labeled = (pr.labels ?? []).some(label => label.name === NOT_READY_LABEL);
  if (conclusion === 'success') return labeled && !pr.draft ? 'clear' : 'none';
  if (conclusion !== 'failure' || pr.draft || MAINTAINER.has(pr.author_association) || pr.user?.type === 'Bot') return 'none';
  return Date.parse(pr.created_at) >= Date.parse(NOT_READY_SINCE) ? 'draft' : 'none';
}

export const NOT_READY_COMMENT = `A check failed, so this PR is a draft again and not in the review queue yet. The failed check's log says what is missing (see CONTRIBUTING.md). Once everything is green, click **Ready for review** and it goes back into the queue.`;

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
  for (const pr of prs) {
    const decision = notReadyDecision(pr, conclusion);
    const path = `/repos/${repository}/issues/${pr.number}`;
    if (decision === 'draft') {
      await github('/graphql', token, { method: 'POST', body: JSON.stringify({
        query: 'mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }',
        variables: { id: pr.node_id } }) });
      await github(`${path}/labels`, token, { method: 'POST', body: JSON.stringify({ labels: [NOT_READY_LABEL] }) });
      await github(`${path}/comments`, token, { method: 'POST', body: JSON.stringify({ body: NOT_READY_COMMENT }) });
    } else if (decision === 'clear') {
      await github(`${path}/labels/${NOT_READY_LABEL}`, token, { method: 'DELETE' });
    }
    console.log(`#${pr.number}: ${decision}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
