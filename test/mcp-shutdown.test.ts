import { promises as fs } from 'node:fs';
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
    capabilities: { ...cfg.capabilities, command: true }
  });
  endpoint = await startMcpServer(() => ({
    roots,
    caps: { ...cfg.capabilities, command: true },
    readOnly: false,
    sessionTools: false,
    agentTools: false
  }));
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'exec_command',
      arguments: {
        cmd:
          process.platform === 'win32'
            ? "Set-Content -LiteralPath 'started.txt' -Value 'started' -NoNewline; Start-Sleep -Milliseconds 500; Set-Content -LiteralPath 'after-stop.txt' -Value 'after' -NoNewline"
            : "printf '%s' started > started.txt; sleep 1; printf '%s' after > after-stop.txt",
        workdir: '/probe',
        shell:
          process.platform === 'win32'
            ? path.join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
            : '/bin/sh',
        yield_time_ms: 5_000
      }
    }
  };
  const request = fetch(endpoint.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body)
  }).then(async (response) => ({ ok: true, status: response.status, text: await response.text() }));

  // Synchronise on a side effect from the accepted command before asking the server to stop.
  // Keep the helper inside the already-running shell process: spawning a second `node`
  // process made this shutdown test depend on hosted-runner process startup rather than drain
  // semantics, and on a loaded CI runner that cold spawn can outrun the whole 15s budget below.
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    try {
      await fs.access(path.join(dir, 'started.txt'));
      break;
    } catch {
      // A request that finishes before the file appears has failed for a reason the ENOENT
      // below would hide; say what the server actually answered instead of timing out on it.
      const early = await Promise.race([
        request.then((result) => ({ done: true as const, result })),
        sleep(20).then(() => ({ done: false as const }))
      ]);
      if (early.done) {
        throw new Error(`MCP request finished before command start: HTTP ${early.result.status} ${early.result.text}`);
      }
    }
  }
  await expect(fs.readFile(path.join(dir, 'started.txt'), 'utf8')).resolves.toContain('started');

  const stopping = endpoint.stop();
  endpoint = null;
  const result = await request;
  await stopping;

  expect(result.ok).toBe(true);
  expect(result.status).toBe(200);
  expect(result.text).toContain('Process exited with code 0');
  await expect(fs.readFile(path.join(dir, 'after-stop.txt'), 'utf8')).resolves.toContain('after');
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
