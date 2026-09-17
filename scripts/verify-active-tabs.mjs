/** Real Chromium background rendering, without attaching an observation debugger to the page. */
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const output = path.resolve('outputs/active-tabs'), run = path.join(output, randomUUID());
const extension = path.join(run, 'extension'), profile = path.join(run, 'profile');
await fs.mkdir(extension, { recursive: true });
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<title>Background rendering fixture</title><button onclick="requestAnimationFrame(()=>document.body.dataset.opened='true')">Open picker</button>
    <script>document.body.dataset.opened='false';let frames=0;function paint(){document.body.dataset.frames=String(++frames);requestAnimationFrame(paint)}paint();</script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const source = await fs.readFile('extension/active-tabs.js', 'utf8');
// Test-only origin substitution: no signed-in browser, production bridge or external page.
assert.match(source, /const valid = tab =>[\s\S]*?;\n/);
await fs.writeFile(path.join(extension, 'active-tabs.js'), source.replace(/const valid = tab =>[\s\S]*?;\n/,
  `const valid = tab => Number.isInteger(tab?.id) && typeof tab.url === 'string' && tab.url.startsWith(${JSON.stringify(base + '/')}) && !tab.pendingUrl;\n`));
await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Active tab isolated fixture', version: '1.0.0',
  permissions: ['debugger', 'tabs', 'storage', 'scripting'], host_permissions: [base + '/*'], background: { service_worker: 'fixture.js', type: 'module' } }));
await fs.writeFile(path.join(extension, 'fixture.js'), `import {createActiveTabs} from './active-tabs.js';
globalThis.activity=createActiveTabs(chrome);
chrome.debugger.onDetach.addListener(source=>void activity.detached(source));
chrome.tabs.onRemoved.addListener(id=>void activity.navigation(id));
chrome.runtime.onMessage.addListener((message,sender,reply)=>{(async()=>{
  const tabs=message.tabId?[await chrome.tabs.get(message.tabId)]:[];
  await activity.set('policy',tabs);reply({ok:true});
})().catch(error=>reply({error:String(error)}));return true;});`);
await fs.writeFile(path.join(extension, 'probe.html'), '<title>Extension fixture controller</title>');
const executable = process.env.COS_TEST_CHROMIUM || path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe');
const browser = spawn(executable, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--headless=new', '--no-first-run',
  '--no-default-browser-check', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label) {
  const end = Date.now() + 12000;
  let last;
  while (Date.now() < end) { try { const value = await read(); last = value; if (value) return value; } catch (error) { last = error.message; } await delay(100); }
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}
let connection, seq = 0;
const pending = new Map();
function cdp(method, params = {}, sessionId) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method} ${params.expression || ''}`)); }, 10000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    connection.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
let workerSession;
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression: `(async()=>(${expression}))()`, awaitPromise: true, returnByValue: true }, workerSession);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
const report = { run, checks: [] };
try {
  const endpoint = await until(async () => (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n'), 'Chrome startup');
  connection = new WebSocket(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
  await new Promise(resolve => connection.on('open', resolve));
  connection.on('message', raw => {
    const message = JSON.parse(raw), request = pending.get(message.id);
    if (request) { pending.delete(message.id); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result); }
  });
  const worker = await until(async () => (await cdp('Target.getTargets')).targetInfos.find(t => t.type === 'service_worker' && t.url.endsWith('/fixture.js')), 'Fixture worker');
  const controller = await cdp('Target.createTarget', { url: worker.url.replace('fixture.js', 'probe.html') });
  workerSession = (await cdp('Target.attachToTarget', { targetId: controller.targetId, flatten: true })).sessionId;
  await until(() => evaluate('Boolean(globalThis.chrome?.tabs?.create && chrome.scripting)'), 'Extension controller readiness');
  await evaluate(`(globalThis.work=await chrome.tabs.create({url:${JSON.stringify(base + '/work')},active:false}),
    globalThis.idle=await chrome.tabs.create({url:${JSON.stringify(base + '/idle')},active:false}),
    globalThis.sentinel=await chrome.tabs.create({url:${JSON.stringify(base + '/sentinel')},active:true}))`);
  const read = name => evaluate(`(await chrome.scripting.executeScript({target:{tabId:${name}.id},world:'MAIN',func:()=>({
    frames:Number(document.body.dataset.frames),opened:document.body.dataset.opened,visibility:document.visibilityState,focused:document.hasFocus()
  })}))[0].result`);
  await until(async () => (await read('work'))?.frames, 'Page hydration');
  await evaluate(`chrome.scripting.executeScript({target:{tabId:work.id},world:'MAIN',func:()=>document.querySelector('button').click()})`);
  await delay(700);
  report.before = await read('work');
  assert.equal(report.before.visibility, 'hidden');
  assert.equal(report.before.opened, 'false', 'Native animation callback must be suspended before the lease');
  const started = Date.now();
  const acquired = await evaluate(`chrome.runtime.sendMessage({tabId:work.id})`);
  assert.equal(acquired.ok, true, acquired.error);
  await until(async () => (await read('work')).opened === 'true', 'Picker animation resumed');
  report.resumeMs = Date.now() - started;
  report.during = await read('work');
  assert.equal(report.during.visibility, 'visible');
  assert.equal((await read('idle')).visibility, 'hidden');
  assert.equal(await evaluate(`(await chrome.tabs.query({active:true,currentWindow:true}))[0].id===sentinel.id`), true);
  report.checks.push('hidden native animation stalled before lease and resumed with focus emulation', 'idle neighbor stayed hidden', 'selected tab stayed on foreground sentinel');
  const released = await evaluate(`chrome.runtime.sendMessage({})`);
  assert.equal(released.ok, true, released.error);
  report.after = await read('work');
  assert.equal(report.after.visibility, 'hidden');
  assert.equal(await evaluate(`(await chrome.debugger.getTargets()).some(t=>t.tabId===work.id&&t.attached)`), false);
  report.checks.push('settled work released debugger and returned to hidden scheduling');
  report.ok = true;
  await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ ...report, error: error.stack }, null, 2));
  throw error;
} finally { connection?.close(); browser.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
