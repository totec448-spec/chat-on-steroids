/**
 * `Hunk`, `UpdateFileChunk` and the patch markers, from `codex-rs/apply-patch/src/parser.rs`.
 *
 * Codex stores paths as `PathBuf` and later resolves them against the turn cwd; here a hunk keeps
 * the path exactly as the patch spelled it, because that spelling is what the summary prints.
 */

export const BEGIN_PATCH_MARKER = '*** Begin Patch';
export const END_PATCH_MARKER = '*** End Patch';
export const ADD_FILE_MARKER = '*** Add File: ';
export const DELETE_FILE_MARKER = '*** Delete File: ';
export const UPDATE_FILE_MARKER = '*** Update File: ';
export const MOVE_TO_MARKER = '*** Move to: ';
export const EOF_MARKER = '*** End of File';
export const CHANGE_CONTEXT_MARKER = '@@ ';
export const EMPTY_CHANGE_CONTEXT_MARKER = '@@';

/** `UpdateFileChunk`. */
export interface UpdateFileChunk {
  /**
   * A single line of context used to narrow down the position of the chunk (this is usually a
   * class, method, or function definition.)
   */
  changeContext: string | null;

  /**
   * A contiguous block of lines that should be replaced with `newLines`. `oldLines` must occur
   * strictly after `changeContext`.
   */
  oldLines: string[];
  newLines: string[];

  /**
   * Pairs of indices into `oldLines` and `newLines` that identify lines parsed as context rather
   * than inferred to be equal by their contents.
   */
  contextLineIndices: Array<[number, number]>;

  /**
   * If set to true, `oldLines` must occur at the end of the source file. (Tolerance around
   * trailing newlines should be encouraged.)
   */
  isEndOfFile: boolean;
}

export function newUpdateFileChunk(): UpdateFileChunk {
  return {
    changeContext: null,
    oldLines: [],
    newLines: [],
    contextLineIndices: [],
    isEndOfFile: false
  };
}

/**
 * `UpdateFileChunk::push_context_line`: adds a context line to both sides while recording its
 * corresponding indices so it remains distinguishable from identical changed lines.
 */
export function pushContextLine(chunk: UpdateFileChunk, line: string): void {
  chunk.contextLineIndices.push([chunk.oldLines.length, chunk.newLines.length]);
  chunk.oldLines.push(line);
  chunk.newLines.push(line);
}

export interface AddFileHunk {
  kind: 'add_file';
  path: string;
  contents: string;
}

export interface DeleteFileHunk {
  kind: 'delete_file';
  path: string;
}

export interface UpdateFileHunk {
  kind: 'update_file';
  path: string;
  movePath: string | null;
  /**
   * Chunks should be in order, i.e. the `changeContext` of one chunk should occur later in the
   * file than the previous chunk.
   */
  chunks: UpdateFileChunk[];
}

/** `Hunk`. */
export type Hunk = AddFileHunk | DeleteFileHunk | UpdateFileHunk;

/**
 * `Hunk::path`: the path affected by this hunk, using the move destination for rename hunks.
 *
 * This is the spelling the patch used, which is what `print_summary` reports.
 */
export function hunkPath(hunk: Hunk): string {
  if (hunk.kind === 'update_file' && hunk.movePath !== null) return hunk.movePath;
  return hunk.path;
}

/** `Vec<Hunk>::clone`: the streaming parser hands out snapshots, not live state. */
export function cloneHunks(hunks: readonly Hunk[]): Hunk[] {
  return hunks.map((hunk) => {
    if (hunk.kind === 'update_file') {
      return {
        ...hunk,
        chunks: hunk.chunks.map((chunk) => ({
          ...chunk,
          oldLines: [...chunk.oldLines],
          newLines: [...chunk.newLines],
          contextLineIndices: chunk.contextLineIndices.map(([left, right]): [number, number] => [left, right])
        }))
      };
    }
    return { ...hunk };
  });
}
