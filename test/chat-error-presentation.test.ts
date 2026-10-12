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

it('folds Retry-label duplicates and keeps the acknowledged reload visible while tools continue', () => {
  const question: SessionEvent = { seq: 1, time: 90, source: 'extension', kind: 'user_message', messageId: 'question', message: { text: 'Build', chars: 5, truncated: false } };
  const failed = error('Message delivery timed out. Please try again. Retry', { seq: 3, recoverable: true });
  const duplicate = error('Message delivery timed out. Please try again.', { seq: 5, turnId: undefined, recoverable: true });
  const receipt = repair('Reloaded chat to recover an interrupted response.', { seq: 4 });
  const work: SessionEvent = { seq: 6, time: 120, source: 'app', kind: 'turn_start', turnId: 'turn-a', detail: 'Work resumed' };
  const history = [question, failed, receipt, duplicate, work];
  expect([...duplicateChatErrors(history)]).toEqual([5]);
  expect(chatErrorPresentation(failed, history)).toMatchObject({ resolved: false, reloaded: true });
  expect(chatErrorPresentation(failed, history).next).toContain('Reloaded chat');
  expect(chatErrorPresentation(failed, history).next).toContain('once per chat');
  expect(chatErrorPresentation(failed, history).next).toContain('silence');
  expect(chatErrorPresentation(failed, [question, failed, repair('Trying to reload chat', { seq: 4 })]).reloaded).not.toBe(true);
  expect(chatErrorPresentation(failed, [question, failed, repair('Reload failed', { seq: 4 })]).reloaded).not.toBe(true);
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

it('explains a spent error reload on a later error in the same question, never on another question', () => {
  const question: SessionEvent = { seq: 1, time: 90, source: 'extension', kind: 'user_message', messageId: 'q1', message: { text: 'Build', chars: 5, truncated: false } };
  const interrupted = error('Connection interrupted', { seq: 2, recoverable: true });
  const receipt = repair('Reloaded chat to recover an interrupted response.', { seq: 3 });
  const later = error('Message delivery timed out.', { seq: 4, turnId: undefined, recoverable: true });
  const history = [question, interrupted, receipt, later];
  expect(chatErrorPresentation(later, history).next).toContain('already received');
  expect(chatErrorPresentation(later, history).next).toContain('silence');
  expect(chatErrorPresentation(later, history).resolved).toBe(false);
  const next = { ...later, seq: 6 };
  expect(chatErrorPresentation(next, [...history, { ...question, seq: 5, messageId: 'q2' }, next]).next).not.toContain('already received');
  expect(chatErrorPresentation(later, [question, interrupted, repair('Trying to reload chat', { seq: 3 }), later]).next).not.toContain('already received');
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
  // Each scenario below is a notice of its own: one notice seen resolved stays resolved across pages.
  const other = error('Thinking failed', { seq: 2 });
  expect(chatErrorPresentation(other, [other, { ...end, turnId: 'turn-b' }]).next).not.toContain('later completed');
  expect(chatErrorPresentation(other, [other, { ...end, outcome: 'stopped' }]).next).not.toContain('later completed');
  const reopened: SessionEvent = { seq: 4, time: 120, source: 'app', kind: 'turn_start', turnId: 'turn-a' };
  expect(chatErrorPresentation(failed, [failed, end, reopened]).next).toContain('Work continued');
  expect(chatErrorPresentation(failed, [failed, end, reopened]).resolved).toBe(false);
  expect(chatErrorPresentation(other, [other, { ...end, turnId: 'turn-b' }]).resolved).toBe(false);
  expect(chatErrorPresentation(other, [other, { ...reopened, turnId: 'turn-b' }]).next).not.toContain('Work continued');
});

it('names a chat deleted in ChatGPT and points to a new chat instead of a retry or reload', () => {
  const deleted = error('This chat was deleted in ChatGPT. Start a new chat to continue.', { recoverable: false });
  expect(chatErrorPresentation(deleted)).toEqual({ title: 'Chat deleted in ChatGPT',
    message: 'ChatGPT no longer has this chat, so nothing more can be sent to it.',
    next: 'Start a new chat to continue. This history stays in the app.', resolved: false, reloaded: false });
});

it('says until when ChatGPT asked to wait, when the notice recorded that time (#1355)', () => {
  const noticed = new Date(2026, 9, 12, 14, 20).getTime();
  const sameDay = new Date(2026, 9, 12, 14, 32).getTime();
  const nextDay = new Date(2026, 9, 13, 0, 5).getTime();
  const clock = (time: number) => new Date(time).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' });
  const limited = (retryAt?: number) => chatErrorPresentation(error('ChatGPT temporarily limited access to this conversation history.',
    { time: noticed, blocking: true, ...(retryAt ? { retryAt } : {}) })).next;

  expect(limited(sameDay)).toBe(`ChatGPT asked to wait until at least ${clock(sameDay)}. After that the app continues by itself. Reloading cannot remove this limit.`);
  // A wait that ends on another day names the day too.
  expect(limited(nextDay)).toContain(new Date(nextDay).toLocaleDateString('en', { month: 'short', day: 'numeric' }));
  expect(limited(nextDay)).toContain(clock(nextDay));
  // A notice recorded before the time was kept says what it always said.
  expect(limited()).toBe('Wait until ChatGPT allows requests again, then retry. Reloading cannot remove this limit.');
});

it('keeps a resolved notice resolved when the rows that prove it leave the loaded page (2026-10-12)', () => {
  // Scrolling up loads older rows and drops newer ones. A notice drawn red, then green once its turn's
  // completion loaded, turned red again on the next page and green again when it came back.
  const question: SessionEvent = { seq: 40, time: 4000, source: 'extension', kind: 'user_message', messageId: 'q-page', message: { text: 'Build', chars: 5, truncated: false } };
  const failed = error('The response stream is unavailable (resume HTTP 404).', { seq: 41, time: 4100, turnId: 'turn-page', recoverable: true });
  const completed: SessionEvent = { seq: 50, time: 5000, source: 'extension', kind: 'turn_end', turnId: 'turn-page', outcome: 'completed' };
  expect(chatErrorPresentation(failed, [question, failed, completed]).resolved).toBe(true);
  expect(chatErrorPresentation(failed, [question, failed]).resolved).toBe(true);
  // Another notice of that page is not resolved by it.
  expect(chatErrorPresentation({ ...failed, seq: 42 }, [question, failed]).resolved).toBe(false);
});
