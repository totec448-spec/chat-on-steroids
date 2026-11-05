import type { SessionSummary } from '../shared/session.js';

const STORAGE_KEY = 'chat-on-steroids.pending-tab-follow';
const TTL_MS = 10_000;
type Pending = { id: string; conversationId: string | null; expiresAt: number };
type Reply = { ok: boolean; data?: boolean };
type Selection = Pick<SessionSummary, 'id' | 'conversationId' | 'origin'>;

/** One pending desktop selection, saved before IPC; acceptance retires its restart copy. */
export function createSelectedTabFollow(send: (id: string | null) => Promise<Reply> | undefined) {
  const host = window;
  let recovered: Pending | null = null;
  let restoring: Pending | null = null;
  let current: Pending | null = null;
  let waiting = false;
  let inFlight: Pending | null = null;
  const clear = () => {
    try { host.localStorage.removeItem(STORAGE_KEY); }
    catch { console.error('Browser follow: pending selection could not be cleared from local storage.'); }
  };
  const save = () => {
    try {
      if (waiting && current) host.localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
      else host.localStorage.removeItem(STORAGE_KEY);
    } catch { console.error('Browser follow: local storage is unavailable; pending selection stays in this window only.'); }
  };
  try {
    const raw = host.localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const value = raw.length <= 512 ? JSON.parse(raw) : null;
      const now = Date.now();
      if (value && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 200 &&
          (value.conversationId === null || (typeof value.conversationId === 'string' && /^[0-9a-z-]{8,64}$/i.test(value.conversationId))) &&
          typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt) &&
          value.expiresAt > now && value.expiresAt <= now + TTL_MS) recovered = value;
      else { clear(); console.info('Browser follow: discarded an invalid or expired saved selection.'); }
    }
  } catch { clear(); console.error('Browser follow: saved selection could not be read; recovery was skipped.'); }

  async function deliver(record: Pending): Promise<void> {
    if (!waiting || inFlight === record) return;
    if (Date.now() >= record.expiresAt && record.conversationId !== null) {
      waiting = false; save();
      console.info('Browser follow: pending selection expired before acceptance.');
      return;
    }
    inFlight = record;
    try {
      const reply = await send(record.id);
      if (current === record && record.conversationId !== null && reply?.ok && reply.data === true) {
        waiting = false; save();
      }
    } catch { /* A later catalog/bridge update retries the same bounded intent. */ }
    finally { if (inFlight === record) inFlight = null; }
  }

  return {
    /** Called once the catalog is available; any explicit selection has already canceled recovery. */
    restore(rows: Selection[]): string | null {
      const record = recovered;
      recovered = null;
      if (!record) return null;
      const row = rows.find(row => row.id === record.id);
      if (record.expiresAt <= Date.now() || row?.origin?.kind !== 'desktop' ||
          (record.conversationId !== null && record.conversationId !== row.conversationId)) {
        clear(); console.info('Browser follow: saved selection no longer matches a current desktop chat.');
        return null;
      }
      restoring = record;
      return row.id;
    },
    select(row: Selection | null): void {
      recovered = null;
      const restored = restoring;
      restoring = null;
      current = row?.origin?.kind === 'desktop'
        ? { id: row.id, conversationId: row.conversationId, expiresAt: restored?.expiresAt ?? Date.now() + TTL_MS }
        : null;
      waiting = current !== null;
      save();
      if (current) void deliver(current);
      else void send(row?.id ?? null)?.catch(() => undefined);
    },
    observe(row: Selection | undefined): void {
      if (!current || row?.id !== current.id || row.origin?.kind !== 'desktop') return;
      if (current.conversationId === null && row.conversationId) {
        current = { id: row.id, conversationId: row.conversationId, expiresAt: Date.now() + TTL_MS };
        waiting = true; save();
      } else if (row.conversationId && row.conversationId !== current.conversationId) {
        // A compacted/rebound chat is not the first binding this selection was waiting for.
        waiting = false; save();
        return;
      }
      if (waiting && current.conversationId !== null) void deliver(current);
    }
  };
}
