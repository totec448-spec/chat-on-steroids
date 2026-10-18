import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeApplyPatch } from '../src/main/codex/apply-patch/index.js';

// apply_patch keeps each file's own line endings (tools-core always passes
// `preserve_line_endings`). This drives random files and random multi-hunk patches through it
// and compares against a plain model: untouched and context lines keep their exact bytes,
// new lines take the file's first ending, and every line ends up terminated.

type Ending = '\n' | '\r\n' | '\r' | '';
interface Line { text: string; ending: Ending }

/** Small seeded generator, so a failure names a case that reruns identically. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['alpha', 'Zoë', 'größe', '日本', 'tab\there', '  indented', 'x = 1;', 'emoji 🎉', 'trailing  ', '$var', '*** not a marker'];

function makeCase(seed: number): { lines: Line[]; bom: boolean; patch: string; expected: string } {
  const random = generator(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const style = pick(['lf', 'crlf', 'cr', 'mixed'] as const);
  const endingFor = (): Ending => style === 'lf' ? '\n' : style === 'crlf' ? '\r\n' : style === 'cr' ? '\r' : pick(['\n', '\r\n'] as const);
  const count = 1 + Math.floor(random() * 40);
  const lines: Line[] = [];
  for (let index = 0; index < count; index++) {
    // Unique text keeps every context match unambiguous; blank lines are the only repeats and are
    // never used as a hunk's sole anchor.
    const text = random() < 0.12 ? '' : `${index} ${pick(WORDS)}`;
    lines.push({ text, ending: endingFor() });
  }
  if (random() < 0.4) (lines.at(-1) as Line).ending = '';
  const bom = random() < 0.2;
  const preferred: Ending = lines.find(line => line.ending !== '')?.ending ?? '\n';

  // Non-overlapping regions, each with up to two context lines on either side.
  const chunks: string[] = [];
  const result: Line[] = [];
  let cursor = 0;
  // First line the next hunk may use as context: the parser resumes after the previous hunk.
  let free = 0;
  let start = Math.floor(random() * Math.min(5, count));
  while (start < count) {
    const before = Math.min(2, start - free);
    const removed = Math.min(count - start, Math.floor(random() * 3));
    const after = Math.min(2, count - start - removed);
    const added = Array.from({ length: Math.floor(random() * 3) + (removed === 0 ? 1 : 0) }, (_, n) => `new ${seed}.${start}.${n} ${pick(WORDS)}`);
    const contextBefore = lines.slice(start - before, start);
    const contextAfter = lines.slice(start + removed, start + removed + after);
    const anchors = [...contextBefore, ...lines.slice(start, start + removed), ...contextAfter];
    // A hunk anchored only by blank lines could match an earlier blank line; skip that region.
    if (anchors.length === 0 || anchors.every(line => line.text === '')) { start += 1; continue; }
    const body = [
      ...contextBefore.map(line => ` ${line.text}`),
      ...lines.slice(start, start + removed).map(line => `-${line.text}`),
      ...added.map(text => `+${text}`),
      ...contextAfter.map(line => ` ${line.text}`)
    ];
    chunks.push('@@', ...body);
    result.push(...lines.slice(cursor, start));
    result.push(...added.map(text => ({ text, ending: preferred })));
    cursor = start + removed;
    free = cursor + after;
    start = free + 1 + Math.floor(random() * 6);
  }
  result.push(...lines.slice(cursor));
  for (const line of result) if (line.ending === '') line.ending = preferred;

  const patch = ['*** Begin Patch', '*** Update File: file.txt', ...chunks, '*** End Patch'].join('\n');
  const expected = (bom ? '﻿' : '') + result.map(line => line.text + line.ending).join('');
  return { lines, bom, patch, expected };
}

describe('apply_patch keeps line endings on random files and patches', () => {
  let root = '';
  beforeAll(async () => { root = await mkdtemp(path.join(tmpdir(), 'cos-patch-endings-')); });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it('matches the model for 400 seeded cases', async () => {
    const file = path.join(root, 'file.txt');
    for (let seed = 1; seed <= 400; seed++) {
      const { lines, bom, patch, expected } = makeCase(seed);
      if (!patch.includes('\n@@\n')) continue;
      await writeFile(file, (bom ? '﻿' : '') + lines.map(line => line.text + line.ending).join(''));
      const run = await executeApplyPatch({ cwd: root, patch, updateFileMode: 'preserve_line_endings' });
      expect(run.exitCode, `seed ${seed}: ${run.stderr}`).toBe(0);
      expect(JSON.stringify(await readFile(file, 'utf8')), `seed ${seed}`).toBe(JSON.stringify(expected));
    }
  });
});
