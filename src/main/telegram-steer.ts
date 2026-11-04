/**
 * A reply to a Telegram notification as the person's message for that chat (Telegram phase 2,
 * 2026-10-31). A message can make ChatGPT run tools on this computer, so it goes only with its own
 * switch on (off by default), only to a chat the person talks to (never a worker or helper), and
 * only through the composer's own send path; while the chat works, the app's follow-up choice
 * decides whether it goes into the answer or after it, as for a message typed in the composer.
 */
import { randomUUID } from 'node:crypto';
import type { InputArgs, InputEntry } from './session/input.js';

export interface SteerDeps {
  /** The "Let replies send messages to chats" switch. */
  allowed(): boolean;
  session(sessionId: string): Promise<{ conversationId: string | null; activeTurnId?: string | null; origin?: { kind: string } | null } | null>;
  /** The app's follow-up setting is "queue": a message sent while ChatGPT works waits for its answer. */
  followUpQueues(): boolean;
  send(input: InputArgs): Promise<InputEntry>;
  log(line: string): void;
}

/** ChatGPT's own limit is far above a Telegram message (4096 characters); this only bounds it. */
const MAX_TEXT = 16_000;

export async function steerFromTelegram(deps: SteerDeps, sessionId: string, text: string): Promise<'sent' | 'queued' | 'off' | 'refused' | 'failed'> {
  if (!deps.allowed()) return 'off';
  const trimmed = text.trim().slice(0, MAX_TEXT);
  const session = await deps.session(sessionId).catch(() => null);
  if (!trimmed || !session?.conversationId || session.origin?.kind === 'worker' || session.origin?.kind === 'helper') return 'refused';
  const mode = session.activeTurnId && deps.followUpQueues() ? 'after-turn' as const : 'auto' as const;
  try {
    // Marked so the chat shows it came from Telegram, where the person can check what happened remotely (Haz on #1990).
    const row = await deps.send({ id: randomUUID(), sessionId, text: trimmed, mode, dueAt: Date.now(), model: null, reasoningEffort: null, authoredSource: 'text', via: 'telegram' });
    deps.log(`telegram: a reply became message ${row.id} for session ${sessionId} (${mode})`);
    return row.state === 'failed' ? 'failed' : mode === 'after-turn' ? 'queued' : 'sent';
  } catch (error) {
    deps.log(`telegram: could not send a reply to session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    return 'failed';
  }
}
