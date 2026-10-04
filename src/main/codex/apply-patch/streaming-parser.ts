/**
 * Port of `codex-rs/apply-patch/src/streaming_parser.rs`.
 *
 * This is the real grammar engine behind `apply_patch`: the Lark grammar Codex advertises to the
 * model is a description of what this parser accepts, not a separate implementation. Every
 * accept/reject decision and every error string below is the Rust one.
 */

import { PatchParseError } from './errors.js';
import {
  ADD_FILE_MARKER,
  BEGIN_PATCH_MARKER,
  CHANGE_CONTEXT_MARKER,
  DELETE_FILE_MARKER,
  EMPTY_CHANGE_CONTEXT_MARKER,
  END_PATCH_MARKER,
  EOF_MARKER,
  MOVE_TO_MARKER,
  UPDATE_FILE_MARKER,
  type Hunk,
  type UpdateFileChunk,
  type UpdateFileHunk,
  cloneHunks,
  newUpdateFileChunk,
  pushContextLine
} from './hunk.js';

const ENVIRONMENT_ID_MARKER = '*** Environment ID:';

const INVALID_HUNK_HEADER_SUFFIX =
  "is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'";

const UNEXPECTED_LINE_SUFFIX =
  "Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)";

type StreamingParserMode =
  | { kind: 'not_started' }
  | { kind: 'started_patch' }
  | { kind: 'add_file' }
  | { kind: 'delete_file' }
  | { kind: 'update_file'; hunkLineNumber: number }
  | { kind: 'ended_patch' };

/** `StreamingPatchParser`. */
export class StreamingPatchParser {
  private lineBuffer = '';
  private mode: StreamingParserMode = { kind: 'not_started' };
  private hunks: Hunk[] = [];
  private environmentIdValue: string | null = null;
  private lineNumber = 0;

  environmentId(): string | null {
    return this.environmentIdValue;
  }

  /** `push_delta`: feeds text in, emitting the hunks parsed so far. */
  pushDelta(delta: string): Hunk[] {
    let start = 0;
    for (let end = delta.indexOf('\n'); end !== -1; end = delta.indexOf('\n', start)) {
      let line = this.lineBuffer + delta.slice(start, end);
      this.lineBuffer = '';
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.lineNumber += 1;
      this.processLine(line);
      start = end + 1;
    }
    this.lineBuffer += delta.slice(start);
    return cloneHunks(this.hunks);
  }

  /** `finish`: flushes a trailing unterminated line and requires the end marker. */
  finish(): Hunk[] {
    if (this.lineBuffer !== '') {
      const line = this.lineBuffer;
      this.lineBuffer = '';
      this.lineNumber += 1;
      if (line.trim() === END_PATCH_MARKER) {
        this.ensureUpdateHunkIsNotEmpty(line.trim());
        this.mode = { kind: 'ended_patch' };
      } else {
        this.processLine(line);
      }
    }

    if (this.mode.kind !== 'ended_patch') {
      throw PatchParseError.invalidPatch("The last line of the patch must be '*** End Patch'");
    }

    return cloneHunks(this.hunks);
  }

  private lastHunk(): Hunk | undefined {
    return this.hunks.at(-1);
  }

  private ensureUpdateHunkIsNotEmpty(line: string): void {
    const last = this.lastHunk();
    if (last === undefined || last.kind !== 'update_file') return;

    if (last.chunks.length === 0 && this.mode.kind === 'update_file') {
      throw PatchParseError.invalidHunk(
        `Update file hunk for path '${last.path}' is empty`,
        this.mode.hunkLineNumber
      );
    }
    const lastChunk = last.chunks.at(-1);
    if (lastChunk !== undefined && lastChunk.oldLines.length === 0 && lastChunk.newLines.length === 0) {
      if (line === END_PATCH_MARKER) {
        throw PatchParseError.invalidHunk('Update hunk does not contain any lines', this.lineNumber);
      }
      throw PatchParseError.invalidHunk(
        `Unexpected line found in update hunk: '${line}'. ${UNEXPECTED_LINE_SUFFIX}`,
        this.lineNumber
      );
    }
  }

