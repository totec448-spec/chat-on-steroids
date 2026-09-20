import { app, BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { initConfigPath, loadConfig, getConfig } from '../../src/main/config.js';
import { initSecretsPath, getSecret } from '../../src/main/secrets.js';
import { initSessionStore } from '../../src/main/session/store.js';
import { initDurableStore, flushDurable } from '../../src/main/durable.js';
import { startBridge, stopBridge, shutdownBridge, bridgePort, bridgeStatus, browserWakeConnected,
  setBrowserOpener } from '../../src/main/bridge.js';
import { registerIpc } from '../../src/main/ipc.js';

const run = process.argv[2];
app.setPath('userData', path.join(run, 'runtime'));
const report: { checks: string[]; unavailable: number[]; error?: string; extensionStatus?: unknown } = { checks: [], unavailable: [] };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => T | Promise<T>, label: string, timeout = 15000): Promise<T> {
  const end = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < end) {
    try { const value = await read(); if (value) return value; } catch (error) { last = error; }
    await delay(100);
  }
  throw new Error(`${label}: ${last instanceof Error ? last.message : 'timed out'}`);
}

void app.whenReady().then(async () => {
  let win: BrowserWindow | undefined;
  let blocker: http.Server | undefined;
  let chrome: ReturnType<typeof spawn> | undefined;
  let cdpSocket: WebSocket | undefined;
  try {
    delete process.env.CLF_BRIDGE_PORTS;
    const data = app.getPath('userData');
    initConfigPath(data); initSecretsPath(data); initSessionStore(data); initDurableStore(data);
    await loadConfig();
    assert.equal(getConfig().ui.browserBridgePort, 'auto');
    // No app-driven browser launches or provider tasks belong to this smoke fixture.
    setBrowserOpener(async () => {});
    assert.ok(await startBridge());
    registerIpc(() => win ?? null, () => {});
    win = new BrowserWindow({ show: false, width: 1100, height: 900,
      webPreferences: { preload: path.resolve('out/preload/index.js'), sandbox: true, contextIsolation: true } });
    await win.loadFile(path.resolve('out/renderer/index.html'));
    const js = (code: string) => win!.webContents.executeJavaScript(code);
    const state = async () => (await js('window.api.getState()')).data;
    await until(() => js('!!document.getElementById("browserBridgePort")?.options.length'), 'Renderer');
    await delay(300);
    const choose = async (value: number | 'auto') => {
      await js(`(() => { const select = document.getElementById('browserBridgePort'); select.focus(); select.value = ${JSON.stringify(String(value))}; select.dispatchEvent(new Event('change', {bubbles:true})); })()`);
      return until(async () => {
        const current = await state();
        const selected = await js('document.getElementById("browserBridgePort").value');
        return current.config.ui.browserBridgePort === value || selected !== String(value) ? current : null;
      }, `Save ${value}`);
    };
    report.checks.push('Fresh config defaults to Auto; production renderer and preload/Settings IPC loaded.');
    const available: number[] = [];
    for (const candidate of [8765, 8766, 8767, 8768, 8769]) {
      const previous = getConfig().ui.browserBridgePort; const old = bridgePort();
      const result = await choose(candidate);
      if (result.config.ui.browserBridgePort === candidate) {
        assert.equal(bridgePort(), candidate); available.push(candidate);
        assert.equal((await loadConfig()).ui.browserBridgePort, candidate);
      } else {
        assert.equal(getConfig().ui.browserBridgePort, previous); assert.equal(bridgePort(), old);
        report.unavailable.push(candidate);
      }
    }
    assert.ok(available.length >= 2, 'Need two free supported ports; no existing listener is displaced.');
    report.checks.push(`Fixed choices persisted and bound: ${available.join(', ')}. Occupied choices rejected without changing the listener.`);
    await choose('auto'); assert.equal(getConfig().ui.browserBridgePort, 'auto');
    const legacy = structuredClone(getConfig()); delete legacy.ui.browserBridgePort;
    await fs.writeFile(path.join(data, 'config.json'), JSON.stringify(legacy));
    await loadConfig(); assert.equal(getConfig().ui.browserBridgePort, 'auto');
    report.checks.push('Auto and legacy config use the first free candidate.');
    const [first, second] = available;
    await choose(first); await stopBridge();
    blocker = http.createServer(); await new Promise<void>(resolve => blocker!.listen(first, '127.0.0.1', resolve));
    await loadConfig(); assert.equal(await startBridge(), null);
    assert.equal(getConfig().ui.browserBridgePort, first);
    await until(async () => (await js('document.getElementById("bridgeState").textContent')).includes('EADDRINUSE'), 'Startup error UI');
    await choose(second); assert.equal(bridgePort(), second); assert.equal((await bridgeStatus()).error, null);
    await new Promise<void>(resolve => blocker!.close(() => resolve())); blocker = undefined;
    report.checks.push('Restart lifecycle with an occupied saved port stays stopped, preserves choice, shows EADDRINUSE in Setup, and recovers through Settings.');
    await stopBridge(); process.env.CLF_BRIDGE_PORTS = '0'; await startBridge();
    await until(() => js('document.getElementById("browserBridgePort").disabled'), 'Override selector');
    const rejected = await js(`(async () => { const {data} = await window.api.getState(); return window.api.saveSettings({...data.config, ui:{...data.config.ui,browserBridgePort:${first}}}, data.config); })()`);
    assert.equal(rejected.ok, false); assert.match(rejected.error, /CLF_BRIDGE_PORTS/);
    report.checks.push('Real environment override controls listener, disables selector, and rejects explicit Settings IPC edits.');
    await stopBridge(); delete process.env.CLF_BRIDGE_PORTS; await startBridge();

    // Use only ports this fixture successfully owned. Never discover the installed bridge.
    const extension = path.join(run, 'extension'); await fs.cp('extension', extension, { recursive: true });
    const source = await fs.readFile(path.join(extension, 'background.js'), 'utf8');
    // A test-only reference invokes the existing popup status handler in its worker context.
    // Discovery, pairing, maintenance and reconnection remain the production implementations.
    await fs.writeFile(path.join(extension, 'background.js'), source.replace(/const PORTS = \[[^\]]+\];/, `const PORTS = [${second}, ${first}];`) +
      '\nglobalThis.__cosPortSmokeStatus = () => HANDLERS.status();\n');
    const profile = path.join(run, 'chrome-profile');
    chrome = spawn(process.env.COS_TEST_CHROMIUM!, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--headless=new',
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, 'about:blank'],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    chrome.on('error', error => { report.error = error.message; });
    const active = await until(async () => {
      try { return (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n'); } catch { return null; }
    }, 'Chromium startup');
    cdpSocket = new WebSocket(`ws://127.0.0.1:${active![0]}${active![1]}`);
    await new Promise(resolve => cdpSocket!.once('open', resolve));
    let sequence = 0;
    const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
    cdpSocket.on('message', raw => {
      const message = JSON.parse(String(raw)); const request = pending.get(message.id);
      if (!request) return; pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
    });
    const cdp = (method: string, params = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
      const id = ++sequence; pending.set(id, { resolve, reject });
      cdpSocket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
    const sessionId = await until(async () => {
      for (const target of (await cdp('Target.getTargets')).targetInfos.filter((target: any) =>
        target.type === 'service_worker' && target.url.endsWith('/background.js'))) {
        const attached = (await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
        const name = await cdp('Runtime.evaluate', { expression: 'chrome.runtime.getManifest().name', returnByValue: true }, attached);
        if (name.result?.value === manifest.name) return attached;
        await cdp('Target.detachFromTarget', { sessionId: attached });
      }
      return null;
    }, 'Production extension worker');
    const extensionStatus = async () => {
      const result = await cdp('Runtime.evaluate', { expression: 'globalThis.__cosPortSmokeStatus?.()', awaitPromise: true, returnByValue: true }, sessionId);
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      report.extensionStatus = result.result?.value;
      return result.result?.value;
    };
    await until(async () => (await extensionStatus())?.paired, 'Extension pairing');
    await until(browserWakeConnected, 'Extension wake channel', 45000);
    const token = await getSecret('bridgeToken'); assert.ok(token);
    const switchedAt = Date.now();
    await choose(first); assert.equal(bridgePort(), first);
    // Observe the real transport, without invoking the extension's reconnect/refresh actions.
    await until(browserWakeConnected, 'Automatic extension reconnection', 45000);
    assert.equal(await getSecret('bridgeToken'), token);
    const connected = await extensionStatus(); assert.equal(connected.port, first); assert.equal(connected.paired, true);
    report.checks.push(`Production MV3 worker automatically rediscovered the switched port and reauthenticated its wake socket with the unchanged pairing token in ${Date.now() - switchedAt} ms. No signed-in/provider task used.`);
    await fs.writeFile(path.join(run, 'verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ run, ...report }, null, 2));
  } catch (error) {
    report.error = error instanceof Error ? error.stack : String(error);
    await fs.writeFile(path.join(run, 'failure.json'), JSON.stringify(report, null, 2));
    console.error(report.error); process.exitCode = 1;
  } finally {
    cdpSocket?.close(); chrome?.kill();
    if (blocker?.listening) await new Promise<void>(resolve => blocker!.close(() => resolve()));
    await shutdownBridge(); await flushDurable(); win?.destroy(); app.exit(process.exitCode ?? 0);
  }
});
