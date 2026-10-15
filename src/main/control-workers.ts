import { z } from 'zod';
import { acknowledgeLocalReports, offerMessagesForCaller, persistCriticalSwarmNow, requestWorkerBootstraps,
  requestWorkerRevivals, stageMessages, statusForCaller, type Caller } from './agents.js';
import { acceptAgentMutation, measureSleepingWorkers, spawnAgentWorkers } from './agent-admission.js';
import { effectiveCapabilities, getConfig } from './config.js';
import { RequestError } from './control-reads.js';
import { projectWorkspace } from './projects.js';
import { redactSecretText } from './redaction.js';
import { findSessionByConversation } from './session/store.js';

const uuid = z.string().uuid().refine(value => value === value.toLowerCase());
const routePattern = /^\/v1\/workers\/([0-9a-f-]{36})(?:\/(spawn|message|reports|ack))?$/;
const run = { runId: uuid.optional() };
const spawnBody = z.object({ ...run, projectId: uuid.optional(), context: z.string().max(4000).optional(),
  workers: z.array(z.object({ label: z.string().trim().min(1).max(60).optional(), task: z.string().trim().min(1).max(4000) }).strict()).min(1).max(8) }).strict();
const messageBody = z.object({ ...run, messages: z.array(z.object({ to: z.string().regex(/^worker-[1-9][0-9]{0,5}$/),
  text: z.string().trim().min(1).max(4000), label: z.string().trim().min(1).max(60).optional() }).strict()).min(1).max(16) }).strict();
const ackBody = z.object({ ...run, messageIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).min(1).max(128) }).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RequestError(400, 'invalid_body');
  return result.data;
}

function callerFor(route: string): { caller: Caller; action: string | undefined } | null {
  const match = routePattern.exec(route);
  if (!match) return null;
  return { caller: { localOwnerId: parse(uuid, match[1]), setupProfileId: getConfig().tunnel.profileId ?? 'default' }, action: match[2] };
}

function enabled(): void {
  const config = getConfig();
  if (!config.controlApi.enabled || !config.controlApi.allowActions) throw new RequestError(403, 'actions_disabled');
  if (!config.multiAgent.enabled) throw new RequestError(403, 'workers_disabled');
}

async function status(caller: Caller) {
  await measureSleepingWorkers(caller);
  enabled();
  const current = statusForCaller(caller);
  const workers = [];
  for (const worker of current.state.agents.filter(agent => agent.role === 'worker')) {
    const session = worker.conversationId ? await findSessionByConversation(worker.conversationId, { requireUnique: true }) : null;
    enabled();
    workers.push({ id: worker.id, runId: worker.runId ?? null, label: worker.label, state: worker.state,
      conversationId: worker.conversationId, sessionId: session?.id ?? null, revivable: worker.revivable,
      pending: worker.pending, awaitingAck: worker.awaitingAck, contextTokens: worker.contextTokens });
  }
  return { runId: current.runId, freeWorkerSlots: current.freeWorkerSlots, retainedHistory: current.state.retainedHistory === true, workers };
}

/** Reads are owner-scoped broker projections, including parked history. Reports need explicit receipts. */
export async function serveWorkerRead(route: string, params: URLSearchParams): Promise<unknown | undefined> {
  const selected = callerFor(route);
  if (!selected || (selected.action !== undefined && selected.action !== 'reports')) return undefined;
  enabled();
  const query: Record<string, string> = Object.create(null);
  for (const [key, value] of params) {
    if (Object.hasOwn(query, key)) throw new RequestError(400, 'invalid_query');
    query[key] = value;
  }
  const result = z.object(run).strict().safeParse(query);
  if (!result.success) throw new RequestError(400, 'invalid_query');
  const caller = { ...selected.caller, ...result.data };
  if (!selected.action) return status(caller);
  statusForCaller(caller); // Reject foreign/unknown run selection before any inbox offer.
  const offered = offerMessagesForCaller(caller)?.messages ?? [];
  return { messages: offered.map(message => ({ id: message.id, runId: message.runId ?? caller.runId ?? null,
    from: message.from, time: message.time, text: redactSecretText(message.text) })) };
}

export async function serveWorkerAction(method: string, route: string, raw: unknown, authorize: () => void) {
  const selected = callerFor(route);
  if (method !== 'POST' || !selected || !['spawn', 'message', 'ack'].includes(selected.action ?? '')) return undefined;
  enabled();
  const authorizeCurrent = () => {
    authorize();
    enabled();
    if ((getConfig().tunnel.profileId ?? 'default') !== selected.caller.setupProfileId) throw new RequestError(409, 'connection_profile_changed');
  };
  authorizeCurrent();
  if (selected.action === 'spawn') {
    const body = parse(spawnBody, raw);
    const caller = { ...selected.caller, runId: body.runId };
    const roots = JSON.stringify(getConfig().roots);
    const workspace = body.projectId ? await projectWorkspace(body.projectId) : null;
    const result = await spawnAgentWorkers(
      { caller, context: body.context, workers: body.workers }, async () => workspace,
      () => {
        const caps = effectiveCapabilities(getConfig());
        return caps.command && caps.create && caps.edit;
      }, {
        workspace,
        assertCurrent: () => {
          authorizeCurrent();
          if (workspace && JSON.stringify(getConfig().roots) !== roots) throw new RequestError(409, 'project_roots_changed');
        },
        validate: async () => { if (body.projectId) await projectWorkspace(body.projectId); }
      });
    requestWorkerBootstraps(result.created.map(worker => worker.id), result.runId);
    return { status: 202, body: { runId: result.runId, workers: result.created.map(worker => ({ id: worker.id, label: worker.label, state: worker.state })),
      notes: [...result.defaultNotes ?? [], ...result.isolationNotes] } };
  }
  if (selected.action === 'message') {
    const body = parse(messageBody, raw);
    const caller = { ...selected.caller, runId: body.runId };
    await measureSleepingWorkers(caller);
    authorizeCurrent();
    const staged = stageMessages(caller, body.messages);
    await acceptAgentMutation(staged, 'Worker message admission failed.', undefined, { validate: async () => undefined, assertCurrent: authorizeCurrent });
    requestWorkerRevivals(staged.waking, staged.runId);
    return { status: 202, body: { runId: staged.runId, queued: staged.messages.map(message => ({ id: message.id, to: message.to })), waking: staged.waking } };
  }
  const body = parse(ackBody, raw);
  authorizeCurrent();
  const acknowledged = acknowledgeLocalReports({ ...selected.caller, runId: body.runId }, body.messageIds);
  if (!(await persistCriticalSwarmNow())) throw new RequestError(503, 'broker_persistence_failed');
  return { status: 200, body: { acknowledged: acknowledged.map(message => message.id) } };
}
