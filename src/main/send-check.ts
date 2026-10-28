/**
 * #1794 phase 1: before a message the app sends by itself (a Goal or Loop step, an automatic
 * Continue or recovery, the fresh turn after a long one, a scheduled run, a worker's start or a
 * message to a worker), an optional local program is asked whether it may go. A message a person sends is never
 * asked about.
 *
 * Veto-only: the answer can hold the send back, never change its text, model or target. Off while no
 * address is set. Once one is set, anything but a clear "allow" holds the send (no answer within
 * the timeout, an error, another status or body), so a crashed checker never quietly opens the gate.
 * The address must be on this computer; a saved one that is not is never contacted, and holds too.
 * Every decision writes one log line, never with the message in it.
 */
import { getConfig } from './config.js';
import { logInfo } from './logger.js';
import { sendCheckUrl } from '../shared/send-check.js';

export { sendCheckUrl };

export type SendCheckKind = 'goal-step' | 'loop-step' | 'continue' | 'recovery' | 'fresh-turn' | 'scheduled' | 'worker-start' | 'worker-message';

export interface SendCheckRequest {
  kind: SendCheckKind;
  /** The send's own id, the same across retries. */
  id: string;
  chat: { session: string | null; project: string | null; worker: string | null };
  text: string;
  /** 1 for the first ask, then one more for each retry after a hold. */
  attempt: number;
}

export type SendCheckResult = { allowed: true } | { allowed: false; reason: string; answered: boolean };

export interface SendCheckDeps {
  /** The saved address; empty means off. */
  url(): string;
  fetch(url: string, init: RequestInit): Promise<Response>;
  log(line: string): void;
  timeoutMs?: number;
}

/** How long a held send waits before the program is asked again. */
export const SEND_CHECK_RETRY_MS = 30_000;
let retryMs = SEND_CHECK_RETRY_MS;
/** The wait before asking again about a held send that waits in place (a Goal or Loop step). */
export function sendCheckRetryMs(): number { return retryMs; }
export function setSendCheckRetryForTests(ms = SEND_CHECK_RETRY_MS): void { retryMs = ms; }
const TIMEOUT_MS = 3_000;
const MAX_REASON = 200;

function cleanReason(value: unknown): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON).trim();
}

export function createSendCheck(deps: SendCheckDeps): (request: SendCheckRequest) => Promise<SendCheckResult> {
  const held = (request: SendCheckRequest, reason: string, answered: boolean, why: string): SendCheckResult => {
    deps.log(`send check: ${request.kind} ${request.id} attempt ${request.attempt} held (${why})`);
    return { allowed: false, reason, answered };
  };
  return async request => {
    const saved = deps.url().trim();
    if (!saved) return { allowed: true };
    const url = sendCheckUrl(saved);
    if (!url) return held(request, '', false, 'the send check address is not on this computer');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? TIMEOUT_MS);
    let answer: unknown;
    try {
      const response = await Promise.race([
        deps.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ version: 1, kind: request.kind, id: request.id, chat: request.chat, text: request.text, attempt: request.attempt }),
          redirect: 'manual',
          signal: controller.signal
        }),
        new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }))
      ]);
      answer = response.status === 200 ? await response.json() : undefined;
    } catch {
      answer = undefined;
    } finally {
      clearTimeout(timer);
    }
    const body = answer && typeof answer === 'object' && !Array.isArray(answer) ? answer as { allow?: unknown; reason?: unknown } : null;
    if (body?.allow === true) {
      deps.log(`send check: ${request.kind} ${request.id} attempt ${request.attempt} allowed`);
      return { allowed: true };
    }
    if (body?.allow === false) {
      const reason = cleanReason(body.reason);
      return held(request, reason, true, reason || 'no reason given');
    }
    return held(request, '', false, 'the send check did not answer');
  };
}

/** The app's send check, reading its address from Settings each time it asks. */
export function checkAutomaticSend(request: SendCheckRequest): Promise<SendCheckResult> {
  return appCheck(request);
}
const appCheck = createSendCheck({
  url: () => getConfig().ui.sendCheckUrl ?? '',
  fetch: (url, init) => fetch(url, init),
  log: logInfo
});
