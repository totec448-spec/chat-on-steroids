import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const script = readFileSync(new URL('../extension/usage.js', import.meta.url), 'utf8');
function harness() {
  const posts: Array<Record<string, any>> = [];
  let now = Date.parse('2026-09-05T12:00:00Z');
  class Clock extends Date { static override now() { return now; } }
  let response: unknown;
  let nextBodyGate: Promise<void> | null = null;
  let listener: (event: unknown) => void = () => {};
  const window = {
    fetch: (..._args: unknown[]) => Promise.resolve(response),
    postMessage: (data: unknown) => posts.push(JSON.parse(JSON.stringify(data))),
    addEventListener: (_type: string, handler: typeof listener) => { listener = handler; }
  };
  runInNewContext(script, { window, location: { origin: 'https://chatgpt.com' }, URL, Date: Clock, TextDecoder, setTimeout, clearTimeout });
  async function feed(data: unknown, url = 'https://chatgpt.com/backend-api/wham/usage', init: Record<string, unknown> = {}) {
    let done: () => void = () => {};
    const inspected = new Promise<void>(resolve => { done = resolve; });
    let read = false;
    const bodyGate = nextBodyGate; nextBodyGate = null;
    const body = new TextEncoder().encode(JSON.stringify(data));
    response = { url, ok: true, headers: { get: () => 'application/json' }, clone: () => ({ body: { getReader: () => ({
      read: async () => { await bodyGate; return read ? { done: true } : (read = true, { done: false, value: body }); },
      cancel: async () => { done(); }
    }) } }) };
    const expectedResponse = response;
    const returned = await window.fetch('/endpoint', { headers: { Authorization: 'private-test-value' }, ...init });
    expect(returned).toBe(expectedResponse);
    if (new URL(url).origin === 'https://chatgpt.com' && /^\/backend-api\/(wham\/usage|conversation\/init|conversation\/prepare|models)$/.test(new URL(url).pathname)) await inspected;
    else await new Promise(resolve => setTimeout(resolve, 0));
  }
  async function feedSse(chunks: string[], init: Record<string, unknown> = { method: 'POST' }) {
    let done: () => void = () => {};
    const inspected = new Promise<void>(resolve => { done = resolve; });
    let at = 0;
    response = {
      url: 'https://chatgpt.com/backend-api/conversation',
      ok: true,
      headers: { get: () => 'text/event-stream; charset=utf-8' },
      clone: () => ({ body: { getReader: () => ({
        read: async () => at < chunks.length
          ? { done: false, value: new TextEncoder().encode(chunks[at++]!) }
          : { done: true },
        cancel: async () => { done(); }
      }) } })
    };
    const returned = await window.fetch('/backend-api/conversation', init);
    expect(returned).toBe(response);
    if (String(init.method || 'GET').toUpperCase() === 'POST') await inspected;
    else await new Promise(resolve => setTimeout(resolve, 0));
  }
  return { posts, feed, feedSse, holdNextBody: () => { let release = () => {}; nextBodyGate = new Promise<void>(resolve => { release = resolve; }); return () => release(); }, advance: (ms: number) => { now += ms; }, request: (source: unknown = window, origin = 'https://chatgpt.com') => listener({ source, origin, data: { type: 'cos-usage-request' } }) };
}

