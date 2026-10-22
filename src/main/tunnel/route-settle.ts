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
 * The hold covers the slower case with a margin. Only an existing chat's message waits, and
 * only right after a new client starts; the alternative is that message waiting two minutes.
 *
 * So a message for an existing chat is held until every new client has been connected for
 * ROUTE_SETTLE_MS, and the browser is woken when the hold ends.
 */
import { wakeBrowserWork } from '../browser-wake.js';

export const ROUTE_SETTLE_MS = 35_000;

let settledAt = 0;
let timer: NodeJS.Timeout | null = null;

/** A new tunnel-client process connected for the first time. */
export function noteTunnelClientConnected(now = Date.now()): void {
  const until = now + ROUTE_SETTLE_MS;
  if (until <= settledAt) return;
  settledAt = until;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; wakeBrowserWork(); }, ROUTE_SETTLE_MS);
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

export function resetRouteSettleForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  settledAt = 0;
}
