import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * #924 / #1401: a named Cloudflare tunnel keeps its hostname, but the secret path changed on every
 * start, so ChatGPT's stored URL went dead and its tools vanished. Opt-in: each surface keeps its
 * token, only in the OS-backed secret store; turning the option off forgets them.
 */
const store = new Map<string, string>();
let available = true;
vi.mock('../src/main/secrets.js', () => ({
  getSecret: vi.fn(async (key: string) => store.get(key) ?? null),
  setSecret: vi.fn(async (key: string, value: string) => { if (!available) throw new Error('Secure storage is unavailable'); store.set(key, value); }),
  clearSecret: vi.fn(async (key: string) => { store.delete(key); })
}));

const { forgetSurfaceTokens, loadSurfaceTokens, rememberSurfaceTokens } = await import('../src/main/mcp/persistent-paths.js');
const { startMcpServer } = await import('../src/main/mcp/server.js');
const { defaultConfig, initConfigPath } = await import('../src/main/config.js');

const token = (c: string) => c.repeat(43);
const urls = { core: `http://127.0.0.1:1/mcp/core/${token('a')}`, desktop: `http://127.0.0.1:1/mcp/desktop/${token('b')}`, plugins: `http://127.0.0.1:1/mcp/plugins/${token('c')}` };
beforeEach(() => { store.clear(); available = true; });

it('remembers each surface token and gives back only well-formed ones', async () => {
  expect(await rememberSurfaceTokens(urls)).toBe(true);
  expect(await loadSurfaceTokens()).toEqual({ core: token('a'), desktop: token('b'), plugins: token('c') });
  store.set('mcp:path:desktop', 'not a token');
  expect(await loadSurfaceTokens()).toEqual({ core: token('a'), plugins: token('c') });
});

it('keeps rotating when secure storage is unavailable', async () => {
  available = false;
  expect(await rememberSurfaceTokens(urls)).toBe(false);
  expect(await loadSurfaceTokens()).toEqual({});
});

it('forgets every stored token when the option is turned off', async () => {
  await rememberSurfaceTokens(urls);
  await forgetSurfaceTokens();
  expect(await loadSurfaceTokens()).toEqual({});
});

let dir = '';
afterEach(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }); dir = ''; });

it('serves each surface on the kept token, and a fresh one for a surface without', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-mcp-paths-'));
  initConfigPath(dir);
  const cfg = defaultConfig();
  const endpoint = await startMcpServer(() => ({ roots: [], caps: cfg.capabilities, readOnly: true }), { core: token('a') });
  try {
    expect(new URL(endpoint.urls.core).pathname).toBe(`/mcp/core/${token('a')}`);
    expect(new URL(endpoint.urls.desktop).pathname).toMatch(/^\/mcp\/desktop\/[A-Za-z0-9_-]{43}$/);
    expect(endpoint.urls.desktop).not.toContain(token('b'));
  } finally { await endpoint.stop(); }
});

// #1550: a named tunnel points at a fixed local port, but the server took a new random port on
// every start, so the kept URL still went dead after a restart.
const { loadKeptPort } = await import('../src/main/mcp/persistent-paths.js');

it('remembers the local port with the tokens, and forgets it with them', async () => {
  await rememberSurfaceTokens({ core: `http://127.0.0.1:50123/mcp/core/${token('a')}`, desktop: `http://127.0.0.1:50123/mcp/desktop/${token('b')}`, plugins: `http://127.0.0.1:50123/mcp/plugins/${token('c')}` });
  expect(await loadKeptPort()).toBe(50123);
  store.set('mcp:path:port', 'eighty');
  expect(await loadKeptPort()).toBeNull();
  store.set('mcp:path:port', '70000');
  expect(await loadKeptPort()).toBeNull();
  await rememberSurfaceTokens(urls);
  await forgetSurfaceTokens();
  expect(await loadKeptPort()).toBeNull();
});

it('serves on the kept port when it is free, and on a fresh one when it is taken', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-mcp-port-'));
  initConfigPath(dir);
  const cfg = defaultConfig();
  const context = () => ({ roots: [], caps: cfg.capabilities, readOnly: true });
  const first = await startMcpServer(context, {});
  const port = Number(new URL(first.urls.core).port);
  await first.stop();
  const again = await startMcpServer(context, {}, { port });
  try {
    expect(Number(new URL(again.urls.core).port)).toBe(port);
    // Another program has the port now: the app still starts, on another one.
    const taken = await startMcpServer(context, {}, { port });
    try {
      expect(Number(new URL(taken.urls.core).port)).not.toBe(port);
    } finally { await taken.stop(); }
  } finally { await again.stop(); }
});
