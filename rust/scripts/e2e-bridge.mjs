#!/usr/bin/env node
/**
 * End-to-end check of the Rust bridge against the unchanged extension (protocol 14): the
 * extension in this checkout pairs with cos-headless, opens its wake socket, and its stored
 * token is the one the bridge accepts.
 *
 * Isolation: cos-headless listens on an OS-assigned port (CLF_BRIDGE_PORTS=0) that no extension
 * scans, and Chromium sends every request, loopback included (`<-loopback>`), through a proxy
 * owned by this script. The proxy maps 127.0.0.1:8765, the first port the extension scans, to
 * the Rust bridge and refuses everything else. So the test extension can reach only the Rust
 * bridge, and no other extension or app on this machine can reach it. Both processes are
 * stopped by killing their process trees.
 *
 *   node rust/scripts/e2e-bridge.mjs --binary <cos-headless.exe> --chromium <chrome.exe> --out <dir>
 *
 * `--out` must not exist yet. It receives both profiles, the copied extension and report.json.
 * Exit code 0 is pass, 1 is fail or error, 2 is a usage error.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argument = name => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const [binary, chromium, out] = ['binary', 'chromium', 'out'].map(argument);
if (!binary || !chromium || !out) {
  console.error('usage: node rust/scripts/e2e-bridge.mjs --binary <cos-headless.exe> --chromium <chrome.exe> --out <dir>');
  process.exit(2);
}
if (fs.existsSync(out)) {
  console.error(`${out} already exists; pass a new folder`);
  process.exit(2);
}
const run = path.resolve(out);
const cosProfile = path.join(run, 'cos-profile');
const chromeProfile = path.join(run, 'chrome-profile');
const extension = path.join(run, 'extension');
const extensionVersion = JSON.parse(fs.readFileSync(path.join(repo, 'extension', 'manifest.json'), 'utf8')).version;
const appVersion = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
fs.mkdirSync(cosProfile, { recursive: true });
const report = { checks: [], proxied: [] };
const started = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (what, probe, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await probe(); if (value) return value; await sleep(200); }
  throw new Error(`timed out: ${what}`);
};
const tree = dir => {
  const hash = createHash('sha256');
  const visit = (current, relative = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path.join(current, entry.name), name);
      else { hash.update(name); hash.update(fs.readFileSync(path.join(current, entry.name))); }
    }
  };
  visit(dir);
  return hash.digest('hex').slice(0, 16);
};
const killTree = pid => spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
const logLines = () => { try { return fs.readFileSync(path.join(cosProfile, 'app.log'), 'utf8').split(/\r?\n/); } catch { return []; } };
const get = (port, route, headers = {}) => new Promise((resolve, reject) => {
  const request = http.request({ host: '127.0.0.1', port, path: route, headers }, response => {
    let body = '';
    response.on('data', chunk => { body += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, body: body ? JSON.parse(body) : null }));
  });
  request.on('error', reject);
  request.end();
});

let bridgePort = 0;
const proxy = http.createServer((request, response) => {
  const target = (() => { try { return new URL(request.url); } catch { return null; } })();
  const mapped = target && target.hostname === '127.0.0.1' && target.port === '8765';
  report.proxied.push(`${request.method} ${target ? target.host + target.pathname : request.url} ${mapped ? '-> bridge' : 'refused'}`);
  if (!mapped) { response.writeHead(502); response.end(); return; }
  const upstream = http.request({ host: '127.0.0.1', port: bridgePort, method: request.method, path: target.pathname + target.search, headers: request.headers }, reply => {
    response.writeHead(reply.statusCode, reply.headers);
    reply.pipe(response);
  });
  upstream.on('error', () => { response.writeHead(502); response.end(); });
  request.pipe(upstream);
});
proxy.on('connect', (request, socket, head) => {
  const mapped = request.url === '127.0.0.1:8765';
  report.proxied.push(`CONNECT ${request.url} ${mapped ? '-> bridge' : 'refused'}`);
  if (!mapped) { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
  const upstream = net.connect(bridgePort, '127.0.0.1', () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    upstream.write(head);
    upstream.pipe(socket); socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

/** The token the extension stored, read from its own service worker over DevTools. */
async function extensionToken() {
  const [devtoolsPort, devtoolsPath] = fs.readFileSync(path.join(chromeProfile, 'DevToolsActivePort'), 'utf8').split('\n');
  const cdp = new WebSocket(`ws://127.0.0.1:${devtoolsPort}${devtoolsPath}`);
  await new Promise((resolve, reject) => {
    cdp.addEventListener('open', resolve, { once: true });
    cdp.addEventListener('error', () => reject(new Error('DevTools refused the connection')), { once: true });
  });
  let id = 0;
  const pending = new Map();
  cdp.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const send = (method, params = {}, sessionId) => new Promise(resolve => {
    pending.set(++id, resolve);
    cdp.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  try {
    for (const target of (await send('Target.getTargets')).result.targetInfos.filter(target => target.type === 'service_worker')) {
      const session = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).result.sessionId;
      const probe = await send('Runtime.evaluate', { expression: 'globalThis.chrome?.storage ? chrome.runtime.getManifest().version : null', returnByValue: true }, session);
      if (probe.result?.result?.value !== extensionVersion) continue;
      report.extensionWorker = target.url;
      const stored = await send('Runtime.evaluate', { expression: 'chrome.storage.local.get("token").then(all => all.token)', awaitPromise: true, returnByValue: true }, session);
      const token = stored.result?.result?.value;
      if (typeof token !== 'string') throw new Error('no token in the extension storage: ' + JSON.stringify(stored).slice(0, 400));
      return token;
    }
    throw new Error('the extension worker was not found');
  } finally {
    cdp.close();
  }
}

try {
  fs.cpSync(path.join(repo, 'extension'), extension, { recursive: true });
  report.extensionTree = { checkout: tree(path.join(repo, 'extension')), loaded: tree(extension) };
  if (report.extensionTree.checkout !== report.extensionTree.loaded) throw new Error('the loaded extension differs from the checkout');
  fs.writeFileSync(path.join(cosProfile, 'config.json'), JSON.stringify({
    roots: [],
    capabilities: { browse: true, search: true, read: true, metadata: true, create: true, edit: true, move: true, deleteFile: true,
      command: true, screen: false, control: false, clipboardRead: false, clipboardWrite: false },
    readOnly: false,
    multiAgent: { enabled: false, allowUnattributedCalls: false },
    tunnel: { kind: 'manual', tunnelId: '', desktopTunnelId: '', pluginsTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: false, autoConnect: false, language: 'en', lastSeenVersion: appVersion, turnNotifications: false,
      keepAwake: false, startAtLogin: false, localAppUsage: false, autoRefreshPlugins: false, autoRefreshPluginsAsked: true },
    controlApi: { enabled: true, allowActions: false }
  }, null, 2));

  const cos = spawn(binary, [`--user-data-dir=${cosProfile}`], {
    env: { ...process.env, CLF_BRIDGE_PORTS: '0', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NODE_USE_ENV_PROXY: '1' },
    stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true
  });
  started.push(cos.pid);
  bridgePort = Number(await until('the bridge listens', () =>
    logLines().map(line => /bridge listening on 127\.0\.0\.1:(\d+)/.exec(line)?.[1]).find(Boolean)));
  report.bridgePort = bridgePort;
  report.helloBefore = (await get(bridgePort, '/hello')).body;

  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = proxy.address().port;
  const chrome = spawn(chromium, [
    `--user-data-dir=${chromeProfile}`, '--remote-debugging-port=0', '--headless=new', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', `--proxy-server=http://127.0.0.1:${proxyPort}`,
    '--proxy-bypass-list=<-loopback>', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
  started.push(chrome.pid);

  const provisioned = await until('pairing', () => logLines().find(line => line.includes('bridge: browser extension connected and provisioned')), 45000);
  const authenticated = await until('the wake socket', () => logLines().find(line => line.includes('bridge: browser wake channel authenticated')), 45000);
  report.helloAfter = (await get(bridgePort, '/hello')).body;
  const secrets = fs.readFileSync(path.join(cosProfile, 'secrets.bin'));
  report.secretsBin = { bytes: secrets.length, prefix: secrets.subarray(0, 3).toString('latin1') };

  const token = await extensionToken();
  const authed = await get(bridgePort, '/status', { authorization: `Bearer ${token}`, 'x-extension-protocol': '14' });
  const forged = await get(bridgePort, '/status', { authorization: `Bearer ${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`, 'x-extension-protocol': '14' });
  report.tokenCheck = { length: token.length, extensionToken: authed, forgedToken: forged };

  const endpoint = JSON.parse(fs.readFileSync(path.join(cosProfile, 'control-api', 'endpoint.json'), 'utf8'));
  const controlToken = fs.readFileSync(path.join(cosProfile, 'control-api', 'token'), 'utf8').trim();
  report.v1StatusBridge = (await get(endpoint.port, '/v1/status', { authorization: `Bearer ${controlToken}` })).body.bridge;

  report.logLines = logLines().filter(line => line.includes('bridge'));
  report.checks.push(`pairing logged: ${provisioned.trim()}`);
  report.checks.push(`wake logged: ${authenticated.trim()}`);
  const ok = report.helloBefore.paired === false && report.helloAfter.paired === true && report.helloAfter.compatible === null &&
    report.secretsBin.prefix === 'v10' && authed.status === 404 && authed.body.error === 'not_found' && forged.status === 401 &&
    report.v1StatusBridge.paired === true && report.v1StatusBridge.present === true &&
    report.v1StatusBridge.extensionVersion === extensionVersion &&
    report.proxied.some(line => line.startsWith('CONNECT 127.0.0.1:8765'));
  report.result = ok ? 'pass' : 'fail';
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  report.result = `error: ${error.message}`;
  report.logLines = logLines().filter(line => line.includes('bridge'));
  process.exitCode = 1;
} finally {
  for (const pid of started.reverse()) killTree(pid);
  proxy.close();
  report.proxied = [...new Set(report.proxied)];
  fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
