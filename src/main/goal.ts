/**
 * The goal loop — a second model, standing in for the user, that keeps a chat moving.
 *
 * ChatGPT finishes a long turn. Somebody has to decide whether all concrete work/questions the
 * user actually requested were clearly completed, and for an unattended run that somebody is an
 * OpenRouter model given the same conversation and a strict continuation-gate instruction. The
 * stock policy keeps going while a requested item is not clearly resolved, but still treats an
 * explicit whole-job completion claim as authoritative and never invents extra work.
 * OpenRouter is asked for a strict `{ action, reply }` decision and the app validates it before
 * anything reaches the browser; provider reasoning, tokenizer markers and malformed protocol
 * output are never user messages. That is the whole feature, and the two halves live in different
 * places for a reason:
 *
 *   · The *page* owns "the turn is really over". Only the browser can tell a finished answer
 *     from a mid-turn redraw, a tool call, or a reload replaying yesterday's transcript, and
 *     it already has that machinery — the same settle barrier a compaction goes through.
 *   · This module owns everything after that: the context, the credential, the request, and
 *     the one draft per chat that the page is allowed to send.
 *
 * ## Why the app makes the call and not the extension
 *
 * The API key is a real credential. It lives in the same DPAPI blob as everything else the
 * app holds and never leaves the main process, so the extension is handed a *reply* rather
 * than a key. That also means the context is built from the local recording, which is the
 * authoritative copy of what was said — the page's DOM is a rendering of it, and a rendering
 * that has been scrolled, virtualised and re-mounted for six hours.
 *
 * ## What is sent
 *
 * Every authored user message and every final ChatGPT answer of this session, in order, plus
 * the Compact & Resume bootstrap that the replacement chat actually received. No tool calls,
 * no arguments, no results, no file contents. The goal model is deciding whether the user's
 * request has been satisfied, and the conversation is the only evidence it needs for that;
 * the rest is this machine's business and does not leave it.
 *
 * ## One draft per chat
 *
 * A draft is keyed by the generation it answers. A second request for the same turn is the
 * same draft — a retried POST, a reloaded tab, two observers of one settle — and is answered
 * with what already exists rather than by asking the model twice and sending two messages
 * into somebody's conversation.
 */

import { createHash } from 'node:crypto';
import { getConfig } from './config.js';
import { writeDurableNow, writeDurableSoon } from './durable.js';
import { logInfo, logWarn } from './logger.js';
import { getSecret } from './secrets.js';
import { getSession, readEvents, readHandoff, readRecentEvents } from './session/store.js';
import { resumeBootstrapMatches, resumeBootstrapText } from './session/handoff.js';
import {
  GOAL_LOOP_STOP_REFUSED,
  GOAL_LOOP_TRAILER,
  GOAL_OBJECTIVE_OPENING_TURN,
  GOAL_OBJECTIVE_TRAILER,
  GOAL_SYSTEM_TRAILER,
  MAX_GOAL_OBJECTIVE_CHARS,
  goalObjectiveMessage
} from '../shared/goal.js';
import type { GoalMode } from '../shared/types.js';

/** Where OpenRouter lives. One host, both routes. */
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/**
 * Sent so a key's owner can see which application spent it, which OpenRouter asks for and
 * uses to attribute traffic. Neither header carries anything about the user or the chat.
 */
const ATTRIBUTION_HEADERS: Record<string, string> = {
  'HTTP-Referer': 'https://github.com/chat-on-steroids',
  'X-Title': 'Chat On Steroids'
};

/** How many messages of history the goal model is given, newest kept. */
const MAX_CONTEXT_MESSAGES = 120;
/** …and how many characters of them, so one 200k-character answer cannot be the whole prompt. */
const MAX_CONTEXT_CHARS = 120_000;
/** The per-message cut. Long enough to carry an answer's substance, short enough to fit many. */
const MAX_MESSAGE_CHARS = 12_000;
/** How long one draft may take before it is abandoned as failed. */
const REQUEST_TIMEOUT_MS = 180_000;

/**
 * Failures that asking again cannot answer, whoever asks and however long they wait.
 *
 * A key that is refused, an account with no credit, a model id OpenRouter does not know and a
 * chat with nothing to continue from are all settings, not weather. Everything else — the
 * provider erroring, a stream cut short, a timeout, an answer in a shape this app cannot read —
 * is the same request having a bad moment, and it is asked again.
 *
 * Nothing in this module acts on that distinction: one draft is one request, and asking again
 * belongs to the page's Goal loop, which is the only place that can tell whether the turn is
 * still the one being answered. This is what that loop reads, published as `retryable`.
 */
const SETTLED_FAILURE = /^(?:auth_rejected|out_of_credit|unknown_model|no_api_key|no_conversation|no_objective)(?:$|:)/;
/** The catalogue is UI data; a dead provider must not leave the picker request hanging forever. */
const MODEL_LIST_TIMEOUT_MS = 30_000;
/** A single SSE record should be tiny; this still leaves ample room around the 12k reply cap. */
const MAX_SSE_RECORD_CHARS = 64_000;
/** Error prose is diagnostic only. Never buffer an arbitrary provider-controlled failure body. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;
/** A Goal decision is tiny. Bound the successful provider envelope just like failure prose. */
const MAX_GOAL_BODY_BYTES = 64 * 1024;
/** The model catalogue is bounded UI metadata, not an unlimited provider document. */
const MAX_MODEL_LIST_BODY_BYTES = 8 * 1024 * 1024;
/** Cache/picker cardinality and field bounds for provider-controlled model metadata. */
const MAX_MODELS = 5_000;
const MAX_MODEL_FIELD_CHARS = 500;
/** How long a finished draft stays available to the page that has to type it. */
const DRAFT_TTL_MS = 10 * 60_000;
/** The model listing is small and changes daily, not by the second. */
const MODEL_CACHE_MS = 5 * 60_000;
/** The page shows models in pages of this size, and asks for them the same way. */
export const MODEL_PAGE_SIZE = 20;

/**
 * The word that means "say nothing".
 *
 * Exact legacy spelling. The broader protocol guard below also treats a standalone sentinel
 * inside surrounding scratchpad text as stop: a false stop is recoverable, while typing model
 * plumbing into ChatGPT starts an unintended turn.
 */
const NO_REPLY = /^no[\s_-]?reply[\s.!]*$/i;
/** Standalone protocol sentinel anywhere in legacy output means stop, never "type this". */
const NO_REPLY_TOKEN = /(?:^|[^\p{L}\p{N}])no[\s_-]?reply[\s.!]*(?=$|[^\p{L}\p{N}])/iu;
/** Common raw tokenizer/control markers that must never be submitted to ChatGPT. */
const MODEL_CONTROL_TOKEN = /<\|[^|\r\n]{1,100}\|>|<\/?s>|\[\/?INST\]|<<\/?SYS>>/giu;
/** Reasoning wrappers are not formatting; their contents are never a user message. */
const UNSAFE_REASONING_TAG = /<\/?(?:think|analysis|reasoning)\b[^>]*>/iu;

/**
 * How many times one loop draft may be asked again after it tried to stop anyway.
 *
 * Structured output already removes `stop` from the loop's vocabulary, so this only catches
 * the model writing the sentinel into the message text — rare, and usually gone on the next
 * attempt. It is bounded because the alternative is a chat that silently spends a key in a
 * circle; past the last attempt the draft fails *retryably* and the page's own Goal loop asks
 * again on its clock, which is the one place that knows whether this turn is still the last one.
 */
const LOOP_ATTEMPTS = 3;

/** App-owned transport contract. The editable prompt decides policy, never wire syntax. */
const GOAL_OUTPUT_PROTOCOL =
  'Return only the app decision described by the response schema. Use action "stop" when the editable instruction would say NO_REPLY. ' +
  'Use action "continue" only with the exact short user message in reply. Put no reasoning, counting, labels, tokenizer markers, or protocol words in reply.';

const GOAL_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'goal_decision',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['stop', 'continue'],
          description:
            'stop only when the whole requested job is clearly complete; continue while concrete requested work or questions are not yet clearly completed or answered'
        },
        reply: {
          type: 'string',
          description: 'empty for stop; for continue, only the short message to send as the user'
        }
      },
      required: ['action', 'reply'],
      additionalProperties: false
    }
  }
} as const;

/**
 * Loop's transport contract: the same envelope with the stop half taken out.
 *
 * The editable instruction says the loop never stops, and this is the same statement made
 * where a model cannot argue with it — `continue` is the only value the enum admits, so a
 * provider honouring the schema has no way to spell the answer this mode does not accept.
 * The prompt remains the thing that decides *what* to write; this only removes the exit.
 */
const LOOP_OUTPUT_PROTOCOL =
  'Return only the app decision described by the response schema. Action is always "continue" — there is no stop, and no message may be skipped. ' +
  'Put the exact next user message in reply, and put no reasoning, counting, labels, tokenizer markers, or protocol words in it.';

const LOOP_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'goal_decision',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['continue'],
          description: 'always continue; this mode never stops on its own'
        },
        reply: {
          type: 'string',
          description: 'the short message to send as the user; never empty'
        }
      },
      required: ['action', 'reply'],
      additionalProperties: false
    }
  }
} as const;

/** The persisted instruction used for the next draft. Exported for focused contract tests. */
export function goalSystemPrompt(): string {
  return getConfig().goal.prompt;
}

/** The persisted driver instruction, used instead of the gate once a chat carries a goal. */
export function goalObjectivePrompt(): string {
  return getConfig().goal.objectivePrompt;
}

