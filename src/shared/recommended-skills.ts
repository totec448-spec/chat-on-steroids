/**
 * Skills that ship with the app and can be installed from the Skills page with one click.
 *
 * They are never installed on their own: the Skills library stays the user's. Installing one
 * writes its SKILL.md to a private temporary folder and imports it through the ordinary,
 * validated package path, so a recommended skill is afterwards indistinguishable from one the
 * user imported and can be edited or removed the same way.
 */
export interface RecommendedSkill {
  /** Folder name and library id once installed. */
  id: string;
  name: string;
  description: string;
  markdown: string;
}

function skill(id: string, name: string, description: string, body: string): RecommendedSkill {
  // Quoted scalars: a description with ": " is otherwise read as a nested YAML mapping (#561).
  return { id, name, description, markdown: `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body.trim()}\n` };
}

export const RECOMMENDED_SKILLS: readonly RecommendedSkill[] = [
  skill('code-review', 'Code review',
    'Review a change for correctness, safety and clarity before it is merged, and report only findings that matter.',
    `
# Code review

Use this when asked to review a diff, a pull request or recently changed files.

## Method

1. **Understand the intent first.** Read the description, the linked issue and the tests. Say in one sentence what the change is meant to do.
2. **Read the whole change**, not just the first file. Note every file touched and why.
3. **Check correctness against the intent.** For each changed function, ask what inputs reach it, what it returns on every path, and what happens on errors, empty values, concurrency and retries.
4. **Check safety.** User input reaching a shell, file path, SQL, HTML or URL; secrets in logs; permissions widened; data deleted or overwritten.
5. **Check the tests.** Does a test fail without the change? Are the edge cases from step 3 covered?
6. **Run what you can:** the tests, the type checker, the linter.

## Reporting

- Report **findings, not impressions.** Each finding names the file and line, the concrete failure ("with an empty list this returns undefined and the caller crashes"), and a suggested fix.
- Order by severity: bugs and security first, then missing tests, then clarity.
- Leave out style preferences the project's formatter would settle, and anything you are not confident about. Five real findings beat twenty maybes.
- If nothing is wrong, say so plainly and mention what you checked.
`),
  skill('debug-systematically', 'Debug systematically',
    'Find the root cause of a bug with evidence before changing code, then fix it with a test that proves it.',
    `
# Debug systematically

Use this for any bug, failing test or unexpected behaviour.

## Rules

- **No fix before a root cause.** A change that makes the symptom disappear without an explanation usually moves the bug.
- Change **one thing at a time.**

## Steps

1. **Reproduce.** Write down the exact steps, input and actual vs expected output. If it does not reproduce reliably, collect more evidence (logs, timing, environment) instead of guessing.
2. **Read the error completely**: message, stack trace, line numbers.
3. **Look at what changed recently**: commits, dependencies, configuration.
4. **Trace the data backwards** from where it goes wrong to where the bad value first appears. Add temporary logging at component boundaries if needed.
5. **State one hypothesis**: "X happens because Y." Test it with the smallest possible experiment.
6. **Fix at the source**, not where the symptom shows. Add a test that fails before the fix and passes after.
7. **Verify**: run the test suite, remove temporary logging, and re-check the original reproduction.

If three fixes in a row fail, stop and question the design instead of trying a fourth.
`),
  skill('test-first-bugfix', 'Test-first bug fix',
    'Fix a bug by first writing a test that reproduces it, then making the smallest change that turns it green.',
    `
# Test-first bug fix

1. Find the project's test framework and how to run a single test.
2. **Write a failing test** that reproduces the bug through the public interface. Run it and confirm it fails *for the right reason* (the bug, not a typo).
3. Make the **smallest code change** that makes the test pass. No unrelated refactoring.
4. Run the whole test suite. Fix anything you broke.
5. Look for **siblings of the bug**: the same mistake elsewhere, or neighbouring edge cases (empty, one, many, very large, unicode, concurrent). Add tests for the ones that apply.
6. Report the root cause in one or two sentences, the test you added, and the suite result.
`),
  skill('commit-and-pr', 'Commit messages and PR descriptions',
    'Write clear commit messages and pull request descriptions that explain what changed and why.',
    `
# Commit messages and PR descriptions

## Commit message

- **Subject**: imperative mood, at most about 60 characters, no trailing period. "Fix login redirect loop", not "Fixed stuff".
- **Body** (after a blank line): *why* the change was needed and what it does, in plain sentences. Mention the user-visible effect and anything a reviewer should know. Wrap at about 72 characters.
- One logical change per commit.

## Pull request description

1. **Problem**: what was wrong or missing, ideally with how to reproduce it.
2. **Change**: what this PR does, at the level of behaviour, not a file list.
3. **Verification**: which tests you ran, what you checked by hand, with results.
4. **Risks and follow-ups**: anything not covered, known limitations.

Keep it short, factual and free of filler. Link the issue it closes.
`),
  skill('explore-codebase', 'Explore an unfamiliar codebase',
    'Build a quick, accurate map of an unfamiliar project before changing it: structure, entry points, conventions and how to run it.',
    `
# Explore an unfamiliar codebase

Use this before making changes in a project you have not seen.

1. **Read the top-level docs**: README, CONTRIBUTING, any AGENTS.md or docs folder.
2. **Find how to build, run and test**: package manifests, Makefile, CI workflow files. Run the tests once to know the baseline.
3. **Map the structure**: list the top-level folders and say what each is for in one line.
4. **Find the entry points**: main files, routes, CLI commands, exported APIs.
5. **Follow one real flow end to end** related to the task, from input to output.
6. **Note the conventions**: naming, error handling, test style, formatting. New code should look like the surrounding code.
7. Summarise the map in under 15 lines before starting work, and say what you still don't know.
`),
  skill('research-with-sources', 'Research with sources',
    'Answer a question by researching current, reliable sources, and cite them so every claim can be checked.',
    `
# Research with sources

1. **Restate the question** and what a good answer must include.
2. **Search broadly, then narrow**: prefer primary sources (official documentation, papers, statements, datasets) over summaries and blogs.
3. **Check dates.** Prefer the most recent authoritative source; say when information may be outdated.
4. **Cross-check** important claims in at least two independent sources. Note disagreements instead of hiding them.
5. **Answer first, then support**: a short direct answer, followed by the key points, each with its source link.
6. Clearly separate **facts, estimates and your own reasoning**. Say "I could not verify this" when that is the case.
`),
  skill('clear-writing', 'Clear writing',
    "Rewrite or draft text so it is clear, concise and easy to act on, while keeping the author's meaning and voice.",
    `
# Clear writing

Use this for emails, documentation, announcements and any text a person will read.

- **Lead with the point.** The first sentence says what the reader needs to know or do.
- **One idea per paragraph**; short sentences; active voice.
- **Concrete over abstract**: numbers, names, dates and examples instead of "various", "some" or "soon".
- **Cut filler**: "in order to", "it is important to note that", "basically", repeated hedges.
- **Match the reader**: explain jargon or remove it; keep the author's tone.
- Use **lists** for steps and options, and **headings** only when the text is long enough to need them.
- End with the **next step** when the text asks for something.

When editing someone else's text, keep their meaning. Point out anything you changed that alters it.
`),
  skill('data-analysis', 'Data analysis',
    'Analyse a CSV, spreadsheet or dataset carefully: inspect it, clean it, answer the question and show how you got there.',
    `
# Data analysis

1. **Inspect before analysing**: row and column counts, column types, a few sample rows, missing values, duplicates, obvious outliers.
2. **Restate the question** in terms of the columns you will use.
3. **Clean transparently**: list every filter, fix or dropped row and why. Never silently drop data.
4. **Compute** with code (Python, SQL or spreadsheet formulas) rather than by eye, and keep the code so it can be rerun.
5. **Sanity-check results**: totals add up, percentages make sense, units are right.
6. **Present**: the answer first, then a small table or chart, then caveats (sample size, missing data, correlation vs causation).
`),
  skill('security-review', 'Security review',
    'Check code or a change for common security problems such as injection, secrets, unsafe file access and weak permissions.',
    `
# Security review

Use this on a change, a module or a small app before it ships.

## Look for

- **Injection**: user input reaching a shell command, SQL, file path, URL, HTML or template without escaping or parameterisation.
- **Secrets**: keys, tokens or passwords in code, logs, error messages, URLs or client-side bundles.
- **File and path access**: path traversal (\`../\`), following symlinks, writing outside an intended folder.
- **Authentication and authorisation**: missing checks, checks only in the UI, IDs that let one user reach another's data.
- **Unsafe defaults**: debug modes, permissive CORS, disabled TLS verification, world-writable files.
- **Dependencies**: known-vulnerable or abandoned packages, unpinned versions.

## Report

For each finding: where, how it could be exploited in one sentence, how bad it is (high, medium, low), and the fix. Do not print working exploit code. If nothing serious is found, say what was checked.
`),
  skill('write-documentation', 'Write documentation',
    'Write or improve a README, guide or reference page that a newcomer can follow without asking questions.',
    `
# Write documentation

1. **Know the reader**: a newcomer, a user or a maintainer. Write for exactly one.
2. **Start with what it is and why it matters**, in two or three sentences.
3. **Quick start first**: the shortest path from nothing to a working result, with copy-pasteable commands.
4. **Then the details**: configuration, common tasks, troubleshooting, reference.
5. **Test every step yourself** where possible; commands and paths must be exactly right.
6. Prefer **examples over explanations**, and keep each section short with clear headings.
7. Note prerequisites, supported versions and where to get help.
`),
  skill('refactor-safely', 'Refactor safely',
    'Improve the structure of existing code without changing what it does, in small verified steps.',
    `
# Refactor safely

1. **Make sure tests cover the behaviour** you are about to touch. If they don't, add characterisation tests first.
2. **One kind of change at a time**: rename, extract, move or simplify, never all at once, and never mixed with new features or bug fixes.
3. **Small steps**, running the tests after each one.
4. **Keep the public interface stable** unless changing it is the goal; update every caller if it changes.
5. Follow the surrounding code's style and patterns.
6. Summarise what moved and why, and confirm that behaviour is unchanged (tests, types, a quick manual check).
`),
  skill('performance-investigation', 'Performance investigation',
    'Find out why something is slow by measuring first, fix the real bottleneck, and prove the improvement with numbers.',
    `
# Performance investigation

1. **Define slow**: which action, how slow now, how fast it needs to be.
2. **Measure before changing anything**: timings, a profiler, query plans, network traces. Reproduce with realistic data.
3. **Find the bottleneck** in the measurement: the part that dominates the time. Ignore everything else for now.
4. **Fix that part**, typically less work (fewer calls, queries or re-renders), caching, better algorithms or indexes, or doing it later.
5. **Measure again** under the same conditions and report before and after numbers.
6. Keep correctness: run the tests, and watch memory and error rates as well as speed.
`),
  skill('upgrade-dependencies', 'Upgrade dependencies',
    'Upgrade a project dependency or runtime safely: read the changelog, change one thing at a time and verify.',
    `
# Upgrade dependencies

1. **List what is outdated** and why each upgrade is wanted (security fix, feature, support ending).
2. **Read the changelog and migration notes** between the current and target version, especially breaking changes.
3. **Upgrade one package (or one related group) at a time.** Commit each separately.
4. **Apply the required code changes**, then run build, type checks and tests.
5. **Check the lockfile diff** for surprising transitive changes.
6. Report what changed, what needed code changes and anything left for later.
`),
  skill('accessibility-review', 'Accessibility review',
    'Check a web page or app screen for accessibility problems: keyboard use, labels, contrast, structure and screen readers.',
    `
# Accessibility review

Check against WCAG 2.2 AA and report concrete fixes.

- **Keyboard**: everything reachable and usable with Tab, Shift+Tab, Enter, Space and arrow keys; a visible focus indicator; no keyboard traps.
- **Names and labels**: every button, link, input and icon-only control has an accessible name; form fields have labels; images have useful alt text (or empty alt if decorative).
- **Structure**: one main heading, logical heading order, landmarks, lists as lists, tables with headers.
- **Contrast and colour**: text at least 4.5:1 (3:1 for large text); meaning is never carried by colour alone.
- **Motion and timing**: respects reduced motion; no content that flashes; timeouts can be extended.
- **Dynamic content**: status messages are announced; dialogs move and trap focus correctly and return it on close.

For each problem: element, impact, fix.
`),
  skill('sql-queries', 'SQL queries',
    'Write, review or optimise SQL queries correctly and safely, with parameters, clear joins and a check of the results.',
    `
# SQL queries

1. **Understand the schema first**: tables, keys, relationships and the database engine.
2. **Write the query step by step**: start from the main table, add joins one at a time, then filters, grouping and ordering.
3. **Always use parameters** for user-supplied values, never string concatenation.
4. **Be explicit**: named columns instead of \`SELECT *\`, explicit join types, table aliases.
5. **Check correctness**: row counts before and after each join (watch for duplication), NULL handling, time zones.
6. **For slow queries**, read the query plan and look for missing indexes or scans on large tables.
7. For changes (\`UPDATE\`, \`DELETE\`), run the matching \`SELECT\` first and use a transaction.
`),
  skill('summarize-documents', 'Summarize documents',
    'Summarise long documents, threads or transcripts accurately: key points, decisions, open questions and action items.',
    `
# Summarize documents

1. **Read everything** before summarising; note the purpose and audience of the source.
2. Lead with a **one-paragraph summary**: what it is about and the most important conclusion.
3. Then **key points** as a short list, in order of importance.
4. Pull out **decisions, action items (with owners and dates) and open questions** separately.
5. **Stay faithful**: no new claims, keep numbers and names exact, mark uncertainty and quote when wording matters.
6. Keep it to about a tenth of the original length unless asked otherwise, and cite sections or timestamps for important points.
`),
  skill('translate-faithfully', 'Translate faithfully',
    'Translate text accurately and naturally, keeping meaning, tone, formatting and terminology consistent.',
    `
# Translate faithfully

1. **Identify the purpose and audience** (UI text, legal, marketing, casual) and match the register.
2. **Keep meaning over word order**: the result should read as if written in the target language.
3. **Preserve formatting and placeholders** exactly: Markdown, HTML tags, code, \`{0}\`-style placeholders, numbers and units.
4. **Keep terminology consistent**; use an existing glossary or earlier translations when there is one.
5. **Do not translate** product names, code identifiers or proper names unless an established translation exists.
6. Flag anything ambiguous or culture-specific instead of guessing silently.
`),
  skill('plan-a-project', 'Plan a project',
    'Turn a goal into a clear, realistic plan: scope, milestones, tasks, risks and a first step that can start today.',
    `
# Plan a project

1. **State the goal and success criteria**: what done looks like and how it will be measured.
2. **Set the scope**: what is in, what is explicitly out.
3. **Break it into milestones**, each delivering something usable, then into tasks small enough to finish in a day or less.
4. **Order by dependencies and risk**: do the uncertain or blocking parts early.
5. **List risks and assumptions** with a mitigation for each.
6. **Estimate roughly** and add a buffer; name who does what if more than one person is involved.
7. End with the **first concrete step** that can start right away.
`)

];
