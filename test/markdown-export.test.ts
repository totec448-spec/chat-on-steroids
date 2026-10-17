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
