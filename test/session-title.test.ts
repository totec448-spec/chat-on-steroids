import { describe, expect, it } from 'vitest';
import { automaticTitle, userTitle } from '../src/main/session/title.js';

describe('a chat named after its first message', () => {
  it('keeps a short message as it is', () => {
    expect(userTitle('Fix the contact form')).toBe('Fix the contact form');
  });

  it('cuts a long message at a word and says it goes on', () => {
    const text = 'Release check 2.1.43 mid-turn compaction D, harmless. Use the app named Chat On Steroids Core for every step.';
    const title = userTitle(text);
    expect(title.endsWith('…')).toBe(true);
    expect([...title].length).toBeLessThanOrEqual(80);
    // Never half a word.
    expect(text.startsWith(title.slice(0, -1))).toBe(true);
    expect(text[title.length - 1]).toBe(' ');
  });

  it('reads as one line: line breaks and runs of spaces become one space', () => {
    expect(userTitle('Plan the\n\n  team   offsite')).toBe('Plan the team offsite');
  });

  it('never splits an emoji or other character outside the basic plane', () => {
    const title = userTitle('🙂'.repeat(100));
    expect(title).toBe('🙂'.repeat(79) + '…');
  });

  it('cuts a language without spaces at the length', () => {
    const title = userTitle('设置页面添加深色模式并保持现有测试通过'.repeat(10));
    expect([...title].length).toBe(80);
    expect(title.endsWith('…')).toBe(true);
  });

  it('drops a comma or dash left before the ellipsis', () => {
    const words = Array.from({ length: 30 }, (_, i) => i === 12 ? 'word,' : 'word');
    expect(userTitle(words.join(' '))).not.toMatch(/[,;:–-]…$/);
  });

  it('still recognises such a title as made from the message, so ChatGPT\'s own name can replace it', () => {
    const text = 'Release check 2.1.43 mid-turn compaction D, harmless. Use the app named Chat On Steroids Core for every step.';
    const message = { kind: 'user_message', seq: 1, origin: 1, time: 1, message: { text, chars: text.length, truncated: false } } as never;
    expect(automaticTitle({ title: userTitle(text) } as never, message)).toBe(true);
  });
});
