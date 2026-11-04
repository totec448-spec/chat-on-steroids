import { expect, it } from 'vitest';
import { isStoppedNote, recoveryEpisode } from '../src/renderer/recovery-episode.js';
import type { SessionEvent } from '../src/shared/session.js';

let seq = 0;
const at = (minute: number) => Date.parse('2026-11-01T13:00:00Z') + minute * 60_000;
const text = (value: string) => ({ text: value });
const ev = (event: Record<string, unknown>) => ({ seq: ++seq, ...event }) as unknown as SessionEvent;
const done = (minute: number) => ev({ kind: 'turn_end', time: at(minute), source: 'extension', turnId: `t${minute}`, outcome: 'completed' });
const asked = (minute: number) => ev({ kind: 'user_message', time: at(minute), source: 'extension', message: text('Do the work') });
const error = (minute: number, value = 'The response stream is unavailable (resume HTTP 404).') =>
  ev({ kind: 'chat_error', time: at(minute), source: 'extension', message: text(value) });
const reload = (minute: number, id: string, value: string) =>
  ev({ kind: 'progress', time: at(minute), source: 'app', progressId: `browser-repair:${id}`, message: text(value) });
const automatic = (minute: number, value = 'Continue until you are fully finished. The last response appears interrupted…') =>
  ev({ kind: 'user_message', time: at(minute), source: 'extension', automatic: true, message: text(value) });
const failed = (minute: number) => ev({ kind: 'turn_end', time: at(minute), source: 'extension', turnId: `f${minute}`, outcome: 'failed' });
const note = (minute: number, value: string) => ev({ kind: 'note', time: at(minute), source: 'app', message: text(value) });
const tool = (minute: number) => ev({ kind: 'tool_call', time: at(minute), source: 'mcp', call: {} });

// The real shape of 2026-11-01 13:47–15:10 on the maintainer's Mac (#1883).
it('gathers one episode since the chat last worked: errors, reloads, a failed turn, Continues and the stop', () => {
  const episode = recoveryEpisode([
    asked(0), tool(1), done(2), asked(40),
    error(47), reload(47, 'a', 'Trying to reload chat to recover an interrupted response…'),
    reload(47.5, 'a', 'Reloaded chat to recover an interrupted response.'),
    error(57, 'Message delivery timed out. Please try again. Retry'), failed(58),
    reload(58, 'b', 'Trying to reload chat to recover a handoff request that has not been sent…'),
    reload(58.5, 'b', 'Reloaded chat to recover a handoff request that has not been sent.'),
    automatic(60),
    note(70, 'Stopped trying to recover this chat: 10 attempts were offered to the browser and none was picked up, so this chat has no page to reload.')
  ])!;
  expect(episode.since).toBe(at(47));
  expect(episode.items.map(item => item.kind)).toEqual(['error', 'reload', 'error', 'turn', 'reload', 'continue', 'note']);
  // A reload is one row, showing how it ended.
  expect(episode.items[1]!.text).toBe('Reloaded chat to recover an interrupted response.');
  expect(episode.tries).toBe(3);
  expect(episode.stopped).toBe(true);
  expect(episode.current).toBe(true);
});

it('starts over after a completed turn or the person\'s own message, so an old episode never comes back', () => {
  expect(recoveryEpisode([error(1), reload(2, 'a', 'Reloaded chat.'), done(5)])).toBeNull();
  expect(recoveryEpisode([error(1), reload(2, 'a', 'Reloaded chat.'), asked(5)])).toBeNull();
  expect(recoveryEpisode([error(1), asked(5), error(6)])!.items).toHaveLength(1);
});

it('is no longer current once the chat works again, and is still current while only recovery happens', () => {
  expect(recoveryEpisode([asked(0), error(1), reload(2, 'a', 'Reloaded chat.'), tool(3)])!.current).toBe(false);
  // A reload that finishes after healthy work is recovery again.
  expect(recoveryEpisode([asked(0), error(1), reload(2, 'a', 'Trying…'), tool(3), reload(4, 'a', 'Reloaded chat.')])!.current).toBe(true);
});

