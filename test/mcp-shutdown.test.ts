import { promises as fs } from 'node:fs';
import * as filesystem from '../src/main/codex/filesystem.js';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { validateNewRoot } from '../src/main/sandbox.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { initSessionStore, resetSessionStoreForTests, unsetSessionRootForTests } from '../src/main/session/store.js';

let dir = '';
let endpoint: McpEndpoint | null = null;

afterEach(async () => {
  if (endpoint) await endpoint.stop().catch(() => undefined);
  endpoint = null;
  resetSessionStoreForTests();
  unsetSessionRootForTests();
  resetDurableForTests();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = '';
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it('drains an accepted MCP mutation before closing its response socket', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-mcp-drain-'));
  initConfigPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  const cfg = defaultConfig();
  const rootPath = await validateNewRoot(dir, []);
  const roots = [{ name: 'probe', path: rootPath }];
  await saveConfig({
    ...cfg,
    roots,
    readOnly: false,
    capabilities: cfg.capabilities
  });
  endpoint = await startMcpServer(() => ({
    roots,
    caps: cfg.capabilities,
    readOnly: false,
    sessionTools: false,
    agentTools: false
  }));
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'apply_patch',
      arguments: {
        patch: '*** Begin Patch\n*** Add File: /probe/after-stop.txt\n+after\n*** End Patch'
      }
    }
  };
  // Hold the real mutation at its accepted boundary. Shell startup and exec's
  // normal early-yield response are independent of HTTP drain semantics; a cold
  // Windows runner can exceed that yield before its first command runs.
  let entered!: () => void;
  let release!: () => void;
  const accepted = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writeFile = filesystem.writeFile;
  const mutation = vi.spyOn(filesystem, 'writeFile').mockImplementation(async (file, contents) => {
    if (file === path.join(rootPath, 'after-stop.txt')) {
      entered();
      await gate;
    }
    await writeFile(file, contents);
  });
  const request = fetch(endpoint.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body)
  }).then(async (response) => ({ status: response.status, text: await response.text() }));
  let stopping: Promise<void> | undefined;
  try {
    await Promise.race([
      accepted,
      request.then(result => { throw new Error(`MCP request finished before mutation: HTTP ${result.status} ${result.text}`); })
    ]);
    stopping = endpoint.stop();
    endpoint = null;
    expect(await Promise.race([stopping.then(() => true), sleep(20).then(() => false)])).toBe(false);
    await expect(fs.readFile(path.join(dir, 'after-stop.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    release();
    const result = await request;
    await stopping;

    expect(result.status).toBe(200);
    expect(result.text).toContain('Success. Updated the following files:');
    await expect(fs.readFile(path.join(dir, 'after-stop.txt'), 'utf8')).resolves.toBe('after\n');
  } finally {
    release();
    await request.catch(() => undefined);
    await stopping;
    mutation.mockRestore();
  }
});
it('does not put a force-close deadline on an ordinary endpoint stop', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-mcp-graceful-stop-'));
  initConfigPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  const cfg = defaultConfig();
  const rootPath = await validateNewRoot(dir, []);
  const roots = [{ name: 'probe', path: rootPath }];
  await saveConfig({ ...cfg, roots });
  endpoint = await startMcpServer(() => ({
    roots,
    caps: cfg.capabilities,
    readOnly: true,
    sessionTools: false,
    agentTools: false
  }));
  const timeout = vi.spyOn(globalThis, 'setTimeout');
  try {
    const stopping = endpoint.stop();
    endpoint = null;
    await stopping;
    expect(timeout.mock.calls.some((call) => call[1] === 30_000)).toBe(false);
  } finally {
    timeout.mockRestore();
  }
});
