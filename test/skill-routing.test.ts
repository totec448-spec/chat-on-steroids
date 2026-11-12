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

it.each(['code-reviewを使って確認して', 'この変更はcode-reviewで確認して', 'このcode-reviewを使って'])(
  'routes a complete literal name next to Japanese particles: %s', authored => {
    expect(routeSkillMetadata(authored, [candidate()]))
      .toEqual([{ id: 'code-review', revision: revision('a') }]);
  }
);

it('routes a complete Japanese display name without requiring spaces around particles', () => {
  expect(routeSkillMetadata('コードレビューを使って確認して', [candidate({ displayName: 'コードレビュー' })]))
    .toEqual([{ id: 'code-review', revision: revision('a') }]);
});

it.each([
  'code-review は使わないで', 'code-reviewを使わずに進めて',
  'コードレビューは使用しないで', 'Do not use Code Review for this task.',
  "Don't use code-review.", 'Never invoke Code Review.', 'Work without using Code Review.',
  '「code-review」は使わないで', 'Code Review must not be used.',
  'code-reviewを使ってはいけない', 'code-reviewは使うな', 'code-reviewを使用せずに進めて'
])('does not auto-select a directly excluded Skill: %s', authored => {
  expect(routeSkillMetadata(authored, [candidate({ displayName: 'コードレビュー' })])).toEqual([]);
});

it.each([
  'Use Code Review to check why the tests do not pass.',
  'Do not deploy; use Code Review first.',
  'Do not skip Code Review.',
  'code-reviewを使って失敗しないように確認して'
])('does not mistake unrelated or double negation for a Skill exclusion: %s', authored => {
  expect(routeSkillMetadata(authored, [candidate()]))
    .toEqual([{ id: 'code-review', revision: revision('a') }]);
});

it.each([
  'precode-reviewを使って', 'code-reviewerを使って', 'コードレビュー支援を使って', 'code-review𠮷を使って',
  'pre-code-review', 'code-review-helper', 'pre--code-review', 'code-review--helper'
])(
  'does not match a partial Skill name inside a longer name: %s', authored => {
    expect(routeSkillMetadata(authored, [candidate({ displayName: 'コードレビュー' })])).toEqual([]);
  }
);

// Characterize the existing finite vocabulary before consolidating its repeated definitions.
it.each([
  ['use', 'using', 'used'], ['invoke', 'invoking', 'invoked'], ['run', 'running', 'run'],
  ['apply', 'applying', 'applied'], ['select', 'selecting', 'selected']
])('preserves every supported usage form for %s', (base, gerund, passive) => {
  for (const text of [
    `Do not ${base} Code Review`, `Don't ${base} Code Review`, `Don’t ${base} Code Review`,
    `Never ${base} the Code Review`, `Avoid ${gerund} Code Review`, `Without ${gerund} Code Review`,
    ...['should', 'must', 'will', 'can'].map(modal => `Code Review ${modal} not be ${passive}`)
  ]) expect(routeSkillMetadata(text, [candidate()]), text).toEqual([]);
  expect(routeSkillMetadata(`Please ${base} Code Review`, [candidate()]))
    .toEqual([{ id: 'code-review', revision: revision('a') }]);
  // A usage verb can itself be the beginning of the full literal Skill identity.
  for (const form of [base, gerund]) {
    const skill = candidate({ id: `${form}-checklist`, name: `${form} checklist` });
    const negative = form === base ? 'Do not' : 'Avoid';
    expect(routeSkillMetadata(`${negative} ${form} checklist`, [skill])).toEqual([]);
    expect(routeSkillMetadata(`Do not skip ${form} checklist`, [skill]))
      .toEqual([{ id: skill.id, revision: skill.revision }]);
  }
});

it.each(['から', 'なら', 'では', 'には', 'とは', 'を', 'で', 'に', 'は', 'が', 'と', 'も', 'の', 'へ'])(
  'preserves the shared Japanese particle boundary on either side: %s', particle => {
    for (const text of [`変更${particle}code-review`, `code-review${particle}確認`]) {
      expect(routeSkillMetadata(text, [candidate()]), text)
        .toEqual([{ id: 'code-review', revision: revision('a') }]);
    }
  }
);

it.each(['ではなく', 'じゃなく'])(
  'preserves the before-only Japanese replacement boundary: %s', particle => {
    expect(routeSkillMetadata(`他の方法${particle}code-review`, [candidate()]))
      .toEqual([{ id: 'code-review', revision: revision('a') }]);
    expect(routeSkillMetadata(`code-review${particle}他の方法`, [candidate()])).toEqual([]);
  }
);

it.each(['"', "'", '`', '「', '『', '('])('preserves quoted exclusions: %s', opening => {
  const closing = ({ '「': '」', '『': '』', '(': ')' } as Record<string, string>)[opening] ?? opening;
  for (const text of [
    `Do not use ${opening}Code Review${closing}`,
    `${opening}code-review${closing}は使わないで`,
    `${opening}code-review${closing}ではなく他の方法`,
    `${opening}Code Review${closing} must not be used`
  ]) expect(routeSkillMetadata(text, [candidate()]), text).toEqual([]);
});

it('keeps a separated dash usable and does not confuse a shorter hyphen-prefix identity', () => {
  const short = candidate({ id: 'code', name: 'Code', revision: revision('b') });
  expect(routeSkillMetadata('Use code-review - check this change.', [candidate(), short]))
    .toEqual([{ id: 'code-review', revision: revision('a') }]);
});

