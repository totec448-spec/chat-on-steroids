import { z } from 'zod';
import { serveWorkerAction } from './control-workers.js';
import { resolveChatModel } from '../shared/chat-models.js';
import type { ControlApiCancelResult, ControlApiSendResult, ControlApiStopResult } from '../shared/control-api.js';
import { REASONING_EFFORTS } from '../shared/session.js';
import type { ReasoningEffort } from '../shared/session.js';
import { getChatModels } from './chat-models.js';
import { stopSessionTurn } from './bridge.js';
import type { SessionControlsView } from './bridge.js';
import { getConfig } from './config.js';
import { projectInput, projectLive, RequestError } from './control-reads.js';
import { logInfo } from './logger.js';
import { deliveryProof, listInputs, sessionInputPolicy } from './session/input.js';
import type { InputArgs, InputEntry } from './session/input.js';
import { getProject } from './projects.js';
import { readSession } from './session/read-model.js';
import { cancelDesktopInput, sendDesktopInput } from './session/start-input.js';

/**
 * The action routes of the local control API: send a message to an existing chat or start a new
 * chat with it, cancel one that has not been handed over, stop the answer a chat is writing, or
 * delegate to the existing worker broker.
 *
 * There is no new send path. A message goes through `sendDesktopInput`, the same entry the
 * composer uses, and is cancelled through `cancelDesktopInput`. Stop goes through
 * `stopSessionTurn`, the same entry as the app's Stop button. The outbox stays the only owner
 * of what was admitted, what was delivered and what is unknown. The caller's UUID is the outbox
 * id, so repeating it returns the row that already exists instead of sending again. What a row
 * proves about delivery comes from `deliveryProof`, never from time, text or a turn range, and a
 * row that may have reached ChatGPT is reported as unconfirmed and is never resent.
 *
 * The listener decides whether actions are allowed at all and reads the request body; this
 * module only sees an authorized, size-checked, parsed request.
 */

/** Actions need both switches. The listener runs only with the first, but a save can race a request. */
export function actionsAllowed(): boolean {
  const { enabled, allowActions } = getConfig().controlApi;
  return enabled && allowActions;
}

/** A message may be shorter than the app's own ceiling; the byte envelope is checked at claim time. */
const MAX_TEXT = 64_000;

/** Ids are generated lowercase; another casing would name a second row for the same message. */
const lowerUuid = z.string().uuid().refine((value) => value === value.toLowerCase(), 'id must be lowercase');

const sendBody = z
  .object({
    id: lowerUuid,
    // Without a session the message starts a new chat (#1349), whose id is the message id.
    sessionId: z.string().regex(/^[0-9a-z-]{8,64}$/).optional(),
    // The project a new chat starts in. An existing chat keeps the one it has.
    projectId: lowerUuid.optional(),
    text: z.string().max(MAX_TEXT).refine((value) => value.trim().length > 0, 'text is empty'),
    // Consent to a send that would stop the answer ChatGPT is writing right now.
    interrupt: z.boolean().optional(),
    // A model and one of its thinking levels from GET /v1/models, always together, as the composer sends them.
    model: z.string().min(1).max(80).optional(),
    reasoningEffort: z.enum(REASONING_EFFORTS).optional()
  })
  .strict()
  .refine((body) => body.sessionId === undefined || body.projectId === undefined, { path: ['projectId'], message: 'a project belongs to a new chat' })
  .refine((body) => (body.model === undefined) === (body.reasoningEffort === undefined), { path: ['reasoningEffort'], message: 'model and reasoningEffort go together' });

const cancelBody = z.object({}).strict();

// Stop names the exact answer it ends (`live.activeTurnId`), so a late request never stops a newer one.
const stopBody = z.object({ turnId: z.string().min(1).max(256) }).strict();

const CANCEL_ROUTE = /^\/v1\/inputs\/([0-9a-f-]{36})\/cancel$/;
const STOP_ROUTE = /^\/v1\/sessions\/([0-9a-z-]{8,64})\/stop$/;

/** Every path an action can arrive on, whatever the id, so one gate can refuse them all alike. */
export function isActionPath(route: string): boolean {
  return route === '/v1/inputs' || /^\/v1\/inputs\/[^/]+\/cancel$/.test(route) || /^\/v1\/workers\/[^/]+\/(spawn|message|ack)$/.test(route) ||
    /^\/v1\/sessions\/[^/]+\/stop$/.test(route);
}

export interface ActionReply {
  status: number;
  body: unknown;
}

const find = async (id: string): Promise<InputEntry | undefined> => (await listInputs()).find((row) => row.id === id);

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join('.') : 'body';
    throw new RequestError(400, 'invalid_body', issue?.code === 'unrecognized_keys' ? 'unknown field' : where + ' is not valid');
  }
  return parsed.data;
}

