import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// The meter's Pro rule reads the model picker. A state update painted the meter before the picker
// took that state, so for one paint a Pro chat could fill toward a compaction point it never uses.
it('paints the context meter only after the model picker took the new state', () => {
  const chat = readFileSync('src/renderer/chat.ts', 'utf8');
  const apply = chat.slice(chat.indexOf('export function chatApply('), chat.indexOf('\n}\n', chat.indexOf('export function chatApply(')));
  const picker = apply.indexOf('applyChatModels(config, previous)');
  const meter = apply.indexOf('paintContextMeter(');
  expect(picker).toBeGreaterThan(0);
  expect(meter).toBeGreaterThan(picker);
});
