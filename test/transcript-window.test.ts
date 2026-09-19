import { describe, expect, it } from 'vitest';
import { chronological, projectTimeline, type Chronological, type TimelineTurns } from '../src/shared/chronology.js';

describe('transcript pagination across recovered turns', () => {
  const turns: TimelineTurns = {
    first: { origin: 2, time: 100, endTime: 180 },
    second: { origin: 8, time: 200, endTime: 280 }
  };
  const source: Chronological[] = [
    { seq: 1, time: 90, kind: 'user_message' },
    { seq: 2, time: 100, kind: 'turn_start', turnId: 'first' },
    { seq: 3, time: 120, kind: 'tool_call', turnId: 'first' },
    { seq: 4, time: 150, kind: 'tool_call', turnId: 'first' },
    { seq: 5, time: 180, kind: 'turn_end', turnId: 'first' },
    { seq: 7, time: 190, kind: 'user_message' },
    { seq: 8, time: 200, kind: 'turn_start', turnId: 'second' },
    // The earlier response becomes visible only after the next send/reload.
    { seq: 30, origin: 9, time: 210, authoredAt: 130, kind: 'assistant_message', turnId: 'first' },
    { seq: 31, origin: 10, time: 210, authoredAt: 170, kind: 'assistant_message', turnId: 'first', final: true },
    { seq: 11, time: 240, kind: 'tool_call', turnId: 'second' },
    { seq: 32, origin: 12, time: 260, kind: 'assistant_message', turnId: 'second', final: true },
    { seq: 13, time: 280, kind: 'turn_end', turnId: 'second' }
  ];

  it('gives every page the same relative order as the complete transcript', () => {
    const projected = projectTimeline(source, turns);
    const full = chronological(projected);
    expect(full.map(row => row.seq)).toEqual([1, 2, 3, 30, 4, 31, 5, 7, 8, 11, 32, 13]);
    for (let from = 0; from < source.length; from++) {
      for (let size = 1; size <= source.length; size++) {
        const window = projectTimeline(source.slice(from, from + size), turns);
        const keys = new Set(window.map(row => row.seq));
        expect(chronological(window).map(row => row.seq)).toEqual(full.filter(row => keys.has(row.seq)).map(row => row.seq));
      }
    }
    expect(source.some(row => row.turnOrigin !== undefined)).toBe(false);
  });

  it('does not absorb an unowned user message into the preceding unfinished turn', () => {
    const rows = [
      { seq: 1, time: 100, kind: 'turn_start', turnId: 'first' },
      { seq: 2, time: 120, kind: 'user_message' },
      { seq: 3, time: 130, kind: 'turn_start', turnId: 'second' },
      { seq: 4, time: 125, kind: 'assistant_message', turnId: 'first', final: true }
    ];
    expect(chronological(rows).map(row => row.seq)).toEqual([1, 4, 2, 3]);
  });

  it('retains canonical cursor identity and never grants lifecycle ownership from provider time', () => {
    const row: Chronological = { seq: 40, origin: 15, kind: 'assistant_message', time: 300, authoredAt: 110 };
    const [projected] = projectTimeline([row], turns);
    expect(projected).toMatchObject(row);
    expect(projected?.turnId).toBeUndefined();
    expect(projected?.turnOrigin).toBeNull();
  });

  it('keeps unowned backfill and post-turn notices outside a partially loaded generation', () => {
    const rows: Chronological[] = [
      { seq: 2, time: 100, kind: 'turn_start', turnId: 'first' },
      { seq: 3, time: 180, kind: 'turn_end', turnId: 'first' },
      { seq: 4, time: 190, kind: 'progress' },
      { seq: 5, time: 200, authoredAt: 120, kind: 'assistant_message', final: true }
    ];
    const expected = chronological(projectTimeline(rows, turns));
    const missingEnd = projectTimeline(rows.filter(row => row.kind !== 'turn_end'), turns);
    expect(chronological(missingEnd).map(row => row.seq)).toEqual(expected.filter(row => row.kind !== 'turn_end').map(row => row.seq));
    expect(missingEnd.slice(1).every(row => row.turnOrigin === null)).toBe(true);
  });

  const working = '11111111-1111-4111-8111-111111111111';
  const exchange = '22222222-2222-4222-8222-222222222222';
  const parent = '33333333-3333-4333-8333-333333333333';
  const nativeMessage = (seq: number, messageId: string, turnId?: string): Chronological => ({
    seq, time: seq * 10, kind: 'assistant_message', source: 'extension', messageId, turnId
  });

  it('places reloaded interim prose between its tools using the recorded native response, without assigning a lifecycle owner', () => {
    const at = 1789805531000;
    const source = [
      { seq: 1, time: at + 10, kind: 'turn_start', turnId: 'first' },
      { ...nativeMessage(2, `assistant:${parent}:${working}:${exchange}`, 'first'), time: at + 20 },
      { seq: 3, time: at + 30, kind: 'tool_call', turnId: 'first' },
      // Native publication preceded the tool, but its canonical revision arrived later.
      { ...nativeMessage(7, `assistant:${working}:${exchange}:${at + 40}`), origin: 4, time: at + 45 },
      { seq: 5, time: at + 50, kind: 'tool_call', turnId: 'first' },
      { seq: 6, time: at + 60, kind: 'tool_call', turnId: 'first' }
    ];
    const boundaries = { first: { origin: 1, time: at + 10 } };
    const before = structuredClone(source);
    const projected = projectTimeline(source, boundaries);
    const read = chronological(projected);
    expect(read.map(row => row.seq)).toEqual([1, 2, 3, 7, 5, 6]);
    expect(projected.find(row => row.seq === 7)).toMatchObject({ seq: 7, origin: 4, time: at + 45, turnOrigin: 1 });
    expect(projected.find(row => row.seq === 7)?.turnId).toBeUndefined();
    expect(source).toEqual(before);
  });

  it('uses canonical response evidence outside a small page without borrowing the newest response', () => {
    const original = nativeMessage(2, `assistant:${working}:${exchange}:1789805348151`, 'first');
    const recovered = nativeMessage(12, `assistant:${parent}:${working}:${exchange}`);
    const projected = projectTimeline([recovered], turns, {}, [original, recovered]);
    expect(projected[0]).toMatchObject({ seq: 12, turnOrigin: 2 });
    expect(projected[0]?.turnId).toBeUndefined();
  });

  it.each(['conflicting-turn', 'unknown-turn', 'different-agent', 'different-working', 'different-exchange', 'partial-key', 'raw-id'])(
    'does not borrow response ownership from %s evidence', conflict => {
      const original = nativeMessage(2, `assistant:${parent}:${working}:${exchange}`, 'first');
      let recovered = nativeMessage(12, `assistant:${working}:${exchange}:1789805531502`);
      const evidence: Chronological[] = [original];
      if (conflict === 'conflicting-turn' || conflict === 'unknown-turn') evidence.push({
        ...original, seq: 9, turnId: conflict === 'unknown-turn' ? 'absent' : 'second'
      });
      if (conflict === 'different-agent') recovered = { ...recovered, agent: 'worker-1' };
      if (conflict === 'different-working') recovered.messageId = `assistant:${parent}:${exchange}:1789805531502`;
      if (conflict === 'different-exchange') recovered.messageId = `assistant:${working}:${parent}:1789805531502`;
      if (conflict === 'partial-key') recovered.messageId = `assistant:${working}::1789805531502`;
      if (conflict === 'raw-id') recovered.messageId = exchange;
      const [projected] = projectTimeline([recovered], turns, {}, evidence);
      expect(projected?.turnOrigin).toBeNull();
      expect(projected?.turnId).toBeUndefined();
    }
  );

  it('accepts multiple exact native anchors only when the recorded lifecycle already identifies one response', () => {
    const source = [
      nativeMessage(2, `assistant:${parent}:${working}:${exchange}`, 'first'),
      nativeMessage(9, `assistant:${working}:${exchange}:1789805531502`, 'second'),
      nativeMessage(12, `assistant:${working}:${exchange}:1789806074481`)
    ];
    const sameResponse = { ...turns, second: { ...turns.second!, responseTurnId: 'first' } };
    expect(projectTimeline(source, sameResponse).map(row => row.turnOrigin)).toEqual([2, 2, 2]);
    expect(projectTimeline(source, turns).map(row => row.turnOrigin)).toEqual([2, 8, null]);
  });
});
