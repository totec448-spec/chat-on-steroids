import { REASONING_EFFORTS } from '../shared/session.js';
/** Successful account choices survive restart; request/opening authority never does. */
import { randomUUID } from 'node:crypto';
import { wakeBrowserWork } from './browser-wake.js';
import { z } from 'zod';
import { logInfo } from './logger.js';
import type { ChatModelCatalog } from '../shared/chat-models.js';
import { readDurable, writeDurableSoon } from './durable.js';
const observation = z.object({
  nonce: z.string().uuid(),
  error: z.enum(['picker_unavailable', 'model_unconfirmed', 'power_unknown', 'power_unconfirmed', 'power_changed', 'restore_failed', 'inspection_failed']).optional(),
  models: z.array(z.object({
    id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/),
    label: z.string().trim().min(1).max(80),
    efforts: z.array(z.enum(REASONING_EFFORTS)).max(REASONING_EFFORTS.length),
    aliases: z.array(z.string().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/)).max(20).optional()
  }).strict()).min(1).max(20).nullable()
}).strict();
let catalog: ChatModelCatalog = { state: 'unknown', requestedAt: null, observedAt: null, models: [] };
let request: { nonce: string; expiresAt: number; allowOpen: boolean } | null = null;
let deadline: ReturnType<typeof setTimeout> | null = null;
let launch: { nonce: string; allowOpen: boolean; work: Promise<void> } | null = null;
let changed = (): void => {};
let wake: ((nonce: string, allowOpen: boolean) => Promise<void>) | null = null;
export async function restoreChatModels(): Promise<void> {
  const saved = z.object({ observedAt: z.number().finite().positive(), models: observation.shape.models.unwrap() }).strict().safeParse(await readDurable('chat-models'));
  if (!saved.success || request || catalog.state !== 'unknown') return;
  const models = saved.data.models;
  if (new Set(models.map(model => model.id)).size !== models.length || models.some(model => new Set(model.efforts).size !== model.efforts.length)) return;
  catalog = { state: 'ready', requestedAt: null, observedAt: saved.data.observedAt, models };
}
function failed(error: string): void {
  catalog = { ...catalog, state: catalog.models.length ? 'ready' : 'unavailable', error };
}
export function configureChatModelDiscovery(options: { changed: () => void; wake: (nonce: string, allowOpen: boolean) => Promise<void> }): void { changed = options.changed; wake = options.wake; }
function scheduleDeadline(at: number): void {
  if (deadline) clearTimeout(deadline);
  deadline = setTimeout(() => { deadline = null; expire(); changed(); wakeBrowserWork(); }, Math.max(0, at - Date.now()));
  deadline.unref?.();
}
function expire(): void {
  if (request && Date.now() >= request.expiresAt) { logInfo(`model discovery expired id=${request.nonce}`); request = null; failed('Model discovery timed out. Check ChatGPT is signed in, then retry.'); }
}
export function getChatModels(): ChatModelCatalog {
  expire(); return structuredClone(catalog);
}
export function requestChatModels(allowOpen = true): ChatModelCatalog {
  expire();
  if (!request) {
    const now = Date.now(); request = { nonce: randomUUID(), expiresAt: now + 120000, allowOpen };
    logInfo(`model discovery requested id=${request.nonce}`);
    catalog = { ...catalog, state: 'pending', requestedAt: now, error: undefined };
    scheduleDeadline(request.expiresAt);
    changed();
    wakeBrowserWork();
  } else if (allowOpen && !request.allowOpen) {
    // Explicit refresh promotes the existing nonce; it cannot create a competing request.
    request.allowOpen = true;
    wakeBrowserWork();
  }
  return getChatModels();
}
/** An explicit UI request starts only the local browser bridge, never MCP/tunnel exposure. */
export async function startChatModelDiscovery(allowOpen = true): Promise<ChatModelCatalog> {
  // Showing an existing app window is neither a refresh nor permission to open Chrome.
  if (!allowOpen && catalog.state !== 'unknown') return getChatModels();
  requestChatModels(allowOpen);
  const nonce = request!.nonce;
  if (!launch || launch.nonce !== nonce || (request!.allowOpen && !launch.allowOpen)) {
    const previous = launch?.nonce === nonce ? launch.work : null;
    const attempt = { nonce, allowOpen: request!.allowOpen, work: Promise.resolve() };
    const work = (async () => {
      try {
        if (previous) await previous;
        if (request?.nonce !== nonce) return;
        if (!wake) throw new Error('Model discovery is not ready');
        await wake(nonce, attempt.allowOpen);
        logInfo(`model discovery browser wake completed id=${nonce}`);
      }
      catch (error) {
        if (request?.nonce !== nonce) return;
        request = null;
        if (deadline) clearTimeout(deadline); deadline = null;
        failed(`${(error as Error).message}. Retry model discovery.`.slice(0, 240));
        changed(); wakeBrowserWork();
      }
    })();
    attempt.work = work;
    launch = attempt;
    void work.finally(() => { if (launch === attempt) launch = null; });
  }
  // The request deadline and observation own completion. OS wake is only dispatch;
  // an unresolved handoff must never hold the renderer's Refresh/Send promise.
  await Promise.resolve();
  return getChatModels();
}
export function pendingChatModelRequest(): { nonce: string; expiresAt: number; allowOpen: boolean } | null {
  expire(); return request ? { ...request } : null;
}
export function observeChatModels(raw: unknown): boolean {
  expire(); const parsed = observation.safeParse(raw);
  if (!parsed.success || !request || parsed.data.nonce !== request.nonce) return false;
  const models = parsed.data.models;
  if (models && (new Set(models.map(model => model.id)).size !== models.length ||
    models.some(model => new Set(model.efforts).size !== model.efforts.length))) return false;
  logInfo(`model discovery observed id=${request.nonce} models=${models?.length ?? 0} elapsed_ms=${Date.now() - (catalog.requestedAt ?? Date.now())} error=${parsed.data.error ?? 'none'}`);
  const error = parsed.data.error === 'picker_unavailable'
    ? 'ChatGPT\'s native model picker could not be read. If your account shows only Think and no model picker, model discovery is not supported for that interface yet.'
    : 'ChatGPT model choices could not be read. Open ChatGPT in the selected browser and check its model picker, then retry.';
  if (models) {
    catalog = { ...catalog, state: 'ready', models, observedAt: Date.now(), error: undefined };
    writeDurableSoon('chat-models', { observedAt: catalog.observedAt, models });
  } else failed(error);
  request = null;
  if (deadline) clearTimeout(deadline); deadline = null;
  changed(); wakeBrowserWork(); return true;
}
export function resetChatModelsForTests(): void {
  if (deadline) clearTimeout(deadline); deadline = null; launch = null;
  request = null; catalog = { state: 'unknown', requestedAt: null, observedAt: null, models: [] };
}
