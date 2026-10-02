import { expect, it } from 'vitest';
import { unifiedDiffLines } from '../src/renderer/unified-diff.js';

it('aligns old and new gutters through replacement, insertion and deletion', () => {
  const result = unifiedDiffLines('one\ntwo\nthree\n', 'one\nchanged\nnew\nthree\n');
  expect(result.lines.map(({ kind, old, next, text }) => [kind, old, next, text])).toEqual([
    ['context', 1, 1, 'one'], ['removed', 2, null, 'two'], ['added', null, 2, 'changed'], ['added', null, 3, 'new'], ['context', 3, 4, 'three']
  ]);
  expect(result.truncated).toBe(false);
});
it('shows creation and deletion from exact snapshots including a missing final newline', () => {
  expect(unifiedDiffLines('', 'hello').lines.filter(line => line.kind === 'added').map(line => line.text)).toEqual(['hello']);
  expect(unifiedDiffLines('hello', '').lines.filter(line => line.kind === 'removed').map(line => line.text)).toEqual(['hello']);
});
it('bounds rendered lines and folds long unchanged context without changing line identities', () => {
  const source = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const result = unifiedDiffLines(source, source.replace('line 50', 'edited 50'));
  expect(result.lines.some(line => line.kind === 'gap')).toBe(true);
  expect(result.lines.find(line => line.kind === 'added')?.next).toBe(51);
  expect(unifiedDiffLines('', 'line\n'.repeat(5000)).lines).toHaveLength(600);
  expect(unifiedDiffLines('', 'line\n'.repeat(5000)).truncated).toBe(true);
});
