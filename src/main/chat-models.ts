import { REASONING_EFFORTS } from '../shared/session.js';
/** Successful account choices survive restart; request/opening authority never does. */
import { randomUUID } from 'node:crypto';
import { wakeBrowserWork } from './browser-wake.js';
import { z } from 'zod';
import { logInfo } from './logger.js';
import type { ChatModelCatalog, GeminiModelCatalog } from '../shared/chat-models.js';
import { readDurable, writeDurableSoon } from './durable.js';

const chatgptObservation = z.object({
  provider: z.literal('chatgpt').optional(),
  nonce: z.string().uuid(),
  error: z.enum(['picker_unavailable', 'picker_close_failed', 'model_unconfirmed', 'power_unknown', 'power_unconfirmed', 'power_changed', 'restore_failed', 'inspection_failed']).optional(),
  models: z.array(z.object({
    id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/),
    label: z.string().trim().min(1).max(80),
    efforts: z.array(z.enum(REASONING_EFFORTS)).max(REASONING_EFFORTS.length),
    aliases: z.array(z.string().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/)).max(20).optional()
  }).strict()).min(1).max(20).nullable()
}).strict();

const geminiObservation = z.object({
  provider: z.literal('gemini'),
  nonce: z.string().uuid(),
  error: z.enum(['picker_unavailable', 'picker_close_failed', 'model_unconfirmed', 'restore_failed', 'inspection_failed']).optional(),
  models: z.array(z.object({
    id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/),
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(160).optional()
  }).strict()).min(1).max(20).nullable()
}).strict();

const WAITING_CODES = ['generating', 'input_busy', 'draft', 'attachments', 'composer_missing', 'composer_hidden',
  'inspection_busy', 'page_unreachable', 'page_changed', 'opening', 'inspecting', 'inspection_failed', 'result_unconfirmed', 'picker_unreadable'] as const;

type WaitingCode = (typeof WAITING_CODES)[number];

const progress = z.object({
  provider: z.enum(['chatgpt', 'gemini']).optional(),
  nonce: z.string().uuid(),
  waiting: z.enum(WAITING_CODES)
}).strict();

function waitingReasonsFor(brand: 'ChatGPT' | 'Gemini'): Record<WaitingCode, string> {
  return {
    generating: `${brand} is still generating. The running response is left untouched.`,
    input_busy: 'Waiting for the current browser input operation to finish.',
    draft: 'An unsent browser draft is protected. Discovery needs an empty composer.',
    attachments: 'Browser attachments are protected. Discovery needs an empty composer.',
    composer_missing: `Waiting for the ${brand} composer to finish loading.`,
    composer_hidden: `The ${brand} composer is hidden. Close native settings or dialogs to use this tab.`,
    inspection_busy: 'The native model picker is already being inspected.',
    page_unreachable: 'The browser extension has not answered the page readiness check.',
    page_changed: 'The discovery page changed or closed. Retry to start a new inspection.',
    opening: 'Opening one separate discovery page. Existing chats are left untouched.',
    inspecting: 'Reading the native model versions and restoring the original selection.',
    inspection_failed: 'The browser model inspection did not complete.',
    result_unconfirmed: 'The model inspection returned without an accepted catalog.',
    picker_unreadable: 'The open chats show no readable model picker. Refresh opens a separate discovery page.'
  };
}

type ModelCatalogLike<TOption> = {
  state: 'unknown' | 'pending' | 'ready' | 'unavailable';
  requestedAt: number | null;
  observedAt: number | null;
  models: TOption[];
  waiting?: string;
  error?: string;
};

type DiscoveryConfig<TOption> = {
  brand: 'ChatGPT' | 'Gemini';
  logPrefix: string;
  durableKey: string;
  observationSchema: z.ZodType<{ nonce: string; error?: string; models: TOption[] | null }>;
  validModels: (models: TOption[]) => boolean;
  progressMatches: (parsed: z.infer<typeof progress>) => boolean;
};

