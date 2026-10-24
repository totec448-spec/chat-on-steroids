#!/usr/bin/env node
// Records the observable contracts of Chat On Steroids as a golden corpus: MCP initialize,
// tools/list and a call matrix per surface, the HTTP guards of the MCP endpoint, and every /v1
// control API route with its errors and SSE framing. See rust/golden/README.md.
//
//   node scripts/golden/record.mjs [--binary <exe>] [--out <dir>] [--variants base,desktop,...]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repo, request, launchApp, waitReady, stopApp, openTargetWindow, pause } from './app.mjs';
import { createNormalizer, shapeOf } from './normalize.mjs';
import { VARIANTS } from './variants.mjs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i === -1 ? fallback : argv[i + 1]; };
const binary = opt('binary', null);
const outDir = path.resolve(opt('out', path.join(repo, 'rust', 'golden')));
const only = opt('variants', null)?.split(',');
const scratch = path.join(repo, '.tmp', 'golden-scratch', path.basename(outDir));
const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;

const HEADERS_KEPT = ['content-type', 'cache-control', 'allow', 'retry-after', 'connection', 'mcp-session-id', 'www-authenticate', 'x-accel-buffering'];
const keptHeaders = headers => Object.fromEntries(HEADERS_KEPT.filter(name => headers[name] !== undefined).map(name => [name, name === 'mcp-session-id' ? '<MCP_SESSION_ID>' : headers[name]]));
const parseBody = text => { try { return JSON.parse(text); } catch { return text; } };

/** Server-sent events as frames: comments, ids, event names and parsed data, in order. */
export function sseFrames(text) {
  return text.split(/\r?\n\r?\n/).filter(block => block.length).map(block => {
    const frame = {};
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':')) { (frame.comments ??= []).push(line.slice(1).trim()); continue; }
      const at = line.indexOf(':');
      const field = at === -1 ? line : line.slice(0, at);
      const value = at === -1 ? '' : line.slice(at + 1).replace(/^ /, '');
      if (field === 'data') frame.data = frame.data === undefined ? value : `${frame.data}\n${value}`;
      else frame[field] = value;
    }
    if (frame.data !== undefined) frame.data = parseBody(frame.data);
    return frame;
  });
}

// ---------------------------------------------------------------- MCP over Streamable HTTP
const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
function mcpResponse(res) {
  const sse = String(res.headers['content-type'] ?? '').includes('text/event-stream');
  const messages = sse ? sseFrames(res.body).filter(f => f.data !== undefined).map(f => f.data) : res.body ? [parseBody(res.body)] : [];
  return { status: res.status, framing: sse ? 'sse' : res.body ? 'json' : 'empty', messages };
}
async function mcpSession(url, protocolVersion = '2025-06-18') {
  let next = 0;
  const init = await request(url, { method: 'POST', headers: MCP_HEADERS, body: JSON.stringify({ jsonrpc: '2.0', id: ++next, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 'cos-golden', version: '1' } } }) });
  const initialized = mcpResponse(init);
  const negotiated = initialized.messages[0]?.result?.protocolVersion;
  const session = init.headers['mcp-session-id'];
  const headers = { ...MCP_HEADERS, ...(session ? { 'mcp-session-id': session } : {}), ...(negotiated ? { 'mcp-protocol-version': negotiated } : {}) };
  await request(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  const rpc = async (method, params, timeoutMs = 120_000, extraHeaders = {}) => {
    const res = await request(url, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify({ jsonrpc: '2.0', id: ++next, method, params }), timeoutMs });
    return mcpResponse(res);
  };
  return { init: { ...initialized, headers: keptHeaders(init.headers) }, rpc, headers };
}
async function listTools(url) {
  const { rpc } = await mcpSession(url);
  return (await rpc('tools/list', {})).messages[0]?.result?.tools ?? [];
}

// ---------------------------------------------------------------- fixture and seed
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
function seedProject(dir, { second = false } = {}) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  if (second) {
    fs.writeFileSync(path.join(dir, 'other.txt'), 'second root file\n');
    return;
  }
  fs.writeFileSync(path.join(dir, 'README.md'), '# Fixture project\n\nGolden corpus fixture.\n');
  fs.writeFileSync(path.join(dir, 'src', 'greeting.txt'), 'hello world\nsecond line\n');
  fs.writeFileSync(path.join(dir, 'src', 'notes.md'), 'The needle phrase is quartz-lantern.\n');
  fs.writeFileSync(path.join(dir, 'src', 'data.bin'), Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
  fs.writeFileSync(path.join(dir, 'src', 'pixel.png'), Buffer.from(TINY_PNG, 'base64'));
  fs.writeFileSync(path.join(dir, 'src', 'large.txt'), Array.from({ length: 12_000 }, (_, i) => `line ${String(i + 1).padStart(5, '0')} ${'x'.repeat(40)}`).join('\n') + '\n');
  spawnSync('git', ['init', '-q'], { cwd: dir });
}

