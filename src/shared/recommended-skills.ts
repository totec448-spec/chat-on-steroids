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
  return { id, name, description, markdown: `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n` };
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
`)
];
