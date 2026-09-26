import { expect, it } from 'vitest';
import { supportsFinishAutomation } from '../src/shared/finish.js';

it.each([
  ['goal', 'gpt-6-pro', 'pro', true],
  ['loop', 'gpt-6-astra', 'ultra', true],
  ['loop', 'gpt-6', 'pro', true],
  ['off', 'gpt-6-pro', 'pro', false],
  ['goal', 'gpt-5-6-pro', 'pro', false],
  ['loop', 'gpt-5-6-pro', 'pro', false],
  ['loop', 'gpt-5.6-pro', undefined, false],
  ['loop', 'gpt-5-6-thinking', 'pro', false],
  ['loop', 'gpt-5-6-thinking', 'high', false],
  ['goal', 'gpt-6', 'high', false],
  ['loop', null, 'pro', false],
  ['loop', 'unknown-pro', 'pro', false]
] as const)('offers finish automation for %s / %s / %s only under the Astra contract', (mode, model, effort, eligible) => {
  expect(supportsFinishAutomation(mode, model, effort)).toBe(eligible);
});
