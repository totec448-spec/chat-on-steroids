/**
 * How long a new tunnel-client takes over an existing chat's route (#1220).
 *
 * After a new tunnel-client connects (an app start, an update, or a client the app replaced),
 * OpenAI keeps sending an existing chat's tool calls to the previous client for a few seconds.
 * A call sent in that window waits for the old client's lease, about 128 s, before it arrives.
 * Measured on Windows (2026-10-09), sending from the same open chat after the new client
 * connected: at once 15 of 18 calls waited, after 3 s 5 of 6, after 6 s 5 of 6, after 9–10 s
 * none of 26. A new chat is not affected. On the Mac on 2026-10-22 (#1788) the window had grown:
 * with the hold then at 12 s, about half the calls still waited; sent 22 s after the new client
 * connected, 2 of 3; at 32 s and 47 s, none of 6. Windows the same day: 4 of 4 fine at 12 s.
 * Only an existing chat's message waits, and only right after a new client starts; the
 * alternative is that message waiting two minutes.
 *
 * So a message for an existing chat is held until every new client has been connected for the
 * current hold, and the browser is woken when the hold ends.
 *
 * The hold learns, per computer. The window differs between computers and changes over time, and
 * nothing tells the app when OpenAI has moved a chat over. What it can see is the outcome: the
 * page shows a call's request id within seconds of the send even when the call itself arrives
 * ~124 s later (Mac, 2026-10-22: 2.8, 4.2 and 6.4 s against 124.7, 123.4 and 124.5 s). So after
 * each new client, the first message for an existing chat is timed from ChatGPT showing its call
 * to the call reaching this app. Late, the hold grows at once; fast three restarts in a row, it
 * shrinks a little. Anything in between, a new chat, or a send long after the restart says
 * nothing about the route and changes nothing.
 */
import { wakeBrowserWork } from '../browser-wake.js';
import { readDurable, writeDurableSoon } from '../durable.js';
import { logInfo } from '../logger.js';

/** Where the hold starts, and what it returns to when nothing valid was saved. */
export const ROUTE_SETTLE_MS = 35_000;
const MIN_HOLD_MS = 12_000;
const MAX_HOLD_MS = 90_000;
/** The old route's wait is ~124 s; a normal call follows its sighting within seconds. */
const LATE_GAP_MS = 60_000;
const FAST_GAP_MS = 30_000;
const FAST_STREAK = 3;
const STEP_DOWN_MS = 5_000;
const STEP_UP_MIN_MS = 15_000;
/** Only a send this soon after a new client is about that client's takeover. */
const MEASURE_WINDOW_MS = 5 * 60_000;
const STATE = 'route-hold';
const STATE_VERSION = 1;

let holdMs = ROUTE_SETTLE_MS;
let fastStreak = 0;
let settledAt = 0;
let timer: NodeJS.Timeout | null = null;

/** The newest client's takeover, while its one measurement is still open. */
let epoch: { connectedAt: number; measured: boolean } | null = null;
/** Existing chats sent to after the newest client connected, not yet seen calling. */
const watched = new Set<string>();
/** Request ids ChatGPT showed for a watched chat, and when; or calls that arrived first. */
const sighted = new Map<string, number>();
const arrived = new Map<string, number>();

/** The current hold, for tests and the log. */
export function routeHoldMs(): number {
  return holdMs;
}

/** A new tunnel-client process connected for the first time. */
export function noteTunnelClientConnected(now = Date.now()): void {
  epoch = { connectedAt: now, measured: false };
  watched.clear();
  sighted.clear();
  arrived.clear();
  const until = now + holdMs;
  if (until <= settledAt) return;
  settledAt = until;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; wakeBrowserWork(); }, holdMs);
  timer.unref?.();
}

/** Whether a message for an existing chat would still reach the previous client's route. */
export function tunnelRouteSettling(now = Date.now()): boolean {
  return now < settledAt;
}

/** When the current hold ends, for the chat to say why a message is waiting; null when none. */
export function tunnelRouteSettlingUntil(now = Date.now()): number | null {
  return now < settledAt ? settledAt : null;
}

