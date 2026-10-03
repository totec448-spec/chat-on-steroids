/**
 * Chrome extension match patterns, as `chrome.tabs.query({ url })` accepts them.
 *
 * Only the forms a URL query can use: `<all_urls>`, a scheme of `*`, `http`, `https`, `file` or
 * `ftp`, a host of `*`, `*.domain` or an exact host, and a path where `*` matches any run of
 * characters. A malformed pattern matches nothing, as Chrome rejects it rather than guessing.
 */
const SCHEMES = new Set(['http', 'https', 'file', 'ftp']);

function compile(pattern: string): ((url: URL) => boolean) | null {
  if (pattern === '<all_urls>') return url => SCHEMES.has(url.protocol.slice(0, -1));
  const parts = /^(\*|[a-z]+):\/\/(\*|\*\.[^/*]+|[^/*]+)?(\/.*)$/.exec(pattern);
  if (!parts) return null;
  const [, scheme, host = '', path] = parts;
  if (scheme !== '*' && !SCHEMES.has(scheme!)) return null;
  if (scheme !== 'file' && !host) return null;
  const glob = new RegExp(`^${path!.split('*').map(text => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return url => {
    const actual = url.protocol.slice(0, -1);
    if (scheme === '*' ? actual !== 'http' && actual !== 'https' : actual !== scheme) return false;
    if (host !== '*') {
      // A pattern without a port matches every port; one with a port matches only that port.
      const actualHost = host.includes(':') ? url.host : url.hostname;
      if (host.startsWith('*.')) {
        const domain = host.slice(2);
        if (actualHost !== domain && !actualHost.endsWith(`.${domain}`)) return false;
      } else if (actualHost !== host) return false;
    }
    return glob.test(url.pathname + url.search);
  };
}

/** Whether `url` matches any of `patterns`; an unparseable URL matches none. */
export function matchesPatterns(url: string, patterns: string | readonly string[]): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  return [patterns].flat().some(pattern => compile(pattern)?.(parsed) === true);
}
