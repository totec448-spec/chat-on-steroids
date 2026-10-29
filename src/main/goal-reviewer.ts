/**
 * The Goal step reviewer at work (#1832, Haz's review). When a Goal step that edited files ends,
 * the Goal chat's reviewer worker is asked to read the step's changes; its answer goes into the
 * next step's message. The brief is `goal-review.ts`; the worker, its hold on the chat and its
 * reviewer chat (no edits, no workers) are the broker's and the kernel's (`agents.ts`, `mcp/kernel.ts`).
 *
 * One reviewer per Goal chat, reused: a sleeping one is woken with the next step's brief, and a
 * new one starts only when there is none, it can no longer be woken, or the chosen model changed.
 * It waits for a free worker slot at most REVIEW_MAX_MS, and a review never blocks Goal for good:
 * the hold ends with the reviewer's answer or that limit, whichever comes first.
 */

import type { AgentInfo, SessionEvent } from '../shared/session.js';
import type { GoalMode } from '../shared/types.js';
import { resolveChatModel, type ChatModelOption } from '../shared/chat-models.js';
import { logInfo, logWarn } from './logger.js';
import { reviewBrief, type ReviewFile } from './goal-review.js';
import { unifiedDiff } from './text-diff.js';
import { netTurnChanges, netTurnFileDiff, turnFileEdits, type ReviewReader } from './session/turn-changes.js';
import { REVIEW_MAX_MS, clearAgent, occupiesSlot, persistAgentAuthorityNow, requestWorkerBootstraps, requestWorkerRevivals, reviewerFor, stageMessages, type Caller } from './agents.js';
import { getChatModels } from './chat-models.js';
import { getConfig } from './config.js';
import { goalDrivingMode, goalObjectiveFor } from './goal.js';

/** How often the next step's draft looks again for a review still in progress. */
const DRAFT_POLL_MS = 1_000;
/** How often a review that found every worker slot busy tries again. */
const SLOT_RETRY_MS = 15_000;
/** The reviewer's answer in the next step's message, at most. */
const NOTE_CHARS = 4_000;

export interface StepFacts {
  files: ReviewFile[];
  more: number;
  /** The message that started the step. */
  step: string;
  /** The first request in the chat, for a Goal chat without its own objective. */
  firstRequest: string;
  /** The model the Goal chat's own messages were sent with, when recorded. */
  chatModel: string | null;
}

export interface StepReviewDeps {
  settings(): { reviewerModel: string; workersOn: boolean; profileId: string };
  mode(conversationId: string): GoalMode;
  objective(conversationId: string): string;
  facts(sessionId: string, turnId: string): Promise<StepFacts>;
  offered(): readonly ChatModelOption[];
  reviewer(conversationId: string): AgentInfo | null;
  spawn(caller: Caller, brief: string, model: string | null): Promise<string>;
  wake(caller: Caller, workerId: string, brief: string): Promise<void>;
  /** Ends a working reviewer's review; its chat stays as history. */
  cancel(info: AgentInfo): Promise<void>;
  now(): number;
  wait(ms: number): Promise<void>;
}

export type StepReviewStart = 'asked' | 'off' | 'repeat' | 'loop' | 'no-workers' | 'no-edits' | 'busy' | 'no-slot' | 'failed';
export type DraftReview = { text: string } | { timedOut: true } | { unavailable: true } | { pending: true } | null;

interface ReviewRow { turnId: string; askedAt: number; workerId: string | null }
/** The step each Goal chat's reviewer was last asked about. In memory: after a restart Goal just goes on. */
const reviews = new Map<string, ReviewRow>();

const textOf = (event: SessionEvent): string => event.kind === 'user_message' ? event.authoredText ?? event.message.text : '';

