import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { observeRequestCorrelation } from '../src/main/session/correlation.js';
import { flushRecorder, resetRecorderForTests, sessionForConversation } from '../src/main/session/recorder.js';
import * as store from '../src/main/session/store.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let root: string;
let endpoint: McpEndpoint;
let sessionId: string;
let requestId: string;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

beforeEach(async () => {
  root = await makeTempDir('clf-image-recording-');
  initConfigPath(root);
  store.initSessionStore(root);
  resetRecorderForTests();
  const config = defaultConfig();
  await saveConfig(config);
  await fs.writeFile(path.join(root, 'pixel.png'), png);
  const conversationId = randomUUID();
  sessionId = (await sessionForConversation(conversationId))!;
  requestId = randomUUID();
  observeRequestCorrelation({ requestId, conversationId, sessionId, messageId: randomUUID(), observedAt: Date.now(), tool: 'view_image' });
  endpoint = await startMcpServer(() => ({ roots: [{ name: 'workspace', path: root }],
    caps: config.capabilities, readOnly: false, sessionTools: false, agentTools: false }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await endpoint?.stop();
  await flushRecorder();
  await store.flushSessions();
  resetRecorderForTests();
  store.resetSessionStoreForTests();
  await removeTempDir(root);
});

async function callImage() {
  const response = await fetch(endpoint.urls.core, { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-request-id': requestId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'view_image', arguments: { path: '/workspace/pixel.png' } } }) });
  expect(response.status).toBe(200);
  const body = (await response.text()).trim();
  const reply = JSON.parse(body.startsWith('{') ? body : [...body.matchAll(/^data:\s*(.*)$/gm)].at(-1)![1]!);
  expect(reply.error).toBeUndefined();
  expect(reply.result.isError).not.toBe(true);
  expect(reply.result.content).toEqual([{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }]);
  const events = await store.readEvents(sessionId, { kinds: ['tool_call'] });
  const event = events.at(-1)!;
  if (event.kind !== 'tool_call') throw new Error('missing recorded tool call');
  expect(event.call.outcome).toBe('ok');
  expect(event.call.result.text).toBe('');
  return event.call;
}

it('keeps exact image bytes on the wire when the recording quota rejects a preview, then records the next successful preview', async () => {
  // Inject failure at the disk-storage owner; run the real registrar, decoder,
  // dispatcher, recorder and HTTP serialization on both sides of that failure.
  const write = vi.spyOn(store, 'writeAsset').mockRejectedValueOnce(new Error('Global session asset quota exceeded'));
  const missing = await callImage();
  expect(missing.assets).toBeUndefined();
  expect(missing.summary).toMatchObject({ tone: 'warn' });
  expect(missing.summary.detail).toContain('recording storage limit reached');
  expect(missing.summary.detail).toContain('Image content remains in the tool response.');
  write.mockRestore();
  const recorded = await callImage();
  expect(recorded.summary.detail).toBeUndefined();
  expect(recorded.assets).toHaveLength(1);
  expect(await store.readAsset(sessionId, recorded.assets![0]!.id)).toEqual(png);
});

it('exposes a recording write failure without leaking filesystem error text into history or changing the image result', async () => {
  vi.spyOn(store, 'writeAsset').mockRejectedValueOnce(new Error('EACCES: PRIVATE_LOCAL_PATH'));
  const call = await callImage();
  expect(call.summary.detail).toContain('recording write failed');
  expect(JSON.stringify(call)).not.toContain('PRIVATE_LOCAL_PATH');
});
