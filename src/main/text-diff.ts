/**
 * A unified diff of two texts, as `git diff` writes its hunks: three lines of context and
 * `@@ -a,b +c,d @@` headers, without the file header lines. The Goal step reviewer reads it
 * (#1832); every model knows the format.
 *
 * Common leading and trailing lines are trimmed first, as in `diffstat.ts`. The block between is
 * compared line by line with a longest common subsequence while that stays small; a larger
 * rewrite is written as its old lines removed and its new lines added, which is still a true
 * diff, only a coarser one.
 */

const CONTEXT = 3;
/** Largest middle block (old lines × new lines) compared line by line; about 800 × 800. */
const LCS_CELLS = 640_000;

interface Op { kind: ' ' | '-' | '+'; text: string }

function split(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function middle(a: readonly string[], b: readonly string[]): Op[] {
  const removed = a.map((text): Op => ({ kind: '-', text }));
  const added = b.map((text): Op => ({ kind: '+', text }));
  if (!a.length || !b.length || a.length * b.length > LCS_CELLS) return [...removed, ...added];
  const width = b.length + 1;
  // Suffix LCS lengths; values stay below 800 since the product is bounded.
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1
        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push({ kind: ' ', text: a[i]! }); i++; j++; }
    else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) ops.push({ kind: '-', text: a[i++]! });
    else ops.push({ kind: '+', text: b[j++]! });
  }
  while (i < a.length) ops.push({ kind: '-', text: a[i++]! });
  while (j < b.length) ops.push({ kind: '+', text: b[j++]! });
  return ops;
}

/** The hunks between `before` and `after`; empty when they are the same lines. */
export function unifiedDiff(before: string, after: string): string {
  const a = split(before), b = split(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const ops: Op[] = [
    ...a.slice(0, start).map((text): Op => ({ kind: ' ', text })),
    ...middle(a.slice(start, a.length - end), b.slice(start, b.length - end)),
    ...a.slice(a.length - end).map((text): Op => ({ kind: ' ', text }))
  ];
  // Old and new lines used up before each op, for the hunk headers.
  const oldBefore: number[] = [], newBefore: number[] = [];
  let oldSeen = 0, newSeen = 0;
  for (const op of ops) {
    oldBefore.push(oldSeen); newBefore.push(newSeen);
    if (op.kind !== '+') oldSeen++;
    if (op.kind !== '-') newSeen++;
  }
  const changed = ops.flatMap((op, index) => op.kind === ' ' ? [] : [index]);
  const hunks: string[] = [];
  for (let k = 0; k < changed.length;) {
    const from = Math.max(0, changed[k]! - CONTEXT);
    let last = changed[k]!;
    while (k + 1 < changed.length && changed[k + 1]! - last <= 2 * CONTEXT + 1) last = changed[++k]!;
    k++;
    const to = Math.min(ops.length, last + CONTEXT + 1);
    const rows = ops.slice(from, to);
    const oldCount = rows.filter(op => op.kind !== '+').length;
    const newCount = rows.filter(op => op.kind !== '-').length;
    const oldStart = oldCount ? oldBefore[from]! + 1 : oldBefore[from]!;
    const newStart = newCount ? newBefore[from]! + 1 : newBefore[from]!;
    hunks.push([`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...rows.map(op => op.kind + op.text)].join('\n'));
  }
  return hunks.join('\n');
}
