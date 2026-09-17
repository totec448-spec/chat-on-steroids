import { describe, expect, it } from 'vitest';
import { isAstraModel, isProModel } from '../src/shared/chat-models.js';

describe('provider model names and execution slugs', () => {
  it.each(['GPT-6 Pro', '6 Pro', 'gpt-6-pro', 'Astra', '6 Astra', 'GPT-6 Astra', 'gpt-6-astra'])('retains Astra policy for %s', model => {
    expect(isAstraModel(model)).toBe(true);
    expect(isProModel(model)).toBe(true);
  });

  it.each(['GPT-5.6 Pro', '5.6 Pro', 'gpt-5-6-pro', 'GPT-5.5 Pro', '5.5 Pro', 'gpt-5-5-pro', 'Pro'])('recognizes %s without granting Astra-only behavior', model => {
    expect(isProModel(model)).toBe(true);
    expect(isAstraModel(model)).toBe(false);
  });

  it.each(['GPT-5.6 Sol', '5.6 Sol', 'Sol', 'gpt-5-6-thinking', 'gpt-5-6', '5.6', 'GPT-5.5', '5.5', 'gpt-5-5-thinking'])('uses effort, not a removed display prefix, for %s', model => {
    expect(isProModel(model, 'high')).toBe(false);
    expect(isProModel(model, 'xhigh')).toBe(false);
    expect(isProModel(model, 'pro')).toBe(true);
  });

  it.each([null, '', 'future-model', 'professional', 'Sol Pro Preview', 'my-astra-model'])('does not guess Pro from %s', model => {
    expect(isProModel(model)).toBe(false);
  });
});
