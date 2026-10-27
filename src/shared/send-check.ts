/**
 * #1794: the send check's address, as Settings and the main process both accept it. Plain http on
 * this computer with a port (127.0.0.1, localhost or [::1]), so a send check can never leave the
 * machine; the normalized address, or null for anything else.
 */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function sendCheckUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'http:' || !LOCAL_HOSTS.has(url.hostname) || !url.port || url.username || url.password) return null;
  return url.href;
}
