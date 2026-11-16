import { describe, expect, it } from 'vitest';
import {
  CHAT_PROVIDERS,
  conversationFromUrl,
  conversationUrl,
  geminiSlugFromConversationId,
  homeUrlForProvider,
  inputBrowserUrl,
  isAcceptedConversationId,
  isChatGptConversationId,
  isChatGptHost,
  isChatProvider,
  isGeminiConversationId,
  isGeminiHost,
  isValidConversationId,
  providerForConversationId,
  providerForUrl,
  toGeminiConversationId
} from '../src/shared/provider.js';

describe('provider shared helpers', () => {
  it('distinguishes ChatGPT UUIDs and Gemini slugs consistently', () => {
    const gptId = '12345678-1234-1234-1234-1234567890ab';
    const gemId = 'gemini-8f3b2c1d9e0a4567';

    expect(CHAT_PROVIDERS).toEqual(['chatgpt', 'gemini']);
    expect(isChatProvider('chatgpt')).toBe(true);
    expect(isChatProvider('gemini')).toBe(true);
    expect(isChatProvider('claude')).toBe(false);

    expect(isChatGptConversationId(gptId)).toBe(true);
    expect(isChatGptConversationId(gemId)).toBe(false);
    expect(isGeminiConversationId(gemId)).toBe(true);
    expect(isGeminiConversationId(gptId)).toBe(false);
    expect(isGeminiConversationId('gemini-settings')).toBe(false);
    expect(isGeminiConversationId('gemini-x')).toBe(false);

    expect(isValidConversationId(gptId)).toBe(true);
    expect(isValidConversationId(gemId)).toBe(true);
    expect(isValidConversationId('gemini-settings')).toBe(false);
    expect(isAcceptedConversationId(gemId)).toBe(true);
    expect(isAcceptedConversationId('c-prime-test')).toBe(true);

    expect(providerForConversationId(gptId)).toBe('chatgpt');
    expect(providerForConversationId(gemId)).toBe('gemini');
    expect(providerForConversationId('bad/id')).toBeNull();

    expect(geminiSlugFromConversationId(gemId)).toBe('8f3b2c1d9e0a4567');
    expect(geminiSlugFromConversationId(gptId)).toBeNull();
    expect(toGeminiConversationId('8f3b2c1d9e0a4567')).toBe(gemId);
    expect(toGeminiConversationId(gemId)).toBe(gemId);
    expect(toGeminiConversationId('settings')).toBeNull();
  });

  it('builds and parses URLs cleanly for both ChatGPT and Gemini Web', () => {
    const gptId = '12345678-1234-1234-1234-1234567890ab';
    const gemId = 'gemini-8f3b2c1d9e0a4567';

    expect(homeUrlForProvider('chatgpt')).toBe('https://chatgpt.com/');
    expect(homeUrlForProvider('gemini')).toBe('https://gemini.google.com/app');

    expect(conversationUrl(gptId)).toBe(`https://chatgpt.com/c/${gptId}`);
    expect(conversationUrl(gemId)).toBe('https://gemini.google.com/app/8f3b2c1d9e0a4567');

    expect(inputBrowserUrl({ id: 'in-1', provider: 'gemini' })).toBe(
      'https://gemini.google.com/app?cos-input=in-1#cos-input=in-1'
    );
    expect(inputBrowserUrl({ id: 'in-2', provider: 'chatgpt', temporary: true })).toBe(
      'https://chatgpt.com/?temporary-chat=true&cos-input=in-2#cos-input=in-2'
    );
    expect(inputBrowserUrl({ id: 'in-3', conversationId: gemId })).toBe(
      'https://gemini.google.com/app/8f3b2c1d9e0a4567'
    );

    expect(isGeminiHost('gemini.google.com')).toBe(true);
    expect(isChatGptHost('chatgpt.com')).toBe(true);
    expect(providerForUrl('https://gemini.google.com/u/1/app')).toBe('gemini');
    expect(providerForUrl('https://chatgpt.com/')).toBe('chatgpt');
    expect(providerForUrl('http://gemini.google.com/app')).toBeNull();

    expect(conversationFromUrl('https://gemini.google.com/app/8f3b2c1d9e0a4567')).toEqual({
      provider: 'gemini',
      conversationId: gemId,
      rawId: '8f3b2c1d9e0a4567'
    });
    expect(conversationFromUrl('https://gemini.google.com/u/0/gem/my-gem/AbCdEf123456')).toEqual({
      provider: 'gemini',
      conversationId: 'gemini-AbCdEf123456',
      rawId: 'AbCdEf123456'
    });
    expect(conversationFromUrl(`https://chatgpt.com/g/g-proj/c/${gptId}`)).toEqual({
      provider: 'chatgpt',
      conversationId: gptId,
      rawId: gptId
    });
    expect(conversationFromUrl('https://gemini.google.com/app/settings')).toBeNull();
  });
});
