import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { validateNewRoot } from '../src/main/sandbox.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  inFlightToolCalls,
  runningToolCalls,
  settlingToolCalls
} from '../src/main/mcp/call-context.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { initSessionStore, resetSessionStoreForTests, unsetSessionRootForTests } from '../src/main/session/store.js';

/** What the counter said while the call was being recorded, i.e. after its handler returned. */
let duringRecord: number | null = null;
/** Held open to stand in for the grace window an unattributed record can spend waiting. */
let releaseRecord: (() => void) | null = null;

// The recorder runs in the gap this test is about: the handler has returned, the result has
// not been delivered, and the durable append is still to come. Everything else in the module
// stays real, so the call travels its normal path.
vi.mock('../src/main/session/recorder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/session/recorder.js')>();
  return {
    ...actual,
    recordToolCall: async (...args: Parameters<typeof actual.recordToolCall>) => {
      duringRecord = inFlightToolCalls(null);
      if (releaseRecord !== null) {
        await new Promise<void>((resolve) => {
          const previous = releaseRecord;
          releaseRecord = () => {
            previous?.();
            resolve();
          };
        });
      }
      return actual.recordToolCall(...args);
    }
  };
});

let dir = '';
let endpoint: McpEndpoint | null = null;

afterEach(async () => {
  releaseRecord?.();
  releaseRecord = null;
  if (endpoint) await endpoint.stop().catch(() => undefined);
  endpoint = null;
  duringRecord = null;
  resetSessionStoreForTests();
  unsetSessionRootForTests();
  resetDurableForTests();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = '';
});

async function serve(): Promise<McpEndpoint> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-inflight-'));
  initConfigPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  const cfg = defaultConfig();
  const rootPath = await validateNewRoot(dir, []);
  const roots = [{ name: 'probe', path: rootPath }];
  await saveConfig({ ...cfg, roots, readOnly: false });
  await fs.writeFile(path.join(dir, 'note.txt'), 'hello\n', 'utf8');
  return startMcpServer(() => ({
    roots,
    caps: cfg.capabilities,
    readOnly: false,
    sessionTools: false,
    agentTools: false
  }));
}

const readNote = (url: string): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'read', arguments: { paths: ['/probe/note.txt'] } }
    })
  });

it('counts a call as running until its whole request is done, not just its handler', async () => {
  // The compaction barrier waits for this to reach zero before it writes a handoff. The
  // handler returning is not the end of the request: identity is still being resolved, the
  // outcome is still being recorded, and the result has not reached ChatGPT. A counter that
  // closed with the handler let a handoff be written into exactly that gap.
  endpoint = await serve();
  const response = await readNote(endpoint.url);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('hello');

  expect(duringRecord).toBe(1);
  // And released once it has: this call was never attributed, so it is held through its own
  // record landing — see the test below, which is about exactly that window.
  const settled = Date.now();
  while (inFlightToolCalls(null) !== 0 && Date.now() - settled < 5_000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(inFlightToolCalls(null)).toBe(0);
});

it('keeps an unattributed call counted while its record is still landing', async () => {
  // The half the request counter alone does not cover. A call whose conversation the page
  // has not named does not hold up its own result — the recorder may still be waiting for
  // that evidence — so dispatch returns and the request ends while the append is unfinished.
  // Until it lands, the call could still turn out to belong to the chat that is asking, so
  // it stays charged to every chat rather than reading as zero for all of them.
  releaseRecord = () => {};
  endpoint = await serve();
  const response = await readNote(endpoint.url);
  expect(response.status).toBe(200);

  // The request is over and its result delivered, but the record has not settled.
  expect(inFlightToolCalls('conversation-a')).toBe(1);
  expect(inFlightToolCalls('conversation-b')).toBe(1);
  expect(inFlightToolCalls(null)).toBe(1);
  // This distinction is the compaction contract. The machine-changing request is done, so
  // `pendingTools` may be zero even while the unattributed history append stays observable.
  expect(runningToolCalls('conversation-a')).toBe(0);
  expect(runningToolCalls('conversation-b')).toBe(0);
  expect(settlingToolCalls('conversation-a')).toBe(1);
  expect(settlingToolCalls('conversation-b')).toBe(1);

  releaseRecord();
  releaseRecord = null;
  // Settling is what releases it, and nothing else.
  const settled = Date.now();
  while (inFlightToolCalls(null) !== 0 && Date.now() - settled < 5_000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(inFlightToolCalls('conversation-a')).toBe(0);
  expect(runningToolCalls('conversation-a')).toBe(0);
  expect(settlingToolCalls('conversation-a')).toBe(0);
});
