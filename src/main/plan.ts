/**
 * First-class /plan semantics without adding another MCP schema.
 *
 * The command itself lives in the user's ChatGPT message. The app derives the newest /plan
 * directive from the durable session history and the MCP dispatcher enforces the resulting mode
 * before any model-facing tool handler runs. This keeps the Core surface at its deliberate seven
 * live schemas while making Plan Mode an app-owned permission boundary rather than a prompt that
 * the model may ignore.
 *
 *   /plan <objective>  -> planning: reads/inspection only
 *   /plan              -> planning: ask/produce a plan for the current task
 *   /plan run          -> approved: lift the mutation fence and execute the agreed plan
 *   /plan clear        -> off: cancel the plan fence
 *
 * Plan state is keyed by the local session, not by one ChatGPT conversation. Compact & Resume
 * rebinds a session to a replacement conversation, so the same plan follows that rebind without
 * a second migration mechanism. The latest directive sequence is persisted separately so an app
 * restart cannot rediscover an old /plan start after a later /plan run or /plan clear fell out of
 * a bounded recent-history read.
 */

import type { SessionEvent } from '../shared/session.js';
import { readDurable, writeDurableNow } from './durable.js';
import { logWarn } from './logger.js';
import { currentCall } from './mcp/call-context.js';
import { IDENTITY_EVIDENCE_MS, type SurfaceRegistrar, type ToolResult } from './mcp/kernel.js';
import { awaitFreshCallOrigin } from './session/recorder.js';
import { findSessionByConversation, readEvents, readRecentEvents } from './session/store.js';

export type PlanPhase = 'off' | 'planning' | 'approved';

export interface PlanDirective {
  phase: PlanPhase;
  objective: string;
}

interface StoredPlanState extends PlanDirective {
  /** Session-local sequence of the user message that most recently changed Plan Mode. */
  directiveSeq: number;
  updatedAt: number;
}

interface PlanSnapshot {
  version: 1;
  savedAt: number;
  sessions: Array<{ sessionId: string; state: StoredPlanState }>;
}

export const PLAN_STATE_FILE = 'plan-mode';
const MAX_OBJECTIVE_CHARS = 4_000;
const RECENT_USER_DIRECTIVES = 64;
const MAX_STORED_SESSIONS = 512;

/**
 * These tools cannot mutate the approved filesystem/terminal/desktop. Everything else is
 * denied while planning. In particular exec_command is intentionally not special-cased: even a
 * command that looks like a search can contain shell redirection, command substitution or an rg
 * --pre hook. The existing read tool still supports folder listings and globs during planning.
 */
const PLAN_READ_ONLY_TOOLS = new Set(['read', 'view_image', 'find', 'session', 'observe']);

const stateBySession = new Map<string, StoredPlanState>();
let loaded: Promise<void> | null = null;

function toolError(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function cleanObjective(value: string): string {
  return value.replace(/\u0000/g, '').trim().slice(0, MAX_OBJECTIVE_CHARS);
}

/** Pure slash parser. Only a message beginning with /plan owns Plan Mode. */
export function parsePlanDirective(message: string): PlanDirective | null {
  const text = String(message ?? '').trim();
  if (!/^\/plan(?:\s|$)/i.test(text)) return null;
  const tail = cleanObjective(text.slice('/plan'.length));
  const command = tail.toLowerCase();
  if (command === 'run' || command === 'execute' || command === 'approve') {
    return { phase: 'approved', objective: '' };
  }
  if (command === 'clear' || command === 'off' || command === 'cancel') {
    return { phase: 'off', objective: '' };
  }
  return { phase: 'planning', objective: tail };
}

/** Pure permission policy, exported for focused tests. */
export function planAllowsTool(phase: PlanPhase, tool: string): boolean {
  return phase !== 'planning' || PLAN_READ_ONLY_TOOLS.has(tool);
}

function validStoredState(value: unknown): value is StoredPlanState {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Partial<StoredPlanState>;
  return (
    (raw.phase === 'off' || raw.phase === 'planning' || raw.phase === 'approved') &&
    typeof raw.objective === 'string' &&
    raw.objective.length <= MAX_OBJECTIVE_CHARS &&
    typeof raw.directiveSeq === 'number' &&
    Number.isSafeInteger(raw.directiveSeq) &&
    raw.directiveSeq >= 0 &&
    typeof raw.updatedAt === 'number' &&
    Number.isFinite(raw.updatedAt)
  );
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return loaded;
  loaded = (async () => {
    const snapshot = await readDurable<PlanSnapshot>(PLAN_STATE_FILE);
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.sessions)) return;
    for (const row of snapshot.sessions) {
      if (!row || typeof row.sessionId !== 'string' || !/^[0-9a-z-]{8,64}$/i.test(row.sessionId)) continue;
      if (!validStoredState(row.state)) continue;
      stateBySession.set(row.sessionId, {
        ...row.state,
        objective: cleanObjective(row.state.objective)
      });
    }
  })();
  return loaded;
}

