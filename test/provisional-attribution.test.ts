import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { requestCorrelation, restoreRequestCorrelations } from '../src/main/session/correlation.js';
import { captureRecordingContext, flushRecorder, freshCallOrigin, recordChatObservations, recordRequestEvidence,
  recordToolCall, recordingContextCurrent, repairDeterministicAttribution, resetRecorderForTests,
  sessionForConversation } from '../src/main/session/recorder.js';
import { flushSessions, getSession, indexedSessions, initSessionStore, readAsset, readEvents, rebindSession,
  resetSessionStoreForTests, unsetSessionRootForTests } from '../src/main/session/store.js';
import { dispatch, ok } from '../src/main/mcp/kernel.js';
import { withInboundRequestId } from '../src/main/mcp/inbound.js';
import { currentCaller } from '../src/main/mcp/call-context.js';
import type { RecordingContext } from '../src/main/session/recorder.js';

let directory: string;
const begin = async (chat = 'chat-a', turn = 'turn-a', at = Date.now() - 100) => {
  await recordChatObservations(chat, [{ kind: 'turn_start', time: at, turnId: turn }]);
  await prove(chat, `page-${chat}-${turn}`, at + 1);
  return (await sessionForConversation(chat))!;
};
const prove = (chat: string, requestId: string, time = Date.now()) => recordRequestEvidence(chat, [{
  kind: 'tool_evidence', time, fiberConversationId: chat,
  calls: [{ tool: '', messageId: `message-${requestId}`, requestId, order: 0, answered: false }]
}]);
const record = (requestId = 'hidden-workflow', recordingContext: RecordingContext | null = captureRecordingContext(Date.now()), text = 'ok') =>
  recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text }], outcome: 'ok',
    durationMs: 1, startedAt: Date.now(), requestId, recordingContext });
const calls = async (id: string) => (await readEvents(id, { kinds: ['tool_call'] })).filter(row => row.kind === 'tool_call');

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'cos-provisional-'));
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
  await saveConfig(defaultConfig());
});
afterEach(async () => {
  await flushRecorder(); await flushSessions(); await flushDurable();
  resetRecorderForTests(); resetSessionStoreForTests(); unsetSessionRootForTests(); resetDurableForTests();
  await rm(directory, { recursive: true, force: true });
});

it('records the unexposed second id in the sole evidenced turn without granting caller proof', async () => {
  const sessionId = await begin();
  const call = await record();
  expect(call).toMatchObject({ attribution: 'generation', attributionMethod: 'generation',
    conversationId: 'chat-a', requestId: 'hidden-workflow' });
  expect(await calls(sessionId)).toHaveLength(1);
  expect((await indexedSessions()).some(row => row.conversationId === null)).toBe(false);
  expect((await getSession(sessionId))?.provisionalToolCalls).toBe(1);
  expect(requestCorrelation('hidden-workflow')).toBeNull();
  expect(freshCallOrigin('read', Date.now(), 'hidden-workflow')).toBeNull();
});

it('never chooses one of two running chats', async () => {
  await begin(); await begin('chat-b', 'turn-b');
  expect(captureRecordingContext(Date.now())).toBeNull();
  expect(await record()).toMatchObject({ attributionMethod: 'unattributed', conversationId: null });
});

it('requires page evidence from this turn, not an old request seen before it', async () => {
  await prove('chat-a', 'old-request', Date.now() - 1000);
  await recordChatObservations('chat-a', [{ kind: 'turn_start', time: Date.now() - 10, turnId: 'fresh-turn' }]);
  expect(captureRecordingContext(Date.now())).toBeNull();
});

it('does not acquire a context from a different chat after recording admission', async () => {
  await begin();
  const context = captureRecordingContext(Date.now());
  const recording = record('hidden-workflow', context);
  await begin('chat-b', 'turn-b');
  await recordChatObservations('chat-b', [{ kind: 'turn_end', time: Date.now(), turnId: 'turn-b', outcome: 'completed' }]);
  expect(recordingContextCurrent(context)).toBe(false);
  expect(await recording).toMatchObject({ attributionMethod: 'unattributed', conversationId: null });
});

it('retains the captured turn when it completes during the exact-evidence grace', async () => {
  await begin();
  const recording = record();
  await recordChatObservations('chat-a', [{ kind: 'turn_end', time: Date.now(), turnId: 'turn-a', outcome: 'completed' }]);
  expect(await recording).toMatchObject({ attributionMethod: 'generation', conversationId: 'chat-a' });
  expect(await readEvents((await sessionForConversation('chat-a'))!, { kinds: ['turn_start'] })).toHaveLength(1);
});

it('drops a stopped turn and cannot carry its context into a subsequent question', async () => {
  await begin();
  const context = captureRecordingContext(Date.now());
  await recordChatObservations('chat-a', [{ kind: 'turn_end', time: Date.now(), turnId: 'turn-a', outcome: 'stopped' }]);
  expect(recordingContextCurrent(context)).toBe(false);
  await begin('chat-a', 'next-turn');
  expect(recordingContextCurrent(context)).toBe(false);
});

