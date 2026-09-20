import { isAstraModel, isProModel } from './chat-models.js';
import type { InputAutomation } from './input.js';
import type { ReasoningEffort } from './session.js';

/** Both Astra modes and older Pro Loop can use the finish boundary. */
export function supportsFinishAutomation(mode: InputAutomation, model: string | null | undefined, effort?: ReasoningEffort): boolean {
  return mode !== 'off' && (isAstraModel(model, effort) || (mode === 'loop' && isProModel(model, effort)));
}

/** One completion policy for browser and tool delivery; authored user text stays unchanged. */
export function finishInstruction(leadMinutes?: number): string {
  return `Work through the whole requested task, including corrections. Use session_finish only when the requested implementation is complete and about ${leadMinutes === 3 ? 3 : 5} minutes of final verification remain. New instructions extend the work; they do not require another finish call. Do not use this tool for progress updates or to collect queued tasks.`;
}
