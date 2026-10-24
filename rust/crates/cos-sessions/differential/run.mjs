#!/usr/bin/env node
// Feeds ops.json to the TypeScript recorder (vitest, no Electron) and to the Rust store, then
// compares the two sessions/ trees. Exit 0: equal. Exit 1: different. Exit 2: a side failed.
//
//   node rust/crates/cos-sessions/differential/run.mjs [--out <dir>]
//
// JSON files and journal lines are compared as JSON values after the run-dependent values are
// replaced: the session id, call ids, and clock readings the script did not set. Key order is
// reported but does not fail the comparison. Every other file is compared byte for byte.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const outFlag = process.argv.indexOf('--out');
const out = path.resolve(outFlag > 0 ? process.argv[outFlag + 1] : path.join(repo, '.tmp/sessions-differential'));
const ops = JSON.parse(readFileSync(path.join(here, 'ops.json'), 'utf8'));
const scripted = new Set(ops.calls.map((call) => call.startedAt));

function run(label, command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    process.stderr.write(`${label} failed (${result.status})\n${result.stdout}\n${result.stderr}\n`);
    process.exit(2);
  }
}

rmSync(out, { recursive: true, force: true });
for (const side of ['ts', 'rust']) mkdirSync(path.join(out, side), { recursive: true });
run('TypeScript recorder', 'npx', ['vitest', 'run', '--config', path.relative(repo, path.join(here, 'vitest.config.ts')).split(path.sep).join('/')], repo, { COS_SESSIONS_OUT: path.join(out, 'ts') });
run('Rust store', 'cargo', ['test', '-p', 'cos-sessions', '--test', 'differential', '--', '--exact', 'records_the_operation_script'], path.join(repo, 'rust'), { COS_SESSIONS_OUT: path.join(out, 'rust') });

function files(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full, `${prefix}${name}/`) : [`${prefix}${name}`];
  });
}

function tree(side) {
  const root = path.join(out, side, 'sessions');
  const sessions = existsSync(root) ? readdirSync(root).sort() : [];
  const names = new Map(sessions.map((name, index) => [name, `<SESSION:${index + 1}>`]));
  const uuids = new Map();
  const normalize = (value, key) => {
    if (Array.isArray(value)) return value.map((item) => normalize(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, normalize(item, name)]));
    }
    if (typeof value === 'string') {
      if (names.has(value)) return names.get(value);
      if (key === 'callId') {
        if (!uuids.has(value)) uuids.set(value, `<UUID:${uuids.size + 1}>`);
        return uuids.get(value);
      }
      return value;
    }
    if (typeof value === 'number' && value > 1e12 && value < 1e13 && !scripted.has(value)) return '<CLOCK>';
    return value;
  };
  const entries = new Map();
  for (const session of sessions) {
    for (const file of files(path.join(root, session))) {
      const bytes = readFileSync(path.join(root, session, file));
      const name = `${names.get(session)}/${file}`;
      if (file.endsWith('.jsonl')) {
        const lines = bytes.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
        entries.set(name, { json: normalize(lines), raw: lines });
      } else if (file.endsWith('.json')) {
        const parsed = JSON.parse(bytes.toString('utf8'));
        entries.set(name, { json: normalize(parsed), raw: parsed });
      } else {
        entries.set(name, { sha: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
      }
    }
  }
  return entries;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function differences(left, right, at = '$', found = []) {
  if (found.length > 20) return found;
  if (typeof left !== typeof right || Array.isArray(left) !== Array.isArray(right) || (left === null) !== (right === null)) {
    found.push(`${at}: ${JSON.stringify(left)?.slice(0, 120)} != ${JSON.stringify(right)?.slice(0, 120)}`);
  } else if (left && typeof left === 'object') {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (!(key in left) || !(key in right)) found.push(`${at}.${key}: only in ${key in left ? 'TypeScript' : 'Rust'}`);
      else differences(left[key], right[key], `${at}.${key}`, found);
    }
  } else if (left !== right) {
    found.push(`${at}: ${JSON.stringify(left)?.slice(0, 120)} != ${JSON.stringify(right)?.slice(0, 120)}`);
  }
  return found;
}

const ts = tree('ts');
const rust = tree('rust');
let different = 0;
let orderOnly = 0;
for (const name of [...new Set([...ts.keys(), ...rust.keys()])].sort()) {
  const left = ts.get(name);
  const right = rust.get(name);
  if (!left || !right) {
    different += 1;
    console.log(`${name}: only in ${left ? 'TypeScript' : 'Rust'}`);
    continue;
  }
  if ('sha' in left || 'sha' in right) {
    const same = left.sha === right.sha;
    if (!same) different += 1;
    console.log(`${name}: ${same ? 'same bytes' : `bytes differ (${left.bytes} vs ${right.bytes})`}`);
    continue;
  }
  const found = differences(canonical(left.json), canonical(right.json));
  if (found.length) {
    different += 1;
    console.log(`${name}: different\n  ${found.join('\n  ')}`);
    continue;
  }
  const ordered = JSON.stringify(left.json) === JSON.stringify(right.json);
  if (!ordered) orderOnly += 1;
  console.log(`${name}: same value${ordered ? ', same key order' : ', key order differs'}`);
}
console.log(`\n${ts.size} TypeScript files, ${rust.size} Rust files, ${different} different, ${orderOnly} differ only in key order`);
process.exit(different === 0 && ts.size > 0 ? 0 : 1);
