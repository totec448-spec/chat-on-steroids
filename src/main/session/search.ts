/**
 * Searching chats by title and by what was said in them (#1107).
 *
 * A chat's recorded journal can be hundreds of megabytes (tool output, images), so a query never
 * reads it. Each chat instead gets a small plain-text index, `search.txt` in its own session
 * folder, holding only the user's and ChatGPT's words. It is built in the background the first
 * time someone searches, rebuilt only when the chat changed since, and deleted with the chat.
 * The index never leaves this computer and nothing here needs a folder permission: it is the
 * app's own recording, the same text the chat view already shows.
 */
import { promises as fs } from 'node:fs';
import { setImmediate as yieldToEvents } from 'node:timers/promises';
import type { SessionSearchLocation, SessionSearchReply, SessionSearchResult, SessionSummary } from '../../shared/session.js';
import { positionOf } from '../../shared/chronology.js';
import { transcriptEntries } from '../../shared/markdown-export.js';
import { indexedSessions, readEvents, readOverflowText, sessionSearchIndexPath } from './store.js';
import { logWarn } from '../logger.js';

/** Plenty for a long chat's words; a runaway transcript is cut, not stored whole. */
const MAX_INDEX_CHARS = 1_000_000;
/** Lowercased indexes kept in memory between queries. */
const CACHE_CHARS = 24_000_000;
const SNIPPET_CHARS = 140;
export const MAX_SEARCH_RESULTS = 50;
const INDEX_VERSION = 1;


/**
 * Lowercase without accents ("Prüfung", "café" and "İstanbul" match "prufung", "cafe" and
 * "istanbul") that keeps every character's length, so match offsets in it are offsets in the
 * original. A character whose folded form would change length keeps a same-length form or itself.
 */
export function foldCase(text: string): string {
  return text.replace(/[A-Z]+|[^\x00-\x7f]/gu, chunk => {
    if (chunk.charCodeAt(0) < 0x80) return chunk.toLowerCase();
    const lower = chunk.toLowerCase();
    const base = lower.length === chunk.length ? lower : chunk;
    const bare = base.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
    return bare.length === chunk.length ? bare : base;
  });
}

/** What makes an index current: the chat's last change and its event count. */
const stampOf = (summary: SessionSummary): string => `${INDEX_VERSION}:${summary.updatedAt}:${summary.events ?? 0}`;

const cache = new Map<string, { stamp: string; text: string; lower: string }>();
let cachedChars = 0;
const current = new Map<string, string>();
let indexing: Promise<void> | null = null;
let indexingWanted = false;

function remember(id: string, stamp: string, text: string): { stamp: string; text: string; lower: string } {
  const previous = cache.get(id);
  if (previous) { cachedChars -= previous.text.length; cache.delete(id); }
  const entry = { stamp, text, lower: foldCase(text) };
  cache.set(id, entry);
  cachedChars += text.length;
  for (const [key, value] of cache) {
    if (cachedChars <= CACHE_CHARS) break;
    cache.delete(key); cachedChars -= value.text.length;
  }
  return entry;
}

function searchable(summary: SessionSummary): boolean {
  return summary.origin?.kind !== 'helper';
}

/** The chat's words, one message per paragraph, from the recording. */
async function transcriptText(id: string): Promise<string> {
  const events = await readEvents(id, { kinds: ['user_message', 'assistant_message'] });
  const parts: string[] = [];
  let size = 0;
  for (const entry of transcriptEntries(events)) {
    const text = entry.stored.truncated && entry.stored.assetId
      ? (await readOverflowText(id, entry.stored.assetId)) ?? entry.stored.text
      : entry.stored.text;
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    parts.push(clean);
    size += clean.length + 1;
    if (size >= MAX_INDEX_CHARS) break;
  }
  return parts.join('\n').slice(0, MAX_INDEX_CHARS);
}

