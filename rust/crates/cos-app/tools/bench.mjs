// Cold start of cos-app measured from outside, the way scripts/bench.mjs (branch bench/baseline)
// measures the Electron app: spawn() to a visible top-level window of the child pid, to an
// authenticated control API /v1/health answered by that pid, and to a Core MCP tools/list with
// at least one tool. Then, after the idle period, memory and process count of the process tree.
//
// usage (from the repository root):
//   node rust/crates/cos-app/tools/bench.mjs --exe rust/target/release/cos-app.exe --run <id>
//        [--cold 15] [--warm 0] [--idle 10] [--keep] [--quiet cargo.exe,rustc.exe] [-- app args...]
// --keep launches once, prints the pid and profile, and leaves the app running; --profile <dir>
// reuses an existing profile instead of seeding a fresh one.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
// koffi resolves from the nearest node_modules above the repository (run npm ci first).
const koffi = createRequire(path.join(repo, 'package.json'))('koffi');

const dash = process.argv.indexOf('--');
const argv = process.argv.slice(2, dash === -1 ? undefined : dash);
const appArgs = dash === -1 ? [] : process.argv.slice(dash + 1);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i === -1 ? fallback : argv[i + 1]; };
const has = name => argv.includes(`--${name}`);
const exe = path.resolve(opt('exe', 'rust/target/release/cos-app.exe'));
const runId = opt('run', 'dev');
const cold = Number(opt('cold', 15));
const warm = Number(opt('warm', 0));
const idle = Number(opt('idle', 10));
const keep = has('keep');
const quietImages = opt('quiet', 'cargo.exe,rustc.exe').toLowerCase().split(',').filter(Boolean);
const outDir = path.join(repo, '.tmp', 'cos-app-bench', runId);
fs.mkdirSync(outDir, { recursive: true });
const samplesFile = path.join(outDir, 'samples.jsonl');
const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

koffi.load('winmm.dll').func('uint32 __stdcall timeBeginPeriod(uint32 ms)')(1);
const user32 = koffi.load('user32.dll');
const EnumProc = koffi.proto('bool __stdcall CosEnumWindowsProc(void *hwnd, intptr_t lParam)');
const EnumWindows = user32.func('bool __stdcall EnumWindows(CosEnumWindowsProc *cb, intptr_t lParam)');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *hwnd)');
// Reads only the owner pid of each top-level window, never its title or contents.
function visibleWindowOf(pid) {
  let found = null;
  const callback = koffi.register(hwnd => {
    if (!IsWindowVisible(hwnd)) return true;
    const owner = [0];
    GetWindowThreadProcessId(hwnd, owner);
    if (owner[0] === pid) found = Number(koffi.address(hwnd));
    return found === null;
  }, koffi.pointer(EnumProc));
  try { EnumWindows(callback, 0); } finally { koffi.unregister(callback); }
  return found;
}

function processTree(rootPid) {
  const script = `$p = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name | Select-Object ProcessId,ParentProcessId,Name;
$m = Get-CimInstance Win32_PerfRawData_PerfProc_Process -Property IDProcess,WorkingSet,WorkingSetPrivate,PrivateBytes | Select-Object IDProcess,WorkingSet,WorkingSetPrivate,PrivateBytes;
@{ procs = $p; mem = $m } | ConvertTo-Json -Depth 3 -Compress`;
  const table = JSON.parse(spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', maxBuffer: 64 << 20 }).stdout);
  const tree = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of table.procs) if (tree.has(p.ParentProcessId) && !tree.has(p.ProcessId)) { tree.add(p.ProcessId); grew = true; }
  }
  const members = table.procs.filter(p => tree.has(p.ProcessId));
  const mem = new Map(table.mem.map(m => [m.IDProcess, m]));
  const sum = (key, list = members) => list.reduce((total, p) => total + Number(mem.get(p.ProcessId)?.[key] ?? 0), 0) / 2 ** 20;
  const root = members.filter(p => p.ProcessId === rootPid);
  return {
    names: members.map(p => p.Name), privateWsMb: sum('WorkingSetPrivate'), wsMb: sum('WorkingSet'), privateMb: sum('PrivateBytes'),
    appPrivateWsMb: sum('WorkingSetPrivate', root), pids: members.map(p => p.ProcessId),
  };
}

