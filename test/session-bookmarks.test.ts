import { afterEach, beforeEach, expect, it } from 'vitest';
import { initConfigPath, defaultConfig, saveConfig } from '../src/main/config.js';
import { initDurableStore, flushDurable, resetDurableForTests } from '../src/main/durable.js';
import { createSession, deleteSession, initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { listBookmarks, MAX_BOOKMARKS, setBookmark } from '../src/main/session/bookmarks.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;
beforeEach(async () => {
  directory = await makeTempDir('cos-bookmarks-');
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
  await saveConfig(defaultConfig());
});
afterEach(async () => {
  await flushDurable(); resetSessionStoreForTests(); resetDurableForTests(); await removeTempDir(directory);
});

const A = 'aaaaaaaa-1111-4222-8333-444444444444';
const B = 'bbbbbbbb-1111-4222-8333-444444444444';
const C = 'cccccccc-1111-4222-8333-444444444444';

it('keeps a chat\'s bookmarks in the order its answers appeared, across a restart', async () => {
  const { id } = await createSession({ conversationId: 'bookmarks-1', title: 'Bookmarks' });
  expect(await listBookmarks(id)).toEqual([]);
  await setBookmark(id, { messageId: B, excerpt: 'Second answer', messageTime: 200 }, true);
  await setBookmark(id, { messageId: A, excerpt: 'First answer', messageTime: 100 }, true);
  resetSessionStoreForTests();
  initSessionStore(directory);
  expect((await listBookmarks(id)).map(mark => mark.messageId)).toEqual([A, B]);
  expect((await listBookmarks(id))[0]).toMatchObject({ messageId: A, excerpt: 'First answer', messageTime: 100 });
});

it('removes a bookmark, and treats a repeated toggle as one', async () => {
  const { id } = await createSession({ conversationId: 'bookmarks-2', title: 'Bookmarks' });
  await setBookmark(id, { messageId: A, excerpt: 'One', messageTime: 1 }, true);
  await setBookmark(id, { messageId: A.toUpperCase(), excerpt: 'One again', messageTime: 1 }, true);
  expect(await listBookmarks(id)).toHaveLength(1);
  await setBookmark(id, { messageId: A, excerpt: '', messageTime: 1 }, false);
  await setBookmark(id, { messageId: A, excerpt: '', messageTime: 1 }, false);
  expect(await listBookmarks(id)).toEqual([]);
});

it('shortens a long excerpt to one line', async () => {
  const { id } = await createSession({ conversationId: 'bookmarks-3', title: 'Bookmarks' });
  await setBookmark(id, { messageId: A, excerpt: `  Line one\n\nline two ${'x'.repeat(400)}`, messageTime: 1 }, true);
  const [mark] = await listBookmarks(id);
  expect(mark!.excerpt.startsWith('Line one line two')).toBe(true);
  expect(mark!.excerpt.length).toBeLessThanOrEqual(160);
  expect(mark!.excerpt.endsWith('…')).toBe(true);
});

it('refuses a bookmark past the limit and a message id that is not ChatGPT\'s', async () => {
  const { id } = await createSession({ conversationId: 'bookmarks-4', title: 'Bookmarks' });
  await expect(setBookmark(id, { messageId: 'message-1', excerpt: 'x', messageTime: 1 }, true)).rejects.toThrow();
  for (let n = 0; n < MAX_BOOKMARKS; n += 1) {
    const messageId = `${n.toString(16).padStart(8, '0')}-1111-4222-8333-444444444444`;
    await setBookmark(id, { messageId, excerpt: `mark ${n}`, messageTime: n }, true);
  }
  // A literal message, so the window finds its translation; it must name the real limit.
  await expect(setBookmark(id, { messageId: C, excerpt: 'one too many', messageTime: 9_999 }, true)).rejects.toThrow(`A chat keeps at most ${MAX_BOOKMARKS} bookmarks`);
  expect(await listBookmarks(id)).toHaveLength(MAX_BOOKMARKS);
});

it('goes with its chat, and never brings a deleted chat back', async () => {
  const { id } = await createSession({ conversationId: 'bookmarks-5', title: 'Bookmarks' });
  await setBookmark(id, { messageId: A, excerpt: 'Kept', messageTime: 1 }, true);
  await deleteSession(id);
  expect(await listBookmarks(id)).toEqual([]);
  await expect(setBookmark(id, { messageId: B, excerpt: 'Late', messageTime: 2 }, true)).rejects.toThrow();
  expect(await listBookmarks(id)).toEqual([]);
});

it('applies toggles in the order they were made', async () => {
  const { id } = await createSession({ conversationId: 'bookmarks-6', title: 'Bookmarks' });
  await Promise.all([
    setBookmark(id, { messageId: A, excerpt: 'a', messageTime: 1 }, true),
    setBookmark(id, { messageId: B, excerpt: 'b', messageTime: 2 }, true),
    setBookmark(id, { messageId: A, excerpt: '', messageTime: 1 }, false)
  ]);
  expect((await listBookmarks(id)).map(mark => mark.messageId)).toEqual([B]);
});

// CodeRabbit on #1719: a file with more than the limit (written by hand, or by another version) was
// returned whole. Reading keeps the limit too: the ones bookmarked first, as adding would have.
it('keeps at most the limit when a saved file holds more, the ones bookmarked first', async () => {
  const { id } = await createSession({ conversationId: 'bookmarks-many', title: 'Many' });
  const { sessionBookmarksPath } = await import('../src/main/session/store.js');
  const { writeFile } = await import('node:fs/promises');
  const idOf = (n: number) => `${n.toString(16).padStart(8, '0')}-1111-4222-8333-444444444444`;
  const marks = Array.from({ length: MAX_BOOKMARKS + 5 }, (_, n) => ({ messageId: idOf(n), excerpt: `Answer ${n}`, messageTime: 1000 - n, at: n }));
  await writeFile(sessionBookmarksPath(id), JSON.stringify({ version: 1, bookmarks: marks }), 'utf8');
  const listed = await listBookmarks(id);
  expect(listed).toHaveLength(MAX_BOOKMARKS);
  // The five bookmarked last (highest `at`) are the ones left out; the list is still in chat order.
  expect(listed.some(mark => mark.messageId === idOf(MAX_BOOKMARKS))).toBe(false);
  expect(listed.map(mark => mark.messageTime)).toEqual([...listed.map(mark => mark.messageTime)].sort((a, b) => a - b));
});
