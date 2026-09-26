import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, flushDurable, resetDurableForTests } from '../src/main/durable.js';
import { initSessionStore, flushSessions, resetSessionStoreForTests, readEvents } from '../src/main/session/store.js';
import { recordChatObservations, liveConversations, resetRecorderForTests, onSessionChange } from '../src/main/session/recorder.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const chat = 'bbbbbbbb-1111-4111-8111-111111111111', turn = 'native-status-turn';
let directory: string;
beforeEach(async () => {
  directory = await makeTempDir('cos-native-status-');
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
  await saveConfig(defaultConfig());
});
afterEach(async () => {
  await flushSessions(); await flushDurable(); resetRecorderForTests(); resetSessionStoreForTests(); resetDurableForTests();
  await removeTempDir(directory);
});
const current = () => liveConversations().find(value => value.conversationId === chat);
const caption = (text: string, time: number, turnId = turn, fiberConversationId = chat) =>
  recordChatObservations(chat, [{ kind: 'activity_status', time, turnId, fiberConversationId, text }]);

it('notifies the renderer on changed ephemeral captions, coalescing a burst without disk events', async () => {
  await recordChatObservations(chat, [{ kind: 'turn_start', time: 100, turnId: turn }]);
  await new Promise(resolve => setTimeout(resolve, 420)); // Drain the separate turn-start notification.
  const listener = vi.fn(), unsubscribe = onSessionChange(listener);
  try {
    await caption('Inspecting files', 101); await caption('Analyzing results', 102);
    await new Promise(resolve => setTimeout(resolve, 420));
    expect(listener).toHaveBeenCalledTimes(1);
    await caption('Analyzing results', 103);
    await new Promise(resolve => setTimeout(resolve, 420));
    expect(listener).toHaveBeenCalledTimes(1);
  } finally { unsubscribe(); }
});

it('keeps public headlines ephemeral and outside work/Goal/send authority, scoped to the existing turn', async () => {
  expect((await caption('Cannot create a session', 100)).sessionId).toBeNull();
  const start = await recordChatObservations(chat, [{ kind: 'user_message', time: 101, messageId: 'question-id', text: 'Test' },
    { kind: 'turn_start', time: 102, turnId: turn }]);
  const before = await readEvents(start.sessionId!);
  const status = await caption('Searching public documentation', 103);
  expect(current()?.activityCaption).toBe('Searching public documentation');
  expect(status).toMatchObject({ stored: 0, activity: { meaningful: false, working: false, terminal: false }, goalCandidates: [] });
  expect(await readEvents(start.sessionId!)).toEqual(before);
  await caption('Wrong turn', 104, 'different-turn');
  await caption('Wrong chat', 104, turn, 'foreign-chat');
  await caption('Older caption', 102);
  expect(current()?.activityCaption).toBe('Searching public documentation');
  await caption('Analyzing\nthe result', 105);
  expect(current()?.activityCaption).toBe('Analyzing the result');
  await caption('', 106); expect(current()?.activityCaption).toBeUndefined();
  await caption('Finishing', 107);
  await recordChatObservations(chat, [{ kind: 'turn_end', time: 108, turnId: turn, outcome: 'stopped' }]);
  await caption('Late stale status', 109);
  expect(current()?.generating).toBe(false); expect(current()?.activityCaption).toBeUndefined();
});
