import { ReadStream } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { initConfigPath, defaultConfig, saveConfig } from '../src/main/config.js';
import { initDurableStore, flushDurable, resetDurableForTests } from '../src/main/durable.js';
import {
  createSession, deleteSession, flushSessions, initSessionStore, readEvents, renameSession, resetSessionStoreForTests, sessionSearchIndexPath, upsertMessageEvent, writeOverflowText
} from '../src/main/session/store.js';
import { findInSession, foldCase, locateMessage, locateSearchMatch, queryTerms, resetSessionSearchForTests, searchIndexingSettled, searchSessions, snippetFor } from '../src/main/session/search.js';
import { positionOf } from '../src/shared/chronology.js';
import { faultGate, makeTempDir, removeTempDir } from './helpers.js';

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
  vi.useRealTimers();
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

it('searches the beginning, overflow text and recent messages of a chat longer than a million characters', async () => {
  const id = await chat('Long conversation', [['user', 'earlyneedle']]);
  const text = `${'x'.repeat(1_000_010)} overflowneedle`;
  const assetId = await writeOverflowText(id, text);
  expect(assetId).not.toBeNull();
  await upsertMessageEvent(id, { kind: 'assistant_message', source: 'extension', time: Date.now(), messageId: 'long-answer',
    message: { text: text.slice(0, 100), chars: text.length, truncated: true, assetId: assetId! }, state: 'final', final: true });
  await upsertMessageEvent(id, { kind: 'user_message', source: 'app', time: Date.now(), messageId: 'recent-question',
    message: { text: 'recentneedle', chars: 12, truncated: false } });
  await flushSessions();
  const reply = await search('earlyneedle overflowneedle recentneedle');
  expect(reply).toMatchObject({ results: [{ id }], indexed: 1, total: 1 });
  expect(reply.results[0]!.snippet!.text).toBe('earlyneedle');
  expect((await search('recentneedle')).results[0]!.snippet!.text).toBe('recentneedle');
  expect(await locateSearchMatch(id, 'recentneedle')).toMatchObject({ messageId: 'recent-question' });
  // Restart reuses the complete on-disk index, not the journal or a truncated in-memory copy.
  const store = await import('../src/main/session/store.js');
  const read = vi.spyOn(store, 'readEvents');
  resetSessionSearchForTests();
  expect((await search('overflowneedle recentneedle')).results.map(row => row.id)).toEqual([id]);
  expect(read).not.toHaveBeenCalled();
});

it.each(['legacy', 'damaged'])('rebuilds a %s index from the recording', async kind => {
  const id = await chat('Migration', [['user', 'firstneedle'], ['assistant', 'lastneedle']]);
  await search('firstneedle');
  const file = sessionSearchIndexPath(id);
  const stored = await fs.readFile(file, 'utf8');
  const header = stored.slice(0, stored.indexOf('\n')).replace(/^\d+:/, '1:');
  await fs.writeFile(file, kind === 'legacy' ? `${header}\nfirstneedle` : 'damaged stamp\nfirstneedle');
  resetSessionSearchForTests();
  expect((await search('lastneedle')).results.map(row => row.id)).toEqual([id]);
  expect(await fs.readFile(file, 'utf8')).toMatch(/^2:/);
});

it('reuses and truncates a crash-leftover temporary index after restart', async () => {
  const id = await chat('Interrupted build', [['user', 'currentneedle']]);
  const file = sessionSearchIndexPath(id), temporary = `${file}.tmp`;
  await fs.writeFile(temporary, 'leftoverneedle '.repeat(100_000));
  resetSessionSearchForTests();
  expect((await search('currentneedle')).results.map(row => row.id)).toEqual([id]);
  await expect(fs.stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(file, 'utf8')).not.toContain('leftoverneedle');
});

