import { describe, expect, it } from 'vitest';
import { structureTimeline, type FlowRow } from '../src/renderer/timeline-rounds.js';
import type { SessionEvent } from '../src/shared/session.js';
import type { TurnTrace } from '../src/shared/turn-trace.js';

const TURN = 'g-turn-0-1';
let seq = 0;
const base = (turnId: string | undefined = TURN) => ({ seq: ++seq, time: 1_000 + seq, source: 'extension' as const, ...(turnId ? { turnId } : {}) });
const text = (value: string) => ({ text: value, chars: value.length, truncated: false });
const user = (): FlowRow => { const event = { ...base(undefined), kind: 'user_message', message: text('Make three files') } as SessionEvent; return { key: `u${event.seq}`, event }; };
const call = (title: string, tool = 'apply_patch', extra: Record<string, unknown> = {}): FlowRow => {
  const event = { ...base(), kind: 'tool_call', call: { callId: `c${seq}`, tool, summary: { kind: 'create', title }, ...extra } } as unknown as SessionEvent;
  return { key: `c${event.seq}`, event };
};
const say = (value: string, providerMessageId?: string): FlowRow => {
  const event = { ...base(), kind: 'assistant_message', message: text(value), final: false, state: 'streaming', ...(providerMessageId ? { providerMessageId } : {}) } as SessionEvent;
  return { key: `m${event.seq}`, event };
};
const answer = (value = 'Done'): FlowRow => {
  const event = { ...base(), kind: 'assistant_message', message: text(value), final: true, state: 'final' } as SessionEvent;
  return { key: `a${event.seq}`, event };
};
const step = (label: string, turnId: string | undefined = TURN): FlowRow => {
  const event = { ...base(turnId), kind: 'page_tool', messageId: `p${seq}`, label } as SessionEvent;
  return { key: `p${event.seq}`, event };
};
const shape = (parts: ReturnType<typeof structureTimeline>) => parts.map(part =>
  part.kind === 'row' ? `row ${part.key}` :
  part.kind === 'say' ? `say ${part.rowKey ?? JSON.stringify(part.text)}` :
  `work[${part.rows.join(',')}]${part.recap ? ` "${part.recap}"` : ''}${part.live ? ' live' : ''}`);

