#!/usr/bin/env node
// Runs the same Compact & Resume ops through the TypeScript transaction (vitest, no Electron
// window) and through cos-continuation, then compares the answers, every file under
// sessions/ and state/continuations.json with the recorder harness's compare.mjs.
// Exit 0: equal. Exit 1: different. Exit 2: a side failed.
//
//   node rust/crates/cos-continuation/differential/run.mjs [--out <dir>] [--only <case>]
//
// The cases crash after each phase of one A to B move, restart, and finish the move; two more
// crash inside the commit, before and after the session move landed. Tokens, handoff ids and
// the provenance fingerprint are random on each side, so both folders are rewritten first:
// each becomes <TOKEN:n>, <HANDOFF:n> or <CONTINUATION:n> by its order in the WAL.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare, report, run } from '../../cos-recorder/differential/compare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const flag = (name) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
};
const out = path.resolve(flag('--out') ?? path.join(repo, '.tmp/continuation-differential'));
const only = flag('--only');

const happy = ['sourceAttempt', 'sourceDispatch', 'sourceMessage', 'capture', 'claim',
  'destinationAttempt', 'destinationDispatch', 'destinationMessage', 'commit'];
const steps = (names) => names.map((step) => ({ step }));
const opening = [{ create: 'chat-a' }, { open: { automatic: false } }];
const cases = [];
for (let phase = 0; phase <= happy.length; phase++) {
  cases.push({
    name: `crash-after-${String(phase).padStart(2, '0')}-${phase ? happy[phase - 1] : 'open'}`,
    ops: [...opening, ...steps(happy.slice(0, phase)), { restart: true }, { view: true },
      ...steps(happy.slice(phase)), { view: true }, { restart: true }, { view: true }]
  });
}
for (const rebound of [false, true]) {
  cases.push({
    name: `crash-inside-commit-${rebound ? 'after' : 'before'}-the-move`,
    ops: [...opening, ...steps(happy.slice(0, 5)), { crash: { to: 'chat-b', rebound } }, { view: true },
      { step: 'commit' }, { view: true }]
  });
}
cases.push({
  name: 'automatic-ticket-cancelled-then-restarted',
  ops: [{ create: 'chat-a' }, { open: { automatic: true } }, { step: 'abort' }, { restart: true }, { view: true }]
});

const selected = cases.filter((entry) => !only || entry.name === only);
prepare(out, selected);

let failed = false;
for (const entry of selected) {
  failed ||= !run(`TypeScript continuation (${entry.name})`, 'npx',
    ['vitest', 'run', '--config', 'rust/crates/cos-continuation/differential/vitest.config.ts'], repo,
    { COS_CONTINUATION_OPS: path.join(out, entry.name, 'ops.json'), COS_CONTINUATION_OUT: path.join(out, entry.name, 'ts') });
}
failed ||= !run('Rust continuation', 'cargo',
  ['test', '-p', 'cos-continuation', '--test', 'differential', '--', '--exact', 'runs_the_continuation_ops'],
  path.join(repo, 'rust'), { COS_CONTINUATION_CASES: out, CARGO_INCREMENTAL: '0' });
if (failed) process.exit(2);

function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

/** Replaces this side's random identities by their order in its own WAL. */
function normalize(root) {
  const wal = path.join(root, 'state', 'continuations.json');
  const entries = existsSync(wal) ? JSON.parse(readFileSync(wal, 'utf8')).entries ?? [] : [];
  const names = new Map();
  const fileNames = new Map();
  entries.forEach((entry, index) => {
    names.set(entry.token, `<TOKEN:${index}>`);
    names.set(createHash('sha256').update(entry.token, 'utf8').digest('base64url'), `<CONTINUATION:${index}>`);
    if (entry.handoffId) {
      names.set(entry.handoffId, `<HANDOFF:${index}>`);
      fileNames.set(entry.handoffId, `handoff-${index}`);
    }
  });
  const rewrite = (text) => [...names].reduce((value, [from, to]) => value.split(from).join(to), text);
  for (const file of [...files(path.join(root, 'sessions')), ...files(path.join(root, 'state')), path.join(root, 'answers.json')]) {
    if (!existsSync(file) || !/\.jsonl?$/.test(file)) continue;
    writeFileSync(file, rewrite(readFileSync(file, 'utf8')));
    const base = path.basename(file, '.json');
    if (path.basename(path.dirname(file)) === 'handoffs' && fileNames.has(base)) {
      renameSync(file, path.join(path.dirname(file), `${fileNames.get(base)}.json`));
    }
  }
}
for (const entry of selected) for (const side of ['ts', 'rust']) normalize(path.join(out, entry.name, side));
process.exit(report(out, selected, ['continuations.json']));
