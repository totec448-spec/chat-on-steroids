import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { liveConversations, recordChatObservations, recordToolCall, resetRecorderForTests } from '../src/main/session/recorder.js';
import { appendEvent, flushSessions, getSession, initSessionStore, readActivityEvents, readCompletedFinal,
  readEvents, readLatestUserMessage, readRecoveryBoundary, resetSessionStoreForTests, sessionsRoot } from '../src/main/session/store.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;
beforeEach(async () => {
  dir = await makeTempDir('clf-response-identity-');
  initConfigPath(dir); initSessionStore(dir); resetRecorderForTests();
  await saveConfig(defaultConfig());
});
afterEach(async () => {
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests(); vi.restoreAllMocks();
  await removeTempDir(dir);
});

const chat = 'split-response-chat';
const first = 'g-first-document-0-1', second = 'g-second-document-0-1';
const requestId = 'wfr_one_native_response';
const stored = (text: string) => ({ text, chars: text.length, truncated: false });

async function split(options: { newQuestion?: boolean; newRequest?: boolean; endedBefore?: boolean; live?: boolean; trailingOldRequest?: boolean } = {}) {
  const at = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
  const opened = await recordChatObservations(chat, [
    { kind: 'user_message', time: at, messageId: 'native-question', text: 'Review the changes.' },
    { kind: 'turn_start', time: at + 1, turnId: first }
  ]);
  const id = opened.sessionId!;
  clock.mockReturnValue(at + 10);
  await recordToolCall({ conversationId: chat, requestId, tool: 'read', args: { paths: ['/project/example.ts'] },
    content: [{ type: 'text', text: 'ok' }], outcome: 'ok', durationMs: 1, startedAt: Date.now() });
  const [template] = (await readEvents(id)).filter(event => event.kind === 'tool_call');
  await appendEvent(id, { kind: 'user_message', source: 'app', time: at + 11, turnId: first,
    inputId: 'correction', messageId: 'input:correction', message: stored('For this project, obviously.') });
  if (options.endedBefore) await recordChatObservations(chat, [
    { kind: 'turn_end', time: at + 12, turnId: first, outcome: 'completed' }
  ]);
  if (options.newQuestion) await recordChatObservations(chat, [
    { kind: 'user_message', time: at + 13, messageId: 'different-native-question', text: 'A different task.' }
  ]);
  clock.mockReturnValue(at + 20);
  await recordChatObservations(chat, [{ kind: 'turn_start', time: Date.now(), turnId: second }]);
  clock.mockReturnValue(at + 30);
  if (options.live) await recordToolCall({ conversationId: chat, requestId, tool: 'read', args: {},
    content: [{ type: 'text', text: 'another result' }], outcome: 'ok', durationMs: 1, startedAt: Date.now() });
  else await appendEvent(id, { kind: 'tool_call', source: 'mcp', time: Date.now(), turnId: second,
    call: { ...template!.call, callId: 'second-call', requestId: options.newRequest ? 'wfr_different_response' : requestId } });
  if (options.trailingOldRequest) {
    clock.mockReturnValue(at + 35);
    await recordToolCall({ conversationId: chat, requestId, tool: 'read', args: {},
      content: [{ type: 'text', text: 'late result from the original request' }], outcome: 'ok', durationMs: 1, startedAt: Date.now() });
  }
  clock.mockReturnValue(at + 40);
  await recordChatObservations(chat, [{ kind: 'assistant_message', time: Date.now(), turnId: first,
    messageId: 'native-answer', providerMessageId: '11111111-2222-4333-8444-555555555555',
    text: 'The review is complete.', final: true, state: 'final', activeNow: true }]);
  if (!options.live) await recordChatObservations(chat, [
    { kind: 'turn_end', time: at + 41, turnId: first, outcome: 'completed' },
    { kind: 'turn_end', time: at + 42, turnId: second, outcome: 'completed' }
  ]);
  return { id, at, clock };
}