async function cpuBusyPercent(ms = 1000) {
  const snap = () => os.cpus().reduce((t, c) => { const all = Object.values(c.times).reduce((a, b) => a + b, 0); return { idle: t.idle + c.times.idle, all: t.all + all }; }, { idle: 0, all: 0 });
  const a = snap(); await pause(ms); const b = snap();
  return Math.round(100 * (1 - (b.idle - a.idle) / (b.all - a.all)));
}
const quietSeen = () => [...new Set(spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout
  .split('\n').map(line => line.split('","')[0].replace(/^"/, '').toLowerCase()))].filter(name => quietImages.includes(name));
async function waitQuiet() {
  const t = performance.now();
  for (let seen = quietSeen(); seen.length; seen = quietSeen()) { console.error(`waiting: ${seen.join(', ')} running`); await pause(5000); }
  return Math.round((performance.now() - t) / 1000);
}

/** The same fixture profile scripts/bench.mjs seeds: one project root, manual tunnel, auto-connect, control API on. */
function seed(name) {
  const dir = path.join(outDir, 'profiles', name);
  fs.rmSync(dir, { recursive: true, force: true });
  const profile = path.join(dir, 'profile');
  const project = path.join(dir, 'project');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(project, 'README.md'), '# Fixture project\n\nBenchmark fixture.\n');
  fs.writeFileSync(path.join(project, 'src', 'notes.md'), 'The needle phrase is quartz-lantern.\n');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    roots: [{ name: 'project', path: project }],
    capabilities: { browse: true, search: true, read: true, metadata: true, create: true, edit: true, move: true,
      deleteFile: true, command: true, screen: false, control: false, clipboardRead: false, clipboardWrite: false },
    readOnly: false,
    tunnel: { kind: 'manual', tunnelId: '', desktopTunnelId: '', pluginsTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: true, autoConnect: true, language: 'en', lastSeenVersion: version, turnNotifications: false,
      keepAwake: false, startAtLogin: false, localAppUsage: false, autoRefreshPlugins: false, autoRefreshPluginsAsked: true },
    controlApi: { enabled: true, allowActions: false },
  }, null, 2));
  return { dir, profile, project };
}

