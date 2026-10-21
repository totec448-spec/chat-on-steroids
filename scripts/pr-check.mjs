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

/** Files whose change alters what the app or the extension does for a person. */
const BEHAVIOR = /^(src|extension|native)\//;
/**
 * Contributor PRs opened from here on (user, 2026-10-15) show a behavior change working in the real
 * app, so a review only needs smaller checks of its own.
 */
export const LIVE_PROOF_SINCE = '2026-10-15T16:00:00Z';

/**
 * Every PR that changes code opened from here on (user, 2026-10-21), maintainers' included, says
 * which rare and edge cases it handles and how, so they are thought through before review.
 */
export const EDGE_CASES_SINCE = '2026-10-21T05:00:00Z';

/**
 * Files that touch the operating system: native helpers, windows and tray, keyboard shortcuts,
 * the terminal and processes, dictation, secure storage, updates and packaging. A change there says
 * how it behaves on Windows and on macOS (user, 2026-10-21: testing on a Mac is recommended, not required).
 */
const OS_LEVEL = /^(native\/|build\/|scripts\/(build|package|sign|notarize)[^/]*$|src\/main\/(computer\/|platform|tray|window-|keep-awake|dictation|exec\.ts|workspace-terminal|keychain|secrets|shutdown|update|browser(-startup)?\.ts|pet-overlay|pet-window|edit-context-menu|toolchain|sandbox|rawfs|fsops|project-file-watcher)|src\/renderer\/[^/]*(shortcut|dictation|keys?)[^/]*\.ts$)/;

/**
 * Four more for PRs opened from here on (user, 2026-10-21): a change to what the app saves loads
 * the previous version's data, every decision is logged with its reason, new tests wait for a
 * condition instead of a fixed time, and cost per step and big files are stated.
 */