/** The step's facts from the chat's recording: its instruction, the first request, the model, and each changed file's net diff. */
export async function stepFacts(events: readonly SessionEvent[], turnId: string, read: ReviewReader): Promise<StepFacts> {
  const start = events.find(event => event.kind === 'turn_start' && event.turnId === turnId)?.seq ??
    events.find(event => event.turnId === turnId)?.seq ?? Number.MAX_SAFE_INTEGER;
  const questions = events.filter(event => event.kind === 'user_message');
  const before = questions.filter(event => event.seq < start);
  const files = turnFileEdits(events, turnId);
  const changes = await netTurnChanges(files, read);
  const reviewed: ReviewFile[] = [];
  for (const change of changes) {
    const ends = change.diff === 'kept' && change.state !== 'unchanged' ? await netTurnFileDiff(files, change.path, read) : null;
    reviewed.push({ path: change.path, state: change.state, added: change.added, removed: change.removed, approximate: change.approximate,
      edits: change.edits, diff: change.state === 'unchanged' ? '' : ends ? unifiedDiff(ends.before, ends.after) : null,
      unavailable: change.diff === 'kept' ? null : change.diff });
  }
  return {
    files: reviewed,
    more: Math.max(0, files.length - changes.length),
    step: before.length ? textOf(before.at(-1)!) : '',
    firstRequest: questions.length ? textOf(questions[0]!) : '',
    chatModel: [...before].reverse().find(event => event.model)?.model ?? null
  };
}

function reviewerModel(setting: string, chatModel: string | null, offered: readonly ChatModelOption[]): string | null {
  if (setting === 'same') return chatModel;
  const match = resolveChatModel([...offered], setting);
  if (match) return match.id;
  logInfo(`goal review: the reviewer model ${setting} is not offered; using the Goal chat's model`);
  return chatModel;
}

const slotTaken = (error: unknown): boolean =>
  /live workers|NO_FREE_SLOT|GLOBAL_WORKER_LIMIT|SPAWN_IN_PROGRESS/.test(error instanceof Error ? error.message : String(error));

/** Asks the Goal chat's reviewer to review the step that just ended. Never throws; Goal goes on either way. */
export async function startStepReview(input: { conversationId: string; sessionId: string; turnId: string }, deps: StepReviewDeps = defaultDeps()): Promise<StepReviewStart> {
  const { conversationId, sessionId, turnId } = input;
  const settings = deps.settings();
  if (!settings.reviewerModel) return 'off';
  if (reviews.get(conversationId)?.turnId === turnId) return 'repeat';
  if (deps.mode(conversationId) !== 'goal') { logInfo(`goal review: not started for ${conversationId}: Loop is not reviewed`); return 'loop'; }
  if (!settings.workersOn) { logInfo(`goal review: not started for ${conversationId}: Sub-agents are off`); return 'no-workers'; }
  const row: ReviewRow = { turnId, askedAt: deps.now(), workerId: null };
  reviews.set(conversationId, row);
  try {
    const facts = await deps.facts(sessionId, turnId);
    if (!facts.files.length) {
      logInfo(`goal review: step ${turnId} in ${conversationId} changed no files with the edit tools; nothing to review`);
      reviews.delete(conversationId);
      return 'no-edits';
    }
    const brief = reviewBrief({ objective: deps.objective(conversationId) || facts.firstRequest, step: facts.step, files: facts.files, more: facts.more });
    const model = reviewerModel(settings.reviewerModel, facts.chatModel, deps.offered());
    const caller: Caller = { conversationId, sessionId, setupProfileId: settings.profileId };
    const started = deps.now();
    for (;;) {
      if (reviews.get(conversationId) !== row) return 'failed';
      const current = deps.reviewer(conversationId);
      if (current && occupiesSlot(current.state)) {
        logInfo(`goal review: ${current.id} is still reviewing an earlier step in ${conversationId}; step ${turnId} is not reviewed`);
        reviews.delete(conversationId);
        return 'busy';
      }
      try {
        if (current && current.state === 'sleeping' && current.revivable !== false && (current.model ?? null) === model) {
          await deps.wake(caller, current.id, brief);
          row.workerId = current.id;
        } else {
          row.workerId = await deps.spawn(caller, brief, model);
        }
        // Goal stopped while the reviewer was being started: the stop could not cancel it yet, so this does.
        if (reviews.get(conversationId) !== row) {
          const info = deps.reviewer(conversationId);
          if (info && info.id === row.workerId && occupiesSlot(info.state)) await deps.cancel(info);
          logInfo(`goal review: Goal stopped in ${conversationId} while ${row.workerId} was being asked; its review was cancelled, its chat stays`);
          return 'failed';
        }
        row.askedAt = deps.now();
        const count = facts.files.length + facts.more;
        logInfo(`goal review: asked ${row.workerId} to review step ${turnId} in ${conversationId} (${count} file${count === 1 ? '' : 's'})`);
        return 'asked';
      } catch (error) {
        if (!slotTaken(error)) throw error;
        if (deps.now() - started + SLOT_RETRY_MS > REVIEW_MAX_MS) {
          logInfo(`goal review: no worker slot came free for step ${turnId} in ${conversationId} within 10 minutes; not reviewed`);
          reviews.delete(conversationId);
          return 'no-slot';
        }
        await deps.wait(SLOT_RETRY_MS);
      }
    }
  } catch (error) {
    logWarn(`goal review: could not ask for a review of step ${turnId} in ${conversationId}: ${error instanceof Error ? error.message : String(error)}`);
    if (reviews.get(conversationId) === row) reviews.delete(conversationId);
    return 'failed';
  }
}

