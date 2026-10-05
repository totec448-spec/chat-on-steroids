/**
 * Pinned chats (#1133): a local presentation preference, like the sidebar order. A pinned chat
 * stays above the unpinned chats of its own list (the main Chats list or its project) and keeps
 * its manual order among the other pinned chats there. Session and project ownership never change.
 */
const STORAGE_KEY = 'chat-on-steroids.sidebar-pins';
const MAX_PINS = 500;
const PINNED_SCOPE = 'pinned:';

/** The drag scope of a row: pinned and unpinned chats are ordered separately within one list. */
export function pinnedSortScope(scope: string, pinned: boolean): string {
  return pinned ? `${PINNED_SCOPE}${scope}` : scope;
}

export function createSidebarPins() {
  const pins = new Set<string>();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const saved: unknown = raw && raw.length <= 100_000 ? JSON.parse(raw) : [];
    if (Array.isArray(saved)) {
      for (const id of saved) {
        if (pins.size >= MAX_PINS) break;
        if (typeof id === 'string' && id.length > 0 && id.length <= 160) pins.add(id);
      }
    }
  } catch { /* Unavailable/corrupt layout storage must not prevent opening chats. */ }

  function save(): void {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...pins])); }
    catch { /* Keep the pins in this window when layout storage is unavailable. */ }
  }

  return {
    has: (id: string): boolean => pins.has(id),
    /** Pins or unpins one chat and says whether it is pinned now. */
    toggle(id: string): boolean {
      if (pins.has(id)) pins.delete(id);
      else {
        // The oldest pin gives way at the bound; a pin is never refused.
        if (pins.size >= MAX_PINS) pins.delete(pins.values().next().value!);
        pins.add(id);
      }
      save();
      return pins.has(id);
    },
    /** Pinned rows first, each group in the order it came in. */
    first<T extends { id: string }>(rows: T[]): T[] {
      return [...rows.filter(row => pins.has(row.id)), ...rows.filter(row => !pins.has(row.id))];
    }
  };
}
