import { expect, it } from 'vitest';
import type { SessionEvent } from '../src/shared/session.js';
import {
  answerAnchors, answerMarkdown, completedTurnIds, markdownFileName, messageAnswerAnchors, messageAnswerEntries, sessionMarkdown,
  transcriptEntries, turnAnswerEntries
} from '../src/shared/markdown-export.js';

const text = (value: string) => ({ text: value, truncated: false, chars: value.length });
let seq = 0;
const user = (turnId: string, value: string, extra: object = {}): SessionEvent =>
  ({ seq: ++seq, time: seq, source: 'extension', kind: 'user_message', turnId, messageId: `u-${seq}`, message: text(value), ...extra }) as SessionEvent;
const answer = (turnId: string, messageId: string, value: string, final = true): SessionEvent =>
  ({ seq: ++seq, time: seq, source: 'extension', kind: 'assistant_message', turnId, messageId, message: text(value), final, state: final ? 'final' : 'streaming' }) as SessionEvent;
const end = (turnId: string, outcome = 'completed'): SessionEvent =>
  ({ seq: ++seq, time: seq, source: 'extension', kind: 'turn_end', turnId, outcome }) as SessionEvent;

it('keeps each message once, at its latest revision, without partial answers or continuation prompts', () => {
  seq = 0;
  const events = [
    user('t1', 'Write a hello file', { authoredText: 'Write a hello file' }),
    answer('t1', 'a1', 'Working on', false),
    answer('t1', 'a1', 'Done: hello.txt'),
    end('t1'),
    user('t2', '[[CLF-HANDOFF:abcdefghijklmnop]] Write the handoff brief.'),
    answer('t2', 'a2', 'Brief draft', false),
    user('t3', 'Now in Portuguese', { authoredText: 'Now in Portuguese' }),
    answer('t3', 'a3', 'Pronto: ola.txt'),
    answer('t3', 'a1', 'Done: hello.txt (revised)')
  ];
  expect(transcriptEntries(events).map(entry => [entry.role, entry.stored.text])).toEqual([
    ['user', 'Write a hello file'],
    ['assistant', 'Done: hello.txt (revised)'],
    ['user', 'Now in Portuguese'],
    ['assistant', 'Pronto: ola.txt']
  ]);
});

// 2.1.47 round: Share as web page put "Done" above the question that asked for it. The question's
// latest revision (its delivery confirmed after the answer) carried a later work stamp than the answer.
it('keeps a question above its answer when the question was revised after the answer', () => {
  const events = [
    { seq: 3, time: 1000, source: 'extension', kind: 'turn_start', turnId: 'g-1' },
    { seq: 4, time: 1100, source: 'extension', kind: 'tool_call', turnId: 'g-1', call: { callId: 'c1', tool: 'apply_patch', outcome: 'ok', summary: { kind: 'edit', tone: 'good', title: 'Edited 2 files' } } },
    { seq: 7, origin: 6, contentSeq: 7, finalContentSeq: 7, time: 1400, source: 'extension', kind: 'assistant_message', turnId: 'g-1', messageId: 'a1',
      message: text('Done'), final: true, state: 'final' },
    { seq: 8, time: 1500, source: 'extension', kind: 'turn_end', turnId: 'g-1', outcome: 'completed' },
    { seq: 16, origin: 1, contentSeq: 16, time: 900, source: 'app', kind: 'user_message', messageId: 'q1', inputDelivery: 'confirmed',
      message: text('Change the line, then reply Done'), authoredText: 'Change the line, then reply Done' }
  ] as unknown as SessionEvent[];
  expect(transcriptEntries(events).map(entry => [entry.role, entry.stored.text])).toEqual([
    ['user', 'Change the line, then reply Done'],
    ['assistant', 'Done']
  ]);
});