function snapshot(): PlanSnapshot {
  const sessions = [...stateBySession.entries()]
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, MAX_STORED_SESSIONS)
    .map(([sessionId, state]) => ({ sessionId, state }));
  return { version: 1, savedAt: Date.now(), sessions };
}

async function saveState(): Promise<void> {
  const keep = [...stateBySession.entries()]
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, MAX_STORED_SESSIONS);
  stateBySession.clear();
  for (const [sessionId, state] of keep) stateBySession.set(sessionId, state);
  await writeDurableNow(PLAN_STATE_FILE, snapshot());
}

function newestDirective(events: readonly SessionEvent[], afterSeq = -1): { seq: number; directive: PlanDirective } | null {
  for (let at = events.length - 1; at >= 0; at--) {
    const event = events[at];
    if (!event || event.seq <= afterSeq || event.kind !== 'user_message') continue;
    const directive = parsePlanDirective(event.message.text);
    if (directive) return { seq: event.seq, directive };
  }
  return null;
}

async function refreshSessionPlan(sessionId: string): Promise<StoredPlanState | null> {
  await ensureLoaded();
  const stored = stateBySession.get(sessionId) ?? null;
  const events = stored
    ? await readRecentEvents(sessionId, RECENT_USER_DIRECTIVES, { kinds: ['user_message'] })
    : await readEvents(sessionId, { kinds: ['user_message'] });
  const found = newestDirective(events, stored?.directiveSeq ?? -1);
  if (!found) return stored;

  const next: StoredPlanState = {
    phase: found.directive.phase,
    objective: found.directive.phase === 'planning' ? found.directive.objective : stored?.objective ?? '',
    directiveSeq: found.seq,
    updatedAt: Date.now()
  };
  if (found.directive.phase === 'off') next.objective = '';
  stateBySession.set(sessionId, next);
  try {
    await saveState();
  } catch (error) {
    logWarn(`plan: could not persist directive for ${sessionId}: ${(error as Error).message}`);
  }
  return next;
}

async function callerConversation(tool: string): Promise<string | null> {
  const call = currentCall();
  if (!call) return null;
  if (call.caller.conversationId) return call.caller.conversationId;
  if (!call.caller.requestId) return null;
  const conversationId = await awaitFreshCallOrigin(tool, call.startedAt, IDENTITY_EVIDENCE_MS, {
    requestId: call.caller.requestId
  });
  if (conversationId) call.caller.conversationId = conversationId;
  return conversationId;
}

async function sessionStateForConversation(conversationId: string): Promise<StoredPlanState | null> {
  const summary = await findSessionByConversation(conversationId, { requireUnique: true });
  if (!summary) return null;
  return refreshSessionPlan(summary.id);
}

function blockedMessage(state: StoredPlanState, tool: string): string {
  const objective = state.objective ? `\nPlan objective: ${state.objective}` : '';
  return (
    `PLAN_MODE_READ_ONLY: ${tool} is blocked because this ChatGPT session is in /plan mode.${objective}\n` +
    'Inspect with read/view_image/find/session/observe only. Produce a decision-complete implementation plan and stop for the user to review it. ' +
    'Do not edit files, run shell commands, type/click on the desktop, write the clipboard, or spawn workers. ' +
    'The user can send /plan run to approve execution or /plan clear to cancel Plan Mode.'
  );
}

async function guardPlanTool(tool: string): Promise<ToolResult | null> {
  await ensureLoaded();
  if (PLAN_READ_ONLY_TOOLS.has(tool)) return null;

  const conversationId = await callerConversation(tool);
  if (!conversationId) {
    const anyPlanning = [...stateBySession.values()].some((state) => state.phase === 'planning');
    return anyPlanning
      ? toolError(
          'PLAN_CALLER_IDENTITY_REQUIRED: a /plan session is active and this mutating call could not be attributed to a ChatGPT conversation. No action was run. Restore the browser-extension identity path and retry.'
        )
      : null;
  }

  const state = await sessionStateForConversation(conversationId);
  if (!state || planAllowsTool(state.phase, tool)) return null;
  return toolError(blockedMessage(state, tool));
}

/** Wraps a surface registrar without changing its schemas or discovery budget. */
export function withPlanGuard(reg: SurfaceRegistrar): SurfaceRegistrar {
  return {
    ...reg,
    register: ((name: string, config: unknown, handler: (args: unknown) => Promise<ToolResult>) => {
      reg.register(name, config as never, (async (args: unknown) => {
        const blocked = await guardPlanTool(name);
        return blocked ?? handler(args);
      }) as never);
    }) as SurfaceRegistrar['register']
  };
}

export function resetPlanStateForTests(): void {
  stateBySession.clear();
  loaded = null;
}
