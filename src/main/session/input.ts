import { REASONING_EFFORTS } from '../../shared/session.js';
/** User-authored input has one durable owner across browser and MCP delivery.
 * A claimed browser send is never automatically retried: losing the ACK is ambiguous.
 * Tool delivery repeats under a stable message id until a later request proves receipt.
 */
import { z } from 'zod';
import { browserInputModel, type InputImage } from '../../shared/input.js';
import type { SessionSummary } from '../../shared/session.js';
import { getConfig } from '../config.js';
import { randomUUID } from 'node:crypto';
import { readDurable, writeDurableNow, writeDurableSoon } from '../durable.js';
import { getSession, findSessionByConversation, createSession, conversationWasSuperseded, readRecentEvents, listUsageSessions } from './store.js';
import { assignSessionProject, projectWorkspace, getSessionProject } from '../projects.js';
import { isChatBlocked } from './blocked-chats.js';
import { wakeBrowserWork } from '../browser-wake.js';
import { logInfo } from '../logger.js';
import { noteChatOrigin } from './recorder.js';
import { isAstraModel } from '../../shared/chat-models.js';
import { automaticFinishEnabled } from '../goal.js';
import { finishInstruction, finishInputInstruction } from '../../shared/finish.js';
import { attachmentSchema, validateInputAttachments } from './input-attachments.js';

export const inputArgs = z.object({
  projectId: z.string().uuid().nullable().optional(),
  automation: z.enum(['off', 'goal', 'loop']).optional(),
  objective: z.string().trim().max(16000).optional(),
  stages: z.array(z.string().trim().min(1).max(16000)).max(11).optional(),
  images: z.array(z.object({ name: z.string().min(1).max(110), dataUrl: z.string().max(512100).regex(/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/) })).max(4).optional(),
  attachments: z.array(attachmentSchema).max(20).optional(),
  id: z.string().uuid(),
  sessionId: z.string().min(8).max(64).nullable(),
  text: z.string().trim().min(1).max(16000),
  mode: z.enum(['auto', 'after-turn', 'finish']),
  afterTurn: z.boolean().optional(),
  dueAt: z.number().int().nonnegative(),
  model: z.string().max(80).nullable(),
  reasoningEffort: z.enum(REASONING_EFFORTS).nullable()
});
export type InputArgs = z.infer<typeof inputArgs>;
const entrySchema = inputArgs.extend({
  finishOwner: z.object({ turnId: z.string().min(1).max(256), periodic: z.boolean(), userRequested: z.boolean().optional() }).optional(),
  requestedMode: z.enum(['auto', 'after-turn', 'finish']).optional(),
  transportIntent: z.enum(['tool', 'browser']).optional(),
  text: z.string().min(1).max(240000),
  deliveryText: z.string().min(1).max(240000).optional(),
  purpose: z.enum(['user', 'decision']).optional(),
  lifetime: z.literal('temporary-planner').optional(),
  decisionSourceSessionId: z.string().min(8).max(64).optional(),
  response: z.string().max(16000).optional(),
  state: z.enum(['queued', 'browser', 'tool', 'sent', 'cancelled', 'failed', 'decision']),
  offeredAt: z.number().optional(),
  sendAuthorizedAt: z.number().optional(),
  requiresAuthorization: z.boolean().optional(),
  error: z.string().max(200).optional(),
  owner: z.string().nullable(),
  createdAt: z.number(),
  conversationId: z.string().nullable(),
  deliveredSessionId: z.string().min(8).max(64).nullable().optional(),
  messageId: z.string().min(1).max(256).optional(),
  deliveredAt: z.number().optional(),
  stagesApplied: z.boolean().optional(),
  historyRecorded: z.boolean().optional(),
  completedTurnId: z.string().max(256).optional(),
  queueOrder: z.number().int().nonnegative().optional()
});
export type InputEntry = z.infer<typeof entrySchema>;
const STATE = 'session-input';
const TOOL_INPUT_TEXT_BYTES = 128000;
type InputDeliveryHooks = {
  hasActivity?: (session: SessionSummary) => boolean;
  wakeDecision?: (entry: Readonly<InputEntry>, signal: AbortSignal) => Promise<void>;
  bindHelper?: (conversationId: string, sourceSessionId: string | null) => Promise<void>;
  recordDelivered?: (entry: Readonly<InputEntry>) => Promise<boolean>;
  prepareText?: (entry: Readonly<InputEntry>) => string;
  applyAutomation: (conversationId: string, automation: NonNullable<InputArgs['automation']>, phase: 'before-send' | 'after-send', objective?: string) => Promise<void>;
  changed: () => void;
};
let deliveryHooks: InputDeliveryHooks | null = null;
/** Installed once by IPC before bridge/MCP startup; avoids a Goal/input import cycle. */
export function configureInputDelivery(hooks: InputDeliveryHooks): void { deliveryHooks = hooks; }
/** One delivery policy for composer presentation, admission and the final send fence. */
export async function sessionInputPolicy(sessionId: string, observedActivity?: boolean): Promise<{ queueAtFinish: boolean; canInject: boolean; browserAllowed: boolean }> {
  const session = await getSession(sessionId);
  if (!session?.conversationId || isChatBlocked(session.conversationId)) return { queueAtFinish: false, canInject: false, browserAllowed: false };
  const activity = observedActivity ?? deliveryHooks?.hasActivity?.(session) ?? false;
  const stopped = session.finishTurn?.released === true;
  const canInject = !stopped && (!!session.activeTurnId || activity);
  const astra = session.origin?.kind !== 'worker' && session.origin?.kind !== 'helper' &&
    session.selectedModel?.conversationId === session.conversationId && isAstraModel(session.selectedModel.model, session.selectedModel.reasoningEffort);
  const [end] = astra ? await readRecentEvents(sessionId, 1, { kinds: ['turn_start', 'turn_end'] }) : [];
  const terminal = end?.kind === 'turn_end' && !!end.turnId && end.outcome !== 'unknown';
  return { canInject, queueAtFinish: astra && canInject && getConfig().ui.finishTool === true,
    browserAllowed: !session.activeTurnId && (!astra || (!activity && terminal)) };
}
async function browserInputAllowed(entry: InputEntry): Promise<boolean> {
  if (entry.transportIntent === 'tool') return false;
  if (entry.mode === 'finish' && entry.sessionId && entry.afterTurn !== true) {
    const session = await getSession(entry.sessionId);
    const selection = session?.selectedModel;
    if (selection?.conversationId === session?.conversationId && isAstraModel(selection?.model, selection?.reasoningEffort)) return false;
  }
  return !entry.sessionId || (await sessionInputPolicy(entry.sessionId)).browserAllowed;
}
const inputListeners = new Set<() => void>();
export function onInputChange(listener: () => void): () => void {
  inputListeners.add(listener);
  return () => { inputListeners.delete(listener); };
}
/** Observation only: the kernel remains the sole tool-input consumer. */
export function hasEligibleToolInput(sessionId: string, finishBoundary = false): Promise<boolean> {
  return serial(async () => {
    const current = ordered(await load());
    if (current.some(row => row.sessionId === sessionId && row.state === 'browser')) return false;
    for (const row of current) {
      if (row.sessionId !== sessionId || row.dueAt > Date.now()) continue;
      if (row.attachments?.length) continue;
      if (row.mode === 'after-turn' || (row.mode === 'finish' && !finishBoundary)) continue;
      if (row.state === 'tool') return true;
      if (row.state === 'queued') return row.mode === 'auto' || (finishBoundary && row.mode === 'finish');
    }
    return false;
  });
}
let entries: InputEntry[] | null = null;
let chain: Promise<unknown> = Promise.resolve();
// A timestamp written before the claim commit cannot prove that its response was
// available. Restart discards this evidence and repeats the stable message id.
const offered = new Map<string, number>();
const terminal = (row: InputEntry): boolean => ['sent', 'cancelled', 'failed'].includes(row.state);
const preparable = (row: InputEntry): boolean => row.state === 'queued' ||
  (row.state === 'browser' && row.requiresAuthorization === true && row.sendAuthorizedAt === undefined);
