import { beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
const broker = vi.hoisted(() => ({
  offer: vi.fn(), ack: vi.fn(), bareOffer: vi.fn(), bareAck: vi.fn(), release: vi.fn(), alive: vi.fn(), record: vi.fn(),
  reactivate: vi.fn(), sleep: vi.fn(), stage: vi.fn(), persist: vi.fn(), revive: vi.fn(), origin: vi.fn(), toolRecord: vi.fn(),
  ackInput: vi.fn(), offerInput: vi.fn()
}));
vi.mock('../src/main/agents.js', async (original) => ({
  ...await original<typeof import('../src/main/agents.js')>(),
  agentForCaller: () => 'worker-1', agentForFinishCaller: () => 'worker-1',
  offerMessagesForConversation: broker.offer, acknowledgeOffersForConversation: broker.ack,
  offerMessages: broker.bareOffer, acknowledgeOffers: broker.bareAck,
  currentRunId: (conversationId?: string) => conversationId ? `run-${conversationId}` : null,
  releaseQuiescentRun: broker.release,
  noteAgentAlive: broker.alive,
  reactivateDormantRunForConversation: broker.reactivate,
  sleepSilentDetachedWorkers: broker.sleep,
  stageQueuedWorkerRevivals: broker.stage,
  persistCriticalSwarmNow: broker.persist,
  requestWorkerRevivals: broker.revive
}));
vi.mock('../src/main/session/recorder.js', async (original) => ({
  ...await original<typeof import('../src/main/session/recorder.js')>(),
  freshCallOrigin: (tool: string, at: number, request: string | null) => broker.origin(tool, at, request),
  recordToolCall: broker.toolRecord, recordAgentMessage: broker.record
}));
vi.mock('../src/main/session/store.js', async (original) => ({
  ...await original<typeof import('../src/main/session/store.js')>(), conversationAttachment: async () => 'current'
}));
vi.mock('../src/main/session/input.js', () => ({
  offerToolInput: broker.offerInput,
  acknowledgeToolInput: broker.ackInput,
  TOOL_INPUT_HEADER: '\n--- New instructions from the user ---\n'
}));
import { createRegistrar, dispatch, ok } from '../src/main/mcp/kernel.js';
import { currentCall } from '../src/main/mcp/call-context.js';
import { withInboundRequestId } from '../src/main/mcp/inbound.js';
import { defaultConfig } from '../src/main/config.js';
beforeEach(() => {
  vi.clearAllMocks();
  broker.origin.mockImplementation((_tool: string, _at: number, request: string | null) => request?.startsWith('req-') ? request.slice(4) : null);
  broker.alive.mockReturnValue(null);
  broker.sleep.mockReturnValue([]);
  broker.stage.mockReturnValue({ waking: [], commit: vi.fn(), rollback: vi.fn() });
  broker.persist.mockResolvedValue(true);
  broker.offer.mockImplementation((conversationId) => conversationId ? { agentId: 'worker-1', messages: [{ id: `m-${conversationId}`, from: 'prime', text: `private-${conversationId}`, offers: 1 }] } : null);
  broker.ack.mockReturnValue(null);
  broker.bareOffer.mockReturnValue([{ id: 'foreign', from: 'prime', text: 'foreign-private', offers: 1 }]);
  broker.toolRecord.mockResolvedValue(null);
  broker.ackInput.mockResolvedValue(undefined);
  broker.offerInput.mockResolvedValue({ messages: [], reminder: '' });
});
it('records same-named worker liveness reports under the exact author conversation', async () => {
  broker.alive.mockImplementation((conversationId) => ({ report: { id: `report-${conversationId}`, from: 'worker-1', to: 'prime', text: 'active again' } }));
  const call = handler();
  await Promise.all([call('req-chat-a'), call('req-chat-b')]);
  expect(broker.record).toHaveBeenCalledWith(expect.objectContaining({ id: 'report-chat-a' }), 'sent', 'chat-a');
  expect(broker.record).toHaveBeenCalledWith(expect.objectContaining({ id: 'report-chat-b' }), 'sent', 'chat-b');
});
function handler() {
  let call!: (args: object) => Promise<{ content: Array<{ text?: string }> }>;
  const server = { registerTool: (_name: string, _schema: unknown, callback: typeof call) => { call = callback; } };
  const registrar = createRegistrar(server as never, { roots: [], caps: defaultConfig().capabilities, readOnly: true }, 'core');
  registrar.register('read', { description: 'test real dispatch', inputSchema: z.object({}) }, async () => ok('result'));
  return (requestId: string | null) => withInboundRequestId(requestId, () => call({}));
}
it('routes identical friendly workers through their exact conversation inbox and run cleanup', async () => {
  const call = handler();
  const [a, b] = await Promise.all([call('req-chat-a'), call('req-chat-b')]);
  expect(JSON.stringify(a)).toContain('private-chat-a'); expect(JSON.stringify(a)).not.toContain('private-chat-b');
  expect(JSON.stringify(b)).toContain('private-chat-b'); expect(JSON.stringify(b)).not.toContain('private-chat-a');
  expect(JSON.stringify(a)).toContain('• prime: private-chat-a');
  expect(JSON.stringify(a)).not.toContain('m-chat-a');
  expect(broker.release).toHaveBeenCalledWith({}, 'run-chat-a');
  expect(broker.release).toHaveBeenCalledWith({}, 'run-chat-b');
  expect(broker.bareOffer).not.toHaveBeenCalled(); expect(broker.bareAck).not.toHaveBeenCalled();
});
it('does not fall back to a friendly-id inbox when exact conversation ownership abstains', async () => {
  const result = await handler()(null);
  expect(JSON.stringify(result)).not.toContain('foreign-private');
  expect(broker.bareOffer).not.toHaveBeenCalled(); expect(broker.bareAck).not.toHaveBeenCalled();
  expect(broker.release).not.toHaveBeenCalled();
});

it('offers and acknowledges the worker inbox only on the outer call, outside nested filtering', async () => {
  const registrar = createRegistrar(null, { roots: [], caps: defaultConfig().capabilities, readOnly: true }, 'core');
  registrar.register('read', { description: 'fixture', inputSchema: z.object({}) }, async () => ok('private tool value'));
  const result = await dispatch('exec', {}, null, 'req-chat-a', 'core', async () => {
    const parent = currentCall()!;
    const children = await Promise.all([registrar.invokeNested('read', {}, parent), registrar.invokeNested('read', {}, parent)]);
    expect(children).toEqual([ok('private tool value'), ok('private tool value')]);
    expect(broker.offer).not.toHaveBeenCalled();
    expect(broker.ack).not.toHaveBeenCalled();
    return ok('filtered');
  });
  expect(broker.offer).toHaveBeenCalledTimes(1);
  expect(broker.ack).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).toContain('private-chat-a');
  expect(JSON.stringify(result)).not.toContain('private tool value');
});

