import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { emptyEvidence } from '../src/main/mcp/call-context.js';
import { flushRecorder, recordToolCall, resetRecorderForTests } from '../src/main/session/recorder.js';
import { appendEvent, completeProcessCall, createSession, flushSessions, getSession, initSessionStore,
  readActivityEvents, readEvents, readRecentEvents, recordProcessCall, resetSessionStoreForTests, turnHasMcpCall } from '../src/main/session/store.js';
import { foldProgress, toolCallSummary, workSequence, type SessionEvent } from '../src/shared/session.js';
import { UnifiedExecProcessManager, type ProcessCompletion } from '../src/main/codex/unified-exec.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;
beforeEach(async () => {
  dir = await makeTempDir('process-history-');
  initSessionStore(dir); initConfigPath(dir);
  await saveConfig(defaultConfig());
});
afterEach(async () => {
  await flushRecorder(); await flushSessions();
  resetRecorderForTests(); resetSessionStoreForTests();
  await removeTempDir(dir);
});

function launch(callId: string, conversationId: string): Omit<Extract<SessionEvent, { kind: 'tool_call' }>, 'seq'> {
  return { kind: 'tool_call', source: 'mcp', time: 100, turnId: 'turn', call: {
    callId, conversationId, requestId: 'request', attribution: 'request_id', attributionMethod: 'request_id',
    tool: 'exec_command', args: { text: '{}', chars: 2, truncated: false },
    result: { text: 'initial output', chars: 14, truncated: false }, durationMs: 10, outcome: 'ok',
    process: { sessionId: '1234' }, summary: { kind: 'run', tone: 'neutral', title: 'Started fixture', metric: 'running' }
  } };
}

it('revises the exact launch once, preserves chronology and survives a cold history read', async () => {
  const session = await createSession({ conversationId: 'owner', title: 'process' });
  await recordProcessCall(session.id, launch('call-one', 'owner'));
  const initial = (await readEvents(session.id)).find(e => e.kind === 'tool_call')!;
  await appendEvent(session.id, { kind: 'progress', source: 'app', time: 150, message: { text: 'later', chars: 5, truncated: false } });
  const count = (await getSession(session.id))!.toolCalls;
  await completeProcessCall(session.id, 'call-one', { completedAt: 200, durationMs: 100, exitCode: 7 });
  await completeProcessCall(session.id, 'call-one', { completedAt: 300, durationMs: 200, exitCode: 0 });
  const delta = await readEvents(session.id, { from: initial.seq + 1 });
  const completed = delta.find(e => e.kind === 'tool_call')!;
  expect(completed).toMatchObject({ origin: initial.seq, time: 100, call: {
    result: { text: 'initial output' }, process: { exitCode: 7, completedAt: 200 }, summary: { metric: '✕ exit 7', tone: 'bad' }
  } });
  expect(foldProgress([initial, completed]).filter(e => e.kind === 'tool_call')).toEqual([completed]);
  expect((await getSession(session.id))!.toolCalls).toBe(count);
  await flushSessions(); resetSessionStoreForTests(); initSessionStore(dir);
  expect((await readRecentEvents(session.id, 10)).filter(e => e.kind === 'tool_call')).toEqual([completed]);
  expect((await readEvents(session.id)).filter(e => e.kind === 'tool_call')).toEqual([completed]);
  expect((await readActivityEvents(session.id, initial.seq + 1)).events).toContainEqual(completed);
  expect(await turnHasMcpCall(session.id, 'owner', 'turn')).toBe(true);
  expect(await turnHasMcpCall(session.id, 'foreign', 'turn')).toBe(false);
  expect((await getSession(session.id))!.toolCalls).toBe(count);
});

it('does not cross sessions or reused numeric process ids', async () => {
  const a = await createSession({ conversationId: 'a', title: 'a' });
  const b = await createSession({ conversationId: 'b', title: 'b' });
  await recordProcessCall(a.id, launch('old-call', 'a'));
  await recordProcessCall(a.id, launch('new-call', 'a'));
  await recordProcessCall(b.id, launch('foreign-call', 'b'));
  await completeProcessCall(b.id, 'old-call', { completedAt: 200, durationMs: 100, exitCode: 1 });
  await completeProcessCall(a.id, 'old-call', { completedAt: 200, durationMs: 100, exitCode: 0 });
  const calls = [...await readEvents(a.id), ...await readEvents(b.id)].filter(e => e.kind === 'tool_call');
  expect(calls.map(e => [e.call.callId, e.call.process?.exitCode])).toEqual([
    ['old-call', 0], ['new-call', undefined], ['foreign-call', undefined]
  ]);
});