const needsHistory = (row: InputEntry): boolean => !row.historyRecorded &&
  ((row.state === 'tool' && Number.isFinite(row.offeredAt)) || ((row.state === 'sent' || row.state === 'cancelled') && !!row.messageId));
const pendingStages = (row: InputEntry): boolean => row.state === 'sent' && !!row.stages?.length && !row.stagesApplied;
const ordered = (rows: InputEntry[]): InputEntry[] => [...rows].sort((a, b) =>
  (a.queueOrder ?? a.dueAt) - (b.queueOrder ?? b.dueAt) || a.createdAt - b.createdAt);

function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = chain.then(work, work);
  chain = result.catch(() => undefined);
  return result;
}
async function load(): Promise<InputEntry[]> {
  if (entries) return expireQueued(entries);
  const raw = await readDurable<unknown>(STATE);
  const parsed = z.array(entrySchema).safeParse(raw ?? []);
  if (!parsed.success) throw new Error('The message outbox could not be read safely');
  entries = parsed.data;
  // Old receipts are recovery evidence, not a reason to replay every already-stamped
  // transcript before the sidebar appears. The existing catalog proves an origin is
  // durable; only missing/ambiguous rows need the normal origin repair path below.
  const stamped = new Set<string>();
  const seen = new Set<string>();
  if (entries.some(row => row.conversationId && (row.purpose === 'decision' || (!row.sessionId && row.deliveredAt !== undefined)))) {
    for (const summary of await listUsageSessions()) {
      if (!summary.conversationId) continue;
      if (seen.has(summary.conversationId)) stamped.delete(summary.conversationId);
      else if (summary.origin) stamped.add(summary.conversationId);
      seen.add(summary.conversationId);
    }
  }
  // Durable decision receipts recover helper provenance even when recording/ACK raced
  // or this version first opens a helper recorded before origins were stamped.
  for (const row of entries) {
    // Re-project wrapped receipts once when loading the outbox, so recordings made
    // before authoredText existed recover their original visible text too. This
    // is canonical history only; it never reopens transport or resends an input.
    if (row.historyRecorded && row.deliveryText && row.deliveryText !== row.text) row.historyRecorded = false;
    if (!row.sessionId && row.purpose !== 'decision' && row.conversationId && row.deliveredAt !== undefined && !stamped.has(row.conversationId)) {
      await noteChatOrigin(row.conversationId, { kind: 'desktop', fromSessionId: null, agentId: null, task: '' });
    }
    if (row.purpose === 'decision' && row.lifetime !== 'temporary-planner' && row.conversationId && !stamped.has(row.conversationId)) await deliveryHooks?.bindHelper?.(row.conversationId, row.decisionSourceSessionId ?? null);
  }
  const recovered = entries.map((row): InputEntry => row.purpose === 'decision' && !terminal(row) && !decisionWaiters.has(row.id)
    ? { ...row, state: 'cancelled' } : row);
  if (recovered.some((row, i) => row !== entries![i])) {
    try { await commit(recovered); }
    catch (error) { entries = null; throw error; }
  }
  return expireQueued(entries);
}
async function expireQueued(current: InputEntry[]): Promise<InputEntry[]> {
  const next = await Promise.all(current.map(async (row): Promise<InputEntry> => {
    if (row.finishOwner && !terminal(row) && !(await finishInputCurrent(row)))
      return { ...row, state: 'cancelled', error: 'Automatic follow-up cancelled because its active turn or setting changed.' };
    if (row.purpose === 'decision') return row;
    // Only an ordinary browser attempt has an unclaimed startup deadline. Tool
    // intent survives a later terminal observation/restart; legacy bound-chat
    // rows are ambiguous and cannot safely be reclassified from today's activity.
    if (row.state === 'queued' && row.mode === 'auto' && !row.finishOwner &&
        (row.transportIntent === 'browser' || (!row.transportIntent && !row.sessionId)) &&
        Date.now() - Math.max(row.createdAt, row.dueAt) >= 60_000)
      return { ...row, state: 'failed', error: 'Not sent: the browser did not pick up this message within 60 seconds.' };
    // Native preparation bounds include the 60s upload and 15s picker hydration.
    // Once Send is authorized, its 30s receipt + 15s fresh-route wait are the entire tail.
    if (row.state === 'browser' && Date.now() - (row.sendAuthorizedAt ?? row.offeredAt ?? row.createdAt) >= (row.sendAuthorizedAt === undefined ? (row.attachments?.length ? 720_000 : row.images?.length ? 120_000 : 60_000) : 45_000))
      return { ...row, state: 'cancelled', error: row.requiresAuthorization && row.sendAuthorizedAt === undefined
        ? 'Not sent: browser preparation timed out. This attempt was cancelled.'
        : 'Stopped waiting for delivery confirmation. The message may already have been sent; it will not be resent.' };
    return row;
  }));
  if (next.some((row, index) => row !== current[index])) await commit(next);
  return entries!;
}
async function commit(next: InputEntry[]): Promise<void> {
  // A temporary planner keeps only ownership metadata across restart, never its task or answer.
  const durableRows = (rows: InputEntry[]) => rows.map(row => row.lifetime === 'temporary-planner'
    ? { ...row, text: '[Temporary planner]', deliveryText: undefined, response: undefined } : row);
  try { await writeDurableNow(STATE, durableRows(next)); }
  catch (error) {
    // durable.ts retries failed generations. Never let a rejected send claim or
    // enqueue become live later behind the caller's back.
    writeDurableSoon(STATE, durableRows(entries ?? []));
    throw error;
  }
  entries = next;
  wakeBrowserWork();
  for (const listener of inputListeners) { try { listener(); } catch { /* observer only */ } }
  try { deliveryHooks?.changed(); } catch { /* a detached renderer does not undo a durable commit */ }
}
/** Reserve the attempt durably before crossing into Goal's control ledger. The failed
 * row is the crash tombstone: an ambiguous settings write is never replayed after a
 * later user Off. Only this live operation may replace it with the successful delivery.
 */
