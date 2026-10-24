// Records only the control API phases of the golden corpus (`api`, `sse`, `rateLimit` on
// `base`, `actions` on `actions`) from a binary, with the recorder's own phases, launcher and
// normalizer. Unlike scripts/golden/record.mjs it needs no MCP endpoint: ready means the
// launched pid owns the control API and /v1/health answers.
//
//   node rust/crates/cos-control-api/tests/golden/record-api.mjs --binary <exe> --out <dir>
//   node scripts/golden/diff.mjs rust/golden/base/api <dir>/base/api
//
// Run it from the repository root. Each launch is offline and is stopped by killing its tree.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, pause, repo, request, stopApp } from '../../../../../scripts/golden/app.mjs';
import { createNormalizer, shapeOf } from '../../../../../scripts/golden/normalize.mjs';
import { VARIANTS } from '../../../../../scripts/golden/variants.mjs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i === -1 ? fallback : argv[i + 1]; };
const binary = opt('binary', null);
const outDir = path.resolve(opt('out', ''));
if (!binary || !opt('out', null)) { console.error('usage: record-api.mjs --binary <exe> --out <dir>'); process.exit(2); }
const PHASES = { base: ['api', 'sse', 'rateLimit'], actions: ['actions'] };
const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;

// Copied from record.mjs, which runs a whole recording when imported.
const HEADERS_KEPT = ['content-type', 'cache-control', 'allow', 'retry-after', 'connection', 'mcp-session-id', 'www-authenticate', 'x-accel-buffering'];
const keptHeaders = headers => Object.fromEntries(HEADERS_KEPT.filter(name => headers[name] !== undefined).map(name => [name, name === 'mcp-session-id' ? '<MCP_SESSION_ID>' : headers[name]]));
const parseBody = text => { try { return JSON.parse(text); } catch { return text; } };
function sseFrames(text) {
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
function seedConfig(variant, dirs) {
  return {
    roots: [{ name: 'project', path: dirs.project }],
    capabilities: { browse: true, search: true, read: true, metadata: true, create: true, edit: true, move: true, deleteFile: true,
      command: true, screen: false, control: false, clipboardRead: false, clipboardWrite: false },
    readOnly: false,
    multiAgent: { enabled: false, allowUnattributedCalls: false },
    tunnel: { kind: 'manual', tunnelId: '', desktopTunnelId: '', pluginsTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: false, autoConnect: true, language: 'en', lastSeenVersion: version, turnNotifications: false,
      keepAwake: false, startAtLogin: false, localAppUsage: false, autoRefreshPlugins: false, autoRefreshPluginsAsked: true },
    controlApi: { enabled: true, allowActions: variant.allowActions ?? false }
  };
}

async function waitForApi(inst, timeoutMs = 30_000) {
  const dir = path.join(inst.profile, 'control-api');
  const deadline = Date.now() + timeoutMs;
  let last = 'starting';
  while (Date.now() < deadline) {
    try {
      const endpoint = JSON.parse(fs.readFileSync(path.join(dir, 'endpoint.json'), 'utf8'));
      const token = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
      if (endpoint.pid !== inst.pid) throw new Error(`control API pid ${endpoint.pid} is not ours (${inst.pid})`);
      const health = await request(`http://127.0.0.1:${endpoint.port}/v1/health`, { headers: { authorization: `Bearer ${token}` } });
      if (health.status !== 200) throw new Error(`health ${health.status}`);
      inst.port = endpoint.port;
      inst.token = token;
      return;
    } catch (error) { last = error.message; }
    await pause(100);
  }
  throw new Error(`control API not ready after ${timeoutMs / 1000}s: ${last}`);
}

for (const variant of VARIANTS.filter(v => PHASES[v.id])) {
  const runDir = path.join(repo, '.tmp', 'golden-scratch', `api-${path.basename(outDir)}`, variant.id);
  fs.rmSync(runDir, { recursive: true, force: true });
  const dirs = { run: runDir, profile: path.join(runDir, 'profile'), project: path.join(runDir, 'project'), second: path.join(runDir, 'second') };
  fs.mkdirSync(dirs.profile, { recursive: true });
  fs.mkdirSync(dirs.project, { recursive: true });
  const config = seedConfig(variant, dirs);
  fs.writeFileSync(path.join(dirs.profile, 'config.json'), JSON.stringify(config, null, 2));
  const variantOut = path.join(outDir, variant.id);
  fs.rmSync(variantOut, { recursive: true, force: true });
  const inst = launchApp({ binary, profile: dirs.profile, logFile: path.join(runDir, 'stdout.log') });
  let count = 0;
  try {
    await waitForApi(inst);
    const normalize = createNormalizer({
      secrets: [[inst.token, '<CONTROL_TOKEN>']],
      paths: [[dirs.project, '<PROJECT>'], [dirs.second, '<SECOND>'], [dirs.profile, '<PROFILE>'], [dirs.run, '<RUN>'],
        [repo, '<REPO>'], [os.tmpdir(), '<TMP>'], [os.homedir(), '<HOME>']],
      ports: [[String(inst.port), '<API_PORT>']],
      numbers: [[String(inst.pid), '<PID>']]
    });
    const save = (rel, record, options) => {
      const file = path.join(variantOut, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(normalize(record, options), null, 2) + '\n');
      count++;
    };
    const ctx = { inst, dirs, target: null, save, request, sseFrames, keptHeaders, parseBody, shapeOf };
    for (const phase of variant.phases.filter(phase => PHASES[variant.id].includes(phase.name))) await phase(ctx);
  } finally {
    await stopApp(inst);
  }
  console.log(`${variant.id}: ${count} files`);
}
