import { expect, it } from 'vitest';
import type { SessionEvent } from '../src/shared/session.js';
import { chatErrorPresentation, duplicateChatErrors } from '../src/renderer/chat-error.js';

const error = (text: string, extra = {}): Extract<SessionEvent, { kind: 'chat_error' }> => ({
  seq: 1, time: 100, source: 'extension', kind: 'chat_error', turnId: 'turn-a',
  message: { text, chars: text.length, truncated: false }, ...extra
});
const repair = (text: string, extra = {}): Extract<SessionEvent, { kind: 'progress' }> => ({
  seq: 2, time: 101, source: 'app', kind: 'progress', turnId: 'turn-a', progressId: 'browser-repair:one',
  message: { text, chars: text.length, truncated: false }, ...extra
});

it('projects one recoverable notice across reloads and uses the eventual canonical final', () => {
  const question: SessionEvent = { seq: 1, time: 90, source: 'extension', kind: 'user_message', messageId: 'q1', message: { text: 'Build', chars: 5, truncated: false } };
  const failed = error('Connection interrupted', { seq: 3, recoverable: true });
  const duplicate = error('Connection interrupted', { seq: 5, turnId: undefined, recoverable: true });
  const reminted = error('Connection interrupted', { seq: 7, turnId: 'replacement', recoverable: true });
  const receipt = repair('Reloaded chat', { seq: 8, turnId: 'replacement' });
  const history: SessionEvent[] = [question, failed, duplicate, reminted, receipt];
  expect([...duplicateChatErrors(history)]).toEqual([5, 7]);
  expect(chatErrorPresentation(failed, history).next).toContain('Reloaded chat');
  history.push({ seq: 9, origin: 2, time: 120, source: 'extension', kind: 'assistant_message', messageId: 'answer', final: true, message: { text: 'Done', chars: 4, truncated: false } });
  history.push({ seq: 6, time: 115, source: 'app', kind: 'turn_start', turnId: 'replacement', detail: 'Work resumed' });
  expect(chatErrorPresentation(failed, history).next).toContain('later completed');
  history.push({ ...question, seq: 10, messageId: 'q2' }, { ...reminted, seq: 11 });
  expect([...duplicateChatErrors(history)]).toEqual([5, 7]);
  history.push({ seq: 12, origin: 2, time: 120, source: 'extension', kind: 'assistant_message', messageId: 'answer', final: true, finalContentSeq: 9, message: { text: 'Done', chars: 4, truncated: false } });
  expect(chatErrorPresentation({ ...reminted, seq: 11 }, history).next).not.toContain('later completed');
});

it('explains every error without promising an unknown automatic retry', () => {
  const view = chatErrorPresentation(error('An unfamiliar provider error'));
  expect(view.message).toBe('An unfamiliar provider error');
  expect(view.next).toContain('do not send it again');
  expect(view.next).not.toContain('will try');
  expect(chatErrorPresentation(error('Unbekannt', { blocking: true })).next).toContain('Reloading cannot remove this limit');
  expect(chatErrorPresentation(error('Unbekannt', { recoverable: true })).next).toContain('when recovery is eligible');
});

it('distinguishes a failed view and app silence from actual native generation', () => {
  const thinking = chatErrorPresentation(error('Thinking failed'));
  expect(thinking.title).toBe('Thinking failed');
  expect(thinking.next).toContain('You can send a follow-up');
  expect(thinking.next).toContain('five minutes');
  const stalled = chatErrorPresentation(error('No visible progress for ten minutes. The turn is still marked as generating.'));
  expect(stalled.title).toBe('Response stalled');
  expect(stalled.message).toContain('could not confirm');
  expect(stalled.message).not.toContain('generating');
});

it('shows the existing repair receipt, not a claim that the response recovered', () => {
  const failed = error('Connection interrupted', { recoverable: true });
  const trying = repair('Trying to reload chat…');
  expect(chatErrorPresentation(failed, [failed, trying]).next).toContain(trying.message.text);
  const done = repair('Reloaded chat to recover an interrupted response.', { seq: 3 });
  const result = chatErrorPresentation(failed, [done, failed, trying]);
  expect(result.next).toContain(done.message.text);
  expect(result.next).not.toContain('will try to refresh');
  expect(result.next).toContain('wait until sending is safe');
});

it('never borrows a later question, different turn or unrelated error recovery', () => {
  const failed = error('Connection interrupted');
  const other = repair('Foreign recovery', { turnId: 'turn-b' });
  expect(chatErrorPresentation(failed, [failed, other]).next).not.toContain('Foreign recovery');
  const question: SessionEvent = { seq: 2, time: 101, source: 'extension', kind: 'user_message', message: { text: 'Next', chars: 4, truncated: false } };
  const unscoped = repair('Later recovery', { seq: 4, turnId: undefined });
  expect(chatErrorPresentation(failed, [failed, question, unscoped]).next).not.toContain('Later recovery');
  expect(chatErrorPresentation(failed, [failed, error('Another error', { seq: 3 }), unscoped]).next).not.toContain('Later recovery');
});

it('only an exact completed boundary supersedes the error guidance', () => {
  const failed = error('Thinking failed');
  const end: SessionEvent = { seq: 3, time: 110, source: 'extension', kind: 'turn_end', turnId: 'turn-a', outcome: 'completed' };
  expect(chatErrorPresentation(failed, [failed, end]).next).toContain('later completed');
  expect(chatErrorPresentation(failed, [failed, end])).toMatchObject({ title: 'Recovered after interruption', resolved: true });
  expect(chatErrorPresentation(failed, [failed, { ...end, turnId: 'turn-b' }]).next).not.toContain('later completed');
  expect(chatErrorPresentation(failed, [failed, { ...end, outcome: 'stopped' }]).next).not.toContain('later completed');
  const reopened: SessionEvent = { seq: 4, time: 120, source: 'app', kind: 'turn_start', turnId: 'turn-a' };
  expect(chatErrorPresentation(failed, [failed, end, reopened]).next).toContain('Work continued');
  expect(chatErrorPresentation(failed, [failed, end, reopened]).resolved).toBe(false);
  expect(chatErrorPresentation(failed, [failed, { ...end, turnId: 'turn-b' }]).resolved).toBe(false);
  expect(chatErrorPresentation(failed, [failed, { ...reopened, turnId: 'turn-b' }]).next).not.toContain('Work continued');
});
