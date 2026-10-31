import { mkdtemp, rm } from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as store from '../src/main/session/store.js';
import { getLog } from '../src/main/logger.js';
import { positionOf } from '../src/shared/chronology.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { requestCorrelation, restoreRequestCorrelations, resetCorrelationRegistryForTests } from '../src/main/session/correlation.js';
import { captureRecordingContext, flushRecorder, freshCallOrigin, recordChatObservations, recordRequestEvidence,
  recordToolCall, recordingContextCurrent, repairDeterministicAttribution, resetRecorderForTests,
  sessionForConversation } from '../src/main/session/recorder.js';
import { flushSessions, getSession, indexedSessions, initSessionStore, readAsset, readEvents, rebindSession,
  resetSessionStoreForTests, unsetSessionRootForTests } from '../src/main/session/store.js';
import { dispatch, ok } from '../src/main/mcp/kernel.js';
import { withInboundRequestId } from '../src/main/mcp/inbound.js';
import { currentCaller, emptyEvidence } from '../src/main/mcp/call-context.js';
import type { ProcessCompletion } from '../src/main/codex/unified-exec.js';
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
  vi.restoreAllMocks();
  resetRecorderForTests(); resetSessionStoreForTests(); unsetSessionRootForTests(); resetDurableForTests();
  vi.useRealTimers();
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

it.each(['before relocation', 'after relocation', 'during relocation', 'without relocation',
  'with source read failure', 'with source write failure'] as const)(
  'records a provisional background command exit %s', async phase => {
    const source = await begin();
    let finish!: (completion: ProcessCompletion) => void;
    const completion = new Promise<ProcessCompletion>(resolve => { finish = resolve; });
    const call = await recordToolCall({ tool: 'exec_command', args: { cmd: 'fixture' },
      content: [{ type: 'text', text: 'initial output' }], startedAt: Date.now(), durationMs: 1, outcome: 'ok',
      requestId: 'background-workflow', recordingContext: captureRecordingContext(Date.now()),
      evidence: { ...emptyEvidence(), running: true, processSessionId: '1234', processCompletion: completion } });
    expect(call).toMatchObject({ attributionMethod: 'generation', process: { sessionId: '1234' } });
    const exit = { completedAt: Date.now(), durationMs: 42, exitCode: 7 };
    if (phase === 'before relocation') { finish(exit); await flushRecorder(); }
    let target = source;
    if (phase !== 'without relocation') {
      target = (await sessionForConversation('chat-b'))!;
      if (phase === 'during relocation') {
        const write = store.recordProcessCall;
        vi.spyOn(store, 'recordProcessCall').mockImplementation(async (id, event, admit) => {
          if (id === target) finish(exit);
          return write(id, event, admit);
        });
      }
      await prove('chat-b', 'background-workflow');
      await flushRecorder();
      expect(await calls(source)).toHaveLength(0);
    }
    if (phase === 'with source read failure') {
      const read = store.getSession;
      vi.spyOn(store, 'getSession').mockImplementation(id => id === source
        ? Promise.reject(new Error('Simulated source read failure')) : read(id));
    } else if (phase === 'with source write failure') {
      const complete = store.completeProcessCall;
      vi.spyOn(store, 'completeProcessCall').mockImplementation((id, ...args) => id === source
        ? Promise.reject(new Error('Simulated source write failure')) : complete(id, ...args));
    }
    if (phase !== 'before relocation') { finish(exit); await flushRecorder(); }
    const rows = await calls(target);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ call: { callId: call!.callId,
      process: { sessionId: '1234', ...exit }, summary: { metric: '✕ exit 7', tone: 'bad' } } });
    expect((await getSession(target))?.toolCalls).toBe(1);
    if (phase.includes('source')) expect(getLog().some(row => row.level === 'warn' &&
      row.message.includes(source) && row.message.includes(call!.callId))).toBe(true);
    expect(requestCorrelation('background-workflow')?.conversationId ?? null).toBe(phase === 'without relocation' ? null : 'chat-b');
  }
);

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
  const previousOrigin = (await calls(id))[0]!.origin;
  await prove('chat-a', 'hidden-workflow');
  await flushRecorder();
  expect(await calls(id)).toHaveLength(1);
  expect((await calls(id))[0]?.call).toMatchObject({ callId: original!.callId, attributionMethod: 'request_id' });
  expect((await calls(id))[0]?.origin).toBe(previousOrigin);
  expect((await readEvents(id, { kinds: ['turn_start'] }))).toHaveLength(1);
  expect((await getSession(id))?.provisionalToolCalls).toBe(0);
});