it('gives exact request evidence precedence, even when it identifies another chat', async () => {
  await begin();
  const recording = record();
  await prove('chat-b', 'hidden-workflow');
  expect(await recording).toMatchObject({ attributionMethod: 'request_id', conversationId: 'chat-b' });
});

it('upgrades late same-chat proof without duplicating the call or losing turn boundaries', async () => {
  const id = await begin();
  const original = await record();
  await prove('chat-a', 'hidden-workflow');
  await flushRecorder();
  expect(await calls(id)).toHaveLength(1);
  expect((await calls(id))[0]?.call).toMatchObject({ callId: original!.callId, attributionMethod: 'request_id' });
  expect((await readEvents(id, { kinds: ['turn_start'] }))).toHaveLength(1);
  expect((await getSession(id))?.provisionalToolCalls).toBe(0);
});

it('moves late conflicting proof with overflow assets and preserves unrelated transcript rows', async () => {
  const source = await begin();
  const text = 'complete output\n'.repeat(30_000);
  const original = await record('hidden-workflow', captureRecordingContext(Date.now()), text);
  await prove('chat-b', 'hidden-workflow');
  await flushRecorder();
  const target = (await sessionForConversation('chat-b'))!;
  expect(await calls(source)).toHaveLength(0);
  expect(await calls(target)).toHaveLength(1);
  expect((await calls(target))[0]?.call).toMatchObject({ callId: original!.callId, conversationId: 'chat-b', attributionMethod: 'request_id' });
  expect((await calls(target))[0]?.turnId).toBeUndefined();
  const transferred = (await calls(target))[0]!.call.result;
  expect(transferred.assetId).toBeTruthy();
  expect((await readAsset(target, transferred.assetId!))?.toString()).toBe(text);
  expect((await getSession(source))?.toolCalls).toBe(0);
  expect(await readEvents(source, { kinds: ['turn_start'] })).toHaveLength(1);
  await repairDeterministicAttribution();
  expect(await calls(target)).toHaveLength(1);
});

it('never promotes provisional history into exact correlations after a restart', async () => {
  const id = await begin();
  await record(); await flushRecorder(); await flushSessions(); await flushDurable();
  resetRecorderForTests(); resetSessionStoreForTests();
  await restoreRequestCorrelations();
  expect(requestCorrelation('hidden-workflow')).toBeNull();
  expect(captureRecordingContext(Date.now())).toBeNull();
  expect((await calls(id))[0]?.call.attributionMethod).toBe('generation');
});

it('does not append provisionally to a session whose conversation was replaced', async () => {
  const id = await begin();
  const context = captureRecordingContext(Date.now());
  await rebindSession(id, 'chat-a', 'chat-b');
  expect(await record('hidden-workflow', context)).toMatchObject({ attributionMethod: 'superseded' });
  expect(await calls(id)).toHaveLength(0);
});

it('requires the allow-unattributed preference', async () => {
  await begin();
  const config = defaultConfig();
  await saveConfig({ ...config, multiAgent: { ...config.multiAgent, allowUnattributedCalls: false } });
  expect(captureRecordingContext(Date.now())).toBeNull();
});

it('does not use provisional placement under strict chat allowlisting', async () => {
  await begin();
  const config = defaultConfig();
  await saveConfig({ ...config, multiAgent: { ...config.multiAgent, strictChatAllowlist: true } });
  expect(captureRecordingContext(Date.now())).toBeNull();
});

it('does not place a headerless call even if it carries a recording witness', async () => {
  await begin();
  expect(await record('')).toMatchObject({ attributionMethod: 'unattributed', conversationId: null });
});

it('keeps a provider workflow in its chat after an explicit mid-answer continuation', async () => {
  const id = await begin();
  const invoke = () => withInboundRequestId('cli-workflow', () => dispatch('exec_command', {}, null, 'cli-workflow', 'core', async () => {
    expect(currentCaller()?.conversationId).toBeNull();
    return ok('Godot CLI completed (exit 0)');
  }), undefined, undefined, true);
  await invoke(); await flushRecorder();
  expect((await calls(id))[0]?.call.attributionMethod).toBe('generation');
  const boundary = Date.now();
  await recordChatObservations('chat-a', [
    { kind: 'turn_end', time: boundary, turnId: 'turn-a', outcome: 'completed', continued: true },
    { kind: 'turn_start', time: boundary + 1, turnId: 'continued-turn' }
  ]);
  // ChatGPT exposes no new page-request ID, and keeps the CLI workflow ID.
  await invoke(); await flushRecorder();
  const rows = await calls(id);
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({ turnId: 'continued-turn', call: {
    requestId: 'cli-workflow', attributionMethod: 'generation', conversationId: 'chat-a'
  } });
  expect(requestCorrelation('cli-workflow')).toBeNull();
});

