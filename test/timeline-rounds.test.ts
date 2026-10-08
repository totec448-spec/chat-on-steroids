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
