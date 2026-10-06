/**
 * Chats whose ChatGPT page shows ChatGPT's own tool approval card.
 *
 * Found by the VM stress test on 2026-10-06: a Loop ran ten clean turns, then ChatGPT asked
 * "Allow ChatGPT to use Chat On Steroids Core?" before an `echo` and flagged it as suspicious.
 * Only a person can answer that card. No call reached the app, silence recovery found nothing it
 * could repair, and the chat stood still with nobody told.
 *
 * The page reports the card on every activity poll. While it stands, this module says so once
 * in the chat's timeline, sends one desktop notice after a short grace (a person already looking
 * at the card answers it first), and holds recovery: a reload or a Continue cannot answer the
 * card and could lose it. The app never answers the card itself; that consent is the user's.
 */
import { APPROVAL_ANSWERED_TEXT, APPROVAL_PROGRESS_PREFIX, APPROVAL_WAITING_TEXT } from '../shared/approval-wait.js';

/** Hidden idle tabs poll every 30 s; two missed polls end the episode. */
export const APPROVAL_FRESH_MS = 75_000;
/** Time for a person looking at the card to answer it before a desktop notice interrupts them. */
export const APPROVAL_NOTICE_GRACE_MS = 30_000;

export interface ApprovalWaitDeps {
  record(sessionId: string, progressId: string, text: string, anchor?: { seq: number; time: number }): Promise<{ seq: number; time: number } | null>;
  notify(sessionId: string): void;
  log(message: string): void;
}

interface Wait {
  since: number;
  seenAt: number;
  noticed: boolean;
  progressId: string;
  sessionId: string | null;
  row: Promise<{ seq: number; time: number } | null> | null;
}

const waits = new Map<string, Wait>();

/** Whether this chat's page said, recently enough to still be true, that the card is waiting. */
export function approvalCardWaiting(conversationId: string, now = Date.now()): boolean {
  const wait = waits.get(conversationId);
  return !!wait && now - wait.seenAt < APPROVAL_FRESH_MS;
}

/**
 * One activity poll's word on the card. `sessionId` is the recorded session of this chat, if any:
 * the row and the notice need one, the recovery hold does not.
 */
export async function noteApprovalCard(
  conversationId: string,
  waiting: boolean,
  sessionId: string | null,
  deps: ApprovalWaitDeps,
  now = Date.now()
): Promise<void> {
  let wait = waits.get(conversationId);
  if (wait && (!waiting || now - wait.seenAt >= APPROVAL_FRESH_MS)) {
    waits.delete(conversationId);
    deps.log(`bridge: ${conversationId} no longer shows ChatGPT's tool approval card`);
    // Only an answer seen on the page itself rewrites the row; a page that stopped reporting
    // says nothing about the card.
    const anchor = waiting ? null : await wait.row;
    if (anchor && wait.sessionId) await deps.record(wait.sessionId, wait.progressId, APPROVAL_ANSWERED_TEXT, anchor).catch(() => null);
    wait = undefined;
  }
  if (!waiting) return;
  if (!wait) {
    wait = { since: now, seenAt: now, noticed: false, progressId: `${APPROVAL_PROGRESS_PREFIX}${conversationId}:${now}`, sessionId: null, row: null };
    waits.set(conversationId, wait);
    deps.log(`bridge: ${conversationId} waits for the user to answer ChatGPT's tool approval card`);
  }
  wait.seenAt = now;
  if (sessionId && !wait.sessionId) {
    wait.sessionId = sessionId;
    wait.row = deps.record(sessionId, wait.progressId, APPROVAL_WAITING_TEXT).catch(() => null);
  }
  if (wait.sessionId && !wait.noticed && now - wait.since >= APPROVAL_NOTICE_GRACE_MS) {
    wait.noticed = true;
    try { deps.notify(wait.sessionId); } catch { /* The row still says it. */ }
  }
}

export function resetApprovalWaits(): void {
  waits.clear();
}
