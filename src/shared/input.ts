import type { ReasoningEffort } from './session.js';

/** Normalized image bytes only. No local filesystem path crosses into the renderer. */
export interface InputImage { name: string; dataUrl: string; }
/** Immutable staged upload. Neither renderer nor browser receives a local path. */
export interface InputAttachment { id: string; name: string; size: number; mimeType: string; preview?: string; }
export type InputAutomation = 'off' | 'goal' | 'loop';

/** Finish tasks continue the chat; their old enqueue-time picker is not a new
 * model choice. Apply this projection to legacy queues too, preserving authored
 * fields for idempotent retries and keeping delivery/history on the same rule. */
export function browserInputModel(input: { mode: string; model: string | null; reasoningEffort: ReasoningEffort | null }): { model: string | null; reasoningEffort: ReasoningEffort | null } {
  return input.mode === 'finish'
    ? { model: null, reasoningEffort: null }
    : { model: input.model, reasoningEffort: input.reasoningEffort };
}