async function transition(current: InputEntry[], next: InputEntry[], automated: InputEntry[], phase: 'before-send' | 'after-send'): Promise<void> {
  if (automated.length) {
    if (!deliveryHooks) throw new Error('Input delivery is not ready');
    const reserved = new Map(automated.map((entry) => [entry.id, entry]));
    await commit(current.map((entry): InputEntry => {
      const claimed = reserved.get(entry.id);
      return claimed ? { ...claimed, state: 'failed', error: phase === 'after-send'
        ? 'Message sent, but automation was not confirmed. Check its chat settings.'
        : 'Automation was not confirmed; this message was not sent. Send again to retry.' } : entry;
    }));
    for (const entry of automated) await deliveryHooks.applyAutomation(entry.conversationId!, entry.automation!, phase, entry.objective);
  }
  await commit(next);
}
/** Freeze the exact transport bytes with its durable claim, never the authored enqueue payload. */
function prepare(entry: InputEntry): InputEntry {
  if (entry.purpose === 'decision') return entry;
  // A plan schedules later verification, never withholds the job from its executor.
  // Keep the authored stage intact in history; freeze the complete context in the
  // same delivery claim so retries cannot reconstruct a different opening message.
  const text = entry.stages !== undefined
    ? `Original user request:\n${entry.objective || entry.text}\n\nComplete workflow:\n${[entry.text, ...entry.stages].map((stage, index) => `${index + 1}. ${stage}`).join('\n\n')}\n\nBegin the complete implementation now. Later queued messages are verification checkpoints; do not wait for them to learn or implement requirements. Carry out and verify each received checkpoint before asking for the next one with session_finish; never call it repeatedly just to collect the queue.`
    : entry.text;
  const deliveryText = entry.deliveryText ?? deliveryHooks?.prepareText?.({ ...entry, text }) ?? text;
  // A single input must fit the tool envelope by itself. Aggregate batching below
  // may defer a second input, but cannot silently defer an individually impossible one.
  const envelope = `[User message ${entry.id}]\n${deliveryText}\n\n${finishInputInstruction(getConfig().ui.finishLeadMinutes)}`;
  if (!deliveryText || deliveryText.length > 240000 || Buffer.byteLength(envelope) > TOOL_INPUT_TEXT_BYTES)
    throw new Error('Prepared message exceeds the delivery limit; shorten the request or plan');
  return { ...entry, deliveryText };
}
/** Explicit follow-ups spend one verified completed turn; each transport elects its eligible FIFO. */
const queuedFollowup = (row: InputEntry): boolean => row.mode === 'finish' || (row.mode === 'after-turn' && !!row.sessionId && row.purpose !== 'decision');
function append(current: InputEntry[], entry: InputEntry, stackDirect = false): InputEntry[] {
  if (queuedFollowup(entry)) {
    const positioned = current.filter(row => row.sessionId === entry.sessionId && queuedFollowup(row) && !terminal(row) && row.queueOrder !== undefined);
    if (positioned.length) entry = { ...entry, queueOrder: Math.max(...positioned.map(row => row.queueOrder!)) + 1 };
  }
  // Only ordinary browser sends occupy the global composer slot. Durable tool
  // intent can queue independently; actual handout still fences browser claims.
  if (!stackDirect && entry.purpose !== 'decision' && !queuedFollowup(entry) && current.some(row => (row.transportIntent !== 'tool' || row.sessionId === entry.sessionId) && (row.sessionId === entry.sessionId || (!row.finishOwner && !entry.finishOwner)) && row.purpose !== 'decision' &&
      !(!entry.finishOwner && row.finishOwner && row.state === 'tool') &&
      (!queuedFollowup(row) || row.state === 'browser') && ['queued', 'browser', 'tool'].includes(row.state))) {
    throw new Error('One message is already awaiting delivery. Cancel it before sending another.');
  }
  const active = current.filter((row) => !terminal(row) || needsHistory(row) || pendingStages(row));
  const reserved = (row: InputEntry) => row.stagesApplied ? [] : row.stages ?? [];
  if ([...active, entry].reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify({ ...row, images: undefined, stages: reserved(row) })), 0) > 1024000) {
    throw new Error('The message queue is full');
  }
  const imageBytes = (row: InputEntry): number => (row.images ?? []).reduce((sum, image) => sum + image.dataUrl.length, 0) +
    (row.attachments ?? []).reduce((sum, file) => sum + (file.preview?.length ?? 0), 0);
  if ([...active, entry].reduce((sum, row) => sum + imageBytes(row), 0) > 4 * 1024 * 1024) throw new Error('The image queue is full');
  const history = current.filter((row) => terminal(row) && !needsHistory(row) && !pendingStages(row)).slice(-50);
  const bytes = (row: InputEntry): number => Buffer.byteLength(row.text) + Buffer.byteLength(row.deliveryText ?? '') + Buffer.byteLength(row.response ?? '') + Buffer.byteLength(JSON.stringify(row.stages ?? [])) + imageBytes(row);
  let retainedBytes = [...history, ...active, entry].reduce((sum, row) => sum + bytes(row), 0);
  while (history.length && retainedBytes > 2048000) retainedBytes -= bytes(history.shift()!);
  return [...history, ...active, entry];
}
async function target(entry: InputEntry): Promise<string | null> {
  if (entry.purpose === 'decision') {
    if (entry.conversationId && isChatBlocked(entry.conversationId)) throw new Error('Unblock this helper conversation before sending');
    return entry.conversationId;
  }
  if (!entry.sessionId) return null;
  const session = await getSession(entry.sessionId);
  if (!session?.conversationId) throw new Error('This recording has no ChatGPT conversation');
  if (isChatBlocked(session.conversationId)) throw new Error('Unblock this conversation before sending');
  return session.conversationId;
}
async function finishInputCurrent(entry: InputEntry): Promise<boolean> {
  // Periodic generation was retired; persisted rows cannot regain delivery authority.
  if (!entry.finishOwner || entry.finishOwner.periodic || !entry.sessionId) return false;
  const session = await getSession(entry.sessionId), config = getConfig();
  return !!session?.conversationId && session.conversationId === entry.conversationId &&
    session.activeTurnId === entry.finishOwner.turnId && session.finishTurn?.turnId === entry.finishOwner.turnId &&
    !session.finishTurn.released && config.ui.finishTool === true && !isChatBlocked(session.conversationId) &&
    session.origin?.kind !== 'worker' && session.origin?.kind !== 'helper' &&
    (entry.finishOwner.userRequested === true || automaticFinishEnabled(session.conversationId));
}
export function enqueueInput(raw: InputArgs, finishOwner?: InputEntry['finishOwner']): Promise<InputEntry> {
  return serial(async () => {
    const input = inputArgs.parse(raw);
    if (input.stages !== undefined && JSON.stringify([input.text, ...input.stages]).length > 12000)
      throw new Error('Keep the complete plan below 12,000 characters');
    const current = await load();
    const prior = current.find((entry) => entry.id === input.id);
    if (prior) {
      if (JSON.stringify(inputArgs.parse({ ...prior, mode: prior.requestedMode ?? prior.mode })) !== JSON.stringify(input)) throw new Error('Message id already belongs to different input');
      return { ...prior };
    }
    const policy = input.sessionId ? await sessionInputPolicy(input.sessionId) : null;
    const requestedMode = input.mode;
    if (input.attachments?.length) {
      await validateInputAttachments(input.attachments);
      // Native files belong to the next browser message, never a tool-result injection.
      if (finishOwner) throw new Error('Automatic finish messages cannot attach files');
      if (input.mode === 'finish' || (input.mode === 'auto' && policy?.canInject)) input.mode = 'after-turn';
    } else if (input.mode === 'after-turn' && policy?.queueAtFinish) input.mode = 'finish';
    if (input.mode === 'finish' || input.stages?.length) {
      const session = input.sessionId ? await getSession(input.sessionId) : null;
      if ((input.mode === 'finish' && !session?.conversationId) || session?.origin?.kind === 'worker') throw new Error('Queue staged tasks in a normal chat');
    }
    const transportIntent = input.attachments?.length ? 'browser' as const : input.mode === 'auto' && !finishOwner ? policy?.canInject ? 'tool' as const : 'browser' as const : undefined;
    const entry: InputEntry = { ...input, ...(transportIntent ? { transportIntent } : {}), ...(requestedMode !== input.mode ? { requestedMode } : {}), ...(finishOwner ? { finishOwner } : {}), state: 'queued', owner: null, createdAt: Date.now(), conversationId: null };
    if (input.projectId) {
      await projectWorkspace(input.projectId);
      if (input.sessionId) {
        const session = await getSession(input.sessionId);
        if (session?.projectId !== input.projectId) throw new Error('Message project does not match the session');
        await getSessionProject(input.sessionId);
      }
    }
    entry.conversationId = await target(entry);
    if (finishOwner && !(await finishInputCurrent(entry))) throw new Error('The automatic follow-up no longer belongs to an active turn');
    // User input supersedes only automatic work that has never been handed out.
    // Offered tool receipts retain their identity until a later request proves receipt.
    const prioritized = !finishOwner ? current.map(row => row.sessionId === entry.sessionId && row.finishOwner && row.state === 'queued'
      ? { ...row, state: 'cancelled' as const, error: 'Replaced by your new instruction before delivery.' } : row) : current;
    await commit(append(prioritized, entry, input.mode === 'auto' && !finishOwner && policy?.canInject === true));
    return { ...entry };
  });
}
export function listInputs(): Promise<InputEntry[]> {
  return serial(async () => {
    const current = await load();
    let next: InputEntry[] = [];
    for (const entry of current) {
      if (entry.purpose !== 'decision' && (entry.state === 'sent' || (entry.state === 'cancelled' && entry.deliveredAt !== undefined)) && !entry.sessionId && entry.conversationId && !entry.deliveredSessionId) {
        const session = await findSessionByConversation(entry.conversationId, { requireUnique: true });
        next.push(session ? { ...entry, deliveredSessionId: session.id } : entry);
      } else next.push(entry);
    }
    for (const entry of [...next]) {
      const targetId = entry.sessionId ?? entry.deliveredSessionId;
      if (entry.state !== 'sent' || !targetId || !entry.stages?.length || entry.stagesApplied) continue;
      const position = next.indexOf(entry); next[position] = { ...entry, stagesApplied: true };
      // Checkpoints continue the current chat model, including a later explicit
      // user selection; only the plan's initial send owns its requested picker.
      for (const [index, text] of entry.stages.entries()) next = append(next, { id: randomUUID(), sessionId: targetId, projectId: entry.projectId, text, mode: 'finish', dueAt: entry.createdAt + index, model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: entry.createdAt + index, conversationId: entry.conversationId });
    }
    if (next.length !== current.length || next.some((entry, index) => entry !== current[index])) await commit(next);
    await publishHistory();
    return ordered(await load()).map((entry) => ({ ...entry }));
  });
}
/** A sent receipt survives a recorder failure. Existing outbox reads retry publication,
 * never transport; the stable canonical key makes a lost recording ACK idempotent. */
