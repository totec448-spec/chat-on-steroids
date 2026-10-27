/**
 * The one owner of the code checkpoint ledger. An entry names a Git tree that already exists in
 * the project's object store; it is written only after `write-tree` returned that tree.
 */
import { readDurable, writeDurableNow, writeDurableSoon } from '../durable.js';

export const MAX_CHECKPOINTS_PER_PROJECT = 20;
const STATE = 'code-checkpoints';
const VERSION = 1;
const OID = /^[0-9a-f]{40,64}$/;
const ID = /^[0-9a-f]{32}$/;

export interface CodeCheckpoint {
  id: string;
  projectId: string;
  sessionId: string;
  /** `turn:<responseTurnId>` or `request:<requestId>`; one checkpoint per key and session. */
  key: string;
  reason: 'turn' | 'restore';
  treeOid: string;
  headOid: string | null;
  createdAt: number;
}

let entries: CodeCheckpoint[] = [];
let loading: Promise<void> | null = null;
let mutations: Promise<void> = Promise.resolve();

function valid(value: unknown): value is CodeCheckpoint {
  const entry = value as CodeCheckpoint;
  return Boolean(entry) && typeof entry === 'object' && ID.test(entry.id) &&
    typeof entry.projectId === 'string' && entry.projectId.length <= 64 &&
    typeof entry.sessionId === 'string' && entry.sessionId.length <= 64 &&
    typeof entry.key === 'string' && entry.key.length <= 200 &&
    (entry.reason === 'turn' || entry.reason === 'restore') && OID.test(entry.treeOid) &&
    (entry.headOid === null || OID.test(entry.headOid)) && Number.isSafeInteger(entry.createdAt);
}

function load(): Promise<void> {
  loading ??= readDurable<{ version: number; entries: unknown[] }>(STATE).then(saved => {
    if (saved?.version === VERSION && Array.isArray(saved.entries)) entries = saved.entries.filter(valid);
  });
  return loading;
}

/** Newest first. */
export async function listCheckpoints(projectId: string): Promise<CodeCheckpoint[]> {
  await load();
  return entries.filter(entry => entry.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt);
}

export async function findCheckpoint(projectId: string, id: string): Promise<CodeCheckpoint | null> {
  await load();
  return entries.find(entry => entry.projectId === projectId && entry.id === id) ?? null;
}

export async function hasCheckpoint(projectId: string, sessionId: string, key: string): Promise<boolean> {
  await load();
  return entries.some(entry => entry.projectId === projectId && entry.sessionId === sessionId && entry.key === key);
}

/**
 * Durable before visible; the oldest of the project beyond the bound is evicted in the same write.
 * `keep` (a restore's source) is never the one evicted; the oldest of the others makes room.
 */
export function addCheckpoint(entry: CodeCheckpoint, keep?: string): Promise<void> {
  if (!valid(entry)) return Promise.reject(new Error('Invalid code checkpoint'));
  const operation = mutations.then(async () => {
    await load();
    const sorted = entries.filter(other => other.projectId === entry.projectId).sort((a, b) => b.createdAt - a.createdAt);
    const kept = sorted.find(other => other.id === keep);
    const project = kept && sorted.indexOf(kept) >= MAX_CHECKPOINTS_PER_PROJECT - 1
      ? [...sorted.filter(other => other !== kept).slice(0, MAX_CHECKPOINTS_PER_PROJECT - 2), kept]
      : sorted.slice(0, MAX_CHECKPOINTS_PER_PROJECT - 1);
    const next = [...entries.filter(other => other.projectId !== entry.projectId), ...project, entry];
    try {
      await writeDurableNow(STATE, { version: VERSION, entries: next });
    } catch (error) {
      // The failed generation stays queued for retry; it must not publish an unacknowledged entry.
      writeDurableSoon(STATE, { version: VERSION, entries });
      throw error;
    }
    entries = next;
  });
  mutations = operation.catch(() => undefined);
  return operation;
}

export function resetCheckpointsForTests(): void {
  entries = [];
  loading = null;
  mutations = Promise.resolve();
}
