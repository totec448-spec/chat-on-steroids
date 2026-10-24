// Launch adapter for the golden recorder: starts one isolated, offline instance of the app under
// test, waits until it serves, finds its MCP URLs, and stops it by killing its process tree.
// The app under test is either the Electron build in out/ (default) or any executable that meets
// the contract in rust/golden/README.md ("--binary").
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(repo, 'package.json'));
const WebSocket = require('ws');

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

// Outbound HTTP goes to a dead local proxy, exactly as scripts/bench.mjs does. An online build
// older than the latest release downloads that release and can install it over the user's real
// installation on a graceful quit, so the app is never online and never quit gracefully.
const OFFLINE = { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' };

/**
 * Plain HTTP so the recorder sees status, headers and bytes exactly as sent. A server that
 * answers and closes before reading the whole body resets the socket under the write; the
 * answer it sent is still the result. A reset with no answer is reported as `transportError`.
 */
export function request(url, { method = 'GET', headers: given = {}, body, timeoutMs = 30_000 } = {}) {
  const named = name => Object.keys(given).some(h => h.toLowerCase() === name);
  const headers = body !== undefined && !named('content-length') && !named('transfer-encoding')
    ? { ...given, 'content-length': String(Buffer.byteLength(body)) } : given;
  return new Promise((resolve, reject) => {
    let response = null;
    const chunks = [];
    const settle = () => {
      resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') });
    };
    const req = http.request(url, { method, headers, timeout: timeoutMs, setHost: !Object.keys(headers).some(h => h.toLowerCase() === 'host') }, res => {
      response = res;
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', settle);
      res.on('error', () => settle());
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error(`${method} ${url} timed out`), { code: 'TIMEOUT' })));
    req.on('error', error => {
      if (response) return;
      if (error.code === 'ECONNRESET' || error.code === 'EPIPE') resolve({ status: null, headers: {}, body: '', transportError: error.code });
      else reject(error);
    });
    // With "Expect: 100-continue" the body goes only after the server asks for it, so a refusal
    // decided from the headers alone is read without racing a reset.
    if (Object.entries(headers).some(([name, value]) => name.toLowerCase() === 'expect' && /100-continue/i.test(value))) {
      req.on('continue', () => req.end(body));
      req.flushHeaders();
    } else req.end(body);
  });
}

function processTable() {
  const script = 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress';
  const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return JSON.parse(out.stdout);
}
function processTree(rootPid) {
  const table = processTable();
  const tree = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of table) if (tree.has(p.ParentProcessId) && !tree.has(p.ProcessId)) { tree.add(p.ProcessId); grew = true; }
  }
  return [...tree];
}
/** Forced kill of the whole tree by pid. Never by image name, never a graceful quit. */
export async function killTree(rootPid, knownPids = []) {
  const pids = [...new Set([rootPid, ...knownPids, ...(alive(rootPid) ? processTree(rootPid) : [])])];
  spawnSync('taskkill', ['/PID', String(rootPid), '/T', '/F'], { stdio: 'ignore' });
  for (let i = 0; i < 40 && pids.some(alive); i++) await pause(250);
  for (const pid of pids.filter(alive)) spawnSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' });
  for (let i = 0; i < 20 && pids.some(alive); i++) await pause(250);
  const left = pids.filter(alive);
  if (left.length) throw new Error(`processes still alive after kill: ${left.join(', ')}`);
}

export function controlFiles(profile) {
  const dir = path.join(profile, 'control-api');
  return {
    endpoint: JSON.parse(fs.readFileSync(path.join(dir, 'endpoint.json'), 'utf8')),
    token: fs.readFileSync(path.join(dir, 'token'), 'utf8').trim()
  };
}

async function cdpConnect(profile) {
  const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
  const targets = JSON.parse((await request(`http://127.0.0.1:${port}/json/list`)).body);
  const page = targets.find(t => t.type === 'page' && t.url.startsWith('file:') && t.url.includes('renderer/index.html'));
  if (!page) throw new Error('renderer page not listed yet');
  const socket = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let next = 0; const pending = new Map();
  socket.on('message', raw => { const msg = JSON.parse(String(raw)); pending.get(msg.id)?.(msg); pending.delete(msg.id); });
  socket.on('error', () => {});
  const evaluate = expression => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, msg => msg.result?.exceptionDetails || msg.error ? reject(new Error(`evaluate failed: ${JSON.stringify(msg.error ?? msg.result.exceptionDetails).slice(0, 300)}`)) : resolve(msg.result.result.value));
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  return { evaluate, close: () => socket.close() };
}

/**
 * The per-start MCP URLs. A replacement app writes them to `<profile>/mcp-urls.json` as
 * `{ "core": url, "desktop": url, "plugins": url }` when COS_MCP_URLS_FILE names that file; the
 * Electron app shows them only to its renderer, read here over the DevTools protocol.
 */