async function publishHistory(): Promise<void> {
  const current = await load();
  const recorded = new Set<string>();
  for (const row of current) {
    if (!needsHistory(row)) continue;
    try { if (deliveryHooks?.recordDelivered && await deliveryHooks.recordDelivered(row)) recorded.add(row.id); }
    catch { /* delivered, retained, and still visible until canonical recording succeeds */ }
  }
  if (recorded.size) {
    try { await commit(current.map(row => recorded.has(row.id) ? { ...row, historyRecorded: true } : row)); }
    catch { /* the durable delivery receipt remains; canonical retry is idempotent */ }
  }
}
export function cancelInput(id: string): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const found = current.find((entry) => entry.id === id);
    if (!found || !['queued', 'browser'].includes(found.state)) return false;
    await commit(current.map((entry) => entry === found ? { ...entry, state: 'cancelled',
      error: found.state === 'browser' ? found.requiresAuthorization && found.sendAuthorizedAt === undefined
        ? 'Not sent: this delivery was cancelled before Send was authorized.'
        : 'Cancelled locally. Delivery to ChatGPT is unconfirmed; the message may already have been sent.' : undefined } : entry));
    decisionWaiters.get(id)?.reject(new Error('goal_browser_cancelled'));
    decisionWaiters.delete(id);
    return true;
  });
}

