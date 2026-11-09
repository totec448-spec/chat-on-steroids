/**
 * Searching chats by title and by what was said in them (#1107).
 *
 * A chat's recorded journal can be hundreds of megabytes (tool output, images), so a query never
 * reads it. Each chat instead gets a plain-text index, `search.txt` in its own session
 * folder, holding only the user's and ChatGPT's words. It is built in the background the first
 * time someone searches, rebuilt only when the chat changed since, and deleted with the chat.
 * The index never leaves this computer and nothing here needs a folder permission: it is the
 * app's own recording, the same text the chat view already shows.
 */
import { createReadStream, promises as fs } from 'node:fs';
import { setImmediate as yieldToEvents } from 'node:timers/promises';
import type { SessionSearchLocation, SessionSearchReply, SessionSearchResult, SessionSummary } from '../../shared/session.js';
import { positionOf } from '../../shared/chronology.js';
import { transcriptEntries } from '../../shared/markdown-export.js';
import { indexedSessions, readEvents, readOverflowText, sessionSearchIndexPath } from './store.js';
import { providerEntitiesAsMarkdown } from '../../shared/content-reference.js';
import { markdownVisibleText } from '../../shared/markdown-text.js';
import { foldCase } from '../../shared/fold-case.js';

export { foldCase };
import { logWarn } from '../logger.js';

/** Large indexes stay on disk and are searched in bounded windows, never cut. */
const INDEX_READ_BYTES = 64 * 1024;
const MAX_CACHED_INDEX_CHARS = 1_000_000;
/** Lowercased indexes kept in memory between queries. */
const CACHE_CHARS = 24_000_000;
const SNIPPET_CHARS = 140;
export const MAX_SEARCH_RESULTS = 50;
// Version 1 indexes may have silently omitted everything after the first million characters.
const INDEX_VERSION = 2;
const INDEX_RETRY_MS = 30_000;


/** What makes an index current: the chat's last change and its event count. */
const stampOf = (summary: SessionSummary): string => `${INDEX_VERSION}:${summary.updatedAt}:${summary.events ?? 0}`;

const cache = new Map<string, { stamp: string; text: string; lower: string }>();
let cachedChars = 0;
const current = new Map<string, string>();
/** One cooldown and warning per failed chat revision; success or deletion retires it. */
const failures = new Map<string, { stamp: string; retryAt: number }>();
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
async function* transcriptText(id: string): AsyncGenerator<string> {
  const events = await readEvents(id, { kinds: ['user_message', 'assistant_message'] });
  for (const entry of transcriptEntries(events)) {
    const text = providerEntitiesAsMarkdown(entry.stored.truncated && entry.stored.assetId
      ? (await readOverflowText(id, entry.stored.assetId)) ?? entry.stored.text
      : entry.stored.text);
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    yield clean;
  }
}

