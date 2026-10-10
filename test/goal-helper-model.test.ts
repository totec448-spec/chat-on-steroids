import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  catalogState: 'ready' as string,
  models: [] as Array<{ id: string; label: string; efforts: string[]; aliases?: string[] }>,
  goal: { helperModel: 'gpt-5.6-sol', helperReasoning: 'high' } as Record<string, unknown>
}));
const refreshForUnoffered = vi.hoisted(() => vi.fn());
vi.mock('../src/main/chat-models.js', async original => ({ ...(await original<object>()), getChatModels: () => ({ state: state.catalogState, models: state.models }), refreshForUnoffered }));
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
  state.catalogState = 'ready';
  refreshForUnoffered.mockClear();
});

it("uses ChatGPT's current selection when the account shows no readable model picker (#1282)", () => {
  // Free plan: discovery ends 'unavailable' with no models, and an exact helper model can never be
  // confirmed, so every Goal follow-up failed with "Requested model or reasoning could not be confirmed".
  state.models = [];
  state.catalogState = 'unavailable';
  expect(goalHelperSelection()).toEqual({ model: null, reasoningEffort: null });
  // Before discovery has answered, the saved helper settings still apply.
  for (const pending of ['unknown', 'pending']) {
    state.catalogState = pending;
    expect(goalHelperSelection()).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'high' });
  }
});

it('keeps a saved helper model and reasoning the account offers', () => {
  expect(goalHelperSelection()).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'high' });
  expect(refreshForUnoffered).not.toHaveBeenCalled();
});

it('asks for a fresh catalog when the stored one lacks the saved helper model', () => {
  state.goal = { helperModel: '6', helperReasoning: 'pro' };
  goalHelperSelection();
  expect(refreshForUnoffered).toHaveBeenCalledWith(expect.stringContaining('6'));
});

it("falls back to ChatGPT's current selection for a saved model the account no longer offers", () => {
  state.goal = { helperModel: '6', helperReasoning: 'pro' };
  expect(goalHelperSelection()).toEqual({ model: null, reasoningEffort: null });
});

it('resolves a saved display label to its unique observed family', () => {
  state.models.push({ id: 'gpt-6-pro', label: '6', efforts: ['pro'] });
  state.goal = { helperModel: '6', helperReasoning: 'pro' };
  expect(goalHelperSelection()).toEqual({ model: 'gpt-6-pro', reasoningEffort: 'pro' });
});

it('resolves a label saved before models had full names (2.1.31: "6" is now "GPT-6")', () => {
  // A Mac config kept helperModel "6" from the old picker; after the rename every Goal decision
  // silently fell back to ChatGPT's current selection.
  state.models = [
    { id: 'gpt-6', label: 'GPT-6', efforts: ['none', 'medium', 'high', 'xhigh'], aliases: ['gpt-6', 'gpt-6-thinking'] },
    { id: 'gpt-5-6', label: 'GPT-5.6', efforts: ['none', 'medium', 'high', 'xhigh'] }
  ];
  state.goal = { helperModel: '6', helperReasoning: 'high' };
  expect(goalHelperSelection()).toEqual({ model: 'gpt-6', reasoningEffort: 'high' });
  state.goal = { helperModel: '5.6', helperReasoning: 'pro' };
  expect(goalHelperSelection()).toEqual({ model: 'gpt-5-6', reasoningEffort: null });
});

it('keeps rejecting a display label shared by several families', () => {
  state.models.push({ id: 'gpt-5-5-pro', label: '5.5', efforts: ['pro'] });
  state.goal = { helperModel: '5.5', helperReasoning: 'high' };
  expect(goalHelperSelection()).toEqual({ model: null, reasoningEffort: 'high' });
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

it('logs a fallback from the untouched default helper as info, and from a chosen model as a warning', async () => {
  // The built-in default is no choice of the user's. Its fallback counted as a problem in Activity on
  // every start for accounts without it (2.1.29 pre-release check).
  const { getLog } = await import('../src/main/logger.js');
  const level = (model: string) => getLog().filter(entry => entry.message.includes(`helper model "${model}"`)).at(-1)?.level;
  state.models = [{ id: 'gpt-5-5-thinking', label: '5.5', efforts: ['medium', 'high'] }];
  state.goal = { helperModel: 'gpt-6', helperReasoning: 'high' };
  expect(goalHelperSelection()).toEqual({ model: null, reasoningEffort: 'high' });
  expect(level('gpt-6')).toBe('info');
  state.goal = { helperModel: 'gpt-5-4-thinking', helperReasoning: 'high' };
  goalHelperSelection();
  expect(level('gpt-5-4-thinking')).toBe('warn');
});
