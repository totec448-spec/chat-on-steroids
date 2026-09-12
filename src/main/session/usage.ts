import { z } from 'zod';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { listUsageSessions, readEvents } from './store.js';
import { readDurable, writeDurableSoon } from '../durable.js';
import { logInfo } from '../logger.js';
import { eventTokens } from '../../shared/session.js';
import { usageModelKey, type ModelUsage, type UsageModelTokens, type UsageOverview } from '../../shared/usage.js';
import { getChatModels } from '../chat-models.js';
import { isProModel } from '../../shared/chat-models.js';
const row = z.object({ model: z.string().min(1).max(100), scope: z.enum(['model', 'feature', 'shared']), remaining: z.number().finite().nonnegative().nullable(), remainingPercent: z.number().min(0).max(100).nullable(), resetAt: z.number().finite().positive().nullable(), windowSeconds: z.number().finite().positive().nullable() });
let limits: ModelUsage[] = [];
let latestObservedAt = 0;
const FRESH_MS = 10 * 60000;
export function observeUsage(raw: unknown, capturedAt: unknown = Date.now()): void {
  const parsed = z.array(row).max(80).parse(raw);
  const now = Date.now();
  if (typeof capturedAt !== 'number' || !Number.isFinite(capturedAt) || capturedAt > now + 5000 || now - capturedAt > FRESH_MS || capturedAt < latestObservedAt) return;
  // A snapshot is one account observation. Never merge old counters from another
  // account/tab into the latest response; an explicit empty snapshot clears them.
  latestObservedAt = capturedAt;
  limits = parsed.map((entry) => ({ ...entry, observedAt: capturedAt }));
}
// One persisted derived cache owns both daily and model totals. Formula edits project
// this baseline; only changed canonical session revisions reread transcripts.
const CACHE_VERSION = 6;
const modelTokens = z.object({ model: z.string().min(1).max(100), reasoningEffort: z.string().max(100).nullable(), assumed: z.boolean(), tokens: z.number().finite().nonnegative() });
const cacheRow = z.object({ id: z.string().max(64), revision: z.string().max(200), days: z.array(z.tuple([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.array(modelTokens)])).max(36600) });
const cacheSchema = z.object({ version: z.literal(CACHE_VERSION), rows: z.array(cacheRow).max(100000) });
const dayCache = new Map<string, { revision: string; days: Map<string, UsageModelTokens[]> }>();
let cacheLoaded = false;
let overviewFlight: Promise<UsageOverview> | null = null;
export function usageOverview(signal?: AbortSignal): Promise<UsageOverview> {
  return overviewFlight ??= computeOverview(signal).finally(() => { overviewFlight = null; });
}
function mergeModels(target: Map<string, UsageModelTokens>, rows: readonly UsageModelTokens[]): void {
  for (const row of rows) {
    const key = usageModelKey(row);
    const previous = target.get(key);
    target.set(key, { ...row, tokens: (previous?.tokens ?? 0) + row.tokens });
  }
}
type Attribution = Pick<UsageModelTokens, 'model' | 'reasoningEffort' | 'assumed'>;
const LEGACY: Attribution = { model: 'gpt-5.6', reasoningEffort: 'high', assumed: true };
function attribution(raw: { model?: string; reasoningEffort?: string }, previous: Attribution): Attribution {
  const model = raw.model?.trim();
  const effort = raw.reasoningEffort?.trim();
  if (model) return { model, reasoningEffort: effort || (!previous.assumed && model === previous.model ? previous.reasoningEffort : null), assumed: false };
  if (effort) return { ...previous, reasoningEffort: effort };
  return previous;
}
async function computeOverview(signal?: AbortSignal): Promise<UsageOverview> {
  signal?.throwIfAborted();
  const started = performance.now();
  // One observed Pro choice raises the comparison ceiling for the whole account,
  // including ordinary models. Read existing catalog evidence without discovery.
  const contextTokenCap = getChatModels().models.some(model => isProModel(model.id) || model.efforts.includes('pro')) ? 400_000 : 256_000;
  let rebuilt = 0;
  if (!cacheLoaded) {
    const saved = cacheSchema.safeParse(await readDurable('usage-cache'));
    if (saved.success) for (const row of saved.data.rows) dayCache.set(row.id, { revision: row.revision, days: new Map(row.days) });
    cacheLoaded = true;
  }
  const sessions = await listUsageSessions();
  let dirty = false;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const days = new Map<string, Map<string, UsageModelTokens>>();
  const models = new Map<string, UsageModelTokens>();
  for (const session of sessions) {
    signal?.throwIfAborted();
    const revision = `${contextTokenCap}:${timezone}:${session.updatedAt}:${session.events}:${session.estimatedTokens}`;
    let cached = dayCache.get(session.id);
    if (cached?.revision !== revision) {
      // Startup and the Usage page share this one flight. Read only one changed
      // session at a time, giving interactive work a turn before each disk read.
      await yieldToEventLoop(undefined, { signal });
      rebuilt++;
      const perDay = new Map<string, Map<string, UsageModelTokens>>();
      let context = 0;
      let conversation: string | null = null;
      let selected = LEGACY;
      const calls: Array<{ day: string; attribution: Attribution }> = [];
      const countedCalls = new Set<string>();
      const finishSegment = () => {
        // Cap each frontend before the baseline divisor and call aggregation.
        // Model switches divide attribution, never the frontend context.
        const billingContext = Math.min(context, contextTokenCap);
        for (const call of calls) {
          const totals = perDay.get(call.day) ?? new Map<string, UsageModelTokens>();
          mergeModels(totals, [{ ...call.attribution, tokens: billingContext / 2 }]);
          perDay.set(call.day, totals);
        }
        calls.length = 0; context = 0; selected = LEGACY;
      };
      const events = await readEvents(session.id);
      signal?.throwIfAborted();
      for (const event of events) {
        if (event.kind === 'session_start') { finishSegment(); conversation = event.conversationId; }
        if (event.kind === 'tool_call') {
          if (countedCalls.has(event.call.callId)) continue;
          countedCalls.add(event.call.callId);
          if (!event.call.conversationId || (conversation && conversation !== event.call.conversationId)) finishSegment();
          conversation = event.call.conversationId;
        }
        // Recorded selection belongs to this frontend history, never a mutable
        // global picker or a worker's requested-but-unconfirmed spawn setting.
        if (event.kind === 'user_message' && !event.messageId?.startsWith('input:')) selected = LEGACY;
        if (event.kind !== 'user_message' || !event.messageId?.startsWith('input:')) selected = attribution(event, selected);
        context += eventTokens(event);
        if (event.kind !== 'tool_call') continue;
        const date = new Date(event.time);
        const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        calls.push({ day, attribution: attribution(event.call, selected) });
        if (!conversation) finishSegment();
      }
      finishSegment();
      dirty = true;
      cached = { revision, days: new Map([...perDay].map(([day, values]) => [day, [...values.values()]])) }; dayCache.set(session.id, cached);
    }
    for (const [date, rows] of cached.days) {
      const totals = days.get(date) ?? new Map<string, UsageModelTokens>();
      mergeModels(totals, rows); days.set(date, totals); mergeModels(models, rows);
    }
  }
  const ids = new Set(sessions.map((session) => session.id));
  signal?.throwIfAborted();
  for (const id of dayCache.keys()) if (!ids.has(id)) { dayCache.delete(id); dirty = true; }
  if (dirty) writeDurableSoon('usage-cache', { version: CACHE_VERSION, rows: [...dayCache].map(([id, row]) => ({ id, revision: row.revision, days: [...row.days] })) });
  logInfo(`usage overview sessions=${sessions.length} reused=${sessions.length - rebuilt} rebuilt=${rebuilt} elapsed_ms=${Math.round(performance.now() - started)}`);
  return {
    contextTokenCap,
    limits: limits.filter((entry) => Date.now() - entry.observedAt <= FRESH_MS && (entry.resetAt === null || entry.resetAt > Date.now())).map((entry) => ({ ...entry })),
    days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, rows]) => ({ date, tokens: [...rows.values()].reduce((sum, row) => sum + row.tokens, 0), models: [...rows.values()] })),
    models: [...models.values()], tokens: [...models.values()].reduce((sum, row) => sum + row.tokens, 0), sessions: sessions.length
  };
}
