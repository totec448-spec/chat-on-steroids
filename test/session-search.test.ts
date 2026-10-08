import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { initConfigPath, defaultConfig, saveConfig } from '../src/main/config.js';
import { initDurableStore, flushDurable, resetDurableForTests } from '../src/main/durable.js';
import {
  createSession, deleteSession, flushSessions, initSessionStore, readEvents, renameSession, resetSessionStoreForTests, sessionSearchIndexPath, upsertMessageEvent
} from '../src/main/session/store.js';
import { foldCase, locateSearchMatch, queryTerms, resetSessionSearchForTests, searchIndexingSettled, searchSessions, snippetFor } from '../src/main/session/search.js';
import { positionOf } from '../src/shared/chronology.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;
beforeEach(async () => {
  directory = await makeTempDir('cos-search-');
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
  await saveConfig(defaultConfig());
  resetSessionSearchForTests();
});
afterEach(async () => {
  await searchIndexingSettled(); resetSessionSearchForTests();
  vi.restoreAllMocks();
  await flushDurable(); resetSessionStoreForTests(); resetDurableForTests(); await removeTempDir(directory);
});

let counter = 0;
async function chat(title: string, said: Array<['user' | 'assistant', string, string?]>, origin?: 'helper'): Promise<string> {
  const session = await createSession({ conversationId: `search-chat-${++counter}`, title, ...(origin ? { origin: { kind: origin, fromSessionId: null, agentId: null, task: '' } } : {}) });
  for (const [role, text, authored] of said) {
    const messageId = `message-${++counter}`;
    if (role === 'user') {
      await upsertMessageEvent(session.id, { kind: 'user_message', source: 'app', time: Date.now(), messageId,
        ...(authored ? { authoredText: authored } : {}), message: { text, chars: text.length, truncated: false } });
    } else {
      await upsertMessageEvent(session.id, { kind: 'assistant_message', source: 'extension', time: Date.now(), messageId,
        message: { text, chars: text.length, truncated: false }, state: 'final', final: true });
    }
  }
  await flushSessions();
  return session.id;
}
async function search(query: string) {
  await searchSessions(query);
  await searchIndexingSettled();
  return searchSessions(query);
}

it('finds chats by title and by what was said, every word in any order, titles first', async () => {
  const bridge = await chat('Flaky bridge test', [['user', 'why does the bridge test fail on Windows?']]);
  const deploy = await chat('Release planning', [['user', 'plan the release'], ['assistant', 'First tag the build, then the bridge gets its WINDOWS installer.']]);
  await chat('Unrelated', [['user', 'write a haiku about snow']]);
  const reply = await search('windows bridge');
  // Both match by their words (one in the title, the other in the text): newest first.
  expect(reply.results.map(result => result.id)).toEqual([deploy, bridge]);
  expect(reply.results.map(result => result.id).sort()).toEqual([bridge, deploy].sort());
  const fromText = reply.results.find(result => result.id === deploy)!;
  const marked = fromText.snippet!.matches.map(([start, end]) => fromText.snippet!.text.slice(start, end).toLowerCase());
  expect(marked).toEqual(expect.arrayContaining(['bridge', 'windows']));
  expect(reply).toMatchObject({ indexed: 3, total: 3 });
  // A title match ranks above a text match, and needs no snippet.
  const titled = await search('flaky');
  expect(titled.results).toEqual([{ id: bridge, title: 'Flaky bridge test', projectId: null, titleMatches: [[0, 5]] }]);
  // A word found in the title is marked there too, also when the rest is found in the text.
  expect(fromText.titleMatches).toBeUndefined();
  expect(reply.results.find(result => result.id === bridge)!.titleMatches).toEqual([[6, 12]]);
  expect((await search('   ')).results).toEqual([]);
});

it('indexes the user\'s own words, not the instructions an app-sent message carried', async () => {
  const id = await chat('Opened by the app', [['user', '[[COS_CONTEXT:10]]\nSECRETPROTOCOLWORD instructions\n[[/COS_CONTEXT]]\n\nRefactor the parser', 'Refactor the parser']]);
  expect((await search('refactor parser')).results.map(result => result.id)).toEqual([id]);
  expect((await search('SECRETPROTOCOLWORD')).results).toEqual([]);
});

it('keeps each index current: a new message is found, a renamed title is found, a deleted chat is gone with its index', async () => {
  const id = await chat('Notes', [['user', 'first topic']]);
  expect((await search('second')).results).toEqual([]);
  await upsertMessageEvent(id, { kind: 'assistant_message', source: 'extension', time: Date.now(), messageId: 'later-answer',
    message: { text: 'Now the second topic.', chars: 21, truncated: false }, state: 'final', final: true });
  await flushSessions();
  expect((await search('second')).results.map(result => result.id)).toEqual([id]);
  await renameSession(id, 'Quarterly planning');
  expect((await search('quarterly')).results.map(result => result.id)).toEqual([id]);
  const index = sessionSearchIndexPath(id);
  await expect(fs.stat(index)).resolves.toBeTruthy();
  await deleteSession(id);
  expect((await search('topic')).results).toEqual([]);
  await expect(fs.stat(index)).rejects.toThrow();
});

it('reuses a stored index after a restart instead of reading the chat again', async () => {
  const id = await chat('Restart', [['user', 'remember the lighthouse']]);
  expect((await search('lighthouse')).results.map(result => result.id)).toEqual([id]);
  const stored = await fs.readFile(sessionSearchIndexPath(id), 'utf8');
  // Restart: memory is gone; a stored index with the same stamp is trusted as is.
  resetSessionSearchForTests();
  await fs.writeFile(sessionSearchIndexPath(id), stored.replace('lighthouse', 'lightship'));
  expect((await search('lightship')).results.map(result => result.id)).toEqual([id]);
});

