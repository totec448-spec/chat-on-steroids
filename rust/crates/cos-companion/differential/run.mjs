#!/usr/bin/env node
// Sends the same bridge exchanges to the TypeScript bridge (vitest, no Electron window, port 0)
// and to the real `cos-headless` binary, then compares the answers, the profile's config.json
// and state/chat-models.json. Exit 0: equal. Exit 1: different. Exit 2: a side failed.
//
//   node rust/crates/cos-companion/differential/run.mjs [<cos-headless.exe>] [--out <dir>] [--only <case>]
//
// The exchanges are the recorded E2.4 fixtures of cos-types (`/status`, `/models`, `/usage`,
// `/settings`, `/browser/preferences`, `/diagnostics`, `/plugin-refresh`, `/project-create`),
// one case each, then each scenario*.json as one case. Each case runs on a fresh profile on both
// sides, starting from the TypeScript `defaultConfig()`. A `send` op (see routes.gen.ts) goes
// through `POST /v1/inputs` here, so a case with one also switches the control API on. The binary runs with
// CLF_BRIDGE_PORTS=0 behind a dead proxy and is stopped with a second `--quit` launch.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const flag = (name) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
};
const positional = process.argv.slice(2).find((arg, index, all) => !arg.startsWith('--') && !all[index - 1]?.startsWith('--'));
const binary = path.resolve(positional ?? path.join(repo, 'rust/target/release/cos-headless.exe'));
const out = path.resolve(flag('--out') ?? path.join(repo, '.tmp/companion-differential'));
const only = flag('--only');
const fixtures = path.join(repo, 'rust/crates/cos-types/tests/fixtures/http/bridge');
const routes = ['GET_status', 'POST_status', 'POST_models', 'POST_usage', 'GET_settings', 'POST_settings',
  'POST_browser_preferences', 'POST_diagnostics', 'POST_plugin-refresh', 'POST_project-create'];

const cases = [];
for (const name of readdirSync(fixtures).sort()) {
  if (!routes.some((route) => name.startsWith(`${route}.`))) continue;
  const fixture = JSON.parse(readFileSync(path.join(fixtures, name), 'utf8'));
  cases.push({
    name: name.replace(/\.json$/, ''),
    ops: [{ method: fixture.method, route: fixture.route, request: fixture.request, auth: fixture.status !== 401 }]
  });
}
for (const name of readdirSync(here).filter((file) => /^scenario.*\.json$/.test(file)).sort()) {
  cases.push({ name: name.replace(/\.json$/, ''), ops: JSON.parse(readFileSync(path.join(here, name), 'utf8')) });
}

const EXTENSION = { 'x-extension-version': '2.1.35', 'x-extension-protocol': '14', 'content-type': 'application/json' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what, probe, ms = 45_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const value = await probe(); if (value) return value; } catch {}
    await sleep(100);
  }
  throw new Error(`timed out: ${what}`);
}

