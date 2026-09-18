import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { recordChatObservations, recordToolCall, resetRecorderForTests } from '../src/main/session/recorder.js';
import { appendEvent, flushSessions, getSession, initSessionStore, readActivityEvents, readCompletedFinal,
  readEvents, readRecentEvents, resetSessionStoreForTests, sessionsRoot } from '../src/main/session/store.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;
beforeEach(async () => {
  dir = await makeTempDir('clf-completion-order-');
  initConfigPath(dir);
  initSessionStore(dir);
  resetRecorderForTests();
  await saveConfig(defaultConfig());
});
afterEach(async () => {
  await flushSessions();
  resetRecorderForTests();
  resetSessionStoreForTests();
  vi.restoreAllMocks();
  await removeTempDir(dir);
});

const chat = 'completed-order-chat';
const turn = 'completed-order-turn';
const requestId = 'wfr_completed_order';
const call = (startedAt: number, request = requestId) => recordToolCall({
  conversationId: chat, requestId: request, tool: 'read', args: { paths: ['/project/example.ts'] },
  content: [{ type: 'text', text: 'ok' }], outcome: 'ok', durationMs: 1, startedAt
});

async function completed(native = true) {
  const began = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(began);
  const opened = await recordChatObservations(chat, [
    { kind: 'user_message', time: began, messageId: 'question', text: 'Inspect the source.' },
    { kind: 'turn_start', time: began + 1, turnId: turn }
  ]);
  clock.mockReturnValue(began + 10);
  await call(Date.now());
  clock.mockReturnValue(began + 20);
  await recordChatObservations(chat, [
    { kind: 'assistant_message', time: Date.now(), turnId: turn, messageId: 'answer',
      ...(native ? { providerMessageId: '11111111-2222-4333-8444-555555555555' } : {}), text: 'The source is checked.',
      final: true, state: 'final', activeNow: true },
    { kind: 'turn_end', time: Date.now(), turnId: turn, outcome: 'completed' }
  ]);
  return { id: opened.sessionId!, began, clock };
}

describe('completed request ownership', () => {
  it.each([false, true])('retains the final and call order after trailing work (restart %s)', async restart => {
    const { id, began, clock } = await completed();
    if (restart) {
      await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
    }
    clock.mockReturnValue(began + 30);
    await call(Date.now());
    const events = await readEvents(id);
    const calls = events.filter(event => event.kind === 'tool_call');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ turnId: turn, time: began + 30 });
    expect(events.indexOf(calls[1]!)).toBeLessThan(events.findIndex(event => event.kind === 'assistant_message'));
    expect(await readCompletedFinal(id, chat)).toMatchObject({ messageId: 'answer', completedAt: began + 20 });
    expect((await getSession(id))?.activeTurnId).toBeNull();
  });

  it('projects legacy unowned calls from exact earlier request proof without rewriting events', async () => {
    const { id, began, clock } = await completed();
    const first = (await readEvents(id, { kinds: ['tool_call'] }))[0]!;
    if (first.kind !== 'tool_call') throw new Error('Expected recorded tool');
    clock.mockReturnValue(began + 30);
    const late = await appendEvent(id, { kind: 'tool_call', source: 'mcp', time: Date.now(),
      call: { ...first.call, callId: 'legacy-trailing-call' } });
    await flushSessions();
    const journalPath = path.join(sessionsRoot()!, id, 'events.jsonl');
    const original = await fs.readFile(journalPath, 'utf8');
    // Reproduce a current-watermark checkpoint from before request ownership was projected.
    for (const name of ['meta.json', 'meta.backup.json']) {
      const file = path.join(sessionsRoot()!, id, name);
      const meta = JSON.parse(await fs.readFile(file, 'utf8'));
      delete meta.requestTurns;
      await fs.writeFile(file, JSON.stringify(meta));
    }
    resetRecorderForTests(); resetSessionStoreForTests();
    const summary = await getSession(id);
    const origin = summary!.timelineTurns![turn]!.origin;
    const tail = await readRecentEvents(id, 3);
    expect(tail[0]).toMatchObject({ seq: late.seq, time: began + 30, turnOrigin: origin });
    expect(tail[1]?.kind).toBe('assistant_message');
    expect((await readActivityEvents(id, late.seq)).events[0]).toMatchObject({ seq: late.seq, turnOrigin: origin });
    expect((await readEvents(id, { from: late.seq }))[0]).toMatchObject({ seq: late.seq, turnOrigin: origin });
    expect(await readCompletedFinal(id, chat)).toMatchObject({ messageId: 'answer' });
    expect(await fs.readFile(journalPath, 'utf8')).toBe(original);
  });

  it('does not assign an old request to a newer generation', async () => {
    const { id, began, clock } = await completed();
    clock.mockReturnValue(began + 30);
    await recordChatObservations(chat, [
      { kind: 'user_message', time: Date.now(), messageId: 'next-question', text: 'Inspect another file.' },
      { kind: 'turn_start', time: Date.now(), turnId: 'next-turn' }
    ]);
    clock.mockReturnValue(began + 40);
    await call(Date.now());
    const events = await readEvents(id);
    const oldCall = events.find(event => event.kind === 'tool_call' && event.time === began + 40)!;
    expect(oldCall.turnId).toBe(turn);
    expect(events.indexOf(oldCall)).toBeLessThan(events.findIndex(event => event.kind === 'assistant_message'));
    expect((await getSession(id))?.activeTurnId).toBe('next-turn');
    expect(await readCompletedFinal(id, chat)).toBeNull();
  });

  it('treats a new request after the final as new work', async () => {
    const { id, began, clock } = await completed();
    clock.mockReturnValue(began + 30);
    await call(Date.now(), 'wfr_new_request');
    expect(await readCompletedFinal(id, chat)).toBeNull();
    const events = await readEvents(id);
    expect(events.at(-1)).toMatchObject({ kind: 'tool_call', call: { requestId: 'wfr_new_request' } });
  });

  it('still reopens a falsely completed view without native final proof', async () => {
    const { id, began, clock } = await completed(false);
    clock.mockReturnValue(began + 30);
    await call(Date.now());
    expect((await getSession(id))?.activeTurnId).toBe(turn);
    expect(await readCompletedFinal(id, chat)).toBeNull();
  });

  it('leaves contradictory request-to-turn proof unowned after reconstruction', async () => {
    const { id, began } = await completed();
    const first = (await readEvents(id, { kinds: ['tool_call'] }))[0]!;
    if (first.kind !== 'tool_call') throw new Error('Expected recorded tool');
    await appendEvent(id, { kind: 'turn_start', source: 'extension', time: began + 25, turnId: 'conflicting-turn' });
    await appendEvent(id, { kind: 'tool_call', source: 'mcp', time: began + 26, turnId: 'conflicting-turn',
      call: { ...first.call, callId: 'conflicting-call' } });
    await appendEvent(id, { kind: 'tool_call', source: 'mcp', time: began + 27,
      call: { ...first.call, callId: 'unowned-call' } });
    await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
    expect((await getSession(id))?.requestTurns?.[requestId]).toBeNull();
    const rows = await readEvents(id);
    expect(rows.find(event => event.kind === 'tool_call' && event.call.callId === 'unowned-call')?.turnOrigin).toBeNull();
    expect(await readCompletedFinal(id, chat)).toBeNull();
  });
});
