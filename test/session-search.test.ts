import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { initConfigPath, defaultConfig, saveConfig } from '../src/main/config.js';
import { initDurableStore, flushDurable, resetDurableForTests } from '../src/main/durable.js';
import {
  createSession, deleteSession, flushSessions, initSessionStore, renameSession, resetSessionStoreForTests, sessionSearchIndexPath, upsertMessageEvent
} from '../src/main/session/store.js';
import { foldCase, queryTerms, resetSessionSearchForTests, searchIndexingSettled, searchSessions, snippetFor } from '../src/main/session/search.js';
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