it('keeps a message sent mid-turn above the answer that ended that turn, even when the answer was opened first', () => {
  const events = [
    { seq: 1, time: 1000, source: 'app', kind: 'user_message', messageId: 'q1', message: text('Fix the build') },
    { seq: 2, time: 1010, source: 'extension', kind: 'turn_start', turnId: 'g-2' },
    { seq: 3, time: 1020, authoredAt: 1020, source: 'extension', kind: 'assistant_message', turnId: 'g-2', messageId: 'a1', message: text('Looking'), final: false, state: 'streaming' },
    { seq: 5, time: 1200, source: 'app', kind: 'user_message', turnId: 'g-2', messageId: 'q2', message: text('Also run the tests') },
    { seq: 9, origin: 3, contentSeq: 9, finalContentSeq: 9, time: 1900, authoredAt: 1020, source: 'extension', kind: 'assistant_message', turnId: 'g-2', messageId: 'a1',
      message: text('Built and tested'), final: true, state: 'final' },
    { seq: 10, time: 2000, source: 'extension', kind: 'turn_end', turnId: 'g-2', outcome: 'completed' }
  ] as unknown as SessionEvent[];
  expect(transcriptEntries(events).map(entry => entry.stored.text)).toEqual(['Fix the build', 'Also run the tests', 'Built and tested']);
});

it('places an answer once, by its revisions together, so an older final snapshot cannot lift it above a mid-turn message (CodeRabbit)', () => {
  // A legacy journal kept two final snapshots of one answer, the first opened before the mid-turn message.
  const events = [
    { seq: 1, time: 1000, source: 'app', kind: 'user_message', messageId: 'q1', message: text('Fix the build') },
    { seq: 2, time: 1010, source: 'extension', kind: 'turn_start', turnId: 'g-3' },
    { seq: 4, time: 1100, authoredAt: 1020, source: 'extension', kind: 'assistant_message', turnId: 'g-3', messageId: 'a1', message: text('Built'), final: true, state: 'final' },
    { seq: 5, time: 1200, source: 'app', kind: 'user_message', turnId: 'g-3', messageId: 'q2', message: text('Also run the tests') },
    { seq: 9, time: 1900, authoredAt: 1020, source: 'extension', kind: 'assistant_message', turnId: 'g-3', messageId: 'a1', message: text('Built and tested'), final: true, state: 'final' },
    { seq: 10, time: 2000, source: 'extension', kind: 'turn_end', turnId: 'g-3', outcome: 'completed' }
  ] as unknown as SessionEvent[];
  expect(transcriptEntries(events).map(entry => entry.stored.text)).toEqual(['Fix the build', 'Also run the tests', 'Built and tested']);
});

it('keeps a message recorded without a turn where it was recorded (CodeRabbit)', () => {
  const events = [
    { seq: 1, time: 1000, source: 'app', kind: 'user_message', messageId: 'q1', message: text('First question') },
    { seq: 2, time: 1010, source: 'extension', kind: 'turn_start', turnId: 'g-4' },
    { seq: 3, time: 1100, source: 'extension', kind: 'assistant_message', turnId: 'g-4', messageId: 'a1', message: text('First answer'), final: true, state: 'final' },
    { seq: 4, time: 1200, source: 'extension', kind: 'turn_end', turnId: 'g-4', outcome: 'completed' },
    { seq: 5, time: 1300, source: 'extension', kind: 'assistant_message', messageId: 'a2', message: text('An answer read after a reload'), final: true, state: 'final' },
    { seq: 6, time: 1400, source: 'app', kind: 'user_message', messageId: 'q2', message: text('Second question') }
  ] as unknown as SessionEvent[];
  expect(transcriptEntries(events).map(entry => entry.stored.text))
    .toEqual(['First question', 'First answer', 'An answer read after a reload', 'Second question']);
});

it('prefers the text a person typed over the transport copy of their message', () => {
  seq = 0;
  const events = [user('t1', 'Do it\n\n<control instructions>', { authoredText: 'Do it' })];
  expect(transcriptEntries(events)[0]!.stored.text).toBe('Do it');
});