/** Editing is possible only before handout; claimed text is immutable. */
export function reorderQueuedInputs(sessionId: string, ids: string[]): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const queue = current.filter(row => row.sessionId === sessionId && queuedFollowup(row) && row.state === 'queued');
    // A stale snapshot must not move claimed input or omit newly queued work.
    if (!ids.length || ids.length !== queue.length || new Set(ids).size !== ids.length ||
        queue.some(row => !ids.includes(row.id))) return false;
    const positions = new Map(ids.map((id, index) => [id, index]));
    await commit(current.map(row => positions.has(row.id) ? { ...row, queueOrder: positions.get(row.id)! } : row));
    return true;
  });
}

/** Called inside the existing serialized settings transaction after publishing Off
 * and before re-enabling On (also recovering a failed earlier retirement).
 * A later On cannot revive these durable cancellations, even across restart. */
export function cancelFinishInputs(periodicOnly: boolean): Promise<void> {
  return serial(async () => {
    const current = await load();
    const next = current.map(row => row.finishOwner && (!periodicOnly || row.finishOwner.periodic) && !terminal(row)
      ? { ...row, state: 'cancelled' as const, error: 'Automatic follow-up cancelled by settings. Already offered input may have reached ChatGPT.' } : row);
    if (next.some((row, index) => row !== current[index])) await commit(next);
  });
}

export function editQueuedInput(id: string, text: string, afterTurn?: boolean): Promise<boolean> {
  return serial(async () => {
    const value = z.string().trim().min(1).max(16000).parse(text);
    const current = await load();
    const row = current.find(entry => entry.id === id && entry.state === 'queued' && queuedFollowup(entry));
    if (!row) return false;
    if (current.filter(entry => !terminal(entry)).reduce((sum, entry) => sum + Buffer.byteLength(entry === row ? value : entry.text), 0) > 1024000) throw new Error('Queued messages exceed the text limit');
    await commit(current.map(entry => entry === row ? { ...row, text: value, ...(afterTurn === undefined ? {} : { afterTurn }), deliveryText: undefined } : entry));
    return true;
  });
}

/** Revalidate the same durable claim immediately before sending; never hand out text again. */
export function authorizeBrowserInput(id: string, owner: string, conversationId: string | null): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const row = current.find(row => row.id === id && row.owner === owner && row.state === 'browser' && row.conversationId === conversationId);
    if (!row || row.sendAuthorizedAt !== undefined) return false;
    if (!(await browserInputAllowed(row)) || await target(row) !== conversationId) return false;
    await commit(current.map(entry => entry === row ? { ...row, sendAuthorizedAt: Date.now() } : entry));
    return true;
  });
}
/** The same outbox serialization owns mode changes and browser ACK. A late ACK
 * must observe Off; an ACK that won first is followed by the exact bound-chat Off. */
