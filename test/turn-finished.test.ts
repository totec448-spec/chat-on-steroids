// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { turnFinished } from '../src/renderer/turn-changes.js';
import type { SessionEvent } from '../src/shared/session.js';

/** When the Changed files card may show: its turn is over, by its own end or a later turn's start. */
const at = (seq: number, kind: 'turn_start' | 'turn_end', turnId: string) => ({ seq, time: seq, source: 'extension', kind, turnId }) as unknown as SessionEvent;

it('counts a turn over at its end or a later turn\'s start, and a reopened turn as running until a later turn starts', () => {
  // A ended at 5; its answer is at 4.
  expect(turnFinished([at(1, 'turn_start', 'A'), at(5, 'turn_end', 'A')], 'A', 4)).toBe(true);
  // A runs: no end, no later turn.
  expect(turnFinished([at(1, 'turn_start', 'A')], 'A', 4)).toBe(false);
  // A's start is not loaded, and B started after A's answer.
  expect(turnFinished([at(6, 'turn_start', 'B')], 'A', 4)).toBe(true);
  // A started again after its answer (reopened): running.
  expect(turnFinished([at(1, 'turn_start', 'A'), at(6, 'turn_start', 'A')], 'A', 4)).toBe(false);
  // CodeRabbit on #1836: A reopened, then B started; A is over.
  expect(turnFinished([at(1, 'turn_start', 'A'), at(6, 'turn_start', 'A'), at(8, 'turn_start', 'B')], 'A', 4)).toBe(true);
  // B started before A was reopened: A is running again.
  expect(turnFinished([at(1, 'turn_start', 'A'), at(5, 'turn_start', 'B'), at(6, 'turn_start', 'A')], 'A', 4)).toBe(false);
});
