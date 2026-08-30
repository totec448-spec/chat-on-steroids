/**
 * The machinery every model-facing tool sits on, independent of which surface it lives on.
 *
 * The tools themselves are split by connector — `tools-core.ts` and `tools-desktop.ts` —
 * because a connector is a discovery boundary and that split is the whole point of the
 * design (see `docs/tool-surface.md` §6.4). None of what is in this file is surface-shaped:
 * error mapping, the call clock, the recording context, the agent key and the result
 * formatters behave identically wherever a tool is registered, and duplicating them per
 * surface is how two connectors would quietly start reporting the same thing differently.
 *
 * A tool first appears when its capability is enabled. For the lifetime of a running MCP
 * endpoint the exposed surface is monotonic: if that permission is later revoked, the tool
 * stays registered so a cached ChatGPT tool snapshot does not break, while the live handler
 * returns TOOL_DISABLED. Read-only mode is applied upstream in effectiveCapabilities, so a
 * fresh endpoint starts with every write tool absent.
 *
 * Annotations matter for real behaviour, not just documentation: ChatGPT treats a tool
 * without readOnlyHint as a write action and asks the user to confirm each call, so every
 * genuinely read-only tool is marked as such.
 */

import { rawPromises as fs } from '../rawfs.js';
import { inboundRequestId } from './inbound.js';
import { McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Capabilities, Root } from '../../shared/types.js';
import { FsOpError, formatBytes, type FileInfo } from '../fsops.js';
import { logInfo, logWarn } from '../logger.js';
import {
  SandboxError,
  isAbsoluteVirtualPath,
  isNativeWindowsPath,
  resolvePath,
  type Resolved
} from '../sandbox.js';
import { currentWorkspace, learnWorkspace } from '../workspace.js';
import { ExecError } from '../exec.js';
import { ComputerError } from '../computer/index.js';
import { getConfig } from '../config.js';
import {
  AgentError,
  acknowledgeOffers,
  acknowledgeOffersForConversation,
  dormantWorkerNotice,
  endedWorkerNotice,
  hasDormantWorkerLeases,
  sleepSilentDetachedWorkers,
  noteAgentAlive,
  agentForCaller,
  agentForFinishCaller,
  hasRetiredWorkerLeases,
  offerMessages,
  offerMessagesForConversation,
  persistCriticalSwarmNow,
  requestWorkerRevivals,
  releaseQuiescentRun,
  retiredWorkerForConversation,
  stageQueuedWorkerRevivals,
  swarmRunning
} from '../agents.js';
import type { SurfaceId } from './surfaces.js';
import {
  currentCall,
  emptyEvidence,
  noteOutcome,
  holdWhileSettling,
  runInCallContext,
  trackInFlight,
  trackMcpRequest,
  type CallContext
} from './call-context.js';
import {
  awaitFreshCallOrigin,
  evidenceWindow,
  freshCallOrigin,
  recordAgentMessage,
  recordToolCall
} from '../session/recorder.js';
import { backgroundExecRecoveryNotices } from '../codex/ownership.js';
import { readOverflowText } from '../session/store.js';
import type { StoredText, ToolOutcome } from '../../shared/session.js';

export interface ToolContext {
  roots: Root[];
  /** Capabilities currently allowed by the live settings. */
  caps: Capabilities;
  /**
   * Capabilities whose tools must remain registered for the lifetime of the local MCP
   * endpoint. This prevents an already-cached ChatGPT tool snapshot from turning into
   * UNKNOWN when the user disables a permission mid-session. Calls are still checked
   * against `caps` and return TOOL_DISABLED instead of executing.
   */
  exposedCaps?: Capabilities;
  readOnly: boolean;
  /** When on, an unspecified screenshot captures only the foreground window. */
  privacyScreenshots?: boolean;
  /** Whether session recording is live right now. Defaults to the live setting. */
  sessionTools?: boolean;
  /** Whether multi-agent mode is live right now. Defaults to the live setting. */
  agentTools?: boolean;
  /**
   * Whether these feature tools must stay registered for the lifetime of the endpoint,
   * for the same reason as `exposedCaps`: ChatGPT caches a tools/list snapshot, and a
   * tool that disappears from under a cached snapshot surfaces as a transport-level
   * failure rather than a tidy error. Default to the live values.
   */
  exposedSessionTools?: boolean;
  exposedAgentTools?: boolean;
  /**
   * Whether `find` must stay registered for the lifetime of the endpoint.
   *
   * `find` and the exec pair are mutually exclusive, and that choice cannot be derived
   * from `exposedCaps.command` on each request: `exposedCaps` only ever widens, so a user
   * switching command execution on mid-run would silently *delete* `find` from under a
   * cached ChatGPT snapshot — the exact stale-snapshot failure the monotonic rule exists
   * to prevent. So the decision is made once, from the live capabilities, and then only
   * ever added to. Defaults to the live answer when the caller does not track it.
   */
  exposedFind?: boolean;
}

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export type ToolResult = { content: ToolContent[]; structuredContent?: Record<string, unknown>; isError?: boolean };