/** The persisted loop instruction, used instead of both of the above while Loop is on. */
export function goalLoopPrompt(): string {
  return getConfig().goal.loopPrompt;
}

/**
 * Which instruction drives right now: the gate/driver pair, or the loop.
 *
 * Read through the master switch on purpose. A chat that runs only because it carries its own
 * saved objective, with the standing switch off, is not a chat the user switched Loop on for —
 * and Loop is the mode that never stops by itself, so it is never entered by inheritance.
 */
export function goalDrivingMode(): GoalMode {
  const goal = getConfig().goal;
  return goal.enabled && goal.mode === 'loop' ? 'loop' : 'goal';
}

/** How a draft is going, in the order it goes. */
export type GoalStage =
  /** Building the context and opening the request. */
  | 'sending'
  /** The model is writing; `text` grows. */
  | 'answering'
  /** There is a message to type. */
  | 'ready'
  /** The model said the goal is met. Nothing is typed, and the loop ends here. */
  | 'no-reply'
  | 'failed';

export interface GoalDraftView {
  token: string;
  conversationId: string;
  /** The generation this draft answers. One draft per generation, ever. */
  turnId: string;
  stage: GoalStage;
  model: string;
  /** What the model has written so far, for the panel above the composer. */
  text: string;
  /** The message to type, present only at `ready`. */
  reply: string;
  /** A short machine-readable reason, shown by the page when the stage is `failed`. */
  error: string | null;
  /**
   * Whether this failure is one the same request could still answer.
   *
   * A Goal run ends on one of two answers — `[no reply]`, or words to type — so a failure ends
   * nothing by itself; it leaves the turn still waiting. This is the app's half of that: it
   * says whether asking again is capable of producing an answer. Whether asking again is
   * *allowed* stays with the page, which is where every reason Goal may not act already lives.
   */
  retryable: boolean;
}

// `retryable` is left out on purpose: it is read off the failure every time it is asked for,
// so there is no second place where a draft can be described as retryable and be wrong.
interface GoalDraft extends Omit<GoalDraftView, 'retryable'> {
  sessionId: string;
  /** Frozen with the draft, just like its model, so one request never mixes two settings saves. */
  systemPrompt: string;
  /** The driver instruction, frozen for the same reason. Used only when `objective` is set. */
  objectiveSystemPrompt: string;
  /** The loop instruction, frozen for the same reason. Used only when `mode` is `loop`. */
  loopSystemPrompt: string;
  /**
   * Which mode this draft was started in, frozen with its prompts.
   *
   * Switching from Loop to Goal mid-request must not turn a request that was promised a
   * message into one that may answer with silence, and the reverse must not let a gate answer
   * be regenerated for refusing to speak. The mode a draft was born in is the mode it finishes.
   */
  mode: GoalMode;
  /**
   * This chat's specific goal, frozen with the draft. Empty for an ordinary Goal Mode run.
   *
   * Present means a different instruction, a different default (continue rather than stop),
   * and one thing the gate never allows: a conversation with no user message in it yet.
   */
  objective: string;
  /** Browser tab that owns the right to type/ack this draft. Empty only for legacy callers. */
  clientId: string;
  startedAt: number;
  settledAt: number;
  /** Set once the page has been told to type this, so it can never be typed twice. */
  acknowledged: boolean;
  work: Promise<void> | null;
  abort: AbortController | null;
}

/** At most one draft per conversation. A new turn replaces the old chat's finished draft. */
const drafts = new Map<string, GoalDraft>();

/**
 * The stable ChatGPT reply that still needs one terminal Goal decision.
 *
 * Local generation ids are deliberately not the identity here: ChatGPT remints them after a
 * reload and can replay several start/end pairs for one authored reply. replyId is the
 * canonical assistant message id already used by the session store; eventSeq only orders
 * genuinely newer replies. A handled row is retained so enabling Goal later never replays
 * history that was accepted while it was off.
 */
interface GoalReplyObligation {
  conversationId: string;
  sessionId: string;
  replyId: string;
  turnId: string;
  eventSeq: number;
  /** When this app froze the decision. The row's whole lifetime is measured from here. */
  acceptedAt: number;
  state: 'pending' | 'handled';
}

const goalReplies = new Map<string, GoalReplyObligation>();

/**
 * How long one reply may wait for its Goal decision, and how many chats may be waiting.
 *
 * The obligation is durable so a reload, a crashed page or an app restart cannot lose a
 * finished reply the loop still owes an answer to. It is *not* a standing invitation: a row
 * that outlives this window is retired unanswered, because typing into a chat somebody left
 * a day ago is the failure this whole subsystem is careful about, and the page-side trigger
 * has always refused to manufacture Goal work from an old finished turn.
 *
 * The cap is the second half of the same statement. One row per conversation is written for
 * every final assistant reply this app records, each one fsynced before its HTTP 200, so an
 * unbounded ledger would make every reply in every chat pay for every chat that came before.
 */
const GOAL_REPLY_TTL_MS = 12 * 60 * 60_000;
const MAX_GOAL_REPLIES = 200;

/** Drops rows this app may no longer act on, newest kept. Returns the surviving ledger. */
function boundGoalReplies(now: number): void {
  for (const [conversationId, reply] of goalReplies) {
    if (now - reply.acceptedAt >= GOAL_REPLY_TTL_MS) goalReplies.delete(conversationId);
  }
  if (goalReplies.size <= MAX_GOAL_REPLIES) return;
  const oldestFirst = [...goalReplies.values()].sort((a, b) => a.acceptedAt - b.acceptedAt);
  for (const reply of oldestFirst.slice(0, goalReplies.size - MAX_GOAL_REPLIES)) {
    goalReplies.delete(reply.conversationId);
  }
}
export const GOAL_REPLIES_STATE = 'goal-replies';

export interface GoalRepliesSnapshot {
  version: 1;
  savedAt: number;
  replies: GoalReplyObligation[];
}

export function snapshotGoalReplies(): GoalRepliesSnapshot {
  boundGoalReplies(Date.now());
  return {
    version: 1,
    savedAt: Date.now(),
    replies: [...goalReplies.values()].map((reply) => ({ ...reply }))
  };
}

export function restoreGoalReplies(snapshot: GoalRepliesSnapshot | null): void {
  goalReplies.clear();
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.replies)) return;
  for (const raw of snapshot.replies) {
    if (
      !raw ||
      !/^[0-9a-z-]{8,256}$/i.test(raw.conversationId) ||
      !raw.sessionId ||
      !raw.replyId ||
      !raw.turnId ||
      !Number.isSafeInteger(raw.eventSeq) ||
      raw.eventSeq < 1 ||
      !Number.isSafeInteger(raw.acceptedAt) ||
      raw.acceptedAt <= 0 ||
      (raw.state !== 'pending' && raw.state !== 'handled')
    ) continue;
    goalReplies.set(raw.conversationId, {
      conversationId: raw.conversationId,
      sessionId: String(raw.sessionId).slice(0, 200),
      replyId: String(raw.replyId).slice(0, 200),
      turnId: String(raw.turnId).slice(0, 200),
      eventSeq: raw.eventSeq,
      acceptedAt: raw.acceptedAt,
      state: raw.state
    });
  }
  boundGoalReplies(Date.now());
}

function persistGoalRepliesSoon(): void {
  writeDurableSoon(GOAL_REPLIES_STATE, snapshotGoalReplies());
}

export function goalPendingReplyFor(
  conversationId: string
): Pick<GoalReplyObligation, 'replyId' | 'turnId' | 'eventSeq'> | null {
  const reply = goalReplies.get(conversationId);
  // Expiry is read here as well as pruned on write, because the ledger is only pruned when
  // something writes to it. A chat reopened after the window must not be offered work the
  // next prune would have thrown away.
  if (reply && Date.now() - reply.acceptedAt >= GOAL_REPLY_TTL_MS) return null;
  return reply?.state === 'pending'
    ? { replyId: reply.replyId, turnId: reply.turnId, eventSeq: reply.eventSeq }
    : null;
}

/** Freezes Goal eligibility at the durable recorder boundary. */
export async function acceptGoalReplyNow(input: {
  conversationId: string;
  sessionId: string;
  replyId: string;
  turnId: string;
  eventSeq: number;
  blocked: boolean;
}): Promise<void> {
  const current = goalReplies.get(input.conversationId);
  if (current?.replyId === input.replyId || (current && current.eventSeq > input.eventSeq)) return;
  const provisionalUpgrade = Boolean(
    current &&
      current.eventSeq === 0 &&
      current.turnId === input.turnId &&
      current.replyId === `turn:${input.turnId}`.slice(0, 200)
  );
  const before = current ? { ...current } : null;
  const bounded = snapshotGoalReplies().replies;
  const active =
    !input.blocked &&
    getConfig().sessions.record &&
    (getConfig().goal.enabled || goalObjectiveFor(input.conversationId) !== '') &&
    (await getSecret('openRouterApiKey')) !== null;
  goalReplies.set(input.conversationId, {
    conversationId: input.conversationId,
    sessionId: input.sessionId,
    replyId: input.replyId.slice(0, 200),
    turnId: input.turnId.slice(0, 200),
    eventSeq: input.eventSeq,
    // `/goal/draft` may have had to persist the local turn before Fiber exposed ChatGPT's
    // stable assistant id. The later id strengthens that same row; it must not re-evaluate
    // policy or reopen a decision the page already acknowledged in the meantime.
    acceptedAt: provisionalUpgrade ? current!.acceptedAt : Date.now(),
    state: provisionalUpgrade ? current!.state : active ? 'pending' : 'handled'
  });
  try {
    await writeDurableNow(GOAL_REPLIES_STATE, snapshotGoalReplies());
  } catch (error) {
    // The rejected write is one whole revision, so the rollback is too: the row this accept
    // added and the expired rows it pruned go back together, leaving the ledger exactly as the
    // decision found it.
    goalReplies.clear();
    for (const reply of bounded) goalReplies.set(reply.conversationId, reply);
    if (before) goalReplies.set(input.conversationId, before);
    else goalReplies.delete(input.conversationId);
    persistGoalRepliesSoon();
    throw error;
  }
}

