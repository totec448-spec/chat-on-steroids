#!/usr/bin/env node
/**
 * The pull request checklist, enforced before anyone reviews. CONTRIBUTING.md explains each rule;
 * this only decides whether a PR description and its files meet them, so a PR that does not is
 * sent back by CI instead of by a person.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Changed lines outside tests and locale catalogs above this need a stated reason or a split. */
export const MAX_CHANGED_LINES = 600;

const CODE = /^(src|extension|scripts|native|build)\//;
const TESTS = /^(test\/|scripts\/verify-[^/]+\.cjs$|scripts\/fixtures\/)/;
const CATALOG = /(^|\/)(locales\/[^/]+\.json|_locales\/[^/]+\/messages\.json)$/;
const UI = /^(src\/renderer\/(?!locales\/)|extension\/(popup|options|sidepanel)[^/]*\.(html|css|js)$|extension\/content\.css$)/;
const STRAY = /(^|\/)(\.DS_Store|Thumbs\.db|npm-debug\.log[^/]*|[^/]+\.log|[^/]+\.orig|[^/]+\.rej)$|^docs\/(worklog|notes|scratch)[^/]*$/i;

/** Files that define contracts between processes, the extension and stored data; AGENTS.md maps them. */
const CONTRACT = /^(src\/preload\/index\.ts|src\/main\/(ipc|plugins-ipc)\.ts|src\/shared\/[^/]+\.ts)$/;
/** The template's headings and the names contributors already use for the same thing. */
const HEADINGS = {
  why: ['why', 'problem', 'root cause', 'cause', 'summary', 'motivation'],
  what: ['what changed', 'what changes', 'what', 'change', 'changes', 'fix'],
  test: ['test', 'tests', 'testing', 'validation', 'verification'],
  screenshots: ['screenshots', 'screenshot', 'before and after', 'ui']
};

/** Text of the first `##` section with one of these headings, without HTML comments; empty when missing. */
function section(body, key) {
  const names = HEADINGS[key];
  const lines = body.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const heading = /^##\s+(.+?)\s*#*\s*$/.exec(line.trim());
    return !!heading && names.includes(heading[1].toLowerCase().replace(/[:.]$/, ''));
  });
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

/**
 * @param {{ body: string, files: Array<{ path: string, changes: number }>, draft?: boolean,
 *   fromFork?: boolean, maintainerCanModify?: boolean }} pr
 * @returns {string[]} what is missing, in words a contributor can act on; empty when it passes
 */
export function checkPullRequest({ body, files, draft = false, fromFork = false, maintainerCanModify = true }) {
  const problems = [];
  const text = String(body || '');
  // No issue is required: the description carries the why and the what, and discussion happens
  // on the PR itself. A PR that closes an issue says "Fixes #123" so it closes on merge.
  if (section(text, 'why').length < 20) problems.push('Fill in "## Why": the root cause or the user problem, in a few sentences.');
  if (section(text, 'what').length < 20) problems.push('Fill in "## What changed": the behavior change, not a file list.');

  const stray = files.filter((file) => STRAY.test(file.path)).map((file) => file.path);
  if (stray.length) problems.push(`Remove files that do not belong in the repository: ${stray.join(', ')}.`);

  const code = files.filter((file) => CODE.test(file.path) && !TESTS.test(file.path) && !CATALOG.test(file.path));
  const tests = files.filter((file) => TESTS.test(file.path));
  const testSection = section(text, 'test');
  if (code.length) {
    const optedOut = /^no test:\s*\S.{10,}/im.test(testSection);
    if (!tests.length && !optedOut) {
      problems.push('Add or update a test for the behavior change, or write "No test: <reason>" under "## Test".');
    }
    // Whether the new test fails without the change is proved by the "Fail-first test" job, which
    // runs it against main's code. Requiring the word here as well only failed PRs on wording.
  }

  if (files.some((file) => UI.test(file.path)) && !/!\[[^\]]*\]\(|<img\s/i.test(section(text, 'screenshots')) &&
      !/^(?:[-*]\s+(?:\[[ xX]\]\s+)?)?no visual changes?:\s*\S.{10,}/im.test(text)) {
    problems.push('This changes the interface: add before and after screenshots under "## Screenshots", or write "No visual change: <reason>" when nothing on screen changes.');
  }

  if (files.some((file) => CONTRACT.test(file.path)) && !files.some((file) => file.path === 'AGENTS.md') &&
      !/^(?:[-*]\s+(?:\[[ xX]\]\s+)?)?no contract changes?:\s*\S.{10,}/im.test(text)) {
    problems.push('This changes a shared contract (preload, IPC or src/shared): update AGENTS.md in the same PR, or write "No contract change: <reason>".');
  }
  if (fromFork && !maintainerCanModify) {
    problems.push('Turn on "Allow edits by maintainers" so small fixes can be finished on this PR.');
  }
  if (/\bdepends on\s+#\d+/i.test(text) && !draft) {
    problems.push('This PR depends on another one: keep it a draft until that PR is merged, then rebase on main.');
  }
  const changed = code.reduce((sum, file) => sum + file.changes, 0);
  if (changed > MAX_CHANGED_LINES && !/^large change:\s*\S.{10,}/im.test(text)) {
    problems.push(`${changed} changed lines outside tests and translations (limit ${MAX_CHANGED_LINES}). Split it into smaller PRs, or add a line "Large change: <reason>".`);
  }
  return problems;
}

function changedFiles(base) {
  const raw = execFileSync('git', ['diff', '--numstat', `${base}...HEAD`], { encoding: 'utf8' });
  return raw.split('\n').filter(Boolean).map((line) => {
    const [added, removed, ...rest] = line.split('\t');
    const changes = added === '-' ? 0 : Number(added) + Number(removed);
    return { path: rest.join('\t'), changes };
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8'));
  const pr = event.pull_request;
  if (!pr) { console.log('Not a pull request; nothing to check.'); process.exit(0); }
  const problems = checkPullRequest({
    body: pr.body ?? '', files: changedFiles(`origin/${pr.base.ref}`), draft: pr.draft === true,
    fromFork: pr.head?.repo?.full_name !== pr.base?.repo?.full_name, maintainerCanModify: pr.maintainer_can_modify !== false
  });
  if (!problems.length) { console.log('Pull request checklist passed.'); process.exit(0); }
  console.log('This pull request is not ready for review yet. See CONTRIBUTING.md.\n');
  for (const problem of problems) {
    console.log(`- ${problem}`);
    console.log(`::error::${problem}`);
  }
  process.exit(1);
}