it('leaves helper chats out, as the sidebar does', async () => {
  await chat('Helper', [['user', 'internal helper words']], 'helper');
  expect(await search('internal')).toMatchObject({ results: [], total: 0 });
});

it('ranks an older title match before newer text matches even at a small result limit', async () => {
  let clock = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => ++clock);
  const title = await chat('Needle in the title', [['user', 'ordinary words']]);
  for (let index = 0; index < 5; index++) await chat(`Recent ${index}`, [['user', 'needle in the text']]);
  await search('needle');
  const reply = await searchSessions('needle', 2);
  expect(reply.results[0]!.id).toBe(title);
  expect(reply.results).toHaveLength(2);
  expect(reply.limited).toBe(true);
});

it('does not return superseded words while a changed chat awaits reindexing', async () => {
  const id = await chat('Revision', [['user', 'obsolete needle']]);
  await search('needle');
  const original = (await readEvents(id, { kinds: ['user_message'] }))[0]!;
  if (original.kind !== 'user_message') throw new Error('Missing original question');
  await upsertMessageEvent(id, { ...original, time: original.time + 10,
    message: { text: 'replacement words', chars: 17, truncated: false } });
  await flushSessions();
  expect((await searchSessions('needle')).results).toEqual([]);
  await searchIndexingSettled();
  expect((await search('replacement')).results.map(result => result.id)).toEqual([id]);
});

it('marks matches at the right place, also around characters whose lowercase is longer', () => {
  expect(foldCase('İstanbul Straße')).toHaveLength('İstanbul Straße'.length);
  const text = 'İstanbul: the bridge to İzmir';
  const lower = foldCase(text);
  const snippet = snippetFor(text, lower, ['bridge'])!;
  const [start, end] = snippet.matches[0]!;
  expect(snippet.text.slice(start, end)).toBe('bridge');
  expect(queryTerms('  Bridge   bridge  WINDOWS ')).toEqual(['bridge', 'windows']);
  // A long line is cut around the match, with ellipses.
  const long = `${'a'.repeat(300)} needle ${'b'.repeat(300)}`;
  const cut = snippetFor(long, long, ['needle'])!;
  expect(cut.text.startsWith('…') && cut.text.endsWith('…')).toBe(true);
  expect(cut.text.slice(cut.matches[0]![0], cut.matches[0]![1])).toBe('needle');
});

it('matches words without their accents, at the right place, and says when more chats match than it shows', async () => {
  const german = await chat('Prüfung der Größe', [['user', 'Notizen zum Café in São Paulo']]);
  const turkish = await chat('İstanbul trip', [['user', 'plan the route']]);
  expect((await search('prufung grosse')).results.map(result => result.id)).toEqual([]);
  expect((await search('prufung')).results).toEqual([{ id: german, title: 'Prüfung der Größe', projectId: null, titleMatches: [[0, 7]] }]);
  const cafe = (await search('cafe sao')).results.find(result => result.id === german)!;
  expect(cafe.snippet!.matches.map(([start, end]) => cafe.snippet!.text.slice(start, end))).toEqual(['Café', 'São']);
  expect((await search('ISTANBUL')).results.map(result => result.id)).toEqual([turkish]);
  // Folding never changes a string's length, so ranges index the original.
  for (const text of ['Prüfung', 'İstanbul', 'Ǆemal', 'ẞ', 'Tiếng Việt', '😀 café']) expect(foldCase(text)).toHaveLength(text.length);

  await chat('Third café chat', [['user', 'more coffee']]);
  await chat('Fourth chat', [['assistant', 'The café opens at nine.']]);
  await search('cafe');
  expect(await searchSessions('cafe', 2)).toMatchObject({ limited: true });
  expect((await searchSessions('cafe', 2)).results).toHaveLength(2);
  expect(await searchSessions('cafe', 3)).not.toHaveProperty('limited');
  expect((await searchSessions('cafe', 3)).results).toHaveLength(3);
});

it('locates the first message holding the query, so a result opens there', async () => {
  const id = await chat('Release planning', [
    ['user', 'plan the release'],
    ['assistant', 'First tag the build.'],
    ['user', 'and the Wíndows installer?'],
    ['assistant', 'The windows installer comes after the bridge.']
  ]);
  const { readEvents } = await import('../src/main/session/store.js');
  const said = (await readEvents(id, { kinds: ['user_message', 'assistant_message'] }));
  // Accents and case fold as in the search itself; the first message holding a word wins.
  const found = await locateSearchMatch(id, 'WINDOWS');
  const third = said.find(event => event.kind === 'user_message' && event.message.text.startsWith('and the'))!;
  expect(found).toEqual({ seq: third.seq, kind: 'user_message', messageId: (third as { messageId?: string }).messageId ?? null, position: positionOf(third) });
  // Any one of the words is enough to place it: the snippet came from the first of them.
  expect((await locateSearchMatch(id, 'bridge installer'))?.seq).toBe(third.seq);
  expect((await locateSearchMatch(id, 'bridge'))?.kind).toBe('assistant_message');
  // Nothing said matches (a title-only match): no place to open at.
  expect(await locateSearchMatch(id, 'planning')).toBeNull();
  expect(await locateSearchMatch(id, '   ')).toBeNull();
});
