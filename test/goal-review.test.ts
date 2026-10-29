import { expect, it } from 'vitest';
import { REVIEW_BRIEF_CHARS, reviewBrief, type ReviewFile } from '../src/main/goal-review.js';

/**
 * #1832: what the Goal step reviewer is told. The step's goal and instruction, then every file the
 * step changed with its provenance and counts, then the net diffs in the order the files were first
 * changed, as many as fit; the rest are named so it reads them itself. It always says which changes
 * it does not see (files changed by commands), and that it only reads.
 */
const file = (path: string, over: Partial<ReviewFile> = {}): ReviewFile => ({
  path, state: 'edited', added: 2, removed: 1, approximate: false, edits: 1, diff: `@@ -1,2 +1,3 @@\n a\n-b\n+B\n+c`, ...over
});

it('gives the goal, the step, each changed file with its counts, and the diffs in order', () => {
  const brief = reviewBrief({ objective: 'Ship the CSV export', step: 'Add the export button and its test.',
    files: [file('src/export.ts'), file('test/export.test.ts', { state: 'created', added: 30, removed: 0, edits: 2 })], more: 0 });
  expect(brief).toContain('Ship the CSV export');
  expect(brief).toContain('Add the export button and its test.');
  expect(brief).toContain('- src/export.ts: edited, +2 −1, 1 edit');
  expect(brief).toContain('- test/export.test.ts: created, +30, 2 edits');
  expect(brief.indexOf('--- a/src/export.ts\n+++ b/src/export.ts\n@@ -1,2 +1,3 @@')).toBeGreaterThan(brief.indexOf('- test/export.test.ts'));
  expect(brief.indexOf('+++ b/src/export.ts')).toBeLessThan(brief.indexOf('+++ b/test/export.test.ts'));
});

it('says what it cannot see, that it only reads, and how to answer', () => {
  const brief = reviewBrief({ objective: 'x', step: 'y', files: [file('a.ts')], more: 0 });
  expect(brief).toMatch(/files changed by commands are not listed/i);
  expect(brief).toMatch(/do not edit, create, move or delete files/i);
  expect(brief).toContain('No problems found.');
  expect(brief).toContain('the review is the RESULT');
  expect(brief).toContain('BLOCKING:');
});

it('names a file whose diff was not recorded, and a file changed and put back, without a diff', () => {
  const brief = reviewBrief({ objective: 'x', step: 'y', more: 0, files: [
    file('big.json', { diff: null, unavailable: 'too-large', approximate: true, added: 900, removed: 850 }),
    file('gone.ts', { diff: null, unavailable: 'not-kept' }),
    file('back.ts', { state: 'unchanged', added: 0, removed: 0, diff: '' })
  ] });
  expect(brief).toContain('- big.json: edited, about +900 −850, 1 edit (diff too large to record: read the file)');
  expect(brief).toContain('- gone.ts: edited, +2 −1, 1 edit (diff not recorded: read the file)');
  expect(brief).toContain('- back.ts: changed and put back, no net change');
  expect(brief).not.toContain('+++ b/big.json');
  expect(brief).not.toContain('+++ b/back.ts');
});

it('stays within its budget: diffs that do not fit are named for reading, never cut mid-line', () => {
  const huge = Array.from({ length: 4000 }, (_, i) => `+line ${i} ${'x'.repeat(20)}`).join('\n');
  const files = [file('first.ts'), file('huge.ts', { diff: `@@ -0,0 +1,4000 @@\n${huge}`, added: 4000, removed: 0 }), file('last.ts')];
  const brief = reviewBrief({ objective: 'o'.repeat(5000), step: 's'.repeat(5000), files, more: 3 });
  expect(brief.length).toBeLessThanOrEqual(REVIEW_BRIEF_CHARS);
  expect(brief).toContain('+++ b/first.ts');
  expect(brief).toContain('+++ b/last.ts');
  expect(brief).toMatch(/huge\.ts[^\n]*read it through Core|Diffs not included[^\n]*huge\.ts/);
  expect(brief).toContain('and 3 more files not listed');
  // The goal and the step are shortened, not dropped.
  expect(brief).toContain('ooo');
  expect(brief).toContain('sss…');
  for (const line of brief.split('\n')) if (line.startsWith('+line ')) expect(line).toMatch(/^\+line \d+ x{20}$/);
});

it('keeps a path that would break the layout on one line', () => {
  const brief = reviewBrief({ objective: 'x', step: 'y', more: 0, files: [file('evil\nname.ts')] });
  expect(brief).toContain('- evil name.ts: edited');
});
