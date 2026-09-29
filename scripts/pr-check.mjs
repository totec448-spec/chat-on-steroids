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
 * @param {{ body: string, files: Array<{ path: string, changes: number }> }} pr
 * @returns {string[]} what is missing, in words a contributor can act on; empty when it passes
 */
export function checkPullRequest({ body, files }) {
  const problems = [];
  const text = String(body || '');
  if (!/(^|[\s(])#\d+\b/.test(text.replace(/<!--[\s\S]*?-->/g, ''))) {
    problems.push('Link the issue this answers ("Fixes #123" or "Refs #123"). Open one first if none exists.');
  }
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
    if (tests.length && !/fail/i.test(testSection)) {
      problems.push('Under "## Test", name the test and confirm it fails without your change.');
    }
  }

  if (files.some((file) => UI.test(file.path)) && !/!\[[^\]]*\]\(|<img\s/i.test(section(text, 'screenshots'))) {
    problems.push('This changes the interface: add before and after screenshots under "## Screenshots".');
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
  const problems = checkPullRequest({ body: pr.body ?? '', files: changedFiles(`origin/${pr.base.ref}`) });
  if (!problems.length) { console.log('Pull request checklist passed.'); process.exit(0); }
  console.log('This pull request is not ready for review yet. See CONTRIBUTING.md.\n');
  for (const problem of problems) {
    console.log(`- ${problem}`);
    console.log(`::error::${problem}`);
  }
  process.exit(1);
}
