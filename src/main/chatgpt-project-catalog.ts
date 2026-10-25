/**
 * The ChatGPT Projects this account already has, as ChatGPT's own sidebar lists them (#1756).
 *
 * A page reports the Project links it shows (id and name); nothing is fetched for it. The sidebar
 * can show only part of the list, so a later, shorter report never removes a Project: entries
 * leave only after a month unseen. Names are labels for the person; linking always uses the id.
 *
 * ChatGPT opens a Project only in the workspace it belongs to (a Team or a personal one), so each
 * entry keeps the workspace it was listed in and only those of the workspace in use are offered.
 * The workspace is kept as a short hash of ChatGPT's account id, never the id itself.
 */
import { createHash } from 'node:crypto';
import { readDurable, writeDurableNow } from './durable.js';
import { logWarn } from './logger.js';
import { listProjects } from './projects.js';
import { CHATGPT_PROJECT_ID, type ChatgptProjectChoice } from '../shared/projects.js';

export const CHATGPT_PROJECT_CATALOG = 'chatgpt-projects';
const MAX_PROJECTS = 200;
const MAX_NAME = 120;
const KEEP_MS = 30 * 24 * 3_600_000;
/** An unchanged list is written again at most daily, only to keep its entries from expiring. */
const REFRESH_MS = 24 * 3_600_000;

/** `space`: the workspace's hash, or '' for none (a personal account sets no workspace). */
interface Entry { id: string; name: string; seenAt: number; space: string }
interface Catalog { current: string; entries: Entry[] }

let writes: Promise<unknown> = Promise.resolve();

/** The workspace a page reported, as stored: a hash of a plausible account id, else none. */
function spaceOf(workspace: unknown): string {
  return typeof workspace === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(workspace)
    ? createHash('sha256').update(workspace).digest('hex').slice(0, 16) : '';
}

/**
 * The saved catalog. For a write it must really have been read: a file that can't be read right
 * now fails the write, so a shorter report never replaces what is there. A damaged one starts over.
 */
async function readCatalog(forWrite = false): Promise<Catalog> {
  const raw = forWrite
    ? await readDurable<{ projects?: unknown; current?: unknown }>(CHATGPT_PROJECT_CATALOG, { strict: true }).catch((error: { damaged?: boolean }) => {
      if (!error?.damaged) throw error;
      logWarn('chatgpt projects: the saved list was damaged; it starts again from this report');
      return null;
    })
    : await readDurable<{ projects?: unknown; current?: unknown }>(CHATGPT_PROJECT_CATALOG).catch(() => null);
  const rows = Array.isArray(raw?.projects) ? raw.projects : [];
  const current = typeof raw?.current === 'string' && /^[0-9a-f]{16}$/.test(raw.current) ? raw.current : '';
  const entries: Entry[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const entry = row as Partial<Entry>;
    if (typeof entry.id !== 'string' || !CHATGPT_PROJECT_ID.test(entry.id) || entries.some(other => other.id === entry.id)) continue;
    const name = cleanName(entry.name);
    if (!name || typeof entry.seenAt !== 'number' || !Number.isFinite(entry.seenAt)) continue;
    entries.push({ id: entry.id, name, seenAt: entry.seenAt, space: typeof entry.space === 'string' && /^[0-9a-f]{16}$/.test(entry.space) ? entry.space : '' });
  }
  return { current, entries: entries.slice(0, MAX_PROJECTS) };
}

function cleanName(value: unknown): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();
}

/**
 * Records the Projects a page shows, in its order, and the workspace it shows them in, which is
 * then the one in use; true when the list, a name or the workspace changed.
 */
export function noteChatgptProjects(reported: ReadonlyArray<{ id: unknown; name: unknown }>, now = Date.now(), workspace: unknown = null): Promise<boolean> {
  const operation = writes.then(async () => {
    const space = spaceOf(workspace);
    const seen: Entry[] = [];
    for (const row of reported.slice(0, MAX_PROJECTS * 2)) {
      const name = cleanName(row?.name);
      if (typeof row?.id !== 'string' || !CHATGPT_PROJECT_ID.test(row.id) || !name || seen.some(entry => entry.id === row.id)) continue;
      seen.push({ id: row.id, name, seenAt: now, space });
    }
    // Rows that were all invalid say nothing; an empty sidebar still says which workspace is in use,
    // so a workspace without Projects offers none of the previous one's.
    if (!seen.length && reported.length) return false;
    const previous = await readCatalog(true);
    if (!seen.length) {
      if (previous.current === space) return false;
      await writeDurableNow(CHATGPT_PROJECT_CATALOG, { version: 1, current: space, projects: previous.entries });
      return true;
    }
    const next = [...seen, ...previous.entries.filter(entry => !seen.some(other => other.id === entry.id))].slice(0, MAX_PROJECTS);
    const shape = (catalog: Catalog) => JSON.stringify([catalog.current, catalog.entries.map(entry => [entry.id, entry.name, entry.space])]);
    const changed = shape({ current: space, entries: next }) !== shape(previous);
    const stale = seen.some(entry => (previous.entries.find(other => other.id === entry.id)?.seenAt ?? 0) < now - REFRESH_MS);
    if (!changed && !stale) return false;
    await writeDurableNow(CHATGPT_PROJECT_CATALOG, { version: 1, current: space, projects: next });
    return changed;
  });
  writes = operation.catch(() => undefined);
  return operation;
}

/** The entries ChatGPT listed recently in the workspace in use. */
async function offered(now: number): Promise<Entry[]> {
  const { current, entries } = await readCatalog();
  return entries.filter(entry => entry.space === current && entry.seenAt >= now - KEEP_MS);
}

/** Projects the person can pick, newest report first, each with the CoS project already linked to it. */
export async function chatgptProjectChoices(now = Date.now()): Promise<ChatgptProjectChoice[]> {
  const entries = await offered(now);
  if (!entries.length) return [];
  const projects = (await listProjects()).filter(project => !project.ungrouped);
  return entries.map(entry => {
    const owner = projects.find(project => project.chatgpt?.state === 'linked' && project.chatgpt.id === entry.id);
    return { id: entry.id, name: entry.name, linkedTo: owner ? { id: owner.id, name: owner.name } : null };
  });
}

/** True when ChatGPT has listed this Project in the workspace in use recently enough to offer it. */
export async function isListedChatgptProject(id: string, now = Date.now()): Promise<boolean> {
  return (await offered(now)).some(entry => entry.id === id);
}