function handleGoalReply(conversationId: string, turnId?: string): void {
  const reply = goalReplies.get(conversationId);
  if (!reply || reply.state !== 'pending' || (turnId && reply.turnId !== turnId)) return;
  reply.state = 'handled';
  persistGoalRepliesSoon();
}

/** Durable state file for per-chat Goal objectives. */
export const GOAL_OBJECTIVES_STATE = 'goal-objectives';

export interface GoalObjectivesSnapshot {
  version: 1;
  savedAt: number;
  objectives: Array<{ conversationId: string; objective: string }>;
}

/**
 * The specific goal a chat is being driven towards, keyed by conversation.
 *
 * This is deliberately not app configuration: it is chat/session state. It does survive an
 * app restart so reopening the same chat restores the field, but restoration alone never asks
 * OpenRouter for a draft. The page still owns the only trigger, a newly observed turn ending;
 * a stale finished chat therefore displays its goal without silently starting work.
 *
 * Compact & Resume explicitly moves this entry from chat A to chat B as part of the same live
 * projection as the session/workspace move. Continuation recovery repeats that move after a
 * crash, so an unattended chain of resumptions keeps pursuing one objective without making the
 * user type it again.
 */
const goalObjectives = new Map<string, string>();

export function snapshotGoalObjectives(): GoalObjectivesSnapshot {
  return {
    version: 1,
    savedAt: Date.now(),
    objectives: [...goalObjectives.entries()].map(([conversationId, objective]) => ({ conversationId, objective }))
  };
}

function persistGoalObjectives(): void {
  writeDurableSoon(GOAL_OBJECTIVES_STATE, snapshotGoalObjectives());
}

export function restoreGoalObjectives(snapshot: GoalObjectivesSnapshot | null): void {
  goalObjectives.clear();
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.objectives)) return;
  for (const raw of snapshot.objectives) {
    if (!raw || typeof raw.conversationId !== 'string' || !/^[0-9a-z-]{8,256}$/i.test(raw.conversationId)) continue;
    if (typeof raw.objective !== 'string') continue;
    const objective = raw.objective.trim().slice(0, MAX_GOAL_OBJECTIVE_CHARS);
    if (!objective) continue;
    goalObjectives.set(raw.conversationId, objective);
  }
}

/** This chat's specific goal, or '' when it has none. */
export function goalObjectiveFor(conversationId: string): string {
  return goalObjectives.get(conversationId) ?? '';
}

/**
 * Sets or clears one chat's goal. Empty text clears it.
 *
 * Returns what is now stored, already trimmed and bounded, so the caller reports the stored
 * value rather than the one it sent — the two differ whenever the text was over the cap.
 */
export function setGoalObjective(conversationId: string, text: string): string {
  const goal = text.trim().slice(0, MAX_GOAL_OBJECTIVE_CHARS);
  goalObjectives.delete(conversationId);
  if (goal) goalObjectives.set(conversationId, goal);
  persistGoalObjectives();
  return goal;
}

/**
 * Durable acceptance boundary for a user-visible Goal save/clear.
 *
 * `/goal/objective` tells the page the value was saved, so returning before the ordinary
 * 300 ms durable debounce leaves a real crash window where a successfully acknowledged goal
 * disappears on restart. Stage the in-memory value, make that exact snapshot durable, and only
 * then let the bridge publish success. If the write fails, restore the previous live value and
 * supersede durable.ts's retained failed generation with the still-authoritative snapshot.
 */
export async function setGoalObjectiveNow(conversationId: string, text: string): Promise<string> {
  const before = goalObjectives.get(conversationId);
  const goal = text.trim().slice(0, MAX_GOAL_OBJECTIVE_CHARS);
  goalObjectives.delete(conversationId);
  if (goal) goalObjectives.set(conversationId, goal);
  try {
    await writeDurableNow(GOAL_OBJECTIVES_STATE, snapshotGoalObjectives());
    return goal;
  } catch (error) {
    goalObjectives.delete(conversationId);
    if (before) goalObjectives.set(conversationId, before);
    writeDurableSoon(GOAL_OBJECTIVES_STATE, snapshotGoalObjectives());
    throw error;
  }
}

export function clearGoalObjective(conversationId: string): void {
  if (goalObjectives.delete(conversationId)) persistGoalObjectives();
}

/** Moves one chat-owned objective to the replacement conversation used by Compact & Resume. */
export function moveGoalObjective(fromConversationId: string, toConversationId: string): boolean {
  if (!fromConversationId || !toConversationId || fromConversationId === toConversationId) return false;
  const objective = goalObjectives.get(fromConversationId);
  if (!objective) return false;
  goalObjectives.delete(fromConversationId);
  goalObjectives.delete(toConversationId);
  goalObjectives.set(toConversationId, objective);
  persistGoalObjectives();
  return true;
}

export function goalSettings(): { enabled: boolean; mode: GoalMode; model: string; reasoning: string } {
  const goal = getConfig().goal;
  return { enabled: goal.enabled, mode: goal.mode, model: goal.model, reasoning: goal.reasoning };
}

export async function goalKeyPresent(): Promise<boolean> {
  return (await getSecret('openRouterApiKey')) !== null;
}

function view(draft: GoalDraft): GoalDraftView {
  return {
    token: draft.token,
    conversationId: draft.conversationId,
    turnId: draft.turnId,
    stage: draft.stage,
    model: draft.model,
    text: draft.text,
    // The reply is handed over only while it is still the thing to do. Once acknowledged it
    // is history, and a page that polls again must not find a message to type a second time.
    reply: draft.stage === 'ready' && !draft.acknowledged ? draft.reply : '',
    error: draft.error,
    retryable: draft.stage === 'failed' && !SETTLED_FAILURE.test(draft.error ?? '')
  };
}

function expireDraftPayload(draft: GoalDraft): void {
  if (draft.settledAt === 0 || Date.now() - draft.settledAt <= DRAFT_TTL_MS) return;
  // The TTL is for the *payload*, not the idempotency key. A ready draft can have crossed
  // ChatGPT's irreversible send boundary while its local ACK was lost. Keep this turn's token
  // as a spent tombstone until a genuinely newer generation supersedes it.
  //
  // It is emphatically not for the *obligation*. The reply ledger records that this exact turn
  // is owed an answer, and a clock running out is not an answer: expiring the row here retired
  // the turn unanswered whenever an app restart, a closed tab or a slow provider outlasted ten
  // minutes. Only a real decision — the draft typed, or NO_REPLY — discharges it.
  draft.acknowledged = true;
  draft.text = '';
  draft.reply = '';
  draft.error = null;
  draft.work = null;
}

/** What the page should be told about this chat right now, or null when there is nothing. */
export function goalViewFor(conversationId: string, clientId?: string): GoalDraftView | null {
  const draft = drafts.get(conversationId);
  if (!draft) return null;
  expireDraftPayload(draft);
  if (clientId !== undefined && draft.clientId !== clientId) return null;
  // An acknowledged draft has already been acted on — typed, or decided against. It is kept
  // here only so the turn it belongs to cannot be drafted a second time, and reporting it
  // would leave the page polling fast and the panel above the composer describing something
  // that finished minutes ago.
  if (draft.acknowledged) return null;
  return view(draft);
}

/**
 * Marks this draft as delivered, so nothing can type it again.
 *
 * The page acknowledges after it has typed and sent — or after it has decided it cannot —
 * and both are the same fact here: this draft is spent.
 */
export function ackGoalDraft(conversationId: string, token: string, clientId?: string): boolean {
  const draft = drafts.get(conversationId);
  if (!draft || draft.token !== token) return false;
  if (clientId !== undefined && draft.clientId !== clientId) return false;
  draft.acknowledged = true;
  // An acknowledgement can also mean "this draft will never be sent" (Goal Mode was switched
  // off, the chat moved on, or the composer stayed occupied). Do not keep spending the user's
  // OpenRouter key after the browser has explicitly retired the draft. If the request has not
  // reached fetch yet, run() observes `acknowledged` at its next await boundary; if it has,
  // aborting the controller closes the stream immediately.
  draft.abort?.abort();
  if (draft.settledAt === 0) draft.settledAt = Date.now();
  // The two answers that discharge the obligation are the ones the page can act on: a message
  // it typed, and NO_REPLY. Everything else is the app failing to produce one — a dropped
  // stream, a rejected key, an exhausted balance, an abort — and a failure to answer may not
  // be recorded as an answer. Retiring the row on `auth_rejected` meant the user fixing their
  // key found the turn it was owed for silently gone.
  if (draft.stage === 'ready' || draft.stage === 'no-reply') handleGoalReply(conversationId, draft.turnId);
  return true;
}

/** The browser ACK is not successful until the reply tombstone is crash-durable. */
export async function ackGoalDraftNow(
  conversationId: string,
  token: string,
  clientId?: string
): Promise<boolean> {
  const acknowledged = ackGoalDraft(conversationId, token, clientId);
  if (acknowledged) await writeDurableNow(GOAL_REPLIES_STATE, snapshotGoalReplies());
  return acknowledged;
}