const OFFLINE = { HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' };
function launch(seeded) {
  const urls = path.join(seeded.dir, 'mcp-urls.json');
  const env = { ...process.env, CLF_BRIDGE_PORTS: '0', COS_MCP_URLS_FILE: urls, COS_APP_AUTOMATION: '1', ...OFFLINE };
  const log = fs.openSync(path.join(seeded.dir, 'stdout.log'), 'a');
  const t0 = performance.now();
  const child = spawn(exe, [`--user-data-dir=${seeded.profile}`, ...appArgs], { env, stdio: ['ignore', log, log], detached: keep });
  fs.closeSync(log);
  return { child, pid: child.pid, t0, ...seeded, urls };
}

const agent = new http.Agent({ keepAlive: true });
function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, agent, timeout: 30_000 }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${url} timed out`)));
    req.on('error', reject);
    req.end(body);
  });
}
async function controlHealth(inst) {
  const dir = path.join(inst.profile, 'control-api');
  const endpoint = JSON.parse(fs.readFileSync(path.join(dir, 'endpoint.json'), 'utf8'));
  if (endpoint.pid !== inst.pid) return false;
  const token = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
  const res = await request(`http://127.0.0.1:${endpoint.port}/v1/health`, { headers: { authorization: `Bearer ${token}` } });
  return res.status === 200 && JSON.parse(res.body).pid === inst.pid;
}
export async function mcpConnect(url) {
  let session, protocol, next = 0;
  const rpc = async (method, params, notification = false) => {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(session ? { 'mcp-session-id': session } : {}), ...(protocol ? { 'mcp-protocol-version': protocol } : {}) };
    const id = notification ? undefined : ++next;
    const res = await request(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    session ??= res.headers['mcp-session-id'];
    if (res.status >= 400) throw new Error(`${method}: HTTP ${res.status} ${res.body.slice(0, 200)}`);
    if (notification) return;
    const messages = String(res.headers['content-type']).includes('text/event-stream')
      ? res.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
      : [JSON.parse(res.body)];
    const reply = messages.find(m => m.id === id);
    if (!reply || reply.error) throw new Error(`${method}: ${JSON.stringify(reply?.error ?? 'no reply')}`);
    return reply.result;
  };
  protocol = (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cos-app-bench', version: '1' } })).protocolVersion;
  await rpc('notifications/initialized', undefined, true);
  return { listTools: () => rpc('tools/list', {}), callTool: params => rpc('tools/call', params) };
}
async function toolsListed(inst) {
  const core = JSON.parse(fs.readFileSync(inst.urls, 'utf8')).core;
  if (!core) return false;
  inst.mcp ??= await mcpConnect(core);
  return (await inst.mcp.listTools()).tools.length > 0;
}

async function waitReady(inst, timeoutMs = 30_000) {
  const milestone = async (tickMs, probe) => {
    while (performance.now() - inst.t0 < timeoutMs) {
      if (!alive(inst.pid)) throw new Error('app exited during startup');
      try { if (await probe()) return Math.round((performance.now() - inst.t0) * 10) / 10; } catch {}
      await pause(tickMs);
    }
    return null;
  };
  const [window_ms, health_ms, tools_ms] = await Promise.all([
    milestone(5, async () => visibleWindowOf(inst.pid) !== null),
    milestone(10, () => controlHealth(inst)),
    milestone(10, () => toolsListed(inst)),
  ]);
  return { window_ms, health_ms, tools_ms };
}

async function stop(inst, pids = []) {
  spawnSync('taskkill', ['/PID', String(inst.pid), '/T', '/F'], { stdio: 'ignore' });
  for (let i = 0; i < 40 && [inst.pid, ...pids].some(alive); i++) await pause(100);
  for (const pid of pids.filter(alive)) spawnSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' });
}

const stat = values => {
  const v = values.filter(x => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return { n: v.length, median: +(v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2).toFixed(1), min: +v[0].toFixed(1), max: +v[v.length - 1].toFixed(1) };
};

if (keep) {
  const reuse = opt('profile');
  const inst = launch(reuse ? { dir: path.dirname(path.resolve(reuse)), profile: path.resolve(reuse) } : seed(`keep-${Date.now()}`));
  const ready = await waitReady(inst);
  console.log(JSON.stringify({ pid: inst.pid, profile: inst.profile, urls: inst.urls, ...ready }));
  inst.child.unref();
  process.exit(0);
}

async function sample(phase, i, seeded) {
  const waited_s = await waitQuiet();
  const load_pct = await cpuBusyPercent();
  const inst = launch(seeded);
  let row = { phase, i, waited_s, load_pct };
  try {
    row = { ...row, ...(await waitReady(inst)) };
    if (idle > 0) {
      await pause(idle * 1000);
      const tree = processTree(inst.pid);
      row = { ...row, ...tree, processes: tree.pids.length };
    }
    await stop(inst, row.pids ?? []);
  } catch (error) {
    row.error = error.message;
    await stop(inst);
  }
  // A compiler that started during the sample is recorded; the summary reports how many did.
  row.quietDuring = quietSeen();
  fs.appendFileSync(samplesFile, JSON.stringify({ at: new Date().toISOString(), run: runId, ...row }) + '\n');
  console.log(JSON.stringify(row));
  await pause(500);
  return row;
}

const rows = [];
for (let i = 0; i < cold; i++) rows.push(await sample('cold', i, seed(`cold-${i}`)));
if (warm > 0) {
  // Warm: the same profile again, after one unrecorded launch has created its files.
  const seeded = seed('warm');
  await sample('prime', 0, seeded);
  for (let i = 0; i < warm; i++) rows.push(await sample('warm', i, seeded));
}
const phaseSummary = list => ({
  n: list.length,
  window_ms: stat(list.map(r => r.window_ms)), health_ms: stat(list.map(r => r.health_ms)), tools_ms: stat(list.map(r => r.tools_ms)),
  privateWsMb: stat(list.map(r => r.privateWsMb)), wsMb: stat(list.map(r => r.wsMb)), privateMb: stat(list.map(r => r.privateMb)),
  processes: stat(list.map(r => r.processes)), load_pct: stat(list.map(r => r.load_pct)),
  failures: list.filter(r => r.error || r.window_ms == null || r.health_ms == null || r.tools_ms == null).length,
  compilerSeenDuring: list.filter(r => r.quietDuring?.length).length,
});
const summary = {
  run: runId, exe, exeMb: +(fs.statSync(exe).size / 2 ** 20).toFixed(1),
  cold: phaseSummary(rows.filter(r => r.phase === 'cold')),
  ...(warm > 0 ? { warm: phaseSummary(rows.filter(r => r.phase === 'warm')) } : {}),
  processNames: rows.find(r => r.names)?.names,
};
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