describe('timeline rounds from the turn outline', () => {
  // The GPT-6 shell turn observed on 2026-10-08: two sentences, then a call and its recap, and so on.
  const gpt6: TurnTrace = [
    { kind: 'say', id: 'm-1', text: 'Vou criar os três arquivos em sequência.', done: true },
    { kind: 'say', id: 'm-2', text: 'Vou criar `a.txt` com uma linha de teste.', done: true },
    { kind: 'call', id: 'k-1', tool: 'apply_patch', done: true },
    { kind: 'recap', text: 'Adicionado arquivo de teste ao projeto' },
    { kind: 'say', id: 'm-3', text: 'Vou criar `b.txt` com uma linha de teste.', done: true },
    { kind: 'call', id: 'k-2', tool: 'apply_patch', done: true },
    { kind: 'recap', text: 'Adicionou o arquivo B ao projeto' },
    { kind: 'call', id: 'k-3', tool: 'apply_patch', done: true },
    { kind: 'call', id: 'k-4', tool: 'exec_command', done: true },
    { kind: 'recap', text: 'Adicionados e listados arquivos' }
  ];

  it('puts each sentence before its round and titles each round with its recap', () => {
    const rows = [user(), call('Created a.txt'), call('Created b.txt'), call('Created c.txt'), call('Ran ls', 'exec_command'), answer()];
    expect(shape(structureTimeline(rows, { [TURN]: gpt6 }, false))).toEqual([
      `row ${rows[0]!.key}`,
      'say "Vou criar os três arquivos em sequência."',
      'say "Vou criar `a.txt` com uma linha de teste."',
      `work[${rows[1]!.key}] "Adicionado arquivo de teste ao projeto"`,
      'say "Vou criar `b.txt` com uma linha de teste."',
      `work[${rows[2]!.key}] "Adicionou o arquivo B ao projeto"`,
      `work[${rows[3]!.key},${rows[4]!.key}] "Adicionados e listados arquivos"`,
      `row ${rows[5]!.key}`
    ]);
  });

  it('keeps the round open and live while the turn works, and adds calls the outline has not shown yet', () => {
    const rows = [user(), call('Created a.txt'), call('Created b.txt')];
    const partial = gpt6.slice(0, 5);
    expect(shape(structureTimeline(rows, { [TURN]: partial }, true))).toEqual([
      `row ${rows[0]!.key}`,
      'say "Vou criar os três arquivos em sequência."',
      'say "Vou criar `a.txt` com uma linha de teste."',
      `work[${rows[1]!.key}] "Adicionado arquivo de teste ao projeto"`,
      'say "Vou criar `b.txt` com uma linha de teste."',
      `work[${rows[2]!.key}] live`
    ]);
  });

  it('shows a new chat\'s first sentence before any of its work is recorded', () => {
    // The Working line follows your message; the live row closes the timeline and stays last.
    const rows: FlowRow[] = [user(), { key: 'working' }, { key: 'now', tail: true }];
    expect(shape(structureTimeline(rows, { [TURN]: gpt6.slice(0, 1) }, true, TURN))).toEqual([
      `row ${rows[0]!.key}`, 'row working', 'say "Vou criar os três arquivos em sequência."', 'row now'
    ]);
  });

  it('uses a recorded interim message for its sentence instead of repeating it', () => {
    const rows = [user(), say('Vou criar os três arquivos em sequência.', 'm-1'), call('Created a.txt'), answer()];
    const parts = structureTimeline(rows, { [TURN]: gpt6.slice(0, 4) }, false);
    expect(shape(parts)).toEqual([
      `row ${rows[0]!.key}`, `say ${rows[1]!.key}`, 'say "Vou criar `a.txt` com uma linha de teste."',
      `work[${rows[2]!.key}] "Adicionado arquivo de teste ao projeto"`, `row ${rows[3]!.key}`
    ]);
  });

  it('drops a recap ChatGPT published late as a native step, and keeps other steps in their round', () => {
    const rows = [user(), call('Created a.txt'), step('Searched the web'), answer(), step('Adicionado arquivo de teste ao projeto')];
    expect(shape(structureTimeline(rows, { [TURN]: gpt6.slice(2, 4) }, false))).toEqual([
      `row ${rows[0]!.key}`, `work[${rows[1]!.key},${rows[2]!.key}] "Adicionado arquivo de teste ao projeto"`, `row ${rows[3]!.key}`
    ]);
  });

  it('draws a sentence once when a later page scan records it again without its turn', () => {
    // Measured live 2026-10-17: after the turn ended, a page scan recorded its first sentence and a
    // step once more, with no turn; the outline had already drawn both inside the turn.
    const late = (row: FlowRow): FlowRow => { const { turnId: _turn, ...event } = row.event as SessionEvent & { turnId?: string }; return { ...row, event: event as SessionEvent }; };
    const rows = [user(), call('Created a.txt'), answer(), late(say('Vou criar os três arquivos em sequência.', 'm-1')),
      late(say('Vou criar `a.txt` com uma linha de teste.')), late(step('Adicionado arquivo de teste ao projeto'))];
    expect(shape(structureTimeline(rows, { [TURN]: gpt6.slice(0, 4) }, false))).toEqual([
      `row ${rows[0]!.key}`, 'say "Vou criar os três arquivos em sequência."', 'say "Vou criar `a.txt` com uma linha de teste."',
      `work[${rows[1]!.key}] "Adicionado arquivo de teste ao projeto"`, `row ${rows[2]!.key}`
    ]);
  });

  it('keeps a sentence without a turn that no outline says', () => {
    const rows = [user(), call('Created a.txt'), answer(), say('Something only the page recorded, long enough to compare.')];
    const { turnId: _turn, ...event } = rows[3]!.event as SessionEvent & { turnId?: string };
    rows[3] = { ...rows[3]!, event: event as SessionEvent };
    expect(shape(structureTimeline(rows, { [TURN]: gpt6.slice(2, 4) }, false))).toEqual([
      `row ${rows[0]!.key}`, `work[${rows[1]!.key}] "Adicionado arquivo de teste ao projeto"`, `row ${rows[2]!.key}`, `say ${rows[3]!.key}`
    ]);
  });

  it('gives a code-mode exec the calls the rest of the outline cannot account for', () => {
    const trace: TurnTrace = [
      { kind: 'exec', id: 'x-1', done: true }, { kind: 'recap', text: 'Read the project' },
      { kind: 'call', id: 'k-9', tool: 'apply_patch', done: true }, { kind: 'recap', text: 'Edited the readme' }
    ];
    const rows = [user(), call('Read a', 'read'), call('Read b', 'read'), call('Read c', 'read'), call('Edited README'), answer()];
    expect(shape(structureTimeline(rows, { [TURN]: trace }, false))).toEqual([
      `row ${rows[0]!.key}`, `work[${rows[1]!.key},${rows[2]!.key},${rows[3]!.key}] "Read the project"`,
      `work[${rows[4]!.key}] "Edited the readme"`, `row ${rows[5]!.key}`
    ]);
  });

  it('skips calls ChatGPT shows but this app never received, so later rounds keep their calls', () => {
    // Measured 2026-10-07: a 22-minute turn showed 106 calls and recorded 92; most missing ones were exec_command.
    const trace: TurnTrace = [
      { kind: 'call', id: 'k-1', tool: 'exec_command', done: true },
      { kind: 'call', id: 'k-2', tool: 'exec_command', done: true },
      { kind: 'call', id: 'k-3', tool: 'read', done: true },
      { kind: 'recap', text: 'Inspected the project' },
      { kind: 'call', id: 'k-4', tool: 'apply_patch', done: true },
      { kind: 'recap', text: 'Edited the game' }
    ];
    const rows = [user(), call('Ran ls', 'exec_command'), call('Read main.js', 'read'), call('Edited main.js'), answer()];
    expect(shape(structureTimeline(rows, { [TURN]: trace }, false))).toEqual([
      `row ${rows[0]!.key}`, `work[${rows[1]!.key},${rows[2]!.key}] "Inspected the project"`,
      `work[${rows[3]!.key}] "Edited the game"`, `row ${rows[4]!.key}`
    ]);
  });

  it('matches a call by when the page first showed it when the tool alone is ambiguous', () => {
    const rows = [user(), call('Ran build', 'exec_command'), answer()];
    const started = rows[1]!.event!.time;
    const trace: TurnTrace = [
      { kind: 'call', id: 'k-1', tool: 'exec_command', done: true, at: started - 600_000 },
      { kind: 'recap', text: 'Tried the build' },
      { kind: 'call', id: 'k-2', tool: 'exec_command', done: true, at: started + 400 },
      { kind: 'recap', text: 'Built the game' }
    ];
    expect(shape(structureTimeline(rows, { [TURN]: trace }, false))).toEqual([
      `row ${rows[0]!.key}`, '"Tried the build"', `work[${rows[1]!.key}] "Built the game"`, `row ${rows[2]!.key}`
    ].map(line => line.startsWith('"') ? `work[] ${line}` : line));
  });

  // A message you send while the turn works reaches it inside a call's result (#1231). It stands
  // where it arrived; the outline's later rounds follow it instead of being drawn above it.
  const injected = (): FlowRow => {
    const event = { ...base(), source: 'app', kind: 'user_message', inputId: 'i1', inputDelivery: 'confirmed', message: text('Also say BLUE') } as SessionEvent;
    return { key: `input:${event.seq}`, event };
  };

  it('keeps a message sent during the turn between the rounds it arrived between', () => {
    const rows = [user(), call('Created a.txt'), call('Created b.txt'), injected(), call('Created c.txt'), call('Ran ls', 'exec_command'), answer()];
    expect(shape(structureTimeline(rows, { [TURN]: gpt6 }, false))).toEqual([
      `row ${rows[0]!.key}`,
      'say "Vou criar os três arquivos em sequência."',
      'say "Vou criar `a.txt` com uma linha de teste."',
      `work[${rows[1]!.key}] "Adicionado arquivo de teste ao projeto"`,
      'say "Vou criar `b.txt` com uma linha de teste."',
      `work[${rows[2]!.key}] "Adicionou o arquivo B ao projeto"`,
      `row ${rows[3]!.key}`,
      `work[${rows[4]!.key},${rows[5]!.key}] "Adicionados e listados arquivos"`,
      `row ${rows[6]!.key}`
    ]);
  });

  it('splits a round a message arrived in the middle of, titling the part that finished it', () => {
    const rows = [user(), call('Created a.txt'), call('Created b.txt'), call('Created c.txt'), injected(), call('Ran ls', 'exec_command'), answer()];
    const parts = structureTimeline(rows, { [TURN]: gpt6 }, false);
    expect(shape(parts).slice(5)).toEqual([
      `work[${rows[2]!.key}] "Adicionou o arquivo B ao projeto"`,
      `work[${rows[3]!.key}]`,
      `row ${rows[4]!.key}`,
      `work[${rows[5]!.key}] "Adicionados e listados arquivos"`,
      `row ${rows[6]!.key}`
    ]);
    expect(new Set(parts.map(part => part.key)).size).toBe(parts.length);
  });

  it('draws a sentence once when the message splits the turn before it', () => {
    const rows = [user(), call('Created a.txt'), injected(), say('Vou criar `b.txt` com uma linha de teste.', 'm-3'), call('Created b.txt'), answer()];
    expect(shape(structureTimeline(rows, { [TURN]: gpt6.slice(0, 7) }, false))).toEqual([
      `row ${rows[0]!.key}`,
      'say "Vou criar os três arquivos em sequência."',
      'say "Vou criar `a.txt` com uma linha de teste."',
      `work[${rows[1]!.key}] "Adicionado arquivo de teste ao projeto"`,
      `row ${rows[2]!.key}`,
      `say ${rows[3]!.key}`,
      `work[${rows[4]!.key}] "Adicionou o arquivo B ao projeto"`,
      `row ${rows[5]!.key}`
    ]);
  });

  it('keeps the answer out of the rounds while it is still being written', () => {
    const rows = [user(), call('Created a.txt'), say('Done: three files.', 'answer-1')];
    const trace: TurnTrace = [...gpt6.slice(2, 4), { kind: 'answer', id: 'answer-1' }];
    expect(shape(structureTimeline(rows, { [TURN]: trace }, true))).toEqual([
      `row ${rows[0]!.key}`, `work[${rows[1]!.key}] "Adicionado arquivo de teste ao projeto"`, `row ${rows[2]!.key}`
    ]);
  });

  it('keeps nested code-mode calls with the call that made them', () => {
    const trace: TurnTrace = [{ kind: 'call', id: 'k-1', done: true }, { kind: 'recap', text: 'Ran code' }];
    const rows = [user(), call('Ran code'), call('Read a', 'read', { nested: true }), answer()];
    expect(shape(structureTimeline(rows, { [TURN]: trace }, false))).toEqual([
      `row ${rows[0]!.key}`, `work[${rows[1]!.key},${rows[2]!.key}] "Ran code"`, `row ${rows[3]!.key}`
    ]);
  });
});