/**
 * Retires every outstanding generation when Goal authority/settings are revoked or replaced.
 *
 * Disabling Goal, changing the model/reasoning, or replacing its credential must affect work
 * that is already in flight, not only the next draft. Each entry stays as a spent tombstone so
 * a reload cannot re-draft the same finished ChatGPT turn after the cancellation.
 */
export function retireGoalDrafts(): number {
  let retired = 0;
  for (const draft of drafts.values()) {
    if (draft.acknowledged) continue;
    draft.acknowledged = true;
    draft.abort?.abort();
    if (draft.settledAt === 0) draft.settledAt = Date.now();
    draft.text = '';
    draft.reply = '';
    retired += 1;
  }
  for (const reply of goalReplies.values()) reply.state = 'handled';
  if (goalReplies.size > 0) persistGoalRepliesSoon();
  return retired;
}

/**
 * Retires whatever one chat has in flight, leaving every other chat alone.
 *
 * A draft is frozen with the instruction and the goal it was started under. Changing that
 * chat's goal therefore has to reach the request already running, or the last thing typed
 * into the conversation would be a message written against the goal the user just replaced.
 */
export function retireGoalDraftsFor(conversationId: string): boolean {
  const draft = drafts.get(conversationId);
  const pending = goalReplies.get(conversationId)?.state === 'pending';
  if (!draft || draft.acknowledged) {
    if (pending) handleGoalReply(conversationId);
    return pending;
  }
  draft.acknowledged = true;
  draft.abort?.abort();
  if (draft.settledAt === 0) draft.settledAt = Date.now();
  draft.text = '';
  draft.reply = '';
  handleGoalReply(conversationId);
  return true;
}

export function resetGoalStateForTests(): void {
  for (const draft of drafts.values()) draft.abort?.abort();
  drafts.clear();
  goalReplies.clear();
  goalObjectives.clear();
  firstUserCache.clear();
  legacyCommittedResumeCache.clear();
  modelCache = null;
}

export interface StartGoalDraftInput {
  sessionId: string;
  conversationId: string;
  /** The generation whose answer triggered this. The draft's identity. */
  turnId: string;
  /** Browser-tab ownership fence. Omitted only by direct/legacy callers. */
  clientId?: string;
  /** Bridge-only: reserve ownership while its durable reply obligation is committed. */
  deferStart?: boolean;
}

/**
 * Starts one draft for one finished turn, or hands back the one that already exists.
 *
 * Returns immediately: drafting takes tens of seconds and the page is polling `/activity`
 * anyway, so the stream lands there rather than being held open on one request that a
 * service-worker restart would drop.
 */
export function startGoalDraft(input: StartGoalDraftInput): GoalDraftView {
  const existing = drafts.get(input.conversationId);
  const clientId = input.clientId ?? '';
  if (existing) expireDraftPayload(existing);
  // A Goal reply is an irreversible browser-side write. Conversation identity alone is not
  // enough because two tabs can show the same ChatGPT chat and both poll /activity. Keep one
  // tab as the writer until that draft is spent/expired; a second observer must not abort it,
  // replace its local generation id, or receive its token to type independently.
  if (existing && !existing.acknowledged && existing.clientId !== clientId) {
    throw new Error('goal_owned_elsewhere');
  }
  // Same turn, same draft. This is the idempotency that keeps a retried POST or a second
  // request from the owning tab from putting two messages into one conversation.
  //
  // A failed draft the page has already retired is the one exception, and for exactly that
  // reason: nothing was written, so asking again is this turn still waiting for its answer
  // rather than a second message. Requiring the acknowledgement is what keeps it to one
  // attempt at a time — an unacknowledged failure is still the page's to read. A settings
  // failure is deliberately not retried here, because it would only be paid for again; the
  // obligation behind it survives regardless — see ackGoalDraft — so the turn is still owed
  // its answer once the setting that broke it is fixed.
  const spentFailure =
    existing?.stage === 'failed' && existing.acknowledged && !SETTLED_FAILURE.test(existing.error ?? '');
  if (existing && existing.turnId === input.turnId && !spentFailure) return view(existing);
  // A different turn supersedes whatever the last one left behind, including an unfinished
  // request: the answer it was writing was about a conversation that has since moved on.
  if (existing) {
    existing.abort?.abort();
    drafts.delete(input.conversationId);
  }
  const settings = getConfig().goal;
  const draft: GoalDraft = {
    token: `goal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    conversationId: input.conversationId,
    sessionId: input.sessionId,
    systemPrompt: settings.prompt,
    objectiveSystemPrompt: settings.objectivePrompt,
    loopSystemPrompt: settings.loopPrompt,
    mode: goalDrivingMode(),
    objective: goalObjectiveFor(input.conversationId),
    clientId,
    turnId: input.turnId,
    stage: 'sending',
    model: settings.model,
    text: '',
    reply: '',
    error: null,
    startedAt: Date.now(),
    settledAt: 0,
    acknowledged: false,
    work: null,
    abort: null
  };
  drafts.set(input.conversationId, draft);
  if (!input.deferStart) beginGoalDraft(input.conversationId, draft.token);
  return view(draft);
}

/** Starts provider work only after the bridge has durably committed this reserved turn. */
export function beginGoalDraft(conversationId: string, token: string): boolean {
  const draft = drafts.get(conversationId);
  if (!draft || draft.token !== token || draft.acknowledged || draft.work) return false;
  draft.work = run(draft).catch((err: Error) => {
    settle(draft, 'failed', `goal_failed: ${err.message}`);
  });
  return true;
}

/** Releases a bridge reservation whose durable commit failed, before provider work began. */
export function discardPreparedGoalDraft(conversationId: string, token: string): boolean {
  const draft = drafts.get(conversationId);
  if (!draft || draft.token !== token || draft.work) return false;
  drafts.delete(conversationId);
  return true;
}

function settle(draft: GoalDraft, stage: GoalStage, error: string | null = null): void {
  // A draft that was superseded is no longer this chat's draft, and must not be able to
  // publish a reply into the one that replaced it.
  if (drafts.get(draft.conversationId) !== draft) return;
  draft.stage = stage;
  draft.error = error;
  draft.settledAt = Date.now();
}

/**
 * One OpenRouter decision, with none of the draft bookkeeping around it.
 *
 * Two callers want exactly this and nothing more: `run`, answering a finished turn inside a
 * chat the app is recording, and `draftOpeningMessage`, answering a chat that does not exist
 * yet and therefore has no draft, no session and no conversation id at all. Sharing one
 * request is what keeps the opening message under the same protocol guard, the same body
 * caps and the same refusal rules as every other message this app has ever typed.
 */
interface GoalRequest {
  key: string;
  model: string;
  /**
   * Which contract this request is made under.
   *
   * `goal` may come back with either answer. `loop` is offered only one, both in the schema it
   * is sent and in how the answer is read: see requestDrivingDecision.
   */
  mode: GoalMode;
  /** In order, ahead of the conversation. The wire protocol is appended here, not by callers. */
  system: string[];
  messages: ChatMessage[];
  /**
   * The closing reminder, placed after the transcript rather than before it.
   *
   * Everything in `system` is read before a conversation that can run to hundreds of messages,
   * and a long transcript is exactly the case where an instruction that far up stops steering
   * the answer. This is the same policy restated where the model saw it last. It is app-owned
   * placement, not app-owned policy: the text comes from whichever editable prompt is driving.
   */
  trailer: string;
  signal: AbortSignal;
  /** Called as legacy SSE text arrives, so a streaming panel can show it being written. */
  publish?: (text: string) => void;
}

/**
 * One request, one answer — including "no usable answer".
 *
 * There is deliberately no retry here. A provider error, a cut stream and a reply in a shape
 * this app cannot read are all the same event, and whether asking again is worth anything
 * depends on facts this function cannot see: whether the turn being answered is still the last
 * one, whether the user has started typing, whether Goal is even switched on. Those live in the
 * page's Goal loop, which reads the failure back off `retryable` and asks again on its own
 * clock. A second attempt from in here would be spent against a turn nobody rechecked.
 */
async function requestGoalDecision(request: GoalRequest): Promise<GoalDecision | { action: 'http'; error: string }> {
  const settings = getConfig().goal;
  const body: Record<string, unknown> = {
    model: request.model,
    // Response Healing works only for non-streaming structured responses. Goal decisions
    // are tiny; correctness at the composer boundary matters more than token-by-token UI.
    stream: false,
    messages: [
      ...request.system.map((content) => ({ role: 'system', content })),
      { role: 'system', content: request.mode === 'loop' ? LOOP_OUTPUT_PROTOCOL : GOAL_OUTPUT_PROTOCOL },
      ...request.messages,
      { role: 'system', content: request.trailer }
    ],
    response_format: request.mode === 'loop' ? LOOP_RESPONSE_FORMAT : GOAL_RESPONSE_FORMAT,
    plugins: [{ id: 'response-healing' }],
    // OpenRouter otherwise may route to a provider that silently ignores response_format.
    provider: { require_parameters: true }
  };
  // Reasoning may still be used, but it is never part of the response body this app parses.
  // OpenRouter documents `exclude` as supported across models even when effort selection is
  // not. `default` therefore means "provider-selected effort", not "return its scratchpad".
  body['reasoning'] = {
    ...(settings.reasoning === 'default' ? {} : { effort: settings.reasoning }),
    exclude: true
  };

  const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${request.key}`,
      'content-type': 'application/json',
      ...ATTRIBUTION_HEADERS
    },
    body: JSON.stringify(body),
    signal: request.signal
  });
  if (!response.ok || !response.body) return { action: 'http', error: await httpFailure(response) };
  const completion = await readGoalCompletion(response, request.publish);
  return normalizeGoalDecision(completion.text, completion.legacy);
}

