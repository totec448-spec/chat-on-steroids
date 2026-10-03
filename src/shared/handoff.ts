/** Maximum editable handoff-content instruction size accepted by config and Settings. */
export const MAX_HANDOFF_PROMPT_CHARS = 20_000;

/**
 * Shipped instructions for the content of a Compact & Resume brief.
 *
 * Protocol framing, continuation identity, tool-detail policy and the requirement to return
 * only the brief remain code-owned in session/handoff-prompt.ts. This text is deliberately
 * user-editable: it controls what the brief emphasizes, not whether the handoff is valid.
 */
export const DEFAULT_HANDOFF_PROMPT = `Rules:
- User messages are authoritative. Preserve the original task and every requirement, correction, constraint or preference that can change what the next agent should do; when later user instructions change earlier ones, state the final position.
- Put continuation-critical state first: the current verified result, exact stopping point, unresolved failures or blockers, unfinished user requests and next executable actions. Compress completed chronology unless it changes the remaining work.
- Use tool and agent evidence for what actually happened; distinguish verified work from plans or discussion. Keep exact identifiers, paths, symbols, versions, hashes, commands, errors, test outcomes and relevant repository/runtime state. Preserve delegated ownership and each important failure → root cause → change → verification chain.
- Do not invent missing evidence. State incomplete or ambiguous evidence briefly.
- Produce the shortest handoff that preserves all continuation-critical state. For a substantial session, normally target roughly 2,000–6,000 tokens. Go longer only when correctness needs it; do not copy raw transcripts or completed chronology merely to fill space.

Use compact sections with these headings, omitting empty ones. Keep TASK, USER SPECIFICATION, CURRENT STATE and NEXT near the top so essential resume state survives an interrupted handoff:

TASK — the original goal, in the user's terms.
USER SPECIFICATION — material user requirements and corrections, with the final position explicit.
CURRENT STATE — current repository/app/session state and latest verified behaviour.
NEXT — the concrete next actions, in order.
DONE — completed and verified, with the evidence.
IN PROGRESS — started, not finished, and exactly where it stopped.
PLANNED / DECIDED — accepted work not yet verified complete.
FAILED / UNRESOLVED — failures, actual errors and what was already tried.
FILES — exact files/artifacts and changed symbols that still matter.
VERIFICATION — tests/builds/live checks run, their outcomes and remaining checks.
ENVIRONMENT — relevant commands, versions, processes, dirty-tree and install/release state.
DO NOT — what the next agent should not redo or undo.`;
