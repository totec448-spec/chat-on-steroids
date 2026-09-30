import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const API = 'https://api.github.com';

/**
 * The user-facing line a PR offers for the release notes: its optional "Release note:" line, else
 * its title. "Release note: none" (or "-") leaves the PR out, for work users never notice.
 */
export function releaseNoteFor(pr) {
  const line = /^\s*release note:\s*(.+?)\s*$/im.exec(pr.body ?? '')?.[1];
  if (line && /^(none|n\/a|-)\.?$/i.test(line)) return null;
  return line || pr.title;
}

/** A draft to edit, never the finished notes: one line per merged PR, oldest first, with its author. */
export function draftReleaseNotes({ since, prs }) {
  const lines = prs
    .filter(pr => !/\[bot\]$/.test(pr.user?.login ?? ''))
    .sort((a, b) => Date.parse(a.closed_at) - Date.parse(b.closed_at))
    .map(pr => ({ pr, note: releaseNoteFor(pr) }))
    .filter(({ note }) => note)
    .map(({ pr, note }) => `- ${note} (#${pr.number}, @${pr.user.login})`);
  return [
    `## Draft: changes since ${since}`,
    '',
    'Sort these into New / Improved / Fixed and rewrite them for users before tagging (see docs/release-notes).',
    '',
    ...(lines.length ? lines : ['- No merged pull requests yet.']),
    ''
  ].join('\n');
}

async function github(path, token) {
  const response = await fetch(`${API}${path}`, { headers: {
    Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'chat-on-steroids-release-notes' } });
  if (!response.ok) throw new Error(`GitHub ${path} failed with HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repository || !token) throw new Error('GITHUB_REPOSITORY and GH_TOKEN are required');
  const latest = await github(`/repos/${repository}/releases/latest`, token);
  const prs = [];
  for (let page = 1; page <= 10; page++) {
    const query = encodeURIComponent(`repo:${repository} is:pr is:merged base:main merged:>${latest.published_at}`);
    const result = await github(`/search/issues?q=${query}&per_page=100&page=${page}`, token);
    prs.push(...result.items.map(item => ({ ...item, closed_at: item.closed_at })));
    if (result.items.length < 100) break;
  }
  const draft = draftReleaseNotes({ since: latest.tag_name, prs });
  const out = process.argv[2];
  if (out) writeFileSync(out, draft); else console.log(draft);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
