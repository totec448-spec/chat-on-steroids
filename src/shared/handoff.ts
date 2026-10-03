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
- Treat the user's messages as the highest-authority source in the entire handoff. They are the specification. Preserve the original task, every requirement, every later correction, every constraint, every explicit preference, and every request about what should happen next. If a later message changed an earlier requirement, state the final position and say that it changed. Never let an assistant plan, guess, TODO, or tool-side interpretation override what the user actually said.
- Preserve the substance of every user message that could matter to continuing the work, even when it is conversational, repetitive, frustrated, shorthand, or speech-to-text. Collapse duplicates only when their meaning is genuinely identical; preserve differences, changed decisions, priorities, and corrections.
- Never drop a requirement because it looks minor or because it was not worked on. Unfinished requirements matter most.
- Use the tool evidence to decide what is actually done. An assistant message saying it will do something is not evidence that it happened; a recorded tool call that succeeded is. Say plainly which is which.
- Keep exact identifiers: file paths, function names, versions, ports, hashes, ids, command lines, error text. Do not paraphrase them.
- Make the current state the centre of the brief: what is complete and verified · what is currently in progress and exactly where it stopped · what is planned/decided but not implemented yet · what was attempted and failed · what was only discussed · what is still to do. Write enough state that the next agent can choose its very next tool call without rediscovering the session.
- Include failures and unresolved bugs with the actual error, and say what was already tried so it is not repeated.
- AGENT MESSAGE lines are traffic with other agents in a multi-agent run. One delivered to this agent is a report about work done outside this recording — treat it as the only evidence of that work and keep its substance. One sent by this agent is work already delegated; say who is doing it so it is not delegated again.
- State the current state of the repository, install and running processes as far as the recording shows it.
- Preserve causal links, not just facts. When a bug, design decision or patch exists because of a specific observed failure, keep the failure → root cause → change → verification chain together. Keep known-good and known-bad behaviours distinct.
- Treat the brief as a lossless operational compression, not an executive summary. Prefer completeness over brevity. For a substantial coding/debugging session, target roughly 10,000–30,000 tokens when the material warrants it and use the available answer budget aggressively; a ~6,000-token brief is normally too short when the conversation contains many user corrections, tool calls, patches, tests, agent reports or unresolved branches. Shorter is appropriate only when there genuinely is less useful state to preserve. Never exceed 30,000 tokens.
- Spend extra space on concrete continuation value: exact changed files and symbols, dirty-tree caveats, test/build commands and outcomes, live-session evidence, current hypotheses with confidence, rejected approaches and why, pending worker ownership, release/install state, and the precise next actions. Do not spend that space repeating prose or narrating obvious chronology.
- Be dense and operational even when long. No preamble, no praise, no restating these instructions, no "in this session we". Use compact sections, bullets and short lines so a 10k–30k-token brief remains navigable rather than repetitive.
- If the recording is incomplete or ambiguous, say so in one line rather than inventing detail.

Structure the brief with these headings, omitting any that would be empty:

TASK — the original goal, in the user's terms.
USER SPECIFICATION — every material user request, constraint, preference, correction and changed decision, with the final position explicit. This is the authoritative section.
CURRENT STATE — what is true right now: repository/app/session state, active implementation, versions, processes, and latest relevant observed behaviour.
DONE — completed and verified, with the evidence.
IN PROGRESS — started, not finished, and exactly where it stopped.
PLANNED / DECIDED — concrete work the user or agent decided should happen next but that tool evidence does not show as completed yet.
FAILED / UNRESOLVED — what broke, the error, what was already tried.
FILES — paths touched or inspected that matter to continuation, what changed in each, and important symbols/line regions when known.
VERIFICATION — tests, builds, smoke checks and live evidence already run, with exact commands/results and what remains unverified.
ENVIRONMENT — commands, versions, running processes, repo/dirty-tree state, installation/release state, and anything the next agent must preserve.
NEXT — the concrete next actions, in order.
DO NOT — what the next agent should not redo or undo.`;


/**
 * How long a Compact & Resume brief should be (#995). Thorough is the shipped prompt unchanged.
 * The shorter choices swap the default prompt's two length sentences and add one code-owned line
 * that overrides any other target, so they also apply to an edited prompt.
 */
export const HANDOFF_LENGTHS = ['thorough', 'standard', 'short'] as const;
export type HandoffLength = (typeof HANDOFF_LENGTHS)[number];
export const DEFAULT_HANDOFF_LENGTH: HandoffLength = 'thorough';

const DEFAULT_LENGTH_RULE = DEFAULT_HANDOFF_PROMPT.split('\n').find(line => line.startsWith('- Treat the brief as a lossless operational compression'))!;
const DEFAULT_NAVIGABLE = 'so a 10k–30k-token brief remains navigable';

const SHORTER: Record<Exclude<HandoffLength, 'thorough'>, { range: string; max: string }> = {
  standard: { range: '4,000–10,000', max: '10,000' },
  short: { range: '2,000–6,000', max: '6,000' }
};

/** The content instructions with the chosen length applied. Thorough returns the prompt as it is. */
export function handoffPromptForLength(prompt: string, length: HandoffLength = DEFAULT_HANDOFF_LENGTH): string {
  if (length === 'thorough' || !SHORTER[length]) return prompt;
  const { range, max } = SHORTER[length];
  const rule = `- Treat the brief as a dense operational compression, not an executive summary. For a substantial session, target roughly ${range} tokens: keep every user requirement and correction, the current state, failures and the next actions, and cut narration and repetition first. Go shorter when there is less useful state. Never exceed ${max} tokens.`;
  const adapted = prompt.replace(DEFAULT_LENGTH_RULE, rule).replace(DEFAULT_NAVIGABLE, 'so the brief remains navigable');
  return `${adapted}\n\nLength setting: aim for roughly ${range} tokens and never exceed ${max}. This replaces any other length target in these instructions.`;
}
