/**
 * The exec output budget as it survives the real handler wiring, over `tools/call`.
 *
 * `exec-output-budget.test.ts` pins the formatter, but it builds its own `ExecCommandToolOutput`
 * and therefore chooses the policy itself. That cannot see which constant `tools-core` actually
 * hands the process manager: passing `DEFAULT_TRUNCATION_POLICY` at the handler would restore the
 * 10_000-token ceiling, make every `max_output_tokens` above the default inert again, and leave
 * every unit test passing.
 *
 * So this goes through the server the connector really serves: one `exec_command` request with
 * `max_output_tokens: 30000`, one without, against a command that emits ~200 KB.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { validateNewRoot } from '../src/main/sandbox.js';
import { initSessionStore, resetSessionStoreForTests, unsetSessionRootForTests } from '../src/main/session/store.js';

/** Bytes the probe command writes to stdout. Comfortably past both budgets under test. */
const PROBE_BYTES = 200_000;

/**
 * Read a deterministic fixture from the approved workdir. This test is about retained output,
 * not shell formatting limits or setup-node discovery. macOS' shell printf rejects very large
 * field widths on some hosted images, while the same command succeeds under GNU/bash; letting
 * that platform detail decide whether the MCP call is an error defeats the purpose of the test.
 */
const PROBE_FILE = 'budget-output.txt';
const PROBE_CMD = process.platform === 'win32'
  ? `Get-Content -Raw -LiteralPath '${PROBE_FILE}'`
  : `cat '${PROBE_FILE}'`;

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

async function serve(): Promise<McpEndpoint> {
  // The real roots:add path persists validateNewRoot()'s canonical spelling. Hosted macOS
  // exposes temp paths through /var while realpath resolves them under /private/var, and some
  // Windows runners likewise expose temp directories through a redirected path. Injecting the
  // raw mkdtemp spelling here therefore creates a root production would never persist and makes
  // the sandbox correctly reject it as changed on disk before exec_command can test anything.
  dir = await validateNewRoot(await fs.mkdtemp(path.join(os.tmpdir(), 'clf-budget-')), []);
  await fs.writeFile(path.join(dir, PROBE_FILE), 'x'.repeat(PROBE_BYTES), 'utf8');
  initConfigPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  const cfg = defaultConfig();
  await saveConfig({ ...cfg, roots: [{ name: 'probe', path: dir }], readOnly: false });
  return startMcpServer(() => ({
    roots: [{ name: 'probe', path: dir }],
    caps: cfg.capabilities,
    readOnly: false,
    sessionTools: false,
    agentTools: false
  }));
}

/**
 * The server answers `tools/call` as a single Streamable HTTP SSE frame, so the JSON-RPC body
 * arrives in `data:` lines rather than as the whole response. Per the SSE spec several data lines
 * in one frame join with newlines.
 */
function sseJson(body: string): unknown {
  const data = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart())
    .join('\n');
  return JSON.parse(data === '' ? body : data);
}

/** The model-visible text of one `exec_command` call. */
async function execOutput(url: string, maxOutputTokens: number | undefined): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'exec_command',
        arguments: {
          cmd: PROBE_CMD,
          workdir: '/probe',
          ...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens })
        }
      }
    })
  });
  expect(response.status).toBe(200);
  const body = sseJson(await response.text()) as {
    result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  };
  const text = body.result?.content?.find((part) => part.type === 'text')?.text ?? '';
  expect(body.result?.isError ?? false, text).toBe(false);
  return text;
}

it('honours max_output_tokens above the default through the real exec_command handler', async () => {
  endpoint = await serve();

  const requested = await execOutput(endpoint.url, 30_000);
  const omitted = await execOutput(endpoint.url, undefined);

  // The command really ran and really overflowed both budgets.
  expect(requested).toContain('Process exited with code 0');
  expect(requested).toContain('Warning: truncated output');
  expect(omitted).toContain('Warning: truncated output');

  // 30_000 tokens is ~120 KB of retained output. Under a 10_000-token ceiling this is ~40 KB,
  // and under the original bytes:10_000 policy it is ~10 KB.
  expect(requested.length).toBeGreaterThan(100_000);
  // And the default is still the default: asking for nothing must not get the ceiling.
  expect(omitted.length).toBeLessThan(60_000);
  expect(requested.length).toBeGreaterThan(omitted.length);
}, 30_000);
