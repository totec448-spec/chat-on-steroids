import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const store = vi.hoisted(() => ({ listUsageSessions: vi.fn(), readEvents: vi.fn() }));
vi.mock('../src/main/session/store.js', () => store);
const catalog = vi.hoisted(() => ({ getChatModels: vi.fn() }));
vi.mock('../src/main/chat-models.js', () => catalog);
const durable = vi.hoisted(() => ({ readDurable: vi.fn(), writeDurableSoon: vi.fn() }));
vi.mock('../src/main/durable.js', () => durable);
let usage: typeof import('../src/main/session/usage.js');
let now: number;
const limit = (overrides: Record<string, unknown> = {}) => ({ model: 'Shared ChatGPT usage', scope: 'shared', remaining: null, remainingPercent: 40, resetAt: null, windowSeconds: 18000, ...overrides });
beforeEach(async () => {
  vi.resetModules();
  catalog.getChatModels.mockReset().mockReturnValue({ models: [] });
  durable.readDurable.mockReset().mockResolvedValue(null); durable.writeDurableSoon.mockReset();
  store.listUsageSessions.mockReset().mockResolvedValue([]);
  store.readEvents.mockReset().mockResolvedValue([]);
  now = Date.parse('2026-09-05T12:00:00Z');
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  usage = await import('../src/main/session/usage.js');
});
afterEach(() => vi.restoreAllMocks());
describe('passive usage limits and canonical token totals', () => {
  it('keeps shared windows distinct and does not manufacture model-specific counts', async () => {
    usage.observeUsage([limit(), limit({ windowSeconds: 604800, remainingPercent: 70 }), limit({ model: 'gpt-example', scope: 'model', remaining: 3, remainingPercent: null })]);
    const result = await usage.usageOverview();
    expect(result.limits).toHaveLength(3);
    expect(result.limits.filter(row => row.scope === 'shared').map(row => row.remaining)).toEqual([null, null]);
    expect(result.limits.filter(row => row.scope === 'model')).toEqual([expect.objectContaining({ model: 'gpt-example', remaining: 3, remainingPercent: null })]);
    result.limits[0]!.remainingPercent = 99;
    expect((await usage.usageOverview()).limits[0]?.remainingPercent).toBe(40);
  });
  it.each([{ remaining: -1 }, { remaining: Infinity }, { remainingPercent: 101 }, { remainingPercent: NaN }, { resetAt: -1 }, { windowSeconds: 0 }, { scope: 'guessed' }])('rejects malformed batch atomically (%j)', async (bad) => {
    usage.observeUsage([limit()]);
    expect(() => usage.observeUsage([limit({ remainingPercent: 10 }), limit(bad)])).toThrow();
    expect((await usage.usageOverview()).limits[0]?.remainingPercent).toBe(40);
  });
  it('expires a snapshot on read even when no further provider response arrives', async () => {
    usage.observeUsage([limit()]);
    now += 10 * 60000 + 1;
    expect((await usage.usageOverview()).limits).toEqual([]);
  });
  it('rejects an oversized row batch without replacing the current snapshot', async () => {
    usage.observeUsage([limit()]);
    expect(() => usage.observeUsage(Array.from({ length: 81 }, (_, index) => limit({ model: `model-${index}` })))).toThrow();
    expect((await usage.usageOverview()).limits).toHaveLength(1);
  });
  it('replaces an account snapshot and accepts an explicit empty reset', async () => {
    usage.observeUsage([limit(), limit({ model: 'gpt-old', scope: 'model', remaining: 0 })]);
    now += 1;
    usage.observeUsage([limit({ model: 'gpt-new', scope: 'model', remaining: 5 })]);
    expect((await usage.usageOverview()).limits.map(row => row.model)).toEqual(['gpt-new']);
    now += 1;
    usage.observeUsage([]);
    expect((await usage.usageOverview()).limits).toEqual([]);
  });
  it('refuses older, stale and future snapshots and does not renew a replay timestamp', async () => {
    usage.observeUsage([limit()], now);
    for (const timestamp of [now - 1, now - 11 * 60000, now + 6000, NaN, 'invalid']) {
      usage.observeUsage([limit({ remainingPercent: 99 })], timestamp);
      expect((await usage.usageOverview()).limits[0]?.remainingPercent).toBe(40);
    }
    const captured = now;
    now += 9 * 60000;
    usage.observeUsage([limit()], captured);
    expect((await usage.usageOverview()).limits[0]?.observedAt).toBe(captured);
    now += 60001;
    expect((await usage.usageOverview()).limits).toEqual([]);
  });
  it('removes exhausted pre-reset observations without inventing a replenished balance', async () => {
    usage.observeUsage([limit({ model: 'gpt-example', scope: 'model', remaining: 0, remainingPercent: null, resetAt: now + 1000 })]);
    now += 1001;
    expect((await usage.usageOverview()).limits).toEqual([]);
  });
  it('recomputes changed session revisions and removes deleted sessions from daily totals', async () => {
    const time = new Date(2026, 8, 5, 12).getTime();
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 1, estimatedTokens: 1 }]);
    store.readEvents.mockResolvedValue([{ kind: 'tool_call', time, call: { callId: 'a', conversationId: 'chat', args: { text: 'aaaa' }, result: { text: '' }, summary: { title: '' } } }]);
    expect(await usage.usageOverview()).toMatchObject({ tokens: 0.5, sessions: 1, days: [{ date: '2026-09-05', tokens: 0.5 }] });
    await usage.usageOverview();
    expect(store.readEvents).toHaveBeenCalledTimes(1);
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 2, events: 1, estimatedTokens: 2 }]);
    store.readEvents.mockResolvedValue([{ kind: 'tool_call', time, call: { callId: 'a', conversationId: 'chat', args: { text: 'aaaaaaaa' }, result: { text: '' }, summary: { title: '' } } }]);
    expect((await usage.usageOverview()).days).toMatchObject([{ date: '2026-09-05', tokens: 1 }]);
    expect(store.readEvents).toHaveBeenCalledTimes(2);
    store.listUsageSessions.mockResolvedValue([]);
    expect(await usage.usageOverview()).toMatchObject({ tokens: 0, sessions: 0, days: [] });
  });
  it('uses final frontend context times unique tool calls divided by two', async () => {
    const time = new Date(2026, 8, 5, 12).getTime();
    const call = (callId: string, conversationId = 'a') => ({ kind: 'tool_call', time, call: { callId, conversationId, args: { text: 'aaaa' }, result: { text: 'bbbb' }, summary: { title: '' } } });
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 6, estimatedTokens: 999 }]);
    store.readEvents.mockResolvedValue([
      { kind: 'user_message', time, message: { text: 'aaaa' } },
      call('1'), call('2'), call('2'), call('3', 'b')
    ]);
    // First frontend: 5 tokens x 2 calls / 2; second: 2 x 1 / 2 = 6 total.
    const results = await Promise.all([usage.usageOverview(), usage.usageOverview()]);
    expect(results[0]?.tokens).toBe(6);
    expect(results[0]?.days[0]?.tokens).toBe(6);
    expect(store.readEvents).toHaveBeenCalledTimes(1);
    await usage.usageOverview();
    expect(store.readEvents).toHaveBeenCalledTimes(1);
  });
  it('assigns work to the call day and does not charge authored-only sessions', async () => {
    const first = new Date(2026, 8, 4, 23, 59).getTime();
    const second = new Date(2026, 8, 5, 0, 1).getTime();
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 3, estimatedTokens: 999 }]);
    store.readEvents.mockResolvedValue([
      { kind: 'user_message', time: first, message: { text: 'aaaa' } },
      { kind: 'tool_call', time: second, call: { callId: 'one', conversationId: 'a', args: { text: 'bbbb' }, result: { text: '' }, summary: { title: '' } } },
      { kind: 'assistant_message', time: second, message: { text: 'cccc' } }
    ]);
    expect((await usage.usageOverview()).days).toMatchObject([{ date: '2026-09-05', tokens: 1.5 }]);
    store.listUsageSessions.mockResolvedValue([{ id: 'text-only', updatedAt: 1, events: 1, estimatedTokens: 99 }]);
    store.readEvents.mockResolvedValue([{ kind: 'user_message', time: first, message: { text: 'aaaa' } }]);
    expect((await usage.usageOverview()).tokens).toBe(0);
  });
  it('reuses valid persisted revisions after restart without rereading transcripts', async () => {
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 1, estimatedTokens: 1 }]);
    store.readEvents.mockResolvedValue([{ kind: 'tool_call', time: now, call: { callId: 'a', conversationId: 'chat', args: { text: 'aaaa' }, result: { text: '' }, summary: { title: '' } } }]);
    const first = await usage.usageOverview();
    const persisted = durable.writeDurableSoon.mock.calls.at(-1)![1];
    vi.resetModules(); durable.readDurable.mockResolvedValue(persisted); store.readEvents.mockClear();
    usage = await import('../src/main/session/usage.js');
    expect((await usage.usageOverview()).tokens).toBe(first.tokens);
    expect(store.readEvents).not.toHaveBeenCalled();
  });
  it('caps long frontend estimates before aggregation while preserving raw context and short successors', async () => {
    const first = new Date(2026, 8, 4, 12).getTime();
    const second = new Date(2026, 8, 5, 12).getTime();
    const call = (callId: string, time: number, model: string, conversationId = 'a') => ({ kind: 'tool_call', time, call: { callId, conversationId, model, args: { text: 'aaaa' }, result: { text: '' }, summary: { title: '' } } });
    const session = { id: 'one', updatedAt: 1, events: 9, estimatedTokens: 2_000_000, contextTokens: 2_000_000 };
    const events = [
      { kind: 'user_message', time: first, message: { text: 'preview', truncated: true, chars: 8_000_000 } },
      call('1', first, 'gpt-6-pro'), call('2', first, 'gpt-6-pro'), call('3', first, 'gpt-6-pro'),
      call('4', second, 'gpt-5-6-thinking'), call('4', second, 'gpt-5-6-thinking'),
      { kind: 'session_start', time: second, conversationId: 'b' },
      { kind: 'user_message', time: second, message: { text: 'aaaa' } },
      call('5', second, 'gpt-6-pro', 'b')
    ];
    store.listUsageSessions.mockResolvedValue([session]); store.readEvents.mockResolvedValue(events);
    const result = await usage.usageOverview();
    expect(result.tokens).toBe(512_001);
    expect(result.days.map(day => [day.date, day.tokens])).toEqual([['2026-09-04', 384_000], ['2026-09-05', 128_001]]);
    expect(result.models).toEqual([
      { model: 'gpt-6-pro', reasoningEffort: null, assumed: false, tokens: 384_001 },
      { model: 'gpt-5-6-thinking', reasoningEffort: null, assumed: false, tokens: 128_000 }
    ]);
    const { usageEstimate, DEFAULT_USAGE_FORMULA } = await import('../src/shared/usage.js');
    expect(usageEstimate(result.models, { ...DEFAULT_USAGE_FORMULA, divisor: 1 }).tokens).toBe(1_024_002);
    expect(usageEstimate(result.models, { ...DEFAULT_USAGE_FORMULA, divisor: 4 }).tokens).toBe(256_000.5);
    expect(session).toMatchObject({ estimatedTokens: 2_000_000, contextTokens: 2_000_000 });
    const { eventTokens } = await import('../src/shared/session.js');
    expect(eventTokens(events[0] as Parameters<typeof eventTokens>[0])).toBe(2_000_000);
  });
  it.each([255_999, 256_000, 256_001, 2_000_000])('bounds a %i-token frontend without scaling short context', async (context) => {
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 1, estimatedTokens: context }]);
    store.readEvents.mockResolvedValue([{ kind: 'tool_call', time: now, call: { callId: 'a', conversationId: 'chat', args: { text: '', truncated: true, chars: context * 4 }, result: { text: '' }, summary: { title: '' } } }]);
    expect((await usage.usageOverview()).tokens).toBe(Math.min(context, 256_000) / 2);
  });
  it.each([
    { id: 'gpt-6-pro', efforts: [] },
    { id: 'gpt-6-astra', efforts: ['high'] },
    { id: 'gpt-5-6-pro', efforts: [] },
    { id: 'gpt-5-6-thinking', efforts: ['high', 'pro'] }
  ])('uses a selectable Pro option %j to raise every model to 400K', async (option) => {
    catalog.getChatModels.mockReturnValue({ models: [option] });
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 2, estimatedTokens: 2_000_000 }]);
    store.readEvents.mockResolvedValue(['gpt-5-6-thinking', 'gpt-6-pro'].map((model, i) => ({ kind: 'tool_call', time: now,
      call: { callId: String(i), conversationId: 'chat', model, args: { text: '', truncated: true, chars: 4_000_000 }, result: { text: '' }, summary: { title: '' } } })));
    const result = await usage.usageOverview();
    expect(result.contextTokenCap).toBe(400_000);
    expect(result.models.map(row => row.tokens)).toEqual([200_000, 200_000]);
    expect(result.tokens).toBe(400_000);
  });
  it.each([399_999, 400_000, 400_001])('caps Pro-account context %i at 400K before the divisor', async context => {
    catalog.getChatModels.mockReturnValue({ models: [{ id: 'gpt-6-pro', efforts: [] }] });
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 1, estimatedTokens: context }]);
    store.readEvents.mockResolvedValue([{ kind: 'tool_call', time: now, call: { callId: 'a', conversationId: 'chat', model: 'gpt-5.6',
      args: { text: '', truncated: true, chars: context * 4 }, result: { text: '' }, summary: { title: '' } } }]);
    expect((await usage.usageOverview()).tokens).toBe(Math.min(context, 400_000) / 2);
  });
  it('rebuilds unchanged recordings when Pro availability changes, while ordinary catalog updates reuse the cache', async () => {
    const ordinary = { id: 'gpt-5-6-thinking', efforts: ['high'] };
    catalog.getChatModels.mockReturnValue({ models: [ordinary, { id: 'unknown-pro-lookalike', efforts: ['high'] }] });
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 1, estimatedTokens: 2_000_000 }]);
    store.readEvents.mockResolvedValue([{ kind: 'tool_call', time: now, call: { callId: 'a', conversationId: 'chat', model: 'gpt-6-pro',
      args: { text: '', truncated: true, chars: 8_000_000 }, result: { text: '' }, summary: { title: '' } } }]);
    // Historical Pro usage does not establish current selectable models.
    expect(await usage.usageOverview()).toMatchObject({ contextTokenCap: 256_000, tokens: 128_000 });
    catalog.getChatModels.mockReturnValue({ models: [ordinary, { id: 'gpt-6-pro', efforts: [] }] });
    expect(await usage.usageOverview()).toMatchObject({ contextTokenCap: 400_000, tokens: 200_000 });
    expect(store.readEvents).toHaveBeenCalledTimes(2);
    const saved = durable.writeDurableSoon.mock.calls.at(-1)![1];
    vi.resetModules(); durable.readDurable.mockResolvedValue(saved); store.readEvents.mockClear();
    usage = await import('../src/main/session/usage.js');
    catalog.getChatModels.mockReturnValue({ models: [ordinary, { id: 'gpt-6-pro', efforts: ['high'] }] });
    expect((await usage.usageOverview()).tokens).toBe(200_000);
    expect(store.readEvents).not.toHaveBeenCalled();
    catalog.getChatModels.mockReturnValue({ models: [ordinary] });
    expect(await usage.usageOverview()).toMatchObject({ contextTokenCap: 256_000, tokens: 128_000 });
    expect(store.readEvents).toHaveBeenCalledTimes(1);
  });
  it.each([4, 5])('rebuilds old cache version %i and reuses the corrected cache after restart', async (version) => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    durable.readDurable.mockResolvedValue({ version, rows: [{ id: 'one', revision: `${timezone}:1:1:2000000`, days: [['2026-09-05', [{ model: 'gpt-6-pro', reasoningEffort: null, assumed: false, tokens: 1_000_000 }]]] }] });
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 1, estimatedTokens: 2_000_000 }]);
    store.readEvents.mockResolvedValue([{ kind: 'tool_call', time: now, call: { callId: 'a', conversationId: 'chat', model: 'gpt-6-pro', args: { text: '', truncated: true, chars: 8_000_000 }, result: { text: '' }, summary: { title: '' } } }]);
    expect((await usage.usageOverview()).tokens).toBe(128_000);
    expect(store.readEvents).toHaveBeenCalledTimes(1);
    const persisted = durable.writeDurableSoon.mock.calls.at(-1)![1];
    expect(persisted.version).toBe(6);
    vi.resetModules(); durable.readDurable.mockResolvedValue(persisted); store.readEvents.mockClear();
    usage = await import('../src/main/session/usage.js');
    expect((await usage.usageOverview()).tokens).toBe(128_000);
    expect(store.readEvents).not.toHaveBeenCalled();
  });
  it('releases a failed calculation so opening again can retry', async () => {
    store.listUsageSessions.mockRejectedValueOnce(new Error('temporary read failure'));
    await expect(usage.usageOverview()).rejects.toThrow('temporary read failure');
    expect((await usage.usageOverview()).tokens).toBe(0);
  });
});

