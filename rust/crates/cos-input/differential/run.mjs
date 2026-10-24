#!/usr/bin/env node
// Runs the same outbox and command ops through the TypeScript bridge and outbox (vitest, no
// Electron window, port 0) and through the Rust outbox, then compares the answers, every file
// under sessions/, state/session-input.json and state/bridge-commands.json, the way
// ../../cos-recorder/differential/compare.mjs compares two profiles.
// Exit 0: equal. Exit 1: different. Exit 2: a side failed.
//
//   node rust/crates/cos-input/differential/run.mjs [--out <dir>] [--only <case>]
//
// The cases are the recorded `/input/*`, `/commands/*`, `/conversation-deleted` and
// `/image-export` fixtures of cos-types, one fresh profile each, then every scenario under
// scenarios/ (written by scenarios.mjs). record.gen.ts says what a scenario op can be.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare, report, run } from '../../cos-recorder/differential/compare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const flag = (name) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
};
const out = path.resolve(flag('--out') ?? path.join(repo, '.tmp/input-differential'));
const only = flag('--only');
const fixtures = path.join(repo, 'rust/crates/cos-types/tests/fixtures/http/bridge');
const routes = ['POST_input_', 'POST_commands_', 'POST_conversation-deleted.', 'POST_image-export.'];

const cases = [];
for (const name of readdirSync(fixtures).sort()) {
  if (!routes.some((route) => name.startsWith(route))) continue;
  const fixture = JSON.parse(readFileSync(path.join(fixtures, name), 'utf8'));
  cases.push({ name: name.replace(/\.json$/, ''), ops: [{ route: fixture.route, request: fixture.request }] });
}
for (const name of readdirSync(path.join(here, 'scenarios')).sort()) {
  cases.push({ name: `scenario-${name.replace(/\.json$/, '')}`, ops: JSON.parse(readFileSync(path.join(here, 'scenarios', name), 'utf8')) });
}

const selected = cases.filter((entry) => !only || entry.name === only);
prepare(out, selected);

let failed = false;
for (const entry of selected) {
  failed ||= !run(`TypeScript bridge (${entry.name})`, 'npx', ['vitest', 'run', '--config', 'rust/crates/cos-input/differential/vitest.config.ts'], repo,
    { COS_INPUT_OPS: path.join(out, entry.name, 'ops.json'), COS_INPUT_OUT: path.join(out, entry.name, 'ts') });
}
failed ||= !run('Rust outbox', 'cargo', ['test', '-p', 'cos-input', '--test', 'differential', '--', '--exact', 'runs_the_outbox_ops'],
  path.join(repo, 'rust'), { COS_INPUT_CASES: out, CARGO_INCREMENTAL: '0' });
if (failed) process.exit(2);
process.exit(report(out, selected, ['session-input.json', 'bridge-commands.json']));