const REPORT_HEADER = /^[ \t]*(?:\*\*)?(RESULT|CHANGES|VALIDATION|BLOCKERS)(?:\*\*)?[ \t]*:(?:\*\*)?[ \t]*/gim;

/**
 * The review in a reviewer's answer. Workers finish under RESULT / CHANGES / VALIDATION / BLOCKERS
 * (the agents tool asks for it), and the brief puts the review in RESULT; any other answer is the review.
 */
export function reviewAnswer(text: string): string {
  const headers = [...text.matchAll(REPORT_HEADER)];
  const result = headers.findIndex(match => match[1]!.toUpperCase() === 'RESULT');
  if (result < 0) return text.trim();
  const start = headers[result]!.index! + headers[result]![0].length;
  const end = headers[result + 1]?.index ?? text.length;
  return text.slice(start, end).trim() || text.trim();
}

/** The review of exactly this step for its next message: the answer, a timeout, still pending, or none asked. */
export function reviewForDraft(conversationId: string, turnId: string, deps: Pick<StepReviewDeps, 'reviewer' | 'now'> = defaultDeps()): DraftReview {
  const row = reviews.get(conversationId);
  if (!row || row.turnId !== turnId) return null;
  // Still reading the step or waiting for a worker slot: startStepReview drops the row when it gives up.
  if (!row.workerId) return deps.now() - row.askedAt >= REVIEW_MAX_MS ? { timedOut: true } : { pending: true };
  const info = deps.reviewer(conversationId);
  const fresh = !!info && info.id === row.workerId;
  if (fresh && info.result?.trim() && (info.sleptAt ?? info.finishedAt ?? 0) >= row.askedAt) return { text: reviewAnswer(info.result) };
  // The reviewer stopped (failed, cleared, or slept) without answering this step: nothing more will come.
  if (!fresh || !occupiesSlot(info.state)) return { unavailable: true };
  return deps.now() - row.askedAt >= REVIEW_MAX_MS ? { timedOut: true } : { pending: true };
}

/**
 * Until when the next step waits for this chat's review in progress, or null when none is: from
 * reading the step and finding a worker slot to the reviewer's answer. The reviewer's own hold
 * (`reviewerHoldUntil`) shows only a reviewer that already has its slot.
 */
export function reviewWaitUntil(conversationId: string, deps: Pick<StepReviewDeps, 'reviewer' | 'now'> = defaultDeps()): number | null {
  const row = reviews.get(conversationId);
  if (!row) return null;
  const review = reviewForDraft(conversationId, row.turnId, deps);
  return review && 'pending' in review ? row.askedAt + REVIEW_MAX_MS : null;
}

/**
 * The review of this step once it is in, for the draft of the next step: the draft waits for a review
 * still in progress (at most until REVIEW_MAX_MS from when it was asked), and stops waiting, with no
 * review, as soon as `wanted` says the draft is no longer needed.
 */
