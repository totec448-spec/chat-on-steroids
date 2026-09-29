/**
 * The local control API over real loopback HTTP: who may call it, what it answers, and that its
 * status projection can never carry a secret an owner happens to hold.
 */

import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PluginSnapshot } from '../src/shared/plugins.js';
import type { BridgeStatus, ConnectionStatus, UpdateStatus } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: () => '', getVersion: vi.fn(() => '0.0.0'), getAppPath: () => process.cwd(), isPackaged: false },
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  },
  BrowserWindow: class {},
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => '') },
  nativeTheme: { themeSource: 'system' }
}));

const { initConfigPath } = await import('../src/main/config.js');
const { initSecretsPath } = await import('../src/main/secrets.js');
const controlApi = await import('../src/main/control-api.js');

let dir: string;

beforeAll(async () => {
  dir = await makeTempDir('clf-control-api-');
  initConfigPath(dir);
  initSecretsPath(dir);
  controlApi.initControlApiPath(dir);
});

afterEach(async () => {
  await controlApi.stopControlApi();
});

afterAll(async () => {
  await controlApi.shutdownControlApi();
  await removeTempDir(dir);
});

async function readEndpoint() {
  const endpoint = JSON.parse(await fs.readFile(path.join(dir, 'control-api', 'endpoint.json'), 'utf8'));
  const token = (await fs.readFile(path.join(dir, 'control-api', 'token'), 'utf8')).trim();
  return { ...endpoint, token } as { port: number; pid: number; protocol: number; token: string };
}

function request(
  port: number,
  route: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method: options.method ?? 'GET', headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = text;
        try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
        resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

describe('local control API listener', () => {
  it('publishes its port and a per-launch token only while running', async () => {
    await controlApi.startControlApi();
    const first = await readEndpoint();
    expect(first).toMatchObject({ protocol: 1, pid: process.pid });
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(controlApi.controlApiPort()).toBe(first.port);

    await controlApi.stopControlApi();
    expect(controlApi.controlApiPort()).toBeNull();
    await expect(fs.access(path.join(dir, 'control-api', 'endpoint.json'))).rejects.toThrow();
    await expect(fs.access(path.join(dir, 'control-api', 'token'))).rejects.toThrow();
    await expect(request(first.port, '/v1/health')).rejects.toThrow();

    await controlApi.startControlApi();
    const second = await readEndpoint();
    expect(second.token).not.toBe(first.token);
  });

  it('starting twice keeps one listener', async () => {
    await controlApi.startControlApi();
    const { port } = await readEndpoint();
    await controlApi.startControlApi();
    expect(controlApi.controlApiPort()).toBe(port);
  });

  it('answers only an authenticated local caller with no Origin and its own Host', async () => {
    await controlApi.startControlApi();
    const { port, token } = await readEndpoint();
    const auth = { authorization: `Bearer ${token}` };

    expect((await request(port, '/v1/health')).status).toBe(401);
    expect((await request(port, '/v1/health', { headers: { authorization: `Bearer ${token.slice(1)}x` } })).status).toBe(401);
    expect((await request(port, '/v1/health', { headers: { authorization: token } })).status).toBe(401);
    // An Origin is refused before authentication, so a page learns nothing even with a token.
    const fromPage = await request(port, '/v1/health', { headers: { ...auth, origin: 'https://chatgpt.com' } });
    expect(fromPage.status).toBe(403);
    expect(fromPage.headers['access-control-allow-origin']).toBeUndefined();
    expect((await request(port, '/v1/health', { headers: { ...auth, origin: 'chrome-extension://abc' } })).status).toBe(403);
    expect((await request(port, '/v1/health', { headers: { ...auth, host: 'attacker.example' } })).status).toBe(403);
    expect((await request(port, '/v1/health', { headers: { ...auth, host: `127.0.0.1:${port + 1}` } })).status).toBe(403);

    expect((await request(port, '/v1/health', { headers: { ...auth, host: `localhost:${port}` } })).status).toBe(200);
    const health = await request(port, '/v1/health', { headers: auth });
    expect(health.status).toBe(200);
    expect(health.headers['cache-control']).toBe('no-store');
    expect(health.body).toMatchObject({ ok: true, pid: process.pid });
    expect(typeof health.body.uptimeSeconds).toBe('number');
  });

  it('is read-only: GET without a body, known routes only', async () => {
    await controlApi.startControlApi();
    const { port, token } = await readEndpoint();
    const auth = { authorization: `Bearer ${token}` };

    const post = await request(port, '/v1/status', { method: 'POST', headers: auth });
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('GET');
    const withBody = { ...auth, 'content-type': 'application/json', 'content-length': '2' };
    expect((await request(port, '/v1/status', { headers: withBody, body: '{}' })).status).toBe(413);
    // Refused from the declared length, before anything is buffered.
    const large = 'x'.repeat(1024 * 1024);
    const oversized = { ...auth, 'content-type': 'application/json', 'content-length': String(large.length) };
    expect((await request(port, '/v1/status', { headers: oversized, body: large })).status).toBe(413);
    expect((await request(port, '/v1/nothing', { headers: auth })).status).toBe(404);
    expect((await request(port, '/v1/sessions/not-a-session-id-at-all!', { headers: auth })).status).toBe(404);
    const health = await request(port, '/v1/health', { headers: auth });
    expect(health.body).toMatchObject({
      protocol: 1,
      routes: ['/v1/health', '/v1/status', '/v1/sessions', '/v1/sessions/{id}', '/v1/sessions/{id}/events', '/v1/inputs', '/v1/agents', '/v1/log']
    });
  });

  it('serves status from the live owners without a secret path or token', async () => {
    await controlApi.startControlApi();
    const { port, token } = await readEndpoint();
    const status = await request(port, '/v1/status', { headers: { authorization: `Bearer ${token}` } });
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      connection: { state: 'disconnected' },
      bridge: { running: false },
      toolCalls: { running: 0, inFlightMcpRequests: 0 }
    });
    expect(JSON.stringify(status.body)).not.toContain(token);
  });

  it('answers a failure in the owner behind a route with a plain 500 that names nothing', async () => {
    await controlApi.startControlApi();
    const { port, token } = await readEndpoint();
    // This suite never initialises the session store, so the owner behind the route throws.
    const failure = await request(port, '/v1/sessions', { headers: { authorization: `Bearer ${token}` } });
    expect(failure.status).toBe(500);
    expect(failure.body).toEqual({ error: 'internal_error' });
  });

  // Terminal for this module instance, so it runs last in the file.
  it('does not reopen once shutdown has begun, and removes its files', async () => {
    await controlApi.startControlApi();
    await controlApi.shutdownControlApi();
    await controlApi.startControlApi();
    expect(controlApi.controlApiPort()).toBeNull();
    await expect(fs.access(path.join(dir, 'control-api', 'endpoint.json'))).rejects.toThrow();
  });
});