it('removes the reused temporary index when publication fails', async () => {
  const id = await chat('Interrupted publication', [['user', 'currentneedle']]);
  const temporary = `${sessionSearchIndexPath(id)}.tmp`;
  await fs.writeFile(temporary, 'leftoverneedle '.repeat(100_000));
  vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('synthetic busy index'), { code: 'EBUSY' }));
  await searchSessions('currentneedle');
  await searchIndexingSettled();
  await expect(fs.stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['EACCES', 'EIO'])('replaces an unreadable index after %s when its directory remains writable', async code => {
  const id = await chat('Unreadable index', [['user', 'recoverableneedle']]);
  await searchSessions('');
  await searchIndexingSettled();
  const file = sessionSearchIndexPath(id);
  const iterate = ReadStream.prototype[Symbol.asyncIterator];
  let unreadable = true;
  vi.spyOn(ReadStream.prototype, Symbol.asyncIterator).mockImplementation(function (this: ReadStream) {
    if (this.path !== file || !unreadable) return iterate.call(this);
    const stream = this;
    return (async function* () {
      await new Promise<void>(resolve => { stream.once('close', resolve); stream.destroy(); });
      throw Object.assign(new Error('synthetic index read failure'), { code });
    })();
  });
  const rename = fs.rename;
  const publish = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    await rename(from, to);
    if (to === file) unreadable = false;
  });
  const logger = await import('../src/main/logger.js');
  const warn = vi.spyOn(logger, 'logWarn');
  // A restart has no in-memory proof; it must replace the unreadable derived file.
  resetSessionSearchForTests();
  expect((await search('recoverableneedle')).results.map(row => row.id)).toEqual([id]);
  expect(publish).toHaveBeenCalledWith(`${file}.tmp`, file);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('index unreadable; rebuilding'));
});

it.each(['missing', 'stale'])('logs and retries when a current index becomes %s before its text is read', async kind => {
  const id = await chat('Index replacement', [['user', 'recoverableneedle']]);
  await searchSessions('');
  await searchIndexingSettled();
  const file = sessionSearchIndexPath(id);
  if (kind === 'missing') await fs.rm(file);
  else await fs.writeFile(file, 'stale stamp\nobsolete words');
  const logger = await import('../src/main/logger.js');
  const warn = vi.spyOn(logger, 'logWarn');
  expect(await searchSessions('recoverableneedle')).toMatchObject({ results: [], indexed: 0, total: 1 });
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('index missing or stale; skipped, will be rebuilt'));
  expect((await search('recoverableneedle')).results.map(row => row.id)).toEqual([id]);
});

it('logs and discards a streamed result superseded by a newer index stamp', async () => {
  let clock = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => ++clock);
  const id = await chat('Changing chat', [['user', 'streamedneedle']]);
  await searchSessions('');
  await searchIndexingSettled();
  const file = sessionSearchIndexPath(id);
  const gate = faultGate();
  const iterate = ReadStream.prototype[Symbol.asyncIterator];
  let intercept = true;
  vi.spyOn(ReadStream.prototype, Symbol.asyncIterator).mockImplementation(function (this: ReadStream) {
    const iterator = iterate.call(this);
    if (this.path !== file || !intercept) return iterator;
    intercept = false;
    return (async function* () { yield* iterator; await gate.hold(); return undefined; })();
  });
  const logger = await import('../src/main/logger.js');
  const warn = vi.spyOn(logger, 'logWarn');
  const oldSearch = searchSessions('streamedneedle');
  try {
    await gate.entered;
    await upsertMessageEvent(id, { kind: 'user_message', source: 'app', time: Date.now(), messageId: 'newer-question',
      message: { text: 'newer words', chars: 11, truncated: false } });
    await flushSessions();
    await searchSessions('');
    await searchIndexingSettled();
  } finally { gate.release(); }
  expect((await oldSearch).results).toEqual([]);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('changed while it was searched; skipped'));
  expect((await search('streamedneedle')).results.map(row => row.id)).toEqual([id]);
});

