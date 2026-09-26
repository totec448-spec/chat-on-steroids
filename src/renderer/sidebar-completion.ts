/** Device-local read state for completed sidebar chats; session lifecycle remains authoritative elsewhere. */
const STORAGE_KEY = 'chat-on-steroids.sidebar-completion-seen';
const MAX_ENTRIES = 5000;
const MAX_STORAGE_CHARS = 600_000;

type Completion = {
  id: string;
  activeTurnId?: string | null;
  lastAssistantFinalAt?: number | null;
  lastTurnEndAt?: number | null;
  lastTurnOutcome: string | null;
};

type SavedState = {
  baselineAt: number;
  seen: Array<[string, number]>;
};

function completedAt(entry: Completion): number | null {
  if (entry.lastTurnOutcome !== 'completed' || entry.activeTurnId) return null;
  const end = typeof entry.lastTurnEndAt === 'number' && Number.isFinite(entry.lastTurnEndAt) ? entry.lastTurnEndAt : 0;
  const final = typeof entry.lastAssistantFinalAt === 'number' && Number.isFinite(entry.lastAssistantFinalAt) ? entry.lastAssistantFinalAt : 0;
  const at = Math.max(end, final);
  return at > 0 ? at : null;
}

export function createSidebarCompletionState(now = () => Date.now()) {
  let baselineAt = now();
  let loaded = false;
  const seen = new Map<string, number>();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const saved: unknown = raw && raw.length <= MAX_STORAGE_CHARS ? JSON.parse(raw) : null;
    if (saved && typeof saved === 'object') {
      const candidate = saved as Partial<SavedState>;
      if (typeof candidate.baselineAt === 'number' && Number.isFinite(candidate.baselineAt) && Array.isArray(candidate.seen)) {
        baselineAt = candidate.baselineAt;
        loaded = true;
        for (const item of candidate.seen.slice(-MAX_ENTRIES)) {
          if (!Array.isArray(item) || item.length !== 2) continue;
          const [id, at] = item;
          if (typeof id !== 'string' || id.length === 0 || id.length > 160 || typeof at !== 'number' || !Number.isFinite(at)) continue;
          seen.set(id, at);
        }
      }
    }
  } catch { /* Corrupt/unavailable presentation storage must not affect chat lifecycle. */ }

  function save(): void {
    const bounded: Array<[string, number]> = [];
    let serializedChars = 64; // Wrapper, baseline and punctuation budget.
    for (const item of [...seen].slice(-MAX_ENTRIES).reverse()) {
      const chars = JSON.stringify(item).length + 1;
      if (serializedChars + chars > MAX_STORAGE_CHARS) break;
      serializedChars += chars;
      bounded.push(item);
    }
    bounded.reverse();
    if (bounded.length !== seen.size) {
      seen.clear();
      for (const [id, at] of bounded) seen.set(id, at);
    }
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ baselineAt, seen: bounded } satisfies SavedState)); }
    catch { /* Keep read state for this window when local storage is unavailable. */ }
  }

  function isUnseen(entry: Completion): boolean {
    const at = completedAt(entry);
    return at !== null && at > (seen.get(entry.id) ?? baselineAt);
  }

  function markSeen(entry: Completion | undefined): void {
    if (!entry) return;
    const at = completedAt(entry);
    if (at === null || at <= (seen.get(entry.id) ?? baselineAt)) return;
    seen.delete(entry.id);
    seen.set(entry.id, at);
    save();
  }

  // Persist the baseline even before any chat needs an explicit receipt, so a restart does not
  // reinterpret existing history as newly completed work.
  if (!loaded) save();

  return { isUnseen, markSeen };
}
