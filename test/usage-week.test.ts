import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_USAGE_FORMULA, usageMessageFamily, usageModel, usageRate, usageWeekStart } from '../src/shared/usage.js';

afterEach(() => vi.unstubAllEnvs());

it('selects each most recent weekday, including today, across the year boundary', () => {
  const through = new Date(2027, 0, 4, 12).getTime(); // Monday.
  for (const [weekday, day] of [[0, 3], [1, 4], [2, -2], [3, -1], [4, 0], [5, 1], [6, 2]]) {
    expect(usageWeekStart(weekday!, through)).toBe(new Date(2027, 0, day!, 0, 0, 0, 0).getTime());
  }
});

it.each([
  ['Europe/Berlin', '2026-03-30T12:00:00', '2026-03-27T23:00:00.000Z', 59],
  ['Europe/Berlin', '2026-10-26T12:00:00', '2026-10-23T22:00:00.000Z', 61],
  ['America/New_York', '2026-03-09T12:00:00', '2026-03-07T05:00:00.000Z', 59],
  ['America/New_York', '2026-11-02T12:00:00', '2026-10-31T04:00:00.000Z', 61]
])('keeps Saturday at local midnight in %s across %s', (zone, localMonday, expectedUTC, hours) => {
  vi.stubEnv('TZ', zone);
  const through = new Date(localMonday).getTime();
  const from = usageWeekStart(6, through);
  expect(new Date(from).toISOString()).toBe(expectedUTC);
  expect((through - from) / 3_600_000).toBe(hours);
});

it('groups explicit generation identities and rejects unknown versions and ambiguous effort labels', () => {
  for (const model of ['5.6', 'gpt-5.6', 'gpt-5-6', 'gpt-5-6-instant', 'gpt-5-6-thinking', 'gpt-5-6-pro', 'GPT-5.6 Pro', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'Sol']) {
    expect(usageMessageFamily(model), model).toBe('gpt-5.6');
  }
  // ChatGPT's GPT-6 lanes as recorded (2026-10-07): Instant is `gpt-6`, Thinking is `gpt-6-thinking`.
  for (const model of ['6', 'gpt-6', 'gpt-6-instant', 'gpt-6-thinking', 'gpt-6-pro', 'GPT-6 Pro', 'gpt-6-astra', 'GPT6.0 Pro', 'Astra']) {
    expect(usageMessageFamily(model), model).toBe('gpt-6');
  }
  for (const model of [undefined, '', 'pro', 'high', 'gpt-5.5', 'gpt-5.60', 'gpt-6.1', 'gpt-6-pro-unknown', 'gpt-5-6-thinking-unknown', 'gpt-6-thinking-mini', 'my-gpt-6-pro']) {
    expect(usageMessageFamily(model), model).toBeNull();
  }
});

it('prices both 5.6 lanes as Sol and leaves GPT-6 unpriced until an official rate is established', () => {
  for (const model of ['gpt-5-6-instant', 'gpt-5-6-thinking']) expect(usageRate(usageModel(model), DEFAULT_USAGE_FORMULA), model).toBe(0.4);
  // ChatGPT's GPT-6 lanes have no verified API identity (docs/usage-model-attribution.md); no rate is invented.
  for (const model of ['gpt-6', 'gpt-6-thinking']) expect(usageRate(usageModel(model), DEFAULT_USAGE_FORMULA), model).toBeUndefined();
});
