import { createHash } from 'node:crypto';
import { getConfig } from '../config.js';
import { currentCall } from '../mcp/call-context.js';
import { getSession } from './store.js';
import { onSessionChange, recordProgress } from './recorder.js';
import { isChatBlocked } from './blocked-chats.js';
import { draftFastFollowup, conversationMessages, automaticFinishEnabled } from '../goal.js';
import { hasEligibleToolInput, onInputChange, listInputs, enqueueInput } from './input.js';

import { logWarn } from '../logger.js';
import { retryTaskRequest } from '../task-request.js';

let notify: ((title: string, body: string, sessionId: string, turnId: string) => boolean | void) | null = null;
export function setFinishNotifier(listener: typeof notify): void { notify = listener; }
// Only coalesces work already running. The existing progress row owns durable deduplication.
type FinishDraft = Pick<import('../goal.js').GoalDraftView, 'stage' | 'model' | 'text' | 'error'>;
const running = new Map<string, { promise: Promise<string>; draft: FinishDraft }>();
export function getSessionFinishDraft(sessionId: string, turnId: string | null | undefined): FinishDraft | null {
  const draft = turnId ? running.get(`${sessionId}:${turnId}`)?.draft : undefined;
  return draft ? { ...draft } : null;
}
const finishCalls = new Map<string, number>();
export async function sessionFinishWaiting(sessionId: string, turnId: string | null | undefined, conversationId: string | null): Promise<boolean> {
  return !!turnId && finishCalls.has(`${sessionId}:${turnId}`) &&
    await sessionFinishHeld(sessionId, turnId, conversationId) &&
    !(await listInputs()).some(entry => entry.sessionId === sessionId && ['queued', 'browser', 'tool'].includes(entry.state));
}
const REMAINING = 'Process any user input attached to this result.';