export function setInputAutomation(id: string, automation: NonNullable<InputArgs['automation']>): Promise<boolean> {
  return serial(async () => {
    const mode = z.enum(['off', 'goal', 'loop']).parse(automation);
    const current = await load();
    const entry = current.find(row => row.id === id && row.purpose !== 'decision' && ['queued', 'browser', 'sent', 'tool'].includes(row.state));
    if (!entry) return false;
    const conversationId = entry.conversationId;
    if (conversationId && await conversationWasSuperseded(conversationId)) return false;
    const sessionId = entry.sessionId ?? entry.deliveredSessionId;
    if (sessionId && (await getSession(sessionId))?.conversationId !== conversationId) return false;
    await commit(current.map(row => row === entry ? { ...row, automation: mode } : row));
    if (conversationId && (mode === 'off' || entry.state !== 'queued')) {
      if (!deliveryHooks) throw new Error('Input delivery is not ready');
      // Mode changes preserve the chat's current objective. Only the delivery
      // transition transfers the opening text; an old outbox row must not overwrite
      // an objective the user edited after this message was delivered.
      await deliveryHooks.applyAutomation(conversationId, mode, entry.state === 'sent' ? 'after-send' : 'before-send');
    }
    return true;
  });
}
export function noteInputStartupError(id: string, error: string | null): Promise<InputEntry | null> {
  return serial(async () => {
    const current = await load();
    const row = current.find(entry => entry.id === id);
    if (!row) return null;
    if (row.state !== 'queued') return { ...row };
    const next = { ...row, error: error ? error.slice(0, 200) : undefined };
    await commit(current.map(entry => entry === row ? next : entry));
    return { ...next };
  });
}
/** Metadata only. Text is disclosed to one document only after an exclusive durable claim. */
async function completedStageBoundary(entry: InputEntry, current: InputEntry[]): Promise<string | null> {
  if (!entry.sessionId || !queuedFollowup(entry)) return null;
  // Finish-only stages have no browser authority. They must not block a later
  // explicit After This Turn instruction from spending this completed turn.
  let first: InputEntry | undefined;
  for (const row of ordered(current)) {
    if (row.sessionId === entry.sessionId && queuedFollowup(row) && row.state === 'queued' && row.dueAt <= Date.now() && await browserInputAllowed(row)) { first = row; break; }
  }
  if (first?.id !== entry.id) return null;
  const session = await getSession(entry.sessionId);
  if (!session || session.activeTurnId || session.origin?.kind === 'worker') return null;
  // The newest exact lifecycle event must be completion, never interruption, a
  // historical final, or merely an idle page. One durable claim spends this end.
  const [end] = await readRecentEvents(entry.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
  if (end?.kind !== 'turn_end' || end.outcome !== 'completed' || !end.turnId || end.time < entry.createdAt) return null;
  if (current.some(row => row.sessionId === entry.sessionId && (row.completedTurnId === end.turnId || row.state === 'tool' || row.state === 'browser'))) return null;
  if (current.some(row => row.sessionId === entry.sessionId && !queuedFollowup(row) && row.purpose !== 'decision' &&
      row.dueAt <= Date.now() && ['queued', 'browser', 'tool'].includes(row.state))) return null;
  return end.turnId;
}
export function pendingBrowserInputs(): Promise<Array<{ id: string; conversationId: string | null; supersededConversationId?: string; lifetime?: 'temporary-planner' }>> {
  return serial(async () => {
    const result: Array<{ id: string; conversationId: string | null; supersededConversationId?: string; lifetime?: 'temporary-planner' }> = [];
    const current = await load();
    for (const entry of ordered(current)) {
      if (!preparable(entry) || entry.dueAt > Date.now()) continue;
      if (queuedFollowup(entry) && !(entry.state === 'browser' && entry.completedTurnId) && !(await completedStageBoundary(entry, current))) continue;
      if (!(await browserInputAllowed(entry))) continue;
      try {
        const conversationId = await target(entry);
        result.push({ id: entry.id, conversationId,
          ...(entry.state === 'queued' && entry.purpose !== 'decision' && entry.sessionId && entry.conversationId && entry.conversationId !== conversationId
            ? { supersededConversationId: entry.conversationId } : {}),
          ...(entry.lifetime ? { lifetime: entry.lifetime } : {}) });
      } catch { /* blocked/deleted stays user-visible */ }
    }
    return result;
  });
}
export function claimBrowserInput(id: string, owner: string, conversationId: string | null, requiresAuthorization = false): Promise<InputEntry | null> {
  return serial(async () => {
    const current = await load();
    const entry = current.find((row) => row.id === id);
    if (!entry || !preparable(entry) || (entry.state === 'browser' && !requiresAuthorization) || entry.dueAt > Date.now() || !owner) return null;
    const completedTurnId = queuedFollowup(entry) ? entry.state === 'browser' ? entry.completedTurnId : await completedStageBoundary(entry, current) : undefined;
    if (queuedFollowup(entry) && !completedTurnId) return null;
    if (await target(entry) !== conversationId) return null;
    if (!(await browserInputAllowed(entry))) return null;
    if (entry.purpose === 'decision' && !decisionWaiters.has(id)) return null;
    if (entry.projectId) await projectWorkspace(entry.projectId);
    if (entry.sessionId) {
      if (current.some((row) => row.id !== id && row.sessionId === entry.sessionId && ['browser', 'tool'].includes(row.state))) return null;
      const first = ordered(current).find((row) => row.sessionId === entry.sessionId && row.state === 'queued' && queuedFollowup(row) === queuedFollowup(entry) && row.dueAt <= Date.now());
      // Follow-ups were already elected by completedStageBoundary with live
      // transport eligibility. Direct messages retain their separate FIFO.
      if (entry.state === 'queued' && !queuedFollowup(entry) && first !== entry) return null;
    }
    let claimed: InputEntry;
    try { claimed = prepare({ ...entry, ...(completedTurnId ? { completedTurnId } : {}), state: 'browser', owner, conversationId, offeredAt: entry.offeredAt ?? Date.now(), requiresAuthorization }); }
    catch (error) {
      // A never-handed-out oversized legacy row needs a visible terminal result,
      // not an endless series of browser claims. Existing claims keep their receipt.
      if (entry.state === 'queued') await commit(current.map(row => row === entry
        ? { ...entry, state: 'failed', error: (error as Error).message.slice(0, 200) } : row));
      throw error;
    }
    // Normal sends (including opted-in stages) carry the short user-prompt appendix.
    // MCP delivery below owns the distinct tool-return reminder, never the planner.
    const session = entry.sessionId ? await getSession(entry.sessionId) : null;
    const observed = session?.selectedModel?.conversationId === conversationId ? session?.selectedModel : null;
    const selection = browserInputModel(entry);
    const settings = getConfig().ui;
    if (settings.finishTool && entry.purpose !== 'decision' && session?.origin?.kind !== 'worker' && session?.origin?.kind !== 'helper' &&
        isAstraModel(selection.model ?? observed?.model, selection.model ? selection.reasoningEffort ?? undefined : observed?.reasoningEffort)) {
      const instruction = finishInstruction(settings.finishLeadMinutes);
      if (!claimed.deliveryText!.includes(instruction)) claimed.deliveryText += '\n\n' + instruction;
    }
    await transition(current, current.map((row) => row === entry ? claimed : row),
      entry.state === 'queued' && entry.automation && conversationId && entry.purpose !== 'decision' ? [claimed] : [], 'before-send');
    logInfo(`input ${id}: browser claimed after ${Math.max(0, Date.now() - entry.createdAt)} ms`);
    return { ...claimed, ...selection, text: claimed.deliveryText ?? claimed.text };
  });
}
/** Commit exact project ownership before the document publishes any request-id evidence. */
export function bindBrowserInputProject(id: string, owner: string, conversationId: string): Promise<boolean> {
  return serial(async () => {
    if (!owner || !/^[0-9a-z-]{8,256}$/i.test(conversationId)) return false;
    const current = await load();
    const entry = current.find(row => row.id === id && row.owner === owner);
    if (!entry || !['browser', 'sent'].includes(entry.state) || !entry.projectId || entry.purpose === 'decision') return false;
    if (entry.conversationId && entry.conversationId !== conversationId) return false;
    if (await conversationWasSuperseded(conversationId)) return false;
    // Fence this claim to one conversation durably before creating its session.
    const bound = { ...entry, conversationId };
    if (!entry.conversationId) await commit(current.map(row => row === entry ? bound : row));
    const heldSessionId = entry.sessionId ?? entry.deliveredSessionId;
    const session = heldSessionId ? await getSession(heldSessionId) :
      await findSessionByConversation(conversationId, { requireUnique: true }) ?? await createSession({ conversationId, title: entry.text.slice(0, 120) });
    if (!session || session.conversationId !== conversationId) return false;
    await assignSessionProject(session.id, entry.projectId);
    const latest = await load();
    await commit(latest.map(row => row.id === id ? { ...row, deliveredSessionId: session.id } : row));
    return true;
  });
}
export function acknowledgeBrowserInput(id: string, owner: string, conversationId?: string | null, messageId?: string): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const entry = current.find((row) => row.id === id && row.owner === owner);
    if (!owner || !entry || !['browser', 'sent', 'decision', 'cancelled'].includes(entry.state) ||
      (entry.state === 'cancelled' && entry.purpose === 'decision')) return false;
    if (conversationId !== undefined && !(entry.lifetime === 'temporary-planner' && conversationId === null) && (!conversationId || !/^[0-9a-z-]{8,256}$/i.test(conversationId))) return false;
    if (conversationId && entry.conversationId && entry.conversationId !== conversationId) return false;
    // A fresh user send is not complete until ChatGPT assigns its exact conversation.
    // Keep the authored sessionId unchanged so retrying the original enqueue is idempotent.
    if (!entry.sessionId && entry.purpose !== 'decision' && !conversationId && !entry.conversationId) return false;
    if (messageId !== undefined && (!messageId || messageId.length > 256)) return false;
    if ((entry.state !== 'browser' && entry.state !== 'cancelled') || (entry.state === 'cancelled' && entry.deliveredAt !== undefined)) { await publishHistory(); return true; }
    const deliveredConversation = conversationId ?? entry.conversationId;
    if (!entry.sessionId && entry.purpose !== 'decision' && deliveredConversation) {
      await noteChatOrigin(deliveredConversation, { kind: 'desktop', fromSessionId: null, agentId: null, task: '' });
    }
    const delivered = entry.sessionId ? await getSession(entry.sessionId) : deliveredConversation
      ? await findSessionByConversation(deliveredConversation, { requireUnique: true }) : null;
    if (entry.purpose === 'decision' && entry.lifetime !== 'temporary-planner' && deliveredConversation) await deliveryHooks?.bindHelper?.(deliveredConversation, entry.decisionSourceSessionId ?? null);
    const acknowledged: InputEntry = { ...entry, conversationId: deliveredConversation,
      deliveredSessionId: delivered?.id ?? null, state: entry.state === 'cancelled' ? 'cancelled' : entry.purpose === 'decision' ? 'decision' : 'sent',
      ...(entry.state === 'cancelled' ? { error: 'Cancelled locally; delivery was later confirmed in ChatGPT.' } : {}),
      ...(entry.purpose !== 'decision' ? { ...(messageId ? { messageId } : {}), deliveredAt: Date.now() } : {}) };
    await transition(current, current.map((row) => row === entry ? acknowledged : row),
      entry.state !== 'cancelled' && !entry.sessionId && entry.automation && deliveredConversation && entry.purpose !== 'decision' ? [acknowledged] : [], 'after-send');
    logInfo(`input ${id}: browser acknowledged after ${Math.max(0, Date.now() - entry.createdAt)} ms`);
    await publishHistory();
    return true;
  });
}
/** A later exact call proves receipt of an earlier tool response, never of a queued task. */
function toolInputReceipt(entry: InputEntry, sessionId: string, conversationId: string, startedAt: number): InputEntry {
  const deliveredAt = offered.get(entry.id);
  return entry.sessionId === sessionId && entry.conversationId === conversationId && entry.state === 'tool' &&
    deliveredAt !== undefined && startedAt > deliveredAt
    ? { ...entry, state: 'sent', messageId: `input:${entry.id}`, deliveredAt, historyRecorded: false } : entry;
}
/** Commit incoming receipt evidence before a handler decides whether user work remains. */
export function acknowledgeToolInput(sessionId: string | null | undefined, conversationId: string | null | undefined, requestId: string | null | undefined, startedAt: number): Promise<void> {
  return serial(async () => {
    if (!sessionId || !conversationId || !requestId || isChatBlocked(conversationId)) return;
    if ((await getSession(sessionId))?.conversationId !== conversationId) return;
    const current = await load();
    const next = current.map(entry => toolInputReceipt(entry, sessionId, conversationId, startedAt));
    if (!next.some((entry, index) => entry !== current[index])) return;
    await commit(next);
    for (const entry of next) if (terminal(entry)) offered.delete(entry.id);
    await publishHistory();
  });
}

