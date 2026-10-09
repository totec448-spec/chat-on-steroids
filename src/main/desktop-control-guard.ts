import { getConfig } from './config.js';
import { formatMainText, mainText } from './main-texts.js';
import { logWarn } from './logger.js';
import { currentCall } from './mcp/call-context.js';
import { getSession } from './session/store.js';

export const DESKTOP_CONTROL_GUARD_COUNTDOWN_MS = 10_000;
export const DESKTOP_CONTROL_GUARD_TIMEOUT_MS = 15_000;

export type DesktopControlGuardDecision = 'allow' | 'stop';
export type DesktopControlGuardOutcome = 'success' | 'failure' | 'cancelled';

export interface DesktopControlGuardRequest {
  ownerKey: string;
  label: string;
  operation: string;
  description: string;
  countdownMs: number;
}

export interface DesktopControlGuardPresenter {
  prompt(request: DesktopControlGuardRequest): Promise<DesktopControlGuardDecision>;
  blocked?(request: DesktopControlGuardRequest, allowAgain: () => void): void;
  settled?(request: DesktopControlGuardRequest, outcome: DesktopControlGuardOutcome): void | Promise<void>;
}

export type DesktopControlAdmission =
  | { allowed: true; request: DesktopControlGuardRequest }
  | { allowed: false; reason: string };

let presenter: DesktopControlGuardPresenter | null = null;
const blockedOwners = new Set<string>();

/** Main installs the one built-in presenter. Tests may replace it without Electron. */
export function setDesktopControlGuardPresenter(next: DesktopControlGuardPresenter | null): void {
  presenter = next;
}

/** Disabling the feature is an explicit way to revoke its in-memory Stop decisions. */
export function clearDesktopControlGuardBlocks(): void {
  blockedOwners.clear();
}

/** Kept synchronous so Guard Off adds no await to the existing Desktop path. */
export function desktopControlGuardEnabled(): boolean {
  return getConfig().ui?.desktopControlGuard === true;
}

function ownerKey(): string {
  const call = currentCall();
  if (call?.agent && call.agent !== 'prime') return 'agent:' + call.agent;
  const caller = call?.caller;
  if (caller?.sessionId) return 'session:' + caller.sessionId;
  if (caller?.conversationId) return 'chat:' + caller.conversationId;
  if (caller?.requestId) return 'request:' + caller.requestId;
  if (caller?.transportKey) return 'transport:' + caller.transportKey;
  return 'unattributed';
}

async function callerLabel(): Promise<string> {
  const call = currentCall();
  if (call?.agent && call.agent !== 'prime') {
    const worker = call.agent.replace(/^worker-/, '');
    return formatMainText('Worker {0}', [/^\d+$/.test(worker) ? worker : call.agent]);
  }
  const sessionId = call?.caller.sessionId;
  if (sessionId) {
    try {
      const summary = await getSession(sessionId);
      const title = summary?.title?.replace(/\s+/g, ' ').trim().slice(0, 80);
      if (title) return formatMainText('Chat “{0}”', [title]);
    } catch {
      // Exact caller identity remains valid if presentation metadata cannot be read.
    }
  }
  return call?.caller.conversationId ? mainText('This chat') : mainText('An unattributed caller');
}

async function requestFor(operation: string): Promise<DesktopControlGuardRequest> {
  const call = currentCall();
  return {
    ownerKey: ownerKey(),
    label: await callerLabel(),
    operation,
    description: call?.activity?.title ?? operation,
    countdownMs: DESKTOP_CONTROL_GUARD_COUNTDOWN_MS
  };
}

async function boundedPrompt(
  host: DesktopControlGuardPresenter,
  request: DesktopControlGuardRequest
): Promise<DesktopControlGuardDecision> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      host.prompt(request),
      new Promise<DesktopControlGuardDecision>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Desktop control guard timed out.')),
          DESKTOP_CONTROL_GUARD_TIMEOUT_MS
        );
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Admission happens before computer/index.ts::exclusive(), never while holding its shared queue. */
export async function admitDesktopControl(operation: string): Promise<DesktopControlAdmission> {
  const request = await requestFor(operation);
  const host = presenter;
  if (!host) {
    return {
      allowed: false,
      reason: 'DESKTOP_GUARD_UNAVAILABLE: Desktop control guard is enabled but its notice host is unavailable. No input ran.'
    };
  }

  if (blockedOwners.has(request.ownerKey)) {
    try {
      host.blocked?.(request, () => blockedOwners.delete(request.ownerKey));
    } catch (error) {
      logWarn('desktop guard blocked notice failed: ' + (error instanceof Error ? error.message : String(error)));
    }
    return {
      allowed: false,
      reason: 'DESKTOP_GUARD_STOPPED: This caller was stopped by the user. No input ran. Use the desktop notice to allow it again.'
    };
  }

  let decision: DesktopControlGuardDecision;
  try {
    decision = await boundedPrompt(host, request);
  } catch (error) {
    logWarn('desktop guard preflight failed closed: ' + (error instanceof Error ? error.message : String(error)));
    return {
      allowed: false,
      reason: 'DESKTOP_GUARD_FAILED: The desktop control guard did not complete safely. No input ran.'
    };
  }
  if (decision === 'stop') {
    blockedOwners.add(request.ownerKey);
    try {
      host.blocked?.(request, () => blockedOwners.delete(request.ownerKey));
    } catch (error) {
      logWarn('desktop guard blocked notice failed: ' + (error instanceof Error ? error.message : String(error)));
    }
    return {
      allowed: false,
      reason: 'DESKTOP_GUARD_STOPPED: Desktop control was stopped by the user. No input ran.'
    };
  }
  return { allowed: true, request };
}

/** Post-operation reporting is best effort: it can never rewrite a real native result. */
export function finishDesktopControlGuard(
  admission: DesktopControlAdmission | null,
  outcome: DesktopControlGuardOutcome
): void {
  if (!admission?.allowed || !presenter?.settled) return;
  try {
    void Promise.resolve(presenter.settled(admission.request, outcome)).catch(error =>
      logWarn('desktop guard post-hook failed: ' + (error instanceof Error ? error.message : String(error)))
    );
  } catch (error) {
    logWarn('desktop guard post-hook failed: ' + (error instanceof Error ? error.message : String(error)));
  }
}

export function desktopControlOutcomeForError(error: unknown): DesktopControlGuardOutcome {
  return error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failure';
}
