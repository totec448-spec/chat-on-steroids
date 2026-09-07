import { REASONING_EFFORTS } from '../src/shared/session.js';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { getChatModels, requestChatModels, pendingChatModelRequest, observeChatModels, resetChatModelsForTests, configureChatModelDiscovery, startChatModelDiscovery } from '../src/main/chat-models.js';
const models = [{ id: 'gpt-example', label: 'GPT Example', efforts: ['none', 'medium', 'high', 'xhigh'] }];
beforeEach(() => { resetChatModelsForTests(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());
describe('ephemeral observed ChatGPT model catalog', () => {
  it('explains a missing native picker without claiming sign-in failure or inventing models', () => {
    requestChatModels();
    observeChatModels({ nonce: pendingChatModelRequest()!.nonce, models: null, error: 'picker_unavailable' });
    expect(getChatModels()).toMatchObject({ state: 'unavailable', models: [], error: expect.stringContaining('native model picker') });
  });
  it('rechecks browser startup when an unfinished discovery is explicitly opened again', async () => {
    const wake = vi.fn(async () => {}); configureChatModelDiscovery({ wake, changed: () => {} });
    await startChatModelDiscovery();
    const pending = pendingChatModelRequest()!;
    // The browser may have exited since the completed OS handoff. The shared
    // browser startup owner, not the catalog nonce, decides whether it is absent.
    await startChatModelDiscovery();
    expect(pendingChatModelRequest()).toEqual(pending);
    expect(wake.mock.calls).toEqual([[pending.nonce, true], [pending.nonce, true]]);
  });
  it('promotes a pending passive observation once when the user explicitly refreshes', async () => {
    const wake = vi.fn(async () => {}); configureChatModelDiscovery({ wake, changed: () => {} });
    await startChatModelDiscovery(false);
    const passive = pendingChatModelRequest()!;
    await Promise.all([startChatModelDiscovery(), startChatModelDiscovery()]);
    expect(pendingChatModelRequest()).toEqual({ ...passive, allowOpen: true });
    expect(wake.mock.calls).toEqual([[passive.nonce, false], [passive.nonce, true]]);
  });
  it('serializes explicit promotion behind an in-flight passive wake without duplicate opening', async () => {
    let release!: () => void;
    const wake = vi.fn((_nonce: string, _allowOpen: boolean) => new Promise<void>(resolve => { release = resolve; }));
    configureChatModelDiscovery({ wake, changed: () => {} });
    const passive = startChatModelDiscovery(false);
    const nonce = pendingChatModelRequest()!.nonce;
    const first = startChatModelDiscovery(), second = startChatModelDiscovery();
    expect(wake).toHaveBeenCalledTimes(1);
    release(); await passive;
    expect(wake.mock.calls).toEqual([[nonce, false], [nonce, true]]);
    release(); await Promise.all([first, second]);
    expect(pendingChatModelRequest()).toMatchObject({ nonce, allowOpen: true });
  });
  it('observes existing tabs once on window show without opening Chrome or invalidating ready models', async () => {
    const wake = vi.fn(async () => {}); configureChatModelDiscovery({ wake, changed: () => {} });
    await startChatModelDiscovery(false);
    const request = pendingChatModelRequest()!;
    expect(request.allowOpen).toBe(false);
    expect(wake).toHaveBeenCalledWith(request.nonce, false);
    observeChatModels({ nonce: request.nonce, models });
    await startChatModelDiscovery(false); await startChatModelDiscovery(false);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(getChatModels()).toMatchObject({ state: 'ready', models });
  });
  it('shares explicit browser startup and publishes a bounded expiry without polling', async () => {
    let release!: () => void;
    const wake = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const changed = vi.fn(); configureChatModelDiscovery({ wake, changed });
    const first = startChatModelDiscovery(), second = startChatModelDiscovery();
    expect(wake).toHaveBeenCalledTimes(1);
    release(); await Promise.all([first, second]);
    vi.advanceTimersByTime(120000);
    expect(changed).toHaveBeenCalled();
    expect(getChatModels()).toMatchObject({ state: 'unavailable', error: expect.stringMatching(/timed out/) });
  });
  it('turns browser launch failure into visible retry state without inventing choices', async () => {
    configureChatModelDiscovery({ wake: async () => { throw new Error('Chrome not found'); }, changed: () => {} });
    expect(await startChatModelDiscovery()).toMatchObject({ state: 'unavailable', models: [], error: expect.stringMatching(/Chrome not found/) });
    expect(pendingChatModelRequest()).toBeNull();
  });
  it('reuses a pending request, accepts only its nonce, and detaches all public views', () => {
    expect(getChatModels().state).toBe('unknown');
    expect(requestChatModels().state).toBe('pending');
    const request = pendingChatModelRequest()!;
    requestChatModels(); expect(pendingChatModelRequest()).toEqual(request);
    expect(observeChatModels({ nonce: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', models })).toBe(false);
    expect(observeChatModels({ nonce: request.nonce, models })).toBe(true);
    const view = getChatModels(); expect(view.state).toBe('ready');
    view.models[0]!.label = 'mutated';
    expect(getChatModels().models[0]!.label).toBe('GPT Example');
    expect(observeChatModels({ nonce: request.nonce, models })).toBe(false);
  });
  it('expires requests but retains observed choices for this startup until explicit refresh', () => {
    requestChatModels(); const stale = pendingChatModelRequest()!;
    vi.advanceTimersByTime(120000);
    expect(observeChatModels({ nonce: stale.nonce, models })).toBe(false);
    expect(getChatModels().state).toBe('unavailable');
    requestChatModels(); observeChatModels({ nonce: pendingChatModelRequest()!.nonce, models });
    vi.advanceTimersByTime(300000);
    expect(getChatModels()).toMatchObject({ state: 'ready', models });
    expect(requestChatModels()).toMatchObject({ state: 'pending', models: [], observedAt: null });
  });
  it('bounds observations, excludes arbitrary metadata and refuses duplicate or invented efforts', () => {
    requestChatModels(); const nonce = pendingChatModelRequest()!.nonce;
    for (const invalid of [
      { nonce, models, accountId: 'private' },
      { nonce, models: Array(21).fill(models[0]) },
      { nonce, models: [models[0], models[0]] },
      { nonce, models: [{ ...models[0], efforts: ['invented'] }] },
      { nonce, models: [{ ...models[0], efforts: ['high', 'high'] }] },
      { nonce, models: [{ ...models[0], label: 'x'.repeat(81) }] }
    ]) expect(observeChatModels(invalid)).toBe(false);
    expect(observeChatModels({ nonce, models: null })).toBe(true);
    expect(getChatModels()).toMatchObject({ state: 'unavailable', models: [] });
    resetChatModelsForTests(); expect(pendingChatModelRequest()).toBeNull();
  });
});


it('publishes exactly all canonical observed efforts without dropping Low or imposing the retired five-level cap', () => {
  requestChatModels();
  const observed = [{ id: 'actual-sol', label: 'GPT-5.6 Sol', efforts: [...REASONING_EFFORTS] }];
  expect(observeChatModels({ nonce: pendingChatModelRequest()!.nonce, models: observed })).toBe(true);
  expect(getChatModels()).toMatchObject({ state: 'ready', models: observed });
});