describe('one native response observed in two documents', () => {
  it.each([false, true])('keeps its final after every call and settles both local fragments (legacy rebuild %s)', async rebuild => {
    const { id } = await split();
    await flushSessions();
    const journal = path.join(sessionsRoot(), id, 'events.jsonl');
    const before = await fs.readFile(journal, 'utf8');
    if (rebuild) {
      const metaPath = path.join(sessionsRoot(), id, 'meta.json');
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
      delete meta.nativeQuestion;
      delete meta.requestTurns;
      await fs.writeFile(metaPath, JSON.stringify(meta));
      resetRecorderForTests(); resetSessionStoreForTests();
    }
    expect(await readLatestUserMessage(id, second)).toMatchObject({ messageId: 'native-question' });
    expect(await readCompletedFinal(id, chat, second)).toMatchObject({ messageId: 'native-answer' });
    expect(await readCompletedFinal(id, chat)).not.toBeNull();
    const events = await readEvents(id);
    const answer = events.findIndex(event => event.kind === 'assistant_message');
    expect(events.filter(event => event.kind === 'tool_call')).toHaveLength(2);
    expect(events.slice(answer + 1).some(event => event.kind === 'tool_call')).toBe(false);
    const activity = await readActivityEvents(id, 0);
    expect(activity.events.filter(event => event.kind === 'tool_call').every(event =>
      event.turnOrigin === events[answer]!.turnOrigin)).toBe(true);
    expect(await fs.readFile(journal, 'utf8')).toBe(before);
  });

  it('closes the current duplicate document when the other document publishes its native final', async () => {
    const { id } = await split({ live: true });
    expect(await readCompletedFinal(id, chat, second)).not.toBeNull();
    expect(liveConversations().find(row => row.conversationId === chat)?.generating).toBe(false);
    expect((await getSession(id))?.activeTurnId).toBeNull();
  });

  it.each(['newQuestion', 'newRequest', 'endedBefore'] as const)('keeps distinct response boundaries separate (%s)', async variant => {
    const { id } = await split({ [variant]: true });
    expect(await readCompletedFinal(id, chat, second)).toBeNull();
    const events = await readEvents(id);
    const answer = events.find(event => event.kind === 'assistant_message')!;
    const secondCall = events.find(event => event.kind === 'tool_call' && event.call.callId === 'second-call')!;
    expect(secondCall.turnOrigin).not.toBe(answer.turnOrigin);
  });

  it('retains a new native question delivered through the app with its provider turn id', async () => {
    const { id, at } = await split();
    await appendEvent(id, { kind: 'user_message', source: 'app', time: at + 100,
      inputId: 'browser-input', messageId: 'new-native-question', turnId: '11111111-aaaa-4333-8444-555555555555',
      message: stored('Now review a different task.') });
    expect(await readLatestUserMessage(id, second)).toMatchObject({ messageId: 'new-native-question' });
    expect(await readCompletedFinal(id, chat, second)).toBeNull();
  });

  it.each([false, true])('does not merge a different response when the old request arrives late (restart %s)', async restart => {
    const { id, at } = await split({ newRequest: true, trailingOldRequest: true });
    if (restart) { await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests(); }
    expect(await readCompletedFinal(id, chat, second)).toBeNull();
    const rows = await readEvents(id);
    const newer = rows.find(event => event.kind === 'tool_call' && event.call.callId === 'second-call')!;
    const late = rows.find(event => event.kind === 'tool_call' && event.time === at + 35)!;
    const answer = rows.find(event => event.kind === 'assistant_message')!;
    expect(late.turnOrigin).toBe(answer.turnOrigin);
    expect(newer.turnOrigin).not.toBe(answer.turnOrigin);
  });

  it('retains completion while concurrent activity and recovery readers inspect the same response', async () => {
    const { id } = await split();
    const verdicts = await Promise.all(Array.from({ length: 8 }, async () => {
      const [completed] = await Promise.all([
        readCompletedFinal(id, chat, second), readActivityEvents(id, 0), readRecoveryBoundary(id, second)
      ]);
      return completed;
    }));
    expect(verdicts.every(result => result?.messageId === 'native-answer')).toBe(true);
  });

  it('keeps conflicting conversation evidence unusable when rebuilding request ownership', async () => {
    const { id, at } = await split();
    const [original] = (await readEvents(id)).filter(event => event.kind === 'tool_call');
    await appendEvent(id, { kind: 'tool_call', source: 'mcp', time: at + 100, turnId: first,
      call: { ...original!.call, callId: 'foreign-conversation', conversationId: 'different-conversation' } });
    expect((await getSession(id))?.requestTurns?.[requestId]).toBeNull();
  });
});
