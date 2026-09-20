import http from 'node:http';
import { APP_VERSION, BRIDGE_PROTOCOL } from '../src/main/version.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as ports from '../src/main/bridge-ports.js';
import type { BrowserBridgePort } from '../src/shared/browser-bridge.js';
import { makeTempDir, removeTempDir } from './helpers.js';

vi.mock('electron', () => ({ safeStorage: {
  isAsyncEncryptionAvailable: async () => true,
  getSelectedStorageBackend: () => 'unknown',
  encryptStringAsync: async (value: string) => Buffer.from(value),
  decryptStringAsync: async (value: Buffer) => ({ result: value.toString(), shouldReEncrypt: false })
}, clipboard: {}, shell: {} }));
vi.mock('../src/main/browser-startup.js', () => ({ wakeBrowserUrl: async () => {} }));

const { defaultConfig, getConfig, initConfigPath, saveConfig, updateConfig, loadConfig } = await import('../src/main/config.js');
const { initSecretsPath, resetSecretsCacheForTests, setSecret, getSecret } = await import('../src/main/secrets.js');
const { initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { initDurableStore, flushDurable } = await import('../src/main/durable.js');
const { startBridge, stopBridge, shutdownBridge, resetBridgeForTests, bridgePort, bridgeStatus,
  publishBridgePortChange } = await import('../src/main/bridge.js');
let dir: string;
let candidates: readonly number[];
const occupied: http.Server[] = [];

beforeEach(async () => {
  dir = await makeTempDir('cos-port-lifecycle-');
  initConfigPath(dir); initSecretsPath(dir); resetSecretsCacheForTests();
  initSessionStore(dir); initDurableStore(dir); resetBridgeForTests();
  await saveConfig(defaultConfig());
  await setSecret('bridgeToken', 'port-switch-fixture');
  // All socket tests use ephemeral ports. Never discover or contact an installed app.
  candidates = [0];
  vi.spyOn(ports, 'bridgePortSelection').mockImplementation(() => ({ candidates, overridden: false }));
  await startBridge();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await stopBridge();
  for (const server of occupied.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  await flushDurable(); resetSessionStoreForTests();
  await removeTempDir(dir);
});

async function occupy(): Promise<number> {
  const server = http.createServer(); occupied.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}
const change = (browserBridgePort: BrowserBridgePort) => updateConfig(config => ({
  ...config, ui: { ...config.ui, browserBridgePort }
}), undefined, publishBridgePortChange);
async function status(port = bridgePort()!): Promise<number> {
  return (await fetch(`http://127.0.0.1:${port}/status`, { headers: { Origin: 'chrome-extension://fixture', Authorization: 'Bearer port-switch-fixture', 'X-Extension-Protocol': String(BRIDGE_PROTOCOL), 'X-Extension-Version': APP_VERSION } })).status;
}

it('rejects an occupied target without publishing config or disturbing the old listener', async () => {
  const old = bridgePort(); const config = getConfig(); const disk = await fs.readFile(path.join(dir, 'config.json'), 'utf8');
  candidates = [await occupy()];
  await expect(change(8767)).rejects.toThrow(/EADDRINUSE/);
  expect(getConfig()).toBe(config); expect(bridgePort()).toBe(old);
  expect(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).toBe(disk);
  expect(await status()).toBe(200); expect((await bridgeStatus()).error).toBeNull();
});

it('switches after persistence, retaining pairing and clearing old browser presence', async () => {
  await setSecret('bridgeToken', 'port-switch-fixture');
  const old = bridgePort()!;
  await change(8767);
  expect(bridgePort()).not.toBe(old);
  expect((await loadConfig()).ui.browserBridgePort).toBe(8767);
  expect(await getSecret('bridgeToken')).toBe('port-switch-fixture');
  expect(await bridgeStatus()).toMatchObject({ running: true, paired: true, present: false, error: null });
  expect(await status()).toBe(200);
  await expect(status(old)).rejects.toThrow();
});

it('reuses its current port and respects Auto order before considering later candidates', async () => {
  const old = bridgePort()!;
  candidates = [old]; await change(8767); expect(bridgePort()).toBe(old);
  candidates = [await occupy(), old, 0]; await change('auto'); expect(bridgePort()).toBe(old);
  candidates = [0, old]; await change(8768); expect(bridgePort()).not.toBe(old);
});

it('keeps a prepared listener gated and releases it on configuration write failure', async () => {
  const old = bridgePort()!; const config = getConfig(); let preparedPort = 0;
  const listen = http.Server.prototype.listen;
  vi.spyOn(http.Server.prototype, 'listen').mockImplementation(function (this: http.Server, ...args: any[]) {
    this.once('listening', () => { preparedPort = (this.address() as { port: number }).port; });
    return (listen as any).apply(this, args);
  } as any);
  const rename = fs.rename;
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (to === path.join(dir, 'config.json')) {
      expect(preparedPort).not.toBe(old);
      expect(await status(preparedPort)).toBe(503);
      expect(await status(old)).toBe(200);
      throw new Error('fixture disk failure');
    }
    return rename(from, to);
  });
  await expect(change(8767)).rejects.toThrow('fixture disk failure');
  expect(getConfig()).toBe(config); expect(bridgePort()).toBe(old);
  await expect(status(preparedPort)).rejects.toThrow();
});

