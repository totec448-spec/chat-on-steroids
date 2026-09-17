/**
 * Port of `codex-rs/apply-patch/src/file_update.rs`.
 *
 * Codex also derives a unified diff here (via the `similar` crate) for its approval UI and patch
 * events. Nothing in that path is model-visible and neither system is in scope, so this port
 * keeps only `derive_new_contents_from_chunks` — the half that decides what the file becomes and
 * produces every content-related error the model sees.
 */

import { ApplyPatchError } from './errors.js';
import type { UpdateFileChunk } from './hunk.js';
import type { ApplyPatchFileUpdateMode } from './mode.js';
import { seekSequence } from './seek-sequence.js';
import { SourceFile, type Replacement } from './text-file.js';
import { readFileText } from '../filesystem.js';

/** `AppliedPatch`. */
export interface AppliedPatch {
  originalContents: string;
  newContents: string;
}

/**
 * Return *only* the new file contents (joined into a single string) after applying the chunks to
 * the file at `path`.
 *
 * `baseContents` is a deviation from upstream, which always reads the file. Upstream's applier
 * calls this once per hunk and writes in between, so a second `*** Update File:` hunk for one
 * path reads back what the first one wrote. `verifyApplyPatchArgs` dry-runs the same hunks
 * without writing anything, and passes that intermediate text here instead so the two agree; see
 * the comment on the repeat in `index.ts`. Every other caller omits it and reads from disk.
 */
export async function deriveNewContentsFromChunks(
  path: string,
  chunks: readonly UpdateFileChunk[],
  updateFileMode: ApplyPatchFileUpdateMode,
  baseContents?: string
): Promise<AppliedPatch> {
  let originalContents: string;
  if (baseContents !== undefined) {
    originalContents = baseContents;
  } else {
    try {
      originalContents = await readFileText(path);
    } catch (error) {
      throw ApplyPatchError.io(`Failed to read file to update ${path}`, error);
    }
  }

  let newContents: string;
  if (updateFileMode === 'normalize_to_lf') {
    const originalLines = originalContents.split('\n');

    // Drop the trailing empty element that results from the final newline so that line counts
    // match the behaviour of standard `diff`.
    if (originalLines.at(-1) === '') originalLines.pop();

    const replacements = computeReplacements(originalLines, path, chunks, updateFileMode);
    const newLines = applyReplacements(originalLines, replacements);
    if (newLines.at(-1) !== '') newLines.push('');
    newContents = newLines.join('\n');
  } else {
    const sourceFile = SourceFile.parse(originalContents);
    const originalLines = sourceFile.lineTexts();
    const replacements = computeReplacements(originalLines, path, chunks, updateFileMode);
    sourceFile.applyReplacements(replacements);
    newContents = sourceFile.intoContents();
  }

  return { originalContents, newContents };
}

/** Diagnostics only: never retry a replacement at a different location. */
function matchFailure(
  heading: string,
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  mode: ApplyPatchFileUpdateMode,
  contextIndex: number | null = null
): ApplyPatchError {
  const clip = (line: string): string => line.length > 240 ? `${line.slice(0, 240)}…` : line;
  const earlier = start > 0 ? seekSequence(lines, pattern, 0, false, mode) : null;
  const outOfOrder = earlier !== null && earlier < start;
  const guidance = outOfOrder
    ? `Matching text exists at line ${earlier + 1}, before the current search position at line ${start + 1}. Put edits in file order and avoid overlapping hunks.`
    : 'Use the current file text as patch context; do not reconstruct or reformat the old lines.';
  const expected = pattern.slice(0, 8).map(clip).join('\n') + (pattern.length > 8 ? '\n… (expected text truncated)' : '');

  // A matched @@ context or a unique literal anchor can locate a useful excerpt. Never
  // choose a vaguely similar block or dump the file start when there is no reliable anchor.
  let anchor = outOfOrder ? earlier : contextIndex;
  if (anchor === null) {
    for (const candidate of pattern.slice(0, 12)) {
      const text = candidate.trim();
      if (text.length < 8) continue;
      const first = lines.findIndex(line => line.trim() === text);
      if (first !== -1 && !lines.some((line, index) => index > first && line.trim() === text)) {
        anchor = first;
        break;
      }
    }
  }
  let sourceContext: string | undefined;
  if (anchor !== null) {
    const from = Math.max(0, anchor - 2);
    const excerpt = lines.slice(from, from + 8).map((line, index) => `${from + index + 1}\t${clip(line)}`);
    sourceContext = `Source excerpt from the patch verification snapshot (line numbers are not file content):\n${excerpt.join('\n')}`;
  }
  return ApplyPatchError.computeReplacements(`${heading}\n${guidance}\nExpected text:\n${expected}`, sourceContext);
}

