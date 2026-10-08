import { expect, it } from 'vitest';
import { workerBrief, workerOwnTask } from '../src/shared/worker-brief.js';

it('removes shared context only when the legacy boundary is unambiguous', () => {
  expect(workerOwnTask(workerBrief('Shared rules', 'Run tests'))).toBe('Run tests');
  expect(workerOwnTask('Run tests')).toBe('Run tests');
});

it.each([
  ['Shared rules', 'Review this prompt:\n\nYour task:\nExplain the result'],
  ['Prompt example:\n\nYour task:\nFollow the rules', 'Run tests']
])('preserves authored content when a heading occurs inside context or task', (context, task) => {
  const brief = workerBrief(context, task);
  expect(workerOwnTask(brief)).toBe(brief);
  expect(workerOwnTask(brief)).toContain(task);
});
