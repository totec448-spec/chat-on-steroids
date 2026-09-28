import { z } from 'zod';
import { primeForOwnedConversation } from '../agents.js';
import { sessionActivityExpiresAt } from '../bridge.js';
import { getConfig } from '../config.js';
import { tokenPressure } from '../../shared/session.js';
import { listInputs } from './input.js';
import { activeSessionId } from './recorder.js';
import { blockedChatIds } from './blocked-chats.js';
import { findSessionByConversation, getSession, listSessionPage, readEvents, readRecentEvents } from './store.js';
import type { SessionListCursor } from './store.js';
import type { SessionEventKind, SessionSummary } from '../../shared/session.js';

/**
 * The session list and event pages as clients read them.
 *
 * Both the renderer (IPC) and the local control API serve these, so the enrichment that turns
 * stored summaries into what a client sees lives here once. Nothing here writes on its own, but
 * the list first asks `listInputs()`, which repairs and records delivery receipts as it always has.
 */

export const sessionListCursorSchema = z.object({
  updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i)
});

/** The runtime activity deadline belongs to the bridge, so it is added at read time, never stored. */
function withActivity(summary: SessionSummary): SessionSummary {
  const activityExpiresAt = sessionActivityExpiresAt(summary);
  return activityExpiresAt === undefined ? summary : { ...summary, activityExpiresAt };
}

/** Null when there is no such session. */
export async function readSession(id: string): Promise<SessionSummary | null> {
  const summary = await getSession(id);
  return summary ? withActivity(summary) : null;
}

export async function readSessionList(options: { cursor?: SessionListCursor; limit: number }) {
  const config = getConfig();
  await listInputs(); // Restore exact helper origins before the first sidebar page.
  const page = await listSessionPage({ cursor: options.cursor, limit: options.limit });
  // Older recordings omitted worker origins' parent IDs. The broker's exact
  // retained owner can repair that presentation without reviving a worker or
  // guessing from reusable names such as worker-1.
  const parents = new Map<string, ReturnType<typeof findSessionByConversation>>();
  const sessions = await Promise.all(page.sessions.map(async (summary) => {
    if (summary.origin?.kind !== 'worker' || summary.origin.fromSessionId || !summary.conversationId) return summary;
    const prime = primeForOwnedConversation(summary.conversationId);
    if (!prime || prime === summary.conversationId) return summary;
    if (!parents.has(prime)) parents.set(prime, findSessionByConversation(prime, { requireUnique: true }));
    const parent = await parents.get(prime);
    return parent && parent.id !== summary.id ? { ...summary, origin: { ...summary.origin, fromSessionId: parent.id } } : summary;
  }));
  return {
    sessions: sessions.map(withActivity),
    total: page.total,
    nextCursor: page.nextCursor,
    activeId: activeSessionId(),
    // Live policy, not session history: a block is keyed by ChatGPT conversation and does
    // not belong in any session's meta.json. It rides the list for the same reason
    // `activeId` and `pressure` do — one paint, one round trip.
    blocked: blockedChatIds(),
    pressure: sessions.map((summary) => ({
      id: summary.id,
      // Pressure belongs to the currently attached ChatGPT context. `estimatedTokens` is
      // deliberately lifetime history and therefore never resets across Compact & Resume;
      // using it here made a fresh B look fuller than the A it had just replaced.
      ...tokenPressure(summary.contextTokens, config.sessions.advisoryTokens, config.sessions.limitTokens)
    }))
  };
}

/** Null when there is no such session. */
export async function readSessionEvents(
  id: string,
  options: { from?: number; before?: number; after?: number; limit?: number; kinds?: readonly SessionEventKind[] }
) {
  const summary = await getSession(id);
  if (!summary) return null;
  // The renderer draws a timeline, not the whole log: the tail is what matters and
  // the rest stays one click away rather than being pushed over IPC every refresh.
  // The renderer never paints more than 160 rows. Sending nearly twice that on every first
  // load was pure cloning/IPC work; later refreshes use the sequence cursor below.
  const cap = options.limit ?? 160;
  if (options.from === undefined) {
    // Navigation uses immutable origins. `from` alone is a publication cursor
    // for live revisions and must never decide which history page owns a row.
    const events = await readRecentEvents(id, cap, { before: options.before, after: options.after, kinds: options.kinds, orderByOrigin: true });
    const nextFrom = events.reduce((cursor, event) => Math.max(cursor, event.seq + 1), 0);
    return { summary, events, total: summary.events, nextFrom };
  }
  const events = await readEvents(id, { from: options.from, limit: cap, kinds: options.kinds });
  const nextFrom = events.reduce((cursor, event) => Math.max(cursor, event.seq + 1), options.from);
  return { summary, events, total: summary.events, nextFrom };
}
