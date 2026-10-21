import { beforeEach, expect, it, vi } from 'vitest';
import { considerTurnRotation, noteRotationDeclined, resetTurnRotationForTests, type RotationDeps } from '../src/main/turn-rotation.js';

/**
 * #1402: turns past ~35 minutes almost always broke; a fresh turn every 30 minutes, started right
 * after a tool result, avoided that. The decision is made per attributed tool call.
 */
let now = 0;
let startedAt: number | null = 0;
let minutes = 30;
const filed: Array<[string, string]> = [];
let accept = true;
const deps = (): RotationDeps => ({
  now: () => now,
  minutes: () => minutes,
  turnStartedAt: async () => startedAt,
  file: vi.fn(async (sessionId: string, turnId: string) => { filed.push([sessionId, turnId]); return accept ? { id: 'row' } : null; }),
  log: () => undefined
});
beforeEach(() => { resetTurnRotationForTests(); now = 0; startedAt = 0; minutes = 30; filed.length = 0; accept = true; });

it('rotates a turn once it has run the configured minutes, and only once', async () => {
  now = 29 * 60_000;
  expect(await considerTurnRotation('chat', 'session', 'turn', deps())).toBe(false);
  now = 30 * 60_000;
  expect(await considerTurnRotation('chat', 'session', 'turn', deps())).toBe(true);
  expect(filed).toEqual([['session', 'turn']]);
  now += 60_000;
  expect(await considerTurnRotation('chat', 'session', 'turn', deps())).toBe(false);
  expect(filed).toHaveLength(1);
});

it('tries again later when the outbox refused, or when a filed rotation was not taken', async () => {
  now = 31 * 60_000; accept = false;
  expect(await considerTurnRotation('chat', 'session', 'turn', deps())).toBe(false);
  now += 30_000;
  await considerTurnRotation('chat', 'session', 'turn', deps());
  expect(filed).toHaveLength(1);
  now += 31_000; accept = true;
  expect(await considerTurnRotation('chat', 'session', 'turn', deps())).toBe(true);
  // The same turn still running five minutes later: the rotation did not take.
  now += 4 * 60_000;
  expect(await considerTurnRotation('chat', 'session', 'turn', deps())).toBe(false);
  now += 61_000;
  expect(await considerTurnRotation('chat', 'session', 'turn', deps())).toBe(true);
});

it('does nothing when switched off or when the turn start is unknown', async () => {
  now = 90 * 60_000; minutes = 0;
  expect(await considerTurnRotation('chat', 'session', 'turn', deps())).toBe(false);
  minutes = 30; startedAt = null;
  expect(await considerTurnRotation('chat', 'session', 'turn', deps())).toBe(false);
  expect(filed).toEqual([]);
});

it('measures each new turn from its own start', async () => {
  now = 31 * 60_000;
  expect(await considerTurnRotation('chat', 'session', 'turn-1', deps())).toBe(true);
  startedAt = now; now += 5 * 60_000;
  expect(await considerTurnRotation('chat', 'session', 'turn-2', deps())).toBe(false);
  now = startedAt + 30 * 60_000;
  expect(await considerTurnRotation('chat', 'session', 'turn-2', deps())).toBe(true);
});

// 2026-10-15, the user's Mac chat: seven automatic continues in two turns, every one shown as not
// sent. A turn the page could not rotate twice is left alone after that, with one log line.
it('files at most two automatic continues for one turn', async () => {
  const lines: string[] = [];
  const logged = (): RotationDeps => ({ ...deps(), log: line => lines.push(line) });
  now = 31 * 60_000;
  expect(await considerTurnRotation('chat', 'session', 'turn', logged())).toBe(true);
  now += 5 * 60_000 + 1;
  expect(await considerTurnRotation('chat', 'session', 'turn', logged())).toBe(true);
  for (let step = 0; step < 4; step += 1) {
    now += 5 * 60_000 + 1;
    expect(await considerTurnRotation('chat', 'session', 'turn', logged())).toBe(false);
  }
  expect(filed).toHaveLength(2);
  expect(lines.filter(line => line.includes('giving up on fresh turns'))).toHaveLength(1);
  // The next turn starts over.
  startedAt = now; now += 31 * 60_000;
  expect(await considerTurnRotation('chat', 'session', 'turn-2', logged())).toBe(true);
});

// 2026-10-20, Loop chats on the Windows VM: a continue is filed right after a tool result. When
// ChatGPT shows Stop at that moment it offers no Send for it, so the page declines it at once. A
// later tool result is usually a moment without Stop; waiting five minutes and giving up after two
// meant a Loop step never got its fresh turn.
it('tries again a minute later when the page declined for want of Send, without spending the two filings', async () => {
  now = 31 * 60_000;
  expect(await considerTurnRotation('chat', 'session', 'turn', deps())).toBe(true);
  noteRotationDeclined('chat', 'turn');
  now += 30_000;
  expect(await considerTurnRotation('chat', 'session', 'turn', deps())).toBe(false);
  now += 31_000;
  expect(await considerTurnRotation('chat', 'session', 'turn', deps())).toBe(true);
  noteRotationDeclined('chat', 'turn');
  now += 61_000;
  expect(await considerTurnRotation('chat', 'session', 'turn', deps())).toBe(true);
  // Taken at last: one fresh turn per turn, as before.
  now += 61_000;
  expect(await considerTurnRotation('chat', 'session', 'turn', deps())).toBe(false);
  expect(filed).toHaveLength(3);
});

it('gives up on a turn after six declines, and the next turn starts over', async () => {
  const lines: string[] = [];
  const logged = (): RotationDeps => ({ ...deps(), log: line => lines.push(line) });
  now = 31 * 60_000;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    expect(await considerTurnRotation('chat', 'session', 'turn', logged())).toBe(true);
    noteRotationDeclined('chat', 'turn');
    now += 61_000;
  }
  expect(await considerTurnRotation('chat', 'session', 'turn', logged())).toBe(false);
  now += 10 * 60_000;
  expect(await considerTurnRotation('chat', 'session', 'turn', logged())).toBe(false);
  expect(filed).toHaveLength(6);
  expect(lines.filter(line => line.includes('giving up on fresh turns'))).toHaveLength(1);
  startedAt = now; now += 31 * 60_000;
  expect(await considerTurnRotation('chat', 'session', 'turn-2', logged())).toBe(true);
});

it('ignores a decline for another turn or chat', async () => {
  now = 31 * 60_000;
  expect(await considerTurnRotation('chat', 'session', 'turn', deps())).toBe(true);
  noteRotationDeclined('chat', 'older-turn');
  noteRotationDeclined('other-chat', 'turn');
  now += 61_000;
  // Still the filed-and-not-taken wait of five minutes.
  expect(await considerTurnRotation('chat', 'session', 'turn', deps())).toBe(false);
});
