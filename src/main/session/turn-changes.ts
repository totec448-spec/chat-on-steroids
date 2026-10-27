/**
 * What one answer changed, per file (#1827): the "Changed files" card under a completed answer.
 *
 * A turn's recorded edits are grouped by path in the order each file was first changed, and each
 * file gets one net diff: the text before the turn's first edit of it against the text after its
 * last. Only edits Chat On Steroids made are known; a command that changed files is not, and the
 * card never guesses. A worker's edits belong to the worker's own answers.
 */

import type { SessionEvent } from '../../shared/session.js';
import { lineDelta } from '../diffstat.js';

const WORKER = /^worker-\d+$/;

export interface EditAt { callId: string; index: number; assetId?: string }

export interface TurnFileEdits {
  path: string;
  /** The first and the last recorded change of this file in the turn, with their stored before/after. */
  first: EditAt;
  last: EditAt;
  edits: number;
  /** The recorded counts summed, used when an end of the net diff was not kept. */
  recordedAdded: number;
  recordedRemoved: number;
  recordedApproximate: boolean;
  created: boolean;
  deleted: boolean;
  /** Why an end of the net diff is missing, when one is. */
  unavailable: 'too-large' | 'not-kept' | null;
}

/** The turn's edits per file, in the order each file was first changed. */
export function turnFileEdits(events: readonly SessionEvent[], turnId: string): TurnFileEdits[] {
  const files = new Map<string, TurnFileEdits>();
  const firstMissing = new Map<string, TurnFileEdits['unavailable']>();
  for (const event of events) {
    if (event.kind !== 'tool_call' || event.turnId !== turnId || (event.agent && WORKER.test(event.agent))) continue;
    if (event.call.outcome !== 'ok') continue;
    const kind = event.call.summary.kind;
    for (const [index, change] of (event.call.changes ?? []).entries()) {
      const at: EditAt = { callId: event.call.callId, index, ...(change.reviewAssetId ? { assetId: change.reviewAssetId } : {}) };
      const missing = change.reviewAssetId ? null : change.reviewUnavailable ?? 'not-kept';
      const prior = files.get(change.path);
      if (!prior) {
        firstMissing.set(change.path, missing);
        files.set(change.path, { path: change.path, first: at, last: at, edits: 1, recordedAdded: change.added, recordedRemoved: change.removed,
          recordedApproximate: change.approximate, created: kind === 'create', deleted: kind === 'delete', unavailable: missing });
        continue;
      }
      prior.last = at; prior.edits++;
      prior.recordedAdded += change.added; prior.recordedRemoved += change.removed;
      prior.recordedApproximate ||= change.approximate;
      prior.deleted = kind === 'delete';
      // Only the two ends make the net diff: an edit between them that lost its record changes nothing.
      prior.unavailable = firstMissing.get(change.path) ?? missing;
    }
  }
  return [...files.values()];
}

export interface TurnFileChange {
  path: string;
  /** `unchanged`: changed and put back in the same answer (or made and removed). */
  state: 'edited' | 'created' | 'deleted' | 'unchanged';
  added: number;
  removed: number;
  approximate: boolean;
  /** `kept`: both ends of the net diff are recorded and can be shown. */
  diff: 'kept' | 'too-large' | 'not-kept';
  edits: number;
}

/** Reads one recorded change's before and after; null when it is gone or unreadable. */
export type ReviewReader = (at: EditAt) => Promise<{ before: string; after: string } | null>;

/** The text before the file's first edit and after its last; null when either end is gone. */
async function netEnds(file: TurnFileEdits, review: ReviewReader): Promise<{ before: string; after: string } | null> {
  const single = file.last.callId === file.first.callId && file.last.index === file.first.index;
  const [first, last] = await Promise.all([review(file.first), single ? null : review(file.last)]);
  const end = single ? first : last;
  return first && end ? { before: first.before, after: end.after } : null;
}

/** The net change of each file, at most `limit` files. */
export async function netTurnChanges(files: readonly TurnFileEdits[], review: ReviewReader, limit = 50): Promise<TurnFileChange[]> {
  const out: TurnFileChange[] = [];
  for (const file of files.slice(0, limit)) {
    const ends = file.unavailable ? null : await netEnds(file, review);
    if (!ends) {
      // An end the recording did not keep: the recorded counts, said to be approximate.
      out.push({ path: file.path, state: file.created && file.deleted ? 'unchanged' : file.created ? 'created' : file.deleted ? 'deleted' : 'edited',
        added: file.recordedAdded, removed: file.recordedRemoved, approximate: true, diff: file.unavailable ?? 'not-kept', edits: file.edits });
      continue;
    }
    const delta = lineDelta(ends.before, ends.after);
    const state: TurnFileChange['state'] = ends.before === ends.after ? 'unchanged'
      : file.created && ends.before === '' ? 'created' : file.deleted && ends.after === '' ? 'deleted' : 'edited';
    out.push({ path: file.path, state, added: delta.added, removed: delta.removed, approximate: delta.approximate, diff: 'kept', edits: file.edits });
  }
  return out;
}

/** The net before and after of one file in a turn, for the card's diff; null when an end was not kept. */
export async function netTurnFileDiff(files: readonly TurnFileEdits[], path: string, review: ReviewReader): Promise<{ before: string; after: string } | null> {
  const file = files.find(row => row.path === path);
  return file && !file.unavailable ? netEnds(file, review) : null;
}
