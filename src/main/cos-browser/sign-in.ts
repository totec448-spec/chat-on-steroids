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

/** Google login leaves the embedded browser; it never changes its browser identity. */
export function isGoogleSignIn(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'accounts.google.com';
  } catch { return false; }
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
