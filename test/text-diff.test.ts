import { expect, it } from 'vitest';
import { unifiedDiff } from '../src/main/text-diff.js';

/**
 * #1832: the Goal step reviewer reads each changed file's net diff as text. A plain unified diff,
 * the format every model knows, with three lines of context and git's hunk headers.
 */
const lines = (count: number, prefix = 'line') => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';

it('writes one hunk with three lines of context around a change, and git\'s header', () => {
  const before = lines(10);
  const after = before.replace('line 5\n', 'line five\n');
  expect(unifiedDiff(before, after)).toBe([
    '@@ -2,7 +2,7 @@',
    ' line 2', ' line 3', ' line 4', '-line 5', '+line five', ' line 6', ' line 7', ' line 8'
  ].join('\n'));
});

it('splits changes far apart into separate hunks and joins near ones', () => {
  const before = lines(30);
  const far = before.replace('line 3\n', 'line III\n').replace('line 25\n', 'line XXV\n');
  expect(unifiedDiff(before, far).match(/^@@/gm)).toHaveLength(2);
  const near = before.replace('line 3\n', 'line III\n').replace('line 8\n', 'line VIII\n');
  expect(unifiedDiff(before, near).match(/^@@/gm)).toHaveLength(1);
});

it('describes a created and a deleted file, and nothing for no change', () => {
  expect(unifiedDiff('', 'a\nb\n')).toBe('@@ -0,0 +1,2 @@\n+a\n+b');
  expect(unifiedDiff('a\nb\n', '')).toBe('@@ -1,2 +0,0 @@\n-a\n-b');
  expect(unifiedDiff('same\n', 'same\n')).toBe('');
});

it('keeps interleaved edits in order inside one block', () => {
  const diff = unifiedDiff('a\nb\nc\nd\n', 'a\nB\nc\nD\ne\n');
  expect(diff).toBe('@@ -1,4 +1,5 @@\n a\n-b\n+B\n c\n-d\n+D\n+e');
});

it('treats Windows line ends like Unix ones, so a file is not "all changed" by them', () => {
  expect(unifiedDiff('a\r\nb\r\nc\r\n', 'a\nB\nc\n')).toBe('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c');
});

it('stays correct and quick on a large rewrite, falling back to remove-then-add for the block', () => {
  const before = lines(3000, 'old');
  const after = lines(3000, 'new');
  const started = Date.now();
  const diff = unifiedDiff(before, after);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(diff.startsWith('@@ -1,3000 +1,3000 @@\n-old 1\n')).toBe(true);
  expect(diff.split('\n').filter(line => line.startsWith('-'))).toHaveLength(3000);
  expect(diff.split('\n').filter(line => line.startsWith('+'))).toHaveLength(3000);
});
