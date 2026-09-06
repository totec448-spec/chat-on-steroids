import { REASONING_EFFORTS } from '../src/shared/session.js';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { getChatModels, requestChatModels, pendingChatModelRequest, observeChatModels, resetChatModelsForTests, configureChatModelDiscovery, startChatModelDiscovery } from '../src/main/chat-models.js';
const models = [{ id: 'gpt-example', label: 'GPT Example', efforts: ['none', 'medium', 'high', 'xhigh'] }];
beforeEach(() => { resetChatModelsForTests(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());
describe('ephemeral observed ChatGPT model catalog', () => {
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
