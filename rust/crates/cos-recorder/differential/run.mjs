#!/usr/bin/env node
// Sends the same bridge exchanges to the TypeScript bridge (vitest, no Electron window, port 0)
// and to the Rust recorder, then compares the answers, every file under sessions/ and
// state/request-correlations.json. Exit 0: equal. Exit 1: different. Exit 2: a side failed.
//
//   node rust/crates/cos-recorder/differential/run.mjs [--out <dir>] [--only <case>]
//
// The exchanges are the recorded `/events`, `/correlations` and `/closed` fixtures of cos-types,
// one case each, then scenario.json and late-proof.json as one case each. Besides the routes, an op
// may be `tool_call` (an MCP `read` call with an `x-request-id`), `request_plan` (`update_plan` held
// under a request id) or `settle` (the late-proof repairs already asked for, run now). `/conversation-deleted` belongs to the outbox
// and is compared by cos-input/differential/run.mjs. Each case runs on a fresh profile on both
// sides; compare.mjs says how the two profiles are compared.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare, report, run } from './compare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const flag = (name) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
};
const out = path.resolve(flag('--out') ?? path.join(repo, '.tmp/recorder-differential'));
const only = flag('--only');
const fixtures = path.join(repo, 'rust/crates/cos-types/tests/fixtures/http/bridge');
const routes = ['POST_events', 'POST_correlations', 'POST_closed'];

const cases = [];
for (const name of readdirSync(fixtures).sort()) {
  if (!routes.some((route) => name.startsWith(`${route}.`))) continue;
  const fixture = JSON.parse(readFileSync(path.join(fixtures, name), 'utf8'));
  cases.push({ name: name.replace(/\.json$/, ''), ops: [{ route: fixture.route, request: fixture.request }] });
}
cases.push({ name: 'scenario', ops: JSON.parse(readFileSync(path.join(here, 'scenario.json'), 'utf8')) });
cases.push({ name: 'late-proof', ops: JSON.parse(readFileSync(path.join(here, 'late-proof.json'), 'utf8')) });

const selected = cases.filter((entry) => !only || entry.name === only);
prepare(out, selected);

let failed = false;
for (const entry of selected) {
  const env = { COS_RECORDER_OPS: path.join(out, entry.name, 'ops.json') };
  failed ||= !run(`TypeScript bridge (${entry.name})`, 'npx', ['vitest', 'run', '--config', 'rust/crates/cos-recorder/differential/vitest.config.ts'], repo,
    { ...env, COS_RECORDER_OUT: path.join(out, entry.name, 'ts') });
}
failed ||= !run('Rust recorder', 'cargo', ['test', '-p', 'cos-recorder', '--test', 'differential', '--', '--exact', 'records_the_bridge_exchanges'],
  path.join(repo, 'rust'), { COS_RECORDER_CASES: out, CARGO_INCREMENTAL: '0' });
if (failed) process.exit(2);
process.exit(report(out, selected, ['request-correlations.json', 'request-plans.json']));
