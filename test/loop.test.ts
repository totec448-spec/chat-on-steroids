import { describe, expect, it } from 'vitest';
import {
  loopForTests,
  parseLoopInput,
  resetLoopsForTests,
  restoreLoops,
  snapshotLoops,
  type LoopTask
} from '../src/main/loop.js';

function task(overrides: Partial<LoopTask> = {}): LoopTask {
  const now = 10_000_000;
  return {
    id: 'a1b2c3d4',
    sessionId: 'session-1234',
    sourceSeq: 7,
    mode: 'fixed',
    prompt: 'check the deploy',
    requestedInterval: '5m',
    intervalMs: 5 * 60_000,
    createdAt: now,
    expiresAt: now + 7 * 24 * 60 * 60_000,
    nextWakeAt: now + 5 * 60_000,
    nextWakeKind: 'scheduled',
    stopAt: null,
    lastReason: '',
    runCount: 0,
    lastRunAt: null,
    lease: null,
    ...overrides
  };
}

describe('/loop parsing', () => {
  it('gives a leading compact interval priority', () => {
    expect(parseLoopInput('/loop 5m /babysit-prs')).toMatchObject({
      mode: 'fixed',
      prompt: '/babysit-prs',
      intervalMs: 300_000,
      requestedInterval: '5m',
      bare: false
    });
  });

  it('extracts only a time-valued trailing every clause', () => {
    expect(parseLoopInput('/loop check the deploy every 20 minutes')).toMatchObject({
      mode: 'fixed',
      prompt: 'check the deploy',
      intervalMs: 1_200_000
    });
    expect(parseLoopInput('/loop check every PR')).toMatchObject({
      mode: 'dynamic',
      prompt: 'check every PR'
    });
  });

  it('uses dynamic self-pacing when no interval is present', () => {
    expect(parseLoopInput('/proactive check the deploy')).toEqual({
      mode: 'dynamic',
      prompt: 'check the deploy',
      intervalMs: null,
      requestedInterval: null,
      bare: false
    });
  });

  it('supports modern bare autonomous maintenance mode', () => {
    const parsed = parseLoopInput('/loop');
    expect(parsed.mode).toBe('dynamic');
    expect(parsed.bare).toBe(true);
    expect(parsed.prompt).toContain('.claude/loop.md');
    expect(parsed.prompt).toContain('~/.claude/loop.md');
    expect(parsed.prompt).toContain('unfinished work');
  });

  it('keeps the fixed scheduler at cron-compatible one-minute granularity', () => {
    expect(parseLoopInput('/loop 30s ping').intervalMs).toBe(60_000);
    expect(parseLoopInput('/loop 90s ping').intervalMs).toBe(120_000);
  });

  it('uses autonomous maintenance when only a fixed interval is supplied', () => {
    const parsed = parseLoopInput('/loop 15m');
    expect(parsed.mode).toBe('fixed');
    expect(parsed.intervalMs).toBe(900_000);
    expect(parsed.requestedInterval).toBe('15m');
    expect(parsed.bare).toBe(true);
    expect(parsed.prompt).toContain('.claude/loop.md');
    expect(parsed.prompt).toContain('~/.claude/loop.md');
    expect(parsed.prompt).toContain('unfinished work');

    const natural = parseLoopInput('/loop every 15 minutes');
    expect(natural.mode).toBe('fixed');
    expect(natural.intervalMs).toBe(900_000);
    expect(natural.bare).toBe(true);
    expect(natural.prompt).toContain('unfinished work');
  });
});

describe('/loop durable state', () => {
  it('restores live tasks without restoring a stale delivery lease', () => {
    resetLoopsForTests();
    const saved = task({ lease: { token: 'x', clientId: 'tab', expiresAt: 20_000_000, kind: 'scheduled' } });
    restoreLoops({ version: 1, savedAt: 10_000_000, tasks: [saved] }, 10_000_001);
    expect(loopForTests(saved.sessionId, saved.id)?.lease).toBeNull();
    expect(snapshotLoops().tasks).toHaveLength(1);
  });

  it('drops expired dynamic tasks but preserves an aged fixed task for its final due fire', () => {
    resetLoopsForTests();
    const expiredDynamic = task({ id: '11112222', mode: 'dynamic', intervalMs: null, expiresAt: 9_999_999 });
    const expiredFixed = task({ id: '33334444', expiresAt: 9_999_999, nextWakeAt: 9_900_000 });
    restoreLoops({ version: 1, savedAt: 10_000_000, tasks: [expiredDynamic, expiredFixed] }, 10_000_000);
    expect(snapshotLoops().tasks.map((item) => item.id)).toEqual(['33334444']);
  });
});
