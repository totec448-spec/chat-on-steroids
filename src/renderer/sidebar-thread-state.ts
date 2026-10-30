/**
 * Local-only organisation for the sidebar. This never mutates recorded sessions,
 * the provider conversation, or a running agent's execution state.
 */
export type ThreadShelf = 'active' | 'pinned' | 'snoozed' | 'settled';
export type SidebarAttention = {
  userMessages: number;
  errors: number;
  lastTurnEndAt?: number | null;
  lastTurnOutcome?: string | null;
};
type SavedThread = { shelf: Exclude<ThreadShelf, 'active'>; until?: number; snoozedAt?: number;
  userMessages?: number; errors?: number };
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
const KEY = 'chat-on-steroids.sidebar-thread-shelves.v1';
const MAX_RECORDS = 1500;

export function createSidebarThreadState(storage: StorageLike, now: () => number = Date.now) {
  const records = new Map<string, SavedThread>();
  try {
    const raw: unknown = JSON.parse(storage.getItem(KEY) ?? '{}');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [id, value] of Object.entries(raw).slice(-MAX_RECORDS)) {
        if (!id || id.length > 200 || !value || typeof value !== 'object') continue;
        const entry = value as Partial<SavedThread>;
        if (entry.shelf !== 'pinned' && entry.shelf !== 'snoozed' && entry.shelf !== 'settled') continue;
        if (entry.shelf === 'snoozed' && (!Number.isFinite(entry.until) || (entry.until ?? 0) <= now())) continue;
        records.set(id, { shelf: entry.shelf, ...(entry.shelf === 'snoozed' ? {
          until: entry.until,
          ...(Number.isFinite(entry.snoozedAt) ? { snoozedAt: entry.snoozedAt } : {}),
          ...(Number.isFinite(entry.userMessages) ? { userMessages: entry.userMessages } : {}),
          ...(Number.isFinite(entry.errors) ? { errors: entry.errors } : {})
        } : {}) });
      }
    }
  } catch { /* Invalid or unavailable local preferences fall back to active. */ }

  const save = (): void => {
    try { storage.setItem(KEY, JSON.stringify(Object.fromEntries(records))); }
    catch { /* Preserve in-memory choice even if storage is disabled. */ }
  };
  const get = (id: string, attention?: SidebarAttention): ThreadShelf => {
    const entry = records.get(id);
    if (!entry) return 'active';
    if (entry.shelf === 'snoozed') {
      // Wake only for *new* failure, error or user input; the persistent
      // nativeQuestion identity does not mean a conversation needs attention.
      const newFailure = attention?.lastTurnOutcome === 'failed' || attention?.lastTurnOutcome === 'stalled' || attention?.lastTurnOutcome === 'interrupted';
      const freshFailure = newFailure && entry.snoozedAt !== undefined && (attention?.lastTurnEndAt ?? 0) > entry.snoozedAt;
      if ((entry.until ?? 0) <= now() || freshFailure ||
        (entry.errors !== undefined && (attention?.errors ?? entry.errors) > entry.errors) ||
        (entry.userMessages !== undefined && (attention?.userMessages ?? entry.userMessages) > entry.userMessages)) {
        records.delete(id); save(); return 'active';
      }
    }
    return entry.shelf;
  };
  /** Read the saved state without triggering an attention wake. Main is the
   * authority for persisted transitions and must receive the same signal. */
  const peek = (id: string): ThreadShelf => records.get(id)?.shelf ?? 'active';
  const snapshot = (id: string): { shelf: ThreadShelf; until?: number } => {
    const shelf = get(id);
    const until = shelf === 'snoozed' ? records.get(id)?.until : undefined;
    return { shelf, ...(until !== undefined ? { until } : {}) };
  };
  const set = (id: string, shelf: ThreadShelf, until?: number, attention?: SidebarAttention): void => {
    if (!id || id.length > 200) return;
    if (shelf === 'active' || (shelf === 'snoozed' && (!Number.isFinite(until) || (until ?? 0) <= now()))) records.delete(id);
    else {
      records.delete(id);
      records.set(id, { shelf: shelf as SavedThread['shelf'], ...(shelf === 'snoozed' ? {
        until, snoozedAt: now(),
        ...(attention ? { userMessages: attention.userMessages, errors: attention.errors } : {})
      } : {}) });
      if (records.size > MAX_RECORDS) records.delete(records.keys().next().value!);
    }
    save();
  };
  const nextWake = (): number | null => {
    let earliest = Infinity;
    let changed = false;
    for (const [id, entry] of records) {
      if (entry.shelf !== 'snoozed') continue;
      if ((entry.until ?? 0) <= now()) { records.delete(id); changed = true; continue; }
      earliest = Math.min(earliest, entry.until!);
    }
    if (changed) save();
    return Number.isFinite(earliest) ? earliest : null;
  };
  /** Apply an authoritative backend entry without resetting snooze baselines. */
  const applySaved = (id: string, raw: unknown, persist = true): void => {
    if (!id || id.length > 200 || !raw || typeof raw !== 'object') return;
    const entry = raw as Partial<Omit<SavedThread, 'shelf'>> & { shelf?: ThreadShelf };
    if (entry.shelf === 'active') records.delete(id);
    else if (entry.shelf === 'pinned' || entry.shelf === 'settled') records.set(id, { shelf: entry.shelf });
    else if (entry.shelf === 'snoozed' && Number.isFinite(entry.until) && (entry.until ?? 0) > now()) {
      records.set(id, { shelf: 'snoozed', until: entry.until,
        ...(Number.isFinite(entry.snoozedAt) ? { snoozedAt: entry.snoozedAt } : {}),
        ...(Number.isFinite(entry.userMessages) ? { userMessages: entry.userMessages } : {}),
        ...(Number.isFinite(entry.errors) ? { errors: entry.errors } : {}) });
    }
    if (persist) save();
  };
  const replaceAll = (saved: Record<string, unknown>): void => {
    records.clear();
    for (const [id, entry] of Object.entries(saved).slice(0, MAX_RECORDS)) applySaved(id, entry, false);
    save();
  };
  return { get, peek, snapshot, set, nextWake, applySaved, replaceAll };
}
