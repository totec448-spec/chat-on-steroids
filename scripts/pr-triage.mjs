import { pathToFileURL } from 'node:url';

const API = 'https://api.github.com';
/** Area labels from changed paths. Only added, never removed, so a maintainer's choice stays. */
export const AREAS = [
  ['area: app', path => path.startsWith('src/main/')],
  ['area: interface', path => path.startsWith('src/renderer/') || path.startsWith('src/preload/')],
  ['area: extension', path => path.startsWith('extension/')],
  ['area: translations', path => path.startsWith('src/renderer/locales/') || path.startsWith('extension/_locales/')],
  ['area: ci', path => path.startsWith('.github/') || path.startsWith('scripts/')],
  ['documentation', path => path.startsWith('docs/') || (!path.includes('/') && path.endsWith('.md'))]
];
export const SIZE_LIMIT = 1000;
export const SIZE_MARK = '<!-- size-note -->';
export const WELCOME_MARK = '<!-- welcome -->';
const FIRST_TIMER = new Set(['FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER']);

/** The area labels a PR's files call for. */
export function areasFor(files) {
  return AREAS.filter(([, matches]) => files.some(file => matches(file.filename))).map(([label]) => label);
}

/** Changed lines that make a review harder: tests, translations, docs and the lockfile grow with a change without that. */
export function reviewLines(files) {
  return files.filter(file => !/^(test\/|docs\/|src\/renderer\/locales\/|extension\/_locales\/|package-lock\.json$)|\.md$/.test(file.filename))
    .reduce((sum, file) => sum + file.additions + file.deletions, 0);
}

export const sizeNote = lines => `${SIZE_MARK}
Thanks for the PR! It changes about ${lines} lines outside tests, translations and docs. Large PRs take much longer to review, so if this covers more than one topic, splitting it up usually gets it merged faster. If it is one topic that simply needs the space, ignore this note.`;

export const WELCOME = `${WELCOME_MARK}
Thanks for your first pull request, and welcome! 👋 The short version of [CONTRIBUTING.md](https://github.com/totec448-spec/chat-on-steroids/blob/main/CONTRIBUTING.md):
1. Link the issue it solves (\`Fixes #123\`), and keep one topic per PR.
2. Add a test that fails without your change; the "Fail-first test" check confirms it.
3. For interface changes, add before and after screenshots.
4. Keep "Allow edits by maintainers" on, so we can help with small fixes.
5. The "PR checklist" check tells you exactly what is missing, so no need to guess.

We review once the checks are green. Questions are welcome right here.`;

/** What one PR still needs: missing labels and, at most once each, the size note and the welcome. */
export function triage({ pr, files, comments }) {
  const has = new Set(pr.labels.map(label => label.name));
  const said = mark => comments.some(comment => comment.body?.includes(mark));
  const lines = reviewLines(files);
  return {
    labels: areasFor(files).filter(label => !has.has(label)),
    comments: [
      // The first-interaction action welcomed without the mark; its first sentence counts too.
      ...(FIRST_TIMER.has(pr.author_association) && !said(WELCOME_MARK) && !said('Thanks for your first pull request') ? [WELCOME] : []),
      ...(lines > SIZE_LIMIT && !said(SIZE_MARK) ? [sizeNote(lines)] : [])
    ]
  };
}

async function github(path, token, init = {}) {
  const response = await fetch(`${API}${path}`, { ...init, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'chat-on-steroids-pr-triage', ...(init.headers ?? {}) } });
  if (!response.ok) throw new Error(`GitHub ${path} failed with HTTP ${response.status}`);
  return response.json();
}

async function all(path, token) {
  const rows = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await github(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, token);
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  return rows;
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repository || !token) throw new Error('GITHUB_REPOSITORY and GH_TOKEN are required');
  for (const pr of await all(`/repos/${repository}/pulls?state=open`, token)) {
    if (pr.user.type === 'Bot') continue;
    const [files, comments] = await Promise.all([
      all(`/repos/${repository}/pulls/${pr.number}/files`, token),
      all(`/repos/${repository}/issues/${pr.number}/comments`, token)
    ]);
    const todo = triage({ pr, files, comments });
    if (todo.labels.length) await github(`/repos/${repository}/issues/${pr.number}/labels`, token, { method: 'POST', body: JSON.stringify({ labels: todo.labels }) });
    for (const body of todo.comments) await github(`/repos/${repository}/issues/${pr.number}/comments`, token, { method: 'POST', body: JSON.stringify({ body }) });
    if (todo.labels.length || todo.comments.length) console.log(`#${pr.number}: +${todo.labels.join(', ') || 'no labels'}, ${todo.comments.length} note(s)`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
