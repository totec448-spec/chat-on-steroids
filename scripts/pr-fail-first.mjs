#!/usr/bin/env node
/**
 * Proves the "fails without the change" claim of a pull request instead of taking it on trust.
 *
 * The PR's changed tests run against the base branch's code: every code file the PR changes is put
 * back as it is on the base branch (a file the PR adds is removed), the tests stay as the PR has
 * them. At least one of them must fail there. A PR that changes no code, or no tests, has nothing
 * to prove; a PR whose tests only follow a refactor says so with "Fail-first: n/a <reason>".
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CODE = /^(src|extension|scripts|native|build)\//;
const TEST = /^test\/.+\.test\.ts$/;
const TEST_SUPPORT = /^(test\/|scripts\/verify-[^/]+\.cjs$|scripts\/fixtures\/)/;
const OPT_OUT = /^fail-first:\s*n\/a\b.{10,}/im;

/**
 * What to run and what to put back, from `git diff --name-status base...HEAD` output.
 * @param {string} nameStatus
 * @returns {{ tests: string[], restore: string[], remove: string[] }}
 */
export function planFailFirst(nameStatus) {
  const tests = [], restore = [], remove = [];
  for (const line of nameStatus.split('\n').filter(Boolean)) {
    const [status, ...paths] = line.split('\t');
    const kind = status[0];
    const [from, to = from] = paths;
    if (kind === 'D') continue;
    if (TEST.test(to)) { tests.push(to); continue; }
    if (!CODE.test(to) || TEST_SUPPORT.test(to)) continue;
    if (kind === 'A' || kind === 'C') remove.push(to);
    else if (kind === 'R') { remove.push(to); if (CODE.test(from)) restore.push(from); }
    else restore.push(to);
  }
  return { tests, restore, remove };
}

/**
 * Select an OS that can execute the changed native tests rather than skip their proof.
 * @param {string} nameStatus
 */
export function runnerForFailFirst(nameStatus) {
  return planFailFirst(nameStatus).tests.some(file => /^test\/(?:windows-[^/]+|computer(?:-[^/]+)?)\.test\.ts$/.test(file))
    ? 'windows-2025' : 'ubuntu-24.04';
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8'));
  const pr = event.pull_request;
  if (!pr) { console.log('Not a pull request; nothing to prove.'); process.exit(0); }
  const base = process.env.PR_BASE ?? `origin/${pr.base.ref}`;
  const nameStatus = execFileSync('git', ['diff', '--name-status', '--find-renames', `${base}...HEAD`], { encoding: 'utf8' });
  if (process.argv.includes('--runner')) {
    console.log(`runner=${runnerForFailFirst(nameStatus)}`);
    process.exit(0);
  }
  if (OPT_OUT.test(String(pr.body ?? '').replace(/<!--[\s\S]*?-->/g, ''))) {
    console.log('The description says this PR has no failing-first test ("Fail-first: n/a"). Nothing to prove.');
    process.exit(0);
  }
  const plan = planFailFirst(nameStatus);
  if (!plan.tests.length || !(plan.restore.length + plan.remove.length)) {
    console.log('This PR does not change both code and tests, so there is no failing-first claim to prove.');
    process.exit(0);
  }
  const mergeBase = execFileSync('git', ['merge-base', base, 'HEAD'], { encoding: 'utf8' }).trim();
  if (plan.restore.length) execFileSync('git', ['checkout', mergeBase, '--', ...plan.restore], { stdio: 'inherit' });
  for (const file of plan.remove) rmSync(file, { force: true });
  console.log(`Running ${plan.tests.length} changed test file(s) against the base branch's code:`);
  for (const file of plan.tests) console.log(`  ${file}`);
  const run = spawnSync('npx', ['vitest', 'run', ...plan.tests], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (run.status === 0) {
    const message = 'The changed tests also pass without your code change, so they do not show that it fixes anything. ' +
      'Add a test that fails on main and passes with your change, or write "Fail-first: n/a <reason>" if the tests only follow a refactor.';
    console.log(message);
    console.log(`::error::${message}`);
    process.exit(1);
  }
  console.log('\nGood: at least one changed test fails without the code change, as the PR says.');
  process.exit(0);
}
