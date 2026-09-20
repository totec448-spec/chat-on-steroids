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
  const timers = new Map<number, { at: number; run: () => void }>();
  let timerId = 0;
  const listeners = new Map<string, Array<{ handler: (event: unknown) => void; once: boolean }>>();
  const document = { readyState: 'loading' };
  class Socket {
    static OPEN = 1;
    handlers: Array<(event: { data: string }) => void> = [];
    constructor(readonly url: string) {}
    addEventListener(type: string, listener: (event: { data: string }) => void) { if (type === 'message') this.handlers.push(listener); }
    receive(data: unknown) { for (const listener of this.handlers) listener({ data: JSON.stringify(data) }); }
  }
  const window: any = {
    WebSocket: Socket,
    fetch: (..._args: unknown[]) => Promise.resolve(response),
    postMessage: (data: unknown) => posts.push(JSON.parse(JSON.stringify(data))),
    addEventListener: (type: string, handler: (event: unknown) => void, options?: { once?: boolean }) => {
      const rows = listeners.get(type) ?? [];
      rows.push({ handler, once: options?.once === true });
      listeners.set(type, rows);
    },
    removeEventListener: (type: string, handler: (event: unknown) => void) => listeners.set(type, (listeners.get(type) || []).filter(row => row.handler !== handler))
  };
  const dispatch = (type: string, event: unknown) => {
    const rows = listeners.get(type) ?? [];
    listeners.set(type, rows.filter(row => !row.once));
    for (const row of rows) row.handler(event);
  };
  const evaluate = (source = script) => runInNewContext(source, { window, document, location: { origin: 'https://chatgpt.com' }, URL, Date: Clock, TextDecoder,
    setTimeout: (run: () => void, ms: number) => { timers.set(++timerId, { at: now + ms, run }); return timerId; },
    clearTimeout: (id: number) => timers.delete(id) });
  evaluate();
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
  async function feedSse(chunks: string[], init: Record<string, unknown> = { method: 'POST' }, url = 'https://chatgpt.com/backend-api/conversation') {
    let done: () => void = () => {};
    const inspected = new Promise<void>(resolve => { done = resolve; });
    let at = 0;
    response = {
      url,
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
    if (String(init.method || 'GET').toUpperCase() === 'POST' && new URL(url).origin === 'https://chatgpt.com' && /^\/backend-api\/(?:f\/)?conversation$/.test(new URL(url).pathname)) await inspected;
    else await new Promise(resolve => setTimeout(resolve, 0));
  }
  return {
    posts,
    evaluate,
    observer: () => window.__cosUsageObserver,
    markLegacy: () => { window.__cosUsageObserver.dispose(); window.__cosUsageObserver = true; },
    needsReload: () => window.__cosUsageObserverNeedsReload === true,
    nativeSocket: Socket,
    socket: (url = 'wss://ws.chatgpt.com/ws') => new window.WebSocket(url),
    feed,
    feedSse,
    openSse: async () => {
      let resolve: (value: unknown) => void = () => {};
      let cancelled = false, clones = 0;
      const reader = {
        read: () => new Promise(done => { resolve = done; }),
        cancel: async () => { cancelled = true; resolve({ done: true }); }
      };
      response = { url: 'https://chatgpt.com/backend-api/f/conversation', ok: true,
        headers: { get: () => 'text/event-stream' },
        clone: () => { clones++; return { body: { getReader: () => reader } }; } };
      await window.fetch('/backend-api/f/conversation', { method: 'POST' });
      return { push: (data: unknown) => resolve({ done: false, value: new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`) }),
        get cancelled() { return cancelled; }, get clones() { return clones; } };
    },
    hide: () => dispatch('pagehide', {}),
    replaceFetch: (wrapExisting = false) => {
      const previous = window.fetch;
      const replacement = (...args: unknown[]) => wrapExisting ? previous(...args) : Promise.resolve(response);
      window.fetch = replacement;
      return replacement;
    },
    ready: () => { document.readyState = 'interactive'; dispatch('DOMContentLoaded', {}); },
    currentFetch: () => window.fetch,
    holdNextBody: () => { let release = () => {}; nextBodyGate = new Promise<void>(resolve => { release = resolve; }); return () => release(); },
    advance: (ms: number) => { now += ms; for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.run(); } },
    request: (source: unknown = window, origin = 'https://chatgpt.com') => dispatch('message', { source, origin, data: { type: 'cos-usage-request' } })
  };
}

describe('MAIN-world usage projection', () => {
  it('keeps one current observer and refreshes a provider-replaced wrapper without extra active readers', async () => {
    const h = harness(), current = h.observer(), fetch = h.currentFetch();
    h.evaluate(); expect(h.observer()).toBe(current); expect(h.currentFetch()).toBe(fetch);
    h.replaceFetch(true); expect(current.current()).toBe(false);
    h.evaluate(); expect(current.current()).toBe(true);
    const stream = await h.openSse(); expect(stream.clones).toBe(1);
    h.observer().dispose(); expect(stream.cancelled).toBe(true);
    h.evaluate(); expect(h.observer()).not.toBe(current); expect(h.observer().current()).toBe(true);
  });
  it('retires a versioned observer across replacement while preserving provider wrappers and native sockets', async () => {
    const h = harness(), old = h.observer(), socket = h.socket();
    h.replaceFetch(true);
    h.evaluate(script.replace('const OBSERVER_VERSION = 2;', 'const OBSERVER_VERSION = 3;'));
    expect(old.current()).toBe(false); expect(h.observer().version).toBe(3);
    const stream = await h.openSse(); expect(stream.clones).toBe(1); h.hide();
    expect(socket).toBeInstanceOf(h.nativeSocket);
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await h.feedSse([`data: {"conversation_id":"${id}","metadata":{"request_id":"wfr_replaced"}}\n\n`]);
    expect(h.posts.filter(row => row.requestIds?.includes('wfr_replaced'))).toHaveLength(1);
  });
  it('requires a fresh document for a legacy observer without a disposal handle', () => {
    const h = harness(); h.markLegacy(); const before = h.currentFetch();
    h.evaluate(); expect(h.needsReload()).toBe(true); expect(h.currentFetch()).toBe(before);
  });
  it('reads complete identity in the native f/conversation/resume stream without admitting arbitrary endpoints', async () => {
    const h = harness(), id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const frame = [`data: {"conversation_id":"${id}","metadata":{"request_id":"wfr_resume"}}\n\n`];
    await h.feedSse(frame, { method: 'POST' }, 'https://chatgpt.com/backend-api/f/conversation/resume');
    expect(h.posts.map(row => row.requestIds)).toEqual([['wfr_resume']]);
    await h.feedSse(frame, { method: 'POST' }, 'https://chatgpt.com/backend-api/other/conversation/resume');
    expect(h.posts).toHaveLength(1);
  });
  it('retains self-contained explicit root delta identity when a socket handoff has no encoding prologue', async () => {
    const h = harness(), conversation_id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const frame = (request_id: string) => `event: delta\ndata: ${JSON.stringify({ p: '', o: 'add', c: 0,
      v: { conversation_id, message: { metadata: { request_id } } } })}\n\n`;
    await h.feedSse([frame('wfr_explicit_http')]);
    h.socket().receive([{ type: 'message', payload: { type: 'conversation-turn-stream', payload: {
      type: 'stream-item', conversation_id, turn_id: 'handoff', stream_item_id: 'first', parent_stream_item_id: 'http-last',
      encoded_item: frame('wfr_explicit_handoff')
    } } }]);
    expect(h.posts.map(row => row.requestIds)).toEqual([['wfr_explicit_http'], ['wfr_explicit_handoff']]);
  });
  it('reads complete messages with inherited v1 delta headers before any cache or later status event', async () => {
    const h = harness(), conversation_id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const delta = (value: unknown) => `event: delta\ndata: ${JSON.stringify(value)}\n\n`;
    await h.feedSse(['event: delta_encoding\ndata: "v1"\n\n',
      delta({ p: '', o: 'add', c: 0, v: { conversation_id, message: { metadata: {} } } }),
      delta({ c: 1, v: { conversation_id, message: { metadata: { request_id: 'wfr_early_shell' }, content: { parts: ['NEVER_PROJECT_CONTENT'] } } } }),
      delta({ v: { conversation_id, message: { metadata: { request_id: 'wfr_next_shell' } } } })]);
    expect(h.posts.map(row => row.requestIds)).toEqual([['wfr_early_shell'], ['wfr_next_shell']]);
    expect(JSON.stringify(h.posts)).not.toContain('NEVER_PROJECT_CONTENT');
  });
  it('never treats an inherited nested delta as a root or stitches partial identity fields', async () => {
    const h = harness(), conversation_id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const delta = (value: unknown) => `event: delta\ndata: ${JSON.stringify(value)}\n\n`;
    const value = { conversation_id, message: { metadata: { request_id: 'wfr_not_root' } } };
    await h.feedSse(['event: delta_encoding\ndata: "v1"\n\n',
      delta({ p: '/message/content', o: 'add', v: {} }), delta({ v: value }),
      delta({ p: '', o: 'add', v: { conversation_id } }),
      delta({ p: '/message/metadata/request_id', o: 'add', v: 'wfr_partial' })]);
    expect(h.posts).toEqual([]);
    await h.feedSse(['event: delta_encoding\ndata: "future"\n\n', delta({ p: '', o: 'add', v: value })]);
    expect(h.posts).toEqual([]);
    await h.feedSse([delta({ v: value })]); // A different HTTP response owns no prior headers.
    expect(h.posts).toEqual([]);
  });
  it('decodes linked socket stream items separately for each native turn and rejects missing predecessors', () => {
    const h = harness(), socket = h.socket(), conversation_id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const send = (turn_id: string, stream_item_id: string, parent_stream_item_id: string | null, encoded_item: string) => socket.receive([
      { type: 'message', payload: { type: 'conversation-turn-stream', payload: {
        type: 'stream-item', conversation_id, turn_id, stream_item_id, parent_stream_item_id, encoded_item
      } } }
    ]);
    const delta = (value: unknown) => `event: delta\ndata: ${JSON.stringify(value)}\n\n`;
    const value = (request_id: string) => ({ conversation_id, message: { metadata: { request_id } } });
    send('turn-a', 'a0', null, 'event: delta_encoding\ndata: "v1"\n\n');
    send('turn-a', 'a1', 'a0', delta({ v: value('wfr_socket_early') }));
    send('turn-a', 'a1', 'a0', delta({ v: value('wfr_duplicate') }));
    send('turn-b', 'b1', null, delta({ v: value('wfr_foreign_turn') }));
    send('turn-a', 'a3', 'missing', delta({ v: value('wfr_missing_parent') }));
    expect(h.posts.map(row => row.requestIds)).toEqual([['wfr_socket_early']]);
  });
  it('joins a UUID request from a complete root-add event, including socket delivery, without copying content', async () => {
    const h = harness(), conversation_id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', request_id = '11111111-2222-4333-8444-555555555555';
    const frame = `data: ${JSON.stringify({ p: '', o: 'add', v: { conversation_id, message: { metadata: { request_id }, content: { parts: ['PRIVATE_TEST_TEXT'] } } } })}\n\n`;
    await h.feedSse([frame.slice(0, 73), frame.slice(73)]);
    expect(h.posts).toEqual([{ type: 'cos-request-origin', conversationId: conversation_id, requestIds: [request_id], observedAt: expect.any(Number) }]);
    h.socket().receive([{ type: 'message', payload: { type: 'conversation-turn-stream', payload: {
      type: 'stream-item', conversation_id, encoded_item: frame.replace(request_id, '66666666-2222-4333-8444-555555555555')
    } } }]);
    expect(h.posts[1]?.requestIds).toEqual(['66666666-2222-4333-8444-555555555555']);
    expect(JSON.stringify(h.posts)).not.toContain('PRIVATE_TEST_TEXT');
  });
  it('does not join partial root patches or quoted UUID request metadata', async () => {
    const h = harness(), conversation_id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', request_id = '11111111-2222-4333-8444-555555555555';
    for (const event of [
      { p: '/message', o: 'add', v: { conversation_id, metadata: { request_id } } },
      { p: '', o: 'replace', v: { conversation_id, metadata: { request_id } } },
      { p: '', o: 'add', v: { conversation_id, message: { content: { metadata: { request_id } } } } },
      { p: '', o: 'add', v: { conversation_id } },
      { p: '/metadata', o: 'add', v: { request_id } }
    ]) await h.feedSse([`data: ${JSON.stringify(event)}\n\n`]);
    expect(h.posts).toEqual([]);
  });
  it('observes the Pro socket handoff with exact inner/outer conversation proof and shares HTTP deduplication', async () => {
    const h = harness(), socket = h.socket();
    expect(socket).toBeInstanceOf(h.nativeSocket);
    const conversation_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const frame = `data: ${JSON.stringify({ conversation_id, message: { metadata: { request_id: 'wfr_socket' } } })}\n\n`;
    const envelope = [{ type: 'message', payload: { type: 'conversation-turn-stream', payload: {
      type: 'stream-item', conversation_id, encoded_item: frame
    } } }];
    socket.receive(envelope); socket.receive(envelope);
    expect(h.posts).toHaveLength(1);
    await h.feedSse([frame]);
    expect(h.posts).toHaveLength(1);
    h.request(); expect(h.posts).toHaveLength(2);
  });
  it('rejects foreign sockets, contradictory envelopes and request IDs hidden in model text', () => {
    const h = harness(), socket = h.socket();
    const conversation_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const envelope = (value: unknown, owner = conversation_id) => [{ type: 'message', payload: {
      type: 'conversation-turn-stream', payload: { type: 'stream-item', conversation_id: owner,
        encoded_item: `data: ${JSON.stringify(value)}\n\n` }
    } }];
    const value = { conversation_id, message: { metadata: { request_id: 'wfr_exact' } } };
    h.socket('wss://chatgpt.com.evil.test/ws').receive(envelope(value));
    socket.receive(envelope(value, '11111111-2222-3333-4444-555555555555'));
    socket.receive(envelope({ conversation_id, message: { content: JSON.stringify(value) } }));
    socket.receive(envelope(value).concat(Array(33).fill({})));
    expect(h.posts).toHaveLength(0);
  });
  it('listens beyond five minutes, deduplicates and replays bounded ID evidence, then cancels at fifteen minutes', async () => {
    const h = harness();
    const stream = await h.openSse();
    h.advance(6 * 60_000);
    expect(stream.cancelled).toBe(false);
    const event = { conversation_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', metadata: { request_id: 'wfr_late' } };
    stream.push(event);
    await Promise.resolve(); await Promise.resolve();
    expect(h.posts).toHaveLength(1);
    stream.push(event);
    await Promise.resolve(); await Promise.resolve();
    expect(h.posts).toHaveLength(1);
    h.request();
    expect(h.posts).toHaveLength(2);
    expect(h.posts[1]).toEqual(h.posts[0]);
    h.advance(9 * 60_000);
    expect(stream.cancelled).toBe(true);
    h.hide(); h.request();
    expect(h.posts).toHaveLength(2);
  });
  it('bounds concurrent response clones and releases them on page exit', async () => {
    const h = harness();
    const a = await h.openSse(), b = await h.openSse(), c = await h.openSse();
    expect([a.clones, b.clones, c.clones]).toEqual([1, 1, 0]);
    h.hide();
    expect(a.cancelled && b.cancelled).toBe(true);
  });
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

  it('reattaches after the page runtime replaces fetch during startup', async () => {
    const h = harness();
    const replacement = h.replaceFetch();
    expect(h.currentFetch()).toBe(replacement);
    h.ready();
    expect(h.currentFetch()).not.toBe(replacement);
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    await h.feedSse([`data: {"conversation_id":"${conversationId}","metadata":{"request_id":"wfr_after_runtime_wrap"}}\n\n`]);

    expect(h.posts).toEqual([
      { type: 'cos-request-origin', conversationId, requestIds: ['wfr_after_runtime_wrap'], observedAt: expect.any(Number) }
    ]);
  });

  it('preserves a page wrapper that delegates to the earlier observer without recursion or duplicate inspection', async () => {
    const h = harness();
    h.replaceFetch(true);
    h.ready();
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await h.feedSse([`data: {"conversation_id":"${conversationId}","metadata":{"request_id":"wfr_nested_wrapper"}}\n\n`]);
    expect(h.posts).toEqual([
      { type: 'cos-request-origin', conversationId, requestIds: ['wfr_nested_wrapper'], observedAt: expect.any(Number) }
    ]);
  });

  it('supports the f/conversation endpoint and bounds request ids to sixteen per stream', async () => {
    const h = harness();
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await h.feedSse(Array.from({ length: 20 }, (_, i) =>
      'data: ' + JSON.stringify({ conversation_id: conversationId, message: { metadata: { request_id: 'wfr_limit_' + i } } }) + '\r\n\r\n'
    ), { method: 'POST' }, 'https://chatgpt.com/backend-api/f/conversation');
    expect(h.posts).toHaveLength(16);
  });

  it('does not turn quoted text, tool arguments or cross-event identifiers into ownership', async () => {
    const h = harness();
    const a = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    for (const event of [
      { conversation_id: a, tool_arguments: { request_id: 'wfr_argument' } },
      { conversation_id: a, message: { content: { parts: ['{"request_id":"wfr_quoted"}'] } } },
      { conversation_id: a },
      { metadata: { request_id: 'wfr_separate_event' } }
    ]) await h.feedSse(['data: ' + JSON.stringify(event) + '\n\n']);
    await h.feedSse(['data: ' + JSON.stringify({ conversation_id: a, metadata: { request_id: 'wfr_foreign' } }) + '\n\n'],
      { method: 'POST' }, 'https://example.com/backend-api/conversation');
    expect(h.posts).toEqual([]);
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
