import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  models: [] as Array<{ id: string; label: string; efforts: string[]; aliases?: string[] }>,
  goal: { helperModel: 'gpt-5.6-sol', helperReasoning: 'high' } as Record<string, unknown>
}));
vi.mock('../src/main/chat-models.js', async original => ({ ...(await original<object>()), getChatModels: () => ({ state: 'ready', models: state.models }) }));
vi.mock('../src/main/config.js', async original => {
  const real = await original<typeof import('../src/main/config.js')>();
  return { ...real, getConfig: () => ({ ...real.defaultConfig(), goal: { ...real.defaultConfig().goal, ...state.goal } }) };
});

const { goalHelperSelection, goalProgressFor } = await import('../src/main/goal.js');

beforeEach(() => {
  state.models = [
    { id: 'gpt-5-6-thinking', label: '5.6', efforts: ['medium', 'high', 'xhigh'], aliases: ['gpt-5.6-sol'] },
    { id: 'gpt-5-5-thinking', label: '5.5', efforts: ['medium', 'high'] }
  ];
  state.goal = { helperModel: 'gpt-5.6-sol', helperReasoning: 'high' };
});

it('keeps a saved helper model and reasoning the account offers', () => {
  expect(goalHelperSelection()).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'high' });
});

it("falls back to ChatGPT's current selection for a saved model the account no longer offers", () => {
  state.goal = { helperModel: '6', helperReasoning: 'pro' };
  expect(goalHelperSelection()).toEqual({ model: null, reasoningEffort: null });
});

it('keeps an offered model but drops a reasoning level it does not have', () => {
  state.goal = { helperModel: 'gpt-5-5-thinking', helperReasoning: 'xhigh' };
  expect(goalHelperSelection()).toEqual({ model: 'gpt-5-5-thinking', reasoningEffort: null });
});

it('changes nothing before the catalog has been observed', () => {
  state.models = []; state.goal = { helperModel: '6', helperReasoning: 'pro' };
  expect(goalHelperSelection()).toEqual({ model: '6', reasoningEffort: 'pro' });
});

it('names the model the helper will actually use in progress, not the unusable saved one', () => {
  state.goal = { helperModel: '6', helperReasoning: 'pro' };
  expect(goalProgressFor('goal').model).toBe("ChatGPT's current selection");
  state.goal = { helperModel: 'gpt-5.6-sol', helperReasoning: 'high' };
  expect(goalProgressFor('goal').model).toBe('gpt-5.6-sol');
});
