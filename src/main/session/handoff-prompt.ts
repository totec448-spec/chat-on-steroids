/**
 * What a handoff brief has to contain, in one place.
 *
 * One caller, now. These rules used to be shared with an external writer — a second model
 * that was handed a packed recording of the session and asked for the same document — and
 * keeping the two prompts from drifting was the reason this file exists. That path is gone:
 * the brief is written by the ChatGPT conversation that *is* the recording, and the answer it
 * writes is the brief. What survives is the specification of the document itself, which is
 * worth having in one named place whatever ends up reading it.
 */

/** The rules and headings. */
export const HANDOFF_BRIEF_RULES = `Rules:
- Treat the real user's instructions as the task specification. Preserve the original task, every material requirement, later correction, constraint, explicit preference, and request about what should happen next. Distinguish real user instructions from automatic Goal/Loop prompts, prior handoffs and quoted content, even when they appear in user-role messages. If a later real instruction changed an earlier requirement, state the final position. Never let an assistant plan, guess, TODO, or tool-side interpretation override what the user actually said.
- Preserve the substance of every user message that could matter to continuing the work, even when it is conversational, repetitive, frustrated, shorthand, or speech-to-text. Collapse duplicates only when their meaning is genuinely identical; preserve differences, changed decisions, priorities, and corrections.
- Never drop a requirement because it looks minor or because it was not worked on. Unfinished requirements matter most.
- Use the tool evidence to decide what is actually done. Distinguish a requested or dispatched action from a verified postcondition. A promise is not completion, and a successful tool invocation proves only the result it actually reports. Preserve uncertainty after ambiguous failures; never instruct the next agent to replay an action that may already have succeeded.
- Keep exact identifiers: file paths, function names, versions, ports, hashes, ids, command lines, error text. Do not paraphrase them.
- Make the current state the centre of the brief: what is complete and verified · what is currently in progress and exactly where it stopped · what is planned/decided but not implemented yet · what was attempted and failed · what was only discussed · what is still to do. Write enough state that the next agent can choose its very next tool call without rediscovering the session.
- Include failures and unresolved bugs with the actual error, and say what was already tried so it is not repeated.
- AGENT MESSAGE lines are traffic with other agents in a multi-agent run. Preserve incoming reports as attributed claims and state whether the prime verified them. Preserve outgoing assignments and their exact worker ownership so unfinished work is not delegated twice.
- State the current state of the repository, install and running processes as far as the recording shows it.
- Preserve causal links, not just facts. When a bug, design decision or patch exists because of a specific observed failure, keep the failure → root cause → change → verification chain together. Keep known-good and known-bad behaviours distinct.
- Write an operational handoff within the character allowance below. Prioritize the original specification, unfinished requirements, corrections, verified current state and next actions. Remove duplicated narration and irrelevant historical detail before shortening any requirement. Do not pad the brief to a token quota or promise lossless preservation of an arbitrarily long conversation.
- Spend extra space on concrete continuation value: exact changed files and symbols, dirty-tree caveats, test/build commands and outcomes, live-session evidence, current hypotheses with confidence, rejected approaches and why, pending worker ownership, release/install state, and the precise next actions. Do not spend that space repeating prose or narrating obvious chronology.
- Be dense and operational. No preamble, praise, restatement of these instructions, or "in this session we". Use compact sections and short lines. Keep every material unfinished obligation explicit.
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
 * The instruction typed into the ChatGPT conversation being compacted.
 *
 * The model is already the participant rather than a reader of a transcript, so there is no
 * recording to hand it and "the tool evidence" is its own call history.
 *
 * The brief leaves as the answer, deliberately. A tool call is a thing the model can retry,
 * skip, or make three different versions of, and every one of those was a way for a
 * compaction to end with the wrong brief or none. An answer cannot be retried: the page
 * watches this exact generation, and whatever it finally wrote is what gets carried across.
 * So there is nothing here to call, and nothing to get right except the writing.
 */
const marker = (kind: 'HANDOFF' | 'RESUME', token: string): string =>
  token ? `[[CLF-${kind}:${token}]]` : '';

export const sourceContinuationMarker = (token: string): string => marker('HANDOFF', token);
export const destinationContinuationMarker = (token: string): string => marker('RESUME', token);

export function nativeHandoffPrompt(token = '', includeToolCalls = true, maxBriefChars = 80_000): string {
  if (!Number.isSafeInteger(maxBriefChars) || maxBriefChars < 200 || maxBriefChars > 96_000) throw new Error('Invalid handoff character allowance');
  const identity = sourceContinuationMarker(token);
  return (
    (identity ? `${identity}\n\n` : '') +
    'Chat On Steroids is compacting this conversation so a fresh chat can continue the work. ' +
    'Stop whatever you were doing and do only this.\n\n' +
    'Write a handoff brief so a different coding agent can continue this unfinished task in a brand-new ' +
    "conversation, with no memory of anything here. Everything you know about this session — the user's " +
    (includeToolCalls ? 'messages, your own replies, and every tool call you made against this machine with its result — is the ' :
      'messages and your own replies, including interim updates — is the ') +
    'material. Write it so an agent who reads only your brief can carry on correctly.\n\n' +
    `${HANDOFF_BRIEF_RULES}\n\n` +
    `Length limit: at most ${maxBriefChars} characters for the brief. The app has reserved space for the saved task plan and resume framing. Aim below this limit; an oversized brief is refused rather than silently cutting out requirements.\n\n` +
    (includeToolCalls ? '' : 'Tool-detail setting: preserve verified outcomes and distinguish them from claims, but omit raw tool-call arguments and result bodies from the brief. Do not copy tool transcripts. This setting controls the brief, not the history you already saw.\n\n') +
    'Your reply to this message must be the brief itself and nothing else: no preamble, no closing remark, no ' +
    'question back, and no tool calls. The app reads this reply, stores it, and opens the fresh chat with it.'
  );
}