export async function awaitStepReview(conversationId: string, turnId: string, wanted: () => boolean,
  deps: Pick<StepReviewDeps, 'reviewer' | 'now' | 'wait'> = defaultDeps()): Promise<DraftReview> {
  let logged = false;
  for (;;) {
    const review = reviewForDraft(conversationId, turnId, deps);
    if (!review || !('pending' in review)) return review;
    if (!wanted()) return null;
    if (!logged) { logInfo(`goal review: the next step in ${conversationId} waits for the review of step ${turnId}`); logged = true; }
    await deps.wait(DRAFT_POLL_MS);
  }
}

/** The line the next step's message gets; nothing for "No problems found" or no review. */
export function reviewNote(review: DraftReview): string {
  if (!review || 'pending' in review) return '';
  if ('timedOut' in review) return 'Reviewer did not answer in time.';
  if ('unavailable' in review) return 'Reviewer could not review this step.';
  const text = review.text.trim();
  if (/^no problems found\.?$/i.test(text)) return '';
  return `Reviewer: ${text.length > NOTE_CHARS ? `${text.slice(0, NOTE_CHARS - 1)}…` : text}`;
}

/** Whether the reviewer said Goal cannot safely go on. */
export function reviewBlocks(review: DraftReview): boolean {
  return !!review && 'text' in review && /^BLOCKING:/i.test(review.text.trim());
}

/** The Goal stopped (switched off): a review in progress is cancelled, its chat stays as history. True when one was. */
export async function cancelStepReview(conversationId: string, deps: Pick<StepReviewDeps, 'reviewer' | 'cancel'> = defaultDeps()): Promise<boolean> {
  reviews.delete(conversationId);
  const info = deps.reviewer(conversationId);
  if (!info || !occupiesSlot(info.state)) return false;
  await deps.cancel(info);
  logInfo(`goal review: Goal stopped in ${conversationId}; the review by ${info.id} was cancelled, its chat stays`);
  return true;
}

export function resetStepReviewsForTests(): void { reviews.clear(); }

function defaultDeps(): StepReviewDeps {
  return {
    settings: () => {
      const config = getConfig();
      return { reviewerModel: config.goal.reviewerModel ?? '', workersOn: config.multiAgent.enabled, profileId: config.tunnel.profileId ?? 'default' };
    },
    mode: conversationId => goalDrivingMode(conversationId),
    objective: conversationId => goalObjectiveFor(conversationId),
    facts: async (sessionId, turnId) => {
      const { readEvents, readEditReviewAsset } = await import('./session/store.js');
      const events = await readEvents(sessionId, { kinds: ['user_message', 'turn_start', 'turn_end', 'tool_call'] });
      return stepFacts(events, turnId, at => at.assetId ? readEditReviewAsset(sessionId, at.assetId) : Promise.resolve(null));
    },
    offered: () => getChatModels().models,
    reviewer: conversationId => reviewerFor(conversationId),
    spawn: async (caller, brief, model) => {
      const { spawnAgentWorkers } = await import('./agent-admission.js');
      const result = await spawnAgentWorkers({ caller, workers: [{ task: brief, model, reviewer: true }] }, async () => null, () => false);
      requestWorkerBootstraps(result.created.map(worker => worker.id), result.runId);
      const id = result.created[0]?.id;
      if (!id) throw new Error('no reviewer was created');
      return id;
    },
    wake: async (caller, workerId, brief) => {
      const { acceptAgentMutation } = await import('./agent-admission.js');
      const staged = stageMessages(caller, [{ to: workerId, text: brief }], { review: true });
      await acceptAgentMutation(staged, 'The review could not cross its durable acceptance barrier.');
      requestWorkerRevivals(staged.waking, staged.runId);
    },
    cancel: async info => {
      // As the person's own Clear on the worker's row: the slot frees and its queued start or wake is withdrawn.
      const outcome = clearAgent(info.id, info.runId);
      if (outcome.cleared === 'none') return;
      if (!(await persistAgentAuthorityNow())) throw new Error('the cancellation could not be saved');
      const { cancelWorkerCommands } = await import('./bridge.js');
      cancelWorkerCommands(outcome.reason, info.id, info.runId);
    },
    now: () => Date.now(),
    wait: ms => new Promise(resolve => setTimeout(resolve, ms))
  };
}

