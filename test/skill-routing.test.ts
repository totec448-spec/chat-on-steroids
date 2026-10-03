import { expect, it } from 'vitest';
import { routeSkillMetadata, type SkillRoutingMetadata } from '../src/shared/skill-routing.js';

const revision = (digit: string) => digit.repeat(64);
const candidate = (overrides: Partial<SkillRoutingMetadata> = {}): SkillRoutingMetadata => ({
  id: 'code-review', revision: revision('a'), name: 'Code Review',
  description: 'Review source code changes for correctness and maintainability.',
  allowImplicitInvocation: true, ...overrides
});

// Public metadata used by the maintainer's matcher review. Keep these descriptions realistic so
// the regression protects routing against the same noisy metadata users actually install.
const publicSkills: SkillRoutingMetadata[] = [
  candidate({
    id: 'airflow-plugins', revision: revision('b'), name: 'airflow-plugins',
    description: 'Builds Airflow 3.1+ plugins that embed FastAPI apps, custom UI pages, React components, middleware, macros, and operator links directly into the Airflow UI. Use when building anything custom inside Airflow 3.1+ that involves Python and a browser-facing interface - creating an Airflow plugin, adding a custom UI page or nav entry, building FastAPI-backed endpoints inside Airflow, serving static assets from a plugin, embedding a React app, adding middleware to the API server, creating custom operator extra links, or calling the Airflow REST API from inside a plugin; also when AirflowPlugin, fastapi_apps, external_views, react_apps, or plugin registration come up.'
  }),
  candidate({
    id: 'brainstorming', revision: revision('c'), name: 'brainstorming',
    description: 'You MUST use this before any creative work - creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements and design before implementation.'
  }),
  candidate({
    id: 'systematic-debugging', revision: revision('d'), name: 'systematic-debugging',
    description: 'Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes'
  })
];

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

it('does not route from generic description overlap without a Skill identity term', () => {
  expect(routeSkillMetadata('Why does my React component render twice when the state changes?', publicSkills)).toEqual([]);
});

it('stems natural task wording into public Skill identities', () => {
  expect(routeSkillMetadata('I want to brainstorm names for my new coffee shop', publicSkills))
    .toEqual([{ id: 'brainstorming', revision: revision('c') }]);
  expect(routeSkillMetadata('Debug Windows build failure', publicSkills))
    .toEqual([{ id: 'systematic-debugging', revision: revision('d') }]);
});
