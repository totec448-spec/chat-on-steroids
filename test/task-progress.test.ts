import { describe, expect, it } from 'vitest';
import { planProgressText } from '../src/shared/task-progress.js';

const envelope = (stages: unknown) => JSON.stringify({ action: 'continue', reply: JSON.stringify({ stages }) });

describe('readable streamed plan progress', () => {
  it('shows partial stage prose before either JSON document completes', () => {
    const raw = envelope(['Build the feature', 'Verify the result']);
    const first = raw.indexOf('feature') + 3;
    expect(planProgressText(raw.slice(0, first))).toBe('1. Build the fea');
    expect(planProgressText(raw.slice(0, raw.indexOf('result') + 3))).toBe('1. Build the feature\n\n2. Verify the res');
    expect(planProgressText(raw)).toBe('1. Build the feature\n\n2. Verify the result');
  });

  it('decodes every fragmented prefix across both layers of escapes without protocol leakage', () => {
    const stage = 'Read "C:\\work\\a.ts"\nThen test café and ☔';
    const raw = envelope([stage, 'Verify']);
    for (let end = 0; end <= raw.length; end++) {
      const shown = planProgressText(raw.slice(0, end));
      if (!shown) continue;
      const first = shown.slice(3).split('\n\n2.')[0]!;
      expect(stage.startsWith(first)).toBe(true);
      expect(shown).not.toContain('"stages"');
      expect(shown).not.toContain('"reply"');
    }
    expect(planProgressText(raw)).toBe(`1. ${stage}\n\n2. Verify`);
  });

  it('waits for complete unicode escapes and accepts reply-first property order', () => {
    const raw = '{"reply":"{\\"stages\\":[\\"caf\\u00e9\\"]}","action":"continue"}';
    const end = raw.indexOf('00e9');
    expect(planProgressText(raw.slice(0, end + 2))).toBe('1. caf');
    expect(planProgressText(raw)).toBe('1. café');
  });

  it.each([
    'A plan: {"stages":["invented"]}',
    '{"action":"stop","reply":"{\\"stages\\":[\\"no\\"]}"}',
    '{"action":"continue","reply":"not a stage array"}',
    envelope([123]), envelope([{ text: 'not a string stage' }]),
    '{"action":"continue","reply":"{\\"stages\\":[\\"bad\\q\\"]}"}',
    '{"action":"continue","reply":"{\\"unrelated\\":[\\"no\\"]}"}'
  ])('does not invent stage prose for malformed or unrelated input: %s', raw => {
    expect(planProgressText(raw)).toBe('');
  });

  it('bounds input and preview while retaining the start of the actual stage', () => {
    expect(planProgressText(' '.repeat(64_001))).toBe('');
    const shown = planProgressText(envelope(['x'.repeat(9000), 'Test']));
    expect(shown.length).toBe(8000);
    expect(shown.startsWith('1. xxx')).toBe(true);
  });
});