async function discoverUrls(inst) {
  const file = path.join(inst.profile, 'mcp-urls.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!fs.existsSync(path.join(inst.profile, 'DevToolsActivePort'))) return null;
  inst.cdp ??= await cdpConnect(inst.profile);
  const status = await inst.cdp.evaluate("window.api.getState().then(r => r?.ok ? { state: r.data.status.state, surfaces: r.data.status.surfaces.map(s => [s.id, s.localUrl ?? null]) } : null)");
  if (!status || status.state !== 'connected') return null;
  const urls = Object.fromEntries(status.surfaces);
  return urls.core ? urls : null;
}

/**
 * Starts the app on an isolated profile. `binary` is null for the Electron build in out/, else
 * the path of the executable to run.
 */
export function launchApp({ binary, profile, logFile }) {
  const electron = binary ? null : require('electron');
  const exe = binary ? path.resolve(binary) : electron;
  const args = [...(binary ? [] : [repo]), `--user-data-dir=${profile}`, '--lang=en-US', '--remote-debugging-port=0'];
  const env = { ...process.env, CLF_BRIDGE_PORTS: '0', COS_MCP_URLS_FILE: path.join(profile, 'mcp-urls.json'), ...OFFLINE };
  delete env.ELECTRON_RUN_AS_NODE;
  const log = fs.openSync(logFile, 'a');
  const child = spawn(exe, args, { cwd: repo, env, stdio: ['ignore', log, log], windowsHide: false });
  fs.closeSync(log);
  return { child, pid: child.pid, profile, cdp: null, urls: null };
}

/** Ready: our pid owns the control API, /v1/health answers, and Core answers tools/list. */
export async function waitReady(inst, mcpList, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = 'starting';
  while (Date.now() < deadline) {
    if (!alive(inst.pid)) throw new Error('the app exited during startup');
    try {
      const { endpoint, token } = controlFiles(inst.profile);
      if (endpoint.pid !== inst.pid) throw new Error(`control API pid ${endpoint.pid} is not ours (${inst.pid})`);
      const health = await request(`http://127.0.0.1:${endpoint.port}/v1/health`, { headers: { authorization: `Bearer ${token}` } });
      if (health.status !== 200) throw new Error(`health ${health.status}`);
      inst.urls = await discoverUrls(inst);
      if (!inst.urls) throw new Error('MCP URLs not published yet');
      const tools = await mcpList(inst.urls.core);
      if (!tools.length) throw new Error('Core lists no tools');
      inst.port = endpoint.port;
      inst.token = token;
      return;
    } catch (error) { last = error.message; }
    await pause(250);
  }
  throw new Error(`not ready after ${timeoutMs / 1000}s: ${last}`);
}

export async function stopApp(inst) {
  inst.cdp?.close();
  await killTree(inst.pid);
}

// The desktop tools see only a window this script creates, addressed by its own handle. The
// window never takes focus, and nothing lists, observes or sends input to any other window.
const TARGET_TITLE = 'cos-golden-target';
const TARGET_WINDOW = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition 'public class GoldenTarget : System.Windows.Forms.Form { protected override bool ShowWithoutActivation { get { return true; } } }'
$f = New-Object GoldenTarget; $f.Text = '${TARGET_TITLE}'; $f.StartPosition = 'Manual'; $f.SetBounds(40, 40, 480, 320)
$b = New-Object System.Windows.Forms.Button; $b.Text = 'golden-button'; $b.SetBounds(20, 20, 160, 40); $f.Controls.Add($b)
$t = New-Object System.Windows.Forms.TextBox; $t.Name = 'golden-field'; $t.Text = 'golden-text'; $t.SetBounds(20, 80, 200, 24); $f.Controls.Add($t)
[System.Windows.Forms.Application]::Run($f)`;

let koffiApi = null;
function user32() {
  if (koffiApi) return koffiApi;
  const koffi = require('koffi');
  const lib = koffi.load('user32.dll');
  const EnumProc = koffi.proto('bool __stdcall GoldenEnumWindowsProc(void *hwnd, intptr_t lParam)');
  koffiApi = {
    koffi, EnumProc,
    EnumWindows: lib.func('bool __stdcall EnumWindows(GoldenEnumWindowsProc *cb, intptr_t lParam)'),
    GetWindowThreadProcessId: lib.func('uint32 __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)'),
    IsWindowVisible: lib.func('bool __stdcall IsWindowVisible(void *hwnd)')
  };
  return koffiApi;
}
/** Reads only the owner pid of each top-level window, never its title or contents. */
function visibleWindowOf(pid) {
  const { koffi, EnumProc, EnumWindows, GetWindowThreadProcessId, IsWindowVisible } = user32();
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

export async function openTargetWindow() {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', TARGET_WINDOW], { stdio: 'ignore', windowsHide: true });
  let hwnd = null;
  for (let i = 0; i < 150 && hwnd === null; i++) { hwnd = visibleWindowOf(child.pid); if (hwnd === null) await pause(100); }
  if (hwnd === null) { await killTree(child.pid); throw new Error('the golden target window never appeared'); }
  return { pid: child.pid, hwnd, close: () => killTree(child.pid) };
}