describe('model attribution and equivalent cost', () => {
  const call = (id: string, extra = {}) => ({ kind: 'tool_call', time: new Date(2026, 8, 5, 12).getTime(), call: { callId: id, conversationId: 'chat', args: { text: 'aaaa' }, result: { text: '' }, summary: { title: '' }, ...extra } });
  const message = (model?: string, reasoningEffort?: string, messageId = 'native') => ({ kind: 'user_message', time: now, messageId, message: { text: 'aaaa' }, ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) });
  beforeEach(() => store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 10, estimatedTokens: 10 }]));
  it('splits model and effort attribution without splitting final frontend context or duplicating calls', async () => {
    store.readEvents.mockResolvedValue([message('model-a', 'high'), call('a'), message('model-b', 'low'), call('b'), call('b')]);
    const result = await usage.usageOverview();
    expect(result.tokens).toBe(4);
    expect(result.models).toEqual([
      { model: 'model-a', reasoningEffort: 'high', assumed: false, tokens: 2 },
      { model: 'model-b', reasoningEffort: 'low', assumed: false, tokens: 2 }
    ]);
    expect(result.days[0]?.models).toEqual(result.models);
  });
  it('a native user row without evidence clears earlier selection; injected rows neither select nor clear', async () => {
    store.readEvents.mockResolvedValue([message('model-a', 'high'), message('wrong', 'low', 'input:x'), call('a'), message(), call('b')]);
    expect((await usage.usageOverview()).models).toEqual([
      { model: 'model-a', reasoningEffort: 'high', assumed: false, tokens: 2.5 },
      { model: 'gpt-5.6', reasoningEffort: 'high', assumed: true, tokens: 2.5 }
    ]);
  });
  it('direct call model overrides only that call and never inherits a different models effort', async () => {
    store.readEvents.mockResolvedValue([message('model-a', 'high'), call('a', { model: 'model-b' }), call('b')]);
    expect((await usage.usageOverview()).models).toEqual([
      { model: 'model-b', reasoningEffort: null, assumed: false, tokens: 1.5 },
      { model: 'model-a', reasoningEffort: 'high', assumed: false, tokens: 1.5 }
    ]);
  });
  it('a recorded legacy model name without effort does not turn assumed High into evidence', async () => {
    store.readEvents.mockResolvedValue([message('gpt-5.6'), call('a')]);
    expect((await usage.usageOverview()).models).toEqual([
      { model: 'gpt-5.6', reasoningEffort: null, assumed: false, tokens: 1 }
    ]);
  });
  it('new frontend and unattributed calls cannot inherit the previous model', async () => {
    store.readEvents.mockResolvedValue([message('model-a', 'high'), call('a'), call('b', { conversationId: 'other' }), call('c', { conversationId: null })]);
    const result = await usage.usageOverview();
    expect(result.models).toEqual([
      { model: 'model-a', reasoningEffort: 'high', assumed: false, tokens: 1 },
      { model: 'gpt-5.6', reasoningEffort: 'high', assumed: true, tokens: 1 }
    ]);
  });
  it('keeps effort changes for the same model separate and late evidence invalidates the saved revision', async () => {
    store.readEvents.mockResolvedValue([message('model-a', 'high'), call('a'), message('model-a', 'low'), call('b')]);
    expect((await usage.usageOverview()).models.map(row => row.reasoningEffort)).toEqual(['high', 'low']);
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 2, events: 10, estimatedTokens: 10 }]);
    store.readEvents.mockResolvedValue([message('model-b', 'low'), call('a')]);
    expect((await usage.usageOverview()).models).toEqual([{ model: 'model-b', reasoningEffort: 'low', assumed: false, tokens: 1 }]);
  });
  it('reuses model totals from persisted cache without transcript reads or aliasing returned values', async () => {
    store.readEvents.mockResolvedValue([message('model-a', 'high'), call('a')]);
    const first = await usage.usageOverview();
    const saved = structuredClone(durable.writeDurableSoon.mock.calls.at(-1)![1]);
    first.models[0]!.tokens = 999;
    first.days[0]!.models[0]!.tokens = 999;
    expect((await usage.usageOverview()).tokens).toBe(1);
    vi.resetModules(); durable.readDurable.mockResolvedValue(saved); store.readEvents.mockClear();
    usage = await import('../src/main/session/usage.js');
    expect((await usage.usageOverview()).models).toEqual([{ model: 'model-a', reasoningEffort: 'high', assumed: false, tokens: 1 }]);
    expect(store.readEvents).not.toHaveBeenCalled();
  });
  it('projects editable divisor and per-model cached rates while exposing unknown cost', async () => {
    const { usageEstimate } = await import('../src/shared/usage.js');
    const rows = [
      { model: 'a', reasoningEffort: 'high', assumed: false, tokens: 1e6 },
      { model: 'b', reasoningEffort: 'low', assumed: false, tokens: 2e6 },
      { model: 'unknown', reasoningEffort: null, assumed: false, tokens: 1e6 }
    ];
    expect(usageEstimate(rows, { divisor: 2, multiplier: 1.2, rates: { a: 0.4, b: 1 } })).toEqual({ tokens: 4e6, cost: 2.88, unpricedTokens: 1e6 });
    expect(usageEstimate(rows, { divisor: 4, multiplier: 1, rates: { a: 0, b: 1 } })).toEqual({ tokens: 2e6, cost: 1, unpricedTokens: 0.5e6 });
    expect(rows[0]!.tokens).toBe(1e6);
  });
  it('prices the recorded Sol picker ID without changing its identity or overriding saved rates', async () => {
    const { DEFAULT_USAGE_FORMULA, usageEstimate } = await import('../src/shared/usage.js');
    const rows = [{ model: 'gpt-5-6-thinking', reasoningEffort: 'high', assumed: false, tokens: 427245 }];
    expect(usageEstimate(rows, DEFAULT_USAGE_FORMULA)).toEqual({ tokens: 427245, cost: 0.2050776, unpricedTokens: 0 });
    for (const rate of [null, 0, 0.8]) {
      const estimate = usageEstimate(rows, { ...DEFAULT_USAGE_FORMULA, rates: { ...DEFAULT_USAGE_FORMULA.rates, 'gpt-5-6-thinking': rate } });
      expect(estimate.unpricedTokens).toBe(rate === null ? 427245 : 0);
      expect(estimate.cost).toBeCloseTo(rate === null ? 0 : 427245 / 1e6 * rate * 1.2);
    }
    expect(usageEstimate(rows, { ...DEFAULT_USAGE_FORMULA, rates: { 'gpt-5.6-sol': 0.8 } }).cost).toBeCloseTo(0.4101552);
    expect(usageEstimate([{ ...rows[0]!, model: 'gpt-5-6-thinking-unknown' }], DEFAULT_USAGE_FORMULA).unpricedTokens).toBe(427245);
    expect(rows[0]!.model).toBe('gpt-5-6-thinking');
  });
  it('prices the verified ChatGPT GPT-6 Pro alias at the Astra cached-input comparison rate', async () => {
    const { DEFAULT_USAGE_FORMULA, usageEstimate } = await import('../src/shared/usage.js');
    const rows = ['gpt-5.6', 'gpt-5.6-sol', 'gpt-6-astra', 'gpt-5.5', 'gpt-6-pro', 'gpt-5.6-terra', 'gpt-5.6-luna'].map(model => ({ model, reasoningEffort: 'high', assumed: false, tokens: 1e6 }));
    const estimate = usageEstimate(rows, DEFAULT_USAGE_FORMULA);
    expect(estimate).toMatchObject({ tokens: 7e6, unpricedTokens: 0 });
    expect(estimate.cost).toBeCloseTo(4.224);
  });
  it('groups known aliases without merging effort, provenance or distinct models and preserves per-ID rates', async () => {
    const { DEFAULT_USAGE_FORMULA, usageEstimate, usageModelGroups } = await import('../src/shared/usage.js');
    const rows = [
      ...['5.6', 'gpt-5.6', 'gpt-5-6-thinking', 'gpt-5.6-sol'].map(model => ({ model, reasoningEffort: 'high', assumed: false, tokens: 1e6 })),
      { model: 'gpt-5-6-pro', reasoningEffort: 'pro', assumed: false, tokens: 1e6 },
      { model: 'gpt-5.6', reasoningEffort: 'high', assumed: true, tokens: 1e6 },
      { model: 'gpt-5.6-sol', reasoningEffort: null, assumed: false, tokens: 1e6 },
      ...['gpt-6-pro', 'gpt-5.6-terra', 'gpt-5.6-luna', '5.6-unknown'].map(model => ({ model, reasoningEffort: 'pro', assumed: false, tokens: 1e6 }))
    ];
    const groups = usageModelGroups(rows);
    expect(groups).toHaveLength(8);
    expect(groups[0]).toMatchObject({ model: 'gpt-5.6-sol', reasoningEffort: 'high', assumed: false });
    expect(groups[0]!.sources).toHaveLength(4);
    expect(usageEstimate(groups[1]!.sources, DEFAULT_USAGE_FORMULA).cost).toBeCloseTo(0.48);
    const formula = { ...DEFAULT_USAGE_FORMULA, rates: { ...DEFAULT_USAGE_FORMULA.rates, '5.6': null, 'gpt-5-6-thinking': 0, 'gpt-5.6': 0.8 } };
    expect(usageEstimate(groups[0]!.sources, formula)).toEqual({ tokens: 4e6, cost: 1.44, unpricedTokens: 1e6 });
    expect(usageEstimate(rows.slice(-1), DEFAULT_USAGE_FORMULA).unpricedTokens).toBe(1e6);
    expect(rows[0]!.model).toBe('5.6');
  });
});
