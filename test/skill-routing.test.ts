import { expect, it } from 'vitest';
import { routeSkillMetadata, type SkillRoutingMetadata } from '../src/shared/skill-routing.js';

const revision = (digit: string) => digit.repeat(64);
const candidate = (overrides: Partial<SkillRoutingMetadata> = {}): SkillRoutingMetadata => ({
  id: 'code-review', revision: revision('a'), name: 'Code Review',
  description: 'Review source code changes for correctness and maintainability.',
  allowImplicitInvocation: true, ...overrides
});

// Representative metadata for names discussed in the maintainer's review, not the complete
// external 48-Skill corpus. Description prose must never act as exact-name routing evidence.
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
  candidate({
    id: 'migrating-dagster-to-airflow', revision: revision('e'), name: 'migrating-dagster-to-airflow',
    displayName: 'Dagster to Airflow Migration',
    description: 'Migrate Dagster pipelines to Airflow while preserving scheduling and orchestration behavior.'
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

it('routes one literal normalized Skill name and carries its exact published revision', () => {
  expect(routeSkillMetadata('Please use Code-Review for this change.', [candidate()]))
    .toEqual([{ id: 'code-review', revision: revision('a') }]);
});

it('returns none for unnamed, ambiguous, or implicit-disabled metadata', () => {
  const task = 'Please use Code Review for this change.';
  expect(routeSkillMetadata('Prepare a quarterly budget summary.', [candidate()])).toEqual([]);
  expect(routeSkillMetadata(task, [candidate(), candidate({ id: 'source-review', revision: revision('b'), name: 'Code Review' })])).toEqual([]);
  expect(routeSkillMetadata(task, [candidate({ allowImplicitInvocation: false })])).toEqual([]);
});

it.each(['Code/Review', 'Code+Review', 'Code.Review', 'Code_Review'])(
  'does not normalize non-hyphen punctuation into the different name %s', mention => {
    expect(routeSkillMetadata(`Use ${mention} for this change.`, [candidate()])).toEqual([]);
  }
);

it('keeps diacritics in names while accepting canonically equivalent Unicode', () => {
  const skill = candidate({ id: 'locale-audit', name: 'Café Review' });
  expect(routeSkillMetadata('Use Cafe Review for this change.', [skill])).toEqual([]);
  expect(routeSkillMetadata('Use Cafe\u0301 Review for this change.', [skill]))
    .toEqual([{ id: skill.id, revision: skill.revision }]);
});

it('keeps literal punctuation inside a complete display name', () => {
  const skill = candidate({ id: 'cpp-audit', name: 'C++ Review' });
  expect(routeSkillMetadata('Use C Review for this change.', [skill])).toEqual([]);
  expect(routeSkillMetadata('Use C++ Review.', [skill]))
    .toEqual([{ id: skill.id, revision: skill.revision }]);
});

const maintainerTable = [
  {
    message: 'Draft a plan for migrating our app from REST to GraphQL.',
    reviewedPick: 'migrating-dagster-to-airflow', reviewedExpected: null, option1Expected: null,
    kind: 'semantic paraphrase'
  },
  {
    message: 'Help me migrate this Dagster pipeline to Airflow.',
    reviewedPick: null, reviewedExpected: 'migrating-dagster-to-airflow', option1Expected: null,
    kind: 'semantic paraphrase; exact-name mode intentionally abstains'
  },
  {
    message: 'Use git worktrees to work on two branches at once.',
    reviewedPick: null, reviewedExpected: 'using-git-worktrees', option1Expected: 'using-git-worktrees',
    kind: 'maintainer-suggested literal using→use name alias'
  },
  {
    message: 'Lets brainstorm ideas for the onboarding flow.',
    reviewedPick: null, reviewedExpected: 'brainstorming', option1Expected: null,
    kind: 'semantic/morphological paraphrase; exact-name mode intentionally abstains'
  },
  {
    message: 'Review my airflow DAG for scheduling problems.',
    reviewedPick: null, reviewedExpected: 'an Airflow Skill', option1Expected: null,
    kind: 'domain wording without one exact Skill name'
  },
  {
    message: 'Use systematic debugging to find why this test fails.',
    reviewedPick: 'systematic-debugging', reviewedExpected: 'systematic-debugging', option1Expected: 'systematic-debugging',
    kind: 'literal normalized Skill name'
  }
] as const;

it.each(maintainerTable)(
  'implements option 1 for the maintainer table: $message [$kind]',
  ({ message, option1Expected }) => {
    const routed = routeSkillMetadata(message, publicSkills);
    if (!option1Expected) expect(routed).toEqual([]);
    else {
      const match = publicSkills.find(skill => skill.id === option1Expected)!;
      expect(routed).toEqual([{ id: match.id, revision: match.revision }]);
    }
  }
);

it('matches full id/name/display-name phrases after case and hyphen/space normalization only', () => {
  expect(routeSkillMetadata('Use SYSTEMATIC-DEBUGGING for this failure.', publicSkills))
    .toEqual([{ id: 'systematic-debugging', revision: revision('d') }]);
  expect(routeSkillMetadata('Use migrating dagster to airflow for this pipeline.', publicSkills))
    .toEqual([{ id: 'migrating-dagster-to-airflow', revision: revision('e') }]);
  expect(routeSkillMetadata('Use Dagster-to-Airflow Migration for this pipeline.', publicSkills))
    .toEqual([{ id: 'migrating-dagster-to-airflow', revision: revision('e') }]);
  expect(routeSkillMetadata('Use brainstorming for the onboarding flow.', publicSkills))
    .toEqual([{ id: 'brainstorming', revision: revision('c') }]);
});

it('supports only the maintainer-suggested complete using→use alias and never partial/gapped identity words', () => {
  expect(routeSkillMetadata('Use git worktrees to work on two branches at once.', publicSkills))
    .toEqual([{ id: 'using-git-worktrees', revision: revision('a') }]);
  expect(routeSkillMetadata('Use git feature worktrees to work on two branches.', publicSkills)).toEqual([]);
  expect(routeSkillMetadata('Explain how git rebase works compared to merge.', publicSkills)).toEqual([]);
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

it('treats multiple literal identity matches as ambiguity instead of choosing one', () => {
  expect(routeSkillMetadata('Use Code Review for this change.', [
    candidate(),
    candidate({ id: 'review-helper', revision: revision('b'), name: 'Review Helper', displayName: 'Code Review' })
  ])).toEqual([]);
});
