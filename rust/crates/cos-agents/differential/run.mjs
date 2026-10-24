#!/usr/bin/env node
// Runs the same broker ops against the TypeScript broker (`main/agents.ts`, vitest, no Electron
// window) and the Rust broker, then compares the answers with each op's `swarmState()` (what
// `/v1/agents` projects), `state/swarm.json` and `state/retired-workers.json`, the way
// ../../cos-recorder/differential/compare.mjs compares two profiles. Run ids and message ids are
// random on both sides, so each is renamed `<UUID:n>` or `<MSG:n>` by first appearance first.
// Exit 0: equal. Exit 1: different. Exit 2: a side failed.
//
//   node rust/crates/cos-agents/differential/run.mjs [--out <dir>] [--only <case>]
//
// The cases are the scenarios in scenarios.json; record.gen.ts says what an op can be.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, prepare, report, run } from '../../cos-recorder/differential/compare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const flag = (name) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
};
const out = path.resolve(flag('--out') ?? path.join(repo, '.tmp/agents-differential'));
const only = flag('--only');
const scenarios = JSON.parse(readFileSync(path.join(here, 'scenarios.json'), 'utf8'));
const cases = Object.entries(scenarios).map(([name, ops]) => ({ name, ops }));
const selected = cases.filter((entry) => !only || entry.name === only);
prepare(out, selected);

const files = ['answers.json', 'state/swarm.json', 'state/retired-workers.json'];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const MESSAGE = /\b[0-9a-f]{8}\b/g;

/** Renames every run and message id in one side's files by first appearance, keys sorted. */
function renameIds(side) {
  const names = new Map();
  const rename = (text) =>
    text
      .replace(UUID, (id) => names.get(id.toLowerCase()) ?? names.set(id.toLowerCase(), `<UUID:${names.size}>`).get(id.toLowerCase()))
      .replace(MESSAGE, (id) => names.get(id) ?? names.set(id, `<MSG:${names.size}>`).get(id));
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    return typeof value === 'string' ? rename(value) : value;
  };
  for (const file of files) {
    const full = path.join(side, file);
    if (!existsSync(full)) continue;
    writeFileSync(full, JSON.stringify(walk(canonical(JSON.parse(readFileSync(full, 'utf8')))), null, 2));
  }
}

let failed = false;
for (const entry of selected) {
  failed ||= !run(`TypeScript broker (${entry.name})`, 'npx', ['vitest', 'run', '--config', 'rust/crates/cos-agents/differential/vitest.config.ts'], repo,
    { COS_AGENTS_OPS: path.join(out, entry.name, 'ops.json'), COS_AGENTS_OUT: path.join(out, entry.name, 'ts') });
}
failed ||= !run('Rust broker', 'cargo', ['test', '-p', 'cos-agents', '--test', 'differential', '--', '--exact', 'runs_the_broker_ops'],
  path.join(repo, 'rust'), { COS_AGENTS_CASES: out, CARGO_INCREMENTAL: '0' });
if (failed) process.exit(2);
for (const entry of selected) for (const side of ['ts', 'rust']) renameIds(path.join(out, entry.name, side));
process.exit(report(out, selected, ['swarm.json', 'retired-workers.json']));