describe('timeline rounds without an outline', () => {
  it('opens a round at each interim message and titles a finished round with the native step that ends it', () => {
    const rows = [user(), say('Looking first'), call('Read a'), step('Inspected the project'), say('Now editing'), call('Edited a'), answer()];
    expect(shape(structureTimeline(rows, {}, false))).toEqual([
      `row ${rows[0]!.key}`, `say ${rows[1]!.key}`, `work[${rows[2]!.key}] "Inspected the project"`,
      `say ${rows[4]!.key}`, `work[${rows[5]!.key}]`, `row ${rows[6]!.key}`
    ]);
  });

  it('marks the newest round live while the turn works and never titles it with a step still in progress', () => {
    const rows = [user(), call('Read a'), step('Searching the web')];
    expect(shape(structureTimeline(rows, {}, true))).toEqual([`row ${rows[0]!.key}`, `work[${rows[1]!.key},${rows[2]!.key}] live`]);
  });
});

/**
 * 2.1.48 release round (Windows VM): after an automatic "Continue" (a fresh turn), ChatGPT keeps the
 * continued turns in one response, so each new turn's outline starts with the outlines of the turns
 * before it. Those sentences were drawn again in every later turn.
 */
describe('continued turns', () => {
  const FIRST = 'g-cont-0-1', SECOND = 'g-cont-0-2';
  const sayIn = (turnId: string, value: string, id: string): FlowRow => {
    const event = { ...base(turnId), kind: 'assistant_message', message: text(value), final: false, state: 'streaming', providerMessageId: id } as SessionEvent;
    return { key: `m${event.seq}`, event };
  };
  const callIn = (turnId: string, id: string): FlowRow => {
    const event = { ...base(turnId), kind: 'tool_call', call: { callId: id, tool: 'exec_command', summary: { kind: 'run', title: 'Ran a check' } } } as unknown as SessionEvent;
    return { key: `c${event.seq}`, event };
  };
  const OPENING = 'I’ll run the three timing checks one after the other.';
  const first: TurnTrace = [
    { kind: 'say', id: 's-1', text: OPENING, done: true },
    { kind: 'call', id: 'k-1', tool: 'exec_command', done: true }
  ];
  const second: TurnTrace = [
    ...first,
    { kind: 'recap', text: 'Waited for several processes' },
    { kind: 'say', id: 's-2', text: 'Continuing from the second timing check now.', done: true },
    { kind: 'call', id: 'k-2', tool: 'exec_command', done: true },
    { kind: 'now', text: 'Continuing the second wait' }
  ];
  const third: TurnTrace = [
    ...second.filter(item => item.kind !== 'now'),
    { kind: 'recap', text: 'Watched the commands finish' },
    { kind: 'say', id: 's-3', text: 'The third check has emitted its tick.', done: true }
  ];

  it('draws each sentence once, in the turn that said it', () => {
    const rows = [user(), sayIn(FIRST, OPENING, 's-1'), callIn(FIRST, 'k-1'), user(),
      step('Waited for several processes', SECOND), sayIn(SECOND, 'Continuing from the second timing check now.', 's-2'), callIn(SECOND, 'k-2')];
    const parts = structureTimeline(rows, { [FIRST]: first, [SECOND]: second }, false);
    const sayings = parts.filter(part => part.kind === 'say');
    expect(sayings.map(part => part.rowKey ?? part.text)).toEqual([rows[1]!.key, rows[5]!.key]);
    expect(shape(parts).filter(line => line.startsWith('say "'))).toEqual([]);
  });

  it('drops the longest earlier outline a turn repeats, ignoring what an earlier turn was doing right now', () => {
    const THIRD = 'g-cont-0-3';
    const rows = [user(), sayIn(FIRST, OPENING, 's-1'), callIn(FIRST, 'k-1'), user(),
      sayIn(SECOND, 'Continuing from the second timing check now.', 's-2'), callIn(SECOND, 'k-2'), user(),
      sayIn(THIRD, 'The third check has emitted its tick.', 's-3')];
    const parts = structureTimeline(rows, { [FIRST]: first, [SECOND]: second, [THIRD]: third }, false);
    expect(parts.filter(part => part.kind === 'say').map(part => part.rowKey ?? part.text)).toEqual([rows[1]!.key, rows[4]!.key, rows[7]!.key]);
    // The third turn keeps its own recap.
    expect(parts.some(part => part.kind === 'work' && part.recap === 'Watched the commands finish')).toBe(true);
  });

  it('keeps a later turn’s own sentence that only reads like an earlier turn’s whole outline', () => {
    const rows = [user(), sayIn(FIRST, 'Let me look at the file first.', 's-1'), user(),
      sayIn(SECOND, 'Let me look at the file first.', 's-9'), callIn(SECOND, 'k-9')];
    const parts = structureTimeline(rows, {
      [FIRST]: [{ kind: 'say', id: 's-1', text: 'Let me look at the file first.', done: true }],
      [SECOND]: [{ kind: 'say', id: 's-9', text: 'Let me look at the file first.', done: true }, { kind: 'call', id: 'k-9', tool: 'exec_command', done: true }]
    }, false);
    expect(parts.filter(part => part.kind === 'say').map(part => part.rowKey ?? part.text)).toEqual([rows[1]!.key, rows[3]!.key]);
  });

  // CodeRabbit on #1933: a live continued turn whose outline so far only repeats the turn before it.
  it('draws nothing of an earlier turn while a continued turn has not added its own part yet', () => {
    const rows = [user(), sayIn(FIRST, OPENING, 's-1'), callIn(FIRST, 'k-1'), user()];
    const parts = structureTimeline(rows, { [FIRST]: first, [SECOND]: [...first] }, true, SECOND);
    expect(parts.filter(part => part.kind === 'say').map(part => part.rowKey ?? part.text)).toEqual([rows[1]!.key]);
  });

  // CodeRabbit on #1933: only an earlier turn's outline is dropped, never a later or unrelated one's.
  it('never trims an earlier turn by a later turn’s shorter outline', () => {
    // The earlier turn's opening sentence is only in its outline, not recorded as a message.
    const rows = [user(), callIn(FIRST, 'k-1'), callIn(FIRST, 'k-2'), user()];
    const parts = structureTimeline(rows, { [FIRST]: second.filter(item => item.kind !== 'now'), [SECOND]: first }, false);
    expect(parts.some(part => part.kind === 'say' && part.text === OPENING)).toBe(true);
  });

  it('needs an id to prove a continuation, not only the same opening words', () => {
    const rows = [user(), sayIn(FIRST, 'Let me look at the file first.', 's-1'), user()];
    const parts = structureTimeline(rows, {
      [FIRST]: [{ kind: 'say', text: 'Let me look at the file first.', done: true }],
      [SECOND]: [{ kind: 'say', text: 'Let me look at the file first.', done: true }, { kind: 'say', text: 'It has three sections.', done: true }]
    }, true, SECOND);
    expect(parts.filter(part => part.kind === 'say' && part.text === 'Let me look at the file first.')).toHaveLength(1);
  });

  it('keeps an outline whole when no other turn’s outline begins it', () => {
    const rows = [user(), sayIn(FIRST, OPENING, 's-1'), callIn(FIRST, 'k-1')];
    expect(structureTimeline(rows, { [FIRST]: first, [SECOND]: second }, false).filter(part => part.kind === 'say')).toHaveLength(1);
  });
});
