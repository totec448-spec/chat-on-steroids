/**
 * The proxy for a program that only reads proxies from its environment (#1255).
 *
 * tunnel-client is a Go program: it honours HTTPS_PROXY and NO_PROXY and nothing else. A computer
 * whose way out is the system's proxy setting (or ALL_PROXY, which Go ignores) could therefore not
 * connect the tunnel unless the person set HTTPS_PROXY before starting the app. This derives that
 * variable from what is already configured. A proxy the person set as HTTPS_PROXY always wins.
 */

/** What Go's proxy support accepts, by the kind the browser engine names. */
const SCHEME_BY_KIND: Record<string, string> = { PROXY: 'http', HTTPS: 'https', SOCKS5: 'socks5' };
const HOST_AND_PORT = /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):(\d{1,5})$/i;
const USABLE_PROXY_URL = /^(?:https?|socks5h?):\/\/\S+$/i;
const LOCAL_STAYS_DIRECT = 'localhost,127.0.0.1,::1';

/**
 * The browser engine's answer for one address ("DIRECT", "PROXY host:port; DIRECT",
 * "SOCKS5 host:port") as a proxy address. Entries the tunnel program cannot use are skipped;
 * DIRECT ends the list, as it does for the browser.
 */
export function proxyUrlFromResolution(resolution: string): string | null {
  for (const entry of resolution.split(';')) {
    const [kind = '', address = '', ...more] = entry.trim().split(/\s+/);
    if (kind.toUpperCase() === 'DIRECT') return null;
    const scheme = SCHEME_BY_KIND[kind.toUpperCase()];
    const port = more.length ? null : HOST_AND_PORT.exec(address)?.[1];
    if (!scheme || !port || Number(port) > 65535) continue;
    return `${scheme}://${address}`;
  }
  return null;
}

/** The variables to add for the tunnel program; empty when there is nothing to add. */
export function proxyEnvironment(resolution: string, env: Record<string, string | undefined>): Record<string, string> {
  // Windows spells environment names any way it likes.
  const value = (name: string): string =>
    Object.entries(env).find(([key, entry]) => key.toUpperCase() === name && entry?.trim())?.[1]?.trim() ?? '';
  if (value('HTTPS_PROXY')) return {};
  const all = value('ALL_PROXY');
  // ALL_PROXY is the person's own setting: use it when the program can, and never override it.
  const url = all ? (USABLE_PROXY_URL.test(all) ? all : null) : proxyUrlFromResolution(resolution);
  if (!url) return {};
  return { HTTPS_PROXY: url, ...(value('NO_PROXY') ? {} : { NO_PROXY: LOCAL_STAYS_DIRECT }) };
}

/** A proxy address for the log: without the name and password it may carry. */
export function proxyForLog(url: string): string {
  return url.replace(/\/\/[^/@]*@/, '//');
}