export const QUALITY_SINCE = '2026-10-21T06:00:00Z';
/** Added code that writes saved state: settings, durable files, secure storage, extension storage. Not IPC schemas. */
const SAVES = /\b(?:writeDurable(?:Now|Soon)?|readDurable|setSecret|saveConfig|chrome\.storage\.(?:local|session|sync)\.set|fs(?:\.promises)?\.writeFile|writeFileSync)\b/;
/** A fixed wait in test code: setTimeout or sleep with a delay in milliseconds. */
const FIXED_WAIT = /(?:setTimeout\([^;]*?,\s*|\bsleep\(\s*|\bwait\(\s*)([\d_]+)\s*\)/;
export const MAX_TEST_WAIT_MS = 1000;
export const LARGE_FILE_BYTES = 500 * 1024;

/** Files that define contracts between processes, the extension and stored data; AGENTS.md maps them. */
const CONTRACT = /^(src\/preload\/index\.ts|src\/main\/(ipc|plugins-ipc)\.ts|src\/shared\/[^/]+\.ts)$/;
/** The template's headings and the names contributors already use for the same thing. */
const HEADINGS = {
  why: ['why', 'problem', 'root cause', 'cause', 'summary', 'motivation'],
  what: ['what changed', 'what changes', 'what', 'change', 'changes', 'fix'],
  test: ['test', 'tests', 'testing', 'validation', 'verification'],
  screenshots: ['screenshots', 'screenshot', 'before and after', 'ui'],
  proof: ['live proof', 'proof', 'live test', 'manual test'],
  edges: ['edge cases', 'edge and rare cases', 'rare and edge cases', 'edge cases handled', 'rare cases', 'edge-cases'],
  platforms: ['platforms', 'platform', 'windows and macos', 'macos and windows', 'operating systems'],
  saved: ['saved data', 'stored data', 'old data', 'migration', 'upgrade']
};


/** The text without HTML comments, removed until none is left: one pass can join the pieces of a
 * split comment (`<!<!-- -->-- … -->`) into a new one that readers still cannot see. */
export function withoutComments(text) {
  let previous;
  do { previous = text; text = text.replace(/<!--[\s\S]*?-->/g, ''); } while (text !== previous);
  return text;
}

/** Text of the first `##` section with one of these headings, without HTML comments; empty when missing. */
function section(body, key) {
  const names = HEADINGS[key];
  const lines = withoutComments(body).split(/\r?\n/);
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
 *   fromFork?: boolean, maintainerCanModify?: boolean, maintainer?: boolean, createdAt?: string,
 *   addedCode?: string[], addedTests?: string[], largeFiles?: Array<{ path: string, bytes: number }> }} pr
 * @returns {string[]} what is missing, in words a contributor can act on; empty when it passes
 */
export function checkPullRequest({ body, files, draft = false, fromFork = false, maintainerCanModify = true, maintainer = true, createdAt = '',
  addedCode = [], addedTests = [], largeFiles = [] }) {
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

  if (!maintainer && Date.parse(createdAt) >= Date.parse(LIVE_PROOF_SINCE) &&
      files.some((file) => BEHAVIOR.test(file.path) && !TESTS.test(file.path) && !CATALOG.test(file.path)) &&
      !/!\[[^\]]*\]\(|<img\s|<video\s|https:\/\/github\.com\/user-attachments\/|```[^\n]*\n\s*\S/i.test(section(text, 'proof')) &&
      !/^(?:[-*]\s+(?:\[[ xX]\]\s+)?)?no behavior changes?:\s*\S.{10,}/im.test(text)) {
    problems.push('This changes what the app does: show it working in the real app under "## Live proof" (a screenshot, a recording, or an excerpt of the app log in a code block), or write "No behavior change: <reason>".');
  }

  if (Date.parse(createdAt) >= Date.parse(EDGE_CASES_SINCE) && code.length && section(text, 'edges').length < 20 &&
      !/^(?:[-*]\s+(?:\[[ xX]\]\s+)?)?no edge cases?:\s*\S.{10,}/im.test(text)) {
    problems.push('Say which rare and edge cases this handles under "## Edge cases" (for example empty or missing input, a restart or reload midway, two things at once, a slow or failed network, another platform or language, old data or an older extension) and how, ideally naming the tests that cover them. When none apply, write "No edge cases: <reason>".');
  }

  if (Date.parse(createdAt) >= Date.parse(EDGE_CASES_SINCE) && code.length &&
      !/^[-*]\s+\[[xX]\]\s+every new text a person sees is in all 12 languages/im.test(text)) {
    problems.push('Tick "Every new text a person sees is in all 12 languages, or there is none" in the checklist: interface text, timeline notes, notifications and the extension\'s texts all ship with their translations.');
  }
  if (Date.parse(createdAt) >= Date.parse(EDGE_CASES_SINCE) && files.some((file) => OS_LEVEL.test(file.path) && !TESTS.test(file.path)) &&
      section(text, 'platforms').length < 20 && !/^(?:[-*]\s+(?:\[[ xX]\]\s+)?)?no platform differences?:\s*\S.{10,}/im.test(text)) {
    problems.push('This touches the operating system: say under "## Platforms" how it behaves on Windows and on macOS (including keys the system or an input method takes first). Trying it on a Mac is welcome but not required; then say why it works there. If the platforms cannot differ, write "No platform difference: <reason>".');
  }

  if (Date.parse(createdAt) >= Date.parse(QUALITY_SINCE)) {
    const ticked = (re) => new RegExp(`^[-*]\\s+\\[[xX]\\]\\s+${re}`, 'im').test(text);
    if (code.length && !ticked('every decision the app makes')) {
      problems.push('Tick "Every decision the app makes (it waits, refuses, skips or retries) writes one log line saying which and why, or there is none": a diagnostics report should answer "why didn\'t it…" by itself.');
    }
    if (code.length && !ticked('it sends no more to chatgpt or other providers per step')) {
      problems.push('Tick "It sends no more to ChatGPT or other providers per step, or the PR says how much more and why": every Goal or Loop step pays for what one message carries.');
    }
    if (addedCode.some((line) => SAVES.test(line)) && section(text, 'saved').length < 20 &&
        !/^(?:[-*]\s+(?:\[[ xX]\]\s+)?)?no saved-data change:\s*\S.{10,}/im.test(text)) {
      problems.push('This writes saved data (settings, files, secure storage or extension storage): name the test under "## Saved data" that loads data saved by the previous version, and a damaged value, or write "No saved-data change: <reason>". An update that cannot read old data breaks people right after updating.');
    }
    const waits = addedTests.filter((line) => {
      const match = FIXED_WAIT.exec(line);
      return !!match && Number(match[1].replace(/_/g, '')) > MAX_TEST_WAIT_MS && !/advanceTimers|useFakeTimers/.test(line);
    });
    if (waits.length && !/^long wait:\s*\S.{10,}/im.test(text)) {
      problems.push(`New tests wait a fixed time over ${MAX_TEST_WAIT_MS / 1000} s (${waits.length} place${waits.length === 1 ? '' : 's'}, e.g. \`${waits[0].replace(/^\+\s*/, '').trim().slice(0, 80)}\`): use fake timers or wait for the condition, so the test is fast and not flaky on a slow runner, or add a line "Long wait: <reason>".`);
    }
    if (largeFiles.length && !/^size:\s*\S.{10,}/im.test(text)) {
      problems.push(`This adds large files (${largeFiles.map((file) => `${file.path} ${Math.round(file.bytes / 1024)} KB`).join(', ')}): say why under a line "Size: <reason>", or make them smaller.`);
    }
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

/** Lines this PR adds under these paths (without the leading "+"), for the content checks. */
function addedLines(base, paths) {
  const raw = execFileSync('git', ['diff', '-U0', `${base}...HEAD`, '--', ...paths], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return raw.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'));
}

/** Files this PR adds or changes that are now larger than LARGE_FILE_BYTES; lockfiles excepted. */
function largeFilesOf(base) {
  const names = execFileSync('git', ['diff', '--name-only', '--diff-filter=AM', `${base}...HEAD`], { encoding: 'utf8' }).split('\n').filter(Boolean);
  return names.filter((name) => !/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(name)).flatMap((name) => {
    const bytes = Number(execFileSync('git', ['cat-file', '-s', `HEAD:${name}`], { encoding: 'utf8' }).trim());
    return bytes > LARGE_FILE_BYTES ? [{ path: name, bytes }] : [];
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8'));
  const pr = event.pull_request;
  if (!pr) { console.log('Not a pull request; nothing to check.'); process.exit(0); }
  const problems = checkPullRequest({
    body: pr.body ?? '', files: changedFiles(`origin/${pr.base.ref}`), draft: pr.draft === true,
    fromFork: pr.head?.repo?.full_name !== pr.base?.repo?.full_name, maintainerCanModify: pr.maintainer_can_modify !== false,
    maintainer: ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(pr.author_association) || pr.user?.type === 'Bot', createdAt: pr.created_at ?? '',
    addedCode: addedLines(`origin/${pr.base.ref}`, ['src', 'extension', 'native']),
    addedTests: addedLines(`origin/${pr.base.ref}`, ['test', 'scripts/verify-*']),
    largeFiles: largeFilesOf(`origin/${pr.base.ref}`)
  });
  if (!problems.length) { console.log('Pull request checklist passed.'); process.exit(0); }
  console.log('This pull request is not ready for review yet. See CONTRIBUTING.md.\n');
  for (const problem of problems) {
    console.log(`- ${problem}`);
    console.log(`::error::${problem}`);
  }
  process.exit(1);
}
