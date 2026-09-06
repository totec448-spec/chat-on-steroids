import { REASONING_EFFORTS } from '../shared/session.js';
/** Read-only account picker observation. Process-local requests never revive after restart. */
import { randomUUID } from 'node:crypto';
import { wakeBrowserWork } from './browser-wake.js';
import { z } from 'zod';
import { logInfo } from './logger.js';
import type { ChatModelCatalog } from '../shared/chat-models.js';
const observation = z.object({
  nonce: z.string().uuid(),
  error: z.enum(['picker_unavailable', 'model_unconfirmed', 'power_unknown', 'power_unconfirmed', 'power_changed', 'restore_failed', 'inspection_failed']).optional(),
  models: z.array(z.object({
    id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/),
    label: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9 ._-]+$/),
    efforts: z.array(z.enum(REASONING_EFFORTS)).max(REASONING_EFFORTS.length)
  }).strict()).min(1).max(20).nullable()
}).strict();
let catalog: ChatModelCatalog = { state: 'unknown', requestedAt: null, observedAt: null, models: [] };
let request: { nonce: string; expiresAt: number } | null = null;
let deadline: ReturnType<typeof setTimeout> | null = null;
let launch: { nonce: string; work: Promise<void>; finished: boolean } | null = null;
let changed = (): void => {};
let wake: ((nonce: string) => Promise<void>) | null = null;
export function configureChatModelDiscovery(options: { changed: () => void; wake: (nonce: string) => Promise<void> }): void { changed = options.changed; wake = options.wake; }
function scheduleDeadline(at: number): void {
  if (deadline) clearTimeout(deadline);
  deadline = setTimeout(() => { deadline = null; expire(); changed(); wakeBrowserWork(); }, Math.max(0, at - Date.now()));
  deadline.unref?.();
}
function expire(): void {
  if (request && Date.now() >= request.expiresAt) { logInfo(`model discovery expired id=${request.nonce}`); request = null; catalog = { ...catalog, state: 'unavailable', models: [], error: 'Model discovery timed out. Check ChatGPT is signed in, then retry.' }; }
}
export function getChatModels(): ChatModelCatalog {
  expire(); return structuredClone(catalog);
}
export function requestChatModels(): ChatModelCatalog {
  expire();
  if (!request) {
    const now = Date.now(); request = { nonce: randomUUID(), expiresAt: now + 120000 };
    logInfo(`model discovery requested id=${request.nonce}`);
    catalog = { state: 'pending', requestedAt: now, observedAt: null, models: [] };
    scheduleDeadline(request.expiresAt);
    wakeBrowserWork();
  }
  return getChatModels();
}
/** An explicit UI request starts only the local browser bridge, never MCP/tunnel exposure. */
export async function startChatModelDiscovery(): Promise<ChatModelCatalog> {
  requestChatModels();
  const nonce = request!.nonce;
  if (!launch || (launch.finished && launch.nonce !== nonce)) {
    const attempt = { nonce, work: Promise.resolve(), finished: false };
    const work = (async () => {
      try { if (!wake) throw new Error('Model discovery is not ready'); await wake(nonce); logInfo(`model discovery browser wake completed id=${nonce}`); }
      catch (error) {
        if (request?.nonce !== nonce) return;
        request = null;
        if (deadline) clearTimeout(deadline); deadline = null;
        catalog = { ...catalog, state: 'unavailable', models: [], error: `${(error as Error).message}. Retry model discovery.`.slice(0, 240) };
        changed(); wakeBrowserWork();
      }
    })();
    attempt.work = work.finally(() => { attempt.finished = true; });
    launch = attempt;
  }
  await launch.work;
  return getChatModels();
}
export function pendingChatModelRequest(): { nonce: string; expiresAt: number } | null {
  expire(); return request ? { ...request } : null;
}
export function observeChatModels(raw: unknown): boolean {
  expire(); const parsed = observation.safeParse(raw);
  if (!parsed.success || !request || parsed.data.nonce !== request.nonce) return false;
  const models = parsed.data.models;
  if (models && (new Set(models.map(model => model.id)).size !== models.length ||
    models.some(model => new Set(model.efforts).size !== model.efforts.length))) return false;
  logInfo(`model discovery observed id=${request.nonce} models=${models?.length ?? 0} elapsed_ms=${Date.now() - (catalog.requestedAt ?? Date.now())} error=${parsed.data.error ?? 'none'}`);
  catalog = { ...catalog, state: models ? 'ready' : 'unavailable', models: models ?? [], observedAt: Date.now(), ...(models ? {} : { error: 'ChatGPT model choices could not be read. Check sign-in and retry.' }) };
  request = null;
  if (deadline) clearTimeout(deadline); deadline = null;
  changed(); wakeBrowserWork(); return true;
}
export function resetChatModelsForTests(): void {
  if (deadline) clearTimeout(deadline); deadline = null; launch = null;
  request = null; catalog = { state: 'unknown', requestedAt: null, observedAt: null, models: [] };
}