it('does not count a routine fresh turn as recovery, unless an episode is already running', () => {
  const fresh = 'Continue the task from where you are. (Chat On Steroids starts a fresh turn every so often so long work stays reliable; nothing else changed.)';
  expect(recoveryEpisode([asked(0), tool(1), automatic(30, fresh), tool(31)])).toBeNull();
  const episode = recoveryEpisode([asked(0), error(1), automatic(2, fresh)])!;
  expect(episode.items.map(item => item.text)).toEqual(['The response stream is unavailable (resume HTTP 404).', 'fresh-turn']);
  expect(episode.tries).toBe(0);
});

it('is not stopped while the app still works on it, and knows the notes that say it stopped', () => {
  expect(recoveryEpisode([asked(0), error(1), reload(2, 'a', 'Reloaded chat.')])!.stopped).toBe(false);
  expect(recoveryEpisode([asked(0), note(1, 'Compact & Resume abandoned — cancelled')])!.stopped).toBe(false);
  for (const value of ['This chat stopped: its last turn ran for ten minutes', 'Goal paused: the reviewer found a problem',
    'The browser did not pick up this chat\'s next step', 'Compact & Resume is still waiting for this chat\'s handoff: 3 reloads'])
    expect(isStoppedNote(value)).toBe(true);
});

it('keeps at most the 50 newest items of a very long episode', () => {
  const many = Array.from({ length: 80 }, (_, index) => error(index + 1, `error ${index}`));
  const episode = recoveryEpisode([asked(0), ...many])!;
  expect(episode.items).toHaveLength(50);
  expect(episode.items[0]!.text).toBe('error 30');
  expect(episode.since).toBe(at(31));
});

it('treats a new turn as the chat moving on', () => {
  const turnStart = ev({ kind: 'turn_start', time: at(9), source: 'extension', turnId: 'next' });
  expect(recoveryEpisode([asked(0), error(1), note(2, 'This chat stopped: nothing followed it.'), turnStart])!.current).toBe(false);
});

it('keeps a reload that ended after another step in time order, as one item (CodeRabbit on #2062)', () => {
  const episode = recoveryEpisode([asked(0), reload(1, 'a', 'Trying to reload chat…'), error(2), reload(3, 'a', 'Reloaded chat.')])!;
  expect(episode.items.map(item => [item.kind, item.time])).toEqual([['error', at(2)], ['reload', at(3)]]);
  expect(episode.since).toBe(at(2));
});

it('reads a reload the window already folded into one row at the time it ended (CodeRabbit on #2062)', () => {
  const folded = ev({ kind: 'progress', time: at(1), updatedAt: at(3), source: 'app', progressId: 'browser-repair:a', message: text('Reloaded chat.') });
  const episode = recoveryEpisode([asked(0), folded, error(2)])!;
  expect(episode.items.map(item => [item.kind, item.time])).toEqual([['error', at(2)], ['reload', at(3)]]);
  expect(episode.since).toBe(at(2));
  // A tool call after the error but before the reload ended does not make it over.
  expect(recoveryEpisode([asked(0), folded, error(2), tool(2.5)])!.current).toBe(true);
});

it('keeps a reload that ended late among the 50 newest steps (CodeRabbit on #2062)', () => {
  const late = ev({ kind: 'progress', time: at(1), updatedAt: at(200), source: 'app', progressId: 'browser-repair:late', message: text('Reloaded chat.') });
  const many = Array.from({ length: 60 }, (_, index) => error(index + 2, `error ${index}`));
  const episode = recoveryEpisode([asked(0), late, ...many])!;
  expect(episode.items).toHaveLength(50);
  expect(episode.items.at(-1)).toMatchObject({ kind: 'reload', time: at(200) });
  expect(episode.since).toBe(at(13));
});
