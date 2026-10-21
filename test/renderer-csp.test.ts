import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { approvedChatGptImageRequest, RENDERER_CONTENT_SECURITY_POLICY } from '../src/main/renderer-csp.js';

describe('isolated static ChatGPT illustration policy', () => {
  it('keeps a single default-session onBeforeRequest registration so the URL gate cannot be replaced', () => {
    const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    expect(main.match(/\.onBeforeRequest\s*\(/g)).toHaveLength(1);
    expect(main).toContain("onBeforeRequest({ urls: ['https://images.openai.com/*'] }");
  });
  it('allows only the first-party image origin, not remote scripts, frames, network calls or wildcard hosts', () => {
    const directives = new Map(RENDERER_CONTENT_SECURITY_POLICY.split(';').map(part => {
      const [key, ...values] = part.trim().split(/\s+/);
      return [key!, values];
    }));
    expect(directives.get('default-src')).toEqual(["'none'"]);
    expect(directives.get('img-src')).toEqual(["'self'", 'data:', 'https://images.openai.com']);
    expect(directives.get('script-src')).toEqual(["'self'"]);
    expect(directives.get('connect-src')).toEqual(["'self'"]);
    expect(directives.get('font-src')).toEqual(["'self'"]);
    expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
    expect(RENDERER_CONTENT_SECURITY_POLICY).not.toMatch(/\*\.openai|https:\s*\*/);
  });
  it('admits only static HTTPS image GETs with a fixed optional purpose query', () => {
    const valid = 'https://images.openai.com/static-rsc-4/Example01234';
    expect(approvedChatGptImageRequest(valid)).toBe(true);
    expect(approvedChatGptImageRequest(`${valid}?purpose=inline`)).toBe(true);
    for (const url of [
      'http://images.openai.com/static-rsc-4/Example01234',
      'https://other.openai.com/static-rsc-4/Example01234',
      'https://images.openai.com.evil.invalid/static-rsc-4/Example01234',
      'https://images.openai.com:444/static-rsc-4/Example01234',
      'https://images.openai.com@evil.invalid/static-rsc-4/Example01234',
      'https://images.openai.com/redirect?to=https://evil.invalid',
      `${valid}?purpose=download`, `${valid}?purpose=inline&track=1`,
      `${valid}?PURPOSE=inline`, `${valid}#fragment`,
      'data:image/png;base64,AAA', 'blob:https://images.openai.com/123',
      'https://images.openai.com/static-rsc-4/%2Fredirect'
    ]) expect(approvedChatGptImageRequest(url)).toBe(false);
    expect(approvedChatGptImageRequest(valid, 'script')).toBe(false);
    expect(approvedChatGptImageRequest(valid, 'image', 'POST')).toBe(false);
  });

  it('makes cross-origin redirects ineligible as image destinations under CSP', () => {
    const tokens = RENDERER_CONTENT_SECURITY_POLICY.split(';').find(d => d.trim().startsWith('img-src'))!.trim().split(/\s+/);
    expect(tokens).not.toContain('https:');
    expect(tokens).not.toContain('blob:');
    expect(tokens).not.toContain('http://images.openai.com');
    expect(tokens).not.toContain('https://*.openai.com');
    // CSP checks each hop: the named origin cannot redirect to an external CDN or subdomain.
    for (const redirected of ['https://cdn.openai.com/asset', 'https://third-party.invalid/pixel',
      'http://images.openai.com/asset', 'blob:https://images.openai.com/asset']) {
      expect(approvedChatGptImageRequest(redirected)).toBe(false);
    }
    // data: already supported by the old policy for sanitized inline vector drawings,
    // but never passes the new remote-image request allowlist.
    expect(tokens).toContain('data:');
    expect(approvedChatGptImageRequest('data:image/svg+xml;base64,AAA')).toBe(false);
  });
});
