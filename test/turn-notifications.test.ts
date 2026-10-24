import { expect, it } from 'vitest';
import { createTurnNotifier, noticeText } from '../src/main/turn-notifications.js';
import type { SessionSummary } from '../src/shared/session.js';

// Codex notifies when a turn completes. Chat On Steroids only did for Session finish and stuck
// chats, so a finished answer went unnoticed while the window was in the background.

const chat = (id: string, extra: Partial<SessionSummary> = {}) => ({
  id, title: `Chat ${id}`, conversationId: `conv-${id}`, startedAt: 1, lastTurnEndAt: 100, lastTurnOutcome: 'completed', activeTurnId: null, ...extra
}) as SessionSummary;

function setup(initial: SessionSummary[]) {
  const sessions = new Map(initial.map(row => [row.id, row]));
  const shown: Array<{ title: string; body: string; sessionId: string }> = [];
  const state = { enabled: true, focused: false, automated: new Set<string>(), recent: new Set<string>() };
  const notifier = createTurnNotifier({
    getSession: async id => sessions.get(id) ?? null,
    lastAnswer: async () => '**Done.** 53 devices are back.\n\nDetails follow.',
    enabled: () => state.enabled, focused: () => state.focused,
    automated: conversationId => state.automated.has(conversationId),
    recentlyNotified: sessionId => state.recent.has(sessionId),
    show: (title, body, sessionId) => { shown.push({ title, body, sessionId }); }
  });
  notifier.seed(initial);
  const end = (id: string, extra: Partial<SessionSummary> = {}) => { sessions.set(id, { ...sessions.get(id)!, lastTurnEndAt: (sessions.get(id)!.lastTurnEndAt ?? 0) + 50, ...extra }); };
  return { notifier, shown, state, end };
}

it('notifies once when a chat finishes a turn while the window is in the background', async () => {
  const { notifier, shown, end } = setup([chat('a'), chat('b')]);
  await notifier.handle(['a', 'b']);
  expect(shown).toEqual([]);
  end('a');
  await notifier.handle(['a', 'b']);
  await notifier.handle(['a']);
  expect(shown).toEqual([{ title: 'Chat a', body: 'Done. 53 devices are back.', sessionId: 'a' }]);
});

it('stays quiet while you are looking, when switched off, for stops and errors, and for chats that go on by themselves', async () => {
  const { notifier, shown, state, end } = setup([chat('a'), chat('w', { origin: { kind: 'worker' } as SessionSummary['origin'] }), chat('g'), chat('f'), chat('s')]);
  state.focused = true; end('a'); await notifier.handle(['a']);
  state.focused = false; state.enabled = false; end('a'); await notifier.handle(['a']);
  state.enabled = true;
  end('w'); await notifier.handle(['w']);
  state.automated.add('conv-g'); end('g'); await notifier.handle(['g']);
  state.recent.add('f'); end('f'); await notifier.handle(['f']);
  end('s', { lastTurnOutcome: 'stopped' }); await notifier.handle(['s']);
  end('a', { activeTurnId: 'next-turn' }); await notifier.handle(['a']);
  expect(shown).toEqual([]);
});

it('says the answer is ready when there is no answer text to show', () => {
  expect(noticeText(null)).toBe('ChatGPT finished.');
  expect(noticeText('   ')).toBe('ChatGPT finished.');
  expect(noticeText(`# Heading\n${'word '.repeat(80)}`).length).toBeLessThanOrEqual(140);
  expect(noticeText('[the docs](https://example.com) are `updated`')).toBe('the docs are updated');
  // ChatGPT's link cards come as private-use markup; the notice shows their label.
  expect(noticeText('Open \uE200url\uE202the comparison\uE202https://github.com/o/r/compare\uE201 to merge.')).toBe('Open the comparison to merge.');
});

it('keeps underscores, issue numbers and comparisons that are part of the answer', () => {
  // Every `_ * # > ~` was removed from the whole answer: "goal_r40.txt" read "goalr40.txt" (2.1.41 pass).
  expect(noticeText('Created **goal_r40.txt** for #1590; size > 0 and 2*3 = 6.')).toBe('Created goal_r40.txt for #1590; size > 0 and 2*3 = 6.');
  expect(noticeText('```ts\nconst a = 1;\n```\n\nThe `snake_case` name is kept.')).toBe('The snake_case name is kept.');
  expect(noticeText('> quoted _emphasis_ here')).toBe('quoted emphasis here');
});

it('says the answer is ready in the interface language', async () => {
  const texts = await import('../src/main/main-texts.js');
  texts.setMainTextTranslations({ 'ChatGPT finished.': 'ChatGPT ist fertig.' });
  try { expect(noticeText(null)).toBe('ChatGPT ist fertig.'); }
  finally { texts.setMainTextTranslations({}); }
});

it('hands every finished chat to the phone with how long it worked, even while the window is in front', async () => {
  const sessions = new Map([chat('a'), chat('w', { origin: { kind: 'worker' } as SessionSummary['origin'] }), chat('g'), chat('s')].map(row => [row.id, row]));
  const phone: unknown[] = [];
  const shown: string[] = [];
  const notifier = createTurnNotifier({
    getSession: async id => sessions.get(id) ?? null,
    lastAnswer: async () => 'All tests pass.',
    enabled: () => true, focused: () => true,
    automated: conversationId => conversationId === 'conv-g',
    recentlyNotified: () => false,
    show: (_title, _body, sessionId) => { shown.push(sessionId); },
    turnStartedAt: async id => id === 'a' ? 150 - 12 * 60_000 : null,
    phone: event => { phone.push(event); }
  });
  notifier.seed([...sessions.values()]);
  for (const id of ['a', 'w', 'g']) sessions.set(id, { ...sessions.get(id)!, lastTurnEndAt: 150 });
  sessions.set('s', { ...sessions.get('s')!, lastTurnEndAt: 150, lastTurnOutcome: 'stopped' });
  await notifier.handle(['a', 'w', 'g', 's']);
  // The window is in front, so no desktop notice; the phone decides for itself whether someone is there.
  expect(shown).toEqual([]);
  expect(phone).toEqual([{ sessionId: 'a', chatTitle: 'Chat a', conversationId: 'conv-a', workedMs: 12 * 60_000, detail: 'All tests pass.' }]);
});