describe('MAIN-world usage projection', () => {
  it('retains supported model counts without requiring a reset timestamp', async () => {
    const h = harness();
    await h.feed({ model_limits: [{ model_slug: 'model-a', remaining: 3 }, { model_slug: 'model-b', remaining: 0, resets_after: 'invalid' }, { model_slug: 'unknown' }] });
    expect(h.posts[0]?.rows).toEqual([
      expect.objectContaining({ model: 'model-a', remaining: 3, resetAt: null }),
      expect.objectContaining({ model: 'model-b', remaining: 0, resetAt: null })
    ]);
  });
  it('rejects an older response completing after a newer recognized snapshot, even within one millisecond', async () => {
    const h = harness();
    const release = h.holdNextBody();
    const old = h.feed({ limits_progress: [{ model_slug: 'old-model', remaining: 3 }] });
    await h.feed({ limits_progress: [] });
    release(); await old;
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]?.rows).toEqual([]);
    h.request();
    expect(h.posts[1]?.rows).toEqual([]);
  });
  it('preserves invocation time and does not let unrelated newer responses suppress quota evidence', async () => {
    const h = harness();
    const release = h.holdNextBody();
    const old = h.feed({ limits_progress: [{ model_slug: 'model-a', remaining: 3 }] });
    h.advance(2000);
    await h.feed({ models: [] }, 'https://chatgpt.com/backend-api/models');
    release(); await old;
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]?.observedAt).toBe(Date.parse('2026-09-05T12:00:00Z'));
  });
  it('projects shared percentage windows without copying credentials or inventing a model balance', async () => {
    const h = harness();
    await h.feed({ access_token: 'secret', email: 'private@example.test', rate_limit: { primary_window: { used_percent: 25, reset_at: 1900000000, limit_window_seconds: 18000 } } });
    expect(h.posts).toEqual([{ type: 'cos-usage', observedAt: expect.any(Number), rows: [{ model: 'Shared usage', scope: 'shared', remaining: null, remainingPercent: 75, resetAt: 1900000000000, windowSeconds: 18000 }] }]);
    expect(JSON.stringify(h.posts)).not.toMatch(/secret|private|Authorization/);
  });

  it('keeps model and feature evidence separate', async () => {
    const h = harness();
    await h.feed({ conversation_detail_metadata: { limits_progress: [{ feature_name: 'deep-research', remaining: 5 }, { model_slug: 'gpt-example', remaining: 2 }], model_limits: [{ model_slug: 'gpt-exhausted', resets_after: '2030-01-01T00:00:00Z' }] } }, 'https://chatgpt.com/backend-api/conversation/init');
    expect(h.posts[0]?.rows).toEqual([
      expect.objectContaining({ model: 'gpt-exhausted', scope: 'model', remaining: null }),
      expect.objectContaining({ model: 'deep-research', scope: 'feature', remaining: 5 }),
      expect.objectContaining({ model: 'gpt-example', scope: 'model', remaining: 2 })
    ]);
  });

  it('ignores foreign and unrelated responses, invalid counts and oversized payloads', async () => {
    const h = harness();
    const valid = { rate_limit: { primary_window: { used_percent: 20 } } };
    await h.feed(valid, 'https://example.test/backend-api/wham/usage');
    await h.feed(valid, 'https://chatgpt.com/backend-api/conversations');
    await h.feed({ limits_progress: [{ model_slug: 'gpt-example', remaining: -2 }, { model_slug: 'gpt-other', remaining: '3' }], rate_limit: { primary_window: { used_percent: 101 } } });
    await h.feed({ ...valid, padding: 'x'.repeat(513 * 1024) });
    expect(h.posts).toEqual([{ type: 'cos-usage', observedAt: expect.any(Number), rows: [] }]);
  });

  it('does not emit zero reset timestamps or durations rejected by the app schema', async () => {
    const h = harness();
    await h.feed({ rate_limit: { primary_window: { used_percent: 20, reset_at: 0, limit_window_seconds: 0 } } });
    expect(h.posts[0]?.rows[0]).toMatchObject({ remainingPercent: 80, resetAt: null, windowSeconds: null });
  });

  it('only replays to an exact same-page request', async () => {
    const h = harness();
    await h.feed({ rate_limit: { primary_window: { used_percent: 20 } } });
    h.request({}, 'https://chatgpt.com');
    h.request(undefined, 'https://example.test');
    expect(h.posts).toHaveLength(1);
    h.advance(600000);
    h.request();
    expect(h.posts).toHaveLength(2);
    expect(h.posts[1]?.observedAt).toBe(h.posts[0]?.observedAt);
  });

  it('emits an empty recognized quota snapshot but abstains on unrelated model metadata', async () => {
    const h = harness();
    await h.feed({ models: [{ slug: 'gpt-example', title: 'Example', max_tokens: 100000 }] }, 'https://chatgpt.com/backend-api/models');
    expect(h.posts).toEqual([]);
    await h.feed({ conversation_detail_metadata: { model_limits: [], limits_progress: [] } }, 'https://chatgpt.com/backend-api/conversation/prepare');
    expect(h.posts).toEqual([{ type: 'cos-usage', observedAt: expect.any(Number), rows: [] }]);
  });

  it('bounds the complete projection and rejects labels that could carry private or executable text', async () => {
    const h = harness();
    await h.feed({ limits_progress: [{ model_slug: 'private@example.test', remaining: 3 }, { feature_name: '<script>secret</script>', remaining: 5 }] });
    expect(h.posts[0]?.rows).toEqual([]);
    await h.feed({
      model_limits: Array.from({ length: 45 }, (_, i) => ({ model_slug: `model-${i}`, resets_after: '2030-01-01T00:00:00Z' })),
      limits_progress: Array.from({ length: 45 }, (_, i) => ({ feature_name: `feature-${i}`, remaining: 3 })),
      rate_limit: { primary_window: { used_percent: 20 } }
    });
    expect(h.posts[1]?.rows).toHaveLength(80);
    expect(JSON.stringify(h.posts)).not.toMatch(/private@example|<script>/);
  });

  it('publishes an exact conversation/request pair from a chunked live response before React renders it', async () => {
    const h = harness();
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await h.feedSse([
      `data: {"conversation_id":"${conversationId}","message":{"metadata":{"request_`,
      'id":"wfr_early_exact"},"content":{"parts":["private prompt and tool args"]}}}\n\n',
      `data: {"conversation_id":"${conversationId}","message":{"metadata":{"request_id":"wfr_early_exact"}}}\n\n`,
      `data: {"conversation_id":"${conversationId}","message":{"metadata":{"request_id":"wfr_second"}}}\n\n`
    ]);

    expect(h.posts).toEqual([
      { type: 'cos-request-origin', conversationId, requestIds: ['wfr_early_exact'], observedAt: expect.any(Number) },
      { type: 'cos-request-origin', conversationId, requestIds: ['wfr_second'], observedAt: expect.any(Number) }
    ]);
    expect(JSON.stringify(h.posts)).not.toContain('private prompt');
    expect(JSON.stringify(h.posts)).not.toContain('tool args');
  });

  it('ignores non-POST, foreign, malformed and contradictory stream identity', async () => {
    const h = harness();
    const a = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const b = '11111111-2222-4333-8444-555555555555';
    await h.feedSse([`data: {"conversation_id":"${a}","request_id":"wfr_get"}\n\n`], { method: 'GET' });
    await h.feedSse([`data: {"conversation_id":"${a}","request_id":"not-a-workflow"}\n\n`]);
    await h.feedSse([`data: {"conversation_id":"${a}","nested":{"conversation_id":"${b}"},"request_id":"wfr_conflict"}\n\n`]);
    expect(h.posts).toEqual([]);
  });
});
