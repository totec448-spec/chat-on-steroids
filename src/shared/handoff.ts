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
- Treat the user's messages as the highest-authority source. Preserve the original task, every material requirement, later correction, constraint, explicit preference and request about what should happen next. When a later message changes an earlier requirement, state the final position clearly.
- Distinguish verified work from plans and claims. Use successful tool evidence to say what actually happened; do not present an assistant promise, TODO or guess as completed work.
- Center the brief on continuation-critical state: what is complete and verified, what is currently in progress and exactly where it stopped, what remains to do, and what failed or is still uncertain. The next agent should be able to choose its next action without rediscovering the session.
- Keep exact identifiers that matter to continuation, including relevant file paths, symbols, versions, hashes, ids, commands and error text. Preserve important failure -> root cause -> change -> verification links.
- Include unresolved bugs and failed attempts with enough detail to avoid repeating them. Preserve material reports from other agents and note work that is still delegated.
- Compress completed chronology aggressively. Summarize repeated successful commands, routine exploration and superseded intermediate states instead of replaying the session. Spend space on the latest state, user corrections, unresolved work and evidence that changes the next decision.
- For a substantial coding/debugging session, prefer a dense operational brief of roughly 2,000-6,000 tokens. Shorter is appropriate when the task is simple. Exceed that range only when essential continuation state would otherwise be lost; never pad the brief to reach a target.
- Be concise and operational: compact sections, bullets and short lines. No preamble, praise, closing remark or narration of obvious chronology. If the recording is incomplete or ambiguous, say so briefly rather than inventing detail.

Structure the brief with these headings, omitting any that would be empty:

TASK - the original goal, in the user's terms.
USER SPECIFICATION - material requirements, constraints, preferences, corrections and changed decisions, with the final position explicit.
CURRENT STATE - what is true right now: active implementation, repository/app/session state and latest relevant behavior.
DONE - completed and verified work, with the evidence that matters.
IN PROGRESS - started but unfinished work and exactly where it stopped.
FAILED / UNRESOLVED - failures, uncertainties and what was already tried.
FILES - paths and symbols that matter to continuation, plus what changed in them.
VERIFICATION - tests, builds, smoke checks and live evidence already run, plus what remains unverified.
NEXT - concrete next actions, in order.
DO NOT - work the next agent should not repeat, undo or accidentally broaden.`;