it('keeps a late exit out of work boundaries, pagination and cold finish replay', async () => {
  const session = await createSession({ conversationId: 'owner', title: 'process' });
  await appendEvent(session.id, { kind: 'session_start', source: 'app', time: 80, conversationId: 'owner', title: 'process' });
  await appendEvent(session.id, { kind: 'turn_start', source: 'extension', turnId: 'turn', time: 90 });
  await recordProcessCall(session.id, launch('first', 'owner'));
  const first = (await readRecentEvents(session.id, 1))[0]!;
  await recordProcessCall(session.id, launch('second', 'owner'));
  const second = (await readRecentEvents(session.id, 1))[0]!;
  await appendEvent(session.id, { kind: 'turn_end', source: 'extension', turnId: 'turn', time: 150, outcome: 'completed' });
  const before = (await getSession(session.id))!;
  await completeProcessCall(session.id, 'first', { completedAt: 200, durationMs: 100, exitCode: 0 });
  expect((await readRecentEvents(session.id, 1, { kinds: ['tool_call'] }))[0]).toEqual(second);
  const older = (await readRecentEvents(session.id, 1, { before: second.seq, kinds: ['tool_call'] }))[0]!;
  expect(workSequence(older)).toBe(first.seq);
  expect(older).toMatchObject({ call: { process: { exitCode: 0 } } });
  await flushSessions(); resetSessionStoreForTests();
  const metaPath = path.join(dir, 'sessions', session.id, 'meta.json');
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  meta.__historySeq = 0; // Simulate an exit shard committed before its metadata checkpoint.
  await fs.writeFile(metaPath, JSON.stringify(meta));
  initSessionStore(dir);
  expect(await getSession(session.id)).toMatchObject({ activeTurnId: null, toolCalls: before.toolCalls,
    lastToolCallAt: before.lastToolCallAt, updatedAt: before.updatedAt,
    finishTurn: { workSeq: second.seq } });
});

it('does not claim a legacy launch is still running or invent its exit code', () => {
  const call = launch('legacy', 'owner').call;
  expect(toolCallSummary(call)).toMatchObject({ metric: 'started', tone: 'neutral' });
  expect(call.summary.metric).toBe('running');
});

it('records an exit already resolved before recorder admission without another model call', async () => {
  const session = await createSession({ conversationId: 'owner', title: 'process' });
  const completion = Promise.resolve<ProcessCompletion>({ completedAt: 200, durationMs: 100, exitCode: 0 });
  await recordToolCall({ tool: 'exec_command', args: { cmd: 'fixture' }, content: [{ type: 'text', text: 'initial' }],
    startedAt: 100, durationMs: 10, outcome: 'ok', conversationId: 'owner', sessionId: session.id,
    requestId: 'request', evidence: { ...emptyEvidence(), running: true, processSessionId: '1234', processCompletion: completion } });
  await flushRecorder();
  expect((await readEvents(session.id)).find(e => e.kind === 'tool_call')).toMatchObject({ call: {
    process: { exitCode: 0, completedAt: 200 }, summary: { metric: '✓ finished' }
  } });
});

it('real process exit updates history while all output remains available to its owner', async () => {
  const session = await createSession({ conversationId: 'owner', title: 'process' });
  const manager = new UnifiedExecProcessManager(60_000);
  const id = manager.allocateProcessId();
  try {
    const output = await manager.execCommand({ processId: id, command: [process.execPath, '-e',
      'setTimeout(() => { console.log("retained"); process.exitCode = 7; }, 650)'],
      shellType: process.platform === 'win32' ? 'powershell' : 'bash', hookCommand: 'fixture', cwd: dir, displayCwd: dir,
      env: process.env, tty: false, yieldTimeMs: 250, maxOutputTokens: undefined, truncationPolicy: { kind: 'tokens', tokens: 1000 } });
    expect(output.processId).toBe(id);
    await recordToolCall({ tool: 'exec_command', args: { cmd: 'fixture' }, content: [{ type: 'text', text: 'initial' }],
      startedAt: Date.now(), durationMs: 250, outcome: 'ok', conversationId: 'owner', sessionId: session.id,
      requestId: 'request', evidence: { ...emptyEvidence(), running: true, processSessionId: String(id), processCompletion: output.completion } });
    await output.completion; await flushRecorder();
    expect((await readEvents(session.id)).find(e => e.kind === 'tool_call')).toMatchObject({ call: { process: { exitCode: 7 } } });
    await expect.poll(async () => manager.offerCompletedOutput(new Set([id]), { completedAt: null, failed: false }, 1000)).toMatchObject({ exitCode: 7, output: 'retained\n' });
  } finally { await manager.terminateAllProcesses(); }
});