/** Checks the stamp, then streams text when requested. No visitor means a header-only check. */
async function storedIndex(id: string, stamp: string, visit?: (text: string) => void): Promise<boolean> {
  const header = `${stamp}\n`;
  let prefix = '', checked = false;
  try {
    for await (const chunk of createReadStream(sessionSearchIndexPath(id), { encoding: 'utf8', highWaterMark: INDEX_READ_BYTES })) {
      let text = chunk as string;
      if (!checked) {
        prefix += text;
        if (prefix.length < header.length) continue;
        if (!prefix.startsWith(header)) return false;
        if (!visit) return true;
        checked = true;
        text = prefix.slice(header.length);
        prefix = '';
      }
      visit!(text);
    }
    return checked;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function indexOne(summary: SessionSummary): Promise<void> {
  const stamp = stampOf(summary);
  if (current.get(summary.id) === stamp) return;
  const valid = await storedIndex(summary.id, stamp).catch(error => {
    if (failures.get(summary.id)?.stamp !== stamp) logWarn(`search: chat ${summary.id} index unreadable; rebuilding: ${(error as Error).message}`);
    return false;
  });
  if (!valid) {
    const file = sessionSearchIndexPath(summary.id);
    // One indexer owns this file; a restart truncates its unfinished predecessor instead of
    // leaving another full-transcript temporary behind under a different process id.
    const temporary = `${file}.tmp`;
    try {
      await fs.writeFile(temporary, `${stamp}\n`, 'utf8');
      const handle = await fs.open(temporary, 'a');
      try {
        for await (const text of transcriptText(summary.id)) {
          await handle.writeFile(text, 'utf8');
          await handle.writeFile('\n', 'utf8');
        }
      } finally { await handle.close(); }
      await fs.rename(temporary, file);
    } catch (error) {
      // A chat deleted meanwhile has no folder left; nothing to keep.
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return;
    }
  }
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
      for (const id of failures.keys()) if (!live.has(id)) failures.delete(id);
      for (const summary of summaries) {
        const stamp = stampOf(summary), failure = failures.get(summary.id);
        if (failure?.stamp === stamp && Date.now() < failure.retryAt) continue;
        try {
          await indexOne(summary);
          failures.delete(summary.id);
        } catch (error) {
          failures.set(summary.id, { stamp, retryAt: Date.now() + INDEX_RETRY_MS });
          if (failure?.stamp !== stamp) logWarn(`search: chat ${summary.id} not indexed; searches will retry after 30 seconds (changed chats retry immediately): ${(error as Error).message}`);
        }
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

/** Search windows overlap so neither a word nor the context around its first match is split. */
function indexMatcher(title: string, terms: string[]) {
  const matched = new Set(terms.filter(term => title.includes(term)));
  const overlap = Math.max(...terms.map(term => term.length)) + SNIPPET_CHARS * 2;
  let tail = '', snippet: SessionSearchResult['snippet'];
  const visit = (chunk: string, final = false): void => {
    const text = tail + chunk, lower = foldCase(text);
    for (const term of terms) if (lower.includes(term)) matched.add(term);
    if (!snippet) {
      const first = Math.min(...terms.map(term => lower.indexOf(term)).filter(at => at >= 0));
      // Keep a match near the window's end until its following context has arrived.
      if (Number.isFinite(first) && (final || first + SNIPPET_CHARS <= text.length || text.indexOf('\n', first) >= 0)) {
        snippet = snippetFor(text, lower, terms);
      }
    }
    tail = text.slice(-overlap);
  };
  return {
    visit,
    finish: () => {
      visit('', true);
      return matched.size === terms.length ? { snippet } : null;
    }
  };
}

/** Reuse small indexes; stream large ones without putting the whole conversation in memory. */
async function matchIndex(id: string, stamp: string, title: string, terms: string[]): Promise<{ snippet: SessionSearchResult['snippet'] } | null> {
  const cached = cache.get(id);
  if (cached?.stamp === stamp) {
    if (!terms.every(term => title.includes(term) || cached.lower.includes(term))) return null;
    return { snippet: snippetFor(cached.text, cached.lower, terms.filter(term => cached.lower.includes(term))) };
  }
  const matcher = indexMatcher(title, terms);
  let chars = 0, parts: string[] = [];
  try {
    const valid = await storedIndex(id, stamp, text => {
      matcher.visit(text);
      chars += text.length;
      if (chars <= MAX_CACHED_INDEX_CHARS) parts.push(text);
      else parts = [];
    });
    if (!valid) {
      logWarn(`search: chat ${id} index missing or stale; skipped, will be rebuilt`);
      if (current.get(id) === stamp) current.delete(id);
      return null;
    }
  } catch (error) {
    if (current.get(id) === stamp) current.delete(id);
    logWarn(`search: chat ${id} index could not be read; will retry on the next search: ${(error as Error).message}`);
    return null;
  }
  if (current.get(id) !== stamp) {
    logWarn(`search: chat ${id} changed while it was searched; skipped`);
    return null;
  }
  if (chars <= MAX_CACHED_INDEX_CHARS) remember(id, stamp, parts.join(''));
  return matcher.finish();
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
    const match = await matchIndex(summary.id, stamp, title, terms);
    if (match) results.push({ ...resultFor(summary, title), snippet: match.snippet });
    if (results.length > limit) break;
  }
  return { results: results.slice(0, limit), indexed: summaries.filter(summary => current.get(summary.id) === stampOf(summary)).length,
    total: summaries.length, ...(results.length > limit ? { limited: true } : {}) };
}

/** Waits for background indexing to finish; for tests. */
export async function searchIndexingSettled(): Promise<void> {
  while (indexing) await indexing;
}

export function resetSessionSearchForTests(): void {
  cache.clear(); cachedChars = 0; current.clear(); failures.clear(); indexingWanted = false;
}

/** Most matches one find returns; a chat with more is searched with a longer phrase. */
const MAX_FIND_RESULTS = 500;

/**
 * Find in chat (Codex's ⌘F): every message of one chat holding the phrase, in the order they were
 * said. Case and runs of white space do not matter. Read from the whole recording, so a match far
 * above the page the window holds is found too. A message matches as written or as drawn: answers
 * are recorded as Markdown, and "File: /src" is what the person reads in "**File:** `/src`".
 */
export async function findInSession(id: string, query: string): Promise<SessionSearchLocation[]> {
  const phrase = foldCase(query.replace(/\s+/g, ' ').trim());
  if (!phrase) return [];
  const events = await readEvents(id, { kinds: ['user_message', 'assistant_message'] });
  const found: SessionSearchLocation[] = [];
  for (const entry of transcriptEntries(events)) {
    const text = entry.stored.truncated && entry.stored.assetId
      ? (await readOverflowText(id, entry.stored.assetId)) ?? entry.stored.text
      : entry.stored.text;
    const matches = (written: string): boolean => foldCase(written.replace(/\s+/g, ' ')).includes(phrase);
    // Only text with Markdown syntax in it can read differently once drawn.
    if (!matches(text) && !(/[*_`[\]<&|\\~#]/.test(text) && matches(markdownVisibleText(providerEntitiesAsMarkdown(text))))) continue;
    const event = events.find(candidate => candidate.seq === entry.seq);
    if (!event || (event.kind !== 'user_message' && event.kind !== 'assistant_message')) continue;
    const messageId = event.messageId ?? null;
    const position = Math.min(...events
      .filter(other => other === event || (messageId !== null && other.kind === event.kind && other.messageId === messageId))
      .map(other => positionOf(other)));
    found.push({ seq: event.seq, kind: event.kind, messageId, position });
    if (found.length >= MAX_FIND_RESULTS) break;
  }
  return found;
}

/**
 * The first message of a chat holding any of the query's words: where its snippet came from, so the
 * chat can open there instead of at its end. Read only when a result is opened, from the recording.
 */
/** Where one recorded reply is, by its native message id (#482: a branch links back to it). */
export async function locateMessage(id: string, messageId: string): Promise<SessionSearchLocation | null> {
  const events = await readEvents(id, { kinds: ['assistant_message'] });
  // Bookmarks keep ids in lower case; the recorded id is compared the same way.
  const wanted = messageId.toLowerCase();
  const revisions = events.filter(event => event.kind === 'assistant_message' && typeof event.messageId === 'string' && event.messageId.toLowerCase() === wanted);
  const latest = revisions.at(-1);
  if (!latest || latest.kind !== 'assistant_message') return null;
  // A revised message keeps the place where it first appeared.
  return { seq: latest.seq, kind: 'assistant_message', messageId: latest.messageId ?? messageId, position: Math.min(...revisions.map(event => positionOf(event))) };
}

export async function locateSearchMatch(id: string, query: string): Promise<SessionSearchLocation | null> {
  const terms = queryTerms(query);
  if (!terms.length) return null;
  const events = await readEvents(id, { kinds: ['user_message', 'assistant_message'] });
  for (const entry of transcriptEntries(events)) {
    const text = providerEntitiesAsMarkdown(entry.stored.truncated && entry.stored.assetId
      ? (await readOverflowText(id, entry.stored.assetId)) ?? entry.stored.text
      : entry.stored.text);
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
