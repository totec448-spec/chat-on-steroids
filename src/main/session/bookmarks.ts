/**
 * Bookmarked answers, per chat: you mark an answer under it, and the chat's header lists the marks
 * to jump back to them. Kept in the chat's own folder, so they go when the chat is deleted, and
 * never written into a chat that is gone.
 */
import { promises as fs } from 'node:fs';
import { BOOKMARK_EXCERPT_MAX, type SessionBookmark } from '../../shared/session.js';
import { logInfo } from '../logger.js';
import { sessionBookmarksPath } from './store.js';

export const MAX_BOOKMARKS = 200;
const NATIVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One write after another per chat: two quick toggles must not undo each other. */
const chains = new Map<string, Promise<unknown>>();

function serial<T>(id: string, work: () => Promise<T>): Promise<T> {
  const next = (chains.get(id) ?? Promise.resolve()).then(work, work);
  const settled = next.then(() => undefined, () => undefined);
  chains.set(id, settled);
  void settled.then(() => { if (chains.get(id) === settled) chains.delete(id); });
  return next;
}

function oneLine(text: string): string {
  const plain = text.replace(/\s+/g, ' ').trim();
  return plain.length <= BOOKMARK_EXCERPT_MAX ? plain : `${plain.slice(0, BOOKMARK_EXCERPT_MAX - 1).trimEnd()}…`;
}

async function read(id: string): Promise<SessionBookmark[]> {
  let raw: string;
  try { raw = await fs.readFile(sessionBookmarksPath(id), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  let parsed: unknown;
  // A damaged file loses its marks, never the chat.
  try { parsed = JSON.parse(raw); } catch { return []; }
  const list = Array.isArray((parsed as { bookmarks?: unknown })?.bookmarks) ? (parsed as { bookmarks: unknown[] }).bookmarks : [];
  const marks: SessionBookmark[] = [];
  for (const value of list) {
    const mark = value as Partial<SessionBookmark>;
    const messageId = typeof mark.messageId === 'string' ? mark.messageId.toLowerCase() : '';
    if (!NATIVE_ID.test(messageId) || marks.some(other => other.messageId === messageId)) continue;
    const number = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
    marks.push({ messageId, excerpt: oneLine(typeof mark.excerpt === 'string' ? mark.excerpt : ''), messageTime: number(mark.messageTime), at: number(mark.at) });
  }
  // A file with more than the limit (written by hand, or by another version) keeps the ones
  // bookmarked first, as adding would have: past the limit a new bookmark is refused.
  const kept = marks.length > MAX_BOOKMARKS ? [...marks].sort((a, b) => a.at - b.at).slice(0, MAX_BOOKMARKS) : marks;
  return kept.sort((a, b) => a.messageTime - b.messageTime || a.at - b.at);
}

export function listBookmarks(id: string): Promise<SessionBookmark[]> {
  return serial(id, () => read(id));
}

/** Marks or unmarks one answer; returns the chat's bookmarks after the change. */
export function setBookmark(id: string, mark: { messageId: string; excerpt: string; messageTime: number }, on: boolean): Promise<SessionBookmark[]> {
  return serial(id, async () => {
    const messageId = mark.messageId.toLowerCase();
    if (!NATIVE_ID.test(messageId)) throw new Error('Only a ChatGPT answer can be bookmarked');
    const marks = await read(id);
    const kept = marks.filter(other => other.messageId !== messageId);
    if (on) {
      if (kept.length === marks.length && marks.length >= MAX_BOOKMARKS) {
        logInfo(`bookmarks: chat ${id} already keeps ${MAX_BOOKMARKS} bookmarks, so a new one was refused`);
        // Literal, so the window finds its translation (the limit test keeps it equal to MAX_BOOKMARKS).
        throw new Error('A chat keeps at most 200 bookmarks');
      }
      const previous = marks.find(other => other.messageId === messageId);
      kept.push(previous ?? { messageId, excerpt: oneLine(mark.excerpt), messageTime: Number.isFinite(mark.messageTime) ? mark.messageTime : 0, at: Date.now() });
    } else if (kept.length === marks.length) return marks;
    kept.sort((a, b) => a.messageTime - b.messageTime || a.at - b.at);
    const file = sessionBookmarksPath(id);
    const temporary = `${file}.tmp`;
    // No mkdir: a chat deleted meanwhile has no folder, and the write fails instead of bringing it back.
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, bookmarks: kept }), 'utf8');
      await fs.rename(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Session not found');
      throw error;
    }
    return kept;
  });
}
