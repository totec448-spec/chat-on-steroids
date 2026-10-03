import { expect, it } from 'vitest';
import { routeSkillMetadata, type SkillRoutingMetadata } from '../src/shared/skill-routing.js';

const revision = (digit: string) => digit.repeat(64);
const candidate = (overrides: Partial<SkillRoutingMetadata> = {}): SkillRoutingMetadata => ({
  id: 'code-review', revision: revision('a'), name: 'Code Review',
  description: 'Review source code changes for correctness and maintainability.',
  allowImplicitInvocation: true, ...overrides
});

it('routes one strong metadata match and carries its exact published revision', () => {
  expect(routeSkillMetadata('Review this source code change for correctness and maintainability.', [candidate()]))
    .toEqual([{ id: 'code-review', revision: revision('a') }]);
});

it('returns none for weak, ambiguous, or implicit-disabled metadata', () => {
  const task = 'Review this source code change for correctness.';
  expect(routeSkillMetadata('Prepare a quarterly budget summary.', [candidate()])).toEqual([]);
  expect(routeSkillMetadata(task, [candidate(), candidate({ id: 'source-review', revision: revision('b'), name: 'Source Review' })])).toEqual([]);
  expect(routeSkillMetadata(task, [candidate({ allowImplicitInvocation: false })])).toEqual([]);
});