/** Reads a stored index when it is current for this stamp, else null. */
async function storedIndex(id: string, stamp: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(sessionSearchIndexPath(id), 'utf8');
    const newline = raw.indexOf('\n');
    if (newline < 0 || raw.slice(0, newline) !== stamp) return null;
    return raw.slice(newline + 1);
  } catch { return null; }
}

async function indexOne(summary: SessionSummary): Promise<void> {
  const stamp = stampOf(summary);
  if (current.get(summary.id) === stamp) return;
  let text = await storedIndex(summary.id, stamp);
  if (text === null) {
    text = await transcriptText(summary.id);
    const file = sessionSearchIndexPath(summary.id);
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      await fs.writeFile(temporary, `${stamp}\n${text}`, 'utf8');
      await fs.rename(temporary, file);
    } catch (error) {
      // A chat deleted meanwhile has no folder left; nothing to keep.
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return;
    }
  }
  remember(summary.id, stamp, text);
  current.set(summary.id, stamp);
}

/** Brings every chat's index up to date, newest chats first, one at a time between other work. */
function startIndexing(): void {
  indexingWanted = true;
  if (indexing) return;
  indexing = (async () => {
    while (indexingWanted) {
      indexingWanted = false;
      const summaries = (await indexedSessions()).filter(searchable).sort((a, b) => b.updatedAt - a.updatedAt);
      const live = new Set(summaries.map(summary => summary.id));
      for (const id of [...current.keys()]) if (!live.has(id)) { current.delete(id); const old = cache.get(id); if (old) { cachedChars -= old.text.length; cache.delete(id); } }
      for (const summary of summaries) {
        try { await indexOne(summary); }
        catch (error) { logWarn(`search: chat ${summary.id} not indexed: ${(error as Error).message}`); current.set(summary.id, stampOf(summary)); }
        await yieldToEvents();
      }
    }
  })().finally(() => { indexing = null; });
}

/** The words of a query: matched case-insensitively, all of them, in any order. */
export function queryTerms(query: string): string[] {
  return [...new Set(foldCase(query).split(/\s+/).map(term => term.trim()).filter(Boolean))].slice(0, 12);
}

/** Every occurrence of every term in already-folded text, as sorted ranges shifted by `offset`. */
function matchRanges(lower: string, terms: string[], offset = 0): Array<[number, number]> {
  const matches: Array<[number, number]> = [];
  for (const term of terms) {
    for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) {
      matches.push([offset + at, offset + at + term.length]);
    }
  }
  return matches.sort((a, b) => a[0] - b[0]);
}

/** The line around the first term's first occurrence, with every term's matches inside it. */
export function snippetFor(text: string, lower: string, terms: string[]): SessionSearchResult['snippet'] {
  const first = Math.min(...terms.map(term => lower.indexOf(term)).filter(at => at >= 0));
  if (!Number.isFinite(first)) return undefined;
  const lineStart = lower.lastIndexOf('\n', first) + 1;
  const lineEnd = (() => { const end = lower.indexOf('\n', first); return end < 0 ? lower.length : end; })();
  let start = Math.max(lineStart, first - Math.floor(SNIPPET_CHARS / 3));
  const end = Math.min(lineEnd, start + SNIPPET_CHARS);
  if (end - start < SNIPPET_CHARS) start = Math.max(lineStart, end - SNIPPET_CHARS);
  const prefix = start > lineStart ? '…' : '', suffix = end < lineEnd ? '…' : '';
  return { text: prefix + text.slice(start, end) + suffix, matches: matchRanges(lower.slice(start, end), terms, prefix.length) };
}

/**
 * Chats matching every word of the query: by title first, then by what was said, newest first.
 * Starts (or continues) indexing in the background; until it is done, text matches cover only the
 * chats indexed so far, and the reply says how far that is.
 */
