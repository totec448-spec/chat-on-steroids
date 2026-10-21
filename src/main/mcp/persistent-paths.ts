/**
 * Connector URLs that survive restarts, for installations that publish the endpoint through a
 * tunnel of their own (#924, #1401).
 *
 * Every start normally gives each surface a new random path token, so a URL that leaked stops
 * working at the next restart. A named Cloudflare tunnel keeps its hostname, but ChatGPT keeps the
 * URL it was given: after a restart its tool list request reached nothing, and the app's tools
 * vanished from ChatGPT while the connector still showed. With `mcp.persistentUrls` on, each
 * surface keeps its token, stored only in the OS-backed secret store. Without that store the
 * tokens keep rotating; turning the option off forgets them, so a leaked URL can be replaced.
 *
 * The local port is kept the same way (#1550): such a tunnel points at one fixed local address, and
 * a new random port on every start made the kept URL go dead anyway. The port is reused when free.
 */
import { clearSecret, getSecret, setSecret } from '../secrets.js';
import { SURFACE_IDS, type SurfaceId } from './surfaces.js';

export type SurfaceTokens = Partial<Record<SurfaceId, string>>;

/** The shape `startMcpServer` mints: 32 random bytes, base64url. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const key = (id: SurfaceId) => `mcp:path:${id}` as const;
// Beside the surface tokens: no surface is named "port".
const PORT_KEY = 'mcp:path:port' as const;

/** The token at the end of one surface URL, or null. */
export function surfaceTokenOf(url: string, id: SurfaceId): string | null {
  try {
    const match = new RegExp(`^/mcp/${id}/([A-Za-z0-9_-]{43})$`).exec(new URL(url).pathname);
    return match ? match[1]! : null;
  } catch { return null; }
}

export async function loadSurfaceTokens(): Promise<SurfaceTokens> {
  const tokens: SurfaceTokens = {};
  for (const id of SURFACE_IDS) {
    const value = await getSecret(key(id)).catch(() => null);
    if (value && TOKEN.test(value)) tokens[id] = value;
  }
  return tokens;
}

/** The local port the last kept endpoint listened on, or null. */
export async function loadKeptPort(): Promise<number | null> {
  const value = await getSecret(PORT_KEY).catch(() => null);
  const port = value && /^\d{1,5}$/.test(value) ? Number(value) : 0;
  return port >= 1024 && port <= 65535 ? port : null;
}

/** Stores the running endpoint's tokens and port; false when the secret store refused (they keep rotating). */
export async function rememberSurfaceTokens(urls: Record<SurfaceId, string>): Promise<boolean> {
  try {
    for (const id of SURFACE_IDS) {
      const token = surfaceTokenOf(urls[id], id);
      if (token) await setSecret(key(id), token);
    }
    const port = (() => { try { return new URL(urls.core).port; } catch { return ''; } })();
    if (port) await setSecret(PORT_KEY, port);
    return true;
  } catch {
    return false;
  }
}

export async function forgetSurfaceTokens(): Promise<void> {
  for (const id of SURFACE_IDS) await clearSecret(key(id)).catch(() => undefined);
  await clearSecret(PORT_KEY).catch(() => undefined);
}