/**
 * Compute a list of replacements needed to transform `originalLines` into the new lines, given
 * the patch `chunks`. Each replacement is returned as `[startIndex, oldLength, newLines]`.
 */
function computeReplacements(
  originalLines: readonly string[],
  path: string,
  chunks: readonly UpdateFileChunk[],
  updateFileMode: ApplyPatchFileUpdateMode
): Replacement[] {
  const replacements: Replacement[] = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    let contextIndex: number | null = null;
    // If a chunk has a `changeContext`, we use seekSequence to find it, then adjust our
    // `lineIndex` to continue from there.
    if (chunk.changeContext !== null) {
      const contextLine = chunk.changeContext;
      const index = seekSequence(originalLines, [contextLine], lineIndex, false, updateFileMode);
      if (index === null) {
        throw matchFailure(`Failed to find context in ${path}:`, originalLines, [contextLine], lineIndex, updateFileMode);
      }
      contextIndex = index;
      lineIndex = index + 1;
    }

    if (chunk.oldLines.length === 0) {
      // Preserve the legacy split representation's handling of a final empty line. `SourceFile`
      // only exposes real source lines, so its insertion point is always after the final line.
      let insertionIndex: number;
      if (updateFileMode === 'normalize_to_lf') {
        insertionIndex = originalLines.at(-1) === '' ? originalLines.length - 1 : originalLines.length;
      } else {
        insertionIndex = originalLines.length;
      }
      replacements.push([insertionIndex, 0, [...chunk.newLines]]);
      continue;
    }

    // Otherwise, try to match the existing lines in the file with the old lines from the chunk.
    // In many real-world diffs the last element of `oldLines` is an *empty* string representing
    // the terminating newline of the region being replaced. That sentinel is not present in
    // `originalLines`, so if a direct search fails and the pattern ends with an empty string,
    // retry without that final element.
    let pattern: readonly string[] = chunk.oldLines;
    let newSlice: readonly string[] = chunk.newLines;
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile, updateFileMode);

    if (found === null && pattern.at(-1) === '') {
      pattern = pattern.slice(0, pattern.length - 1);
      if (newSlice.at(-1) === '') newSlice = newSlice.slice(0, newSlice.length - 1);
      found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile, updateFileMode);
    }

    if (found === null) {
      throw matchFailure(`Failed to find expected lines in ${path}:`, originalLines, pattern, lineIndex, updateFileMode, contextIndex);
    }

    const startIndex = found;
    if (updateFileMode === 'normalize_to_lf') {
      replacements.push([startIndex, pattern.length, [...newSlice]]);
    } else {
      // Context lines occur in both sides of a patch chunk. Keep those original lines in place so
      // their exact contents and terminators survive, especially when the file has mixed line
      // endings.
      let oldStart = 0;
      let newStart = 0;
      for (const [oldContext, newContext] of chunk.contextLineIndices) {
        // A trailing empty context line can be removed from `pattern` and `newSlice` above when
        // it represents the final newline.
        if (oldContext >= pattern.length || newContext >= newSlice.length) break;
        if (oldStart !== oldContext || newStart !== newContext) {
          replacements.push([
            startIndex + oldStart,
            oldContext - oldStart,
            newSlice.slice(newStart, newContext)
          ]);
        }
        oldStart = oldContext + 1;
        newStart = newContext + 1;
      }
      if (oldStart !== pattern.length || newStart !== newSlice.length) {
        replacements.push([startIndex + oldStart, pattern.length - oldStart, newSlice.slice(newStart)]);
      }
    }
    lineIndex = startIndex + pattern.length;
  }

  // Rust's `sort_by_key` is stable, as is `Array.prototype.sort`.
  replacements.sort((left, right) => left[0] - right[0]);

  return replacements;
}

/**
 * Apply the `[startIndex, oldLength, newLines]` replacements to `lines`, returning the modified
 * file contents as an array of lines.
 */
function applyReplacements(lines: readonly string[], replacements: readonly Replacement[]): string[] {
  const result = [...lines];
  // We must apply replacements in descending order so that earlier replacements don't shift the
  // positions of later ones.
  for (let index = replacements.length - 1; index >= 0; index--) {
    const [startIndex, oldLength, newSegment] = replacements[index] as Replacement;

    // Remove old lines.
    for (let removed = 0; removed < oldLength; removed++) {
      if (startIndex < result.length) result.splice(startIndex, 1);
    }

    // Insert new lines.
    result.splice(startIndex, 0, ...newSegment);
  }

  return result;
}