  /** Returns true when `trimmed` was consumed as a hunk header or the end marker. */
  private handleHunkHeadersAndEndPatch(trimmed: string): boolean {
    if (this.mode.kind === 'started_patch' && trimmed.startsWith(ENVIRONMENT_ID_MARKER)) {
      if (this.environmentIdValue !== null) {
        throw PatchParseError.invalidPatch(
          'apply_patch environment_id cannot be specified more than once'
        );
      }
      const environmentId = trimmed.slice(ENVIRONMENT_ID_MARKER.length).trim();
      if (environmentId === '') {
        throw PatchParseError.invalidPatch('apply_patch environment_id cannot be empty');
      }
      this.environmentIdValue = environmentId;
      return true;
    }
    if (trimmed === END_PATCH_MARKER) {
      this.ensureUpdateHunkIsNotEmpty(trimmed);
      this.mode = { kind: 'ended_patch' };
      return true;
    }
    if (trimmed.startsWith(ADD_FILE_MARKER)) {
      this.ensureUpdateHunkIsNotEmpty(trimmed);
      this.hunks.push({ kind: 'add_file', path: trimmed.slice(ADD_FILE_MARKER.length), contents: '' });
      this.mode = { kind: 'add_file' };
      return true;
    }
    if (trimmed.startsWith(DELETE_FILE_MARKER)) {
      this.ensureUpdateHunkIsNotEmpty(trimmed);
      this.hunks.push({ kind: 'delete_file', path: trimmed.slice(DELETE_FILE_MARKER.length) });
      this.mode = { kind: 'delete_file' };
      return true;
    }
    if (trimmed.startsWith(UPDATE_FILE_MARKER)) {
      this.ensureUpdateHunkIsNotEmpty(trimmed);
      this.hunks.push({
        kind: 'update_file',
        path: trimmed.slice(UPDATE_FILE_MARKER.length),
        movePath: null,
        chunks: []
      });
      this.mode = { kind: 'update_file', hunkLineNumber: this.lineNumber };
      return true;
    }
    return false;
  }

  private processLine(line: string): void {
    const trimmed = line.trim();
    switch (this.mode.kind) {
      case 'not_started': {
        if (trimmed === BEGIN_PATCH_MARKER) {
          this.mode = { kind: 'started_patch' };
          return;
        }
        throw PatchParseError.invalidPatch("The first line of the patch must be '*** Begin Patch'");
      }
      case 'started_patch': {
        if (this.handleHunkHeadersAndEndPatch(trimmed)) return;
        throw PatchParseError.invalidHunk(`'${trimmed}' ${INVALID_HUNK_HEADER_SUFFIX}`, this.lineNumber);
      }
      case 'add_file': {
        if (this.handleHunkHeadersAndEndPatch(trimmed)) return;
        const last = this.lastHunk();
        if (line.startsWith('+') && last !== undefined && last.kind === 'add_file') {
          last.contents += `${line.slice(1)}\n`;
          return;
        }
        throw PatchParseError.invalidHunk(`'${trimmed}' ${INVALID_HUNK_HEADER_SUFFIX}`, this.lineNumber);
      }
      case 'delete_file': {
        if (this.handleHunkHeadersAndEndPatch(trimmed)) return;
        throw PatchParseError.invalidHunk(`'${trimmed}' ${INVALID_HUNK_HEADER_SUFFIX}`, this.lineNumber);
      }
      case 'update_file': {
        const updateLine = line.trimEnd();
        if (this.handleHunkHeadersAndEndPatch(updateLine)) return;

        const last = this.lastHunk();
        if (last !== undefined && last.kind === 'update_file') {
          this.processUpdateFileLine(last, line, updateLine);
          return;
        }
        throw PatchParseError.invalidHunk(
          `Unexpected line found in update hunk: '${line}'. ${UNEXPECTED_LINE_SUFFIX}`,
          this.lineNumber
        );
      }
      case 'ended_patch': {
        if (trimmed === '') return;
        throw PatchParseError.invalidPatch("The last line of the patch must be '*** End Patch'");
      }
    }
  }