it('serializes overlapping changes against the latest committed configuration', async () => {
  const seen: Array<BrowserBridgePort | undefined> = [];
  const changes = [8767, 8768, 'auto'] as const;
  await Promise.all(changes.map(browserBridgePort => updateConfig(config => {
    seen.push(config.ui.browserBridgePort);
    return { ...config, ui: { ...config.ui, browserBridgePort } };
  }, undefined, publishBridgePortChange)));
  expect(seen).toEqual(['auto', 8767, 8768]);
  expect(getConfig().ui.browserBridgePort).toBe('auto'); expect(await status()).toBe(200);
});

it('cancels preparation before persistence when shutdown wins the bind boundary', async () => {
  const config = getConfig(); const listen = http.Server.prototype.listen; let stopping: Promise<void> | undefined;
  vi.spyOn(http.Server.prototype, 'listen').mockImplementation(function (this: http.Server, ...args: any[]) {
    this.once('listening', () => { stopping = shutdownBridge(); });
    return (listen as any).apply(this, args);
  } as any);
  await expect(change(8767)).rejects.toThrow(/cancelled/);
  await stopping;
  expect(getConfig()).toBe(config); expect(bridgePort()).toBeNull();
  expect(await startBridge()).toBeNull();
});

it('does not resurrect the bridge if shutdown starts during config publication', async () => {
  const rename = fs.rename; let stopping: Promise<void> | undefined;
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (to === path.join(dir, 'config.json')) stopping = shutdownBridge();
    return rename(from, to);
  });
  await change(8767); await stopping;
  expect(getConfig().ui.browserBridgePort).toBe(8767); expect(bridgePort()).toBeNull();
});

it('keeps an unavailable saved choice on startup and clears the error after an explicit free choice', async () => {
  await stopBridge();
  await saveConfig({ ...getConfig(), ui: { ...getConfig().ui, browserBridgePort: 8767 } });
  candidates = [await occupy()];
  expect(await startBridge()).toBeNull();
  expect(getConfig().ui.browserBridgePort).toBe(8767);
  expect(await bridgeStatus()).toMatchObject({ running: false, port: null, error: expect.stringContaining('EADDRINUSE') });
  candidates = [0]; await change('auto');
  expect(await bridgeStatus()).toMatchObject({ running: true, error: null });
});

it('preserves a live wake socket on rejection and reconnects with the same token after switching', async () => {
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${bridgePort()}/wake`, { origin: 'chrome-extension://fixture' });
    await once(socket, 'open');
    const authenticated = once(socket, 'message'); socket.send('port-switch-fixture');
    expect((await authenticated)[0].toString()).toBe('wake'); return socket;
  };
  const socket = await connect();
  try {
    candidates = [await occupy()]; await expect(change(8767)).rejects.toThrow('EADDRINUSE');
    expect(socket.readyState).toBe(WebSocket.OPEN);
    candidates = [0]; const closed = once(socket, 'close'); await change(8767); await closed;
    const replacement = await connect(); replacement.terminate();
  } finally { socket.terminate(); }
});