describe('status projection', () => {
  // Built at run time: a literal here reads as a leaked key to secret scanners.
  const secretPath = randomBytes(32).toString('base64url');
  const pluginConfigSecret = `config-${randomBytes(9).toString('hex')}`;
  const connection: ConnectionStatus = {
    state: 'connected',
    detail: 'Connected',
    publicUrl: `https://tunnel.example/mcp/core/${secretPath}`,
    localUrl: `http://127.0.0.1:51234/mcp/core/${secretPath}`,
    handshakeAt: 1,
    lastRequestAt: 2,
    lastToolCallAt: 3,
    health: { pollErrors: 4, uptimeSeconds: 5, route: 'api.openai.com · direct', probe: 'ok', clientVersion: '1.2.3' },
    surfaces: [{
      id: 'core',
      connectorName: 'Chat On Steroids',
      description: 'desc',
      cardSummary: 'card',
      optional: false,
      available: true,
      localUrl: `http://127.0.0.1:51234/mcp/core/${secretPath}`,
      publicUrl: `https://tunnel.example/mcp/core/${secretPath}`,
      tools: ['read', 'exec'],
      state: 'live',
      detail: 'Published',
      lastRequestAt: 6,
      lastToolCallAt: 7
    }]
  };
  const bridge: BridgeStatus = { running: true, port: 8765, paired: true, present: true, lastSeenAt: 8, extensionVersion: '2.1.19', error: null };
  const plugins = {
    plugins: [{
      id: 'p1',
      name: 'Plugin',
      source: { kind: 'stdio', command: 'C:\\private\\tool.exe', args: ['--token', 'plugin-secret-value'] },
      config: { apiKey: pluginConfigSecret },
      credentialKeys: ['apiKey'],
      version: '1.0.0',
      license: 'MIT',
      enabled: true,
      status: 'error',
      error: `request failed with token sk-${'a'.repeat(24)}`,
      tools: [{ name: 'a', exposedName: 'a', enabled: true }, { name: 'b', exposedName: 'b', enabled: false }],
      installedAt: 0
    }],
    catalog: [],
    schemaRevision: 1
  } as unknown as PluginSnapshot;
  const update: UpdateStatus = { current: '2.1.19', latest: '2.1.20', stage: 'ready', error: null, checkedAt: 9 };

  it('publishes only allowlisted fields, so owners can grow secrets without leaking them', () => {
    const projected = controlApi.projectStatus({
      connection,
      bridge,
      plugins,
      update,
      toolCalls: { running: 1, settling: 0, inFlight: 1, inFlightMcpRequests: 2 }
    });
    const text = JSON.stringify(projected);
    for (const secret of [secretPath, 'plugin-secret-value', pluginConfigSecret, 'C:\\\\private', `sk-${'a'.repeat(24)}`]) {
      expect(text).not.toContain(secret);
    }
    expect(projected.connection.surfaces).toEqual([
      { id: 'core', state: 'live', available: true, optional: false, detail: 'Published', tools: 2, lastRequestAt: 6, lastToolCallAt: 7 }
    ]);
    expect(projected.connection.tunnel).toEqual(connection.health);
    expect(projected.plugins).toEqual([
      { id: 'p1', name: 'Plugin', enabled: true, status: 'error', enabledTools: 1, error: 'request failed with token sk-***' }
    ]);
    expect(projected.update).toEqual(update);
    expect(projected.toolCalls).toEqual({ running: 1, settling: 0, inFlight: 1, inFlightMcpRequests: 2 });
  });
});
