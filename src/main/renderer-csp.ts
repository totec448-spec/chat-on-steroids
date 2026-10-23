/**
 * App-owned renderer policy. Recorded static first-party ChatGPT illustrations need
 * images.openai.com; scripts, connections and everything else remain local-only.
 * Requests to that host must also pass the static-image allowlist below.
 * CSP independently rechecks redirected URLs: its img-src excludes any other
 * remote origin, http://, and blob:. Existing local data: SVG support stays.
 */
export const RENDERER_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https://images.openai.com; font-src 'self'; connect-src 'self'; " +
  "form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

/** Only the static-rsc URL shape actually used by first-party reply images. */
export function approvedChatGptImageRequest(url: string, resourceType = 'image', method = 'GET'): boolean {
  if (url.length > 2048 || resourceType !== 'image' || method !== 'GET') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'images.openai.com' &&
      parsed.username === '' && parsed.password === '' && (parsed.port === '' || parsed.port === '443') &&
      /^\/static-rsc-[a-z0-9-]+\/[\w-]+$/.test(parsed.pathname) &&
      (parsed.search === '' || parsed.search === '?purpose=inline') && !parsed.hash;
  } catch { return false; }
}