it('moves late conflicting proof with overflow assets and preserves unrelated transcript rows', async () => {
  const source = await begin();
  const text = 'complete output\n'.repeat(30_000);
  const original = await record('hidden-workflow', captureRecordingContext(Date.now()), text);
  const target = (await sessionForConversation('chat-b'))!;
  const textBefore = 'Existing destination history';
  for (let i = 0; i < 4; i++) await store.appendEvent(target, { kind: 'note', source: 'app', time: Date.now(),
    message: { text: textBefore, truncated: false, chars: textBefore.length } });
  await prove('chat-b', 'hidden-workflow');
  await flushRecorder();
  expect(await calls(source)).toHaveLength(0);
  expect(await calls(target)).toHaveLength(1);
  expect((await calls(target))[0]?.call).toMatchObject({ callId: original!.callId, conversationId: 'chat-b', attributionMethod: 'request_id' });
  expect((await calls(target))[0]?.turnId).toBeUndefined();
  const moved = (await calls(target))[0]!;
  expect(positionOf(moved)).toBe(moved.seq);
  expect(moved.seq).toBeGreaterThan(4);
  expect((await readEvents(target)).at(-1)).toMatchObject({ kind: 'tool_call', call: { callId: original!.callId } });
  const transferred = (await calls(target))[0]!.call.result;
  expect(transferred.assetId).toBeTruthy();
  expect((await readAsset(target, transferred.assetId!))?.toString()).toBe(text);
  expect((await getSession(source))?.toolCalls).toBe(0);
  expect(await readEvents(source, { kinds: ['turn_start'] })).toHaveLength(1);
  await repairDeterministicAttribution();
  expect(await calls(target)).toHaveLength(1);
});

it.each(['asset quota', 'destination append', 'source revision'] as const)(
  'continues repairs after a provisional %s failure and retries without duplication', async failure => {
    const source = await begin();
    const failed = (await record('failed-repair', captureRecordingContext(Date.now()), 'overflow result\n'.repeat(30_000)))!;
    const healthy = (await record('healthy-repair'))!;
    const legacy = (await record('legacy-repair', null))!;
    // Keep the background repair timer from racing the explicitly awaited pass on slow disks.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const target = (await sessionForConversation('chat-b'))!;
    const legacyTarget = (await sessionForConversation('chat-c'))!;
    if (failure === 'asset quota') {
      const write = store.writeAsset;
      vi.spyOn(store, 'writeAsset').mockImplementation((id, ...args) => {
        if (id === target) return Promise.reject(new Error('Session asset quota exceeded'));
        return write(id, ...args);
      });
    } else if (failure === 'destination append') {
      const append = store.appendEvent;
      vi.spyOn(store, 'appendEvent').mockImplementation((id, event) => {
        if (id === target && event.kind === 'tool_call' && event.call.callId === failed.callId) {
          return Promise.reject(new Error('Simulated destination disk failure'));
        }
        return append(id, event);
      });
    } else {
      const revise = store.reviseProvisionalCall;
      vi.spyOn(store, 'reviseProvisionalCall').mockImplementation((id, callId, replacement) => {
        if (id === source && callId === failed.callId) return Promise.reject(new Error('Simulated source disk failure'));
        return revise(id, callId, replacement);
      });
    }
    await prove('chat-b', 'failed-repair');
    await prove('chat-b', 'healthy-repair');
    await prove('chat-c', 'legacy-repair');
    await expect(repairDeterministicAttribution()).resolves.toMatchObject({ calls: 2 });
    expect((await calls(source)).map(row => row.call.callId)).toEqual([failed.callId]);
    expect((await calls(target)).some(row => row.call.callId === healthy.callId)).toBe(true);
    expect((await calls(legacyTarget)).map(row => row.call.callId)).toEqual([legacy.callId]);
    expect(getLog().some(row => row.level === 'warn' && row.message.includes(failed.callId) && row.message.includes('failed-repair'))).toBe(true);
    vi.restoreAllMocks();
    await repairDeterministicAttribution();
    expect(await calls(source)).toHaveLength(0);
    expect((await calls(target)).map(row => row.call.callId).sort()).toEqual([failed.callId, healthy.callId].sort());
  }
);