const continueTurn = async (from = 'turn-a', to = 'continued-turn') => {
  const time = Date.now();
  await recordChatObservations('chat-a', [{ kind: 'turn_end', time, turnId: from, outcome: 'completed', continued: true }]);
  await recordChatObservations('chat-a', [{ kind: 'turn_start', time, turnId: to }]);
};

it('anchors a continued response before its first tool arrives under an unseen request id', async () => {
  const id = await begin();
  // The page proved the original request, but no tool ran before the steering message.
  await continueTurn();
  await withInboundRequestId('first-cli-after-steering', () => dispatch('exec_command', {}, null,
    'first-cli-after-steering', 'core', async () => {
      expect(currentCaller()?.conversationId).toBeNull();
      return ok('CLI completed (exit 0)');
    }), undefined, undefined, true);
  await flushRecorder();
  expect(await calls(id)).toHaveLength(1);
  expect((await calls(id))[0]).toMatchObject({ turnId: 'continued-turn', call: {
    requestId: 'first-cli-after-steering', attributionMethod: 'generation', conversationId: 'chat-a'
  } });
  expect(requestCorrelation('first-cli-after-steering')).toBeNull();
});

it('keeps an in-flight CLI result in its original turn when a message continues the answer', async () => {
  const id = await begin();
  const originalContext = captureRecordingContext(Date.now());
  const pending = record('inflight-cli', originalContext);
  await continueTurn();
  expect(await pending).toMatchObject({ attributionMethod: 'generation' });
  expect((await calls(id))[0]?.turnId).toBe('turn-a');
  const next = captureRecordingContext(Date.now());
  expect(next?.turnId).toBe('continued-turn');
  expect(await record('inflight-cli', next)).toMatchObject({ attributionMethod: 'generation' });
  expect((await calls(id))[1]?.turnId).toBe('continued-turn');
});

it('carries the evidenced response across consecutive continuations and new workflow ids', async () => {
  await begin();
  captureRecordingContext(Date.now());
  await continueTurn();
  expect(await record('unseen-request')).toMatchObject({ attributionMethod: 'generation' });
  expect(captureRecordingContext(Date.now())?.turnId).toBe('continued-turn');
  await continueTurn('continued-turn', 'continued-again');
  expect(captureRecordingContext(Date.now())?.turnId).toBe('continued-again');
  expect(requestCorrelation('known-cli')).toBeNull();
});

it('does not carry a witnessed workflow into an ordinary later question', async () => {
  await begin();
  captureRecordingContext(Date.now());
  const time = Date.now();
  await recordChatObservations('chat-a', [
    { kind: 'turn_end', time, turnId: 'turn-a', outcome: 'completed' },
    { kind: 'turn_start', time: time + 1, turnId: 'new-question' }
  ]);
  expect(captureRecordingContext(Date.now())).toBeNull();
});

it.each(['completed', 'stopped'] as const)('does not forget another chat overlapped merely because it then %s', async outcome => {
  await begin();
  captureRecordingContext(Date.now());
  await begin('chat-b', 'other-turn');
  await recordChatObservations('chat-b', [{ kind: 'turn_end', time: Date.now(), turnId: 'other-turn', outcome }]);
  await continueTurn();
  expect(captureRecordingContext(Date.now())).toBeNull();
});

it('ignores a stale continued end for an older turn while another question is active', async () => {
  await begin();
  const original = captureRecordingContext(Date.now());
  await begin('chat-a', 'other-question');
  await recordChatObservations('chat-a', [{ kind: 'turn_end', time: Date.now(), turnId: 'turn-a', outcome: 'completed', continued: true }]);
  await continueTurn('other-question', 'third-turn');
  expect(recordingContextCurrent(original)).toBe(false);
  const current = captureRecordingContext(Date.now());
  expect(current?.turnId).toBe('third-turn');
  expect(current?.lineage).not.toBe(original?.lineage);
});

it('cannot seed a continued response from page evidence belonging to an older completed question', async () => {
  await prove('chat-a', 'historical-request', Date.now() - 1000);
  await recordChatObservations('chat-a', [{ kind: 'turn_start', time: Date.now() - 10, turnId: 'turn-a' }]);
  await continueTurn();
  expect(captureRecordingContext(Date.now())).toBeNull();
});

it('only provider ingress can capture presentation context; handlers retain unknown identity', async () => {
  const id = await begin();
  await withInboundRequestId('provider-hidden', () => dispatch('read', {}, null, 'provider-hidden', 'core', async () => {
    expect(currentCaller()?.conversationId).toBeNull();
    return ok('completed');
  }), undefined, undefined, true);
  await flushRecorder();
  expect((await calls(id))[0]?.call.attributionMethod).toBe('generation');
  await withInboundRequestId('local-hidden', () => dispatch('read', {}, null, 'local-hidden', 'core', async () => ok('local')));
  await flushRecorder();
  expect(await calls(id)).toHaveLength(1);
});
