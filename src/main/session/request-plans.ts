/**
 * Plans created before request-id attribution resolves.
 *
 * ChatGPT uses one request id for every connector call in a model turn. When unattributed
 * calls are allowed, that id is enough to preserve the turn's replaceable plan document until
 * the browser reports the exact durable session. The plan is never used as agent identity.
 */
import { agentPlanUpdateSchema, type AgentPlanUpdate } from '../../shared/agent-plan.js';
import { readDurable, writeDurableNow } from '../durable.js';
import { updateSessionPlan } from './store.js';
import type { RequestCorrelation } from './correlation.js';

const STATE_NAME = 'request-plans';
const STATE_VERSION = 1;
const MAX_PENDING_PLANS = 256;
const PLAN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface PendingRequestPlan {
  requestId: string;
  update: AgentPlanUpdate;
  startedAt: number;
  storedAt: number;
}

interface PersistedRequestPlans {
  version: number;
  entries: PendingRequestPlan[];
}

const pending = new Map<string, PendingRequestPlan>();
let loaded = false;
let queue: Promise<void> = Promise.resolve();

function serial<T>(run: () => Promise<T>): Promise<T> {
  const work = queue.then(run, run);
  queue = work.then(() => undefined, () => undefined);
  return work;
}

function validEntry(value: unknown): PendingRequestPlan | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<PendingRequestPlan>;
  if (typeof item.requestId !== 'string' || item.requestId.length < 1 || item.requestId.length > 200) return null;
  if (typeof item.startedAt !== 'number' || !Number.isFinite(item.startedAt) || item.startedAt < 0) return null;
  if (typeof item.storedAt !== 'number' || !Number.isFinite(item.storedAt) || item.storedAt < 0) return null;
  const update = agentPlanUpdateSchema.safeParse(item.update);
  return update.success ? { requestId: item.requestId, update: update.data, startedAt: item.startedAt, storedAt: item.storedAt } : null;
}

function prune(now = Date.now()): void {
  for (const [requestId, entry] of pending) {
    if (entry.storedAt < now - PLAN_TTL_MS) pending.delete(requestId);
  }
  while (pending.size > MAX_PENDING_PLANS) pending.delete(pending.keys().next().value!);
}

async function load(): Promise<void> {
  if (loaded) return;
  const saved = await readDurable<PersistedRequestPlans>(STATE_NAME);
  if (saved?.version === STATE_VERSION && Array.isArray(saved.entries)) {
    for (const raw of saved.entries.slice(-MAX_PENDING_PLANS)) {
      const entry = validEntry(raw);
      if (entry) pending.set(entry.requestId, entry);
    }
  }
  prune();
  loaded = true;
}

function snapshot(): PersistedRequestPlans {
  return {
    version: STATE_VERSION,
    entries: [...pending.values()].map(entry => ({
      ...entry,
      update: { ...entry.update, plan: entry.update.plan.map(step => ({ ...step })) }
    }))
  };
}

async function persist(): Promise<void> {
  await writeDurableNow(STATE_NAME, pending.size ? snapshot() : null);
}

/** Saves the newest complete plan for one request-scoped model turn. */
export function updateRequestPlan(requestId: string, input: AgentPlanUpdate, startedAt: number): Promise<boolean> {
  const update = agentPlanUpdateSchema.parse(input);
  return serial(async () => {
    await load();
    const previous = pending.get(requestId);
    if (previous && previous.startedAt > startedAt) return false;
    const before = new Map(pending);
    pending.delete(requestId);
    pending.set(requestId, { requestId, update, startedAt, storedAt: Date.now() });
    prune();
    try {
      await persist();
    } catch (error) {
      pending.clear();
      for (const [id, entry] of before) pending.set(id, entry);
      throw error;
    }
    return true;
  });
}

/** Applies and removes a pending request plan once exact request correlation exists. */
export function attachRequestPlan(
  owner: Pick<RequestCorrelation, 'requestId' | 'sessionId' | 'conversationId'>
): Promise<'missing' | 'attached' | 'stale'> {
  return serial(async () => {
    await load();
    const entry = pending.get(owner.requestId);
    if (!entry) return 'missing';
    const accepted = await updateSessionPlan(owner.sessionId, owner.conversationId, entry.update, entry.startedAt, { storedAt: entry.storedAt });
    pending.delete(owner.requestId);
    try {
      await persist();
    } catch (error) {
      pending.set(owner.requestId, entry);
      throw error;
    }
    return accepted ? 'attached' : 'stale';
  });
}

/** Reattaches durable pending plans after both registries are restored on app startup. */
export async function reconcileRequestPlans(
  resolve: (requestId: string) => RequestCorrelation | null
): Promise<void> {
  const ids = await serial(async () => {
    await load();
    return [...pending.keys()];
  });
  for (const requestId of ids) {
    const owner = resolve(requestId);
    if (owner) await attachRequestPlan(owner);
  }
}

export function resetRequestPlansForTests(): void {
  pending.clear();
  loaded = false;
  queue = Promise.resolve();
}
