import type { SessionSummary } from '../shared/session.js';

const TTL_MS = 10_000;
type Pending = { id: string; conversationId: string | null; expiresAt: number };
type Reply = { ok: boolean; data?: boolean };
type Selection = Pick<SessionSummary, 'id' | 'conversationId' | 'origin'>;

/** One pending desktop selection; retries share its original ten-second deadline. */
export function createSelectedTabFollow(send: (id: string | null) => Promise<Reply> | undefined) {
  let current: Pending | null = null;
  let inFlight: Pending | null = null;
  function pending(): Pending | null {
    if (current && Date.now() >= current.expiresAt) {
      current = null;
      console.info('Browser follow: pending selection expired before acceptance.');
    }
    return current;
  }

  async function deliver(record: Pending): Promise<void> {
    if (pending() !== record || inFlight === record) return;
    inFlight = record;
    try {
      const reply = await send(record.id);
      if (current === record && record.conversationId !== null && reply?.ok && reply.data === true) {
        current = null;
      }
    } catch { /* A later catalog/bridge update retries the same bounded intent. */ }
    finally { if (inFlight === record) inFlight = null; }
  }

  return {
    select(row: Selection | null): void {
      current = row?.origin?.kind === 'desktop'
        ? { id: row.id, conversationId: row.conversationId, expiresAt: Date.now() + TTL_MS }
        : null;
      if (current) void deliver(current);
      else void send(row?.id ?? null)?.catch(() => undefined);
    },
    observe(row: Selection | undefined): void {
      const record = pending();
      if (!record || row?.id !== record.id || row.origin?.kind !== 'desktop') return;
      if (record.conversationId === null && row.conversationId) {
        current = { ...record, conversationId: row.conversationId };
      } else if (row.conversationId && row.conversationId !== record.conversationId) {
        // A compacted/rebound chat is not the first binding this selection was waiting for.
        current = null;
        return;
      }
      if (current?.conversationId) void deliver(current);
    }
  };
}