function createModelDiscovery<TOption, TCatalog extends ModelCatalogLike<TOption>>(config: DiscoveryConfig<TOption>) {
  const waitingReasons = waitingReasonsFor(config.brand);
  const { brand, logPrefix, durableKey, observationSchema, validModels, progressMatches } = config;
  let lastProblem: string | null = null;
  let catalog: ModelCatalogLike<TOption> = { state: 'unknown', requestedAt: null, observedAt: null, models: [] };
  let request: { nonce: string; expiresAt: number; allowOpen: boolean } | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let launch: { nonce: string; allowOpen: boolean; work: Promise<void> } | null = null;
  let changed = (): void => {};
  let wake: ((nonce: string, allowOpen: boolean) => Promise<void>) | null = null;
  const unofferedAsked = new Set<string>();

  function failed(error: string): void {
    catalog = { ...catalog, state: catalog.models.length ? 'ready' : 'unavailable', waiting: undefined, error };
  }

  function expire(): void {
    if (request && Date.now() >= request.expiresAt) {
      logInfo(`${logPrefix} expired id=${request.nonce}`); request = null;
      failed(`Model discovery timed out. ${lastProblem ?? catalog.waiting ?? `Check the browser extension and the signed-in ${brand} page, then retry.`}`);
    }
  }

  function scheduleDeadline(at: number): void {
    if (deadline) clearTimeout(deadline);
    deadline = setTimeout(() => { deadline = null; expire(); changed(); wakeBrowserWork(); }, Math.max(0, at - Date.now()));
    deadline.unref?.();
  }

  function get(): TCatalog {
    expire(); return structuredClone(catalog) as TCatalog;
  }

  function req(allowOpen = true): TCatalog {
    expire();
    if (!request) {
      const now = Date.now(); request = { nonce: randomUUID(), expiresAt: now + 120000, allowOpen };
      logInfo(`${logPrefix} requested id=${request.nonce}`);
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
    return get();
  }

  return {
    async restore(): Promise<void> {
      const modelsSchema = (observationSchema as unknown as { shape: { models: z.ZodNullable<z.ZodType<TOption[]>> } }).shape.models.unwrap();
      const saved = z.object({ observedAt: z.number().finite().positive(), models: modelsSchema }).strict().safeParse(await readDurable(durableKey));
      if (!saved.success || request || catalog.state !== 'unknown') return;
      const models = saved.data.models;
      if (!validModels(models)) return;
      catalog = { state: 'ready', requestedAt: null, observedAt: saved.data.observedAt, models };
    },
    configure(options: { changed: () => void; wake: (nonce: string, allowOpen: boolean) => Promise<void> }): void {
      changed = options.changed; wake = options.wake;
    },
    get,
    request: req,
    async start(allowOpen = true): Promise<TCatalog> {
      // Showing an existing app window is neither a refresh nor permission to open Chrome.
      if (!allowOpen && catalog.state !== 'unknown') return get();
      req(allowOpen);
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
            logInfo(`${logPrefix} browser wake dispatched id=${nonce}`);
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
      return get();
    },
    refreshForUnoffered(saved: string): void {
      if (catalog.observedAt === null || unofferedAsked.has(saved)) return;
      unofferedAsked.add(saved);
      req(false);
    },
    pending(): { nonce: string; expiresAt: number; allowOpen: boolean } | null {
      expire(); return request ? { ...request } : null;
    },
    observe(raw: unknown): boolean {
      expire();
      const pending = progress.safeParse(raw);
      if (pending.success && progressMatches(pending.data)) {
        if (!request || pending.data.nonce !== request.nonce) return false;
        const waiting = waitingReasons[pending.data.waiting];
        if (!['opening', 'inspecting'].includes(pending.data.waiting)) lastProblem = waiting;
        if (catalog.waiting !== waiting) {
          catalog = { ...catalog, waiting };
          logInfo(`${logPrefix} waiting id=${request.nonce} reason=${pending.data.waiting}`);
          changed();
        }
        return true;
      }
      const parsed = observationSchema.safeParse(raw);
      if (!parsed.success || !request || parsed.data.nonce !== request.nonce) return false;
      const models = parsed.data.models;
      if (models && !validModels(models)) return false;
      logInfo(`${logPrefix} observed id=${request.nonce} models=${models?.length ?? 0} elapsed_ms=${Date.now() - (catalog.requestedAt ?? Date.now())} error=${parsed.data.error ?? 'none'}`);
      const error = parsed.data.error === 'picker_unavailable'
        ? `${brand}'s native model picker could not be read. Check the loaded ${brand} page in the selected browser, close native dialogs, then retry.`
        : parsed.data.error === 'restore_failed' ? `The original ${brand} model selection could not be restored. Check the native picker before retrying.`
        : parsed.data.error === 'picker_close_failed' ? `The native ${brand} model picker did not close. Close it before retrying.`
        : `${brand} model choices could not be confirmed. Check the native picker in the selected browser, then retry.`;
      if (models) {
        catalog = { ...catalog, state: 'ready', models, observedAt: Date.now(), waiting: undefined, error: undefined };
        writeDurableSoon(durableKey, { observedAt: catalog.observedAt, models });
      } else failed(error);
      request = null;
      if (deadline) clearTimeout(deadline); deadline = null;
      changed(); wakeBrowserWork(); return true;
    },
    resetForTests(): void {
      if (deadline) clearTimeout(deadline); deadline = null; launch = null;
      request = null; lastProblem = null; unofferedAsked.clear();
      catalog = { state: 'unknown', requestedAt: null, observedAt: null, models: [] };
    }
  };
}

const chatgpt = createModelDiscovery<ChatModelCatalog['models'][number], ChatModelCatalog>({
  brand: 'ChatGPT',
  logPrefix: 'model discovery',
  durableKey: 'chat-models',
  observationSchema: chatgptObservation,
  validModels: models => new Set(models.map(model => model.id)).size === models.length &&
    !models.some(model => new Set(model.efforts).size !== model.efforts.length),
  progressMatches: parsed => parsed.provider !== 'gemini'
});

const gemini = createModelDiscovery<GeminiModelCatalog['models'][number], GeminiModelCatalog>({
  brand: 'Gemini',
  logPrefix: 'gemini model discovery',
  durableKey: 'gemini-models',
  observationSchema: geminiObservation,
  validModels: models => new Set(models.map(model => model.id)).size === models.length,
  progressMatches: parsed => parsed.provider === 'gemini'
});

export const restoreChatModels = chatgpt.restore;
export const configureChatModelDiscovery = chatgpt.configure;
export const getChatModels = chatgpt.get;
export const requestChatModels = chatgpt.request;
export const startChatModelDiscovery = chatgpt.start;
/**
 * A choice saved in Settings that the stored catalog does not offer may be newer than the catalog:
 * a restored catalog is never observed again on its own, so one saved before a rollout hid the new
 * model for good. Asks an already open ChatGPT page, never a new browser, once per saved choice; a
 * fresh catalog that still lacks it is the account's answer, not a reason to ask again.
 */
export const refreshForUnoffered = chatgpt.refreshForUnoffered;
export const pendingChatModelRequest = chatgpt.pending;
export const observeChatModels = chatgpt.observe;
export const resetChatModelsForTests = chatgpt.resetForTests;

export const restoreGeminiModels = gemini.restore;
export const configureGeminiModelDiscovery = gemini.configure;
export const getGeminiModels = gemini.get;
export const requestGeminiModels = gemini.request;
export const startGeminiModelDiscovery = gemini.start;
export const refreshGeminiForUnoffered = gemini.refreshForUnoffered;
export const pendingGeminiModelRequest = gemini.pending;
export const observeGeminiModels = gemini.observe;
export const resetGeminiModelsForTests = gemini.resetForTests;
