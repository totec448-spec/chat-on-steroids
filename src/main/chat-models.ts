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
  error: z.enum(['picker_unavailable', 'picker_close_failed', 'model_unconfirmed', 'power_unknown', 'power_unconfirmed', 'power_changed', 'restore_failed', 'inspection_failed']).optional(),
  models: z.array(z.object({
    id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/),
    label: z.string().trim().min(1).max(80),
    efforts: z.array(z.enum(REASONING_EFFORTS)).max(REASONING_EFFORTS.length),
    aliases: z.array(z.string().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/)).max(20).optional()
  }).strict()).min(1).max(20).nullable()
}).strict();
const progress = z.object({
  nonce: z.string().uuid(),
  waiting: z.enum(['generating', 'input_busy', 'draft', 'attachments', 'composer_missing', 'composer_hidden',
    'inspection_busy', 'page_unreachable', 'page_changed', 'opening', 'inspecting', 'inspection_failed', 'result_unconfirmed'])
}).strict();
const waitingReasons: Record<z.infer<typeof progress>['waiting'], string> = {
  generating: 'ChatGPT is still generating. The running response is left untouched.',
  input_busy: 'Waiting for the current browser input operation to finish.',
  draft: 'An unsent browser draft is protected. Discovery needs an empty composer.',
  attachments: 'Browser attachments are protected. Discovery needs an empty composer.',
  composer_missing: 'Waiting for the ChatGPT composer to finish loading.',
  composer_hidden: 'The ChatGPT composer is hidden. Close native settings or dialogs to use this tab.',
  inspection_busy: 'The native model picker is already being inspected.',
  page_unreachable: 'The browser companion has not answered the page readiness check.',
  page_changed: 'The discovery page changed or closed. Retry to start a new inspection.',
  opening: 'Opening one separate discovery page. Existing chats are left untouched.',
  inspecting: 'Reading the native model versions and restoring the original selection.',
  inspection_failed: 'The browser model inspection did not complete.',
  result_unconfirmed: 'The model inspection returned without an accepted catalog.'
};
let lastProblem: string | null = null;
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
  catalog = { ...catalog, state: catalog.models.length ? 'ready' : 'unavailable', waiting: undefined, error };
}
export function configureChatModelDiscovery(options: { changed: () => void; wake: (nonce: string, allowOpen: boolean) => Promise<void> }): void { changed = options.changed; wake = options.wake; }
function scheduleDeadline(at: number): void {
  if (deadline) clearTimeout(deadline);
  deadline = setTimeout(() => { deadline = null; expire(); changed(); wakeBrowserWork(); }, Math.max(0, at - Date.now()));
  deadline.unref?.();
}
function expire(): void {
  if (request && Date.now() >= request.expiresAt) {
    logInfo(`model discovery expired id=${request.nonce}`); request = null;
    failed(`Model discovery timed out. ${lastProblem ?? catalog.waiting ?? 'Check the browser companion and the signed-in ChatGPT page, then retry.'}`);
  }
}
export function getChatModels(): ChatModelCatalog {
  expire(); return structuredClone(catalog);
}
export function requestChatModels(allowOpen = true): ChatModelCatalog {
  expire();
  if (!request) {
    const now = Date.now(); request = { nonce: randomUUID(), expiresAt: now + 120000, allowOpen };
    logInfo(`model discovery requested id=${request.nonce}`);
    lastProblem = null;
    catalog = { ...catalog, state: 'pending', requestedAt: now, waiting: undefined, error: undefined };
    scheduleDeadline(request.expiresAt);
    changed();
    wakeBrowserWork();
  } else if (allowOpen && !request.allowOpen) {
    // Explicit refresh promotes the existing nonce once. Time spent waiting for the
    // companion during passive startup must not consume the user's inspection budget.
    request.allowOpen = true;
    request.expiresAt = Date.now() + 120000;
    scheduleDeadline(request.expiresAt);
    changed();
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
        // Wake dispatch is separate from the exact model_catalog completion receipt.
        logInfo(`model discovery browser wake dispatched id=${nonce}`);
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
  expire();
  const pending = progress.safeParse(raw);
  if (pending.success) {
    if (!request || pending.data.nonce !== request.nonce) return false;
    const waiting = waitingReasons[pending.data.waiting];
    if (!['opening', 'inspecting'].includes(pending.data.waiting)) lastProblem = waiting;
    if (catalog.waiting !== waiting) {
      catalog = { ...catalog, waiting };
      logInfo(`model discovery waiting id=${request.nonce} reason=${pending.data.waiting}`);
      changed();
    }
    return true;
  }
  const parsed = observation.safeParse(raw);
  if (!parsed.success || !request || parsed.data.nonce !== request.nonce) return false;
  const models = parsed.data.models;
  if (models && (new Set(models.map(model => model.id)).size !== models.length ||
    models.some(model => new Set(model.efforts).size !== model.efforts.length))) return false;
  logInfo(`model discovery observed id=${request.nonce} models=${models?.length ?? 0} elapsed_ms=${Date.now() - (catalog.requestedAt ?? Date.now())} error=${parsed.data.error ?? 'none'}`);
  const error = parsed.data.error === 'picker_unavailable'
    ? 'ChatGPT\'s native model picker could not be read. Check the loaded ChatGPT page in the selected browser, close native dialogs, then retry.'
    : parsed.data.error === 'restore_failed' ? 'The original ChatGPT model selection could not be restored. Check the native picker before retrying.'
    : parsed.data.error === 'picker_close_failed' ? 'The native ChatGPT model picker did not close. Close it before retrying.'
    : 'ChatGPT model choices could not be confirmed. Check the native picker in the selected browser, then retry.';
  if (models) {
    catalog = { ...catalog, state: 'ready', models, observedAt: Date.now(), waiting: undefined, error: undefined };
    writeDurableSoon('chat-models', { observedAt: catalog.observedAt, models });
  } else failed(error);
  request = null;
  if (deadline) clearTimeout(deadline); deadline = null;
  changed(); wakeBrowserWork(); return true;
}
export function resetChatModelsForTests(): void {
  if (deadline) clearTimeout(deadline); deadline = null; launch = null;
  request = null; lastProblem = null; catalog = { state: 'unknown', requestedAt: null, observedAt: null, models: [] };
}