export const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
export const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** Maps runtime errors to short model-facing text without ever exposing real paths. */
export function friendlyError(err: unknown): string {
  if (err instanceof SandboxError || err instanceof ComputerError) return err.message;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'Not found';
  if (code === 'EACCES' || code === 'EPERM') return 'Access denied by the operating system';
  if (code === 'EBUSY') return 'The file is in use by another program';
  if (code === 'ENOTEMPTY') return 'Directory is not empty';
  if (code === 'EEXIST') return 'Already exists';
  // Node filesystem errors routinely embed the absolute host path in `err.message`.
  // Unknown errno values (ELOOP, ENAMETOOLONG, EINVAL, ENOSPC, …) used to fall through
  // verbatim and violate the model-facing virtual-path contract. Keep the errno useful
  // without echoing the path Windows supplied.
  if (typeof code === 'string' && code.length > 0) return `Filesystem error (${code})`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Epoch ms of the last tool ChatGPT actually ran, or null if it never has.
 *
 * Deliberately separate from "a request arrived". ChatGPT connects, initialises and
 * lists tools on every connect even when the model is then forbidden to use them —
 * which is precisely what an account with Developer mode switched off looks like from
 * here. Only a tool that ran proves the whole chain, model included, works.
 *
 * Kept per surface as well as overall. "Has ChatGPT ever run a tool here" is the only
 * honest proof a connector was created and works, and with two connectors the answer for
 * one says nothing about the other — a user whose Core connector is fine and whose
 * Desktop connector was never added would otherwise see setup reported as finished.
 */
let toolCallSeenAt: number | null = null;
const surfaceToolCallAt = new Map<SurfaceId, number>();

export function lastToolCallAt(surface?: SurfaceId): number | null {
  if (surface === undefined) return toolCallSeenAt;
  return surfaceToolCallAt.get(surface) ?? null;
}

/** Cleared with the server, so the answer is always about the current session. */
export function resetToolClock(): void {
  toolCallSeenAt = null;
  surfaceToolCallAt.clear();
  transportIdentity = { checked: false, present: false };
}

/**
 * Turns any thrown error into a tool execution error the model can act on, and keeps
 * unexpected internals out of the response. Error results are logged with only their
 * first line, so Activity stays useful without copying command output or file contents.
 */
export async function guard(name: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  const started = Date.now();
  // Counted before the work, and counted even when the tool is disabled or fails:
  // the question this answers is whether the model may call us at all.
  toolCallSeenAt = started;
  try {
    const result = await fn();
    const elapsed = Date.now() - started;
    if (result.isError) {
      const summary = result.content
        .find((item): item is Extract<ToolContent, { type: 'text' }> => item.type === 'text')
        ?.text.split(/\r?\n/, 1)[0]
        ?.slice(0, 500);
      // A rejected edit, disabled permission, stale cursor, etc. is a normal tool
      // outcome, not evidence that the connector itself is unhealthy.
      noteOutcomeSafely('tool_rejected');
      logInfo(`tool ${name} rejected in ${elapsed} ms${summary ? `: ${summary}` : ''}`);
    } else {
      noteOutcomeSafely('ok');
      logInfo(`tool ${name} ok in ${elapsed} ms`);
    }
    return result;
  } catch (err) {
    const message = friendlyError(err);
    const elapsed = Date.now() - started;
    if (
      err instanceof SandboxError ||
      err instanceof ComputerError ||
      err instanceof FsOpError ||
      err instanceof ExecError ||
      err instanceof AgentError
    ) {
      noteOutcomeSafely('tool_rejected');
      logInfo(`tool ${name} rejected in ${elapsed} ms: ${message}`);
    } else {
      noteOutcomeSafely('tool_internal_error');
      logWarn(`tool ${name} failed in ${elapsed} ms: ${message}`);
    }
    return fail(message);
  }
}

// noteOutcome is only meaningful inside a call context; guard is also used by tests and
// by internal paths that have none, and a missing context must not turn into an error.
function noteOutcomeSafely(outcome: ToolOutcome): void {
  try {
    noteOutcome(outcome);
  } catch {
    /* no call context: nothing to record against */
  }
}

/**
 * The conversation this call was made from, if this call itself proved it.
 *
 * The only identity any agent has, and the reason no tool here carries a key. It reads one
 * thing: ChatGPT's own message model naming *this* tool request, in exactly one conversation,
 * at or after the moment this call started. Not `provenConversation()` — that reports whichever
 * chat has drawn connector rows lately and keeps answering for a minute after that chat went
 * quiet, which on a machine with one busy chat says the same thing whoever is calling. Not the
 * active chat, not the last chat, not a guess.
 *
 * Deliberately non-blocking, and deliberately after the handler has run. Non-blocking because
 * this is on the path of every ordinary read and exec, and waiting on the browser to answer a
 * question about attribution would make the browser a dependency of reading a file. After the
 * handler because the page reports on its own tick: a call that took a second has had a second
 * for its evidence to arrive, which is exactly the calls whose attribution matters most.
 *
 * A call that cannot be placed simply has no agent. It is not refused — most calls in most
 * installs are an ordinary chat with no swarm anywhere near it, and a phone talking to the same
 * connector is not a worker impersonation attempt. What it does not get is somebody else's
 * inbox, and control of the run: `agents` establishes identity for itself, and refuses without
 * it by name.
 */
function callerConversation(tool: string, startedAt: number, requestId: string | null): string | null {
  return freshCallOrigin(tool, startedAt, requestId);
}

/** The only SDK handler context field this layer consumes; request identity comes from ingress ALS. */
type McpCallContext = Pick<ServerContext, 'sessionId'>;

/**
 * ChatGPT's id for this request, from `x-request-id`, without the per-attempt suffix.
 *
 * The header arrives as `wfr_<id>/<suffix>` and ChatGPT's own message model holds the
 * `wfr_<id>` half, so the suffix is dropped rather than matched on. Measured live on
 * 2026-08-18: header `wfr_01a014bdd7cd7a15b6b533d3ce2b42f2/yqy1`, page evidence
 * `read#wfr_01a014bdd7cd7a15b6b533d3ce2b42f2`.
 *
 * This is what makes caller identity a lookup instead of an inference. Before it, two
 * workers of the same run calling `agents` seconds apart were indistinguishable — both
 * conversations had named an unclaimed `agents` request inside the same window — and both
 * were refused WORKER_IDENTITY_LOST. Nothing about timing needs to be assumed now.
 */
function requestIdOf(mcpCtx: McpCallContext | undefined): string | null {
  // server.ts normalizes x-request-id exactly once at raw HTTP ingress and binds that value
  // to this async request. Re-reading the SDK header here would create a second parser/source
  // of truth for the correlation key.
  void mcpCtx;
  return inboundRequestId();
}

/**
 * Whether the MCP transport ever gave us a session id, once a real call has arrived.
 *
 * Recorded rather than assumed, because it is the one thing that would let this app know
 * which conversation is calling without asking the browser at all. Until it does, identity
 * comes from page evidence. This is what the Activity log reports on the first tool call of
 * each run.
 */
let transportIdentity: { checked: boolean; present: boolean } = { checked: false, present: false };

export function transportIdentityStatus(): { checked: boolean; present: boolean } {
  return { ...transportIdentity };
}

function noteTransportIdentity(transportKey: string | null): void {
  if (transportIdentity.checked) return;
  transportIdentity = { checked: true, present: transportKey !== null };
  logInfo(
    transportKey
      ? 'MCP transport supplied a session id — agent identity could be bound to the transport'
      : 'MCP transport supplied no session id (stateless connector) — agent identity comes from page evidence'
  );
}

/** Appends same-conversation background reminders without consuming terminal output. */
function withBackgroundExecRecovery(
  conversationId: string | null | undefined,
  result: ToolResult
): ToolResult {
  const notices = backgroundExecRecoveryNotices(conversationId);
  if (notices.length === 0) return result;
  return {
    ...result,
    content: [
      ...result.content,
      { type: 'text', text: `\n--- Background command recovery ---\n${notices.join('\n')}` }
    ]
  };
}

/**
 * Appends the messages waiting for this agent to the tool result.
 *
 * This is the push-like delivery: an agent gets whatever has been said to it since its last
 * call, at the end of every result, with no polling loop. It works for a call this app could
 * place in a conversation, which is most of them and never all of them — so nothing is
 * retired here, and a message the page could not confirm is simply offered again next time.
 *
 * Messages are *offered* here, not retired. They are retired when this agent calls
 * again, because that is the first real evidence this result reached ChatGPT.
 */
function withInbox(
  conversationId: string | null | undefined,
  agent: string | null,
  result: ToolResult,
  onFinish = false
): ToolResult {
  // Conversation ownership is the durable authority. This matters most for a parked prime:
  // there is deliberately no live `agent:prime` while another history may be active, but its
  // exact conversation still owns final worker reports queued before parking. The finish flag
  // also preserves the one dormant-worker exception: retrying a lost finish result may re-offer
  // rows that rode on that finish, without re-authorising ordinary worker activity.
  const scoped = offerMessagesForConversation(conversationId, onFinish, onFinish);
  const recipient = scoped?.agentId ?? agent;
  const messages = scoped?.messages ?? (agent ? offerMessages(agent, onFinish) : []);
  if (messages.length === 0) return result;
  const lines = messages
    .map(
      (message) =>
        `• [${message.id}] from ${message.from}${message.offers > 1 ? ' (repeat — you may have seen this)' : ''}: ${message.text}`
    )
    .join('\n');
  return {
    ...result,
    content: [
      ...result.content,
      { type: 'text', text: `\n--- ${messages.length} message(s) for ${recipient ?? 'this conversation'} ---\n${lines}` }
    ]
  };
}

/**
 * Runs one tool call inside a recording context.
 *
 * Registration is wrapped rather than each handler, so the arguments and the result
 * recorded are exactly the ones that crossed the wire — the recorder never has to
 * reconstruct a call from a log line — and so identity is resolved in one place.
 *
 * `finishing` replaces the old `name === 'finish_agent'` test: with the collapsed
 * `agents` tool the terminal call is an *action* rather than a tool name, and the
 * re-offer rule has to follow the action.
 */
async function dispatch(
  name: string,
  args: unknown,
  transportKey: string | null,
  requestId: string | null,
  surface: SurfaceId,
  run: () => Promise<ToolResult>
): Promise<ToolResult> {
  // The context is built here, one layer out from where the work happens, because the
  // compaction barrier asks about the whole request and not just the handler. A call is
  // still unsettled while it waits for its request-id evidence, while its outcome is being
  // recorded, and while its result is on the way back — and a handoff written in any of
  // those gaps describes a machine that has not finished changing. The counter therefore
  // opens with the request and closes with it.
  const context: CallContext = {
    startedAt: Date.now(),
    transportKey,
    agent: null,
    caller: { transportKey, requestId, conversationId: null },
    outcome: null,
    evidence: emptyEvidence()
  };
  return trackMcpRequest(() =>
    trackInFlight(context, () => dispatchTracked(context, name, args, transportKey, requestId, surface, run))
  );
}

async function dispatchTracked(
  context: CallContext,
  name: string,
  args: unknown,
  transportKey: string | null,
  requestId: string | null,
  surface: SurfaceId,
  run: () => Promise<ToolResult>
): Promise<ToolResult> {
  noteTransportIdentity(transportKey);
  // Recorded here rather than in `guard` because only this layer knows which server
  // answered, and "was this connector ever actually used from ChatGPT" is a per-connector
  // question the setup screen has to answer honestly.
  surfaceToolCallAt.set(surface, Date.now());
  const isFinish = isFinishCall(name, args);
  const startedAt = context.startedAt;
  // Cheap, non-blocking ingress identity. When the page has already reported this exact
  // request id, identity-sensitive handlers (workspace/session/agents) see it before they
  // touch state. If the page is one tick late this stays null; only handlers that actually
  // require identity wait for their own exact mate. Ordinary absolute reads/execs never wait.
  context.caller.conversationId = callerConversation(name, startedAt, requestId);
  // Only calls that need an *existing* per-chat workspace before the handler runs are
  // identity-sensitive here. An absolute read or an exec with an explicit absolute workdir is
  // self-contained and must stay fast; if its exact page mate is late, workspace.ts simply
  // declines to learn a guessed workspace. Relative paths, omitted exec workdir and a patch with
  // no explicit base really do consume caller state, so they wait for their exact request-id
  // mate while a swarm is active. Use the full exact-id window, not the shorter prime window:
  // the live worker failure that motivated IDENTITY_EVIDENCE_MS arrived ~8 seconds late.
  const identitySensitive = needsWorkspaceIdentity(name, args);
  if (!context.caller.conversationId && identitySensitive && swarmRunning() && requestId) {
    context.caller.conversationId = await awaitFreshCallOrigin(name, startedAt, IDENTITY_EVIDENCE_MS, { requestId });
  }
  // A run that ended leaves an explicit short-lived lease tombstone for each open worker
  // chat. Resolve exact request identity before ordinary tools too while such leases exist;
  // otherwise an explicit-workdir exec could keep mutating after its worker was retired.
  if (!context.caller.conversationId && hasRetiredWorkerLeases() && requestId) {
    context.caller.conversationId = await awaitFreshCallOrigin(name, startedAt, IDENTITY_EVIDENCE_MS, { requestId });
  }
  // Dormant histories are long-lived identity fences, not active slot claims. An old worker tab
  // may still issue a stale server-side call after its run parked, and without exact request-id
  // attribution an absolute read/exec would otherwise look like an unrelated ordinary chat and
  // run successfully. Resolve the exact mate for every call while such worker conversations
  // exist, just as we do for short-lived retired worker leases.
  if (!context.caller.conversationId && hasDormantWorkerLeases() && requestId) {
    context.caller.conversationId = await awaitFreshCallOrigin(name, startedAt, IDENTITY_EVIDENCE_MS, { requestId });
  }
  // Two things about liveness, both before the agent is resolved so that the answer this
  // call gets is the state this call itself established.
  //
  // A detached worker that has also stopped calling is put to sleep here rather than on a
  // timer: nothing about a run changes while nothing is happening, and this is the moment
  // something is happening. Sleep rather than failure, so being early about a slow worker
  // costs the run nothing — its own next call takes the slot straight back.
  const quietWorkers = sleepSilentDetachedWorkers();
  for (const quiet of quietWorkers) {
    if (quiet.report) await recordAgentMessage(quiet.report, 'sent');
  }
  // And this call is itself first-hand evidence that its own conversation is alive. That is
  // what undoes a worker given up on because its tab went away — the turn never stopped, so
  // the call arrives from a chat the app had written off, and the write-off was wrong.
  const alive = noteAgentAlive(context.caller.conversationId);
  if (alive?.report) await recordAgentMessage(alive.report, 'sent');
  // A prime message accepted while a worker's tab was closed could not safely be injected while
  // that server-side turn might still be running. If the silence check above has now proved the
  // worker stopped, carry that already-durable unread work into a revival instead of leaving it
  // stranded until the prime happens to send a second message. Do this after noteAgentAlive so a
  // tool call from the supposedly quiet worker wins and simply keeps the worker active.
  const deferredWake = stageQueuedWorkerRevivals(quietWorkers.map((entry) => entry.info.id));
  if (deferredWake.waking.length > 0) {
    try {
      if (await persistCriticalSwarmNow()) {
        deferredWake.commit();
        requestWorkerRevivals(deferredWake.waking);
      } else {
        deferredWake.rollback();
        logWarn('multi-agent: could not durably reserve queued work for a worker that just fell asleep');
      }
    } catch (err) {
      deferredWake.rollback();
      logWarn(
        `multi-agent: could not durably reserve queued work for a worker that just fell asleep — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  context.agent = isFinish ? agentForFinishCaller(context.caller) : agentForCaller(context.caller);
  const retiredWorker = retiredWorkerForConversation(context.caller.conversationId);
  // Parking a run releases its global execution claim without retiring its worker chats. Those
  // exact conversations remain workers, though: a stale sleeping/terminal worker tab must not
  // turn into an ordinary unidentified chat and keep running local tools merely because another
  // prime currently owns the active run (or because no run is active at all). Only the owning
  // prime's explicit agents message may wake a sleeping worker.
  const dormantWorker = isFinish ? null : dormantWorkerNotice(context.caller.conversationId);
  // A worker that really is over learns so on its own next call. Without this its calls
  // resolved to nobody and ran anyway, so a chat the user had ended went on writing files
  // in the name of no agent at all.
  // A terminal worker may do exactly one thing: retry its own idempotent finish after a lost
  // result. It still has a tombstone identity for that call so the dispatcher can re-offer the
  // inbox that rode on the missing result. Every other tool call from the same chat is refused
  // by endedWorkerNotice as before.
  const endedWorker = isFinish ? null : endedWorkerNotice(context.caller.conversationId);
  const allowUnattributed = getConfig().multiAgent.allowUnattributedCalls;
  const retiredLeaseAmbiguous =
    !allowUnattributed && hasRetiredWorkerLeases() && !context.caller.conversationId;
  const dormantLeaseAmbiguous =
    !allowUnattributed && hasDormantWorkerLeases() && !context.caller.conversationId;
  // In a swarm, a relative/defaulted filesystem operation is not safe to execute after the
  // exact caller lookup timed out: its workspace is part of the requested operation. Falling
  // back to the first approved root turns an attribution outage into wrong-project mutation.
  // Refuse and let the model retry once page evidence is healthy instead.
  const result = await runInCallContext(context, () =>
      dormantWorker
        ? Promise.resolve(fail(dormantWorker))
        : retiredWorker
        ? Promise.resolve(
            fail(
              `WORKER_RETIRED: ${retiredWorker.id} was retired because ${retiredWorker.reason}. This chat can no longer use local tools. Stop working and return to the prime chat.`
            )
          )
        : endedWorker
        ? Promise.resolve(fail(endedWorker))
        : retiredLeaseAmbiguous
        ? Promise.resolve(
            fail(
              'CALLER_IDENTITY_REQUIRED: a recently retired worker tab may still be open, and the connector could not prove this call belongs to a different chat. No local tool was run. Reload the extension evidence path or wait for the retired lease to expire.'
            )
          )
        : dormantLeaseAmbiguous
        ? Promise.resolve(
            fail(
              'CALLER_IDENTITY_REQUIRED: a dormant worker chat still belongs to its prime history, and the connector could not prove this call belongs to a different conversation. No local tool was run. Restore the browser-extension identity path and retry.'
            )
          )
        : !allowUnattributed && swarmRunning() && identitySensitive && !context.caller.conversationId
        ? Promise.resolve(
            fail(
              'CALLER_IDENTITY_REQUIRED: this operation needs this chat’s exact workspace, but the connector could not prove which ChatGPT conversation made the call. Retry after the extension reconnects; no file or command was changed.'
            )
          )
        : run()
  );
  // Identity, once, from this call's own evidence — see callerConversation. `agents` has
  // already established its own inside the call and adopted it, and re-reading here would
  // only be able to disagree with the stronger answer it waited for.
  if (!context.caller.conversationId) {
    const resolved = callerConversation(name, startedAt, requestId);
    if (resolved) context.caller.conversationId = resolved;
  }
  // Never erase an identity a handler proved more strongly (agents::callerNow). The old
  // post-handler pass could fail to rediscover evidence that callerNow had already reserved
  // and then set agent back to null, which is the live WORKER_IDENTITY_LOST / missing-inbox
  // split brain worker-1 observed.
  if (!context.agent) {
    context.agent = isFinish ? agentForFinishCaller(context.caller) : agentForCaller(context.caller);
  }
  // This call is the best evidence there is that the previous result reached the agent's
  // conversation, so anything offered then can be retired and written to its history —
  // except what was offered on a finish result, which this call may itself be the model's
  // retry after a lost result. The SDK exposes the JSON-RPC id, but a model-issued retry is
  // a new MCP request with a new id, so that id cannot prove the previous finish result was
  // seen. The broker therefore re-offers rather than assuming; see acknowledgeOffers.
  const acknowledgedForConversation = acknowledgeOffersForConversation(
    context.caller.conversationId,
    isFinish,
    startedAt,
    isFinish
  );
  const acknowledged =
    acknowledgedForConversation?.messages ??
    (context.agent ? acknowledgeOffers(context.agent, isFinish, startedAt) : []);
  for (const message of acknowledged) {
    // The exact caller conversation is stronger than the friendly recipient id and remains
    // unique after a run parks. Without this override, a parked Prime A acknowledging its report
    // while Prime B is active could file the delivery into B's `prime` session (or Unattributed).
    await recordAgentMessage(message, 'delivered', context.caller.conversationId);
  }
  // This is the MCP call's wall-clock latency. A managed child can outlive the call, and
  // its own lifetime is process evidence; letting that number overwrite ToolCallRecord's
  // duration is what made a 10s yield read like a command that had completed in 10s.
  const durationMs = Date.now() - startedAt;
  // Inbox messages are part of the MCP result ChatGPT actually receives. Build the delivered
  // result before recording so session(action=read, tool_call=T…) is genuine wire forensics rather than a
  // subtly earlier internal value that omits the worker report most likely to matter later.
  const delivered = withBackgroundExecRecovery(
    context.caller.conversationId,
    withInbox(context.caller.conversationId, context.agent, result, isFinish)
  );
  const recorderStartedAt = Date.now();
  const recording = recordToolCall({
    tool: name,
    args,
    content: delivered.content,
    // guard() already marks unexpected defects; an unclassified isError is an expected rejection.
    outcome: context.outcome ?? (result.isError ? 'tool_rejected' : 'ok'),
    durationMs,
    startedAt,
    evidence: context.evidence,
    agent: context.agent,
    bind: context.bindOnAttribution ?? null,
    requestId: context.caller.requestId,
    conversationId: context.caller.conversationId
  });
  // Exact request-id identity needs no browser wait, so make its durable session append part
  // of completing the MCP call. The recorder catches storage failures and returns null, so a
  // broken history never breaks the tool itself. Only the degraded/unidentified path remains
  // fire-and-forget because it may still spend a grace window waiting for page evidence.
  if (context.caller.conversationId) {
    await recording;
    if (name === 'observe' || name === 'computer') {
      logInfo(`desktop timing recorder_wait_ms=${Date.now() - recorderStartedAt} attributed=true`);
    }
  } else {
    if (name === 'observe' || name === 'computer') {
      void recording.then(() =>
        logInfo(`desktop timing recorder_wait_ms=0 recorder_async_ms=${Date.now() - recorderStartedAt} attributed=false`)
      );
    }
    holdWhileSettling(context, recording);
  }
  // Retire a completed run only after this call has had every chance to acknowledge and
  // receive its inbox. Doing it inside acknowledgeOffers would let `agents status` destroy
  // the run halfway through identifying itself; here the handler and result are already done.
  releaseQuiescentRun();
  return delivered;
}

/** Whether this handler must know which chat it is before resolving its paths. */
function needsWorkspaceIdentity(name: string, args: unknown): boolean {
  const input = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const relative = (value: unknown): boolean =>
    typeof value === 'string' && !isAbsoluteVirtualPath(value) && !isNativeWindowsPath(value);
  if (name === 'read') {
    const paths = Array.isArray(input['paths']) ? input['paths'] : [];
    return paths.some(relative);
  }
  if (name === 'find') return relative(input['path']);
  if (name === 'apply_patch') {
    // Codex's apply_patch surface has no cwd argument. Relative patch paths therefore always
    // consume the turn/chat cwd analogue maintained by this connector.
    return true;
  }
  if (name === 'exec_command') {
    // Every exec in a swarm also needs caller identity so a long-running session can be
    // owned by the right chat even when the cwd itself was explicit.
    const workdir = input['workdir'];
    return swarmRunning() || workdir === undefined || relative(workdir);
  }
  return false;
}

/**
 * Adopts an identity established *inside* a tool call.
 *
 * The dispatcher can only resolve a caller from what the call carried, which for the prime
 * is nothing at all. The `agents` tool proves who is calling from evidence rendered after
 * that call began, and this is how that answer gets back to the layers that need it: the
 * record this call will be filed under, and the inbox attached to its result. Called only
 * from the one tool that does that work, and only with an id it has just proven.
 */
export async function adoptAgent(agent: string | null): Promise<void> {
  const context = currentCall();
  if (!context || !agent) return;
  context.agent = agent;
  // Identity adoption is intentionally pure. A handler may prove identity more strongly than
  // ingress could, but it must not also retire inbox state: the dispatcher owns exactly one ACK
  // point after the handler, where it knows whether this call is a finish retry and can apply
  // the finish-specific at-least-once rule correctly.
}

function isFinishCall(name: string, args: unknown): boolean {
  if (name !== 'agents') return false;
  if (!args || typeof args !== 'object') return false;
  return (args as Record<string, unknown>)['action'] === 'finish';
}

/**
 * A path named by a tool call, resolved against the chat's workspace when it is relative.
 *
 * Every path argument in every tool goes through here rather than calling `resolvePath`
 * directly, for two reasons. Shorthand then means the same thing in `read` as in `exec` as in
 * `apply_patch` — a model that learns it once has learned it everywhere — and the workspace is
 * learned from every absolute path a call has *proved* it can reach, so no tool has to
 * remember to teach it.
 *
 * The sandbox underneath is untouched. `resolvePath` still performs every root, containment,
 * `..` and symlink check it ever did; the workspace only supplies a prefix for a path that
 * arrived without one, before any of that runs. A chat with no workspace gets the same
 * refusal it would have got for a relative path before, which is why ambiguity here costs a
 * retry rather than reaching the wrong file.
 */
export async function resolveIn(
  roots: Parameters<typeof resolvePath>[0],
  requested: string,
  options: { allowMissing?: boolean; base?: string | null } = {}
): Promise<Resolved> {
  // An explicit adapter-supplied base beats the workspace; otherwise the workspace is the base.
  // Either way the joining happens inside `resolvePath`, ahead of validation,
  // so a `..` in the caller's text still meets `checkSegment` instead of being normalised
  // away first. Doing that join here is how a relative patch path could climb out of the
  // workspace: `posix.normalize('/root/a/../../elsewhere')` is a perfectly clean-looking
  // `/elsewhere`, and nothing downstream can tell it apart from a path that was always that.
  const base = options.base !== undefined ? options.base : (currentWorkspace()?.virtual ?? null);
  const resolved = await resolvePath(roots, requested, {
    ...(options.allowMissing === undefined ? {} : { allowMissing: options.allowMissing }),
    base
  });
  // Absolute only: a workspace learned from a relative path would let one loose resolution
  // decide where the next loose resolution points. See workspace.ts.
  if (isAbsoluteVirtualPath(requested) || isNativeWindowsPath(requested)) await learnWorkspace(resolved);
  return resolved;
}

export interface ResolvedCwd {
  real: string;
  virtual: string;
  /** True when the caller named no folder, so the workspace or first root was used instead. */
  defaulted: boolean;
}

/**
 * The working directory a command tool may use, restricted to an approved root.
 *
 * The caller is told which folder this turned out to be, and whether it was a default,
 * because omitting `workdir` while working inside a nested project is a quiet way to run the
 * wrong build: a live run meant for `…/minecraft-web-demo` fell back to the first root and
 * rebuilt the parent Electron app instead, and nothing in the reply said so.
 */
export async function resolveCwd(ctx: ToolContext, virtualPath: string | undefined): Promise<ResolvedCwd> {
  // The chat's own folder before the first root: a command with no `workdir` should run where the
  // chat has been working, which is the whole point of the workspace and is exactly the case
  // the note above describes going wrong.
  const workspace = currentWorkspace();
  // Codex treats an explicitly empty workdir exactly like an omitted one.
  const provided = virtualPath !== undefined && virtualPath !== '';
  if (!provided && !workspace && swarmRunning()) {
    throw new SandboxError(
      'WORKSPACE_REQUIRED: this multi-agent chat has no proven workspace. Supply an explicit approved workdir before running a command.'
    );
  }
  const target = provided ? virtualPath : (workspace?.virtual ?? (ctx.roots[0] ? `/${ctx.roots[0].name}` : ''));
  if (!target) throw new SandboxError('No folder is approved, so there is nowhere to run');
  const resolved = await resolveIn(ctx.roots, target);
  const stat = await fs.stat(resolved.real);
  if (!stat.isDirectory()) throw new SandboxError('workdir must be a folder');
  return { real: resolved.real, virtual: resolved.virtual, defaulted: !provided };
}

// ------------------------------------------------------------------ shared args

export const pathArg = z.string().min(1).max(4096);
export const lineNumberArg = z.number().int().min(1).max(100_000_000);
export const windowIdArg = z.number().int().min(1).max(4_294_967_295);
export const imageCoordinateArg = z.number().int().min(-100_000).max(100_000);
// Zod's plain object parser strips unknown keys even though its generated JSON Schema says
// additionalProperties=false. Keep runtime validation as strict as the wire contract so a
// misspelled coordinate/crop field cannot be silently discarded.
export const pointArg = z.object({ x: imageCoordinateArg, y: imageCoordinateArg }).strict();
export const cropArg = z
  .object({
    x: z.number().int().min(0).max(100_000),
    y: z.number().int().min(0).max(100_000),
    width: z.number().int().min(1).max(100_000),
    height: z.number().int().min(1).max(100_000)
  })
  .strict();
export const mouseButtonArg = z.enum(['left', 'right', 'middle']);
// ------------------------------------------------------------------ registration

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * What a surface module is handed to register its tools with.
 *
 * Passing a small object rather than the raw `McpServer` is what keeps the two surface
 * modules from being able to diverge on the things that must not differ: every tool goes
 * through `dispatch`, every tool gets the agent key under the same condition, and every
 * capability refusal reads the same. A surface decides *which* tools exist, never how a
 * tool is wired up.
 */
export interface SurfaceRegistrar {
  ctx: ToolContext;
  caps: Capabilities;
  exposedCaps: Capabilities;
  sessionToolsLive: boolean;
  sessionToolsExposed: boolean;
  agentToolsLive: boolean;
  agentToolsExposed: boolean;
  /** Whether `find` is part of this endpoint's surface. See ToolContext.exposedFind. */
  findExposed: boolean;
  register<Schema extends z.ZodType>(
    name: string,
    config: {
      title?: string;
      description: string;
      inputSchema: Schema;
      outputSchema?: z.ZodType;
      annotations?: ToolAnnotations;
    },
    handler: (args: z.output<Schema>) => Promise<ToolResult>
  ): void;
  /** Runs `fn` only while `cap` is live, and explains the refusal otherwise. */
  guarded(cap: keyof Capabilities, name: string, fn: () => Promise<ToolResult>): Promise<ToolResult>;
  /** Refusal used when a whole feature is off but its tool is still exposed. */
  featureDisabled(feature: string, setting: string): ToolResult;
  /** Names actually registered on this server, in registration order. */
  registered(): string[];
}

export function createRegistrar(server: McpServer, ctx: ToolContext, surface: SurfaceId): SurfaceRegistrar {
  const caps = ctx.caps;
  const exposedCaps = ctx.exposedCaps ?? caps;
  // These two do not follow a capability checkbox: they are whole features the user
  // switches on in the app, and neither touches the filesystem. Like the capability
  // tools they are exposed monotonically and disabled at the handler, so switching a
  // feature off does not delete a tool a cached ChatGPT snapshot still believes in.
  const sessionToolsLive = ctx.sessionTools ?? getConfig().sessions.record;
  const agentToolsLive = ctx.agentTools ?? getConfig().multiAgent.enabled;
  const sessionToolsExposed = ctx.exposedSessionTools ?? sessionToolsLive;
  const agentToolsExposed = ctx.exposedAgentTools ?? agentToolsLive;
  const findExposed = ctx.exposedFind ?? (!exposedCaps.command && exposedCaps.search);
  const names: string[] = [];

  return {
    ctx,
    caps,
    exposedCaps,
    sessionToolsLive,
    sessionToolsExposed,
    agentToolsLive,
    agentToolsExposed,
    findExposed,
    registered: () => [...names],
    register(name, config, handler) {
      names.push(name);
      // No identity field is ever added here. Every tool's schema is exactly what its
      // surface declared: who is calling is a fact about the conversation, established from
      // page evidence in `dispatch`, and never something the model is asked to carry.
      server.registerTool(name, config, ((args: never, mcpCtx?: McpCallContext) =>
        dispatch(name, args, mcpCtx?.sessionId ?? null, requestIdOf(mcpCtx), surface, () =>
          handler(args)
        )) as never);
    },
    guarded(cap, name, fn) {
      return guard(name, async () => {
        if (!caps[cap]) {
          return fail(
            `TOOL_DISABLED: ${name} is disabled by the current Chat On Steroids permissions. ` +
              'Ask the user to enable the permission in the app, then retry. If the tool list in this conversation is stale, start a new chat.'
          );
        }
        return fn();
      });
    },
    featureDisabled(feature, setting) {
      return fail(
        `FEATURE_DISABLED: ${feature} is switched off in Chat On Steroids. ` +
          `Ask the user to enable "${setting}" in the app, then try again.`
      );
    }
  };
}

// ------------------------------------------------------------------ formatters

/**
 * Largest brief a handoff save will accept.
 *
 * Generous on purpose. A brief that hits this is a symptom — the compaction of a very
 * long session — and refusing it there would throw away the one artefact the whole flow
 * exists to produce. The bound is only to keep a runaway generation from being written
 * to disk unbounded; at roughly four characters per token this is comfortably past any
 * single ChatGPT answer.
 */
export const MAX_HANDOFF_CHARS = 400_000;

/**
 * How long a prime-role `agents` call waits for the calling chat to show its own block.
 *
 * The prime holds no credential, so this window *is* its identity, and it has to be
 * evidence from this call: a block rendered after the call began, in exactly one
 * conversation. Shorter than a join because a prime calls `agents` repeatedly during a run
 * and a join happens once, but long enough that a page reporting on its own tick lands
 * inside it. Nothing falls back to "the only chat that has been active lately".
 */
export const PRIME_EVIDENCE_MS = evidenceWindow(2_500);

/**
 * The same window for a call ChatGPT gave a request id, which is waiting for one exact
 * page record rather than for whichever block turns up.
 *
 * Two and a half seconds was measured too short for the case that matters most: a worker's
 * first `agents` call runs seconds after its tab opened, and on 2026-08-18 worker-1 was
 * told WORKER_IDENTITY_LOST at 16:33:56 with the page evidence for that very call arriving
 * at 16:34:04. The wait is event-driven and ends the instant the mate lands, so the extra
 * seconds are only ever spent by a call that was going to be refused anyway.
 */
export const IDENTITY_EVIDENCE_MS = evidenceWindow(15_000);

/**
 * The same window again for the two `agents` actions whose refusal cannot be retried cheaply.
 *
 * Everything else that waits for identity is asking about work it can decline and be asked
 * for again a moment later. `spawn` is not: a refused `spawn` ends the turn with
 * no run, and the model's own retry costs the user another full generation — on 2026-08-21 it
 * cost two, and the run still never started. The wait is event-driven and returns the instant
 * the page's request-id mate lands, so a longer ceiling is only ever spent by a call that was
 * going to be refused anyway; against that, the live evidence shows ids arriving twenty
 * seconds after the window that refused them. Kept well inside ChatGPT's own connector
 * timeout, so a slow proof still comes back as a spawned run rather than as a dead call.
 */
export const SPAWN_EVIDENCE_MS = evidenceWindow(30_000);

/**
 * Recovers the complete text behind a stored field.
 *
 * A long tool argument or result is bounded inline in the log and written whole beside
 * it; this reads the whole one back so recovery means the exact payload rather than
 * its first eight thousand characters. `complete` is false only when even the overflow
 * copy could not be written, and the caller says so instead of implying otherwise.
 */
export async function expandStored(
  sessionId: string,
  stored: StoredText
): Promise<{ text: string; complete: boolean }> {
  if (!stored.truncated) return { text: stored.text, complete: true };
  if (stored.assetId) {
    const full = await readOverflowText(sessionId, stored.assetId);
    if (full !== null) return { text: full, complete: true };
  }
  return { text: stored.text, complete: false };
}

/** Splits on blank lines so a part never ends mid-sentence unless a block is huge. */
export function chunkText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const parts: string[] = [];
  let current = '';
  for (const block of text.split(/\n{2,}/)) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= size) {
      current = candidate;
      continue;
    }
    if (current) parts.push(current);
    if (block.length <= size) {
      current = block;
    } else {
      for (let at = 0; at < block.length; at += size) parts.push(block.slice(at, at + size));
      current = '';
    }
  }
  if (current) parts.push(current);
  return parts.length > 0 ? parts : [''];
}

/** The per-path header `read` prints. This is what `file_info` used to be. */
export function formatFileInfo(info: FileInfo): string {
  const lines = [
    `path: ${info.virtualPath}`,
    `type: ${info.type}`,
    `size: ${formatBytes(info.bytes)}`,
    `modified: ${info.modified}`,
    `created: ${info.created}`
  ];
  if (info.readOnly) lines.push('readonly: true');
  if (info.binary !== null) lines.push(`binary: ${info.binary}`);
  if (info.lines !== null) lines.push(`lines: ${info.lines}`);
  if (info.sha256) lines.push(`sha256: ${info.sha256}`);
  return lines.join('\n');
}
