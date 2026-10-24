#!/usr/bin/env node
// Semantic difference between two golden corpora, per file.
//
//   node scripts/golden/diff.mjs <a> <b> [--strict-order] [--max 20]
//   node scripts/golden/diff.mjs --self-test
//
// Exit 0: no difference. Exit 1: differences, listed per file. Exit 2: a corpus is missing or
// unreadable, so the result is inconclusive and never reported as a match.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const show = value => { const text = JSON.stringify(value); return text === undefined ? 'undefined' : text.length > 160 ? `${text.slice(0, 157)}...` : text; };
const kind = value => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);

/** Every difference between two JSON values, as `path: a -> b` lines. */
export function compare(a, b, { strictOrder = false } = {}, at = '$', out = []) {
  if (kind(a) !== kind(b)) { out.push(`${at}: ${show(a)} -> ${show(b)}`); return out; }
  if (Array.isArray(a)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= a.length) out.push(`${at}[${i}]: (absent) -> ${show(b[i])}`);
      else if (i >= b.length) out.push(`${at}[${i}]: ${show(a[i])} -> (absent)`);
      else compare(a[i], b[i], { strictOrder }, `${at}[${i}]`, out);
    }
    return out;
  }
  if (a && typeof a === 'object') {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    for (const key of keysA) {
      const where = /^[A-Za-z_$][\w$]*$/.test(key) ? `${at}.${key}` : `${at}[${JSON.stringify(key)}]`;
      if (!Object.hasOwn(b, key)) out.push(`${where}: ${show(a[key])} -> (absent)`);
      else compare(a[key], b[key], { strictOrder }, where, out);
    }
    for (const key of keysB) if (!Object.hasOwn(a, key)) out.push(`${/^[A-Za-z_$][\w$]*$/.test(key) ? `${at}.${key}` : `${at}[${JSON.stringify(key)}]`}: (absent) -> ${show(b[key])}`);
    if (strictOrder) {
      const shared = keysA.filter(key => Object.hasOwn(b, key));
      const sharedB = keysB.filter(key => Object.hasOwn(a, key));
      if (shared.join('\u0000') !== sharedB.join('\u0000')) out.push(`${at}: key order ${show(shared)} -> ${show(sharedB)}`);
    }
    return out;
  }
  if (a !== b) out.push(`${at}: ${show(a)} -> ${show(b)}`);
  return out;
}

function files(root) {
  const found = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else found.push(path.relative(root, file).split(path.sep).join('/'));
    }
  };
  walk(root);
  return found.sort();
}

/** Returns { differences: Map<file, string[]>, onlyA, onlyB }. Throws when a corpus is unreadable. */
export function diffCorpora(rootA, rootB, options = {}) {
  for (const root of [rootA, rootB]) if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`not a corpus directory: ${root}`);
  const listA = files(rootA).filter(f => f.endsWith('.json'));
  const listB = files(rootB).filter(f => f.endsWith('.json'));
  if (!listA.length || !listB.length) throw new Error(`empty corpus: ${!listA.length ? rootA : rootB}`);
  const setB = new Set(listB);
  const setA = new Set(listA);
  const differences = new Map();
  for (const file of listA.filter(f => setB.has(f))) {
    const read = root => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    const found = compare(read(rootA), read(rootB), options);
    if (found.length) differences.set(file, found);
  }
  return { differences, onlyA: listA.filter(f => !setB.has(f)), onlyB: listB.filter(f => !setA.has(f)) };
}

function report({ differences, onlyA, onlyB }, max) {
  const lines = [];
  for (const file of onlyA) lines.push(`only in a: ${file}`);
  for (const file of onlyB) lines.push(`only in b: ${file}`);
  for (const [file, found] of differences) {
    lines.push(`${file}: ${found.length} difference(s)`);
    for (const line of found.slice(0, max)) lines.push(`  ${line}`);
    if (found.length > max) lines.push(`  ... ${found.length - max} more`);
  }
  return lines;
}