/**
 * One decision the caller may act on, with Loop's single addition: a stop is not one.
 *
 * In `goal` mode this is exactly `requestGoalDecision` — one request, one answer, no retry, for
 * all the reasons written above it. In `loop` mode the model has been told it never stops and
 * handed a schema with no way to say so, so a stop reaching this point means it wrote the
 * sentinel into the message text instead. That is a malformed answer rather than a decision,
 * and the honest repair is to ask again with the refusal spelled out — never to type a sentence
 * this app wrote and attribute it to the model.
 *
 * Everything else — a provider error, a cut stream, an unreadable shape — is passed straight
 * back, because whether *those* are worth asking again is the page's call and not this one's.
 */
async function requestDrivingDecision(
  request: GoalRequest
): Promise<GoalDecision | { action: 'http'; error: string }> {
  let decision = await requestGoalDecision(request);
  if (request.mode !== 'loop') return decision;
  for (let attempt = 1; attempt < LOOP_ATTEMPTS && decision.action === 'stop'; attempt += 1) {
    logWarn(`goal: the loop tried to stop with ${request.model}; asking again (${attempt}/${LOOP_ATTEMPTS - 1})`);
    decision = await requestGoalDecision({
      ...request,
      system: [...request.system, GOAL_LOOP_STOP_REFUSED]
    });
  }
  return decision;
}

async function run(draft: GoalDraft): Promise<void> {
  const key = await getSecret('openRouterApiKey');
  if (draft.acknowledged || drafts.get(draft.conversationId) !== draft) return;
  if (!key) return settle(draft, 'failed', 'no_api_key');
  const messages = await conversationMessages(draft.sessionId);
  if (draft.acknowledged || drafts.get(draft.conversationId) !== draft) return;
  // Goal Mode is supposed to continue *the user's objective*. A partially recovered recorder
  // can contain assistant prose without the user row that gave it meaning; treating that as a
  // usable conversation asks the second model to invent what the user wants and can create a
  // brand-new task. Fail closed until at least one recorded user message anchors the request.
  //
  // A chat carrying a specific goal is the one case where that anchor is neither needed nor
  // evidence of a recovery failure: the user stated the request themselves, before the
  // conversation existed, and writing its opening message is the whole job. See setGoalObjective.
  if (!draft.objective && (messages.length === 0 || !messages.some((message) => message.role === 'user'))) {
    return settle(draft, 'failed', 'no_conversation');
  }

  const abort = new AbortController();
  draft.abort = abort;
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  try {
    const decision = await requestDrivingDecision({
      key,
      model: draft.model,
      mode: draft.mode,
      // Loop replaces the instruction, not the goal: a chat that carries one still hands it
      // over verbatim, which is what "here is the task" in that prompt refers to. Without one
      // the loop reads the job out of the conversation, exactly as the gate does.
      system:
        draft.mode === 'loop'
          ? draft.objective
            ? [draft.loopSystemPrompt, goalObjectiveMessage(draft.objective)]
            : [draft.loopSystemPrompt]
          : draft.objective
            ? [draft.objectiveSystemPrompt, goalObjectiveMessage(draft.objective)]
            : [draft.systemPrompt],
      messages: messages.length > 0 ? messages : [{ role: 'user', content: GOAL_OBJECTIVE_OPENING_TURN }],
      trailer:
        draft.mode === 'loop'
          ? GOAL_LOOP_TRAILER
          : draft.objective
            ? GOAL_OBJECTIVE_TRAILER
            : GOAL_SYSTEM_TRAILER,
      signal: abort.signal,
      publish: (text) => {
        draft.stage = 'answering';
        if (drafts.get(draft.conversationId) === draft) draft.text = text;
      }
    });
    if (draft.acknowledged || drafts.get(draft.conversationId) !== draft) return;
    if (decision.action === 'http') return settle(draft, 'failed', decision.error);
    if (decision.action === 'invalid') return settle(draft, 'failed', decision.error);
    if (decision.action === 'stop') {
      // Loop has already been asked again for exactly this, up to its limit. Reaching here
      // means the model kept refusing to write, which is a failure to produce an answer and
      // not a decision to stay silent — so the turn stays owed one. The failure is deliberately
      // outside SETTLED_FAILURE: the page retries it on its own clock, where it can still see
      // whether this turn is the last one.
      if (draft.mode === 'loop') {
        logWarn(`goal: the loop would not write a message in ${draft.conversationId} with ${draft.model}`);
        return settle(draft, 'failed', 'loop_stop_refused');
      }
      logInfo(`goal: ${draft.model} says the goal is met in ${draft.conversationId}; nothing was sent`);
      // Reaching the goal ends this Goal run, not the user's saved objective. Keeping the text
      // lets a reopened chat show what it was pursuing and lets a later manual correction such
      // as "that did not work" continue against the same objective. Nothing auto-restarts here:
      // the browser still needs a genuinely new turn ending before it can request another draft.
      draft.reply = '';
      return settle(draft, 'no-reply');
    }
    // Typed rather than written. See humanReply: the em dashes go, and a couple of the
    // mistakes a person leaves behind go in. After the NO_REPLY test above, never before it.
    draft.reply = humanReply(decision.reply);
    logInfo(`goal: drafted ${decision.reply.length} characters for ${draft.conversationId} with ${draft.model}`);
    settle(draft, 'ready');
  } catch (err) {
    const detail = (err as Error).message;
    const failure = abort.signal.aborted
      ? 'timeout_or_cancelled'
      : detail === 'reply_too_long' || detail === 'stream_record_too_long'
        ? detail
        : `request_failed: ${detail}`;
    logWarn(`goal: draft for ${draft.conversationId} failed — ${failure}`);
    settle(draft, 'failed', failure);
  } finally {
    clearTimeout(timer);
    draft.abort = null;
  }
}

/**
 * The opening message for a chat that does not exist yet.
 *
 * Every other draft in this module belongs to a conversation: it is keyed by one, streamed
 * onto that conversation's activity feed, and acknowledged against it. A New Chat given a
 * goal has none of that — ChatGPT assigns an id only once a message has been sent, which is
 * the very message being asked for here — so this one is a plain request and a plain answer,
 * awaited by the page that will type it.
 *
 * It is deliberately not idempotent, because there is nothing yet to key idempotency to. The
 * page holds that end: one save, one call, and the result goes into an empty composer. It also
 * holds the retry: a failure here goes back to whoever pressed the button, with the reason, and
 * pressing it again is the second attempt — which is why this path needs none of its own.
 */
export async function draftOpeningMessage(
  objective: string
): Promise<{ reply: string; model: string } | { error: string }> {
  const goal = objective.trim().slice(0, MAX_GOAL_OBJECTIVE_CHARS);
  if (!goal) return { error: 'no_objective' };
  const key = await getSecret('openRouterApiKey');
  if (!key) return { error: 'no_api_key' };
  const model = getConfig().goal.model;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  try {
    const mode = goalDrivingMode();
    const decision = await requestDrivingDecision({
      key,
      model,
      mode,
      system: [
        mode === 'loop' ? getConfig().goal.loopPrompt : getConfig().goal.objectivePrompt,
        goalObjectiveMessage(goal)
      ],
      messages: [{ role: 'user', content: GOAL_OBJECTIVE_OPENING_TURN }],
      trailer: mode === 'loop' ? GOAL_LOOP_TRAILER : GOAL_OBJECTIVE_TRAILER,
      signal: abort.signal
    });
    if (decision.action === 'http') return { error: decision.error };
    if (decision.action === 'invalid') return { error: decision.error };
    // Stopping before the first word has been said is the model refusing the goal rather
    // than meeting it, and an empty opening message would leave somebody looking at a chat
    // that never started with nothing on screen to say why.
    if (decision.action === 'stop') return { error: 'nothing_to_open_with' };
    logInfo(`goal: drafted an opening message of ${decision.reply.length} characters with ${model}`);
    return { reply: humanReply(decision.reply), model };
  } catch (err) {
    const detail = (err as Error).message;
    return { error: abort.signal.aborted ? 'timeout_or_cancelled' : `request_failed: ${detail}` };
  } finally {
    clearTimeout(timer);
  }
}

/** The failure in words the page can put on screen, without leaking the key back out. */
async function httpFailure(response: Response): Promise<string> {
  let detail = '';
  try {
    const raw = await boundedResponseText(response, MAX_ERROR_BODY_BYTES);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    const message =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? (parsed as { error?: { message?: unknown } }).error?.message
        : null;
    detail = typeof message === 'string' ? message.slice(0, 200) : raw.slice(0, 200);
  } catch (error) {
    // A body that is neither JSON nor readable adds nothing the status code does not say.
    // Oversize is worth naming because it explains why otherwise useful provider prose was
    // intentionally not read.
    if (error instanceof Error && error.message === 'response_body_too_large') detail = 'response body too large';
  }
  if (response.status === 401 || response.status === 403) return `auth_rejected: ${detail || 'the OpenRouter key was refused'}`;
  if (response.status === 402) return `out_of_credit: ${detail || 'the OpenRouter account is out of credit'}`;
  if (response.status === 404) return `unknown_model: ${detail || 'OpenRouter does not know that model id'}`;
  if (response.status === 429) return `rate_limited: ${detail || 'OpenRouter is rate-limiting this key'}`;
  return `http_${response.status}${detail ? `: ${detail}` : ''}`;
}

