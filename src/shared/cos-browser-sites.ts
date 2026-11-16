/**
 * The sites that open inside the CoS browser rather than the system browser: ChatGPT, the
 * OpenAI platform pages Setup sends people to, and the sign-in providers both use, so the
 * session they establish is this browser's own. Shared so the app and its Setup page draw the same line.
 */
const IN_BROWSER_HOSTS = new Set([
  'chatgpt.com', 'platform.openai.com', 'auth.openai.com', 'auth0.openai.com', 'accounts.google.com',
  'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com', 'idmsa.apple.com'
]);

export function opensInCosBrowser(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && IN_BROWSER_HOSTS.has(parsed.hostname);
  } catch { return false; }
}
