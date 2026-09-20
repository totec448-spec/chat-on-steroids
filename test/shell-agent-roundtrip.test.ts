/** Synthetic versions of @ehkogh/#318 and @redzrush101's public shell shapes.
 * The page helper, isolated recorder, request registry and HTTP MCP handlers are
 * production code. Chrome transport and the native bootstrap receipt are fixtures. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value),
    decryptStringAsync: async (value: Buffer) => ({ result: value.toString(), shouldReEncrypt: false })
  },
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined }
}));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initDurableStore, flushDurable, resetDurableForTests, writeDurableNow } = await import('../src/main/durable.js');
const { initSessionStore, resetSessionStoreForTests, findSessionByConversation, getSession, readEvents, flushSessions } = await import('../src/main/session/store.js');
const { requestCorrelation, resetCorrelationRegistryForTests } = await import('../src/main/session/correlation.js');
const { recordRequestEvidence, recordChatObservations, noteChatOrigin, resetRecorderForTests, flushRecorder } = await import('../src/main/session/recorder.js');
const broker = await import('../src/main/agents.js');
const { startMcpServer } = await import('../src/main/mcp/server.js');
const { inFlightMcpRequests } = await import('../src/main/mcp/call-context.js');
const scripts = ['fiber', 'chatgpt-dom', 'content'].map(name => readFileSync(new URL(`../extension/${name}.js`, import.meta.url), 'utf8'));
let directory: string, endpoint: Awaited<ReturnType<typeof startMcpServer>>;
const pages = new Set<JSDOM>();

beforeAll(async () => {
  directory = await makeTempDir('clf-shell-agent-wire-');
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
  const config = defaultConfig();
  await saveConfig({ ...config, multiAgent: { ...config.multiAgent, enabled: true, maxWorkers: 2, allowUnattributedCalls: true } });
  broker.onSwarmPersistNow(snapshot => writeDurableNow('swarm', snapshot));
  endpoint = await startMcpServer(() => ({ roots: [{ name: 'workspace', path: directory }],
    caps: config.capabilities, readOnly: false, agentTools: true, sessionTools: true }));
});
afterAll(async () => {
  for (const page of pages) { (page.window as any).__CLF_CONTENT_RECORDER__?.stop(); page.window.close(); }
  await endpoint?.stop(); await flushRecorder(); await flushSessions(); await flushDurable();
  broker.resetAgentsForTests(); resetRecorderForTests(); resetCorrelationRegistryForTests();
  resetSessionStoreForTests(); resetDurableForTests(); await removeTempDir(directory);
});

async function call(requestId: string, name: string, args: object): Promise<any> {
  const response = await fetch(endpoint.urls.core, { method: 'POST', headers: {
    'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-request-id': `${requestId}/fixture`
  }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }) });
  const raw = await response.text();
  const envelope = JSON.parse(raw.startsWith('{') ? raw : [...raw.matchAll(/^data: (.+)$/gm)].at(-1)![1]!);
  expect(envelope.error).toBeUndefined();
  return envelope.result;
}
const textOf = (result: any): string => result.content.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n');
async function agents(requestId: string, args: object) {
  const result = await call(requestId, 'agents', args);
  expect(result.isError, textOf(result)).not.toBe(true);
  return result;
}

async function publishPage(conversationId: string, requestId: string, shape: 'live' | 'paired' | 'code' | 'buffered') {
  const user = randomUUID(), turn = randomUUID(), invocation = randomUUID(), resultId = randomUUID();
  const page = new JSDOM(`<main data-app-shell-main-surface><div data-thread-find-target="conversation">
    <div data-turn-key="${user}"><div data-content-search-turn-key="${turn}">
    <div data-content-search-unit-key="${turn}:0:user"><div data-user-message-bubble><div class="whitespace-pre-wrap">Diagnostic task</div></div></div>
    <span data-chatgpt-agent-turn-start></span></div></div></div>
    <form data-chatgpt-composer><div data-composer-body><div contenteditable="true" role="textbox" data-composer-markdown></div></div></form>
    </main>`, { url: `https://chatgpt.com/c/${conversationId}`, runScripts: 'outside-only', pretendToBeVisual: true });
  pages.add(page);
  const win = page.window as any, doc = win.document;
  const paired = shape === 'paired';
  const step = shape === 'code' ? { type: 'dynamic-tool-call', callId: invocation, tool: 'exec', completed: false }
    : { type: 'mcp-tool-call', callId: invocation, completed: paired,
      invocation: { server: 'Chat_On_Steroids_Core', tool: 'agents' },
      ...(paired ? { widgetStateSource: { messageId: resultId } } : {}) };
  const entry = { id: turn, conversationId, turn: { status: 'in_progress',
    messageIds: [user, paired || shape === 'code' ? resultId : invocation], items: [
      { type: 'user-message', messageId: user, serverMessageId: user, message: 'Diagnostic task' },
      { type: 'chatgpt-reasoning-group', items: [step] }
    ] } };
  const path = '/Chat On Steroids Core/link_fixture/agents';
  const mapping = {
    [user]: { id: user, parent: null, message: { id: user, author: { role: 'user' } } },
    [invocation]: { id: invocation, parent: user, message: { id: invocation, author: { role: 'assistant' },
      recipient: shape === 'code' ? 'functions.exec' : 'api_tool.call_tool', metadata: { request_id: requestId },
      content: { content_type: 'code', text: JSON.stringify({ path, args: { secret: 'PRIVATE_FIXTURE_ARGUMENT' } }) } } },
    [resultId]: { id: resultId, parent: invocation, message: { id: resultId, author: { role: 'tool' }, metadata: {
      invoked_resource: { app_name: 'Chat On Steroids Core', resource_uri: path } } } }
  };
  const queries = paired ? [{ queryKey: ['chatgpt-conversation', conversationId], state: { data: { mapping } } }] : [];
  const top = { memoizedProps: { client: { getQueryCache: () => ({ getAll: () => queries }) } }, return: null };
  const owner = { memoizedProps: { conversationId }, return: top, updateQueue: { memoCache: { data: [[{
    renderedConversation: { mapping, current_node: resultId }, renderedTurns: [{ id: turn, turn: entry.turn }]
  }]] } } };
  doc.querySelector('[data-turn-key]').__reactFiber$fixture = { memoizedProps: { entry }, return: paired ? top : owner };
  if (shape === 'buffered') {
    const node = doc.querySelector('[data-turn-key]');
    const previousEntry = structuredClone(entry), previousMapping = structuredClone(mapping);
    const previousMetadata = previousMapping[invocation]?.message.metadata;
    if (!previousMetadata || !('request_id' in previousMetadata)) throw new Error('Fixture invocation metadata is missing');
    previousMetadata.request_id = `wfr_${randomUUID()}`;
    const state: any = { current: null };
    const roots: any[] = [0, 1].map(() => ({ tag: 3, return: null, stateNode: state }));
    const owners: any[] = [previousEntry, entry].map((value, index) => ({ tag: 0,
      return: roots[index], memoizedProps: { conversationId },
      updateQueue: { memoCache: { data: [[{ renderedConversation: { mapping: index ? mapping : previousMapping, current_node: resultId },
        renderedTurns: [{ id: turn, turn: value.turn }] }]] } } }));
    const rows: any[] = [previousEntry, entry].map((value, index) => ({ tag: 0, return: owners[index], memoizedProps: { entry: value } }));
    const hosts: any[] = rows.map(parent => ({ tag: 5, return: parent, stateNode: node, memoizedProps: {} }));
    for (const pair of [roots, owners, rows, hosts]) { pair[0].alternate = pair[1]; pair[1].alternate = pair[0]; }
    for (const index of [0, 1]) { roots[index].child = owners[index]; owners[index].child = rows[index]; rows[index].child = hosts[index]; }
    state.current = roots[1]; node.__reactFiber$fixture = hosts[0];
  }
  win.postMessage = (data: unknown) => queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message', { data, source: win, origin: win.location.origin })));
  win.setInterval = () => 0;
  let hook: any;
  const emitted: any[] = [];
  win.CLF_TEST_HOOK = (value: any) => { hook = value; };
  win.chrome = { runtime: { id: 'shell-agent-fixture', onMessage: { addListener() {}, removeListener() {} },
    async sendMessage(message: any) {
      emitted.push(message);
      if (message.type === 'status') return { connected: true, paired: true, pending: 0 };
      if (message.type === 'correlate') {
        expect(message.conversationId).toBe(conversationId);
        const sessionId = await recordRequestEvidence(conversationId, [{ kind: 'tool_evidence', time: Date.now(), calls: message.calls }]);
        return { ok: true, data: { conversationId, sessionId,
          confirmed: message.calls.filter((c: any) => requestCorrelation(c.requestId)?.conversationId === conversationId).map((c: any) => c.requestId) } };
      }
      if (message.type === 'events') {
        expect(message.conversationId).toBe(conversationId);
        await recordChatObservations(conversationId, message.entries.map((entry: any) => entry.event));
      }
      if (message.type === 'activity') return { ok: true, data: { entries: [], stream: [], pendingTools: 0 } };
      return { ok: true, pending: 0, durable: true };
    }
  }, storage: { onChanged: { addListener() {}, removeListener() {} } } };
  for (const script of scripts) win.eval(script);
  await vi.waitFor(() => expect(hook).toBeTruthy());
  await hook.pullActivity(); await hook.refreshFiber(); await hook.flush();
  await vi.waitFor(() => expect(requestCorrelation(requestId)?.conversationId).toBe(conversationId));
  expect(JSON.stringify(emitted)).not.toContain('PRIVATE_FIXTURE_ARGUMENT');
  await broker.reconcileAgentRequestOwners();
  win.__CLF_CONTENT_RECORDER__.stop(); page.window.close(); pages.delete(page);
}

async function callWhileIdentityCommits(conversationId: string, requestId: string, args: object) {
  await vi.waitFor(() => expect(inFlightMcpRequests()).toBe(0));
  const reply = agents(requestId, args);
  await vi.waitFor(() => expect(inFlightMcpRequests()).toBeGreaterThan(0));
  // The handler is already waiting. Only the committed page model can identify
  // this fresh request; the DOM pointer still holds the preceding React branch.
  await publishPage(conversationId, requestId, 'buffered');
  return reply;
}

it('delivers live messages, consumes their receipts, then wakes and reports from the same shell worker', async () => {
  const prime = randomUUID(), worker = randomUUID();
  let primeRequest = `wfr_${randomUUID()}`, workerRequest = `wfr_${randomUUID()}`;
  const spawned = await agents(primeRequest, { action: 'spawn', workers: [{ task: 'Read-only transport diagnostic' }] });
  const run = spawned.structuredContent.run_id;
  // The bridge's exact native bootstrap receipt is the boundary simulated here.
  expect(broker.bindConversation('worker-1', worker, run)).toBe(true);
  await noteChatOrigin(worker, { kind: 'worker', agentId: 'worker-1', fromSessionId: null, task: 'Read-only transport diagnostic' });
  await publishPage(worker, workerRequest, 'live');
  await publishPage(prime, primeRequest, 'paired');
  const parent = await findSessionByConversation(prime, { requireUnique: true });
  const child = await findSessionByConversation(worker, { requireUnique: true });
  expect((await getSession(child!.id))?.origin?.fromSessionId).toBe(parent!.id);
  expect((await agents(workerRequest, { action: 'status' })).structuredContent.self).toBe('worker-1');

  primeRequest = `wfr_${randomUUID()}`;
  await callWhileIdentityCommits(prime, primeRequest, { action: 'message', to: 'worker-1', text: 'PRIME_TO_WORKER_RECEIVED' });
  expect(broker.pendingCount('worker-1', run)).toBe(1);
  const nested = await call(workerRequest, 'exec', { code: 'const status = await tools.agents({action:"status"}); text(status.structuredContent);' });
  expect(nested.isError, textOf(nested)).not.toBe(true);
  expect(textOf(nested)).toContain('worker-1');
  expect(textOf(nested).match(/PRIME_TO_WORKER_RECEIVED/g)).toHaveLength(1);
  workerRequest = `wfr_${randomUUID()}`;
  await callWhileIdentityCommits(worker, workerRequest, { action: 'message', to: 'prime', text: 'WORKER_TO_PRIME_OK' });
  expect(broker.pendingCount('worker-1', run)).toBe(0);
  expect(textOf(await agents(primeRequest, { action: 'status' }))).toContain('WORKER_TO_PRIME_OK');
  await agents(primeRequest, { action: 'status' });
  expect(broker.pendingCount('prime', run)).toBe(0);

  await agents(workerRequest, { action: 'finish', result: 'EXACT_FIRST_REPORT' });
  expect(textOf(await agents(primeRequest, { action: 'status' }))).toContain('EXACT_FIRST_REPORT');
  const wake = await agents(primeRequest, { action: 'message', to: 'worker-1', text: 'FORWARD_AFTER_WAKE_OK' });
  const revivedRun = wake.structuredContent.run_id;
  expect(wake.structuredContent.waking).toEqual(['worker-1']);
  const workerAfterWake = `wfr_${randomUUID()}`;
  await publishPage(worker, workerAfterWake, 'code');
  const woke = await agents(workerAfterWake, { action: 'status' });
  expect(woke.structuredContent.self).toBe('worker-1');
  expect(textOf(woke)).toContain('FORWARD_AFTER_WAKE_OK');
  await agents(workerAfterWake, { action: 'message', to: 'prime', text: 'RETURN_AFTER_WAKE_OK' });
  expect(broker.pendingCount('worker-1', revivedRun)).toBe(0);
  const returned = await agents(primeRequest, { action: 'status' });
  expect(textOf(returned)).toContain('RETURN_AFTER_WAKE_OK');
  const outsider = await call(`wfr_${randomUUID()}`, 'agents', { action: 'status', run_id: revivedRun });
  expect(outsider.isError).toBe(true);
  expect(textOf(outsider)).not.toMatch(/RETURN_AFTER_WAKE_OK|FORWARD_AFTER_WAKE_OK/);
  await agents(workerAfterWake, { action: 'finish', result: 'EXACT_LAST_REPORT' });
  await agents(primeRequest, { action: 'status' });
  await agents(primeRequest, { action: 'status' });
  const childEvents = await readEvents(child!.id);
  const delivered = childEvents.filter(event => event.kind === 'agent_message');
  expect(delivered.filter(event => event.delivery === 'delivered' && event.message.text === 'PRIME_TO_WORKER_RECEIVED')).toHaveLength(1);
  expect(delivered.filter(event => event.delivery === 'delivered' && event.message.text === 'FORWARD_AFTER_WAKE_OK')).toHaveLength(1);
  const parentEvents = await readEvents(parent!.id);
  expect(parentEvents.filter(event => event.kind === 'agent_message' && event.delivery === 'delivered' && event.message.text === 'WORKER_TO_PRIME_OK')).toHaveLength(1);
  expect(parentEvents.filter(event => event.kind === 'agent_message' && event.delivery === 'delivered' && event.message.text === 'RETURN_AFTER_WAKE_OK')).toHaveLength(1);
});