export function offerToolInput(sessionId: string | null | undefined, conversationId: string | null | undefined, requestId: string | null | undefined, startedAt: number, finishBoundary = false): Promise<Array<{ text: string; images: InputImage[] }>> {
  return serial(async () => {
    if (!sessionId || !conversationId || !requestId || isChatBlocked(conversationId)) return [];
    const session = await getSession(sessionId);
    if (session?.conversationId !== conversationId) return [];
    const finishSettings = getConfig().ui;
    finishBoundary = finishBoundary && finishSettings.finishTool === true && session.origin?.kind !== 'worker';
    const finishReminder = finishSettings.finishTool === true && !session.finishTurn?.released &&
      session.origin?.kind !== 'worker' && session.origin?.kind !== 'helper' &&
      session.selectedModel?.conversationId === conversationId && isAstraModel(session.selectedModel.model, session.selectedModel.reasoningEffort)
      ? finishInputInstruction(finishSettings.finishLeadMinutes) : '';
    const current = await load();
    const result: Array<{ text: string; images: InputImage[] }> = [];
    // A claimed browser send owns this session until its send outcome is known.
    if (current.some((entry) => entry.sessionId === sessionId && entry.state === 'browser')) return [];
    const delivered: string[] = [];
    let inputTaken = false;
    let payloadBytes = 0;
    let payloadImages = 0;
    let payloadFull = false;
    const next = ordered(current).sort((a, b) => Number(a.mode === 'finish' || !!a.finishOwner) - Number(b.mode === 'finish' || !!b.finishOwner)).map((entry): InputEntry => {
      if (entry.sessionId !== sessionId || entry.dueAt > Date.now()) return entry;
      if (entry.attachments?.length) return entry;
      // ChatGPT may reuse one request id for the whole server turn. Receipt follows
      // the actual invocation start, never a change in that grouping id.
      const received = toolInputReceipt(entry, sessionId, conversationId, startedAt);
      if (received !== entry) return received;
      if (payloadFull || (inputTaken && (entry.mode === 'finish' || entry.finishOwner)) || (entry.finishOwner && entry.createdAt >= startedAt)) return entry;
      if (entry.mode === 'finish' && !finishBoundary) return entry;
      // After-turn tasks own a future browser turn; they cannot block an explicit
      // Inject now message from the current tool response. Their own FIFO is unchanged.
      if ((entry.state === 'queued' && (entry.mode === 'finish' || entry.mode === 'auto')) || entry.state === 'tool') {
        let prepared: InputEntry;
        try { prepared = prepare({ ...entry, conversationId }); }
        catch (error) { return { ...entry, state: 'failed', error: (error as Error).message.slice(0, 200) }; }
        const message = `[User message ${entry.id}]\n${prepared.deliveryText ?? prepared.text}` + (finishReminder ? `\n\n${finishReminder}` : entry.mode === 'finish' ? '\nWork on this user task now.' : '');
        if (payloadBytes + Buffer.byteLength(message) > TOOL_INPUT_TEXT_BYTES || payloadImages + (entry.images?.length ?? 0) > 4) { payloadFull = true; return entry; }
        payloadBytes += Buffer.byteLength(message);
        payloadImages += entry.images?.length ?? 0;
        inputTaken = true;
        result.push({ text: message, images: entry.images ?? [] });
        delivered.push(entry.id);
        return { ...prepared, state: 'tool', offeredAt: entry.offeredAt ?? Date.now(), owner: entry.state === 'tool' ? entry.owner : requestId, conversationId };
      }
      return entry;
    });
    if (next.some((entry, index) => entry !== current[index])) {
      const automated = next.filter((entry) => entry.state === 'tool' && entry.automation && current.some((row) => row.id === entry.id && row.state === 'queued'));
      await transition(current, next, automated, 'before-send');
    }
    for (const id of delivered) if (!offered.has(id)) offered.set(id, Date.now());
    for (const entry of next) if (terminal(entry)) offered.delete(entry.id);
    await publishHistory();
    return result;
  });
}