it('matches words across UTF-8 read boundaries, retaining correct snippets and all-word matching', async () => {
  const id = await chat('Boundary title', [['user', 'placeholder']]);
  await search('placeholder');
  const file = sessionSearchIndexPath(id);
  const stored = await fs.readFile(file, 'utf8');
  const header = stored.slice(0, stored.indexOf('\n') + 1);
  // Split the two-byte İ itself, not just the word, across the 64 KiB read boundary.
  const prefix = 'x'.repeat(64 * 1024 - Buffer.byteLength(header) - 1);
  const body = `${prefix}İzmir😀 ${'y'.repeat(1_000_000)}\nfinalneedle`;
  await fs.writeFile(file, header + body);
  const read = vi.spyOn(fs, 'readFile');
  resetSessionSearchForTests();
  const reply = await search('title izmir😀 finalneedle');
  expect(reply.results.map(row => row.id)).toEqual([id]);
  const snippet = reply.results[0]!.snippet!;
  expect(snippet.matches.map(([start, end]) => snippet.text.slice(start, end))).toContain('İzmir😀');
  expect((await search('izmir😀 absentneedle')).results).toEqual([]);
  expect(read.mock.calls.filter(([path]) => path === file)).toEqual([]);
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

// Find in chat (Codex's ⌘F): every message holding the phrase, in the order they were said, from the
// whole recording rather than the page the window happens to hold.
it('finds every message of one chat that holds a phrase, in order', async () => {
  const id = await chat('Release planning', [
    ['user', 'Check the Windows installer'],
    ['assistant', 'The windows   INSTALLER builds; the bridge is next.'],
    ['user', 'And the installer for macOS?'],
    ['assistant', 'Both installers are signed.']
  ]);
  const said = await readEvents(id, { kinds: ['user_message', 'assistant_message'] });
  const found = await findInSession(id, 'Windows installer');
  // Case and runs of spaces do not matter; the whole phrase must be there.
  expect(found.map(location => location.seq)).toEqual([said[0]!.seq, said[1]!.seq]);
  expect(found[0]).toEqual({ seq: said[0]!.seq, kind: 'user_message', messageId: (said[0] as { messageId?: string }).messageId ?? null, position: positionOf(said[0]!) });
  expect((await findInSession(id, 'installer')).map(location => location.seq)).toEqual(said.map(event => event.seq));
  expect(await findInSession(id, 'linux')).toEqual([]);
  expect(await findInSession(id, '  ')).toEqual([]);
});

it('finds a phrase as the chat shows it, across bold, code and links', async () => {
  // Answers are recorded as Markdown: "File: /kunden" did not match "**File:** `/kunden…`" (2.1.41 pass).
  const id = await chat('Formatting', [
    ['user', 'Create the file'],
    ['assistant', '- **File:** `/kundenprojekt/goal.txt`\n- See [the setup guide](https://example.com/setup) first.'],
    ['assistant', 'Use **bold** literally: `**`']
  ]);
  const said = await readEvents(id, { kinds: ['user_message', 'assistant_message'] });
  expect((await findInSession(id, 'File: /kundenprojekt')).map(location => location.seq)).toEqual([said[1]!.seq]);
  expect((await findInSession(id, 'see the setup guide first')).map(location => location.seq)).toEqual([said[1]!.seq]);
  // What was written stays findable too.
  expect((await findInSession(id, '**File:**')).map(location => location.seq)).toEqual([said[1]!.seq]);
  expect((await findInSession(id, 'use bold literally')).map(location => location.seq)).toEqual([said[2]!.seq]);
});

it('locates a reply by its native message id, where it first appeared (#482)', async () => {
  // Branch in new chat links back to the exact reply it was branched from.
  const id = await chat('Branch source', [['user', 'try one'], ['assistant', 'Approach A.'], ['user', 'go on'], ['assistant', 'Approach A, step two.']]);
  const { readEvents } = await import('../src/main/session/store.js');
  const replies = (await readEvents(id, { kinds: ['assistant_message'] })) as Array<{ seq: number; time: number; messageId: string; kind: string; origin?: number }>;
  const first = replies[0]!;
  expect(await locateMessage(id, first.messageId)).toEqual({ seq: first.seq, kind: 'assistant_message', messageId: first.messageId, position: positionOf(first) });
  expect(await locateMessage(id, 'not-in-this-chat')).toBeNull();
});

it('locates a bookmarked reply whose recorded id is upper case (bookmarks are kept lower case)', async () => {
  const session = await createSession({ conversationId: `search-chat-${++counter}`, title: 'Upper-case id' });
  const recorded = 'ABCDEF01-2345-4678-9ABC-DEF012345678';
  await upsertMessageEvent(session.id, { kind: 'assistant_message', source: 'extension', time: Date.now(), messageId: recorded,
    message: { text: 'Marked answer.', chars: 14, truncated: false }, state: 'final', final: true });
  await flushSessions();
  const location = await locateMessage(session.id, recorded.toLowerCase());
  expect(location).toMatchObject({ kind: 'assistant_message', messageId: recorded });
});

it('retries a failed index publication without a restart or a change to the chat', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const id = await chat('Notes', [['user', 'recoverable needle']]);
  const store = await import('../src/main/session/store.js');
  const read = vi.spyOn(store, 'readEvents');
  const logger = await import('../src/main/logger.js');
  const warn = vi.spyOn(logger, 'logWarn');
  const rename = vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('temporarily busy'), { code: 'EBUSY' }));
  await searchSessions('needle');
  await searchIndexingSettled();
  const failedAt = Date.now();
  // A failure is not "indexed"; title search still works while the disk is unavailable.
  expect(await searchSessions('Notes')).toMatchObject({ results: [{ id }], indexed: 0, total: 1 });
  await searchIndexingSettled();
  vi.setSystemTime(failedAt + 29_999);
  expect(await search('needle')).toMatchObject({ results: [], indexed: 0, total: 1 });
  await searchIndexingSettled();
  expect(rename).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(1);
  // A persistent failure retries at the boundary without repeating the warning.
  vi.setSystemTime(failedAt + 30_000);
  expect(await search('needle')).toMatchObject({ results: [], indexed: 0, total: 1 });
  await searchIndexingSettled();
  expect(rename).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenCalledTimes(2);
  expect(warn.mock.calls.filter(([message]) => message.includes('not indexed'))).toEqual([
    [expect.stringContaining('will retry after 30 seconds')]
  ]);
  await expect(fs.stat(`${sessionSearchIndexPath(id)}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' });
  rename.mockRestore();
  vi.setSystemTime(failedAt + 60_000);
  // Index via a title query so its text has not yet entered the cache.
  expect(await search('Notes')).toMatchObject({ results: [{ id }], indexed: 1, total: 1 });
  await searchIndexingSettled();
  expect(await fs.readFile(sessionSearchIndexPath(id), 'utf8')).toContain('recoverable needle');
  // Recovery retires the failure: losing this same-stamp index is a new failure episode.
  await fs.rm(sessionSearchIndexPath(id));
  expect(await searchSessions('needle')).toMatchObject({ results: [], indexed: 0, total: 1 });
  await searchIndexingSettled();
  vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('busy again'), { code: 'EBUSY' }));
  await search('needle');
  await searchIndexingSettled();
  expect(warn.mock.calls.filter(([message]) => message.includes('not indexed'))).toHaveLength(2);
});

it('does not restore stale cached words when rebuilding a revised chat fails', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const id = await chat('Revision', [['user', 'obsolete needle']]);
  expect(await search('needle')).toMatchObject({ results: [{ id }], indexed: 1, total: 1 });
  const original = (await readEvents(id, { kinds: ['user_message'] }))[0]!;
  if (original.kind !== 'user_message') throw new Error('Missing question');
  await upsertMessageEvent(id, { ...original, time: original.time + 1, message: { text: 'replacement', chars: 11, truncated: false } });
  await flushSessions();
  const write = vi.spyOn(fs, 'writeFile').mockRejectedValue(Object.assign(new Error('temporarily denied'), { code: 'EACCES' }));
  expect(await search('needle')).toMatchObject({ results: [], indexed: 0, total: 1 });
  await searchIndexingSettled();
  write.mockRestore();
  vi.setSystemTime(Date.now() + 30_000);
  expect((await search('replacement')).results.map(row => row.id)).toEqual([id]);
  expect((await search('needle')).results).toEqual([]);
});

it('tries a changed chat immediately during failure cooldown without blocking other chats', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const id = await chat('Revision', [['user', 'obsolete needle']]);
  const rename = fs.rename;
  const publish = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (to === sessionSearchIndexPath(id)) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    await rename(from, to);
  });
  await search('needle');
  await searchIndexingSettled();
  expect(publish).toHaveBeenCalledTimes(1);
  const other = await chat('Other', [['user', 'independent words']]);
  expect(await search('independent')).toMatchObject({ results: [{ id: other }], indexed: 1, total: 2 });
  const original = (await readEvents(id, { kinds: ['user_message'] }))[0]!;
  if (original.kind !== 'user_message') throw new Error('Missing question');
  await upsertMessageEvent(id, { ...original, time: original.time + 1, message: { text: 'replacement', chars: 11, truncated: false } });
  await flushSessions();
  publish.mockRestore();
  expect(await search('replacement')).toMatchObject({ results: [{ id }], indexed: 2, total: 2 });
  expect((await search('needle')).results).toEqual([]);
});
