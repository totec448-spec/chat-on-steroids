/**
 * Shared origin normalization and URL composition for the parallel Gemini MCP bridge.
 * Kept runtime-free so main, renderer, and config schemas share identical rules.
 */

/** Normalizes a user-supplied or detected public HTTPS origin (`https://host[:port]`). Returns `''` when invalid. */
export function normalizeHttpsOrigin(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/[\s@\\]/.test(trimmed)) return '';
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return '';
    if (!parsed.hostname || parsed.hostname.startsWith('.') || parsed.hostname.endsWith('.')) return '';
    // Require a real DNS name (contains a dot) or bracketed IPv6, refusing bare local words as remote public origins.
    if (!parsed.hostname.includes('.') && !parsed.hostname.startsWith('[')) return '';
    return parsed.origin.toLowerCase();
  } catch {
    return '';
  }
}

/** Exact lowercase `Host` header candidates derived from an already-validated origin URL. */
export function hostsForOrigin(origin: string): string[] {
  if (!origin) return [];
  try {
    const parsed = new URL(origin);
    const out = new Set<string>();
    if (parsed.host) out.add(parsed.host.toLowerCase());
    if (parsed.hostname) out.add(parsed.hostname.toLowerCase());
    return [...out];
  } catch {
    return [];
  }
}

/** Combines a bridge origin (`https://node.ts.net`) with a loopback surface URL's secret `/mcp/<surface>/<token>` path. */
export function joinOriginWithSurfacePath(origin: string, surfaceLocalUrl: string): string {
  try {
    const base = new URL(origin);
    const local = new URL(surfaceLocalUrl);
    base.pathname = local.pathname;
    base.search = '';
    base.hash = '';
    return base.toString();
  } catch {
    return '';
  }
}