/** Seeded controls: each known-bad change must be reported, and an unchanged copy must match. */
function selfTest() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-diff-'));
  const write = (root, rel, value) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), JSON.stringify(value, null, 2)); };
  const corpus = {
    'v/mcp/core/tools-list.json': { response: { messages: [{ result: { tools: [{ name: 'read', inputSchema: { type: 'object', properties: { paths: { type: 'array' }, max_bytes: { type: 'integer', maximum: 524288 } } } }, { name: 'exec', description: 'Run JavaScript' }] } }] } },
    'v/api/health.json': { response: { status: 200, body: { ok: true, routes: ['/v1/health', '/v1/status'] } } }
  };
  const controls = [
    ['identical copy matches', () => {}, r => r.differences.size === 0 && !r.onlyA.length && !r.onlyB.length],
    ['changed number', root => write(root, 'v/mcp/core/tools-list.json', { ...corpus['v/mcp/core/tools-list.json'], response: { messages: [{ result: { tools: [{ name: 'read', inputSchema: { type: 'object', properties: { paths: { type: 'array' }, max_bytes: { type: 'integer', maximum: 524287 } } } }, corpus['v/mcp/core/tools-list.json'].response.messages[0].result.tools[1]] } }] } }),
      r => r.differences.get('v/mcp/core/tools-list.json')?.some(line => line.includes('maximum: 524288 -> 524287'))],
    ['swapped array items', root => write(root, 'v/api/health.json', { response: { status: 200, body: { ok: true, routes: ['/v1/status', '/v1/health'] } } }),
      r => r.differences.get('v/api/health.json')?.length === 2],
    ['removed key', root => write(root, 'v/api/health.json', { response: { status: 200, body: { routes: ['/v1/health', '/v1/status'] } } }),
      r => r.differences.get('v/api/health.json')?.some(line => line.includes('$.response.body.ok: true -> (absent)'))],
    ['changed type', root => write(root, 'v/api/health.json', { response: { status: '200', body: corpus['v/api/health.json'].response.body } }),
      r => r.differences.get('v/api/health.json')?.some(line => line.includes('$.response.status: 200 -> "200"'))],
    ['missing file', root => fs.rmSync(path.join(root, 'v/api/health.json')), r => r.onlyA.includes('v/api/health.json')],
    ['extra file', root => write(root, 'v/api/extra.json', {}), r => r.onlyB.includes('v/api/extra.json')],
    ['key order only, semantic', root => write(root, 'v/api/health.json', { response: { body: corpus['v/api/health.json'].response.body, status: 200 } }), r => r.differences.size === 0],
    ['key order only, strict', root => write(root, 'v/api/health.json', { response: { body: corpus['v/api/health.json'].response.body, status: 200 } }),
      r => r.differences.get('v/api/health.json')?.some(line => line.includes('key order')), { strictOrder: true }]
  ];
  let failures = 0;
  for (const [name, mutate, expect, options] of controls) {
    const a = fs.mkdtempSync(path.join(base, 'a-'));
    const b = fs.mkdtempSync(path.join(base, 'b-'));
    for (const [rel, value] of Object.entries(corpus)) { write(a, rel, value); write(b, rel, value); }
    mutate(b);
    const ok = expect(diffCorpora(a, b, options));
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  }
  let refused = false;
  try { diffCorpora(path.join(base, 'absent'), path.join(base, 'absent-too')); } catch { refused = true; }
  console.log(`${refused ? 'ok  ' : 'FAIL'} missing corpus is inconclusive, not a match`);
  if (!refused) failures++;
  fs.rmSync(base, { recursive: true, force: true });
  return failures;
}

const argv = process.argv.slice(2);
if (argv.includes('--self-test')) {
  process.exitCode = selfTest() ? 1 : 0;
} else {
  const strictOrder = argv.includes('--strict-order');
  const maxAt = argv.indexOf('--max');
  const max = maxAt === -1 ? 20 : Number(argv[maxAt + 1]);
  const [a, b] = argv.filter((arg, i) => !arg.startsWith('--') && argv[i - 1] !== '--max');
  if (!a || !b) { console.error('usage: node scripts/golden/diff.mjs <a> <b> [--strict-order] [--max 20] | --self-test'); process.exit(2); }
  try {
    const result = diffCorpora(path.resolve(a), path.resolve(b), { strictOrder });
    const lines = report(result, max);
    const changed = result.differences.size + result.onlyA.length + result.onlyB.length;
    console.log(lines.length ? lines.join('\n') : 'no differences');
    if (changed) console.log(`\n${result.differences.size} file(s) differ, ${result.onlyA.length} only in a, ${result.onlyB.length} only in b`);
    process.exitCode = changed ? 1 : 0;
  } catch (error) {
    console.error(`inconclusive: ${error.message}`);
    process.exitCode = 2;
  }
}
