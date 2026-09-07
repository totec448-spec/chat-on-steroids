/**
 * Reads what tunnel-client itself knows about the connection.
 *
 * /readyz is a *local* liveness gate and stays green through an internet outage, so it
 * cannot answer "is ChatGPT actually able to reach this PC". Two other local endpoints
 * can:
 *
 *   /metrics     Prometheus text, including the unix timestamp of the last poll of the
 *                control plane that actually succeeded. A fresh timestamp is proof of a
 *                live round trip to OpenAI within the last poll cycle.
 *   /api/status  The client's own view: per-channel probe status (can it reach our MCP
 *                server?) and the last error it hit fetching tunnel metadata.
 *
 * Everything here is loopback-only, sends nothing anywhere, and never throws: a missing
 * or unparsable field is reported as null so the caller can say "unknown" rather than
 * guess.
 */

/** Poll timeout is 30s, so successes arrive at most that far apart; allow three. */
export const POLL_FRESH_MS = 95_000;

export interface PollHealth {
  /** Epoch ms of the last successful control-plane poll, or null if it never succeeded. */
  lastSuccessMs: number | null;
  /** Poll cycles started, and how many of them failed, since the client started. */
  polls: number | null;
  errors: number | null;
}

export interface ClientStatus {
  version: string | null;
  /** Whether tunnel-client can reach our local MCP server on the "main" channel. */
  probe: string | null;
  /** Last error it saw talking to the control plane, verbatim. May be stale. */
  metadataError: string | null;
  uptimeSeconds: number | null;
  /** Host and mode of the path to OpenAI, e.g. "api.openai.com:443 · direct". */
  route: string | null;
}

/**
 * Sums every sample of a Prometheus metric, ignoring labels.
 *
 * The client emits one sample per label set — poll errors, for instance, are split by
 * `error_kind` — so a name-only lookup has to add them up or it silently reports the
 * first bucket as if it were the total. Gauges only ever carry one sample here.
 */
export function readMetric(text: string, name: string): number | null {
  let total: number | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const trimmed = line.trim();
    if (!trimmed.startsWith(name)) continue;
    // Must be the whole name: `commands_poll_cycles` must not match `..._total`.
    const rest = trimmed.slice(name.length);
    if (rest !== '' && rest[0] !== ' ' && rest[0] !== '{') continue;
    const sample = rest.replace(/^\{[^}]*\}/, '').trim().split(/\s+/)[0];
    if (!sample) continue;
    const value = Number(sample);
    if (!Number.isFinite(value)) continue;
    total = (total ?? 0) + value;
  }
  return total;
}

async function fetchText(url: string, timeoutMs: number): Promise<string | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: abort.signal, headers: { accept: '*/*' } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function parsePollHealth(metrics: string): PollHealth {
  const seconds = readMetric(metrics, 'commands_poll_last_successful_timestamp_seconds');
  return {
    lastSuccessMs: seconds !== null && seconds > 0 ? Math.round(seconds * 1000) : null,
    polls: readMetric(metrics, 'commands_poll_cycles_total'),
    errors: readMetric(metrics, 'commands_poll_errors_total')
  };
}

export async function readPollHealth(base: string, timeoutMs = 3000): Promise<PollHealth | null> {
  const text = await fetchText(`${base}/metrics`, timeoutMs);
  // A readable endpoint without the poll timestamp is still unknown, not the
  // explicit zero that means a healthy client is awaiting its first poll.
  return text === null || readMetric(text, 'commands_poll_last_successful_timestamp_seconds') === null ? null : parsePollHealth(text);
}

export function parseClientStatus(raw: unknown): ClientStatus {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const channels = Array.isArray(obj['channels']) ? obj['channels'] : [];
  const main = channels.find(
    (c) => typeof c === 'object' && c !== null && (c as Record<string, unknown>)['name'] === 'main'
  ) as Record<string, unknown> | undefined;
  const asString = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

  // The route tells you whether traffic goes straight out or through a proxy —
  // the first thing worth knowing when a corporate network breaks the tunnel.
  const route = (obj['control_plane_route'] ?? {}) as Record<string, unknown>;
  const target = asString(route['target']);
  const mode = asString(route['route_mode']);
  const proxy = asString(route['proxy_source']);
  const routeText = target
    ? `${target} · ${proxy && proxy !== 'none' ? `via ${proxy}` : (mode ?? 'direct')}`
    : null;

  return {
    version: asString(obj['version']),
    probe: asString(main?.['probe_status']),
    metadataError: asString(obj['tunnel_metadata_error']),
    uptimeSeconds: typeof obj['uptime_seconds'] === 'number' ? obj['uptime_seconds'] : null,
    route: routeText
  };
}

export async function readClientStatus(base: string, timeoutMs = 3000): Promise<ClientStatus | null> {
  const text = await fetchText(`${base}/api/status`, timeoutMs);
  if (text === null) return null;
  try {
    return parseClientStatus(JSON.parse(text));
  } catch {
    return null;
  }
}

/** "just now", "12s ago", "4m ago" — for a timestamp that may be null or in the future. */
export function ago(atMs: number | null, nowMs = Date.now()): string {
  if (atMs === null) return 'never';
  const seconds = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (seconds < 3) return 'just now';
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