it('keeps direct remote_steering identity-neutral and free of ordinary broker lifecycle effects', async () => {
  broker.sleep.mockReturnValue([
    {
      info: { id: 'worker-quiet', conversationId: 'quiet-chat', runId: 'run-quiet' },
      report: { id: 'quiet-report', from: 'worker-quiet', to: 'prime', text: 'quiet' }
    }
  ]);
  const result = await remoteHandler()('req-chat-a');

  expect(result).toEqual(ok('signed-only'));
  expect(broker.origin).not.toHaveBeenCalled();
  expect(broker.reactivate).not.toHaveBeenCalled();
  expect(broker.sleep).not.toHaveBeenCalled();
  expect(broker.alive).not.toHaveBeenCalled();
  expect(broker.stage).not.toHaveBeenCalled();
  expect(broker.persist).not.toHaveBeenCalled();
  expect(broker.revive).not.toHaveBeenCalled();
  expect(broker.ack).not.toHaveBeenCalled();
  expect(broker.offer).not.toHaveBeenCalled();
  expect(broker.release).not.toHaveBeenCalled();
  expect(broker.ackInput).not.toHaveBeenCalled();
  expect(broker.offerInput).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain('private-chat-a');
  expect(broker.toolRecord).toHaveBeenCalledWith(expect.objectContaining({
    tool: 'remote_steering',
    agent: null,
    conversationId: null,
    sessionId: null
  }));
});

function remoteHandler() {
  let call!: (args: object) => Promise<{ content: Array<{ text?: string }> }>;
  const server = { registerTool: (_name: string, _schema: unknown, callback: typeof call) => { call = callback; } };
  const registrar = createRegistrar(server as never, { roots: [], caps: defaultConfig().capabilities, readOnly: true }, 'core');
  registrar.register('remote_steering', { description: 'signed lane fixture', inputSchema: z.object({}) }, async () => ok('signed-only'));
  return (requestId: string | null) => withInboundRequestId(requestId, () => call({}));
}
