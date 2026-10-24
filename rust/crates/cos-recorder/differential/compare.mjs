// The comparison half of the Track 2 differential harnesses: run each side, then compare the
// answers, every file under sessions/ and the named state files of both profiles. Session ids
// are replaced by the conversation that owns them, call ids by <CALL>, and clock readings the
// exchanges did not set by <CLOCK>. Files that are not JSON (assets) are compared by their
// SHA-256. Key order is reported but does not fail the comparison.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function run(label, command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    process.stderr.write(`${label} failed (${result.status})\n${result.stdout}\n${result.stderr}\n`);
    return false;
  }
  return true;
}

export function scriptedNumbers(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => scriptedNumbers(item, found));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => scriptedNumbers(item, found));
  else if (typeof value === 'number') found.add(value);
  return found;
}

function files(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full, `${prefix}${name}/`) : [`${prefix}${name}`];
  });
}

export function snapshot(root, scripted, stateFiles) {
  const sessionsRoot = path.join(root, 'sessions');
  const sessions = existsSync(sessionsRoot) ? readdirSync(sessionsRoot).sort() : [];
  const names = new Map();
  for (const session of sessions) {
    let owner = 'none';
    try {
      const meta = JSON.parse(readFileSync(path.join(sessionsRoot, session, 'meta.json'), 'utf8'));
      owner = meta.conversationId ?? meta.chatIds?.[0] ?? 'none';
    } catch {}
    names.set(session, `<SESSION:${owner}>`);
  }
  const normalize = (value, key) => {
    if (Array.isArray(value)) return value.map((item) => normalize(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, normalize(item, name)]));
    if (typeof value === 'string' && key === 'callId') return '<CALL>';
    if (typeof value === 'string') return names.get(value) ?? value;
    if (typeof value === 'number' && value > 1e12 && value < 1e13 && !scripted.has(value)) return '<CLOCK>';
    return value;
  };
  const entries = new Map();
  for (const session of sessions) {
    for (const file of files(path.join(sessionsRoot, session))) {
      const bytes = readFileSync(path.join(sessionsRoot, session, file));
      if (!file.endsWith('.json') && !file.endsWith('.jsonl')) {
        entries.set(`${names.get(session)}/${file}`, `<sha256:${createHash('sha256').update(bytes).digest('hex')}>`);
        continue;
      }
      const text = bytes.toString('utf8');
      const parsed = file.endsWith('.jsonl')
        ? text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
        : JSON.parse(text);
      entries.set(`${names.get(session)}/${file}`, normalize(parsed));
    }
  }
  for (const name of stateFiles) {
    const file = path.join(root, 'state', name);
    if (existsSync(file)) entries.set(`state/${name}`, normalize(JSON.parse(readFileSync(file, 'utf8'))));
  }
  const answers = path.join(root, 'answers.json');
  if (existsSync(answers)) entries.set('answers', normalize(JSON.parse(readFileSync(answers, 'utf8'))));
  return entries;
}

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function differences(left, right, at = '$', found = []) {
  if (found.length > 12) return found;
  if (typeof left !== typeof right || Array.isArray(left) !== Array.isArray(right) || (left === null) !== (right === null)) {
    found.push(`${at}: ${JSON.stringify(left)?.slice(0, 140)} != ${JSON.stringify(right)?.slice(0, 140)}`);
  } else if (left && typeof left === 'object') {
    if (Array.isArray(left) && left.length !== right.length) found.push(`${at}: ${left.length} items != ${right.length} items`);
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (!(key in left) || !(key in right)) found.push(`${at}.${key}: only in ${key in left ? 'TypeScript' : 'Rust'}`);
      else differences(left[key], right[key], `${at}.${key}`, found);
    }
  } else if (left !== right) {
    found.push(`${at}: ${JSON.stringify(left)?.slice(0, 140)} != ${JSON.stringify(right)?.slice(0, 140)}`);
  }
  return found;
}

/** A fresh output folder: `<case>/{ts,rust}` and `<case>/ops.json` for every case. */
export function prepare(out, selected) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const entry of selected) {
    for (const side of ['ts', 'rust']) mkdirSync(path.join(out, entry.name, side), { recursive: true });
    writeFileSync(path.join(out, entry.name, 'ops.json'), JSON.stringify(entry.ops, null, 2));
  }
  writeFileSync(path.join(out, 'cases.json'), JSON.stringify(selected.map((entry) => entry.name)));
}

/** Prints one block per case and answers the process exit code: 0 equal, 1 different. */
export function report(out, selected, stateFiles) {
  let differentCases = 0;
  for (const entry of selected) {
    const scripted = scriptedNumbers(entry.ops);
    const ts = snapshot(path.join(out, entry.name, 'ts'), scripted, stateFiles);
    const rust = snapshot(path.join(out, entry.name, 'rust'), scripted, stateFiles);
    const lines = [];
    let different = 0;
    for (const name of [...new Set([...ts.keys(), ...rust.keys()])].sort()) {
      const left = ts.get(name);
      const right = rust.get(name);
      if (left === undefined || right === undefined) {
        different += 1;
        lines.push(`  ${name}: only in ${left !== undefined ? 'TypeScript' : 'Rust'}`);
        continue;
      }
      const found = differences(canonical(left), canonical(right));
      if (found.length) {
        different += 1;
        lines.push(`  ${name}: different\n    ${found.join('\n    ')}`);
      } else {
        lines.push(`  ${name}: same value${JSON.stringify(left) === JSON.stringify(right) ? '' : ', key order differs'}`);
      }
    }
    if (different) differentCases += 1;
    console.log(`${entry.name}: ${different ? `DIFFERENT (${different} of ${ts.size} TypeScript files)` : `equal (${ts.size} files)`}`);
    console.log(lines.join('\n'));
  }
  console.log(`\n${selected.length} cases, ${selected.length - differentCases} equal, ${differentCases} different`);
  return differentCases === 0 ? 0 : 1;
}
