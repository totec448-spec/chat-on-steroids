import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { wakeBrowserWork } from './browser-wake.js';
import { getConfig } from './config.js';
import { logInfo } from './logger.js';

const reply = z.object({
  id: z.string().uuid(),
  conversationId: z.string().regex(/^[0-9a-f-]{8,64}$/i),
  title: z.string().trim().min(1).max(200).nullable(),
  reason: z.enum(['active-tab-mismatch', 'document-unregistered', 'document-changed', 'title-unconfirmed', 'page-unresponsive', 'browser-error']).optional()
}).strict();

let pending: {
  request: { id: string; conversationId: string };
  browser: string | null;
  finish: (title: string | null, reason?: string) => void;
} | null = null;

/** An explicit, one-shot read from a paired browser. Nothing is stored or retried. */
export function readWebChatTitle(conversationId: string): Promise<string | null> {
  if (!getConfig().sessions.checkWebChatTitles || pending) {
    logInfo('web chat title: check skipped (disabled or a check is already pending)');
    return Promise.resolve(null);
  }
  return new Promise(resolve => {
    const request = { id: randomUUID(), conversationId };
    const timer = setTimeout(() => finish(null, 'timeout'), 15_000);
    timer.unref();
    const finish = (title: string | null, reason = 'unknown') => {
      clearTimeout(timer);
      pending = null;
      logInfo(title === null ? `web chat title: no current title confirmed (${reason})` : 'web chat title: current title confirmed');
      resolve(title);
    };
    pending = { request, browser: null, finish };
    wakeBrowserWork();
  });
}

export function offerWebChatTitleCheck(browser: string) {
  if (!getConfig().sessions.checkWebChatTitles || !pending || pending.browser !== null) return undefined;
  pending.browser = browser;
  return pending.request;
}

export function acceptWebChatTitle(browser: string, raw: unknown): boolean {
  const result = reply.safeParse(raw);
  if (!getConfig().sessions.checkWebChatTitles || !result.success ||
      pending?.browser !== browser || pending.request.id !== result.data.id ||
      pending.request.conversationId !== result.data.conversationId) return false;
  pending.finish(result.data.title, result.data.reason);
  return true;
}

export function cancelWebChatTitleCheck(): void {
  pending?.finish(null, 'canceled');
}
