import { describe, expect, it } from 'vitest';

import { chronological } from '../src/shared/chronology.js';

interface Row {
  seq: number;
  origin?: number;
  time: number;
  kind: string;
  turnId?: string | null;
  final?: boolean;
  state?: string;
  label?: string;
}

const row = (seq: number, time: number, kind: string, turnId: string | null, label?: string): Row => ({
  seq,
  time,
  kind,
  turnId,
  label: label ?? `${kind}@${time}`
});

const reading = (rows: Row[]): string[] => chronological(rows).map((entry) => entry.label!);

describe('the order a recorded turn is read in', () => {
  /**
   * A message the app handed between two agents, drawn where it was delivered.
   *
   * Live: prime's message to worker-1 was stamped 1787057617031 — three milliseconds after
   * the `read` above it — and rendered *below* a refusal that happened 32 seconds later,
   * because an app-authored event carries no generation id and was therefore its own group,
   * anchored at its own seq behind the whole turn.
   */
  it('places an app event that names no turn inside the turn that was open', () => {
    const rows = [
      row(1, 100, 'turn_start', 't1'),
      row(2, 110, 'progress', 't1'),
      row(4, 160, 'tool_call', 't1'),
      row(3, 120, 'agent_message', null),
      row(5, 200, 'turn_end', 't1')
    ];
    expect(reading(rows)).toEqual(['turn_start@100', 'progress@110', 'agent_message@120', 'tool_call@160', 'turn_end@200']);
  });

  /** After the turn closed it is nobody's neighbour, so it keeps the position seq gave it. */
  it('leaves an app event that happened after the turn ended where it was appended', () => {
    const rows = [
      row(1, 100, 'turn_start', 't1'),
      row(2, 110, 'progress', 't1'),
      row(3, 120, 'turn_end', 't1'),
      row(4, 130, 'agent_message', null),
      row(5, 140, 'turn_start', 't2'),
      row(6, 150, 'progress', 't2')
    ];
    expect(reading(rows)).toEqual(['turn_start@100', 'progress@110', 'turn_end@120', 'agent_message@130', 'turn_start@140', 'progress@150']);
  });

  it('puts a late-appended tool call back where it ran', () => {
    // The shape the real log takes: the call finishes, and only then is it appended, so it
    // lands after commentary the page had already reported while it was still running.
    const rows = [
      row(1, 100, 'turn_start', 't1'),
      row(2, 110, 'progress', 't1'),
      row(3, 150, 'progress', 't1'),
      row(4, 120, 'tool_call', 't1'),
      row(5, 160, 'assistant_message', 't1'),
      row(6, 170, 'turn_end', 't1')
    ];
    expect(reading(rows)).toEqual([
      'turn_start@100',
      'progress@110',
      'tool_call@120',
      'progress@150',
      'assistant_message@160',
      'turn_end@170'
    ]);
  });

  it('puts the terminal assistant answer after every call even when ChatGPT opened its message earlier', () => {
    // Live 2026-08-21 (`00000019`): ChatGPT stamped the final answer at 08:40:34 when it
    // opened that message object, then ran tool calls at 08:40:37 and 08:40:42 before the
    // prose actually closed the turn. The authored timestamp is useful chronology for ordinary
    // messages, but it cannot mean the terminal answer happened before work the same turn still
    // performed. Only the closing assistant moves; an earlier interim message keeps its place.
    const rows: Row[] = [
      row(1, 100, 'turn_start', 't1'),
      { ...row(2, 115, 'assistant_message', 't1', 'interim'), state: 'streaming', final: false },
      { ...row(5, 120, 'assistant_message', 't1', 'final answer'), state: 'final', final: true },
      row(3, 130, 'tool_call', 't1', 'late tool one'),
      row(4, 140, 'tool_call', 't1', 'late tool two'),
      row(6, 160, 'turn_end', 't1')
    ];

    expect(reading(rows)).toEqual([
      'turn_start@100',
      'interim',
      'late tool one',
      'late tool two',
      'final answer',
      'turn_end@160'
    ]);
  });
  it('does not leave a call that outlived the turn_end stranded after it', () => {
    const rows = [
      row(1, 100, 'turn_start', 't1'),
      row(2, 110, 'progress', 't1'),
      row(3, 160, 'assistant_message', 't1'),
      row(4, 170, 'turn_end', 't1'),
      row(5, 120, 'tool_call', 't1')
    ];
    expect(reading(rows)).toEqual([
      'turn_start@100',
      'progress@110',
      'tool_call@120',
      'assistant_message@160',
      'turn_end@170'
    ]);
  });

  it('keeps a boundary at the boundary even when its stamp says otherwise', () => {
    // turn_end is stamped when the page noticed the stop button go, which can be earlier
    // than the last thing the turn did. It is still the end of the turn.
    const rows = [
      row(1, 100, 'turn_start', 't1'),
      row(2, 400, 'turn_end', 't1'),
      row(3, 900, 'tool_call', 't1')
    ];
    expect(reading(rows)).toEqual(['turn_start@100', 'tool_call@900', 'turn_end@400']);
  });

  it('gives a delayed call back to the turn that made it, not the one that has started since', () => {
    // 5 s of attribution grace is long enough for the user to have sent the next message.
    const rows = [
      row(1, 100, 'turn_start', 't1'),
      row(2, 160, 'assistant_message', 't1'),
      row(3, 170, 'turn_end', 't1'),
      row(4, 200, 'user_message', null),
      row(5, 210, 'turn_start', 't2'),
      row(6, 120, 'tool_call', 't1'),
      row(7, 260, 'assistant_message', 't2')
    ];
    expect(reading(rows)).toEqual([
      'turn_start@100',
      'tool_call@120',
      'assistant_message@160',
      'turn_end@170',
      'user_message@200',
      'turn_start@210',
      'assistant_message@260'
    ]);
  });

  it('never pulls an event the turn does not own into the turn', () => {
    // Reload backfill: a re-reported historical answer carries the page turn id it was read
    // under and the time it was *observed* — 400 here, which is inside nothing. Sorting the
    // log by time would drop it into the live turn's middle. It stays outside, and because a
    // turn is emitted as one contiguous block it settles after the turn it interrupted
    // rather than inside it. That is the honest place for a row that belongs to no turn.
    const rows = [
      row(1, 900, 'user_message', null),
      row(2, 901, 'turn_start', 't1'),
      row(3, 902, 'progress', 't1'),
      row(4, 400, 'assistant_message', 'page-turn-old'),
      row(5, 903, 'turn_end', 't1')
    ];
    expect(reading(rows)).toEqual([
      'user_message@900',
      'turn_start@901',
      'progress@902',
      'turn_end@903',
      'assistant_message@400'
    ]);
  });

  it('keeps a turn contiguous rather than letting a stranger split it', () => {
    const rows = [
      row(1, 100, 'turn_start', 't1'),
      row(2, 110, 'progress', 't1'),
      row(3, 115, 'assistant_message', 'page-turn-old'),
      row(4, 170, 'turn_end', 't1'),
      row(5, 200, 'user_message', null)
    ];
    expect(reading(rows)).toEqual([
      'turn_start@100',
      'progress@110',
      'turn_end@170',
      'assistant_message@115',
      'user_message@200'
    ]);
  });

  it('refuses to move a tail whose turn this window cannot see', () => {
    // A cursor delivering only the tail has no bounded extent for that turn, so it has no
    // grounds to move anything across the events it can see. seq order is the honest answer.
    const rows = [row(80, 500, 'progress', 't1'), row(81, 120, 'tool_call', 't1'), row(82, 600, 'turn_end', 't1')];
    expect(reading(rows)).toEqual(['progress@500', 'tool_call@120', 'turn_end@600']);
  });

  it('rebuilds a window to the same order however its rows arrived', () => {
    const rows = [
      row(1, 100, 'turn_start', 't1'),
      row(2, 110, 'progress', 't1'),
      row(3, 150, 'progress', 't1'),
      row(4, 120, 'tool_call', 't1'),
      row(5, 160, 'assistant_message', 't1'),
      row(6, 170, 'turn_end', 't1')
    ];
    const shuffled = [4, 0, 3, 5, 1, 2].map((index) => rows[index]!);
    expect(reading(shuffled)).toEqual(reading(rows));
    expect(chronological(rows).map((entry) => entry.seq)).toEqual([1, 2, 4, 3, 5, 6]);
  });

  it('orders rows with no usable time by sequence rather than flinging them to one end', () => {
    const rows = [
      row(1, 100, 'turn_start', 't1'),
      { seq: 2, time: Number.NaN, kind: 'progress', turnId: 't1', label: 'untimed' },
      row(3, 150, 'progress', 't1'),
      row(4, 120, 'tool_call', 't1')
    ];
    expect(reading(rows)).toEqual(['turn_start@100', 'untimed', 'tool_call@120', 'progress@150']);
  });

  it('never mutates the window it was given', () => {
    const rows = [row(1, 100, 'turn_start', 't1'), row(2, 150, 'progress', 't1'), row(3, 120, 'tool_call', 't1')];
    const before = rows.map((entry) => entry.seq);
    chronological(rows);
    expect(rows.map((entry) => entry.seq)).toEqual(before);
  });

  it('rebuilding after a late arrival moves it into its slot instead of appending it', () => {
    // What the browser actually does: it holds every row it has ever been given, keyed by
    // seq, and re-reads the whole held window each time the cursor delivers something. The
    // late row keeps seq 500 — its identity and its place in the cursor — and still renders
    // between seq 2 and seq 3.
    const held = new Map<number, Row>();
    const deliver = (rows: Row[]): string[] => {
      for (const entry of rows) held.set(entry.seq, entry);
      return reading([...held.values()]);
    };

    deliver([row(1, 100, 'turn_start', 't1'), row(2, 110, 'progress', 't1'), row(3, 150, 'progress', 't1')]);
    const after = deliver([row(500, 120, 'tool_call', 't1')]);

    expect(after).toEqual(['turn_start@100', 'progress@110', 'tool_call@120', 'progress@150']);
    expect(chronological([...held.values()]).map((entry) => entry.seq)).toEqual([1, 2, 500, 3]);
  });

  it('uses a canonical revision origin to break equal-time ties', () => {
    const rows: Row[] = [
      row(1, 100, 'turn_start', 't1'),
      { ...row(5, 120, 'assistant_message', 't1', 'revised assistant'), origin: 2 },
      row(3, 120, 'tool_call', 't1'),
      row(4, 140, 'turn_end', 't1')
    ];
    expect(reading(rows)).toEqual(['turn_start@100', 'revised assistant', 'tool_call@120', 'turn_end@140']);
  });
});
