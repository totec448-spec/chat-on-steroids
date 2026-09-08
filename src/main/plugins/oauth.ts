import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  auth, type OAuthClientProvider, type OAuthDiscoveryState,
  type StoredOAuthClientInformation, type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { getSecret, setSecret, clearSecret } from '../secrets.js';

export class PluginNeedsAuth extends Error {
  constructor() { super('Sign in to connect this plugin.'); }
}
export class PluginOAuthSetupError extends Error {
  constructor() { super('This server does not offer dynamic OAuth client registration. It needs a registered client or hosted client metadata before it can connect.'); }
}
type Credentials = {
  endpoint: string;
  redirectUri?: string;
  client?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
};
type OpenAuthorization = (url: URL) => Promise<void>;
const secretKey = (id: string): `plugin:${string}` => `plugin:${id}:oauth:state`;
export const clearPluginOAuth = (id: string): Promise<void> => clearSecret(secretKey(id));

/** One installation + exact endpoint owns its encrypted OAuth credentials.
 * SDK owns discovery, issuer/resource validation, DCR, PKCE and token exchange.
 * Browser/callback authority exists only inside an explicit, cancellable signIn.
 */
export class PluginOAuth implements OAuthClientProvider {
  private data: Credentials;
  private verifier?: string;
  private discovery?: OAuthDiscoveryState;
  private interactive?: { state: string; redirectUri: string; open: OpenAuthorization };
  private controller = new AbortController();
  private unlink: () => void;
  readonly fetch: typeof fetch;
  private constructor(
    private id: string, private endpoint: URL, signal: AbortSignal,
    fetcher: typeof fetch, private secret: (value: string) => void,
  ) {
    this.data = { endpoint: endpoint.href };
    const abort = () => this.dispose();
    signal.addEventListener('abort', abort, { once: true });
    this.unlink = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) this.dispose();
    this.fetch = async (input, init) => {
      this.check();
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.username || url.password || url.hash || (url.protocol !== 'https:' &&
        !(this.endpoint.protocol === 'http:' && url.origin === this.endpoint.origin))) {
        throw new Error('OAuth requires secure endpoints.');
      }
      return fetcher(input, { ...init, redirect: 'error', signal: AbortSignal.any([
        this.controller.signal, AbortSignal.timeout(20000), ...(init?.signal ? [init.signal] : []),
      ]) });
    };
  }
  static async load(id: string, endpoint: URL, signal: AbortSignal, fetcher: typeof fetch, secret: (value: string) => void): Promise<PluginOAuth> {
    const provider = new PluginOAuth(id, endpoint, signal, fetcher, secret);
    try {
      const raw = await getSecret(secretKey(id));
      provider.check();
      if (raw && raw.length <= 131072) {
        const value = JSON.parse(raw) as Credentials;
        if (value?.endpoint === endpoint.href) {
          // Stored credentials are never inferred across an endpoint replacement.
          // The SDK validates their issuer stamps again before refreshing/exchanging.
          provider.data = {
            endpoint: endpoint.href,
            ...(typeof value.redirectUri === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/.test(value.redirectUri) ? { redirectUri: value.redirectUri } : {}),
            ...(value.client && typeof value.client.client_id === 'string' ? { client: value.client } : {}),
            ...(value.tokens && typeof value.tokens.access_token === 'string' && typeof value.tokens.token_type === 'string' ? { tokens: value.tokens } : {}),
          };
          provider.rememberSecrets();
        }
      }
      return provider;
    } catch (error) { provider.dispose(); throw error; }
  }
  private check(): void { this.controller.signal.throwIfAborted(); }
  private rememberSecrets(): void {
    for (const value of [this.data.tokens?.access_token, this.data.tokens?.refresh_token, this.data.client?.client_id, this.data.client?.client_secret, this.verifier]) {
      if (typeof value === 'string' && value) this.secret(value);
    }
  }
  private async save(): Promise<void> {
    this.check(); this.rememberSecrets();
    const value = JSON.stringify(this.data);
    if (value.length > 131072) throw new Error('OAuth credential response is too large.');
    await setSecret(secretKey(this.id), value);
    this.check();
  }
  get redirectUrl(): string { return this.interactive?.redirectUri ?? this.data.redirectUri ?? 'http://127.0.0.1:1/oauth/callback'; }
  get clientMetadata() {
    return { client_name: 'Chat On Steroids', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  }
  state(): string { this.check(); if (!this.interactive) throw new PluginNeedsAuth(); return this.interactive.state; }
  clientInformation(context?: { issuer: string }): StoredOAuthClientInformation | undefined {
    this.check(); const value = this.data.client;
    const usable = context && value?.issuer !== context.issuer ? undefined : value;
    // SDK invalid_client recovery drops credentials before retrying DCR. A
    // reconnect may refresh existing credentials, never register a fresh client.
    if (!usable && !this.interactive) throw new PluginNeedsAuth();
    return usable;
  }
  async saveClientInformation(value: StoredOAuthClientInformation): Promise<void> { this.check(); this.data.client = value; await this.save(); }
  tokens(context?: { issuer: string }): StoredOAuthTokens | undefined {
    this.check(); const value = this.data.tokens;
    return context && value?.issuer !== context.issuer ? undefined : value;
  }
  async saveTokens(value: StoredOAuthTokens): Promise<void> { this.check(); this.data.tokens = value; await this.save(); }
  async redirectToAuthorization(url: URL): Promise<void> {
    this.check();
    const flow = this.interactive;
    if (!flow) throw new PluginNeedsAuth();
    const expected = this.discovery?.authorizationServerMetadata?.authorization_endpoint;
    const base = expected ? new URL(expected) : undefined;
    if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      !base || url.origin !== base.origin || url.pathname !== base.pathname ||
      url.searchParams.get('state') !== flow.state || url.searchParams.get('redirect_uri') !== flow.redirectUri ||
      url.searchParams.get('code_challenge_method') !== 'S256' || !url.searchParams.get('code_challenge')) {
      throw new Error('The OAuth authorization URL is invalid.');
    }
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new Error('Plugin sign-in cancelled.'));
      this.controller.signal.addEventListener('abort', abort, { once: true });
    });
    try { await Promise.race([flow.open(url), cancelled]); }
    finally { this.controller.signal.removeEventListener('abort', abort); }
    this.check();
  }
  saveCodeVerifier(value: string): void { this.check(); if (!this.interactive) throw new PluginNeedsAuth(); this.verifier = value; this.secret(value); }
  codeVerifier(): string { this.check(); if (!this.verifier) throw new PluginNeedsAuth(); return this.verifier; }
  saveDiscoveryState(value: OAuthDiscoveryState): void {
    this.check();
    if (this.interactive && !value.authorizationServerMetadata?.registration_endpoint) throw new PluginOAuthSetupError();
    this.discovery = value;
  }
  discoveryState(): OAuthDiscoveryState | undefined { this.check(); return this.discovery; }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    this.check();
    if (scope === 'all' || scope === 'client') delete this.data.client;
    if (scope === 'all' || scope === 'tokens') delete this.data.tokens;
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined;
    if (scope === 'all' || scope === 'discovery') this.discovery = undefined;
    await this.save();
  }
  async signIn(open: OpenAuthorization, timeoutMs = 180000): Promise<void> {
    this.check();
    const state = randomBytes(32).toString('hex'); this.secret(state);
    const server = createServer({ maxHeaderSize: 8192 });
    let settle!: (value: URLSearchParams) => void, fail!: (error: Error) => void;
    const callback = new Promise<URLSearchParams>((resolve, reject) => { settle = resolve; fail = reject; });
    // Callback can fail while discovery is pending; attach its rejection now.
    void callback.catch(() => undefined);
    const cancel = () => { fail(new Error('Plugin sign-in cancelled.')); server.closeAllConnections(); server.close(); };
    this.controller.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => this.dispose(), timeoutMs); timer.unref();
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      this.check();
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Could not start the sign-in callback.');
      const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
      server.on('request', (request, response) => {
        response.setHeader('Content-Type', 'text/plain; charset=utf-8'); response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
        let url: URL;
        try { url = new URL(request.url ?? '/', redirectUri); }
        catch { response.writeHead(400).end('Invalid sign-in callback.'); return; }
        const received = url.searchParams.get('state') ?? '';
        const valid = request.method === 'GET' && request.headers.host === `127.0.0.1:${address.port}` &&
          url.origin === new URL(redirectUri).origin && url.pathname === '/oauth/callback' && (request.url?.length ?? 0) <= 8192 &&
          ['state', 'code', 'iss', 'error'].every(key => url.searchParams.getAll(key).length <= 1) &&
          /^[a-f0-9]{64}$/.test(received) && timingSafeEqual(Buffer.from(received), Buffer.from(state));
        if (!valid) { response.writeHead(400).end('Invalid sign-in callback.'); return; }
        if (url.searchParams.has('error') || !url.searchParams.get('code')) {
          response.writeHead(400).end('Sign-in was not completed. Return to Chat On Steroids.');
          fail(new Error('Plugin sign-in was not completed.')); return;
        }
        response.end('Authorization received. Return to Chat On Steroids.'); server.close(); settle(url.searchParams);
      });
      this.interactive = { state, redirectUri, open };
      // A new ephemeral callback cannot reuse a DCR client's old exact redirect URI.
      this.data.redirectUri = redirectUri; delete this.data.client;
      this.discovery = undefined; this.verifier = undefined;
      await this.save();
      const result = await auth(this, { serverUrl: this.endpoint, fetchFn: this.fetch, forceReauthorization: true });
      if (result === 'REDIRECT') {
        const params = await callback;
        await auth(this, { serverUrl: this.endpoint, fetchFn: this.fetch, authorizationCode: params.get('code')!, iss: params.get('iss') ?? undefined });
      }
      this.check();
      if (!this.data.tokens) throw new Error('Sign-in returned no credentials.');
    } finally {
      clearTimeout(timer); this.controller.signal.removeEventListener('abort', cancel);
      this.interactive = undefined; this.verifier = undefined; this.discovery = undefined;
      server.closeAllConnections(); server.close();
    }
  }
  dispose(): void { this.controller.abort(); this.unlink?.(); this.verifier = undefined; this.interactive = undefined; }
}