it.each(['source read', 'destination read', 'destination append'] as const)(
  'repairs later provisional calls after a legacy %s failure and retries without duplication', async failure => {
    const source = await begin();
    const provisional = (await record('later-provisional'))!;
    const first = (await record('legacy-first', null))!;
    const second = (await record('legacy-second', null))!;
    const legacySource = (await indexedSessions()).find(row => row.conversationId === null)!.id;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const target = (await sessionForConversation('chat-b'))!;
    const legacyTarget = (await sessionForConversation('chat-c'))!;
    await prove('chat-b', 'later-provisional');
    await prove('chat-c', 'legacy-first');
    await prove('chat-c', 'legacy-second');
    const order = (await indexedSessions()).map(row => row.id);
    expect(order.indexOf(legacySource)).toBeLessThan(order.indexOf(source));
    if (failure === 'source read' || failure === 'destination read') {
      const read = store.readEvents;
      vi.spyOn(store, 'readEvents').mockImplementation((id, options) => id === (failure === 'source read' ? legacySource : legacyTarget)
        ? Promise.reject(new Error(`Simulated ${failure} failure`)) : read(id, options));
    } else {
      const append = store.appendEvent;
      vi.spyOn(store, 'appendEvent').mockImplementation((id, event) =>
        id === legacyTarget && event.kind === 'tool_call' && event.call.callId === second.callId
          ? Promise.reject(new Error('Simulated destination append failure')) : append(id, event));
    }
    await expect(repairDeterministicAttribution()).resolves.toBeDefined();
    vi.restoreAllMocks();
    expect((await calls(legacySource)).map(row => row.call.callId)).toEqual([first.callId, second.callId]);
    expect((await calls(target)).map(row => row.call.callId)).toEqual([provisional.callId]);
    expect(await calls(source)).toHaveLength(0);
    expect(await calls(legacyTarget)).toHaveLength(failure === 'destination append' ? 1 : 0);
    expect(getLog().some(row => row.level === 'warn' && row.message.includes(legacySource) &&
      row.message.includes('failed'))).toBe(true);
    await repairDeterministicAttribution(new Set(['unrelated-trigger']));
    expect((await calls(legacyTarget)).map(row => row.call.callId).sort()).toEqual([first.callId, second.callId].sort());
    expect(await calls(legacySource)).toHaveLength(0);
  }
);

it('continues after an unreadable provisional source and repairs it on a later trigger', async () => {
  const healthySource = await begin();
  const healthy = (await record('healthy-source'))!;
  await recordChatObservations('chat-a', [{ kind: 'turn_end', time: Date.now(), turnId: 'turn-a', outcome: 'completed' }]);
  const failedSource = await begin('chat-b', 'turn-b');
  const failed = (await record('unreadable-source'))!;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const healthyTarget = (await sessionForConversation('chat-c'))!;
  const failedTarget = (await sessionForConversation('chat-d'))!;
  await prove('chat-c', 'healthy-source');
  await prove('chat-d', 'unreadable-source');
  const order = (await indexedSessions()).map(row => row.id);
  expect(order.indexOf(failedSource)).toBeLessThan(order.indexOf(healthySource));
  const read = store.readEvents;
  vi.spyOn(store, 'readEvents').mockImplementation((id, options) => id === failedSource
    ? Promise.reject(new Error('Simulated source read failure')) : read(id, options));
  await expect(repairDeterministicAttribution()).resolves.toMatchObject({ calls: 1 });
  vi.restoreAllMocks();
  expect((await calls(healthyTarget)).map(row => row.call.callId)).toEqual([healthy.callId]);
  expect(await calls(healthySource)).toHaveLength(0);
  expect((await calls(failedSource)).map(row => row.call.callId)).toEqual([failed.callId]);
  expect(await calls(failedTarget)).toHaveLength(0);
  expect(getLog().some(row => row.level === 'warn' && row.message.includes(failedSource) && row.message.includes('failed'))).toBe(true);
  await repairDeterministicAttribution(new Set(['unrelated-trigger']));
  expect((await calls(failedTarget)).map(row => row.call.callId)).toEqual([failed.callId]);
  expect(await calls(failedSource)).toHaveLength(0);
});

