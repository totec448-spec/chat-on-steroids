import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  catalogState: 'ready' as string,
  models: [] as Array<{ id: string; label: string; efforts: string[]; aliases?: string[] }>
}));
const logged = vi.hoisted(() => [] as string[]);
vi.mock('../src/main/chat-models.js', async original => ({ ...(await original<object>()), getChatModels: () => ({ state: state.catalogState, models: state.models }) }));
vi.mock('../src/main/logger.js', () => ({ logInfo: (line: string) => { logged.push(line); }, logWarn: (line: string) => { logged.push(line); } }));

const { resetResumeModelForTests, resumeModelSelection } = await import('../src/main/resume-model.js');

beforeEach(() => {
  state.models = [
    { id: 'gpt-5-6-thinking', label: '5.6', efforts: ['medium', 'high'], aliases: ['gpt-5.6-sol'] },
    { id: 'gpt-6-pro', label: '6', efforts: ['pro'] }
  ];
  state.catalogState = 'ready';
  logged.length = 0;
  resetResumeModelForTests();
});

// #1766: on a Free plan ChatGPT shows no model picker, so the source chat's model could never be
// confirmed in the new chat and every Compact & Resume was abandoned before it was sent.
it("starts the new chat on ChatGPT's current selection when the account shows no model picker", () => {
  state.models = [];
  state.catalogState = 'unavailable';
  expect(resumeModelSelection({ model: 'gpt-5-6-thinking', reasoningEffort: 'high' })).toEqual({ model: null, reasoningEffort: null });
  expect(logged).toEqual(["resume: this ChatGPT account shows no readable model picker; the new chat uses ChatGPT's current selection"]);
});

it('carries the source model over while the catalog is still loading, and when the account offers it', () => {
  for (const pending of ['unknown', 'pending']) {
    state.catalogState = pending; state.models = [];
    expect(resumeModelSelection({ model: 'gpt-6-pro', reasoningEffort: 'pro' })).toEqual({ model: 'gpt-6-pro', reasoningEffort: 'pro' });
  }
  state.catalogState = 'ready'; state.models = [{ id: 'gpt-6-pro', label: '6', efforts: ['pro'] }];
  expect(resumeModelSelection({ model: 'gpt-6-pro', reasoningEffort: 'pro' })).toEqual({ model: 'gpt-6-pro', reasoningEffort: 'pro' });
  // An alias stays the exact request it was.
  state.models = [{ id: 'gpt-5-6-thinking', label: '5.6', efforts: ['medium', 'high'], aliases: ['gpt-5.6-sol'] }];
  expect(resumeModelSelection({ model: 'gpt-5.6-sol', reasoningEffort: 'high' })).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'high' });
  expect(logged).toEqual([]);
});

it('drops a model or reasoning the account does not offer, and says so', () => {
  expect(resumeModelSelection({ model: 'gpt-7', reasoningEffort: 'high' })).toEqual({ model: null, reasoningEffort: null });
  expect(resumeModelSelection({ model: 'gpt-5-6-thinking', reasoningEffort: 'xhigh' })).toEqual({ model: 'gpt-5-6-thinking', reasoningEffort: null });
  expect(logged).toEqual([
    'resume: model "gpt-7" is not offered by this ChatGPT account; the new chat uses ChatGPT\'s current selection',
    'resume: reasoning "xhigh" is not offered for gpt-5-6-thinking by this ChatGPT account; the new chat uses ChatGPT\'s current reasoning'
  ]);
});

it('logs each resume once, however often its command is rendered', () => {
  state.models = [];
  state.catalogState = 'unavailable';
  const requested = { model: 'gpt-5-6-thinking', reasoningEffort: 'high' as const };
  resumeModelSelection(requested, 'resume-a');
  resumeModelSelection(requested, 'resume-a');
  resumeModelSelection(requested, 'resume-b');
  expect(logged).toHaveLength(2);
});

it('asks for nothing when the source chat had no known model', () => {
  expect(resumeModelSelection(null)).toEqual({ model: null, reasoningEffort: null });
  expect(resumeModelSelection(undefined)).toEqual({ model: null, reasoningEffort: null });
});
