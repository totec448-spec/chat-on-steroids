/**
 * The user's stop button for a ChatGPT turn that ChatGPT itself will no longer stop.
 *
 * A wedged ChatGPT page can leave a turn running with no working Stop control: the model
 * keeps issuing connector calls, the user can neither see the turn's messages nor cancel it,
 * and every one of those calls arrives here as an ordinary, correctly attributed request. The
 * app cannot end that server-side turn — nothing it can reach owns it. What it does own is
 * whether the turn gets to touch this machine, and refusing every tool it calls is enough:
 * a model with no working tools and an explicit instruction to stop answers and ends the turn.
 *
 * The blocked thing is a **conversation**, not a request id, even though a request id is what
 * the refusal is actually matched on. `correlation.ts` already proves `requestId ->
 * conversationId` exactly, and one ChatGPT turn issues all of its connector calls under one
 * request id, so a conversation is the only key that stays true for the whole rogue turn and
 * for the next one after it. Enumerating request ids would ban the turn the user was looking
 * at and nothing the same chat did a second later.
 *
 * The block is therefore exact-identity only, and deliberately so: it refuses a call whose
 * proven owner is blocked and never a call whose owner is merely unknown. Guessing here would
 * refuse an innocent chat's file read to punish a different chat's turn, which is the trade this
 * whole codebase refuses to make everywhere else.
 *
 * What that costs, and where it was originally got wrong: "the user blocks a chat whose request
 * id is already proven" is true of the turn the user was looking at and of nothing after it. A
 * new turn brings a new request id, and a wedged page — the whole reason this exists — is the
 * page least able to report one promptly. Enforcement that only read already-proven identity
 * therefore let a blocked chat keep running tools that the recorder, which does wait for late
 * evidence, then filed under that same blocked chat. Waiting for the exact request-id mate is
 * not guessing, so the enforcement gate in kernel.ts waits exactly as long as attribution does.
 *
 * Blocks are durable and released only by the user. A restart is not a reason to hand a rogue
 * turn its tools back; the turn can outlive the app.
 */

import { readDurable, writeDurableSoon } from '../durable.js';

/**
 * A hand-curated list, so the ceiling only exists to keep a corrupt or hostile state file from
 * growing without bound. Reaching it is a real error the user sees, never a silent eviction:
 * evicting the oldest entry would quietly unblock a chat the user stopped on purpose.
 */
const MAX_BLOCKED_CHATS = 200;
const BLOCKED_STATE = 'blocked-chats';
const BLOCKED_STATE_VERSION = 1;

/** Conversation id -> when the user blocked it. */
const blocked = new Map<string, number>();
let restored = false;

interface PersistedBlocks {
  version: number;
  entries: Array<{ conversationId: string; blockedAt: number }>;
}

/**
 * The one thing a blocked chat's model is told, on every tool it tries.
 *
 * Written as an instruction rather than a diagnosis because the model is the only party that
 * can end the turn: it names the state, forbids the retry loop a bare failure invites, and
 * asks for the one action that finishes — a final answer. `CHAT_BLOCKED:` matches the prefix
 * convention the other kernel refusals use.
 */
export const BLOCKED_CHAT_REFUSAL =
  'CHAT_BLOCKED: the user blocked this conversation from using local tools, and no tool was run. ' +
  'This session went rogue. Stop right now: abandon the task, make no further tool calls of any ' +
  'kind, and reply to the user immediately with your final answer. The user explicitly asked for this.';

function snapshot(): PersistedBlocks {
  return {
    version: BLOCKED_STATE_VERSION,
    entries: [...blocked].map(([conversationId, blockedAt]) => ({ conversationId, blockedAt }))
  };
}

function validConversationId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-z-]{8,64}$/i.test(value);
}

/**
 * Loads the blocked set before the MCP endpoint can accept a call.
 *
 * A block that arrives one call late is a block the rogue turn got one more tool out of, so
 * this runs alongside the correlation restore rather than lazily on first use.
 */
export async function restoreBlockedChats(): Promise<void> {
  if (restored) return;
  restored = true;
  const saved = await readDurable<PersistedBlocks>(BLOCKED_STATE);
  if (!saved || saved.version !== BLOCKED_STATE_VERSION || !Array.isArray(saved.entries)) return;
  for (const entry of saved.entries.slice(0, MAX_BLOCKED_CHATS)) {
    if (!entry || typeof entry !== 'object') continue;
    const { conversationId, blockedAt } = entry as { conversationId?: unknown; blockedAt?: unknown };
    if (!validConversationId(conversationId)) continue;
    blocked.set(conversationId, typeof blockedAt === 'number' && Number.isFinite(blockedAt) ? blockedAt : Date.now());
  }
}

/**
 * Whether any block exists at all.
 *
 * The kernel's cheap way to ask whether it is worth resolving a call's identity before deciding
 * — see the block gate in kernel.ts. An install with no blocked chat pays one map read per call
 * and never waits on the browser for this.
 */
export function anyChatBlocked(): boolean {
  return blocked.size > 0;
}

/** Exact lookup. An unproven caller has no conversation and is therefore never blocked. */
export function isChatBlocked(conversationId: string | null | undefined): boolean {
  return conversationId !== null && conversationId !== undefined && blocked.has(conversationId);
}

/** Every blocked conversation, so one renderer paint can mark all of its rows at once. */
export function blockedChatIds(): string[] {
  return [...blocked.keys()];
}

/**
 * Blocks or releases one conversation. Idempotent in both directions: the user pressing the
 * button twice must not move a block's timestamp or resurrect a released one.
 */
export function setChatBlocked(conversationId: string, next: boolean): void {
  if (!validConversationId(conversationId)) throw new Error('Not a ChatGPT conversation id');
  if (next === blocked.has(conversationId)) return;
  if (next) {
    if (blocked.size >= MAX_BLOCKED_CHATS) {
      throw new Error(`Too many blocked chats (${MAX_BLOCKED_CHATS}). Release one before blocking another.`);
    }
    blocked.set(conversationId, Date.now());
  } else {
    blocked.delete(conversationId);
  }
  writeDurableSoon(BLOCKED_STATE, snapshot());
}

export function resetBlockedChatsForTests(): void {
  blocked.clear();
  restored = false;
}
