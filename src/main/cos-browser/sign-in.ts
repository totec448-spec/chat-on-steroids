/**
 * Whether the CoS browser holds a ChatGPT sign-in, for Setup's first step.
 *
 * Kept apart from the host so the app's state can read it without loading Electron's browser
 * machinery. The host writes it from its own session's cookies; null while the browser is off.
 */
let signedIn: boolean | null = null;
const listeners = new Set<() => void>();

/** ChatGPT's session cookie, which it splits into numbered chunks when it grows. */
export const CHATGPT_SESSION_COOKIE = /^__Secure-next-auth\.session-token(?:\.\d+)?$/;

/**
 * Google refuses its sign-in to a browser it takes for an embedded one ("This browser or app may
 * not be secure"), even with the embedder's name taken out of the user agent: Chromium still
 * reports its client hints. Measured 2026-10-03 in this browser: with a Firefox agent, which sends
 * no client hints, the same account signs in. Only Google's own sign-in pages see it; ChatGPT and
 * everything else keep the Chromium agent.
 */
const SIGN_IN_HOSTS = /^(?:auth\.openai\.com|accounts\.google\.[a-z]{2,3}(?:\.[a-z]{2})?|accounts\.youtube\.com)$/i;
const FIREFOX_AGENT: Record<string, string> = {
  win32: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:139.0) Gecko/20100101 Firefox/139.0',
  darwin: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:139.0) Gecko/20100101 Firefox/139.0',
  linux: 'Mozilla/5.0 (X11; Linux x86_64; rv:139.0) Gecko/20100101 Firefox/139.0'
};

/** Whether `host` is one of the sign-in pages that see the Firefox agent. */
export function isSignInHost(host: string): boolean {
  return SIGN_IN_HOSTS.test(host);
}

/**
 * The user agent a tab presents for `url`: Firefox on the sign-in pages, else `chromium`. OpenAI's
 * own sign-in page is one of them, so "Continue with Google" leaves it already as Firefox.
 */
export function signInAgent(url: string, chromium: string, platform: string = process.platform): string {
  let host = '';
  try { host = new URL(url).hostname; } catch { return chromium; }
  return isSignInHost(host) ? FIREFOX_AGENT[platform] ?? FIREFOX_AGENT.linux! : chromium;
}

export function cosBrowserSignedIn(): boolean | null {
  return signedIn;
}

export function setCosBrowserSignedIn(next: boolean | null): void {
  if (next === signedIn) return;
  signedIn = next;
  for (const listener of listeners) listener();
}

export function onCosBrowserSignInChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