/**
 * Reads one provider response under a byte ceiling without ever first materialising an
 * unbounded string/ArrayBuffer. `Content-Length` is an early refusal only; streaming bytes are
 * counted too because a chunked or dishonest response is just as untrusted.
 */
async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('response_body_too_large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('response_body_too_large');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Best effort only; the size refusal itself is authoritative.
    }
    throw error;
  }
}

interface GoalCompletion {
  text: string;
  /** Compatibility seam for the pre-structured SSE tests/older gateways. */
  legacy: boolean;
}

/** Reads the structured non-streaming response OpenRouter was asked for, under a hard cap. */
async function readGoalCompletion(
  response: Response,
  publish?: (text: string) => void
): Promise<GoalCompletion> {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/event-stream')) {
    // Older gateways and retained parser regressions can still answer in the previous shape.
    // The normalizer below applies stricter sentinel/control-token rules to this path.
    if (!response.body) return { text: '', legacy: true };
    return { text: await readStream(response.body, publish), legacy: true };
  }

  const raw = await boundedResponseText(response, MAX_GOAL_BODY_BYTES);
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error('malformed_completion_response');
  }
  if (parsed && typeof parsed === 'object' && 'error' in parsed && (parsed as { error?: unknown }).error) {
    throw new Error('provider_completion_error');
  }
  const choices = parsed && typeof parsed === 'object' ? (parsed as { choices?: unknown }).choices : null;
  const choice = Array.isArray(choices) ? choices[0] : null;
  const message = choice && typeof choice === 'object' ? (choice as { message?: unknown }).message : null;
  const content = message && typeof message === 'object' ? (message as { content?: unknown }).content : null;
  if (typeof content !== 'string') throw new Error('malformed_completion_response');
  if (content.length > MAX_MESSAGE_CHARS + 2_048) throw new Error('reply_too_long');
  return { text: content, legacy: false };
}

type GoalDecision =
  | { action: 'stop' }
  | { action: 'continue'; reply: string }
  | { action: 'invalid'; error: string };

/** Removes provider/tokenizer wrappers while preserving the proposed human message itself. */
function cleanGoalReply(value: string): { text: string; hadControl: boolean } {
  const normalized = value.normalize('NFKC');
  const withoutInvisible = normalized.replace(/[\u0000\u200B-\u200D\u2060\uFEFF]/g, '');
  const withoutControl = withoutInvisible.replace(MODEL_CONTROL_TOKEN, '');
  return { text: withoutControl.trim(), hadControl: withoutControl !== withoutInvisible };
}

/**
 * Converts untrusted model output into the only two states the browser may act on.
 *
 * Production responses must be strict JSON. Legacy SSE remains readable for compatibility,
 * but is fail-closed around the stop sentinel: `NO_REPLY` anywhere means stop, so scratchpad
 * prefixes such as "Counting flush: NO_REPLY" can never become a user message. Raw tokenizer
 * markers are removed; an empty or still-marked result is refused rather than typed.
 */
function normalizeGoalDecision(raw: string, legacy: boolean): GoalDecision {
  const trimmed = raw.trim();
  if (!trimmed) return { action: 'invalid', error: 'empty_reply' };

  if (legacy) {
    if (NO_REPLY_TOKEN.test(trimmed) || NO_REPLY.test(trimmed)) return { action: 'stop' };
    const cleaned = cleanGoalReply(trimmed);
    if (!cleaned.text) return { action: 'invalid', error: cleaned.hadControl ? 'control_tokens_only' : 'empty_reply' };
    if (cleaned.text.includes('<|') || cleaned.text.includes('|>') || UNSAFE_REASONING_TAG.test(cleaned.text)) {
      return { action: 'invalid', error: 'unsafe_control_tokens' };
    }
    return { action: 'continue', reply: cleaned.text };
  }

  let decision: unknown;
  try {
    decision = JSON.parse(trimmed);
  } catch {
    return { action: 'invalid', error: 'invalid_goal_decision_json' };
  }
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    return { action: 'invalid', error: 'invalid_goal_decision_schema' };
  }
  const object = decision as Record<string, unknown>;
  if (Object.keys(object).some((key) => key !== 'action' && key !== 'reply')) {
    return { action: 'invalid', error: 'invalid_goal_decision_schema' };
  }
  if ((object.action !== 'stop' && object.action !== 'continue') || typeof object.reply !== 'string') {
    return { action: 'invalid', error: 'invalid_goal_decision_schema' };
  }
  if (object.action === 'stop') return { action: 'stop' };
  // A continue decision that leaks the stop protocol is ambiguous. Stopping is the only safe
  // interpretation: it spends no prompt and cannot make ChatGPT act on internal machinery.
  if (NO_REPLY_TOKEN.test(object.reply) || NO_REPLY.test(object.reply)) return { action: 'stop' };
  const cleaned = cleanGoalReply(object.reply);
  if (!cleaned.text) return { action: 'invalid', error: cleaned.hadControl ? 'control_tokens_only' : 'empty_reply' };
  if (cleaned.text.includes('<|') || cleaned.text.includes('|>') || UNSAFE_REASONING_TAG.test(cleaned.text)) {
    return { action: 'invalid', error: 'unsafe_control_tokens' };
  }
  if (cleaned.text.length > MAX_MESSAGE_CHARS) return { action: 'invalid', error: 'reply_too_long' };
  return { action: 'continue', reply: cleaned.text };
}

/**
 * Reads an SSE completion stream, publishing as it goes.
 *
 * OpenRouter sends `data:` lines with an OpenAI-shaped delta, `: ` comment lines as
 * keep-alives, and `data: [DONE]` at the end. A chunk can split a line anywhere, so the tail
 * of every chunk is carried into the next one; the version that assumed chunk boundaries were
 * line boundaries dropped whichever token happened to straddle one.
 */