it.each(['transient error', 'persistent error', 'lost exact proof'] as const)(
  'uses one delayed storage retry without a page sighting: %s', async scenario => {
    const source = await begin();
    const original = (await record('retry-workflow'))!;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const target = (await sessionForConversation('chat-b'))!;
    await prove('chat-b', 'retry-workflow');
    const read = store.readEvents;
    let attempts = 0;
    const fault = vi.spyOn(store, 'readEvents').mockImplementation((id, options) => {
      if (id === source && (++attempts === 1 || scenario === 'persistent error')) {
        return Promise.reject(new Error('Simulated storage interruption'));
      }
      return read(id, options);
    });
    await repairDeterministicAttribution();
    expect(attempts).toBe(1);
    expect(getLog().some(row => row.message.includes('scheduling one retry in 1000ms'))).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(attempts).toBe(1);
    if (scenario === 'lost exact proof') resetCorrelationRegistryForTests();
    await vi.advanceTimersByTimeAsync(1);
    await flushRecorder();
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    await flushRecorder();
    expect(attempts).toBe(2);
    fault.mockRestore();
    if (scenario === 'transient error') {
      expect(await calls(source)).toHaveLength(0);
      expect((await calls(target)).map(row => row.call.callId)).toEqual([original.callId]);
    } else {
      expect((await calls(source)).map(row => row.call.callId)).toEqual([original.callId]);
      expect(await calls(target)).toHaveLength(0);
      if (scenario === 'lost exact proof') expect(requestCorrelation('retry-workflow')).toBeNull();
      else {
        expect(getLog().some(row => row.message.includes('automatic storage retry exhausted'))).toBe(true);
        await prove('chat-b', 'fresh-trigger');
        await vi.advanceTimersByTimeAsync(250);
        await flushRecorder();
        expect(await calls(source)).toHaveLength(0);
        expect((await calls(target)).map(row => row.call.callId)).toEqual([original.callId]);
      }
    }
  }
);

it('logs a missing source asset and leaves its provisional call available for repair', async () => {
  const source = await begin();
  const original = (await record('missing-asset', captureRecordingContext(Date.now()), 'overflow result\n'.repeat(30_000)))!;
  await fs.rm(path.join(directory, 'sessions', source, 'assets', original.result.assetId!));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const target = (await sessionForConversation('chat-b'))!;
  await prove('chat-b', 'missing-asset');
  await repairDeterministicAttribution();
  expect(await calls(source)).toHaveLength(1);
  expect(await calls(target)).toHaveLength(0);
  expect(getLog().some(row => row.message.includes(original.callId) && row.message.includes('missing-asset') && row.message.includes('source asset is missing'))).toBe(true);
});

it('logs a lost recording context during asset preparation before filing the call as unattributed', async () => {
  const source = await begin();
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const write = fs.writeFile.bind(fs);
  let held = false;
  vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
    if (!held && String(args[0]).includes(source) && String(args[0]).includes(`${path.sep}assets${path.sep}`)) {
      held = true; enter(); await released;
    }
    return write(...args);
  });
  const recording = record('lost-context', captureRecordingContext(Date.now()), 'overflow result\n'.repeat(30_000));
  try {
    await entered;
    await recordChatObservations('chat-a', [{ kind: 'turn_end', time: Date.now(), turnId: 'turn-a', outcome: 'stopped' }]);
  } finally { release(); }
  expect(await recording).toMatchObject({ attributionMethod: 'unattributed', conversationId: null });
  expect(await calls(source)).toHaveLength(0);
  expect(getLog().some(row => row.message.includes('lost-context') && row.message.includes('recording context no longer current'))).toBe(true);
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
  const result = await withInboundRequestId('provider-hidden', () => dispatch('read', {}, null, 'provider-hidden', 'core', async () => {
    expect(currentCaller()?.conversationId).toBeNull();
    return ok('completed');
  }), undefined, undefined, true);
  const text = result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  expect(text).toContain('--- Recording context ---');
  expect(text).toContain('Use the process and run ids returned to this request; later exact proof attaches that state to its chat.');
  expect(text).not.toContain('next attribution recovery check');
  await flushRecorder();
  expect((await calls(id))[0]?.call.attributionMethod).toBe('generation');
  await withInboundRequestId('local-hidden', () => dispatch('read', {}, null, 'local-hidden', 'core', async () => ok('local')));
  await flushRecorder();
  expect(await calls(id)).toHaveLength(1);
});
