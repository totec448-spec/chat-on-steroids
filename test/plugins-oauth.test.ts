import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { auth, IssuerMismatchError } from '@modelcontextprotocol/client';
const stored = vi.hoisted(() => new Map<string, string>());
vi.mock('../src/main/secrets.js', () => ({
  getSecret: vi.fn(async (key: string) => stored.get(key) ?? null),
  setSecret: vi.fn(async (key: string, value: string) => { stored.set(key, value); }),
  clearSecret: vi.fn(async (key: string) => { stored.delete(key); }),
}));
import { PluginOAuth, PluginNeedsAuth, PluginOAuthSetupError, clearPluginOAuth } from '../src/main/plugins/oauth.js';

const endpoint = new URL('https://tools.example/mcp');
const issuer = 'https://accounts.example';
const providers: PluginOAuth[] = [];
afterEach(() => { providers.splice(0).forEach(provider => provider.dispose()); stored.clear(); vi.restoreAllMocks(); });
function authority() {
  const requests: Array<{ url: string; body: string }> = [];
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  let registration = true, challenge = '', rejectRefresh = false;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input); requests.push({ url, body: String(init?.body ?? '') });
    if (url.includes('/.well-known/oauth-protected-resource')) return json({ resource: endpoint.href, authorization_servers: [issuer], scopes_supported: ['read'] });
    if (url.includes('/.well-known/')) return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, ...(registration ? { registration_endpoint: `${issuer}/register` } : {}), response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true });
    if (url === `${issuer}/register`) return json({ ...JSON.parse(String(init!.body)), client_id: 'client-private-id' });
    if (url === `${issuer}/token`) {
      const params = new URLSearchParams(String(init!.body));
      if (params.get('grant_type') === 'authorization_code') {
        expect(params.get('code')).toBe('authorization-private-code');
        expect(createHash('sha256').update(params.get('code_verifier')!).digest('base64url')).toBe(challenge);
      } else {
        expect(params.get('grant_type')).toBe('refresh_token'); expect(params.get('refresh_token')).toBe('refresh-private-token');
        if (rejectRefresh) return new Response(JSON.stringify({ error: 'invalid_client' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      return json({ access_token: 'access-private-token', refresh_token: 'refresh-private-token', token_type: 'Bearer', expires_in: 3600, scope: 'read' });
    }
    throw new Error(`Unexpected fixture route ${url}`);
  });
  const browser = async (url: URL, mutate?: (params: URLSearchParams) => void) => {
    challenge = url.searchParams.get('code_challenge')!;
    expect(url.protocol).toBe('https:'); expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', url.searchParams.get('state')!);
    callback.searchParams.set('code', 'authorization-private-code'); callback.searchParams.set('iss', issuer);
    mutate?.(callback.searchParams);
    return fetch(callback);
  };
  return { fetcher, requests, browser, disableRegistration: () => { registration = false; }, rejectRefresh: () => { rejectRefresh = true; } };
}
async function load(fetcher: typeof fetch, id = 'one', target = endpoint, signal = new AbortController().signal, redact = vi.fn()) {
  const provider = await PluginOAuth.load(id, target, signal, fetcher, redact); providers.push(provider); return provider;
}

it('performs SDK DCR + PKCE with a real loopback callback, retains endpoint/issuer-bound credentials, and refreshes after restart', async () => {
  const server = authority(), redacted = vi.fn();
  const provider = await load(server.fetcher, 'one', endpoint, undefined, redacted);
  await provider.signIn(async url => { expect((await server.browser(url)).status).toBe(200); });
  expect(provider.tokens()?.access_token).toBe('access-private-token');
  const raw = stored.get('plugin:one:oauth:state')!;
  expect(raw).toContain(endpoint.href); expect(raw).toContain('refresh-private-token');
  expect(raw).not.toMatch(/code_verifier|authorization-private-code|"state"/);
  expect(redacted).toHaveBeenCalledWith('access-private-token'); expect(redacted).toHaveBeenCalledWith('client-private-id');
  provider.dispose();
  const restored = await load(server.fetcher);
  expect(await auth(restored, { serverUrl: endpoint, fetchFn: restored.fetch })).toBe('AUTHORIZED');
  expect(server.requests.filter(request => request.url.endsWith('/register'))).toHaveLength(1);
  expect(server.requests.filter(request => request.url.endsWith('/token'))).toHaveLength(2);
  expect(restored.tokens({ issuer: 'https://another.example' })).toBeUndefined();
  expect((await load(server.fetcher, 'two')).tokens()).toBeUndefined();
  expect((await load(server.fetcher, 'one', new URL('https://tools.example/other'))).tokens()).toBeUndefined();
  await clearPluginOAuth('one'); expect(stored.has('plugin:one:oauth:state')).toBe(false);
});

it('rejects wrong/duplicate/Unicode state without killing the callback and accepts the exact state afterward', async () => {
  const server = authority(), provider = await load(server.fetcher);
  await provider.signIn(async url => {
    for (const mutate of [
      (params: URLSearchParams) => params.set('state', 'wrong'),
      (params: URLSearchParams) => params.set('state', 'ä'.repeat(64)),
      (params: URLSearchParams) => params.append('state', params.get('state')!),
    ]) expect((await server.browser(url, mutate)).status).toBe(400);
    expect((await server.browser(url)).status).toBe(200);
  });
  expect(server.requests.filter(request => request.url.endsWith('/token'))).toHaveLength(1);
});

it('rejects callback issuer mismatch before exchanging its code', async () => {
  const server = authority(), provider = await load(server.fetcher);
  await expect(provider.signIn(async url => { await server.browser(url, params => params.set('iss', 'https://wrong.example')); })).rejects.toBeInstanceOf(IssuerMismatchError);
  expect(server.requests.some(request => request.url.endsWith('/token'))).toBe(false);
  expect(provider.tokens()).toBeUndefined();
});

it('never opens the browser from a noninteractive provider and fails missing DCR with an actionable setup error', async () => {
  const server = authority(), provider = await load(server.fetcher);
  await expect(provider.redirectToAuthorization(new URL(`${issuer}/authorize`))).rejects.toBeInstanceOf(PluginNeedsAuth);
  server.disableRegistration();
  await expect(provider.signIn(vi.fn())).rejects.toBeInstanceOf(PluginOAuthSetupError);
  expect(server.requests.some(request => request.url.endsWith('/register'))).toBe(false);
});

it('invalid_client refresh recovery cannot register another client during a silent reconnect', async () => {
  const server = authority(), provider = await load(server.fetcher);
  await provider.signIn(async url => { await server.browser(url); }); provider.dispose();
  const restored = await load(server.fetcher); server.rejectRefresh();
  await expect(auth(restored, { serverUrl: endpoint, fetchFn: restored.fetch })).rejects.toBeInstanceOf(PluginNeedsAuth);
  expect(server.requests.filter(request => request.url.endsWith('/register'))).toHaveLength(1);
});

it.each(['cancel', 'timeout'] as const)('retires the callback and pending browser wait on %s without storing tokens', async action => {
  const server = authority(), controller = new AbortController(), provider = await load(server.fetcher, 'one', endpoint, controller.signal);
  let opened!: (value: URL) => void;
  const browserOpened = new Promise<URL>(resolve => { opened = resolve; });
  const operation = provider.signIn(async url => { opened(url); await new Promise<void>(() => undefined); }, action === 'timeout' ? 70 : 5000);
  const rejected = expect(operation).rejects.toThrow('cancelled');
  const url = await browserOpened;
  if (action === 'cancel') controller.abort();
  await rejected;
  await expect(fetch(url.searchParams.get('redirect_uri')!)).rejects.toThrow();
  expect(stored.get('plugin:one:oauth:state')).not.toContain('access-private-token');
});
