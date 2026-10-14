import { beforeEach, expect, it, vi } from 'vitest';
import { considerTurnRotation, resetTurnRotationForTests, type RotationDeps } from '../src/main/turn-rotation.js';

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