/** A model-issued heads-up, not an inferred completion deadline or a terminal event. */
async function prepareNotice(sessionId: string, summary: string, userRequested = false, requestedTurnId?: string): Promise<string> {
  const configuration = getConfig();
  const settings = configuration.ui;
  if (!settings.finishTool) return 'Finish hold is disabled.';
  const call = currentCall();
  const session = await getSession(sessionId);
  const turnId = session?.activeTurnId;
  if (requestedTurnId && turnId !== requestedTurnId) throw new Error('The active turn changed; this finish action has expired');
  const automatic = automaticFinishEnabled(session?.conversationId ?? '');
  const requestedAt = userRequested ? Date.now() : call?.startedAt ?? 0;
  if (!session || !turnId || !session.conversationId || (!userRequested && (!call || call.caller.sessionId !== sessionId ||
      !call.caller.conversationId || call.caller.conversationId !== session.conversationId)) || isChatBlocked(session.conversationId)) {
    throw new Error('Session finish requires this caller’s exact active session and turn');
  }
  const key = `${sessionId}:${turnId}`;
  const mode = 'loop' as const;
  const existing = running.get(key);
  if (existing) {
    const finish = (await getSession(sessionId))?.finishTurn;
    if (finish?.turnId !== turnId || finish.startedAt > requestedAt) throw new Error('This request predates the active turn');
    return existing.promise;
  }
  const draft: FinishDraft = { stage: 'sending', model: (configuration.goal.loopBackend ?? 'chatgpt') === 'chatgpt' ? configuration.goal.helperModel ?? configuration.goal.model : configuration.goal.model, text: '', error: null };
  const work = (async () => {
    const current = await getSession(sessionId);
    const authority = current?.finishTurn;
    if (authority?.turnId !== turnId || authority.startedAt > requestedAt || current?.activeTurnId !== turnId || current.conversationId !== session.conversationId) {
      throw new Error('The active turn changed or its start could not be verified');
    }
    if (!(await sessionFinishHeld(sessionId, turnId, session.conversationId))) return 'The finish hold is no longer active for this turn.';
    const noticeId = `finish:${turnId}`;
    const notified = authority.notified;
    const description = summary.trim().slice(0, 1000);
    const stillCurrent = async () => {
      const latest = await getSession(sessionId);
      return getConfig() === configuration && latest?.activeTurnId === turnId && latest.conversationId === session.conversationId &&
        getConfig().ui.finishTool && automaticFinishEnabled(session.conversationId!) === automatic && !isChatBlocked(session.conversationId!) &&
        await sessionFinishHeld(sessionId, turnId, session.conversationId);
    };
    const inputs = await listInputs();
    if (inputs.some(entry => entry.sessionId === sessionId && ['queued', 'browser', 'tool'].includes(entry.state)))
      return 'Queued user instructions take priority over finish notices and automatic Goal work.';
    let notification = automatic || userRequested ? 'Automatic Goal check.' : 'This turn’s finish notice was already requested; no notification was repeated.';
    if (!userRequested && !automatic && !notified) {
      const anchor = await recordProgress(sessionId, noticeId, `Preparing finish notice: ${description}`, undefined, turnId, { state: 'notified', conversationId: session.conversationId! });
      if (!anchor) throw new Error('Finish notice could not be recorded; nothing was notified or drafted');
      if (!(await stillCurrent())) return 'The turn changed before its finish notice was delivered.';
      notification = 'Desktop notification is unavailable.';
      if (notify) {
        try { notification = notify('Astra is wrapping up', 'Send an automatic Goal or write your next instruction.', sessionId, turnId) === false ? 'The app is open; no desktop notification was shown.' : 'The user has been notified.'; }
        catch { notification = 'The desktop notification could not be shown.'; }
      }
      await recordProgress(sessionId, noticeId, `Astra is wrapping up: ${description}\n${notification}`, anchor, turnId);
    }
    let result = `${notification} ${REMAINING}`;
    if (!userRequested && !automatic) return result;
    const generated = new Set(inputs.filter(entry => entry.finishOwner).map(entry => entry.id));
    // A request id, timestamp, hold result or app status is not new work. Hash actual
    // authored context and tool output; identical streaming revisions are the same episode.
    const appInput = inputs.filter(entry => entry.sessionId === sessionId && entry.purpose !== 'decision' && !entry.finishOwner &&
      ['tool', 'sent'].includes(entry.state)).slice(-5).map(entry => ({ id: entry.id, text: entry.text }));
    const inputRevision = createHash('sha256').update(JSON.stringify({ mode, appInput })).digest('hex');
    if (authority.decisionRevision && authority.workSeq <= authority.decisionSeq && authority.decisionInputRevision === inputRevision) {
      return `${result} No new work has been recorded since the previous Goal decision; no follow-up was repeated.`;
    }
    const context = await conversationMessages(sessionId, appInput.map(entry => entry.text), generated);
    if (!(await stillCurrent())) return 'The turn or settings changed; the Goal check was discarded.';
    const revision = createHash('sha256').update(JSON.stringify({ mode, context })).digest('hex');
    const progressId = `finish-goal:${turnId}:${revision}`;
    if (authority.decisionRevision === revision) {
      // A repeated streaming snapshot advanced the source cursor without changing content.
      // Checkpoint that known coverage so later bounded-tail aging cannot look like new work.
      if (authority.workSeq > authority.decisionSeq) {
        const covered = await recordProgress(sessionId, progressId, 'The recorded context is unchanged; no new Goal request was needed.', undefined, turnId,
          { state: 'decision', conversationId: session.conversationId!, revision, inputRevision, workSeq: session.finishTurn?.workSeq ?? 0 });
        if (!covered) throw new Error('Unchanged Goal context could not be checkpointed');
      }
      return `${result} No new progress has been recorded since the previous Goal decision; no follow-up was repeated.`;
    }
    const anchor = await recordProgress(sessionId, progressId, 'Checking the newly recorded progress for remaining work.', undefined, turnId, { state: 'decision', conversationId: session.conversationId!, revision, inputRevision, workSeq: session.finishTurn?.workSeq ?? 0 });
    if (!anchor) throw new Error('Goal decision could not be recorded; no provider request was made');
    // This existing operation owns every attempt. User input and turn release revoke it;
    // transport waits may finish meanwhile, but only the existing input queue delivers.
    const controller = new AbortController();
    const knownInputs = new Set(inputs.map(entry => entry.id));
    const currentDecision = async () => await stillCurrent() && !(await listInputs()).some(entry =>
      entry.sessionId === sessionId && !entry.finishOwner && !knownInputs.has(entry.id) &&
      ['queued', 'browser', 'tool', 'sent'].includes(entry.state));
    const checkDecision = () => { void currentDecision().then(current => {
      if (!current) controller.abort(new Error('The turn, settings or user instructions changed; the Goal check was discarded.'));
    }).catch(error => controller.abort(error)); };
    const stopInput = onInputChange(checkDecision);
    const stopSession = onSessionChange(checkDecision);
    try {
      let publishedAt = 0;
      const reply = await retryTaskRequest(async signal => {
        if (!(await currentDecision())) controller.abort(new Error('The turn, settings or user instructions changed; the Goal check was discarded.'));
        signal.throwIfAborted();
        draft.stage = 'sending'; draft.text = '';
        return draftFastFollowup(sessionId, AbortSignal.any([signal, AbortSignal.timeout(180000)]), context, text => {
          if (signal.aborted || Date.now() - publishedAt < 250) return;
          publishedAt = Date.now();
          draft.stage = 'answering'; draft.text = text.slice(-8000);
          void recordProgress(sessionId, progressId, `Generating Goal: ${text.slice(-8000)}`, anchor, turnId);
        }, mode);
      }, controller.signal, progress => {
        draft.stage = 'sending';
        draft.text = `Goal temporarily unavailable (${progress.error}); retrying in ${Math.ceil(((progress.retryAt ?? Date.now()) - Date.now()) / 1000)} seconds.`;
        void recordProgress(sessionId, progressId, draft.text, anchor, turnId);
      });
      if (!(await currentDecision())) result = 'The turn changed or new user instructions took priority; the old Goal follow-up was discarded.';
      else if (reply) {
        if ((await listInputs()).some(entry => entry.sessionId === sessionId && ['queued', 'browser', 'tool'].includes(entry.state))) {
          result = `${notification} New user instructions took priority; the automatic follow-up was discarded.`;
        } else {
          const hash = createHash('sha256').update(`${sessionId}:${progressId}`).digest('hex');
          const id = `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
          await enqueueInput({ id, sessionId, text: reply, mode: 'auto', dueAt: Date.now(), model: null, reasoningEffort: null },
            { turnId, periodic: false, ...(userRequested ? { userRequested: true } : {}) });
          result = `${notification} An automatic Goal instruction is queued once. ${REMAINING}`;
        }
      }
    } catch (error) {
      result = `${notification} Goal follow-up was not available: ${(error as Error).message}. ${REMAINING}`;
    } finally { stopInput(); stopSession(); }
    await recordProgress(sessionId, progressId, result, anchor, turnId);
    return result;
  })();
  const operation = { promise: work, draft } as const;
  running.set(key, operation);
  try { return await work; }
  finally { if (running.get(key) === operation) running.delete(key); }
}

/** Release is an app-authored fact in the existing transcript, scoped to exact turn + frontend. */
export async function sessionFinishHeld(sessionId: string, turnId: string | null | undefined, conversationId: string | null): Promise<boolean> {
  if (!getConfig().ui.finishTool || !turnId || !conversationId || isChatBlocked(conversationId)) return false;
  return !(await finishReleased(sessionId, turnId, conversationId));
}
async function finishReleased(sessionId: string, turnId: string, conversationId: string): Promise<boolean> {
  const session = await getSession(sessionId);
  const finish = session?.finishTurn;
  if (session?.activeTurnId !== turnId || session.conversationId !== conversationId) return true;
  if (finish?.turnId !== turnId) throw new Error('This turn’s finish authority could not be recovered');
  return finish.conversationId === conversationId && finish.released;
}
export async function releaseSessionFinish(sessionId: string, expectedTurnId: string, reason: 'end' | 'stop' = 'end'): Promise<void> {
  const session = await getSession(sessionId);
  if (!session?.conversationId || session.activeTurnId !== expectedTurnId) throw new Error('The active turn changed; refresh before ending it');
  if (await finishReleased(sessionId, expectedTurnId, session.conversationId)) return;
  const latest = await getSession(sessionId);
  if (latest?.activeTurnId !== expectedTurnId || latest.conversationId !== session.conversationId) throw new Error('The active turn changed; refresh before ending it');
  const message = reason === 'stop'
    ? 'Stop requested. The finish hold was released; ChatGPT has not yet confirmed that generation stopped.'
    : 'Finish hold released. ChatGPT may finish its answer; generation has not been stopped.';
  const receipt = await recordProgress(sessionId, `finish-release:${expectedTurnId}`, message,
    undefined, expectedTurnId, { state: 'released', conversationId: session.conversationId });
  if (!receipt) throw new Error('End turn could not be saved; this turn remains held');
}

/** One bounded transport wait. Event subscriptions observe; only the kernel consumes input. */
async function waitForFinishBoundary(sessionId: string, turnId: string, conversationId: string, remainingMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let closed = false;
    let checking = false;
    let dirty = false;
    const done = (held: boolean, error?: unknown) => {
      if (closed) return;
      closed = true; clearTimeout(timer); stopInput(); stopSession();
      if (error) reject(error); else resolve(held);
    };
    const check = async () => {
      if (closed) return;
      if (checking) { dirty = true; return; }
      checking = true;
      try {
        do {
          dirty = false;
          const session = await getSession(sessionId);
          if (session?.activeTurnId !== turnId || session.conversationId !== conversationId ||
              !(await sessionFinishHeld(sessionId, turnId, conversationId))) return done(false);
          if (await hasEligibleToolInput(sessionId, true)) return done(true);
        } while (dirty && !closed);
      } catch (error) { done(false, error); }
      finally { checking = false; }
    };
    const stopInput = onInputChange(() => { void check(); });
    const stopSession = onSessionChange(() => { void check(); });
    const timer = setTimeout(() => {
      void (async () => {
        const session = await getSession(sessionId);
        done(session?.activeTurnId === turnId && session.conversationId === conversationId &&
          await sessionFinishHeld(sessionId, turnId, conversationId));
      })().catch(error => done(false, error));
    }, Math.max(0, remainingMs));
    void check();
  });
}

/** HELD is a model instruction, not a server-side lock on ChatGPT finalization. */
export async function announceSessionFinish(sessionId: string, summary: string): Promise<string> {
  const deadline = Date.now() + 25000;
  const session = await getSession(sessionId);
  const call = currentCall();
  if (!session?.activeTurnId || !session.conversationId || call?.caller.sessionId !== sessionId ||
      call.caller.conversationId !== session.conversationId) throw new Error('Session finish requires this caller’s exact active session and turn');
  if (session.finishTurn?.turnId !== session.activeTurnId || session.finishTurn.startedAt > call.startedAt)
    throw new Error('The active turn changed or its start could not be verified');
  const key = `${sessionId}:${session.activeTurnId}`;
  finishCalls.set(key, (finishCalls.get(key) ?? 0) + 1);
  try {
    const queued = (await listInputs()).some(entry => entry.sessionId === sessionId && ['queued', 'browser', 'tool'].includes(entry.state));
    const automatic = automaticFinishEnabled(session.conversationId);
    let notice = 'Queued user instructions are ready.';
    if (!queued && automatic) {
      void prepareNotice(sessionId, summary).catch(error => logWarn(`Finish Goal check failed: ${(error as Error).message}`));
      notice = 'Automatic Goal generation is running. Its instruction will arrive on a later tool call.';
    } else if (!queued) notice = await prepareNotice(sessionId, summary);
    const held = await waitForFinishBoundary(sessionId, session.activeTurnId, session.conversationId, deadline - Date.now());
    return held
      ? `HELD: Keep this turn open. Complete and verify the remaining requested work, including attached instructions, before calling session_finish again. New messages and progress updates are not finish checkpoints. If no requested work remains, wait here with session_finish; do not invent work. The user can stop generation with the composer Stop button.\n${notice}`
      : `RELEASED: This hold has ended or its turn changed. Do not repeat the hold; follow the latest user instruction. This is not confirmation that provider generation stopped.\n${notice}`;
  } finally {
    const remaining = (finishCalls.get(key) ?? 1) - 1;
    if (remaining) finishCalls.set(key, remaining); else finishCalls.delete(key);
  }
}

/** Notification actions remain fenced to the turn that displayed them. */
export async function requestSessionFinishGoal(sessionId: string, expectedTurnId: string): Promise<string> {
  const session = await getSession(sessionId);
  if (session?.activeTurnId !== expectedTurnId || !session.conversationId ||
      !(await sessionFinishWaiting(sessionId, expectedTurnId, session.conversationId))) throw new Error('This finish action has expired or user input is already queued');
  // A notification can be clicked while its publication operation is still running.
  // Let that receipt finish before asking the same owner for the requested decision.
  await running.get(`${sessionId}:${expectedTurnId}`)?.promise;
  return prepareNotice(sessionId, '', true, expectedTurnId);
}

/** Await already-started decisions when validating the asynchronous transport boundary. */
export async function settleSessionFinishForTests(): Promise<void> { await Promise.all([...running.values()].map(operation => operation.promise)); }
