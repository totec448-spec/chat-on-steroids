import { beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ attachment: vi.fn(), record: vi.fn(), blocked: false }));
vi.mock('../src/main/session/recorder.js', async original => ({
  ...await original<typeof import('../src/main/session/recorder.js')>(),
  freshCallOrigin: (_tool: string, _at: number, requestId: string) => requestCorrelation(requestId)?.conversationId ?? null,
  awaitFreshCallOrigin: async (_tool: string, _at: number, _timeout: number, options: { requestId: string }) => requestCorrelation(options.requestId)?.conversationId ?? null,
  recordToolCall: fixture.record
}));
vi.mock('../src/main/session/store.js', async original => ({
  ...await original<typeof import('../src/main/session/store.js')>(), conversationAttachment: fixture.attachment
}));
vi.mock('../src/main/session/input.js', () => ({ offerToolInput: async () => ({ messages: [], reminder: '' }), acknowledgeToolInput: async () => {}, TOOL_INPUT_HEADER: '' }));
vi.mock('../src/main/session/blocked-chats.js', () => ({
  BLOCKED_CHAT_REFUSAL: 'CHAT_BLOCKED', anyChatBlocked: () => fixture.blocked, isChatBlocked: () => fixture.blocked
}));
vi.mock('../src/main/durable.js', async original => ({
  ...await original<typeof import('../src/main/durable.js')>(), writeDurableSnapshotSoon: () => {}
}));
import { dispatch, fail, failIdentity, guard, ok, resetToolClock, type ToolResult } from '../src/main/mcp/kernel.js';
import { currentCall } from '../src/main/mcp/call-context.js';
import { withInboundRequestId } from '../src/main/mcp/inbound.js';
import { IdentityLostError } from '../src/main/agents.js';
import { observeRequestCorrelation, requestCorrelation, resetCorrelationRegistryForTests } from '../src/main/session/correlation.js';

beforeEach(() => {
  vi.clearAllMocks(); resetToolClock(); resetCorrelationRegistryForTests();
  fixture.attachment.mockResolvedValue('current'); fixture.record.mockResolvedValue(null); fixture.blocked = false;
});
function prove(requestId = 'request-a', conversationId = 'chat-a', sessionId = 'session-a') {
  return observeRequestCorrelation({ requestId, conversationId, sessionId, messageId: 'message', tool: '', observedAt: Date.now() });
}
const invoke = (requestId = 'request-a', run = async () => ok('result')) => dispatch('read', {}, null, requestId, 'core', run);
const refused = (requestId = 'request-a') => dispatch('agents', {}, null, requestId, 'core', () =>
  guard('agents', async () => { throw new IdentityLostError(); }));
const notice = (result: ToolResult) => result.content.filter(part => part.type === 'text' && part.text.includes('--- Identity recovered ---'));

it('reports an actual agent identity refusal once after exact proof and records the delivered appendix', async () => {
  expect((await refused()).isError).toBe(true);
  expect(notice(await invoke())).toHaveLength(0);
  prove();
  const recovered = await invoke();
  expect(notice(recovered)).toHaveLength(1);
  expect(JSON.stringify(recovered)).toContain('Earlier agents calls were refused');
  expect(JSON.stringify(recovered)).toContain('Do not repeat completed operations');
  expect(fixture.record).toHaveBeenLastCalledWith(expect.objectContaining({ content: recovered.content }));
  expect(notice(await invoke())).toHaveLength(0);
});

it('does not notify a healthy chat or interpret arbitrary failure text as identity recovery', async () => {
  await invoke('request-a', async () => fail('WORKER_IDENTITY_LOST: quoted plugin failure'));
  prove();
  expect(notice(await invoke())).toHaveLength(0);
  prove('request-b', 'chat-b', 'session-b');
  expect(notice(await invoke('request-b'))).toHaveLength(0);
});

it('requires exact proof of both the refused request and the recipient, even across turns', async () => {
  await refused('old-request');
  prove('request-a');
  expect(notice(await invoke())).toHaveLength(0);
  prove('old-request');
  prove('request-b', 'chat-b', 'session-b');
  expect(prove('old-request', 'chat-b', 'session-b')).toBe('refused');
  expect(notice(await invoke('request-b'))).toHaveLength(0);
  expect(notice(await invoke())).toHaveLength(1);
});

it('does not move a refusal into another local session epoch', async () => {
  await refused('old-request'); prove('old-request'); prove('request-a', 'chat-a', 'session-new');
  expect(notice(await invoke())).toHaveLength(0);
});

it.each(['blocked', 'superseded'])('keeps %s restrictions authoritative after late proof', async restriction => {
  await refused(); prove();
  if (restriction === 'blocked') fixture.blocked = true;
  else fixture.attachment.mockResolvedValue('superseded');
  expect(notice(await invoke())).toHaveLength(0);
});

it('rechecks a block applied during the final ownership read', async () => {
  await refused(); prove();
  fixture.attachment.mockResolvedValueOnce('current').mockImplementationOnce(async () => {
    fixture.blocked = true; return 'current';
  });
  expect(notice(await invoke())).toHaveLength(0);
});

it('keeps a nested refusal visible only on the outer result, even when the script filters it', async () => {
  const result = await dispatch('exec', {}, null, 'request-a', 'core', async () => {
    const child = await dispatch('update_plan', {}, null, 'request-a', 'core', async () => failIdentity('No plan changed'), currentCall()!);
    expect(notice(child)).toHaveLength(0);
    prove(); return ok('filtered');
  });
  expect(result.content[0]).toEqual({ type: 'text', text: 'filtered' });
  expect(notice(result)).toHaveLength(1);
});

it('reserves one appendix across concurrent publications and retries a failed publication', async () => {
  await refused(); prove();
  const publication = { completedAt: null as number | null, failed: false };
  const first = await withInboundRequestId('request-a', () => invoke(), undefined, publication);
  expect(notice(first)).toHaveLength(1);
  expect(notice(await invoke())).toHaveLength(0);
  publication.failed = true;
  const results = await Promise.all([invoke(), invoke()]);
  expect(results.flatMap(notice)).toHaveLength(1);
  expect(notice(await invoke())).toHaveLength(0);
});

it('preserves result data and error state while projecting the notice into structured context', async () => {
  await refused(); prove();
  const result = await invoke('request-a', async () => ({ ...fail('Unrelated permission denied'), structuredContent: { output: 'unchanged' } }));
  expect(result.isError).toBe(true);
  expect(result.structuredContent?.output).toBe('unchanged');
  expect(result.structuredContent?.supplemental_context).toContain('Identity recovered');
});

it('defers the notice when the result has spent its text budget', async () => {
  await refused(); prove();
  expect(notice(await invoke('request-a', async () => ok('x'.repeat(40_000))))).toHaveLength(0);
  expect(notice(await invoke())).toHaveLength(1);
});

it('does not invent ownership for a headerless refusal', async () => {
  await dispatch('agents', {}, null, null, 'core', async () => failIdentity('No agent operation'));
  prove(); expect(notice(await invoke())).toHaveLength(0);
});