/** The loopback provider (stub.mjs), logging each request it answers to `log`. */
async function provider(log) {
  const child = spawn(process.execPath, [path.join(here, 'stub.mjs'), log], { stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise((resolve, reject) => {
    child.stdout.once('data', (chunk) => resolve(String(chunk).trim()));
    child.once('exit', () => reject(new Error('the stub provider exited')));
  });
  return { child, url };
}

/** The Rust side: the release binary on a fresh profile that starts from the TypeScript config. */
async function rust(entry, dir) {
  const profile = path.join(dir, 'profile');
  mkdirSync(profile, { recursive: true });
  const baked = readFileSync(path.join(out, entry.name, 'ts', 'initial-config.json'), 'utf8');
  const config = JSON.parse(entry.stub?.from ? baked.replaceAll(entry.stub.from, entry.stub.to) : baked);
  if (entry.ops.some((op) => op.send)) config.controlApi = { ...config.controlApi, enabled: true, allowActions: true };
  writeFileSync(path.join(profile, 'config.json'), JSON.stringify(config, null, 2));
  const env = { ...process.env, CLF_BRIDGE_PORTS: '0', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' };
  const child = spawn(binary, [`--user-data-dir=${profile}`], { env, stdio: 'ignore', windowsHide: true });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  try {
    const log = () => { try { return readFileSync(path.join(profile, 'app.log'), 'utf8'); } catch { return ''; } };
    const port = Number(await until('the bridge listens', () => /bridge listening on 127\.0\.0\.1:(\d+)/.exec(log())?.[1]));
    let bearer = '';
    const send = async (op) => {
      const response = await fetch(`http://127.0.0.1:${port}${op.route}`, {
        method: op.method ?? 'POST',
        headers: { ...EXTENSION, ...(bearer && op.auth !== false ? { authorization: `Bearer ${bearer}` } : {}), ...op.headers },
        body: op.method === 'GET' ? undefined : op.raw ?? JSON.stringify(op.request ?? {})
      });
      return { status: response.status, body: await response.json() };
    };
    bearer = await until('pairing', async () => (await send({ route: '/pair', request: {} })).body?.token);
    // Routes answer 503 bridge_recovering until restore opens admission.
    await until('admission', async () => (await send({ method: 'GET', route: '/settings' })).status !== 503);
    const answers = [];
    const sessions = new Map();
    const v1 = async (route, body) => {
      const endpoint = JSON.parse(readFileSync(path.join(profile, 'control-api', 'endpoint.json'), 'utf8'));
      const token = readFileSync(path.join(profile, 'control-api', 'token'), 'utf8').trim();
      const response = await fetch(`http://127.0.0.1:${endpoint.port}${route}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
      });
      return { status: response.status, body: await response.json() };
    };
    for (const op of entry.ops) {
      if (op.config) { answers.push({ config: true }); continue; }
      if (op.wait) { await sleep(op.wait); answers.push({ wait: op.wait }); continue; }
      if (op.send) {
        const sessionId = op.send.conversation ? sessions.get(op.send.conversation) : undefined;
        const sent = await until('the control API', () => v1('/v1/inputs', { id: op.send.id, ...(sessionId ? { sessionId } : {}), text: op.send.text }));
        answers.push({ send: { id: sent.body.input?.id, state: sent.body.input?.state, conversationId: sent.body.input?.conversationId } });
        continue;
      }
      const request = JSON.parse(JSON.stringify(op.request ?? null).replaceAll('"<NOW>"', String(Date.now())));
      const answer = await send({ ...op, request });
      if (op.route === '/events' && answer.body?.sessionId) sessions.set(request.conversationId, answer.body.sessionId);
      answers.push({ route: op.route, ...answer });
    }
    await sleep(300);
    writeFileSync(path.join(dir, 'answers.json'), JSON.stringify(answers, null, 2));
  } finally {
    spawnSync(binary, [`--user-data-dir=${profile}`, '--quit'], { env, stdio: 'ignore', windowsHide: true, timeout: 30_000 });
    const stopped = await Promise.race([exited.then(() => true), sleep(30_000).then(() => false)]);
    if (!stopped) child.kill();
  }
  return profile;
}

function run(label, command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    process.stderr.write(`${label} failed (${result.status})\n${result.stdout}\n${result.stderr}\n`);
    return false;
  }
  return true;
}

const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  if (typeof value === 'number' && value > 1e12 && value < 1e13) return '<CLOCK>';
  if (typeof value === 'string' && NONCE.test(value)) return '<NONCE>';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/.test(value)) return '<SESSION>';
  if (typeof value === 'string' && /^goal-[0-9a-z]+-[0-9a-z]{8}$/.test(value)) return '<TOKEN>';
  return value;
}

/** What E2.4 writes in a profile: the config keys its routes change, and the model catalog. */
function snapshot(answersDir, profile) {
  const entries = new Map();
  const answers = path.join(answersDir, 'answers.json');
  if (existsSync(answers)) entries.set('answers', normalize(JSON.parse(readFileSync(answers, 'utf8'))));
  const config = path.join(profile, 'config.json');
  if (existsSync(config)) {
    const saved = JSON.parse(readFileSync(config, 'utf8'));
    entries.set('config.json', {
      compaction: { auto: saved.compaction?.auto, autoTokens: saved.compaction?.autoTokens },
      goal: { enabled: saved.goal?.enabled, mode: saved.goal?.mode },
      ui: { browserPreferences: saved.ui?.browserPreferences ?? null }
    });
  }
  const models = path.join(profile, 'state', 'chat-models.json');
  entries.set('state/chat-models.json', existsSync(models) ? normalize(JSON.parse(readFileSync(models, 'utf8'))) : null);
  for (const name of ['goal-objectives', 'goal-switches', 'goal-replies']) {
    const file = path.join(profile, 'state', `${name}.json`);
    entries.set(`state/${name}.json`, existsSync(file) ? normalize(JSON.parse(readFileSync(file, 'utf8'))) : null);
  }
  const provider = path.join(answersDir, 'provider.jsonl');
  if (existsSync(provider)) {
    entries.set('provider requests', normalize(readFileSync(provider, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))));
  }
  return entries;
}

function differences(left, right, at = '$', found = []) {
  if (found.length > 12) return found;
  if (typeof left !== typeof right || Array.isArray(left) !== Array.isArray(right) || (left === null) !== (right === null)) {
    found.push(`${at}: ${JSON.stringify(left)?.slice(0, 160)} != ${JSON.stringify(right)?.slice(0, 160)}`);
  } else if (left && typeof left === 'object') {
    if (Array.isArray(left) && left.length !== right.length) found.push(`${at}: ${left.length} items != ${right.length} items`);
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (!(key in left) || !(key in right)) found.push(`${at}.${key}: only in ${key in left ? 'TypeScript' : 'Rust'}`);
      else differences(left[key], right[key], `${at}.${key}`, found);
    }
  } else if (left !== right) {
    found.push(`${at}: ${JSON.stringify(left)?.slice(0, 160)} != ${JSON.stringify(right)?.slice(0, 160)}`);
  }
  return found;
}

if (!existsSync(binary)) {
  process.stderr.write(`no binary at ${binary}\n`);
  process.exit(2);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const selected = cases.filter((entry) => !only || entry.name === only);
let failed = false;
for (const entry of selected) {
  for (const side of ['ts', 'rust']) mkdirSync(path.join(out, entry.name, side), { recursive: true });
  writeFileSync(path.join(out, entry.name, 'ops.json'), JSON.stringify(entry.ops, null, 2));
  // A case naming `<STUB>` gets its own loopback provider per side; nothing else does.
  const wantsStub = JSON.stringify(entry.ops).includes('<STUB>');
  const tsStub = wantsStub ? await provider(path.join(out, entry.name, 'ts', 'provider.jsonl')) : null;
  failed ||= !run(`TypeScript bridge (${entry.name})`, 'npx', ['vitest', 'run', '--config', 'rust/crates/cos-companion/differential/vitest.config.ts'], repo,
    { COS_COMPANION_OPS: path.join(out, entry.name, 'ops.json'), COS_COMPANION_OUT: path.join(out, entry.name, 'ts'), COS_COMPANION_STUB: tsStub?.url ?? '' });
  tsStub?.child.kill();
  const rustStub = wantsStub ? await provider(path.join(out, entry.name, 'rust', 'provider.jsonl')) : null;
  entry.stub = { from: tsStub?.url, to: rustStub?.url };
  try {
    entry.profile = await rust(entry, path.join(out, entry.name, 'rust'));
  } catch (error) {
    process.stderr.write(`cos-headless (${entry.name}) failed: ${error.message}\n`);
    failed = true;
  } finally {
    rustStub?.child.kill();
  }
}
if (failed) process.exit(2);

let differentCases = 0;
for (const entry of selected) {
  const ts = snapshot(path.join(out, entry.name, 'ts'), path.join(out, entry.name, 'ts'));
  const rs = snapshot(path.join(out, entry.name, 'rust'), entry.profile);
  const lines = [];
  for (const name of [...new Set([...ts.keys(), ...rs.keys()])].sort()) {
    const found = differences(ts.get(name), rs.get(name));
    if (found.length) lines.push(`  ${name}:`, ...found.map((line) => `    ${line}`));
  }
  if (lines.length) {
    differentCases += 1;
    console.log(`${entry.name}: DIFFERENT`);
    console.log(lines.join('\n'));
  } else {
    console.log(`${entry.name}: equal`);
  }
}
console.log(`${selected.length - differentCases}/${selected.length} cases equal`);
process.exit(differentCases ? 1 : 0);
