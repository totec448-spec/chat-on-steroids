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
  }),
  // Small domain-representative metadata for the second review's misleading names.
  // These summaries are test fixtures, not a claim to replay the maintainer's full 48-Skill corpus.
  ...[
    ['testing-dags', 'Test Airflow DAG tasks and pipelines; investigate failing tasks before deployment.'],
    ['airflow-state-store', 'Inspect state changes for Airflow workflows and task instances.'],
    ['executing-plans', 'Execute an implementation plan and check progress in small steps.'],
    ['debugging-dags', 'Debug failed Airflow DAG tasks and diagnose build failures in pipelines.'],
    ['analyzing-data', 'Analyze data exports and CSV features from warehouse datasets.'],
    ['using-git-worktrees', 'Use Git worktrees for isolated branches before a merge or rebase.'],
    ['checking-freshness', 'Check whether warehouse data is fresh and report anything wrong.'],
    ['profiling-tables', 'Profile database tables to inspect slow SQL queries over large datasets.'],
    ['receiving-code-review', 'Respond to code review feedback before changing a commit.']
  ].map(([id, description]) => candidate({ id: id!, name: id!, description: description! }))
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

it('stems distinctive identities while requiring independent description support', () => {
  expect(routeSkillMetadata('Brainstorm a creative design for a new feature', publicSkills))
    .toEqual([{ id: 'brainstorming', revision: revision('c') }]);
  expect(routeSkillMetadata('Use systematic debugging to investigate unexpected test failure', publicSkills))
    .toEqual([{ id: 'systematic-debugging', revision: revision('d') }]);
});

it.each([
  'Can you fix the failing test in the login form?',
  'Why does my React component render twice when the state changes?',
  'Plan a 3 day trip to Lisbon with a small budget.',
  'Refactor this function and add a test for it.',
  'Help me debug why the build fails on Windows',
  'Create a new feature that lets users export their data as CSV.',
  'Explain how git rebase works compared to merge.',
  'Check my pull request and tell me if anything is wrong.',
  'Optimize this SQL query, it is slow on large tables.',
  'Review the code changes in my last commit before I push.'
])('does not route specialized Skills from common name words: %s', authored => {
  expect(routeSkillMetadata(authored, publicSkills)).toEqual([]);
});

it('prefers no injection when a distinctive name has no supporting description evidence', () => {
  // The precision-first second review requires both signals. An explicit picker/directive
  // remains available for this task; metadata alone does not establish its intended domain.
  expect(routeSkillMetadata('I want to brainstorm names for my new coffee shop', publicSkills)).toEqual([]);
});

it('accepts a full common-word name only with separate supporting description terms', () => {
  expect(routeSkillMetadata('Use profiling tables to inspect slow SQL queries', publicSkills))
    .toEqual([{ id: 'profiling-tables', revision: revision('a') }]);
});

it('keeps precise domain matches and does not count a repeated name as description support', () => {
  expect(routeSkillMetadata('Build an Airflow plugin with Python and FastAPI', publicSkills))
    .toEqual([{ id: 'airflow-plugins', revision: revision('b') }]);
  expect(routeSkillMetadata('Airflow plugins', [publicSkills[0]!])).toEqual([]);
});
