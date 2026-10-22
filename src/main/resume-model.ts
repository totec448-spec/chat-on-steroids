/**
 * The model a Compact & Resume chat asks ChatGPT for: the source chat's, when this account offers it.
 *
 * The new chat refuses to start on a model it cannot confirm. On a Free plan ChatGPT shows no model
 * picker at all, so carrying the source model over abandoned every resume before it was sent
 * (#1766), the same failure the Goal helper had (#1282). Like the helper, a resume then starts on
 * ChatGPT's current selection, and a model or reasoning the account does not offer is dropped.
 * Until the catalog has loaded, nothing is known yet and the source model is carried over as is.
 */
import { getChatModels } from './chat-models.js';
import { logInfo } from './logger.js';
import { resolveChatModel } from '../shared/chat-models.js';
import type { ReasoningEffort } from '../shared/session.js';

type Selection = { model: string | null; reasoningEffort: ReasoningEffort | null };

/** Decisions already logged, per resume: each resume's command is rendered twice, one line says it. */
const logged = new Set<string>();
let key = '';
function note(line: string): void {
  const entry = `${key}\u0000${line}`;
  if (logged.has(entry)) return;
  logged.add(entry);
  // Bounded: a long-running app only needs to dedupe the resumes still being handed out.
  if (logged.size > 64) logged.delete(logged.values().next().value!);
  logInfo(line);
}

/** `resume` names the resume being handed out, so each one logs its own decision once. */
export function resumeModelSelection(requested: { model: string; reasoningEffort: ReasoningEffort | null } | null | undefined, resume = ''): Selection {
  key = resume;
  if (!requested) return { model: null, reasoningEffort: null };
  const catalog = getChatModels();
  if (!catalog.models.length) {
    if (catalog.state !== 'unavailable') return { model: requested.model, reasoningEffort: requested.reasoningEffort };
    note("resume: this ChatGPT account shows no readable model picker; the new chat uses ChatGPT's current selection");
    return { model: null, reasoningEffort: null };
  }
  const offered = resolveChatModel(catalog.models, requested.model);
  if (!offered) {
    note(`resume: model "${requested.model}" is not offered by this ChatGPT account; the new chat uses ChatGPT's current selection`);
    return { model: null, reasoningEffort: null };
  }
  if (requested.reasoningEffort && !offered.efforts.includes(requested.reasoningEffort)) {
    note(`resume: reasoning "${requested.reasoningEffort}" is not offered for ${requested.model} by this ChatGPT account; the new chat uses ChatGPT's current reasoning`);
    return { model: requested.model, reasoningEffort: null };
  }
  return { model: requested.model, reasoningEffort: requested.reasoningEffort };
}

export function resetResumeModelForTests(): void { logged.clear(); }