  /**
   * The body of Rust's `if let Some(UpdateFile { .. }) = hunks.last_mut()` arm.
   *
   * Note which string each test uses: the structural markers are matched against the
   * right-trimmed line, while `+`/`-`/context lines are taken from the raw line so their own
   * trailing whitespace survives into the file.
   */
  private processUpdateFileLine(
    hunk: UpdateFileHunk,
    line: string,
    updateLine: string
  ): void {
    const chunks = hunk.chunks;
    const isBlankChunk = (chunk: UpdateFileChunk | undefined): boolean =>
      chunk !== undefined && chunk.oldLines.length === 0 && chunk.newLines.length === 0;

    if (chunks.at(-1)?.isEndOfFile === true) {
      if (updateLine === '') return;
      if (updateLine !== EMPTY_CHANGE_CONTEXT_MARKER && !updateLine.startsWith(CHANGE_CONTEXT_MARKER)) {
        throw PatchParseError.invalidHunk(
          `Expected update hunk to start with a @@ context marker, got: '${line}'`,
          this.lineNumber
        );
      }
    }

    if (chunks.length === 0 && hunk.movePath === null && updateLine.startsWith(MOVE_TO_MARKER)) {
      hunk.movePath = updateLine.slice(MOVE_TO_MARKER.length);
      return;
    }

    if (
      (updateLine === EMPTY_CHANGE_CONTEXT_MARKER || updateLine.startsWith(CHANGE_CONTEXT_MARKER)) &&
      isBlankChunk(chunks.at(-1))
    ) {
      throw PatchParseError.invalidHunk(
        `Unexpected line found in update hunk: '${line}'. ${UNEXPECTED_LINE_SUFFIX}`,
        this.lineNumber
      );
    }

    if (updateLine === EMPTY_CHANGE_CONTEXT_MARKER) {
      chunks.push(newUpdateFileChunk());
      return;
    }

    if (updateLine.startsWith(CHANGE_CONTEXT_MARKER)) {
      chunks.push({
        ...newUpdateFileChunk(),
        changeContext: updateLine.slice(CHANGE_CONTEXT_MARKER.length)
      });
      return;
    }

    if (updateLine === EOF_MARKER) {
      if (isBlankChunk(chunks.at(-1))) {
        throw PatchParseError.invalidHunk('Update hunk does not contain any lines', this.lineNumber);
      }
      const lastChunk = chunks.at(-1);
      if (lastChunk !== undefined) lastChunk.isEndOfFile = true;
      return;
    }

    const prefix = line[0] ?? '';
    if (prefix === '' || prefix === ' ' || prefix === '+' || prefix === '-') {
      if (chunks.length === 0) chunks.push(newUpdateFileChunk());
      const chunk = chunks.at(-1)!;
      if (prefix === '+' || prefix === '-') {
        (prefix === '+' ? chunk.newLines : chunk.oldLines).push(line.slice(1));
      } else {
        pushContextLine(chunk, line.slice(1));
      }
      return;
    }

    const lastChunk = chunks.at(-1);
    if (lastChunk !== undefined && (lastChunk.oldLines.length > 0 || lastChunk.newLines.length > 0)) {
      throw PatchParseError.invalidHunk(
        `Expected update hunk to start with a @@ context marker, got: '${line}'`,
        this.lineNumber
      );
    }

    throw PatchParseError.invalidHunk(
      `Unexpected line found in update hunk: '${line}'. ${UNEXPECTED_LINE_SUFFIX}`,
      this.lineNumber
    );
  }
}
