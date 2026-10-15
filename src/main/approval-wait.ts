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
 *
 * Since 2.1.38 the person can answer it in the app (the maintainer's request, 2026-10-14): the page
 * reports the card's words, an id for that exact card and whether ChatGPT lets Allow once be pressed.
 * A click in the app files one answer for that card id, which the same page's next poll carries
 * back; the page presses the button only if the card it shows is still that card. A replaced card,
 * a second click or an answer nobody took within `APPROVAL_ANSWER_MS` sends nothing.
 */
import { randomUUID } from 'node:crypto';
import { APPROVAL_ANSWERED_TEXT, APPROVAL_PROGRESS_PREFIX, APPROVAL_WAITING_TEXT, type ApprovalCardView } from '../shared/approval-wait.js';

/** Hidden idle tabs poll every 30 s; two missed polls end the episode. */
export const APPROVAL_FRESH_MS = 75_000;
/** Time for a person looking at the card to answer it before a desktop notice interrupts them. */
export const APPROVAL_NOTICE_GRACE_MS = 30_000;
/** How long an answer waits for the card's page to take it; a visible card's page polls every 2 s. */
export const APPROVAL_ANSWER_MS = 30_000;

/** What the page reports about the card it shows. */
export interface ApprovalCardFacts { id: string; lines: string[]; allow: boolean }
export type ApprovalChoice = 'allow' | 'deny';
export type ApprovalOutcome = 'clicked' | 'card_changed' | 'unavailable' | 'expired';
interface ApprovalAnswer { token: string; cardId: string; choice: ApprovalChoice; at: number; outcome: ApprovalOutcome | null }

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
  card: ApprovalCardFacts | null;
  answer: ApprovalAnswer | null;
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
  now = Date.now(),
  card?: ApprovalCardFacts | null
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
    wait = { since: now, seenAt: now, noticed: false, progressId: `${APPROVAL_PROGRESS_PREFIX}${conversationId}:${now}`, sessionId: null, row: null, card: null, answer: null };
    waits.set(conversationId, wait);
    deps.log(`bridge: ${conversationId} waits for the user to answer ChatGPT's tool approval card`);
  }
  wait.seenAt = now;
  if (card) {
    // Another card replaces this one: an answer filed for the old card must never reach it.
    if (wait.card && wait.card.id !== card.id) wait.answer = null;
    wait.card = card;
  }
  if (sessionId && !wait.sessionId) {
    wait.sessionId = sessionId;
    wait.row = deps.record(sessionId, wait.progressId, APPROVAL_WAITING_TEXT).catch(() => null);
  }
  if (wait.sessionId && !wait.noticed && now - wait.since >= APPROVAL_NOTICE_GRACE_MS) {
    wait.noticed = true;
    try { deps.notify(wait.sessionId); } catch { /* The row still says it. */ }
  }
}

/** The card a person can answer in the app, with the last answer filed for it. */
export function approvalCardView(conversationId: string, now = Date.now()): ApprovalCardView | null {
  const wait = waits.get(conversationId);
  if (!wait?.card || now - wait.seenAt >= APPROVAL_FRESH_MS) return null;
  expire(wait, now);
  return { ...wait.card, lines: [...wait.card.lines], answer: wait.answer ? { choice: wait.answer.choice, outcome: wait.answer.outcome } : null };
}

/** A person's click in the app: one answer for exactly the card they were shown. */
export function requestApprovalAnswer(conversationId: string, cardId: string, choice: ApprovalChoice, now = Date.now()):
  { ok: true; token: string } | { ok: false; error: 'no_card' | 'card_changed' | 'allow_unavailable' | 'answer_pending' | 'bad_choice' } {
  if (choice !== 'allow' && choice !== 'deny') return { ok: false, error: 'bad_choice' };
  const wait = waits.get(conversationId);
  if (!wait?.card || now - wait.seenAt >= APPROVAL_FRESH_MS) return { ok: false, error: 'no_card' };
  if (wait.card.id !== cardId) return { ok: false, error: 'card_changed' };
  if (choice === 'allow' && !wait.card.allow) return { ok: false, error: 'allow_unavailable' };
  expire(wait, now);
  if (wait.answer && wait.answer.outcome === null) return { ok: false, error: 'answer_pending' };
  wait.answer = { token: randomUUID(), cardId, choice, at: now, outcome: null };
  return { ok: true, token: wait.answer.token };
}

/** The answer this chat's page should carry out on its next poll, if one is waiting. */
export function approvalAnswerFor(conversationId: string, now = Date.now()): { token: string; cardId: string; choice: ApprovalChoice } | null {
  const wait = waits.get(conversationId);
  if (!wait?.answer) return null;
  expire(wait, now);
  const answer = wait.answer;
  return answer && answer.outcome === null ? { token: answer.token, cardId: answer.cardId, choice: answer.choice } : null;
}

/** The page's report on an answer it was given: pressed, or why not. Unknown tokens are ignored. */
export function settleApprovalAnswer(conversationId: string, token: string, outcome: Exclude<ApprovalOutcome, 'expired'>): boolean {
  const answer = waits.get(conversationId)?.answer;
  if (!answer || answer.token !== token || answer.outcome !== null) return false;
  answer.outcome = outcome;
  return true;
}

/** The page's card report from its activity poll; anything malformed is no card at all. */
export function parseApprovalCard(raw: string | null): ApprovalCardFacts | null {
  if (!raw || raw.length > 8_000) return null;
  try {
    const value = JSON.parse(raw) as Partial<ApprovalCardFacts>;
    if (typeof value?.id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(value.id) || typeof value.allow !== 'boolean' || !Array.isArray(value.lines)) return null;
    const lines = value.lines.filter((line): line is string => typeof line === 'string')
      .map(line => line.replace(/\s+/g, ' ').trim().slice(0, 300)).filter(Boolean).slice(0, 8);
    return { id: value.id, lines, allow: value.allow };
  } catch { return null; }
}

/** The page's report on an answer it was given, from its activity poll. */
export function parseApprovalResult(raw: string | null): { token: string; outcome: Exclude<ApprovalOutcome, 'expired'> } | null {
  if (!raw || raw.length > 500) return null;
  try {
    const value = JSON.parse(raw) as { token?: unknown; outcome?: unknown };
    if (typeof value?.token !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(value.token)) return null;
    return value.outcome === 'clicked' || value.outcome === 'card_changed' || value.outcome === 'unavailable'
      ? { token: value.token, outcome: value.outcome } : null;
  } catch { return null; }
}

function expire(wait: Wait, now: number): void {
  if (wait.answer && wait.answer.outcome === null && now - wait.answer.at >= APPROVAL_ANSWER_MS) wait.answer.outcome = 'expired';
}

export function resetApprovalWaits(): void {
  waits.clear();
}
