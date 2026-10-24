#!/usr/bin/env node
/**
 * End-to-end check of direct browser control (E2.8) against the Rust binary: the unchanged
 * extension in a throwaway headless Chromium pairs with cos-headless, and the Desktop MCP
 * surface's browser_* tools drive a local test page through it, the same path the TypeScript
 * `scripts/verify-browser-control.mjs` proves with its fixture broker.
 *
 * Isolation, as in `e2e-bridge.mjs`: cos-headless listens on an OS-assigned bridge port
 * (CLF_BRIDGE_PORTS=0) that no extension scans, and Chromium sends every request, loopback
 * included, through a proxy this script owns. The proxy maps 127.0.0.1:8765 to the Rust bridge
 * and the test page's own host to this script's page server, and refuses everything else. The
 * tools act only on tabs inside that Chromium. Nothing sends OS input; every click and key is
 * the extension's DevTools input inside the headless browser. Both processes are stopped by
 * killing their process trees.
 *
 *   node rust/scripts/e2e-browser-control.mjs --binary <cos-headless.exe> --chromium <chrome.exe> --out <dir>
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
  console.error('usage: node rust/scripts/e2e-browser-control.mjs --binary <cos-headless.exe> --chromium <chrome.exe> --out <dir>');
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
const project = path.join(run, 'project');
const appVersion = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
fs.mkdirSync(cosProfile, { recursive: true });
fs.mkdirSync(project, { recursive: true });
const report = { checks: [], calls: [], proxied: [] };
const started = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (what, probe, ms = 30000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { const value = await probe(); if (value) return value; } catch (error) { last = error; }
    await sleep(200);
  }
  throw new Error(`timed out: ${what}${last ? ` (${last.message})` : ''}`);
};
const check = (ok, what, detail) => {
  if (!ok) throw new Error(`${what}: ${JSON.stringify(detail)?.slice(0, 2000)}`);
  report.checks.push(what);
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

const page = `<!doctype html><meta charset=utf-8><title>Browser Control Fixture</title>
<h1>Background fixture</h1><button id=click>Increment counter</button><output id=count>0</output>
<label>Notes<textarea id=notes></textarea></label>
<label>Choice<select id=choice><option value=one>One</option><option value=two>Two</option></select></label>
<script>let count=0;document.querySelector('#click').onclick=()=>{document.querySelector('#count').textContent=++count;console.log('fixture-click',count);fetch('/api',{method:'POST',body:'fixture-body'})};</script>`;
const pages = http.createServer((request, response) => {
  if (request.url === '/api') {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, fixture: 'network-body' }));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(request.url === '/fixture' ? page : '<!doctype html><title>Second page</title><h1>Second page</h1>');
});

let bridgePort = 0;
let pagesHost = '';
const upstreamOf = host => host === '127.0.0.1:8765' ? bridgePort : host === pagesHost ? pages.address().port : null;
const proxy = http.createServer((request, response) => {
  const target = (() => { try { return new URL(request.url); } catch { return null; } })();
  const port = target ? upstreamOf(target.host) : null;
  report.proxied.push(`${request.method} ${target ? target.host + target.pathname : request.url} ${port ? 'forwarded' : 'refused'}`);
  if (!port) { response.writeHead(502); response.end(); return; }
  const upstream = http.request({ host: '127.0.0.1', port, method: request.method, path: target.pathname + target.search, headers: request.headers }, reply => {
    response.writeHead(reply.statusCode, reply.headers);
    reply.pipe(response);
  });
  upstream.on('error', () => { response.writeHead(502); response.end(); });
  request.pipe(upstream);
});
proxy.on('connect', (request, socket, head) => {
  const port = upstreamOf(request.url);
  report.proxied.push(`CONNECT ${request.url} ${port ? 'forwarded' : 'refused'}`);
  if (!port) { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
  const upstream = net.connect(port, '127.0.0.1', () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    upstream.write(head);
    upstream.pipe(socket); socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

/** One MCP session on the Desktop surface (Streamable HTTP, SSE or JSON answers). */
async function desktopSession(url) {
  let next = 0;
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const post = async body => {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await response.text();
    if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) return text ? JSON.parse(text) : null;
    const data = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim());
    return data.length ? JSON.parse(data.at(-1)) : null;
  };
  const init = await post({ jsonrpc: '2.0', id: ++next, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cos-e2e', version: '1' } } });
  headers['mcp-protocol-version'] = init.result.protocolVersion;
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return {
    list: async () => (await post({ jsonrpc: '2.0', id: ++next, method: 'tools/list', params: {} })).result.tools,
    call: async (name, args) => {
      const startedAt = Date.now();
      const answer = await post({ jsonrpc: '2.0', id: ++next, method: 'tools/call', params: { name, arguments: args } });
      const result = answer.result;
      const text = result.content.find(part => part.type === 'text')?.text;
      report.calls.push({ tool: name, action: args.action, ms: Date.now() - startedAt, error: result.isError ? text : undefined });
      return result;
    }
  };
}

try {
  fs.cpSync(path.join(repo, 'extension'), extension, { recursive: true });
  report.extensionTree = { checkout: tree(path.join(repo, 'extension')), loaded: tree(extension) };
  if (report.extensionTree.checkout !== report.extensionTree.loaded) throw new Error('the loaded extension differs from the checkout');
  fs.writeFileSync(path.join(cosProfile, 'config.json'), JSON.stringify({
    roots: [{ name: 'project', path: project }],
    capabilities: { browse: true, search: true, read: true, metadata: true, create: false, edit: false, move: false, deleteFile: false,
      command: false, screen: true, control: true, clipboardRead: false, clipboardWrite: false },
    readOnly: false,
    multiAgent: { enabled: false, allowUnattributedCalls: true },
    tunnel: { kind: 'manual', tunnelId: '', desktopTunnelId: '', pluginsTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: false, autoConnect: true, language: 'en', lastSeenVersion: appVersion, turnNotifications: false,
      keepAwake: false, startAtLogin: false, localAppUsage: false, autoRefreshPlugins: false, autoRefreshPluginsAsked: true },
    controlApi: { enabled: true, allowActions: false }
  }, null, 2));

  const urlsFile = path.join(cosProfile, 'mcp-urls.json');
  const cos = spawn(binary, [`--user-data-dir=${cosProfile}`], {
    env: { ...process.env, CLF_BRIDGE_PORTS: '0', COS_MCP_URLS_FILE: urlsFile, HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NODE_USE_ENV_PROXY: '1' },
    stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true
  });
  started.push(cos.pid);
  bridgePort = Number(await until('the bridge listens', () =>
    logLines().map(line => /bridge listening on 127\.0\.0\.1:(\d+)/.exec(line)?.[1]).find(Boolean)));
  const urls = await until('the MCP URLs', () => { try { const u = JSON.parse(fs.readFileSync(urlsFile, 'utf8')); return u.desktop ? u : null; } catch { return null; } });
  report.bridgePort = bridgePort;
  const desktop = await desktopSession(urls.desktop);
  const listed = (await desktop.list()).map(tool => tool.name).filter(name => name.startsWith('browser_'));
  check(listed.join() === 'browser_tabs,browser_snapshot,browser_screenshot,browser_navigate,browser_action,browser_evaluate,browser_console,browser_network',
    'the Desktop surface lists the eight browser tools in TypeScript order', listed);
  const offline = await desktop.call('browser_tabs', { action: 'list' });
  check(!offline.isError && offline.structuredContent.value.message === 'Open Chrome with the companion extension connected.',
    'with no browser connected, listing says so instead of guessing', offline);

  await new Promise(resolve => pages.listen(0, '127.0.0.1', resolve));
  pagesHost = `127.0.0.1:${pages.address().port}`;
  const base = `http://${pagesHost}`;
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const chrome = spawn(chromium, [
    `--user-data-dir=${chromeProfile}`, '--remote-debugging-port=0', '--headless=new', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', `--proxy-server=http://127.0.0.1:${proxy.address().port}`,
    '--proxy-bypass-list=<-loopback>', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
  started.push(chrome.pid);
  await until('pairing', () => logLines().find(line => line.includes('bridge: browser extension connected and provisioned')), 45000);
  await until('the wake socket', () => logLines().find(line => line.includes('bridge: browser wake channel authenticated')), 45000);
  report.checks.push('the unchanged extension paired with cos-headless and opened its wake socket');

  const list = await until('the extension polls for browser work', async () => {
    const result = await desktop.call('browser_tabs', { action: 'list' });
    return !result.isError && result.structuredContent.value.tabs?.length ? result : null;
  }, 45000);
  const browserId = list.structuredContent.value.browserId ?? list.structuredContent.value.browsers?.[0]?.id;
  report.firstList = list.structuredContent.value;
  check(list.structuredContent.value.tabs.some(tab => tab.url === 'about:blank'), 'browser_tabs lists the throwaway browser\'s tabs', list.structuredContent.value);

  const created = await desktop.call('browser_tabs', { action: 'new', url: `${base}/fixture` });
  check(!created.isError, 'browser_tabs new opens the test page in the background', created);
  const tabId = created.structuredContent.value.created?.tabId ?? created.structuredContent.value.tabId;
  check(typeof tabId === 'string' && /^[a-f\d-]{36}:\d+$/i.test(tabId), 'the new tab has a tab handle', created.structuredContent.value);

  const snapshot = async () => until('a snapshot of the test page', async () => {
    const result = await desktop.call('browser_snapshot', { tabId, maxNodes: 300, maxChars: 16000 });
    return !result.isError && result.structuredContent.value?.text?.includes('Background fixture') && result.structuredContent.value.pageId ? result.structuredContent.value : null;
  });
  const refFor = (snap, name) => /^\s*\[([^\]]+)\]/.exec(snap.text.split('\n').find(line => /^\s*\[/.test(line) && line.includes(name)) ?? '')?.[1];
  let snap = await snapshot();
  check(refFor(snap, 'Increment counter'), 'browser_snapshot returns refs and a pageId for the attached tab', snap);

  const clicked = await desktop.call('browser_action', { tabId, pageId: snap.pageId, action: 'click', ref: refFor(snap, 'Increment counter') });
  check(!clicked.isError, 'browser_action clicks a ref', clicked);
  const filled = await desktop.call('browser_action', { tabId, pageId: snap.pageId, action: 'fill', ref: refFor(snap, 'Notes'), text: 'Hello from Rust' });
  check(!filled.isError, 'browser_action fills a textarea', filled);
  const selected = await desktop.call('browser_action', { tabId, pageId: snap.pageId, action: 'select', ref: refFor(snap, 'Choice'), values: ['two'] });
  check(!selected.isError, 'browser_action selects an option', selected);
  const evaluated = await desktop.call('browser_evaluate', { tabId, pageId: snap.pageId,
    expression: '({count:document.querySelector("#count").textContent,notes:document.querySelector("#notes").value,choice:document.querySelector("#choice").value})' });
  const state = evaluated.structuredContent?.value?.value ?? evaluated.structuredContent?.value;
  check(!evaluated.isError && state.count === '1' && state.notes === 'Hello from Rust' && state.choice === 'two',
    'browser_evaluate reads the page state the actions produced', evaluated.structuredContent);

  const consoleRead = await until('the click\'s console message', async () => {
    const result = await desktop.call('browser_console', { tabId });
    return !result.isError && JSON.stringify(result.structuredContent).includes('fixture-click') ? result : null;
  });
  check(consoleRead, 'browser_console returns the page\'s console message', consoleRead.structuredContent);
  const network = await until('the click\'s request', async () => {
    const result = await desktop.call('browser_network', { tabId, filter: '/api' });
    return !result.isError && JSON.stringify(result.structuredContent).includes('/api') ? result : null;
  });
  check(network, 'browser_network returns the page\'s request', network.structuredContent);

  const shot = await desktop.call('browser_screenshot', { tabId });
  const image = shot.content.find(part => part.type === 'image');
  check(!shot.isError && image && ['image/png', 'image/jpeg'].includes(image.mimeType) && image.data.length > 100 &&
    !JSON.stringify(shot.structuredContent).includes(image.data.slice(0, 64)),
  'browser_screenshot returns one validated native image block', { isError: shot.isError, mimeType: image?.mimeType, bytes: image?.data.length });

  const navigated = await desktop.call('browser_navigate', { tabId, pageId: snap.pageId, action: 'url', url: `${base}/second` });
  check(!navigated.isError, 'browser_navigate accepts an HTTP URL', navigated);
  const second = await until('the second page', async () => {
    const result = await desktop.call('browser_snapshot', { tabId });
    return !result.isError && result.structuredContent.value?.text?.includes('Second page') ? result : null;
  });
  check(second, 'the tab shows the navigated page', second.structuredContent.value.text);
  const stale = await desktop.call('browser_action', { tabId, pageId: snap.pageId, action: 'click', ref: refFor(snap, 'Increment counter') });
  check(stale.isError, 'input against the old pageId is refused after navigation', stale.content[0].text);

  const closed = await desktop.call('browser_tabs', { action: 'close', tabId });
  check(!closed.isError, 'browser_tabs close closes the test tab', closed);
  const after = await desktop.call('browser_tabs', { action: 'list', browserId });
  check(!after.structuredContent.value.tabs.some(tab => tab.tabId === tabId), 'the closed tab is gone from the list', after.structuredContent.value);

  report.proxiedRefused = [...new Set(report.proxied.filter(line => line.endsWith('refused')))];
  report.result = 'pass';
  process.exitCode = 0;
} catch (error) {
  report.result = `error: ${error.message}`;
  report.logLines = logLines().filter(line => /bridge|tool browser_/.test(line)).slice(-60);
  process.exitCode = 1;
} finally {
  for (const pid of started.reverse()) killTree(pid);
  proxy.close();
  pages.close();
  report.proxied = [...new Set(report.proxied)];
  fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: report.result, checks: report.checks, calls: report.calls.length, proxiedRefused: report.proxiedRefused }, null, 2));
}
