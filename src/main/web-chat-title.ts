import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { wakeBrowserWork } from './browser-wake.js';
import { getConfig } from './config.js';
import { logInfo } from './logger.js';

const reply = z.object({
  id: z.string().uuid(),
  conversationId: z.string().regex(/^[0-9a-f-]{8,64}$/i),
  title: z.string().trim().min(1).max(200).nullable(),
  accountKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  reason: z.enum([
    'active-tab-mismatch', 'no-matching-tab', 'multiple-matching-tabs', 'tab-unavailable',
    'document-unregistered', 'document-changed', 'title-unconfirmed', 'page-unresponsive', 'browser-error',
    'title-changed', 'native-rename-unavailable', 'native-rename-unconfirmed', 'rename-canceled',
    'native-trigger-unavailable', 'native-menu-unavailable', 'native-editor-unavailable', 'native-input-rejected',
    'account-mismatch', 'account-unconfirmed'
  ]).optional()
}).strict();

type NativeRename = { expectedTitle: string; accountKey: string; title: string; expiresAt: number };
type TitleProof = { title: string; accountKey?: string };

let pending: {
  request: { id: string; conversationId: string; accountProof?: true; rename?: NativeRename };
  browser: string | null;
  forRename: boolean;
  result: Promise<TitleProof | null>;
  canCommit?: () => Promise<boolean>;
  finish: (proof: TitleProof | null, reason?: string) => void;
} | null = null;

/** An explicit, one-shot read from a paired browser. Nothing is stored or retried. */
export async function readWebChatTitle(conversationId: string): Promise<string | null> {
  return (await requestWebChatTitle(conversationId, false))?.title ?? null;
}

export async function captureWebChatTitleForRename(conversationId: string): Promise<{ title: string; accountKey: string } | null> {
  if (!enabled(true)) return null;
  const existing = pending;
  if (existing && !existing.request.rename && existing.request.conversationId === conversationId && !existing.request.accountProof)
    await existing.result;
  const proof = await (pending?.request.conversationId === conversationId && pending.request.accountProof
    ? pending.result : requestWebChatTitle(conversationId, true));
  return proof?.accountKey ? { title: proof.title, accountKey: proof.accountKey } : null;
}

export async function renameWebChatTitle(
  conversationId: string,
  expectedTitle: string,
  accountKey: string,
  title: string,
  canCommit: () => Promise<boolean>
): Promise<boolean> {
  return (await requestWebChatTitle(conversationId, true, { expectedTitle, accountKey, title, expiresAt: Date.now() + 15_000 }, canCommit))?.title === title;
}

function enabled(forRename: boolean): boolean {
  const settings = getConfig().sessions;
  return forRename ? settings.renameWebChatTitles === true : settings.checkWebChatTitles === true;
}

function requestWebChatTitle(conversationId: string, forRename: boolean, rename?: NativeRename, canCommit?: () => Promise<boolean>): Promise<TitleProof | null> {
  if (!enabled(forRename) || pending) {
    logInfo('web chat title: check skipped (disabled or a check is already pending)');
    return Promise.resolve(null);
  }
  let resolve!: (proof: TitleProof | null) => void;
  const result = new Promise<TitleProof | null>(done => { resolve = done; });
  const request = { id: randomUUID(), conversationId, ...(rename ? { rename } : forRename ? { accountProof: true as const } : {}) };
  const timer = setTimeout(() => finish(null, 'timeout'), 15_000);
  timer.unref();
  const finish = (proof: TitleProof | null, reason = 'unknown') => {
    clearTimeout(timer);
    pending = null;
    logInfo(rename
      ? proof?.title === rename.title ? 'web chat title: native rename confirmed' : `web chat title: native rename unconfirmed (${reason})`
      : proof === null ? `web chat title: no current title confirmed (${reason})` : 'web chat title: current title confirmed');
    resolve(proof);
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
  const { title, accountKey, reason } = result.data;
  if (pending.request.accountProof && title && !accountKey) pending.finish(null, 'account-unconfirmed');
  else pending.finish(title ? { title, ...(accountKey ? { accountKey } : {}) } : null, reason);
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
