import { describe, expect, it } from 'vitest';
import { recoveryMessage } from '../src/shared/recovery.js';

describe('the automatic Continue text', () => {
  it('carries no unrelated aside unless the person switched them on', () => {
    for (let index = 0; index < 50; index++) {
      const text = recoveryMessage();
      expect(text).not.toMatch(/aside|Fun fact|Meme joke/i);
      expect(text).toMatch(/check|inspect|verify|look for/i);
    }
  });

  it('adds one marked aside, which the model is told to ignore, when switched on', () => {
    const text = recoveryMessage({ playful: true });
    expect(text).toMatch(/\(Unrelated aside: (Fun fact|Meme joke): .+ Ignore this aside; do not research or respond to it\. Stay on the original task\.\)$/);
  });
});
