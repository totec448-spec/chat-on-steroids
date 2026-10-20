import { describe, expect, it } from 'vitest';
import { CUSTOM_CONTINUE_MAX_CHARS, recoveryMessage } from '../src/shared/recovery.js';

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

  it("says the person's own Continue words instead of a built-in phrase, and still asks to check existing work", () => {
    for (let index = 0; index < 20; index++) {
      const text = recoveryMessage({ custom: '  Weiter, bitte. Finish the migration first.  ' });
      expect(text.startsWith('Weiter, bitte. Finish the migration first. ')).toBe(true);
      expect(text).not.toMatch(/Continue until|Keep going until|Carry on|Please continue|Resume|Keep working|Pick up where/);
      expect(text).toMatch(/check|inspect|verify|look for/i);
    }
    // Blank text is no text: the built-in phrases come back.
    expect(recoveryMessage({ custom: '   ' })).toMatch(/^(Continue|Keep|Carry|Please|Resume|Pick)/);
    // The aside is its own switch and still comes after the person's words.
    expect(recoveryMessage({ custom: 'Go on.', playful: true })).toMatch(/^Go on\. .+\(Unrelated aside: /);
    // Never longer than the bound, whatever reached it.
    expect(recoveryMessage({ custom: 'x'.repeat(CUSTOM_CONTINUE_MAX_CHARS + 50) }).indexOf(' ')).toBe(CUSTOM_CONTINUE_MAX_CHARS);
  });
});