it.each(['', ' \t\n', '---'])('selects nothing for empty or separator-only input: %j', authored => {
  expect(routeSkillMetadata(authored, [candidate()])).toEqual([]);
});

it('handles a large failed exclusion match without suppressing the named Skill', () => {
  const authored = `Do not use${' '.repeat(20_000)}x Code Review`;
  expect(routeSkillMetadata(authored, [candidate()]))
    .toEqual([{ id: 'code-review', revision: revision('a') }]);
});

it('handles near-limit repeated mentions and still honors a final exclusion', () => {
  const phrase = 'Use code-review. ';
  const authored = phrase.repeat(Math.floor(95_000 / phrase.length));
  expect(routeSkillMetadata(authored, [candidate()]))
    .toEqual([{ id: 'code-review', revision: revision('a') }]);
  expect(routeSkillMetadata(authored + 'Do not use code-review.', [candidate()])).toEqual([]);
});

it('keeps a direct exclusion across a large whitespace gap without a context-window cutoff', () => {
  expect(routeSkillMetadata(`Do not use${' '.repeat(20_000)}Code Review`, [candidate()])).toEqual([]);
});

it('keeps a directly excluded Skill out even when another mention is positive', () => {
  expect(routeSkillMetadata('Use Code Review. Do not use code-review.', [candidate()])).toEqual([]);
});

it('can route one requested Skill while excluding another named Skill', () => {
  const audit = candidate({ id: 'security-audit', name: 'Security Audit', revision: revision('b') });
  expect(routeSkillMetadata('Do not use Code Review; use Security Audit.', [candidate(), audit]))
    .toEqual([{ id: audit.id, revision: audit.revision }]);
  expect(routeSkillMetadata('code-reviewではなくsecurity-auditを使って', [candidate(), audit]))
    .toEqual([{ id: audit.id, revision: audit.revision }]);
});

it.each([
  'Do not use code-review or security-audit.',
  'Do not use code-review, security-audit.',
  'code-reviewとsecurity-auditは使わないで',
  'code-reviewもsecurity-auditも使わないで',
  'code-review、security-auditを使用しないで'
])('excludes every Skill in an explicitly excluded list: %s', authored => {
  const audit = candidate({ id: 'security-audit', name: 'Security Audit', revision: revision('b') });
  expect(routeSkillMetadata(authored, [candidate(), audit])).toEqual([]);
});

it('retains excluded list context from a Skill that does not allow implicit invocation', () => {
  const audit = candidate({ id: 'security-audit', name: 'Security Audit', revision: revision('b') });
  expect(routeSkillMetadata('Do not use Code Review or Security Audit.', [
    candidate({ allowImplicitInvocation: false }), audit
  ])).toEqual([]);
});

it('does not propagate an exclusion across a new invocation clause', () => {
  const audit = candidate({ id: 'security-audit', name: 'Security Audit', revision: revision('b') });
  expect(routeSkillMetadata('Do not use Code Review, use Security Audit.', [candidate(), audit]))
    .toEqual([{ id: audit.id, revision: audit.revision }]);
  expect(routeSkillMetadata('code-reviewは使わないで、security-auditを使って', [candidate(), audit]))
    .toEqual([{ id: audit.id, revision: audit.revision }]);
});

it.each([
  'Do not use Code Review, use git worktrees',
  'Do not use Code Review, and use git worktrees',
  'Do not use Code Review、use git worktrees'
])('separates a new using→use alias invocation from an excluded list: %s', authored => {
  const worktrees = candidate({ id: 'using-git-worktrees', name: 'Using Git Worktrees' });
  expect(routeSkillMetadata(authored, [candidate(), worktrees]))
    .toEqual([{ id: worktrees.id, revision: worktrees.revision }]);
});

it.each([
  'Do not use Code Review; do not use git worktrees',
  'Do not use Code Review, Using Git Worktrees',
  'Do not use Code Review, or use git worktrees',
  'Do not use Code Review, use-git-worktrees'
])('retains direct or coordinated exclusions for using-style names: %s', authored => {
  const worktrees = candidate({ id: 'using-git-worktrees', name: 'Using Git Worktrees' });
  expect(routeSkillMetadata(authored, [candidate(), worktrees])).toEqual([]);
});

it('does not mistake an ordinary verb-leading name for an invocation alias', () => {
  const cases = candidate({ id: 'use-cases', name: 'Use Cases' });
  expect(routeSkillMetadata('Do not use Code Review, Use Cases', [candidate(), cases])).toEqual([]);
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
  "Don't use git worktrees", 'Never use git worktrees', 'Do not use git worktrees',
  'avoid using git worktrees', 'Do not use Using Git Worktrees', 'Do not use the Using Git Worktrees'
])('excludes a negated using→use alias or full name: %s', authored => {
  expect(routeSkillMetadata(authored, publicSkills)).toEqual([]);
});

it('keeps positive aliases and unrelated negation while handling verb-leading Skill names', () => {
  expect(routeSkillMetadata('Do not skip using git worktrees', publicSkills))
    .toEqual([{ id: 'using-git-worktrees', revision: revision('a') }]);
  const skill = candidate({ id: 'use-cases', name: 'Use Cases' });
  expect(routeSkillMetadata("Don't use Use Cases", [skill])).toEqual([]);
  const run = candidate({ id: 'run-tests', name: 'Run Tests' });
  expect(routeSkillMetadata('Do not run tests', [run])).toEqual([]);
  expect(routeSkillMetadata('Do not use Run Tests', [run])).toEqual([]);
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
