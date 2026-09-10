import { AsyncLocalStorage } from 'node:async_hooks';
import type { OutputPublication } from '../codex/unified-exec.js';

/**
 * The id ChatGPT puts on the HTTP request that carries a tool call.
 *
 * Measured live: the connector request arrives with `x-request-id: wfr_<id>/<suffix>`, and
 * the same `wfr_<id>` is what the page's own message model holds as `metadata.request_id`
 * on the request behind the call. That makes it a deterministic join between a call and the
 * conversation that issued it — no window, no ordering, and no coin toss when two workers
 * call the same tool at the same moment.
 *
 * It has to be carried out of band because the MCP server's own call context does not
 * expose the request headers: live, `mcpCtx.http.headers` is null while the header is
 * plainly there on the socket. So the surface's request handler runs inside this store and
 * the tool dispatch reads it back.
 */
export type InboundPhase = 'identity' | 'handler' | 'delivery' | 'recorder';
export interface InboundTiming {
  startedAt: number;
  dispatchedAt: number | null;
  completedAt: number | null;
  calls: number;
  phases: Record<InboundPhase, number>;
}
const store = new AsyncLocalStorage<{ requestId: string | null; timing?: InboundTiming; publication?: OutputPublication }>();

/** Fixed-size, process-local numbers only: no payload, credential, path or chat identity. */
export function createInboundTiming(): InboundTiming {
  return { startedAt: performance.now(), dispatchedAt: null, completedAt: null, calls: 0,
    phases: { identity: 0, handler: 0, delivery: 0, recorder: 0 } };
}

/** Each dispatch has its own cursor even if an adapter executes several calls concurrently. */
export function beginToolTiming(): (phase: InboundPhase, complete?: boolean) => void {
  const timing = store.getStore()?.timing;
  let previous = performance.now();
  if (timing) { timing.calls++; timing.dispatchedAt ??= previous; }
  return (phase, complete = false) => {
    const now = performance.now();
    if (timing) {
      timing.phases[phase] += Math.max(0, now - previous);
      if (complete) timing.completedAt = now;
    }
    previous = now;
  };
}

/** Aggregated call time may exceed HTTP wall time for concurrent calls; response_tail is
 * local SDK serialization/socket completion, never evidence of remote model receipt. */
export function formatInboundTiming(timing: InboundTiming): string {
  if (!timing.calls) return '';
  const ms = (value: number) => Math.max(0, Math.round(value));
  return ` calls=${timing.calls} ingress_ms=${ms((timing.dispatchedAt ?? timing.startedAt) - timing.startedAt)}` +
    Object.entries(timing.phases).map(([phase, value]) => ` ${phase}_ms=${ms(value)}`).join('') +
    ` response_tail_ms=${timing.completedAt === null ? 'pending' : ms(performance.now() - timing.completedAt)}`;
}

/** Runs `body` with the request id of the HTTP request currently being served. */
export function withInboundRequestId<T>(requestId: string | null, body: () => T, timing?: InboundTiming, publication?: OutputPublication): T {
  return store.run({ requestId, timing, publication }, body);
}

/** Shared by calls in one HTTP response; socket completion alone is not a remote receipt. */
export function inboundPublication(): OutputPublication | undefined {
  return store.getStore()?.publication;
}

/** The request id of the HTTP request this call is being served on, if it had one. */
export function inboundRequestId(): string | null {
  return store.getStore()?.requestId ?? null;
}

/**
 * The join key inside a raw header value.
 *
 * Only the part before the `/` matches the page: the suffix is per-hop and differs between
 * the header and the message model.
 */
export function requestIdFromHeader(value: string | string[] | undefined): string | null {
  // Identity evidence is not a "pick one" field. If a proxy/runtime ever gives us duplicate
  // request-id values, choosing the first would turn an ambiguous request into authority for
  // one conversation. Fail closed instead. (A one-element array is only a representation
  // detail and is still unambiguous.)
  if (Array.isArray(value) && value.length !== 1) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const id = raw.split('/')[0]!.trim();
  return id.length > 0 && id.length <= 100 && /^[a-z0-9_-]+$/i.test(id) ? id : null;
}
