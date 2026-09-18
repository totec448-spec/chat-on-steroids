import type { ReasoningEffort } from './session.js';

/** Normalized image bytes only. No local filesystem path crosses into the renderer. */
export interface InputImage { name: string; dataUrl: string; }
/** Upload metadata without a local path. Outbox ids require immutable staging;
 * recorded native-message ids are presentation metadata and grant no file access. */
export interface InputAttachment { id: string; name: string; size: number; mimeType: string; preview?: string; }
export const MAX_INPUT_IMAGES = 10;
export function injectableAttachments(files: Array<InputImage | InputAttachment>): boolean {
  return files.length > 0 && files.length <= MAX_INPUT_IMAGES && files.every(file => 'dataUrl' in file ||
    ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.mimeType));
}
export type InputAutomation = 'off' | 'goal' | 'loop';

type InputIntent = {
  mode: string; requestedMode?: string; sessionId: string | null; opening?: boolean;
  finishOwner?: unknown; purpose?: string; attachmentDelivery?: string;
};
/** A native upload may wait for a browser boundary while retaining immediate intent.
 * Admission and presentation must classify that same durable row identically. */
export function manualInput(row: InputIntent): boolean {
  return (row.requestedMode ?? row.mode) === 'auto' && !row.finishOwner && row.purpose !== 'decision' && row.attachmentDelivery !== 'tool';
}
export function queuedFollowup(row: InputIntent): boolean {
  return !row.opening && !manualInput(row) &&
    (row.mode === 'finish' || (row.mode === 'after-turn' && !!row.sessionId && row.purpose !== 'decision'));
}

/** Finish tasks continue the chat; their old enqueue-time picker is not a new
 * model choice. Apply this projection to legacy queues too, preserving authored
 * fields for idempotent retries and keeping delivery/history on the same rule. */
export function browserInputModel(input: { mode: string; model: string | null; reasoningEffort: ReasoningEffort | null }): { model: string | null; reasoningEffort: ReasoningEffort | null } {
  return input.mode === 'finish'
    ? { model: null, reasoningEffort: null }
    : { model: input.model, reasoningEffort: input.reasoningEffort };
}
