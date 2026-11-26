import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { wakeBrowserWork } from './browser-wake.js';
import { getConfig } from './config.js';
import { logInfo } from './logger.js';

const reply = z.object({
  id: z.string().uuid(),
  conversationId: z.string().regex(/^[0-9a-f-]{8,64}$/i),
  title: z.string().trim().min(1).max(200).nullable(),
  reason: z.enum([
    'active-tab-mismatch', 'no-matching-tab', 'multiple-matching-tabs', 'tab-unavailable',
    'document-unregistered', 'document-changed', 'title-unconfirmed', 'page-unresponsive', 'browser-error',
    'title-changed', 'native-rename-unavailable', 'native-rename-unconfirmed', 'rename-canceled',
    'native-trigger-unavailable', 'native-menu-unavailable', 'native-editor-unavailable', 'native-input-rejected'
  ]).optional()
}).strict();

type NativeRename = { expectedTitle: string; title: string; expiresAt: number };

let pending: {
  request: { id: string; conversationId: string; rename?: NativeRename };
  browser: string | null;
  forRename: boolean;
  result: Promise<string | null>;
  canCommit?: () => Promise<boolean>;
  finish: (title: string | null, reason?: string) => void;
} | null = null;

/** An explicit, one-shot read from a paired browser. Nothing is stored or retried. */
export function readWebChatTitle(conversationId: string): Promise<string | null> {
  return requestWebChatTitle(conversationId, false);
}

export function captureWebChatTitleForRename(conversationId: string): Promise<string | null> {
  if (!enabled(true)) return Promise.resolve(null);
  if (pending && !pending.request.rename && pending.request.conversationId === conversationId) return pending.result;
  return requestWebChatTitle(conversationId, true);
}

export async function renameWebChatTitle(
  conversationId: string,
  expectedTitle: string,
  title: string,
  canCommit: () => Promise<boolean>
): Promise<boolean> {
  return await requestWebChatTitle(conversationId, true, { expectedTitle, title, expiresAt: Date.now() + 15_000 }, canCommit) === title;
}

function enabled(forRename: boolean): boolean {
  const settings = getConfig().sessions;
  return forRename ? settings.renameWebChatTitles === true : settings.checkWebChatTitles === true;
}

function requestWebChatTitle(conversationId: string, forRename: boolean, rename?: NativeRename, canCommit?: () => Promise<boolean>): Promise<string | null> {
  if (!enabled(forRename) || pending) {
    logInfo('web chat title: check skipped (disabled or a check is already pending)');
    return Promise.resolve(null);
  }
  let resolve!: (title: string | null) => void;
  const result = new Promise<string | null>(done => { resolve = done; });
  const request = { id: randomUUID(), conversationId, ...(rename ? { rename } : {}) };
  const timer = setTimeout(() => finish(null, 'timeout'), 15_000);
  timer.unref();
  const finish = (title: string | null, reason = 'unknown') => {
    clearTimeout(timer);
    pending = null;
    logInfo(rename
      ? title === rename.title ? 'web chat title: native rename confirmed' : `web chat title: native rename unconfirmed (${reason})`
      : title === null ? `web chat title: no current title confirmed (${reason})` : 'web chat title: current title confirmed');
    resolve(title);
  };
  pending = { request, browser: null, forRename, result, canCommit, finish };
  wakeBrowserWork();
  return result;
}

export function offerWebChatTitleCheck(browser: string) {
  if (!pending || !enabled(pending.forRename) || pending.browser !== null) return undefined;
  pending.browser = browser;
  return pending.request;
}

export function acceptWebChatTitle(browser: string, raw: unknown): boolean {
  const result = reply.safeParse(raw);
  if (!result.success || pending?.browser !== browser || !enabled(pending.forRename) || pending.request.id !== result.data.id ||
      pending.request.conversationId !== result.data.conversationId) return false;
  pending.finish(result.data.title, result.data.reason);
  return true;
}

const renameClaim = reply.pick({ id: true, conversationId: true }).extend({ commit: z.literal(true) }).strict();

export async function authorizeWebChatRename(browser: string, raw: unknown): Promise<boolean> {
  const claim = renameClaim.safeParse(raw);
  const job = pending;
  const rename = job?.request.rename;
  if (!claim.success || !job || !rename || job.browser !== browser || job.request.id !== claim.data.id ||
      job.request.conversationId !== claim.data.conversationId || !job.canCommit || !enabled(true)) return false;
  const check = job.canCommit;
  job.canCommit = undefined;
  return await check().catch(() => false) && pending === job && enabled(true) && Date.now() < rename.expiresAt;
}

export function cancelWebChatTitleCheck(): void {
  pending?.finish(null, 'canceled');
}
