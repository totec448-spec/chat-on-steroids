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
});