async function readStream(
  body: ReadableStream<Uint8Array>,
  publish?: (text: string) => void
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let text = '';
  /** True means the OpenAI-compatible stream declared this completion finished. */
  const consume = (rawLine: string): boolean => {
    if (rawLine.length > MAX_SSE_RECORD_CHARS) throw new Error('stream_record_too_long');
    const line = rawLine.trim();
    if (!line || line.startsWith(':') || !line.startsWith('data:')) return false;
    const payload = line.slice(5).trim();
    if (!payload) return false;
    if (payload === '[DONE]') return true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // A non-empty data record is protocol, not decoration. Ignoring malformed JSON after
      // valid deltas promotes a provider-truncated sentence to a ready user message.
      throw new Error('malformed_stream_record');
    }
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const rawError = (parsed as { error?: unknown }).error;
      if (rawError) {
        const rawMessage =
          typeof rawError === 'string'
            ? rawError
            : rawError && typeof rawError === 'object' && 'message' in rawError
              ? (rawError as { message?: unknown }).message
              : null;
        const detail =
          typeof rawMessage === 'string'
            ? rawMessage.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200)
            : '';
        // OpenRouter can surface an upstream failure *inside* an already-200 SSE response,
        // including after some deltas were emitted. Ignoring that event turns a truncated
        // completion into a ready Goal message and types a sentence the model never finished.
        throw new Error(`provider_stream_error${detail ? `: ${detail}` : ''}`);
      }
    }
    const delta = deltaOf(parsed);
    if (!delta) return false;
    if (text.length + delta.length > MAX_MESSAGE_CHARS) throw new Error('reply_too_long');
    text += delta;
    // Published as it arrives: this is what the panel above the composer is streaming.
    publish?.(text);
    return false;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let cut = buffered.indexOf('\n');
      while (cut >= 0) {
        const line = buffered.slice(0, cut);
        buffered = buffered.slice(cut + 1);
        if (consume(line)) {
          // `[DONE]` is a terminal protocol record, not a keep-alive. Do not wait for a proxy
          // to close the HTTP body and never accept provider/proxy junk after the declared end
          // as part of the user message. Cancelling also stops an otherwise lingering body from
          // spending the rest of the request timeout transferring bytes we will not consume.
          await reader.cancel().catch(() => undefined);
          return text;
        }
        cut = buffered.indexOf('\n');
      }
      if (buffered.length > MAX_SSE_RECORD_CHARS) throw new Error('stream_record_too_long');
    }
    // TextDecoder can still be holding the last bytes of a split UTF-8 code point, and an SSE
    // producer is allowed to close after its final `data:` record without a trailing newline.
    // The old parser discarded both pieces at EOF and turned an otherwise valid completion into
    // `empty_reply` (or silently lost its last token).
    buffered += decoder.decode();
    if (buffered.length > MAX_SSE_RECORD_CHARS) throw new Error('stream_record_too_long');
    if (buffered) consume(buffered);
    return text;
  } catch (error) {
    // Stop pulling a stream we have already refused. Without this, an upstream model that
    // ignored the short-reply instruction could keep transferring bytes after the draft had
    // become unusable locally.
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function deltaOf(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return '';
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const choice = choices[0] as { delta?: { content?: unknown }; message?: { content?: unknown } };
  const content = choice?.delta?.content ?? choice?.message?.content;
  return typeof content === 'string' ? content : '';
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * The recent reader is deliberately tail-bounded. Once that tail saturates, preserve the one
 * old row Goal still semantically requires: what the user originally asked for. Cache only
 * successful lookups because a missing first user may simply mean recording is not there yet.
 */
const firstUserCache = new Map<string, ChatMessage>();
/** Positive-only compatibility proof for sessions resumed before committed provenance existed. */
const legacyCommittedResumeCache = new Map<string, string>();

async function firstUserMessage(sessionId: string): Promise<ChatMessage | null> {
  const cached = firstUserCache.get(sessionId);
  if (cached) return cached;
  const [event] = await readEvents(sessionId, { kinds: ['user_message'], limit: 1 });
  if (!event || event.kind !== 'user_message') return null;
  const content = clip(event.message.text);
  if (!content) return null;
  const message: ChatMessage = { role: 'user', content };
  firstUserCache.set(sessionId, message);
  while (firstUserCache.size > 128) {
    const oldest = firstUserCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    firstUserCache.delete(oldest);
  }
  return message;
}

/**
 * Which handoff is proven to have become a replacement chat's user bootstrap.
 *
 * Current sessions get this from the atomic continuation rebind metadata. For sessions created
 * by an older build, infer conservatively only when the exact browser bootstrap is itself present
 * somewhere in durable authored user-message history and the session lineage spans more than one
 * ChatGPT chat. A published handoff event alone is never proof: capture precedes commit and an
 * aborted continuation deliberately leaves that event behind.
 */
async function committedResumeHandoffId(
  sessionId: string,
  summary: Awaited<ReturnType<typeof getSession>>
): Promise<string | null> {
  if (!summary) return null;
  if (summary.lastCommittedResumeHandoffId) return summary.lastCommittedResumeHandoffId;
  if (summary.chatIds.length <= 1) return null;
  const cached = legacyCommittedResumeCache.get(sessionId);
  if (cached) return cached;

  const [users, handoffEvents] = await Promise.all([
    readEvents(sessionId, { kinds: ['user_message'] }),
    readEvents(sessionId, { kinds: ['handoff'] })
  ]);
  const authored: string[] = [];
  for (const event of users) {
    if (event.kind !== 'user_message' || event.message.truncated || !event.message.text) continue;
    authored.push(event.message.text);
  }
  for (let at = handoffEvents.length - 1; at >= 0; at--) {
    const event = handoffEvents[at];
    if (!event || event.kind !== 'handoff') continue;
    const handoff = await readHandoff(sessionId, event.handoffId);
    if (!handoff) continue;
    if (authored.some((text) => resumeBootstrapMatches(text, handoff.text))) {
      legacyCommittedResumeCache.set(sessionId, handoff.id);
      while (legacyCommittedResumeCache.size > 128) {
        const oldest = legacyCommittedResumeCache.keys().next().value as string | undefined;
        if (!oldest) break;
        legacyCommittedResumeCache.delete(oldest);
      }
      return handoff.id;
    }
  }
  return null;
}

/**
 * The conversation as the goal model sees it: what the user asked, and what ChatGPT answered.
 *
 * Read from the local recording rather than from the page. Only *final* assistant messages
 * count — a streaming snapshot is the same answer half-written, and including both would
 * show the model the same reply twice with the shorter one second.
 */
export async function conversationMessages(sessionId: string): Promise<ChatMessage[]> {
  const recentLimit = MAX_CONTEXT_MESSAGES * 2;
  const events = await readRecentEvents(sessionId, recentLimit, {
    kinds: ['user_message', 'assistant_message']
  });
  const ordered: ChatMessage[] = [];
  const byStableMessage = new Map<string, number>();
  for (const event of events) {
    let next: ChatMessage | null = null;
    if (event.kind === 'user_message') {
      const content = clip(event.message.text);
      if (content) next = { role: 'user', content };
    } else if (event.kind === 'assistant_message' && event.final) {
      const content = clip(event.message.text);
      if (content) next = { role: 'assistant', content };
    }
    if (!next) continue;

    // Current recordings are canonicalized by the session store before they get here. Older
    // append-only sessions are still valid history, though, and can contain two final snapshots
    // of the same stable ChatGPT message after a remount/replay. Keep its first position but
    // replace the content with the newest snapshot. Id-less legacy rows remain distinct because
    // there is no identity strong enough to merge them safely.
    const stableId = 'messageId' in event && typeof event.messageId === 'string' && event.messageId ? event.messageId : null;
    const key = stableId ? `${event.kind}\u0000${stableId}` : null;
    const existingAt = key ? byStableMessage.get(key) : undefined;
    if (existingAt !== undefined) ordered[existingAt] = next;
    else {
      if (key) byStableMessage.set(key, ordered.length);
      ordered.push(next);
    }
  }
  // A saturated recent read does not prove it reached the start of the conversation. Its first
  // user can merely be the oldest follow-up still inside the tail, which makes the system
  // prompt's "what you originally asked for" instruction false. Resolve the actual first user
  // once in that case, while keeping everything sent to the provider bounded below.
  let firstUserAt = ordered.findIndex((message) => message.role === 'user');
  let firstUser = firstUserAt >= 0 ? ordered[firstUserAt]! : null;
  if (events.length >= recentLimit) {
    const original = await firstUserMessage(sessionId);
    if (original) {
      firstUser = original;
      // Equality by content is sufficient for the outgoing ChatMessage projection. If the
      // first recent user has the same text as the original, keeping that one avoids a duplicate;
      // otherwise the original lives outside the tail and gets its own reserved slot.
      if (firstUserAt < 0 || ordered[firstUserAt]?.content !== original.content) firstUserAt = -1;
    }
  }

  const summary = await getSession(sessionId);
  const committedHandoffId = await committedResumeHandoffId(sessionId, summary);
  const committedHandoff = committedHandoffId ? await readHandoff(sessionId, committedHandoffId) : null;
  const committedHandoffMessage = committedHandoff
    ? ({ role: 'user', content: clip(resumeBootstrapText(committedHandoff.text)) } as ChatMessage)
    : null;
  let committedHandoffAt = -1;
  if (committedHandoffMessage?.content && committedHandoff) {
    for (let at = ordered.length - 1; at >= 0; at--) {
      if (ordered[at]?.role === 'user' && resumeBootstrapMatches(ordered[at]!.content, committedHandoff.text)) {
        committedHandoffAt = at;
        break;
      }
    }
  }

  // If the whole bounded read fits and contains the true first-user anchor, preserve it exactly.
  // Otherwise Goal Mode needs two anchors at once: the newest work tells it what just happened,
  // while the first user message tells it what the work was for.
  const totalChars = ordered.reduce((sum, message) => sum + message.content.length, 0);
  if (
    firstUserAt >= 0 &&
    (!committedHandoffMessage || committedHandoffAt >= 0) &&
    ordered.length <= MAX_CONTEXT_MESSAGES &&
    totalChars <= MAX_CONTEXT_CHARS
  ) {
    return ordered;
  }

  // Preserve anchors without disturbing chronology. An anchor still present in `ordered` keeps
  // its real index. One recovered from outside the tail sorts before every recent row but after
  // an original user request which itself came from outside the tail.
  const anchors: Array<{ at: number; message: ChatMessage }> = [];
  if (firstUser) anchors.push({ at: firstUserAt >= 0 ? firstUserAt : -2, message: firstUser });
  if (committedHandoffMessage?.content) {
    const duplicateFirst = firstUser?.role === 'user' && firstUser.content === committedHandoffMessage.content;
    if (!duplicateFirst) {
      anchors.push({
        at: committedHandoffAt >= 0 ? committedHandoffAt : -1,
        message: committedHandoffMessage
      });
    }
  }
  const anchorIndexes = new Set(anchors.filter((anchor) => anchor.at >= 0).map((anchor) => anchor.at));
  let chars = anchors.reduce((sum, anchor) => sum + anchor.message.content.length, 0);
  const tailSlots = Math.max(0, MAX_CONTEXT_MESSAGES - anchors.length);
  const selected: Array<{ at: number; message: ChatMessage }> = [];
  for (let at = ordered.length - 1; at >= 0 && selected.length < tailSlots; at--) {
    if (anchorIndexes.has(at)) continue;
    const message = ordered[at]!;
    if (chars + message.content.length > MAX_CONTEXT_CHARS) break;
    chars += message.content.length;
    selected.push({ at, message });
  }
  return [...anchors, ...selected]
    .sort((left, right) => left.at - right.at)
    .map((entry) => entry.message);
}

/*
 * ---------------------------------------------------------------------------------------
 * Typing it, rather than writing it
 * ---------------------------------------------------------------------------------------
 *
 * Two things give away a chat message a model composed, and neither of them survives being
 * asked nicely in a system prompt.
 *
 * The first is the em dash. It is not on a keyboard, nobody reaches for it halfway through
 * firing off a follow-up, and one of them in a lowercase two-sentence message is the whole
 * tell on its own.
 *
 * The second is that the message is *clean*. Real messages in a conversation like this one
 * have a dropped apostrophe or a transposed pair in them, because the person typing them did
 * not go back to fix it. A model asked to write casually still writes correctly.
 *
 * Both are applied to the finished reply, after `NO_REPLY` has been ruled out: the stopping
 * condition is matched against what the model actually said, never against a string this
 * file has been editing.
 *
 * ## Why none of it is random
 *
 * One finished turn is one message. A retried POST, a second observer and a reloaded tab all
 * ask for the same draft again, and the idempotency that keeps two messages out of somebody's
 * conversation only holds if asking twice returns the identical string. Anything drawn from a
 * clock or `Math.random` would quietly turn one draft into several different messages
 * depending on who asked and when. So the seed is the draft itself.
 */

/** FNV-1a over the draft, so every choice below is the draft's own and never a clock's. */
function seedOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0 || 1;
}

/** xorshift32. Small, and the only thing it decides is which words carry the mistakes. */
function stepped(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

/**
 * The em dash, and the spaced en dash that is the same move by another character.
 *
 * A comma is what that sentence looks like when it is typed instead, so that is the default.
 * The exceptions are the shapes where a comma would be wrong or doubled: a dash opening or
 * closing a line is a bullet or a trailing thought and simply goes, a dash already sitting
 * against punctuation leaves a space behind, and a dash between two digits is a range and
 * becomes the hyphen somebody would actually have reached for.
 *
 * The whitespace class is horizontal only. A plain `\s*` would have swallowed the newlines
 * around a dash at the start of a line and welded a list into one paragraph.
 */
function undash(text: string): string {
  return text.replace(/[^\S\r\n]*[—–][^\S\r\n]*/g, (match, at: number, whole: string) => {
    const before = at > 0 ? whole[at - 1] : '';
    const after = whole[at + match.length] ?? '';
    if (!before || before === '\n') return '';
    if (!after || after === '\n') return '';
    if (/[0-9]/.test(before) && /[0-9]/.test(after)) return '-';
    if (/[,;:]/.test(before) || /[,;:.!?]/.test(after)) return ' ';
    return ', ';
  });
}

/**
 * Text a mistake must never be put into.
 *
 * A typo is only harmless in prose. Inside a path, a command, a URL or a file name it is a
 * different instruction, and the whole point of this message is that ChatGPT acts on it.
 */
const PROTECTED = /```[\s\S]*?```|`[^`\n]*`|https?:\/\/\S+|\S+[\\/@]\S+|[\w-]+\.[\w-]+/g;

/** One plain lowercase word: no capitals, so an acronym or a model id is never a candidate. */
const CANDIDATE = /(?<![\w'’-])[a-z][a-z'’]{2,}[a-z](?![\w'’-])/g;

/**
 * The mistake this word would carry, or null when it has none available.
 *
 * In the order a real one happens. The dropped apostrophe is far and away the commonest and
 * the least jarring to read, so it is tried first; the collapsed double letter next; the
 * transposition last, because it is the most visible and a message full of them reads as
 * broken rather than as fast.
 */
function mistyped(word: string): string | null {
  if (/['’]/.test(word)) {
    const dropped = word.replace(/['’]/g, '');
    if (dropped.length >= 3 && dropped !== word) return dropped;
  }
  if (word.length >= 5) {
    const doubled = /([a-z])\1/.exec(word);
    if (doubled) return word.slice(0, doubled.index) + word.slice(doubled.index + 1);
  }
  if (word.length >= 5) {
    // Never the first or last letter: those are the two a reader recognises a word by at a
    // glance, and swapping either reads as a different word rather than as a slip.
    for (let at = Math.floor((word.length - 1) / 2); at >= 1; at--) {
      if (at + 1 <= word.length - 2 && word[at] !== word[at + 1]) {
        return word.slice(0, at) + word[at + 1] + word[at] + word.slice(at + 2);
      }
    }
  }
  return null;
}

/** Every word that could carry a mistake, with where it is and what it becomes. */
function typoSites(text: string): Array<{ at: number; word: string; typo: string }> {
  const guarded: Array<[number, number]> = [];
  PROTECTED.lastIndex = 0;
  for (let found = PROTECTED.exec(text); found; found = PROTECTED.exec(text)) {
    guarded.push([found.index, found.index + found[0].length]);
  }
  const out: Array<{ at: number; word: string; typo: string }> = [];
  CANDIDATE.lastIndex = 0;
  for (let found = CANDIDATE.exec(text); found; found = CANDIDATE.exec(text)) {
    const at = found.index;
    const word = found[0];
    if (guarded.some(([from, to]) => at < to && at + word.length > from)) continue;
    const typo = mistyped(word);
    if (typo) out.push({ at, word, typo });
  }
  return out;
}

/**
 * The finished draft, as it would have been typed.
 *
 * `undash` always runs. The mistakes are deliberately few — one, and one more for every
 * couple of hundred characters after that, never more than three — because a message with a
 * slip in every sentence is a tell of its own in the other direction. They are spread by
 * dividing the candidate words into that many buckets and taking one from each, so two of
 * them never land in the same breath.
 */
export function humanReply(reply: string): string {
  const text = undash(reply);
  const sites = typoSites(text);
  if (sites.length === 0) return text;
  const wanted = Math.min(3, 1 + Math.floor(text.length / 220));
  const next = stepped(seedOf(text));
  const chosen = new Set<number>();
  const bucket = sites.length / wanted;
  for (let index = 0; index < wanted; index++) {
    const from = Math.floor(index * bucket);
    const to = Math.max(from + 1, Math.min(sites.length, Math.floor((index + 1) * bucket)));
    chosen.add(from + (next() % (to - from)));
  }
  let out = text;
  // Back to front, so an edit never moves the offset of one still to come.
  for (const index of [...chosen].sort((a, b) => b - a)) {
    const site = sites[index]!;
    out = out.slice(0, site.at) + site.typo + out.slice(site.at + site.word.length);
  }
  return out;
}

function clip(text: string): string {
  const trimmed = (text ?? '').trim();
  if (trimmed.length <= MAX_MESSAGE_CHARS) return trimmed;
  // Goal Mode is specifically trying to decide what still remains after ChatGPT's *finished*
  // answer. Long answers commonly put the verification/result/conclusion at the end, so keeping
  // only the prefix can remove the exact evidence needed to stop the loop and make it ask for
  // work that is already done. Preserve both ends inside the same hard per-message budget.
  const marker = '\n[… cut …]\n';
  const contentBudget = MAX_MESSAGE_CHARS - marker.length;
  const head = Math.ceil(contentBudget / 2);
  const tail = contentBudget - head;
  return `${trimmed.slice(0, head)}${marker}${trimmed.slice(-tail)}`;
}

export interface GoalModel {
  id: string;
  name: string;
  /** Unix seconds, as OpenRouter publishes it. 0 when the listing did not say. */
  created: number;
  contextLength: number;
}

let modelCache: { at: number; keyScope: string; models: GoalModel[] } | null = null;

/**
 * The models OpenRouter currently publishes, newest first.
 *
 * Sorted by release date rather than alphabetically or by popularity, because the question
 * this picker answers is "what is new" — the whole reason to open it is that a better model
 * exists than the one already chosen. Paged, because the listing is several hundred long and
 * nobody scrolls that.
 */
export async function listGoalModels(offset = 0, limit = MODEL_PAGE_SIZE): Promise<{ models: GoalModel[]; total: number }> {
  const models = await allGoalModels();
  const from = Math.max(0, Math.floor(offset));
  const count = Math.max(1, Math.min(100, Math.floor(limit)));
  return { models: models.slice(from, from + count), total: models.length };
}

async function allGoalModels(): Promise<GoalModel[]> {
  const key = await getSecret('openRouterApiKey');
  // OpenRouter may return a key-restricted catalogue. A cache filled under key A is therefore
  // not valid under key B. Keep only a one-way fingerprint beside the models rather than the
  // credential itself; replacing a key immediately changes the cache scope without retaining
  // either secret for the five-minute listing TTL.
  const keyScope = key ? createHash('sha256').update(key).digest('hex') : 'public';
  if (modelCache && modelCache.keyScope === keyScope && Date.now() - modelCache.at < MODEL_CACHE_MS) {
    return modelCache.models;
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), MODEL_LIST_TIMEOUT_MS);
  let response: Response;
  let parsed: unknown;
  try {
    response = await fetch(`${OPENROUTER_BASE}/models`, {
      headers: {
        // The listing is public; the key is sent when there is one so a key with a restricted
        // model set sees its own set rather than the catalogue.
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...ATTRIBUTION_HEADERS
      },
      signal: abort.signal
    });
    if (!response.ok) throw new Error(`OpenRouter would not list its models (HTTP ${response.status})`);
    const raw = await boundedResponseText(response, MAX_MODEL_LIST_BODY_BYTES);
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      throw new Error('OpenRouter returned a model list this app could not read');
    }
  } catch (error) {
    if (abort.signal.aborted) throw new Error('OpenRouter model list request timed out');
    if (error instanceof Error && error.message === 'response_body_too_large') {
      throw new Error('OpenRouter model list response body was too large');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const raw = parsed && typeof parsed === 'object' ? (parsed as { data?: unknown }).data : null;
  if (!Array.isArray(raw)) throw new Error('OpenRouter returned a model list this app could not read');
  const models: GoalModel[] = [];
  for (const entry of raw) {
    if (models.length >= MAX_MODELS) break;
    if (!entry || typeof entry !== 'object') continue;
    const model = entry as { id?: unknown; name?: unknown; created?: unknown; context_length?: unknown };
    if (typeof model.id !== 'string' || model.id === '' || model.id.length > MAX_MODEL_FIELD_CHARS) continue;
    models.push({
      id: model.id,
      name:
        typeof model.name === 'string' && model.name
          ? model.name.slice(0, MAX_MODEL_FIELD_CHARS)
          : model.id,
      created: typeof model.created === 'number' && Number.isFinite(model.created) ? model.created : 0,
      contextLength:
        typeof model.context_length === 'number' && Number.isFinite(model.context_length) ? model.context_length : 0
    });
  }
  // Newest first, and ties broken by id so the order is stable between two identical calls
  // rather than dependent on the listing's own arrival order.
  models.sort((a, b) => (b.created - a.created) || a.id.localeCompare(b.id));
  modelCache = { at: Date.now(), keyScope, models };
  return models;
}