export function resetInputForTests(): void { entries = null; chain = Promise.resolve(); offered.clear(); decisionWaiters.clear(); }

export async function pausedBrowserHelpers(): Promise<Array<{ id: string; sourceSessionId: string }>> {
  return (await listInputs()).filter(row => row.purpose === 'decision' && row.state === 'cancelled' && !row.conversationId && row.decisionSourceSessionId)
    .map(row => ({ id: row.id, sourceSessionId: row.decisionSourceSessionId! }));
}

/** A deliberate user action withdraws exactly one ambiguous attempt's retry fence.
 * Its old owner remains terminal forever; this never replays the previous send. */
export function authorizeBrowserHelperRetry(id: string, sourceSessionId: string): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const row = current.find(entry => entry.id === id && entry.decisionSourceSessionId === sourceSessionId
      && entry.purpose === 'decision' && entry.state === 'cancelled' && !entry.conversationId);
    if (!row || current.some(entry => entry.decisionSourceSessionId === sourceSessionId && !terminal(entry))) return false;
    await commit(current.map(entry => entry === row ? { ...entry, state: 'failed', error: 'User authorized a new helper' } : entry));
    return true;
  });
}

/** Only a pre-send failure can be declared failed. An ambiguous click stays claimed. */
export function failBrowserInput(id: string, owner: string, error: string): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const entry = current.find((row) => row.id === id && row.owner === owner && row.state === 'browser');
    if (!entry) return false;
    await commit(current.map((row) => row === entry ? { ...row, state: 'failed', error: error.slice(0, 200) } : row));
    decisionWaiters.get(id)?.reject(new Error('goal_browser_send_failed'));
    decisionWaiters.delete(id);
    return true;
  });
}

// The browser is an alternative decision transport, using this same exclusive outbox.
// A timeout cancels authority; late answers cannot become messages in the source chat.
const decisionWaiters = new Map<string, { resolve: (text: string) => void; reject: (reason: unknown) => void; publish?: (text: string) => void }>();
/** Presentation only, fenced by the same exact decision claim as its eventual answer. */
export async function publishBrowserDecision(id: string, owner: string, conversationId: string | null, text: string): Promise<boolean> {
  if (text.length > 8000) return false;
  const entry = (await load()).find(row => row.id === id && row.owner === owner && row.purpose === 'decision' &&
    row.conversationId === conversationId && ['browser', 'decision'].includes(row.state));
  const waiter = decisionWaiters.get(id);
  if (!entry || !waiter) return false;
  waiter.publish?.(text); return true;
}
export async function requestBrowserDecision(text: string, signal: AbortSignal, options: {
  lifetime?: 'temporary-planner';
  sourceSessionId?: string; conversationId?: string | null; model?: string;
  reasoningEffort?: InputArgs['reasoningEffort'];
  publish?: (text: string) => void;
} = {}): Promise<string> {
  if (!text.trim() || text.length > 240000) throw new Error('goal_context_too_large');
  signal.throwIfAborted();
  const id = randomUUID();
  let resolveAnswer!: (text: string) => void;
  let rejectAnswer!: (reason: unknown) => void;
  const answer = new Promise<string>((resolve, reject) => { resolveAnswer = resolve; rejectAnswer = reject; });
  void answer.catch(() => undefined);
  decisionWaiters.set(id, { resolve: resolveAnswer, reject: rejectAnswer, publish: options.publish });
  const cancel = () => {
    decisionWaiters.delete(id);
    rejectAnswer(new Error('goal_browser_cancelled'));
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const queued = await serial(async () => {
      signal.throwIfAborted();
      const current = await load();
      if (current.filter((row) => row.purpose === 'decision' && ['queued', 'browser', 'decision'].includes(row.state)).length >= 4) throw new Error('goal_browser_busy');
      if (options.sourceSessionId && current.some(row => row.decisionSourceSessionId === options.sourceSessionId && !terminal(row))) throw new Error('goal_browser_busy');
      if (options.sourceSessionId && !options.conversationId && current.some(row => row.decisionSourceSessionId === options.sourceSessionId && row.state === 'cancelled' && !row.conversationId)) {
        throw new Error('goal_browser_send_unconfirmed');
      }
      const entry = entrySchema.parse({ id, sessionId: null, text, mode: 'after-turn', dueAt: Date.now(),
        model: options.model ?? 'gpt-5.6-sol', reasoningEffort: options.reasoningEffort ?? 'high',
        decisionSourceSessionId: options.sourceSessionId, lifetime: options.lifetime, purpose: 'decision', state: 'queued', owner: null,
        createdAt: Date.now(), conversationId: options.conversationId ?? null });
      await commit(append(current, entry));
      return entry;
    });
    signal.throwIfAborted();
    await deliveryHooks?.wakeDecision?.(queued, signal);
    signal.throwIfAborted();
    return await answer;
  } finally {
    decisionWaiters.delete(id);
    signal.removeEventListener('abort', cancel);
    // Catch an abort that raced enqueue before the answer was awaited.
    void answer.catch(() => undefined);
    await serial(async () => {
      const current = await load();
      if (current.some((row) => row.id === id && !terminal(row))) {
        await commit(current.map((row) => row.id === id && !terminal(row) ? { ...row, state: 'cancelled' } : row));
      }
    });
  }
}
export function completeBrowserDecision(id: string, owner: string, response: string, conversationId?: string | null): Promise<boolean> {
  return serial(async () => {
    if (!response.trim() || response.length > 16000) return false;
    const current = await load();
    if (current.some((entry) => entry.id === id && entry.owner === owner && entry.purpose === 'decision' && entry.state === 'sent' && entry.response === response)) return true;
    if (!decisionWaiters.has(id)) return false;
    const row = current.find((entry) => entry.id === id && entry.owner === owner && entry.purpose === 'decision' && ['browser', 'decision'].includes(entry.state));
    if (!row) return false;
    if (conversationId && row.conversationId && conversationId !== row.conversationId) return false;
    await commit(current.map((entry) => entry === row ? { ...entry, conversationId: conversationId ?? row.conversationId, state: 'sent', response } : entry));
    const waiter = decisionWaiters.get(id);
    if (!waiter) await commit((await load()).map((entry) => entry.id === id ? { ...entry, state: 'cancelled', response: undefined } : entry));
    waiter?.resolve(response);
    return !!waiter;
  });
}