function seedConfig(variant, dirs) {
  const caps = { browse: true, search: true, read: true, metadata: true, create: true, edit: true, move: true, deleteFile: true,
    command: true, screen: false, control: false, clipboardRead: false, clipboardWrite: false, ...variant.caps };
  return {
    roots: [{ name: 'project', path: dirs.project }, ...(variant.secondRoot ? [{ name: 'second', path: dirs.second }] : [])],
    capabilities: caps,
    readOnly: variant.readOnly ?? false,
    multiAgent: { enabled: variant.multiAgent ?? false, allowUnattributedCalls: variant.allowUnattributed ?? false },
    tunnel: { kind: 'manual', tunnelId: '', desktopTunnelId: '', pluginsTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: false, autoConnect: true, language: 'en', lastSeenVersion: version, turnNotifications: false,
      keepAwake: false, startAtLogin: false, localAppUsage: false, autoRefreshPlugins: false, autoRefreshPluginsAsked: true,
      ...(variant.finishTool ? { finishTool: true } : {}) },
    controlApi: { enabled: true, allowActions: variant.allowActions ?? false }
  };
}

// ---------------------------------------------------------------- writing
function writeCase(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
}

async function recordVariant(variant) {
  const runDir = path.join(scratch, variant.id);
  fs.rmSync(runDir, { recursive: true, force: true });
  const dirs = { run: runDir, profile: path.join(runDir, 'profile'), project: path.join(runDir, 'project'), second: path.join(runDir, 'second') };
  fs.mkdirSync(dirs.profile, { recursive: true });
  seedProject(dirs.project);
  if (variant.secondRoot) seedProject(dirs.second, { second: true });
  const config = seedConfig(variant, dirs);
  fs.writeFileSync(path.join(dirs.profile, 'config.json'), JSON.stringify(config, null, 2));

  const target = variant.desktopTarget ? await openTargetWindow() : null;
  const inst = launchApp({ binary, profile: dirs.profile, logFile: path.join(runDir, 'stdout.log') });
  const variantOut = path.join(outDir, variant.id);
  fs.rmSync(variantOut, { recursive: true, force: true });
  let count = 0;
  try {
    await waitReady(inst, listTools);
    // Startup work (plugin scan, update check against the dead proxy) settles before recording.
    await pause(3000);
    const tokens = Object.entries(inst.urls).filter(([, url]) => url).map(([surface, url]) => [new URL(url).pathname.split('/').pop(), `<MCP_TOKEN:${surface}>`]);
    const mcpPort = new URL(inst.urls.core).port;
    const normalize = createNormalizer({
      secrets: [[inst.token, '<CONTROL_TOKEN>'], ...tokens],
      paths: [[dirs.project, '<PROJECT>'], [dirs.second, '<SECOND>'], [dirs.profile, '<PROFILE>'], [dirs.run, '<RUN>'],
        [repo, '<REPO>'], [os.tmpdir(), '<TMP>'], [os.homedir(), '<HOME>']],
      ports: [[mcpPort, '<MCP_PORT>'], [String(inst.port), '<API_PORT>']],
      numbers: [[String(inst.pid), '<PID>'], ...(target ? [[String(target.hwnd), '<HWND>'], [String(target.pid), '<TARGET_PID>']] : [])]
    });
    const save = (rel, record, options) => { writeCase(path.join(variantOut, rel), normalize(record, options)); count++; };
    save('config.json', { config });

    const ctx = { inst, dirs, target, save, mcpSession, request, sseFrames, keptHeaders, parseBody, shapeOf };
    for (const phase of variant.phases) await phase(ctx);
  } finally {
    await stopApp(inst);
    await target?.close();
  }
  return count;
}

const selected = VARIANTS.filter(variant => !only || only.includes(variant.id));
if (only && selected.length !== only.length) { console.error(`unknown variant in ${only.join(',')}; known: ${VARIANTS.map(v => v.id).join(', ')}`); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });
const summary = {};
let failed = false;
for (const variant of selected) {
  const started = Date.now();
  try {
    summary[variant.id] = await recordVariant(variant);
    console.log(`${variant.id}: ${summary[variant.id]} files in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (error) {
    failed = true;
    console.error(`${variant.id}: FAILED ${error.stack ?? error.message}`);
  }
}
if (!only) {
  writeCase(path.join(outDir, 'manifest.json'), {
    app: binary ? 'binary' : 'electron', appVersion: version, platform: process.platform, arch: process.arch,
    variants: VARIANTS.map(v => ({ id: v.id, about: v.about }))
  });
}
if (failed) process.exitCode = 1;
