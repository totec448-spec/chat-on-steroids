import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, flushDurable, resetDurableForTests } from '../src/main/durable.js';
import { initSessionStore, createSession, appendEvent, resetSessionStoreForTests } from '../src/main/session/store.js';
import { observeRequestCorrelation } from '../src/main/session/correlation.js';
import { enqueueInput, listInputs, resetInputForTests } from '../src/main/session/input.js';
import { validateInputImages } from '../src/main/session/input-images.js';
import { startMcpServer } from '../src/main/mcp/server.js';
import { setFinishNotifier, releaseSessionFinish } from '../src/main/session/finish.js';
import { makeTempDir, removeTempDir } from './helpers.js';

it('carries validated user image bytes through an exact-session MCP result and acknowledges the next same-turn call', async () => {
  const directory = await makeTempDir('clf-mcp-input-image-');
  initDurableStore(directory); initSessionStore(directory); resetInputForTests();
  initConfigPath(directory);
  const config = defaultConfig();
  await saveConfig({ ...config, ui: { ...config.ui, finishTool: true } });
  await fs.writeFile(path.join(directory, 'example.txt'), 'Image test');
  const endpoint = await startMcpServer(() => ({ roots: [{ name: 'workspace', path: directory }], caps: config.capabilities, readOnly: true, sessionTools: false, agentTools: false }));
  try {
    const conversationId = randomUUID(), requestId = 'wfr_input_image_test';
    const session = await createSession({ conversationId, title: 'Image injection test' });
    await appendEvent(session.id, { kind: 'turn_start', source: 'extension', turnId: 'held-image-turn', time: Date.now() });
    expect(observeRequestCorrelation({ requestId, conversationId, sessionId: session.id, messageId: 'image-message', tool: 'read', observedAt: Date.now() })).toBe('stored');
    const bytes = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#437b79' } }).webp().toBuffer();
    const images = [{ name: 'reference.webp', dataUrl: `data:image/webp;base64,${bytes.toString('base64')}` }];
    await validateInputImages(images);
    const input = await enqueueInput({ id: randomUUID(), sessionId: session.id, text: 'Use this image', images, mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
    const call = async (name = 'read', args: Record<string, unknown> = { paths: ['/workspace/example.txt'] }) => {
      const response = await fetch(endpoint.urls.core, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-request-id': `${requestId}/att1` }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }) });
      const raw = await response.text();
      return JSON.parse(raw.startsWith('event:') || raw.startsWith('data:') ? raw.split('\n').find(line => line.startsWith('data:'))!.slice(5) : raw);
    };
    const stageOne = await enqueueInput({ id: randomUUID(), sessionId: session.id, text: 'First scheduled stage', mode: 'finish', dueAt: 0, model: null, reasoningEffort: null });
    const stageTwo = await enqueueInput({ id: randomUUID(), sessionId: session.id, text: 'Second scheduled stage', mode: 'finish', dueAt: 0, model: null, reasoningEffort: null });
    const first = await call();
    expect(first.result.isError).not.toBe(true);
    expect(first.result.content).toContainEqual({ type: 'image', mimeType: 'image/webp', data: bytes.toString('base64') });
    expect(first.result.content.some((row: { text?: string }) => row.text?.includes(input.id))).toBe(true);
    const second = await call();
    expect(second.result.content.some((row: { type: string }) => row.type === 'image')).toBe(false);
    expect((await listInputs()).find(row => row.id === input.id)?.state).toBe('sent');
    expect(second.result.content.some((row: { text?: string }) => row.text?.includes(stageOne.id))).toBe(false);
    expect(second.result.content.some((row: { text?: string }) => row.text?.includes(stageTwo.id))).toBe(false);
    expect((await listInputs()).find(row => row.id === stageOne.id)?.state).toBe('queued');
    const refusedFinish = await call('session_finish', { summary: '' });
    expect(refusedFinish.result.isError).toBe(true);
    expect((await listInputs()).find(row => row.id === stageOne.id)?.state).toBe('queued');
    const finish = await call('session_finish', { summary: 'The current stage is complete' });
    expect(finish.result.isError).not.toBe(true);
    expect(finish.result.content.some((row: { text?: string }) => row.text?.includes(stageOne.id))).toBe(true);
    expect(finish.result.content.some((row: { text?: string }) => row.text?.includes(stageTwo.id))).toBe(false);
    const ordinary = await call();
    expect(ordinary.result.content.some((row: { text?: string }) => row.text?.includes(stageTwo.id))).toBe(false);
    expect((await listInputs()).find(row => row.id === stageOne.id)?.state).toBe('sent');
    const third = await call('session_finish', { summary: 'The next stage is complete' });
    expect(third.result.content.some((row: { text?: string }) => row.text?.includes(stageTwo.id))).toBe(true);
    expect((await listInputs()).find(row => row.id === stageOne.id)?.state).toBe('sent');
    // The last injected stage is still a tool claim until the next invocation
    // proves receipt. Finish must acknowledge it before checking for pending work.
    expect((await listInputs()).find(row => row.id === stageTwo.id)?.state).toBe('tool');
    await saveConfig({ ...config, ui: { ...config.ui, finishTool: true, finishAction: 'notify' } });
    let notifications = 0;
    setFinishNotifier((_title, _body, id, turnId) => {
      notifications += 1;
      void releaseSessionFinish(id, turnId);
      return true;
    });
    const exhausted = await call('session_finish', { summary: 'All received stages are complete' });
    expect(notifications).toBe(1);
    expect(exhausted.result.content.some((row: { text?: string }) => row.text?.includes('Queued user instructions are ready'))).toBe(false);
    expect(exhausted.result.content.some((row: { text?: string }) => row.text?.includes('The user has been notified'))).toBe(true);
    expect((await listInputs()).find(row => row.id === stageTwo.id)?.state).toBe('sent');
  } finally {
    setFinishNotifier(null);
    await endpoint.stop(); await flushDurable(); resetInputForTests(); resetSessionStoreForTests(); resetDurableForTests(); await removeTempDir(directory);
  }
});
