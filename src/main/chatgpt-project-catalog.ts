/**
 * The ChatGPT Projects this account already has, as ChatGPT's own sidebar lists them (#1756).
 *
 * A page reports the Project links it shows (id and name); nothing is fetched for it. The sidebar
 * can show only part of the list, so a later, shorter report never removes a Project: entries
 * leave only after a month unseen. Names are labels for the person; linking always uses the id.
 */
import { readDurable, writeDurableNow } from './durable.js';
import { listProjects } from './projects.js';
import { CHATGPT_PROJECT_ID, type ChatgptProjectChoice } from '../shared/projects.js';

export const CHATGPT_PROJECT_CATALOG = 'chatgpt-projects';
const MAX_PROJECTS = 200;
const MAX_NAME = 120;
const KEEP_MS = 30 * 24 * 3_600_000;
/** An unchanged list is written again at most daily, only to keep its entries from expiring. */
const REFRESH_MS = 24 * 3_600_000;

interface Entry { id: string; name: string; seenAt: number }

let writes: Promise<unknown> = Promise.resolve();

async function readCatalog(): Promise<Entry[]> {
  const raw = await readDurable<{ projects?: unknown }>(CHATGPT_PROJECT_CATALOG).catch(() => null);
  const rows = Array.isArray(raw?.projects) ? raw.projects : [];
  const entries: Entry[] = [];
  for (const row of rows) {
    const entry = row as Partial<Entry>;
    if (typeof entry.id !== 'string' || !CHATGPT_PROJECT_ID.test(entry.id) || entries.some(other => other.id === entry.id)) continue;
    const name = cleanName(entry.name);
    if (!name || typeof entry.seenAt !== 'number' || !Number.isFinite(entry.seenAt)) continue;
    entries.push({ id: entry.id, name, seenAt: entry.seenAt });
  }
  return entries.slice(0, MAX_PROJECTS);
}

function cleanName(value: unknown): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();
}

/** Records the Projects a page shows, in its order; true when the list or a name changed. */
export function noteChatgptProjects(reported: ReadonlyArray<{ id: unknown; name: unknown }>, now = Date.now()): Promise<boolean> {
  const operation = writes.then(async () => {
    const seen: Entry[] = [];
    for (const row of reported.slice(0, MAX_PROJECTS * 2)) {
      const name = cleanName(row?.name);
      if (typeof row?.id !== 'string' || !CHATGPT_PROJECT_ID.test(row.id) || !name || seen.some(entry => entry.id === row.id)) continue;
      seen.push({ id: row.id, name, seenAt: now });
    }
    if (!seen.length) return false;
    const previous = await readCatalog();
    const next = [...seen, ...previous.filter(entry => !seen.some(other => other.id === entry.id))].slice(0, MAX_PROJECTS);
    const shape = (entries: Entry[]) => JSON.stringify(entries.map(entry => [entry.id, entry.name]));
    const changed = shape(next) !== shape(previous);
    const stale = seen.some(entry => (previous.find(other => other.id === entry.id)?.seenAt ?? 0) < now - REFRESH_MS);
    if (!changed && !stale) return false;
    await writeDurableNow(CHATGPT_PROJECT_CATALOG, { version: 1, projects: next });
    return changed;
  });
  writes = operation.catch(() => undefined);
  return operation;
}

/** Projects the person can pick, newest report first, each with the CoS project already linked to it. */
export async function chatgptProjectChoices(now = Date.now()): Promise<ChatgptProjectChoice[]> {
  const entries = (await readCatalog()).filter(entry => entry.seenAt >= now - KEEP_MS);
  if (!entries.length) return [];
  const projects = (await listProjects()).filter(project => !project.ungrouped);
  return entries.map(entry => {
    const owner = projects.find(project => project.chatgpt?.state === 'linked' && project.chatgpt.id === entry.id);
    return { id: entry.id, name: entry.name, linkedTo: owner ? { id: owner.id, name: owner.name } : null };
  });
}

/** True when ChatGPT has listed this Project for the account recently enough to offer it. */
export async function isListedChatgptProject(id: string, now = Date.now()): Promise<boolean> {
  return (await readCatalog()).some(entry => entry.id === id && entry.seenAt >= now - KEEP_MS);
}