it('offers actions only for turns the page reported as completed, on their last answer', () => {
  seq = 0;
  const events = [
    user('t1', 'One'), answer('t1', 'a1', 'First part'), answer('t1', 'a2', 'Second part'), end('t1'),
    user('t2', 'Two'), answer('t2', 'a3', 'Stopped midway'), end('t2', 'interrupted'),
    user('t3', 'Three'), answer('t3', 'a4', 'Still going')
  ];
  expect([...completedTurnIds(events)]).toEqual(['t1']);
  const anchors = answerAnchors(events);
  expect([...anchors.keys()]).toEqual(['t1']);
  expect(anchors.get('t1')).toBe(events.find(event => event.kind === 'assistant_message' && event.messageId === 'a2')!.seq);
  expect(turnAnswerEntries(events, 't1').map(entry => entry.stored.text)).toEqual(['First part', 'Second part']);
});

// Answers recorded outside any turn: the history ChatGPT copied into a branch, an adopted chat's
// earlier answers, replies to messages typed in the ChatGPT tab. Each final one carries actions too.
it('offers actions on each final answer recorded without a turn, by its message id', () => {
  seq = 0;
  const loose = (messageId: string, value: string, final = true) =>
    ({ ...answer('x', messageId, value, final), turnId: undefined }) as SessionEvent;
  const events = [
    { ...user('x', 'Earlier question'), turnId: undefined } as SessionEvent,
    loose('b1', 'Earlier answer, first draft'), loose('b1', 'Earlier answer'),
    loose('b2', 'Still streaming', false),
    user('t1', 'Now'), answer('t1', 'a1', 'Turn answer'), end('t1')
  ];
  const anchors = messageAnswerAnchors(events);
  expect([...anchors.keys()]).toEqual(['b1']);
  expect(anchors.get('b1')).toBe(events.filter(event => event.kind === 'assistant_message' && event.messageId === 'b1').at(-1)!.seq);
  expect(messageAnswerEntries(events, 'b1').map(entry => entry.stored.text)).toEqual(['Earlier answer']);
  // A turn's own answer keeps its turn's actions, never a second set.
  expect(messageAnswerEntries(events, 'a1')).toEqual([]);
  expect([...answerAnchors(events).keys()]).toEqual(['t1']);
});

it('formats an answer and a session transcript as Markdown', () => {
  expect(answerMarkdown(['## Result\n\nDone.  ', '', 'Next step.'])).toBe('## Result\n\nDone.\n\nNext step.\n');
  expect(sessionMarkdown('Hello test', [
    { role: 'user', text: 'Write a file' }, { role: 'assistant', text: 'Created `hello.txt`.' }, { role: 'user', text: '  ' }
  ])).toBe('# Hello test\n\n## You\n\nWrite a file\n\n## ChatGPT\n\nCreated `hello.txt`.\n');
});

it('names files safely from chat titles', () => {
  expect(markdownFileName('Olá, teste: faça um "olá mundo" no C:\\Users?')).toBe('Olá, teste faça um olá mundo no C Users.md');
  expect(markdownFileName('   ...  ')).toBe('chat.md');
  expect(markdownFileName('Plan', ' - answer')).toBe('Plan - answer.md');
  expect(markdownFileName('x'.repeat(200)).length).toBe(83);
  // Truncating UTF-16 at a fixed length must not split an emoji into a lone surrogate.
  const prefix = 'x'.repeat(79);
  expect(markdownFileName(`${prefix}🧪 test`)).toBe(`${prefix}.md`);
  expect(markdownFileName(`${'x'.repeat(78)}🧪 test`)).toBe(`${'x'.repeat(78)}🧪.md`);
  expect(markdownFileName(`${prefix}🧪 test`, ' - answer')).toBe(`${prefix} - answer.md`);
});