function measuring(now: number): boolean {
  return !!epoch && !epoch.measured && now - epoch.connectedAt <= MEASURE_WINDOW_MS;
}

/** The browser took a message for an existing chat (one with a ChatGPT conversation). */
export function noteRouteExistingChatSend(conversationId: string, now = Date.now()): void {
  if (measuring(now)) watched.add(conversationId);
}

/** The page proved which chat a ChatGPT request belongs to: its call has been issued. */
export function noteRouteRequestSighted(requestId: string, conversationId: string, now = Date.now()): void {
  if (!measuring(now) || !watched.has(conversationId) || sighted.has(requestId)) return;
  watched.delete(conversationId);
  const arrivedAt = arrived.get(requestId);
  if (arrivedAt !== undefined) learn(arrivedAt - now);
  else sighted.set(requestId, now);
}

/** A call reached this app over the tunnel, carrying ChatGPT's request id. */
export function noteRouteRequestArrived(requestId: string, now = Date.now()): void {
  if (!measuring(now)) return;
  const at = sighted.get(requestId);
  if (at !== undefined) { learn(now - at); return; }
  // A fast route can deliver the call before the page reports it. Only while a send is watched,
  // so ordinary traffic costs nothing.
  if (watched.size && arrived.size < 64) arrived.set(requestId, now);
}

function learn(gapMs: number): void {
  if (!epoch || epoch.measured) return;
  epoch.measured = true;
  watched.clear();
  sighted.clear();
  arrived.clear();
  const seconds = Math.round(Math.max(0, gapMs) / 1000);
  const before = holdMs;
  if (gapMs >= LATE_GAP_MS) {
    holdMs = Math.min(MAX_HOLD_MS, Math.max(Math.round(holdMs * 1.5), holdMs + STEP_UP_MIN_MS));
    fastStreak = 0;
    logInfo(`route hold: an existing chat's call reached this app ${seconds} s after ChatGPT showed it, ` +
      `so it still took the previous tunnel-client; hold ${before / 1000} s → ${holdMs / 1000} s`);
  } else if (gapMs <= FAST_GAP_MS) {
    fastStreak += 1;
    if (fastStreak >= FAST_STREAK) {
      holdMs = Math.max(MIN_HOLD_MS, holdMs - STEP_DOWN_MS);
      fastStreak = 0;
    }
    logInfo(`route hold: an existing chat's call reached this app ${seconds} s after ChatGPT showed it; ` +
      (holdMs !== before ? `${FAST_STREAK} fast restarts in a row, hold ${before / 1000} s → ${holdMs / 1000} s` :
        `hold stays ${holdMs / 1000} s (${fastStreak} of ${FAST_STREAK} fast restarts)`));
  } else {
    logInfo(`route hold: an existing chat's call reached this app ${seconds} s after ChatGPT showed it; ` +
      `neither clearly fast nor late, hold stays ${holdMs / 1000} s`);
    return;
  }
  writeDurableSoon(STATE, { version: STATE_VERSION, holdMs, fastStreak });
}

/** Loads this computer's learned hold; anything damaged or out of range starts over at 35 s. */
export async function restoreRouteHold(): Promise<void> {
  const saved = await readDurable<{ version?: unknown; holdMs?: unknown; fastStreak?: unknown }>(STATE);
  if (!saved || typeof saved !== 'object' || saved.version !== STATE_VERSION) return;
  const ms = saved.holdMs;
  if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < MIN_HOLD_MS || ms > MAX_HOLD_MS) return;
  holdMs = ms;
  const streak = saved.fastStreak;
  fastStreak = typeof streak === 'number' && Number.isInteger(streak) && streak >= 0 && streak < FAST_STREAK ? streak : 0;
}

export function resetRouteSettleForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  settledAt = 0;
  holdMs = ROUTE_SETTLE_MS;
  fastStreak = 0;
  epoch = null;
  watched.clear();
  sighted.clear();
  arrived.clear();
}
