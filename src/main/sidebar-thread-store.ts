/**
 * Presentation-only sidebar shelves. Local session history, provider conversations and
 * agent execution never depend on this file. One main-process queue owns all writes.
 */
import { durableStoreReady, readDurable, writeDurableNow, writeDurableSoon } from './durable.js';

export type SidebarShelf = 'active' | 'pinned' | 'snoozed' | 'settled';
export interface SidebarShelfAttention {
  userMessages: number;
  errors: number;
  lastTurnEndAt?: number | null;
  lastTurnOutcome?: string | null;
}

export type SidebarShelfEntry =
  | { shelf: 'active' }
  | { shelf: 'pinned' | 'settled' }
  | { shelf: 'snoozed'; until: number; snoozedAt: number; userMessages?: number; errors?: number };
export type SidebarShelfRecords = Record<string, Exclude<SidebarShelfEntry, { shelf: 'active' }>>;
export interface SidebarShelfList { records: SidebarShelfRecords; revision: number; nextWake: number | null }
export interface SidebarShelfChange {
  id: string;
  before: SidebarShelfEntry;
  current: SidebarShelfEntry;
  revision: number;
}
/** One durable transaction and one observer event, even when several rows change. */
export interface SidebarShelfBatchChange {
  revision: number;
  changes: Array<Omit<SidebarShelfChange, 'revision'>>;
}
export interface SidebarShelfMutation {
  id: string;
  shelf: SidebarShelf;
  until?: number;
  attention?: SidebarShelfAttention;
}
export interface SidebarShelfRestore { id: string; snapshot: SidebarShelfEntry }

const STORE_NAME = 'sidebar-thread-shelves';
export const MAX_SIDEBAR_SHELVES = 1500;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const SESSION_ID = /^[a-z0-9][a-z0-9._:-]{0,199}$/i;

interface PersistedShelves {
  version: 1;
  revision: number;
  migratedLegacy: boolean;
  records: SidebarShelfRecords;
}

function validId(id: string): boolean { return SESSION_ID.test(id) && id !== '__proto__'; }

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP;
}

/** Never trust the state file or the renderer's migration/undo payload. */
function readEntry(input: unknown): SidebarShelfEntry | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (record.shelf === 'active') return { shelf: 'active' };
  if (record.shelf === 'pinned' || record.shelf === 'settled') return { shelf: record.shelf };
  if (record.shelf !== 'snoozed' || !validTimestamp(record.until) || !validTimestamp(record.snoozedAt)) return null;
  return {
    shelf: 'snoozed', until: record.until, snoozedAt: record.snoozedAt,
    ...(validCount(record.userMessages) ? { userMessages: record.userMessages } : {}),
    ...(validCount(record.errors) ? { errors: record.errors } : {})
  };
}

function visible(entry?: SidebarShelfEntry): SidebarShelfEntry {
  return entry ? { ...entry } : { shelf: 'active' };
}

function attentionWakes(entry: SidebarShelfEntry, attention?: SidebarShelfAttention): boolean {
  if (entry.shelf !== 'snoozed' || !attention) return false;
  const failure = ['failed', 'stalled', 'interrupted'].includes(attention.lastTurnOutcome ?? '');
  return (failure && (attention.lastTurnEndAt ?? 0) > entry.snoozedAt) ||
    (entry.errors !== undefined && attention.errors > entry.errors) ||
    (entry.userMessages !== undefined && attention.userMessages > entry.userMessages);
}

/** Instantiable so tests can exercise restart/concurrent access using the real durable store. */
export class SidebarThreadStore {
  private loaded = false;
  private records = new Map<string, Exclude<SidebarShelfEntry, { shelf: 'active' }>>();
  private revision = 0;
  private migratedLegacy = false;
  private tail: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(change: SidebarShelfChange) => void>();
  private batchListeners = new Set<(change: SidebarShelfBatchChange) => void>();

  constructor(private readonly now: () => number = Date.now) {}

