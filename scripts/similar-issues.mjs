import { pathToFileURL } from 'node:url';

const API = 'https://api.github.com';
const STOP = new Set(['the', 'and', 'for', 'with', 'not', 'when', 'after', 'from', 'that', 'this', 'into', 'does', 'can', 'cannot',
  'app', 'chat', 'chats', 'cos', 'chatgpt', 'issue', 'bug', 'error', 'problem', 'still', 'again', 'der', 'die', 'das', 'und', 'nicht']);
/** Only a close match is worth a comment; a weak one would be noise on every new issue. */
export const MIN_SIMILARITY = 0.5;

/** The distinctive words of a title: lowercase, without version numbers, short words or filler. */
export function titleWords(title) {
  return new Set(String(title).toLowerCase().replace(/\[[^\]]*\]/g, ' ').replace(/\bv?\d+(\.\d+)+\b/g, ' ')
    .split(/[^a-z0-9äöüß&+#-]+/).map(word => word.replace(/^[-#]+|[-#]+$/g, '')).filter(word => word.length >= 3 && !STOP.has(word)));
}

/**
 * Shared words over all words (Jaccard): 1 for the same title, 0 for nothing in common. One shared
 * word is never enough: vague titles like "... is not working" would all match each other.
 */
export function similarity(a, b) {
  const x = titleWords(a), y = titleWords(b);
  let shared = 0;
  for (const word of x) if (y.has(word)) shared++;
  return shared < 2 ? 0 : shared / (x.size + y.size - shared);
}

/** At most three existing issues that look like the same report, closest first. */
export function similarIssues(issue, candidates) {
  return candidates
    .filter(candidate => candidate.number !== issue.number && !candidate.pull_request)
    .map(candidate => ({ candidate, score: similarity(issue.title, candidate.title) }))
    .filter(({ score }) => score >= MIN_SIMILARITY)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ candidate }) => candidate);
}

export function commentFor(matches) {
  const list = matches.map(match => `- #${match.number} ${match.title}${match.state === 'closed' ? ' (closed)' : ''}`).join('\n');
  return `These existing issues look similar:\n\n${list}\n\nIf one of them is the same problem, a comment or 👍 there helps us more than a second issue. If yours is different, just ignore this note. Thanks for reporting!`;
}

async function github(path, token, init = {}) {
  const response = await fetch(`${API}${path}`, { ...init, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'chat-on-steroids-similar-issues', ...(init.headers ?? {}) } });
  if (!response.ok) throw new Error(`GitHub ${path} failed with HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  const number = Number(process.env.ISSUE_NUMBER);
  if (!repository || !token || !Number.isInteger(number)) throw new Error('GITHUB_REPOSITORY, GH_TOKEN and ISSUE_NUMBER are required');
  const issue = await github(`/repos/${repository}/issues/${number}`, token);
  const words = [...titleWords(issue.title)].slice(0, 6);
  if (words.length < 2) return;
  const query = encodeURIComponent(`repo:${repository} is:issue ${words.join(' OR ')}`);
  const result = await github(`/search/issues?q=${query}&per_page=50`, token);
  const matches = similarIssues(issue, result.items);
  if (!matches.length) return;
  await github(`/repos/${repository}/issues/${number}/comments`, token, { method: 'POST', body: JSON.stringify({ body: commentFor(matches) }) });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
