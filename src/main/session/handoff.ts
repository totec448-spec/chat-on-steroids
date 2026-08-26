/**
 * Preparing and publishing a handoff.
 *
 * One store, one writer: the ChatGPT conversation being compacted writes its own brief as
 * its final answer, and this is where that brief is saved. The id is minted here rather
 * than taken from the text — a model that invents its own handoff id can collide with a
 * real one, overwrite it, or hand the next chat an id that resolves to somebody else's
 * brief.
 */

import { randomUUID } from 'node:crypto';
import type { Handoff } from '../../shared/session.js';
import { logInfo } from '../logger.js';
import { getSession, saveHandoff } from './store.js';

export interface PrepareHandoffInput {
  sessionId: string;
  /** The brief itself. */
  text: string;
  notes?: readonly string[];
  /** How the recording looked when the brief was written. Defaults to the session's own counts. */
  sourceEvents?: number;
  sourceTokens?: number;
}

/**
 * The exact ordinary user message typed into the replacement ChatGPT conversation.
 *
 * Keep this beside the stored handoff rather than in bridge.ts: Compact & Resume has two
 * consumers of the same semantic message. The browser command types it into chat B, and Goal
 * reconstructs that chat-facing conversation from the durable session after the local session
 * has been rebound. Sharing one formatter prevents those two model contexts from drifting.
 */
export function resumeBootstrapText(summary: string): string {
  return (
    'Continuing a Chat On Steroids session that was compacted. This is the brief the previous chat wrote about ' +
    'its own work; carry on from it rather than starting again.\n\n' +
    summary
  );
}

/**
 * Whether a recorded user row is the exact Compact & Resume bootstrap for one stored handoff.
 *
 * ChatGPT's rendered text has historically changed ordinary indentation spaces into NBSP. One
 * Windows/DOM path then surfaced those bytes as the literal mojibake pair `Â ` (U+00C2 U+00A0)
 * in the recorder. That is presentation damage, not authored-content drift. Canonicalise only
 * those known space artifacts plus line endings; deliberately do not trim/collapse
 * ordinary whitespace or normalize arbitrary Unicode, because this comparison is provenance.
 */
export function resumeBootstrapMatches(recorded: string, summary: string): boolean {
  const canonical = (value: string): string =>
    value.replace(/\u00c2\u00a0/g, ' ').replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n');
  return canonical(recorded) === canonical(resumeBootstrapText(summary));
}

/**
 * The shortest a brief may be before it is refused, for any session at all.
 *
 * Far below what the brief rules ask for — they target 10,000-30,000 tokens — because this
 * is not a quality bar. It is the line under which a document cannot be a handoff of
 * anything, whatever the session held.
 */
const MIN_BRIEF_CHARS = 200;
/** Above this much recorded context, a session's brief has real work to describe. */
const SUBSTANTIAL_SESSION_TOKENS = 20_000;
/** The floor that applies to those sessions. Still roughly a fortieth of the target. */
const MIN_SUBSTANTIAL_BRIEF_CHARS = 1_000;

/**
 * Why this text cannot be the brief for this session, or null if it can.
 *
 * Nothing downstream checks a brief. The chat that receives one has no way to tell a whole
 * handoff from the first line of one and acts on it either way, which is what makes a
 * truncated capture so much worse than a failed one. On 2026-08-23 a compaction turn was
 * declared finished 28 characters in and the app stored `TASK`, a newline and
 * `Continue implementing ` as the handoff for a session holding 455 events and 318,422
 * tokens; the replacement chat asked its own session for the handoff history, was told the
 * session had no recorded events, and rebuilt the work off the filesystem.
 *
 * The page-side settle window is what stops that happening. This is the floor underneath it,
 * and refusing here is cheap: a refused compaction leaves the user in the chat they were
 * already in, with the reason on screen and the button still there.
 */
export function briefShortfall(text: string, sourceTokens: number): string | null {
  const brief = text.trim();
  if (!brief) return 'ChatGPT answered the compaction request with nothing.';
  if (brief.length < MIN_BRIEF_CHARS) {
    return `ChatGPT wrote only ${brief.length} characters before its compaction turn looked finished, which is too little to continue any session from.`;
  }
  if (sourceTokens >= SUBSTANTIAL_SESSION_TOKENS && brief.length < MIN_SUBSTANTIAL_BRIEF_CHARS) {
    return `The brief is ${brief.length} characters for a session carrying about ${Math.round(sourceTokens / 1000)}k tokens of work, so it cannot be the whole handoff.`;
  }
  return null;
}

/** A fresh, unique handoff id. Never taken from a caller, and never from a model. */
export function newHandoffId(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
}

/**
 * Writes one handoff file without publishing it into the session timeline yet.
 *
 * Compact & Resume has a second durable boundary after this file: the continuation WAL
 * transition that says this exact handoff is claimable. Publishing the session `handoff`
 * event here used to cross those boundaries in the wrong order. If the WAL write then
 * failed, `summary.lastHandoffId` already advertised a brief the transaction had rejected,
 * and the retry wrote a second one. The continuation publishes the prepared file only after
 * its semantic state is durable; restart recovery repairs the tiny opposite crash window.
 */
export async function prepareHandoff(input: PrepareHandoffInput): Promise<Handoff> {
  const text = input.text.trim();
  if (!text) throw new Error('A handoff cannot be empty');
  const summary = await getSession(input.sessionId);
  if (!summary) throw new Error('That session no longer exists');
  // Checked again here, and not only at the bridge route that can word the refusal well,
  // because this is the one function that writes a handoff to disk. A stub that reaches the
  // store is indistinguishable from a real brief for the rest of its life.
  const shortfall = briefShortfall(text, input.sourceTokens ?? summary.estimatedTokens);
  if (shortfall) throw new Error(shortfall);
  const handoff: Handoff = {
    id: newHandoffId(),
    sessionId: input.sessionId,
    createdAt: Date.now(),
    text,
    sourceEvents: input.sourceEvents ?? summary.events,
    sourceTokens: input.sourceTokens ?? summary.estimatedTokens,
    // The working folder is deliberately not here. It belongs to the durable local session
    // and moves with the session's rebind (see `moveChatWorkspace`), so writing it into the
    // brief as well would be a second, weaker copy of state the commit already carries.
    notes: [...(input.notes ?? [])]
  };
  await saveHandoff(handoff);
  logInfo(`handoff ${handoff.id} prepared (${handoff.text.length} characters)`);
  return handoff;
}