export async function searchSessions(query: string, limit = MAX_SEARCH_RESULTS): Promise<SessionSearchReply> {
  const terms = queryTerms(query);
  const summaries = (await indexedSessions()).filter(searchable).sort((a, b) => b.updatedAt - a.updatedAt);
  startIndexing();
  const indexed = summaries.filter(summary => current.get(summary.id) === stampOf(summary)).length;
  if (!terms.length) return { results: [], indexed, total: summaries.length };
  const results: SessionSearchResult[] = [];
  const textCandidates: Array<{ summary: SessionSummary; title: string }> = [];
  const resultFor = (summary: SessionSummary, title: string): SessionSearchResult => {
    const titleMatches = matchRanges(title, terms);
    return { id: summary.id, title: summary.title, projectId: summary.projectId ?? null, ...(titleMatches.length ? { titleMatches } : {}) };
  };
  // Rank the entire title catalog before touching text. An early text cutoff previously
  // hid older title matches, while common title queries allocated every matching result.
  for (const summary of summaries) {
    const title = foldCase(summary.title);
    if (terms.every(term => title.includes(term))) {
      results.push(resultFor(summary, title));
      if (results.length > limit) return { results: results.slice(0, limit), indexed, total: summaries.length, limited: true };
    } else textCandidates.push({ summary, title });
  }
  for (const { summary, title } of textCandidates) {
    const stamp = stampOf(summary);
    // An old cache entry is not evidence of what a revised chat currently says. Until
    // its new index commits, it belongs only to the indexing progress, not the results.
    if (current.get(summary.id) !== stamp) continue;
    let entry = cache.get(summary.id);
    if (!entry || entry.stamp !== stamp) {
      // Indexed earlier but pushed out of memory: read the stored index again.
      const text = await storedIndex(summary.id, stamp);
      if (current.get(summary.id) !== stamp) continue;
      entry = text !== null ? remember(summary.id, stamp, text) : undefined;
    }
    if (!entry) continue;
    // A word may be in the title and the rest in the text.
    if (terms.every(term => title.includes(term) || entry!.lower.includes(term))) {
      const inText = terms.filter(term => entry!.lower.includes(term));
      results.push({ ...resultFor(summary, title), snippet: snippetFor(entry.text, entry.lower, inText) });
    }
    if (results.length > limit) break;
  }
  return { results: results.slice(0, limit), indexed, total: summaries.length, ...(results.length > limit ? { limited: true } : {}) };
}

/** Waits for background indexing to finish; for tests. */
export async function searchIndexingSettled(): Promise<void> {
  while (indexing) await indexing;
}

export function resetSessionSearchForTests(): void {
  cache.clear(); cachedChars = 0; current.clear(); indexingWanted = false;
}

/**
 * The first message of a chat holding any of the query's words: where its snippet came from, so the
 * chat can open there instead of at its end. Read only when a result is opened, from the recording.
 */
export async function locateSearchMatch(id: string, query: string): Promise<SessionSearchLocation | null> {
  const terms = queryTerms(query);
  if (!terms.length) return null;
  const events = await readEvents(id, { kinds: ['user_message', 'assistant_message'] });
  for (const entry of transcriptEntries(events)) {
    const text = entry.stored.truncated && entry.stored.assetId
      ? (await readOverflowText(id, entry.stored.assetId)) ?? entry.stored.text
      : entry.stored.text;
    const lower = foldCase(text.replace(/\s+/g, ' '));
    if (!terms.some(term => lower.includes(term))) continue;
    const event = events.find(candidate => candidate.seq === entry.seq);
    if (!event || (event.kind !== 'user_message' && event.kind !== 'assistant_message')) return null;
    const messageId = event.messageId ?? null;
    // A revised message keeps the place where it first appeared.
    const position = Math.min(...events
      .filter(other => other === event || (messageId !== null && other.kind === event.kind && other.messageId === messageId))
      .map(other => positionOf(other)));
    return { seq: event.seq, kind: event.kind, messageId, position };
  }
  return null;
}