/** The outbox throws plain errors; these literals are the ones a caller can act on. */
function refusal(error: unknown): RequestError | null {
  const message = error instanceof Error ? error.message : '';
  if (message === 'The app is shutting down') return new RequestError(503, 'shutting_down');
  if (message === 'Input cancelled') return new RequestError(409, 'cancelled');
  if (message.startsWith('One message is already awaiting delivery')) return new RequestError(409, 'busy', 'another message for this chat is still awaiting delivery');
  if (message === 'Message id already belongs to different input') return new RequestError(409, 'id_conflict');
  if (message === 'Unblock this conversation before sending') return new RequestError(409, 'chat_blocked');
  if (message === 'This recording has no ChatGPT conversation') return new RequestError(409, 'no_chat');
  if (message === 'The message queue is full') return new RequestError(503, 'queue_full');
  if (error instanceof z.ZodError) return new RequestError(400, 'invalid_body');
  return null;
}

/** A worker or helper chat belongs to the run that opened it; a person or the prime talks to it. */
async function controllable(sessionId: string | null): Promise<void> {
  if (!sessionId) return;
  const origin = (await readSession(sessionId))?.origin?.kind;
  if (origin === 'worker' || origin === 'helper') throw new RequestError(409, 'session_not_controllable');
}

/**
 * The catalog id and a thinking level it offers, checked against the models the app last read from
 * ChatGPT's picker, exactly as the composer only offers those. Without them ChatGPT keeps its own selection.
 */
function chosenModel(model: string | undefined, effort: ReasoningEffort | undefined): { model: string | null; reasoningEffort: ReasoningEffort | null } {
  if (model === undefined || effort === undefined) return { model: null, reasoningEffort: null };
  const catalog = getChatModels();
  if (catalog.state !== 'ready' || !catalog.models.length) {
    throw new RequestError(409, 'models_unknown', "the app has not read this account's models yet; refresh them in the app");
  }
  const choice = resolveChatModel(catalog.models, model);
  if (!choice) throw new RequestError(409, 'model_unknown', 'GET /v1/models lists the models this account offers');
  if (!choice.efforts.includes(effort)) throw new RequestError(409, 'effort_unavailable', choice.id + ' offers ' + choice.efforts.join(', '));
  return { model: choice.id, reasoningEffort: effort };
}

async function send(rawBody: unknown): Promise<ActionReply> {
  const body = parse(sendBody, rawBody);
  const text = body.text.trim();
  const selection = chosenModel(body.model, body.reasoningEffort);

  // A repeated id names the row that already exists. It is answered here because the outbox
  // compares the whole request, `dueAt` included, and a retry a moment later would not match.
  const existing = await find(body.id);
  if (existing) {
    // A new chat's first message is filed under its own id.
    if (existing.purpose === 'decision' || existing.sessionId !== (body.sessionId ?? body.id) || existing.text !== text ||
        existing.model !== selection.model || existing.reasoningEffort !== selection.reasoningEffort) {
      throw new RequestError(409, 'id_conflict', 'this id belongs to a different message');
    }
    const replay: ControlApiSendResult = { input: projectInput(existing), replayed: true };
    return { status: 200, body: replay };
  }

  if (body.sessionId === undefined) {
    if (body.projectId !== undefined && !(await getProject(body.projectId))) throw new RequestError(404, 'project_not_found');
  } else {
    const session = await readSession(body.sessionId);
    if (!session) throw new RequestError(404, 'session_not_found');
    await controllable(body.sessionId);
    if (!session.conversationId) throw new RequestError(409, 'no_chat', 'this session has no ChatGPT chat to send to');

    // A send into an answer being written ends that part of the turn: ChatGPT continues with the
    // message. That is a decision for the caller, not a default.
    const interrupting = !!(await sessionInputPolicy(body.sessionId)).directTurn;
    if (interrupting && body.interrupt !== true) {
      throw new RequestError(409, 'would_interrupt', 'the chat is answering; pass interrupt:true to send into that answer');
    }
  }

  const input: InputArgs = {
    id: body.id,
    // The outbox opens a chat for a message without a session, exactly as the composer's New chat does.
    sessionId: body.sessionId ?? null,
    ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
    text,
    mode: 'auto',
    dueAt: Date.now(),
    ...selection,
    authoredSource: 'text'
  };
  // The switch can flip while the lookups above run; this is the last point before the outbox.
  if (!actionsAllowed()) throw new RequestError(403, 'actions_disabled');
  let row: InputEntry;
  try {
    row = await sendDesktopInput(input);
  } catch (error) {
    throw refusal(error) ?? error;
  }
  // The outbox decides for itself, when it admits the row, whether this send stops an answer. If
  // a turn began after the check above, the caller did not agree to that: withdraw the row.
  if (row.directTurn && body.interrupt !== true) {
    await cancelDesktopInput(row.id);
    throw new RequestError(409, 'would_interrupt', 'the chat began answering while the message was being admitted; it was withdrawn');
  }
  logInfo('control API: message ' + row.id + (body.sessionId === undefined ? ' admitted as a new chat' : ' admitted for session ' + body.sessionId));
  // Admitted, not delivered: the row is durable, and delivery is read from GET /v1/inputs.
  const reply: ControlApiSendResult = { input: projectInput(row), replayed: false };
  return { status: 202, body: reply };
}

