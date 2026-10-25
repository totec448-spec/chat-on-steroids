import { describe, expect, it } from 'vitest';
import { newTopic } from '../src/renderer/phone-push-settings.js';

describe('a new phone topic', () => {
  it('is cos- and 20 letters, each of the 32 equally likely', () => {
    const counts = new Map<string, number>();
    for (let start = 0; start < 256; start += 20) {
      const topic = newTopic(count => Array.from({ length: count }, (_, index) => (start + index) % 256));
      expect(topic).toMatch(/^cos-[a-km-np-z2-9]{20}$/);
    }
    // Every byte value once: each letter comes from exactly 8 of the 256.
    const all = newTopic(() => Array.from({ length: 256 }, (_, byte) => byte)).slice(4);
    for (const letter of all) counts.set(letter, (counts.get(letter) ?? 0) + 1);
    expect(counts.size).toBe(32);
    expect(new Set(counts.values())).toEqual(new Set([8]));
  });
});