  onChange(listener: (change: SidebarShelfChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  onBatch(listener: (change: SidebarShelfBatchChange) => void): () => void {
    this.batchListeners.add(listener);
    return () => { this.batchListeners.delete(listener); };
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(work);
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    if (!durableStoreReady()) throw new Error('Sidebar storage is not ready');
    const saved = await readDurable<unknown>(STORE_NAME);
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      const value = saved as Partial<PersistedShelves>;
      if (value.version === 1 && value.records && typeof value.records === 'object' && !Array.isArray(value.records)) {
        // Reject an impossible oversized ledger rather than silently evicting pinned threads.
        const entries = Object.entries(value.records);
        if (entries.length <= MAX_SIDEBAR_SHELVES) {
          for (const [id, input] of entries) {
            if (!validId(id)) continue;
            const entry = readEntry(input);
            if (entry && entry.shelf !== 'active' && (entry.shelf !== 'snoozed' || entry.until > this.now())) {
              this.records.set(id, entry);
            }
          }
          this.revision = validCount(value.revision) ? value.revision : 0;
          this.migratedLegacy = value.migratedLegacy === true;
        }
      }
    }
    this.loaded = true;
  }

  private data(records = this.records, revision = this.revision, migratedLegacy = this.migratedLegacy): PersistedShelves {
    return { version: 1, revision, migratedLegacy, records: Object.fromEntries(records) };
  }

  private async commit(next: Map<string, Exclude<SidebarShelfEntry, { shelf: 'active' }>>, migratedLegacy = this.migratedLegacy): Promise<number> {
    if (this.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Sidebar revision exhausted');
    const revision = this.revision + 1;
    try {
      await writeDurableNow(STORE_NAME, this.data(next, revision, migratedLegacy));
    } catch (error) {
      // The shared durable writer retries failed commits in the background. Supersede
      // that rejected generation with the last acknowledged state so it cannot surface
      // later as an unacknowledged shelf change when disk access recovers.
      writeDurableSoon(STORE_NAME, this.data());
      throw error;
    }
    this.records = next;
    this.revision = revision;
    this.migratedLegacy = migratedLegacy;
    return revision;
  }

  private publish(id: string, before: SidebarShelfEntry, current: SidebarShelfEntry): SidebarShelfChange {
    const change = { id, before, current, revision: this.revision };
    for (const listener of this.listeners) {
      try { listener(change); } catch { /* Observers do not own storage commits. */ }
    }
    return change;
  }

  private publishBatch(changes: SidebarShelfBatchChange['changes']): SidebarShelfBatchChange {
    const batch = { changes, revision: this.revision };
    for (const listener of this.batchListeners) {
      try { listener(batch); } catch { /* Observers never own a transaction. */ }
    }
    return batch;
  }

  /** Validate every mutation before changing durable state, then commit exactly once. */
  setMany(mutations: SidebarShelfMutation[], expectedRevision: number): Promise<SidebarShelfBatchChange> {
    if (!mutations.length || mutations.length > MAX_SIDEBAR_SHELVES ||
        new Set(mutations.map(item => item.id)).size !== mutations.length ||
        mutations.some(item => !validId(item.id) || !['active', 'pinned', 'snoozed', 'settled'].includes(item.shelf) ||
          (item.shelf === 'snoozed' && !validTimestamp(item.until)))) {
      return Promise.reject(new Error('Invalid sidebar batch'));
    }
    return this.serial(async () => {
      await this.load();
      if (this.revision !== expectedRevision) throw new Error('Sidebar changed in another window');
      const next = new Map(this.records);
      const changes: SidebarShelfBatchChange['changes'] = [];
      for (const item of mutations) {
        if (item.shelf === 'snoozed' && item.until! <= this.now()) throw new Error('Sidebar snooze deadline expired');
        const before = visible(next.get(item.id));
        const current: SidebarShelfEntry = item.shelf === 'snoozed' && item.until! > this.now()
          ? { shelf: 'snoozed', until: item.until!, snoozedAt: this.now(),
              ...(item.attention ? { userMessages: item.attention.userMessages, errors: item.attention.errors } : {}) }
          : item.shelf === 'active' || item.shelf === 'snoozed' ? { shelf: 'active' } : { shelf: item.shelf };
        if (current.shelf === 'active') next.delete(item.id);
        else next.set(item.id, current);
        if (JSON.stringify(before) !== JSON.stringify(current)) changes.push({ id: item.id, before, current });
      }
      if (next.size > MAX_SIDEBAR_SHELVES) throw new Error('Sidebar shelf limit reached');
      if (!changes.length) return { revision: this.revision, changes: [] };
      await this.commit(next);
      return this.publishBatch(changes);
    });
  }

  /** Atomic Undo/redo: the exact prior snapshots are accepted only at the expected revision. */
  restoreMany(snapshots: SidebarShelfRestore[], expectedRevision: number): Promise<SidebarShelfBatchChange> {
    if (!snapshots.length || snapshots.length > MAX_SIDEBAR_SHELVES ||
        new Set(snapshots.map(item => item.id)).size !== snapshots.length ||
        snapshots.some(item => !validId(item.id) || !readEntry(item.snapshot))) {
      return Promise.reject(new Error('Invalid sidebar batch undo'));
    }
    return this.serial(async () => {
      await this.load();
      if (this.revision !== expectedRevision) throw new Error('Sidebar changed in another window');
      const next = new Map(this.records);
      const changes: SidebarShelfBatchChange['changes'] = [];
      for (const item of snapshots) {
        const before = visible(next.get(item.id));
        const saved = readEntry(item.snapshot)!;
        // Undo cannot truthfully restore an expired snooze. Reject the whole transaction.
        if (saved.shelf === 'snoozed' && saved.until <= this.now()) throw new Error('Sidebar snooze snapshot expired');
        const current: SidebarShelfEntry = saved;
        if (current.shelf === 'active') next.delete(item.id);
        else next.set(item.id, current);
        if (JSON.stringify(before) !== JSON.stringify(current)) changes.push({ id: item.id, before, current });
      }
      if (next.size > MAX_SIDEBAR_SHELVES) throw new Error('Sidebar shelf limit reached');
      if (!changes.length) return { revision: this.revision, changes: [] };
      await this.commit(next);
      return this.publishBatch(changes);
    });
  }

  private async wake(id: string, attention?: SidebarShelfAttention): Promise<void> {
    const entry = this.records.get(id);
    if (!entry || entry.shelf !== 'snoozed') return;
    if (entry.until > this.now() && !attentionWakes(entry, attention)) return;
    const next = new Map(this.records);
    next.delete(id);
    await this.commit(next);
    this.publish(id, visible(entry), { shelf: 'active' });
  }

  private async expire(): Promise<void> {
    const expired = [...this.records].filter(([, entry]) => entry.shelf === 'snoozed' && entry.until <= this.now());
    if (!expired.length) return;
    const next = new Map(this.records);
    for (const [id] of expired) next.delete(id);
    await this.commit(next);
    this.publishBatch(expired.map(([id, entry]) => ({ id, before: visible(entry), current: { shelf: 'active' } })));
  }

  list(): Promise<SidebarShelfList> {
    return this.serial(async () => {
      await this.load();
      await this.expire();
      let nextWake = Infinity;
      for (const entry of this.records.values()) if (entry.shelf === 'snoozed') nextWake = Math.min(nextWake, entry.until);
      return { records: this.data().records, revision: this.revision, nextWake: Number.isFinite(nextWake) ? nextWake : null };
    });
  }

  get(id: string, attention?: SidebarShelfAttention): Promise<SidebarShelfEntry> {
    if (!validId(id)) return Promise.reject(new Error('Invalid local session ID'));
    return this.serial(async () => {
      await this.load();
      await this.wake(id, attention);
      return visible(this.records.get(id));
    });
  }

  set(id: string, shelf: SidebarShelf, until?: number, attention?: SidebarShelfAttention,
    expectedRevision?: number): Promise<SidebarShelfChange> {
    if (!validId(id)) return Promise.reject(new Error('Invalid local session ID'));
    if (shelf === 'snoozed' && !validTimestamp(until)) return Promise.reject(new Error('Invalid snooze deadline'));
    return this.serial(async () => {
      await this.load();
      if (expectedRevision !== undefined && expectedRevision !== this.revision) throw new Error('Sidebar changed in another window');
      const before = visible(this.records.get(id));
      const current: SidebarShelfEntry = shelf === 'snoozed' && until! > this.now()
        ? { shelf, until: until!, snoozedAt: this.now(),
            ...(attention ? { userMessages: attention.userMessages, errors: attention.errors } : {}) }
        : shelf === 'snoozed' || shelf === 'active' ? { shelf: 'active' } : { shelf };
      const next = new Map(this.records);
      if (current.shelf === 'active') next.delete(id);
      else next.set(id, current);
      if (next.size > MAX_SIDEBAR_SHELVES) throw new Error('Sidebar shelf limit reached; remove a saved shelf first');
      // Do not turn a repeated no-op or an already-active row into a disk write.
      if (JSON.stringify(before) === JSON.stringify(current)) return { id, before, current, revision: this.revision };
      await this.commit(next);
      return this.publish(id, before, current);
    });
  }

  /** Restore an exact prior shelf (including its original snooze baseline) for Undo. */
  restore(id: string, snapshot: SidebarShelfEntry, expectedRevision: number): Promise<SidebarShelfChange> {
    if (!validId(id)) return Promise.reject(new Error('Invalid local session ID'));
    const restored = readEntry(snapshot);
    if (!restored) return Promise.reject(new Error('Invalid sidebar undo snapshot'));
    return this.serial(async () => {
      await this.load();
      if (this.revision !== expectedRevision) throw new Error('Sidebar changed in another window');
      const before = visible(this.records.get(id));
      const current = restored.shelf === 'snoozed' && restored.until <= this.now()
        ? { shelf: 'active' as const } : restored;
      const next = new Map(this.records);
      if (current.shelf === 'active') next.delete(id);
      else next.set(id, current);
      if (next.size > MAX_SIDEBAR_SHELVES) throw new Error('Sidebar shelf limit reached');
      if (JSON.stringify(before) === JSON.stringify(current)) return { id, before, current, revision: this.revision };
      await this.commit(next);
      return this.publish(id, before, current);
    });
  }

  /** One-time import of the old renderer preference, without replacing main-owned choices. */
  migrateLegacy(rows: Record<string, unknown>): Promise<SidebarShelfList> {
    return this.serial(async () => {
      await this.load();
      if (!this.migratedLegacy) {
        const incoming = Object.entries(rows);
        if (incoming.length > MAX_SIDEBAR_SHELVES) throw new Error('Legacy sidebar shelf limit exceeded');
        const next = new Map(this.records);
        const added: Array<[string, Exclude<SidebarShelfEntry, { shelf: 'active' }>]> = [];
        for (const [id, input] of incoming) {
          if (!validId(id) || next.has(id)) continue;
          const entry = readEntry(input);
          if (entry && entry.shelf !== 'active' && (entry.shelf !== 'snoozed' || entry.until > this.now())) {
            next.set(id, entry);
            added.push([id, entry]);
          }
        }
        if (next.size > MAX_SIDEBAR_SHELVES) throw new Error('Sidebar shelf limit reached');
        await this.commit(next, true);
        if (added.length) this.publishBatch(added.map(([id, current]) => ({ id, before: { shelf: 'active' }, current })));
      }
      let nextWake = Infinity;
      for (const entry of this.records.values()) if (entry.shelf === 'snoozed') nextWake = Math.min(nextWake, entry.until);
      return { records: this.data().records, revision: this.revision, nextWake: Number.isFinite(nextWake) ? nextWake : null };
    });
  }
}

export const sidebarThreadStore = new SidebarThreadStore();