const notCancellable = (row: InputEntry, detail?: string): ActionReply => ({
  status: 409,
  body: { error: 'not_cancellable', ...(detail ? { detail } : {}), input: projectInput(row) }
});

async function cancel(id: string, rawBody: unknown): Promise<ActionReply> {
  parse(cancelBody, rawBody);
  const row = await find(id);
  if (!row || row.purpose === 'decision') throw new RequestError(404, 'input_not_found');
  await controllable(row.sessionId);

  // The app's own rules decide what is still cancellable, and this route is narrower than they
  // are: a message whose Send was authorized may already be in ChatGPT, and withdrawing it here
  // would free its chat for a second copy. Nothing is reported as cancelled unless the row is
  // provably not sent afterwards.
  if (row.state === 'sent' || row.state === 'tool') return notCancellable(row, 'already handed to ChatGPT');
  if (row.state === 'cancelled' || row.state === 'failed') {
    const already: ControlApiCancelResult = { input: projectInput(row), cancelled: false };
    return { status: 200, body: already };
  }
  if (deliveryProof(row) !== 'pending') return notCancellable(row, 'Send was authorized; it may already be in ChatGPT');
  // A new chat's first message owns a reserved local chat that cancelling deletes, and a pair of
  // rows is cancelled together. Both are decisions for the person at the app.
  if (row.opening) return notCancellable(row, 'a new chat is opening; cancel it in the app');
  if (row.companionInputId || (await listInputs()).some((other) => other.companionInputId === row.id)) {
    return notCancellable(row, 'it is paired with another message; cancel it in the app');
  }

  await cancelDesktopInput(id);
  const after = await find(id);
  if (!after) throw new RequestError(409, 'not_cancellable', 'the message left the outbox while it was being cancelled');
  if (after.state !== 'cancelled') return notCancellable(after);
  const proof = deliveryProof(after);
  logInfo('control API: message ' + id + ' cancelled, ' + proof);
  if (proof !== 'not_sent') {
    // Send was authorized between the check and the cancel. The row is withdrawn locally, but
    // the message may be in ChatGPT, so it is not reported as cancelled.
    return { status: 409, body: { error: 'delivery_unconfirmed', input: projectInput(after) } };
  }
  const done: ControlApiCancelResult = { input: projectInput(after), cancelled: true };
  return { status: 200, body: done };
}

async function stop(sessionId: string, rawBody: unknown): Promise<ActionReply> {
  const body = parse(stopBody, rawBody);
  const session = await readSession(sessionId);
  if (!session) throw new RequestError(404, 'session_not_found');
  await controllable(sessionId);
  if (!session.conversationId) throw new RequestError(409, 'no_chat', 'this session has no ChatGPT chat to stop');
  if (!actionsAllowed()) throw new RequestError(403, 'actions_disabled');
  let controls: SessionControlsView;
  try {
    controls = await stopSessionTurn(sessionId, body.turnId);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'active_turn_changed') throw new RequestError(409, 'turn_not_running', 'the answer this turnId names is not running');
    if (message === 'conversation_superseded' || message === 'conversation_changed') throw new RequestError(409, 'no_chat', 'this session moved to another chat');
    throw error;
  }
  logInfo('control API: stop requested for session ' + sessionId + ', turn ' + body.turnId);
  // Requested, not done: the browser presses Stop, and the recorded `turn_end` is the proof.
  const reply: ControlApiStopResult = { live: projectLive(controls) };
  return { status: 202, body: reply };
}

/** Undefined when the method and path are not an action. */
export async function serveAction(method: string, route: string, body: unknown): Promise<ActionReply | undefined> {
  if (method !== 'POST') return undefined;
  const worker = await serveWorkerAction(method, route, body, () => {
    if (!actionsAllowed()) throw new RequestError(403, 'actions_disabled');
  });
  if (worker) return worker;
  if (route === '/v1/inputs') return send(body);
  const match = CANCEL_ROUTE.exec(route);
  if (match) return cancel(match[1]!, body);
  const stopMatch = STOP_ROUTE.exec(route);
  if (stopMatch) return stop(stopMatch[1]!, body);
  return undefined;
}
