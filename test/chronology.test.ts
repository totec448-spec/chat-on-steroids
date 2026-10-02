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
  authoredAt?: number;
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
   * Native ChatGPT steps between paragraphs, with the times a live session recorded. ChatGPT
   * opened each paragraph (12.267s, 32.946s) before the step drawn above it was read (15.371s,
   * 36.884s), so steps ordered by when they were read fell after the paragraph that follows them.
   * The page is read in ChatGPT's order: a step read in the same pass as the next paragraph goes
   * before it. A step read on its own keeps its own time.
   */
  it('places a native step before the paragraph read with it, where ChatGPT draws it', () => {
    const prose = (seq: number, time: number, authoredAt: number, label: string): Row => ({ ...row(seq, time, 'assistant_message', 't1', label), authoredAt });
    const rows: Row[] = [
      row(3, 1790715424000, 'turn_start', 't1', 'start'),
      prose(6, 1790715431068, 1790715424455, 'first paragraph'),
      row(7, 1790715435371, 'page_tool', 't1', 'Searched 2 websites'),
      prose(11, 1790715435371, 1790715432267, 'second paragraph'),
      row(12, 1790715446000, 'tool_call', 't1', 'Created teste-timeline.txt'),
      row(14, 1790715456884, 'page_tool', 't1', 'Created Electron release timeline file'),
      prose(18, 1790715456885, 1790715452946, 'third paragraph'),
      row(24, 1790715530132, 'page_tool', 't1', 'Retried the identical operation')
    ];
    expect(reading(rows)).toEqual(['start', 'first paragraph', 'Searched 2 websites', 'second paragraph',
      'Created teste-timeline.txt', 'Created Electron release timeline file', 'third paragraph', 'Retried the identical operation']);
  });

  /**
   * Work done after ChatGPT opened a paragraph but before its text could be read is drawn above it.
   * A live agentic turn: the second paragraph says the file "already got its fourth line", yet the
   * edit reached the app 119 ms after the paragraph was opened; and the round's recap, read 14 s
   * before the third paragraph's text, headed the next round instead of closing its own. A call that
   * arrived 10 s after a paragraph opened was issued after it, however late the hidden tab read it.
   */
  it('places work done before a paragraph was written above it, and its recap with it', () => {
    const prose = (seq: number, time: number, authoredAt: number, label: string): Row => ({ ...row(seq, time, 'assistant_message', 't1', label), authoredAt });
    const rows: Row[] = [
      row(3, 1790959781045, 'turn_start', 't1', 'start'),
      prose(6, 1790959781339, 1790959777101, 'plan paragraph'),
      row(8, 1790959803756, 'tool_call', 't1', 'create'),
      row(9, 1790959810875, 'tool_call', 't1', 'edit'),
      row(10, 1790959814727, 'page_tool', 't1', 'Created, edited, and validated'),
      prose(13, 1790959814727, 1790959810756, 'already edited'),
      row(16, 1790959829140, 'tool_call', 't1', 'count lines'),
      row(17, 1790959835467, 'page_tool', 't1', 'Validated and counted'),
      row(18, 1790959835234, 'tool_call', 't1', 'list windows'),
      row(19, 1790959849395, 'page_tool', 't1', 'Listed windows'),
      row(20, 1790959845275, 'tool_call', 't1', 'call after the paragraph'),
      prose(23, 1790959849396, 1790959835275, 'validation closed'),
      row(24, 1790959858851, 'tool_call', 't1', 'list apps'),
      row(28, 1790959905874, 'tool_call', 't1', 'window state'),
      row(29, 1790959906106, 'page_tool', 't1', 'Identified foreground'),
      prose(36, 1790959915441, 1790959905851, 'desktop revealed'),
      row(37, 1790959918644, 'tool_call', 't1', 'chrome state')
    ];
    expect(reading(rows)).toEqual(['start', 'plan paragraph', 'create', 'edit', 'Created, edited, and validated', 'already edited',
      'count lines', 'list windows', 'Validated and counted', 'Listed windows', 'validation closed',
      'call after the paragraph', 'list apps', 'window state', 'Identified foreground', 'desktop revealed', 'chrome state']);
  });

  /**
   * A whole turn read late in one pass (after a reload, or a new chat's first turn): every paragraph
   * and step is read a few ms apart, minutes after the work. Each step still goes only before the
   * paragraph after it on the page, as it is drawn there, not before the first paragraph.
   */
  it('keeps each step with its own paragraph when a turn is read late in one pass', () => {
    const late = 1_790_000_420_000;
    const prose = (seq: number, read: number, authoredAt: number, label: string, final?: boolean): Row =>
      ({ ...row(seq, read, 'assistant_message', 't1', label), authoredAt, ...(final ? { final } : {}) });
    const rows: Row[] = [
      row(3, 1_790_000_000_000, 'turn_start', 't1', 'start'),
      prose(66, late, 1_790_000_001_500, 'first paragraph'),
      row(4, 1_790_000_005_000, 'tool_call', 't1', 'first call'),
      row(67, late + 1, 'page_tool', 't1', 'first recap'),
      prose(68, late + 2, 1_790_000_009_000, 'second paragraph'),
      row(5, 1_790_000_012_000, 'tool_call', 't1', 'second call'),
      row(69, late + 3, 'page_tool', 't1', 'second recap'),
      prose(73, late + 4, 1_790_000_030_000, 'answer', true),
      row(7, 1_790_000_040_000, 'turn_end', 't1', 'end')
    ];
    expect(reading(rows)).toEqual(['start', 'first paragraph', 'first call', 'first recap', 'second paragraph',
      'second call', 'second recap', 'answer', 'end']);
  });

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

  it('applies a newly proved response origin to already resident rows of that same local turn', () => {
    const rows = [
      { ...row(1, 100, 'turn_start', 'document-a'), turnOrigin: 1 },
      { ...row(2, 110, 'tool_call', 'document-a'), turnOrigin: 1 },
      { ...row(3, 120, 'turn_start', 'document-b'), turnOrigin: 3 },
      { ...row(4, 125, 'assistant_message', 'document-b', 'resident interim'), turnOrigin: 3 },
      // Only this fresh delta knows that both documents observed one response.
      { ...row(5, 130, 'tool_call', 'document-b'), turnOrigin: 1 },
      { ...row(6, 140, 'assistant_message', 'document-a', 'native final'), turnOrigin: 1, final: true }
    ];
    const output = chronological(rows);
    expect(output.at(-1)?.label).toBe('native final');
    expect(output.findIndex(event => event.label === 'resident interim')).toBeLessThan(output.findIndex(event => event.seq === 5));
  });
});
