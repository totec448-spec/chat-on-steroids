import { afterEach, expect, it, vi } from 'vitest';
import { createKeepAwake, keepAwakeState } from '../src/main/keep-awake.js';
import type { SessionSummary } from '../src/shared/session.js';

// Codex's "Prevent sleep while running": a computer that sleeps in the middle of a long run stops
// the run (the #1086 reports set Windows never to sleep by hand). While any chat is working, the
// app now holds the system awake; the screen may still turn off.

const NOW = Date.UTC(2026, 9, 13, 20);
const chat = (id: string, activityExpiresAt: number | null, extra: Partial<SessionSummary> = {}) =>
  ({ id, startedAt: NOW - 600_000, activityExpiresAt, ...extra }) as SessionSummary;

afterEach(() => { vi.useRealTimers(); });

it('stays awake while a chat is working, and says when to look again', () => {
  expect(keepAwakeState([chat('a', null), chat('b', NOW + 90_000), chat('c', NOW + 30_000)], NOW)).toEqual({ awake: true, nextAt: NOW + 30_000 });
  expect(keepAwakeState([chat('a', null), chat('b', NOW - 1)], NOW)).toEqual({ awake: false, nextAt: null });
  // A worker that reported its finish is done, whatever its last deadline says.
  expect(keepAwakeState([chat('w', NOW + 60_000, { origin: { kind: 'worker' } as SessionSummary['origin'], lastFinishReportAt: NOW - 10, lastToolCallAt: NOW - 20 })], NOW).awake).toBe(false);
});

it('holds the system awake only while work runs, and lets go when it is switched off', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
  let sessions = [chat('a', NOW + 30_000)];
  let enabled = true;
  const held = new Set<number>(); let next = 1;
  const blocker = { start: vi.fn(() => { const id = next++; held.add(id); return id; }), stop: vi.fn((id: number) => { held.delete(id); }) };
  const awake = createKeepAwake({ sessions: async () => sessions, enabled: () => enabled, blocker });

  await awake.refresh();
  expect(held.size).toBe(1);
  await awake.refresh();
  expect(blocker.start).toHaveBeenCalledTimes(1);

  // The deadline passes with no new work: the hold ends by itself.
  await vi.advanceTimersByTimeAsync(30_100);
  expect(held.size).toBe(0);

  sessions = [chat('a', NOW + 120_000)];
  await awake.refresh();
  expect(held.size).toBe(1);
  enabled = false;
  await awake.refresh();
  expect(held.size).toBe(0);

  enabled = true;
  await awake.refresh();
  awake.dispose();
  expect(held.size).toBe(0);
});

// Some Windows laptops (Modern Standby) go to standby once the screen turns off, whatever the app
// holds for the system alone (2.1.37 release round). "The computer and screen" keeps the screen on.
it('holds the screen too when asked, and swaps the hold when the choice changes', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
  let screen = false;
  const held = new Map<number, string>(); let next = 1;
  const blocker = { start: vi.fn((kind: 'computer' | 'screen') => { const id = next++; held.set(id, kind); return id; }), stop: vi.fn((id: number) => { held.delete(id); }) };
  const awake = createKeepAwake({ sessions: async () => [chat('a', NOW + 120_000)], enabled: () => true, screen: () => screen, blocker });

  await awake.refresh();
  expect([...held.values()]).toEqual(['computer']);
  screen = true;
  await awake.refresh();
  expect([...held.values()]).toEqual(['screen']);
  await awake.refresh();
  expect(blocker.start).toHaveBeenCalledTimes(2);
  screen = false;
  await awake.refresh();
  expect([...held.values()]).toEqual(['computer']);
  awake.dispose();
  expect(held.size).toBe(0);
});
