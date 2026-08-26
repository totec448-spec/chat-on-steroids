/**
 * Types for the session recorder, compaction and the multi-agent broker.
 *
 * Shared by the main process, the renderer and — in JSON form — the Chrome extension.
 * No runtime logic here beyond a couple of pure helpers the UI and the recorder must
 * agree on exactly.
 */

/** Where an event came from. The extension is untrusted UI observation; mcp is ours. */
export type EventSource = 'extension' | 'mcp' | 'app';

/**
 * How a ChatGPT turn ended.
 *
 * Deliberately more than "done" and "failed". Guessing "output limit reached" for
 * every unexplained stop is exactly the fake precision this project avoids, so an
 * unexplained stop stays `interrupted` or `unknown` unless ChatGPT actually said why.
 */
export type TurnOutcome =
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'interrupted'
  | 'stalled'
  | 'unknown';

export const TURN_OUTCOME_LABELS: Record<TurnOutcome, string> = {
  completed: 'completed',
  failed: 'failed with a visible error',
  stopped: 'stopped by the user',
  interrupted: 'interrupted before it finished',
  stalled: 'stalled — no visible progress',
  unknown: 'ended for an unknown reason'
};

/**
 * Text stored in an event, with an explicit note when it was cut.
 *
 * The inline copy is bounded so the JSONL stays readable and one huge command output
 * cannot push a line past the reader's limit. Nothing is actually lost by that: when
 * the text is cut, the full redacted original is written beside the log as an asset
 * and named here, so recovery reads the whole thing. `truncated` therefore means
 * "not all of it is in this line", never "the rest is gone".
 */
export interface StoredText {
  text: string;
  /** True when the original was longer than the per-event cap. */
  truncated: boolean;
  /** Length of the original, so a summary can say what it lost. */
  chars: number;
  /** Asset holding the complete redacted text, present only when truncated. */
  assetId?: string;
  /**
   * Digest of the complete text, for events whose identity has to survive being cut.
   *
   * Written for messages, which are the events a reloaded page reports again and which
   * must therefore be recognisable as ones already stored. `text` alone cannot do that
   * once it has been capped, and a length plus a head cannot tell two answers apart that
   * begin the same way — the exact case ChatGPT's reused turn ids produce.
   */
  digest?: string;
}

/** A screenshot or other binary kept beside the log rather than inside it. */
export interface AssetRef {
  id: string;
  mimeType: string;
  bytes: number;
  /** Present only for images. */
  width?: number;
  height?: number;
}

/** Compact human-readable presentation of one tool call. */
export interface ActivitySummary {
  /** Short verb phrase: "Edited src/main/mcp/server.ts". */
  title: string;
  /** Optional qualifier: "lines 200–420", "30 matches". */
  detail?: string;
  /** Optional right-aligned metric: "+18 −4", "✓ 4.8s", "✕ exit 1". */
  metric?: string;
  tone: 'neutral' | 'good' | 'bad' | 'warn';
  /** Family the entry belongs to, for icons and filtering. */
  kind:
    | 'edit'
    | 'create'
    | 'delete'
    | 'move'
    | 'read'
    | 'search'
    | 'browse'
    | 'run'
    | 'process'
    | 'screen'
    | 'input'
    | 'clipboard'
    | 'session'
    | 'agent'
    | 'other';
}

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  /** True when the counts come from a bounded heuristic rather than a full diff. */
  approximate: boolean;
}

export type ToolOutcome = 'ok' | 'error' | 'rejected';

/**
 * How confident the recorder is that this call belongs to the session it landed in.
 *
 * Four grades, strongest first. `agent` is caller identity. `turn` is per-call evidence
 * out of the page's own message model, or a connector block it drew. `generation` is the
 * one ChatGPT chat that was demonstrably mid-turn when the call arrived. `inferred` means
 * nothing identified the caller — those calls are stored in the unattributed stream rather
 * than guessed into somebody's history. The extension refuses to rewrite ChatGPT's UI for
 * an inferred call.
 */
export type CallAttribution = 'request_id' | 'unattributed' | 'turn' | 'agent' | 'generation' | 'inferred';

/**
 * What each grade of attribution actually rests on, in the words shown to the user.
 *
 * Deliberately not interchangeable. `agent` is caller identity: a key only that agent
 * holds, bound to a chat the app itself opened. `turn` is the page having shown a
 * connector block — good evidence about which conversation made *a* connector call, but
 * the collapsed row does not name the connector, so it is a match rather than an identity.
 *
 * `generation` is weaker again and is stated as what it is. The connector belongs to a
 * ChatGPT account rather than to a browser, so a chat being mid-turn here does not prove
 * this call came from here rather than from the same account on a phone. It is used
 * because the alternative measured worse in practice by a wide margin: requiring per-call
 * page evidence sent roughly half of one session's own work into `Unattributed activity`,
 * and a record that is missing half the work is not more truthful than one that says how
 * it placed each call.
 *
 * `inferred` is on the records in the unattributed stream, which is where everything else
 * goes rather than being guessed into somebody's history.
 */
export const ATTRIBUTION_LABELS: Record<CallAttribution, string> = {
  request_id: 'exact request id',
  unattributed: 'request id not resolved',
  agent: 'agent key',
  turn: 'tool block on the page',
  generation: 'the only chat generating',
  inferred: 'not placed in a chat'
};

export interface ToolCallRecord {
  callId: string;
  tool: string;
  attribution: CallAttribution;
  /** Normalized inbound HTTP x-request-id, retained for forensic correlation. */
  requestId: string | null;
  /** Conversation proven by that request id, or null when ownership was unresolved. */
  conversationId: string | null;
  /** New 1.8 calls use only these two deterministic outcomes. */
  attributionMethod: 'request_id' | 'unattributed';
  /** Exact arguments as JSON. Cut inline past the cap, with the whole text in an asset. */
  args: StoredText;
  result: StoredText;
  outcome: ToolOutcome;
  durationMs: number;
  summary: ActivitySummary;
  /** Files this call demonstrably changed, with line counts where computable. */
  changes?: FileChange[];
  assets?: AssetRef[];
}

export type MessageState = 'streaming' | 'final';

interface BaseEvent {
  /** 1-based, strictly increasing within a session. Ordering never relies on time. */
  seq: number;
  time: number;
  source: EventSource;
  /** Multi-agent attribution. Absent when no swarm is running. */
  agent?: string;
  /** ChatGPT's own turn id when the extension could read it. */
  turnId?: string;
}

export type SessionEvent =
  | (BaseEvent & { kind: 'session_start'; conversationId: string | null; title: string })
  | (BaseEvent & {
      kind: 'user_message';
      message: StoredText;
      messageId?: string;
      /** First sequence assigned to this stable website message; revisions keep this anchor. */
      origin?: number;
    })
  | (BaseEvent & {
      kind: 'assistant_message';
      message: StoredText;
      /**
       * Stable ChatGPT website identity used by the local canonical store.
       *
       * For streaming commentary this is an exact tuple of ChatGPT's parent/working-turn/
       * turn-exchange ids when those are available, so it remains stable even if React rotates
       * the child text-message UUID before the thought row mounts. Older page shapes with a
       * proven thought parent may use that thought `message.id`; a text object with no stronger
       * relation uses its own ChatGPT message id. Local turn ids, text prefixes and DOM
       * positions do not participate in this identity.
       */
      messageId?: string;
      /** ChatGPT's canonical rendered representation captured from the page. */
      renderedHtml?: StoredText;
      state?: MessageState;
      /** Compatibility mirror for older consumers; equivalent to state === 'final'. */
      final: boolean;
      /** First sequence assigned to this logical message; later revisions keep this anchor. */
      origin?: number;
    })
  /**
   * One visible ChatGPT commentary item, as it stood when this snapshot was taken.
   *
   * `progressId` is the identity of the *logical* item — one caption block the page keeps
   * growing — not of the snapshot. ChatGPT re-lays-out, reparents, shrinks and redraws that
   * block many times inside a turn, and treating each redraw as a new event is what put the
   * same sentence on screen a dozen times, split across duplicate rows. So a later snapshot
   * of the same item supersedes the earlier one instead of following it: readers keep the
   * newest text at the *earliest* record's position, which is both where the commentary
   * belongs chronologically and the only way one caption stays one row.
   *
   * `origin` names the seq of that earliest record, so a reader working from a cursor can
   * still place a supersession whose anchor it has already consumed. Both are optional: an
   * event written before this model existed, or by a page whose commentary had no readable
   * identity, is still a plain standalone caption.
   */
  | (BaseEvent & { kind: 'progress'; message: StoredText; progressId?: string; origin?: number })
  /**
   * Visible ChatGPT-native tool activity that never passed through this MCP server.
   *
   * `messageId` is ChatGPT's own thought/message identity for the activity. The rendered row
   * may be replaced entirely and its label may change from "Inspecting" to "Inspected";
   * neither affects identity. `origin` names the seq of the first record of that site object,
   * for readers working from a cursor that has already consumed it.
   */
  | (BaseEvent & { kind: 'page_tool'; messageId: string; label: string; origin?: number })
  | (BaseEvent & { kind: 'turn_start' })
  | (BaseEvent & { kind: 'turn_end'; outcome: TurnOutcome; detail?: string })
  | (BaseEvent & { kind: 'chat_error'; message: StoredText })
  | (BaseEvent & { kind: 'tool_call'; call: ToolCallRecord })
  | (BaseEvent & { kind: 'note'; message: StoredText })
  /**
   * A message routed between agents.
   *
   * Recorded twice and deliberately so: once in the sender's session when the broker
   * accepts it, once in the recipient's when the recipient acknowledges it. Without the
   * second one a worker's report would exist only in the worker's own history and the
   * volatile queue, so compacting the prime — the whole point of Compact & Resume while
   * workers keep running — would silently omit everything the workers had told it.
   * `messageId` is stable across both, so the pair can be matched and re-offers of the
   * same message never produce a second record.
   */
  | (BaseEvent & {
      kind: 'agent_message';
      messageId: string;
      from: string;
      to: string;
      message: StoredText;
      delivery: 'sent' | 'delivered';
    })
  | (BaseEvent & {
      kind: 'handoff';
      handoffId: string;
      chars: number;
      /** What triggered it: manual compaction, resume, or an automatic suggestion. */
      reason: string;
    });

export type SessionEventKind = SessionEvent['kind'];

/**
 * An event before the store assigns its sequence number.
 *
 * Written as a distributive conditional because a plain Omit over a union keeps only
 * the keys every member shares, which would silently reduce every event to its base
 * fields and let a caller append a tool_call with no call in it.
 */
export type NewSessionEvent = SessionEvent extends infer Event
  ? Event extends SessionEvent
    ? Omit<Event, 'seq'>
    : never
  : never;

/**
 * How a chat came to exist, when this app is the one that opened it.
 *
 * Recorded when the extension acknowledges that it typed the bootstrap into a fresh
 * tab, which is the first and only moment at which the app can connect the command it
 * queued to the conversation that command became.
 */
export interface SessionOrigin {
  kind: 'resume' | 'worker';
  /** The session this chat continues. Null when the source session no longer exists. */
  fromSessionId: string | null;
  /** Agent id for a worker chat ("worker-1"). Null for a resume. */
  agentId: string | null;
  /** The worker's task, verbatim from `agents action=spawn`. Empty for a resume. */
  task: string;
}

const RESUMED_PREFIX = 'Resumed · ';

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * The name to give a chat this app opened, in place of its bootstrap prompt.
 *
 * A resumed or worker chat opens with a long instruction this app typed itself, and
 * the ordinary "name a session after the first thing the user said" rule turned that
 * instruction into the session's name. The result was a list of near-identical rows
 * reading `Continue the previous ChatGPT ...` and `You are worker agent "worker-1"...`
 * with nothing in them to say which run a row belonged to. The command that opened the
 * chat already knows what the chat is for, so the name comes from there instead.
 */
export function originTitle(origin: SessionOrigin, source: string | null): string {
  if (origin.kind === 'worker') {
    const who = origin.agentId ?? 'worker';
    const task = clip(origin.task, 60);
    return task ? `${who} · ${task}` : who;
  }
  // A resumed chat is itself resumable, and often is. Stacking the prefix each time
  // would bury the part of the name that identifies the work.
  const from = clip((source ?? '').replace(new RegExp(`^(?:${RESUMED_PREFIX})+`), ''), 80);
  return from ? `${RESUMED_PREFIX}${from}` : 'Resumed session';
}

export interface SessionSummary {
  id: string;
  title: string;
  /**
   * The ChatGPT conversation this session is attached to *right now*.
   *
   * The local session is the durable identity; a ChatGPT chat is only the frontend
   * currently attached to it. Compact & Resume moves this from chat A to chat B in one
   * commit, and nothing else ever changes it.
   */
  conversationId: string | null;
  /**
   * Every ChatGPT conversation this session has lived in, oldest first, current last.
   *
   * Kept so a recorded history that spans a compaction can still be traced back to the
   * chats it was written in, and so a stale tab reporting for a superseded conversation
   * can be recognised rather than silently filed as if nothing had moved.
   */
  chatIds: string[];
  startedAt: number;
  updatedAt: number;
  /** Null while the session is still the active one. */
  endedAt: number | null;
  events: number;
  userMessages: number;
  toolCalls: number;
  errors: number;
  /** Rough local estimate for the whole session — never ChatGPT's private counter. */
  estimatedTokens: number;
  /**
   * The same estimate, but only for what the *currently attached* ChatGPT chat is carrying.
   *
   * This is what the composer meter fills against and what automatic compaction fires on,
   * and it is why one durable session surviving a compaction does not mean an ever-rising
   * meter: the rebind into chat B resets this to zero while `estimatedTokens` keeps
   * counting the session's whole life. Chat B genuinely starts with only the handoff in
   * its context, so measuring it against the session's lifetime total would re-fire
   * compaction immediately after every compaction.
   */
  contextTokens: number;
  /**
   * When this chat's one automatic compaction was claimed, or null while it still has one.
   *
   * The whole durable state of automatic compaction, because the rest of the rule is read
   * live rather than remembered: the chat is over `contextTokens`, and the model is working
   * *right now*. Set before the browser is touched, so a failed or abandoned attempt can
   * never become a retry loop, and reset when Compact & Resume attaches this session to a
   * fresh ChatGPT conversation — a new chat gets a new budget and a new trigger.
   */
  autoCompactTriggeredAt: number | null;
  /** Id of the newest stored handoff, or null when the session was never compacted. */
  lastHandoffId: string | null;
  lastHandoffAt: number | null;
  /**
   * Handoff that positively became the opening user message of the currently attached resumed
   * chat, or null when no successful Compact & Resume has been durably proven.
   *
   * Distinct from `lastHandoffId`: a handoff is published as soon as capture is durable, before
   * the replacement-chat rebind commits. A later aborted compaction may therefore advance
   * `lastHandoffId` without ever becoming ChatGPT context. This field moves only with the same
   * atomic metadata write that moves `conversationId` to the replacement chat.
   */
  lastCommittedResumeHandoffId?: string | null;
  /** Outcome of the most recent finished turn. */
  lastTurnOutcome: TurnOutcome | null;
  /** Durable open-turn projection. Undefined only on pre-1.8.8 metadata. */
  activeTurnId?: string | null;
  /** Agents seen in this session, prime first. Empty when no swarm ran. */
  agents: string[];
  /** Set only for a chat this app opened itself. Null for one the user started. */
  origin: SessionOrigin | null;
}

export interface Handoff {
  id: string;
  sessionId: string;
  createdAt: number;
  /** The continuation brief itself. */
  text: string;
  /** How the raw session looked when this was made, for honest staleness reporting. */
  sourceEvents: number;
  sourceTokens: number;
  /** Set when the model stopped early or the pack dropped material. */
  notes: string[];
}

// ---------------------------------------------------------------- agents

export type AgentRole = 'prime' | 'worker';
/**
 * Where an agent is in its life, and — for `detached` — where its *browser view* is.
 *
 * `detached` is the state that separates the two. A ChatGPT turn runs on OpenAI's servers,
 * so closing the tab of a worker that is mid-task stops nothing: its tool calls keep
 * arriving here, correlated to the same conversation by the same request id. Treating the
 * closed tab as the end of the worker was reading the browser's lifecycle as if it were the
 * turn's. A detached worker is still working, still holds its slot, still has an inbox, and
 * can still report; it only sleeps once it has also gone quiet.
 *
 * `sleeping` is the state that makes a worker reusable rather than disposable.
 *
 * A worker used to be a one-shot job: it reported, its slot was a tombstone, and the only
 * way to get more work done was another `spawn` — another ChatGPT conversation, thrown away
 * again a few minutes later. That is both what ChatGPT itself pushes back on and a waste of
 * everything the worker had already learned about the task. So the end of a worker's *turn*
 * is no longer the end of the worker: it goes to sleep in the chat it already has, keeping
 * its conversation, its transcript, its workspace and its inbox. The prime wakes it by
 * messaging it, and the app reopens that exact chat and types the message into it.
 *
 * A sleeping worker holds no slot — that is the whole point of the state — so a run can
 * accumulate more sleeping workers than `maxWorkers` while never having more than
 * `maxWorkers` of them awake at once.
 *
 * `waking` is the short window between the prime's message being accepted and the app
 * proving it typed that message into the worker's chat. It holds the slot the revival
 * reserved, so two revivals cannot claim the same one; a revival that fails puts the worker
 * back to sleep and gives the slot back.
 *
 * `finished` and `failed` remain the two terminal states, and a worker only reaches
 * `finished` once its own chat has grown past the context ceiling: past that point there is
 * nothing left to reuse, so the next time it stops working it stops for good.
 */
export type AgentState =
  | 'invited'
  | 'active'
  | 'detached'
  | 'waking'
  | 'sleeping'
  | 'finished'
  | 'failed';

export interface AgentInfo {
  id: string;
  role: AgentRole;
  label: string;
  task: string;
  state: AgentState;
  createdAt: number;
  /**
   * When the app bound this agent to its conversation and started it.
   *
   * Set by the app, never by the model: a worker is activated by the extension reporting the
   * chat it opened for the slot, which happens before that chat has said anything.
   */
  activatedAt: number | null;
  finishedAt: number | null;
  /** Result text the worker reported when it finished. */
  result: string | null;
  /** Messages waiting for this agent, including offered-but-unacknowledged ones. */
  pending: number;
  /** Of those, how many have gone out at least once and are awaiting proof of receipt. */
  awaitingAck: number;
  /** Messages this agent has demonstrably received. */
  delivered: number;
  /**
   * The ChatGPT conversation this agent is running in.
   *
   * For the prime this is the run's identity and is set exactly once, by a successful
   * spawn; it moves only through the app's authenticated Compact & Resume transfer. For a
   * worker it is reported first-hand by the extension that opened the tab, and is what
   * lets `join` answer from the conversation the call came from.
   */
  conversationId: string | null;
  /**
   * When this agent's last ChatGPT view went away, while the agent itself did not.
   *
   * Set with `detached`, cleared on revival. Only the browser is gone at this point: the
   * ChatGPT turn is server-side and may still be issuing tool calls.
   */
  detachedAt: number | null;
  /**
   * The last moment this app had first-hand evidence that this agent's conversation exists.
   *
   * Exactly two things stamp it: an MCP call proved by the request-id correlation, and the
   * agent's own page reporting to the bridge. One clock, so a worker whose tab is open is
   * never on the silence clock at all. It is what revives a detached agent, and — when it
   * stops advancing — what eventually ends one nobody can see any more.
   */
  lastSeenAt: number | null;
  /**
   * Whether this agent can be brought back — by the prime, or by its own next call.
   *
   * True for every sleeping worker under the context ceiling, and for one that ended for a
   * reason that says nothing about the turn itself (its chat was closed, or it went quiet
   * after that). False for a worker whose tab never opened, one a person cleared, and one
   * whose chat crossed the ceiling, which is what makes that crossing terminal.
   */
  revivable: boolean;
  /**
   * Bridge command id of the most recent revival whose user message ChatGPT accepted.
   *
   * This is crash-recovery evidence for the narrow window where the worker snapshot was
   * fsynced but the bridge command receipt was not. It is never used to decide whether a worker
   * may be revived; it only makes a retry of that exact browser ACK idempotent.
   */
  lastRevivalCommandId?: string | null;
  /**
   * When this agent last stopped working without ending, or null.
   *
   * Distinct from `finishedAt`, which is only ever set by a terminal state. A worker that
   * has slept three times and been woken twice has a `sleptAt` and no `finishedAt` at all.
   */
  sleptAt: number | null;
  /**
   * This chat's own estimated context, as the local session store measures it.
   *
   * Never a number a model reported: it is the same estimate the composer meter fills
   * against, read off the durable session that records this exact conversation. It is what
   * decides whether a worker is still worth reviving — see {@link revivable}.
   */
  contextTokens: number;
}

/**
 * One brokered message, with delivery tracked at-least-once — within a stated limit.
 *
 * Marking a message delivered at the moment it is written into a tool result would be
 * a lie the moment the connector drops between the result being built and ChatGPT
 * receiving it — a failure this project has already reproduced — and the message would
 * be gone for good. So a message is only *offered* when it goes out, and retired when
 * the recipient proves it got it by making another authenticated call. The cost is
 * that a message can be shown twice; `id` is stable so the model and the recorder can
 * both tell a repeat from a new message, and a repeat is much cheaper than a loss.
 *
 * The limit, stated rather than glossed: another authenticated call is *evidence* that
 * the previous result arrived, not proof of it. The connector supplies no session id and
 * no request identity (see transportIdentityStatus), so a retry of a call whose result
 * was lost is indistinguishable from the next call of one that arrived — and retirement
 * on that call would drop a message the model never saw. `offeredOnFinish` narrows the
 * one place where that is unrecoverable rather than merely annoying.
 */
export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  time: number;
  text: string;
  /** When it was last written into a tool result. Re-offered until acknowledged. */
  offeredAt: number | null;
  /** How many times it has been offered, so a repeat can be labelled as one. */
  offers: number;
  /**
   * Last written into a result for a `finish_agent` call.
   *
   * That is the one call an agent repeats verbatim when its result goes missing, and the
   * one whose next call therefore proves nothing — a finish that never came back is
   * answered by another finish. Retiring on it would hand the agent's own retry as
   * evidence that it read something it never saw, and then terminalise it. So a message
   * carrying this flag is not retired by a finish; it is re-offered, and only an ordinary
   * tool call — the kind an agent makes because it went back to work — retires it.
   */
  offeredOnFinish: boolean;
  /**
   * This row was delivered by the browser as a real user message while reviving a sleeping
   * worker, rather than merely being copied into an MCP result.
   *
   * That distinction is durable and stronger than an ordinary offer. Once ChatGPT accepted
   * the injected user message, replaying the same row through the worker's next tool result
   * would duplicate the prime's instruction inside one turn. A later authenticated worker call
   * may acknowledge the row, but the broker must never *offer* it again, including after an app
   * restart where ordinary result offers deliberately become uncertain and are reset.
   */
  offeredViaRevival: boolean;
  /** Set once the recipient has demonstrably received it. */
  ackedAt: number | null;
}

export interface SwarmState {
  enabled: boolean;
  /** True while at least one worker is invited or active. */
  running: boolean;
  /**
   * Local-app presentation hint: worker histories exist but are parked outside the active run.
   * Caller/model status remains scoped separately and never uses this to reveal another owner.
   */
  retainedHistory?: boolean;
  agents: AgentInfo[];
}

/**
 * The result of the user clearing one agent row in the app.
 *
 * `cleared` is what actually happened, not what was asked for: clearing the prime ends the
 * whole run, clearing a worker frees that one slot, and clearing a row that had already
 * ended does nothing at all. The UI reports this rather than assuming the click worked.
 */
export interface ClearAgentResult {
  cleared: 'run' | 'worker' | 'none';
  reason: string;
  swarm: SwarmState;
}

// ---------------------------------------------------------------- helpers

/**
 * Rough token estimate for locally held text.
 *
 * Four characters per token is the usual English approximation. It is deliberately
 * not presented as ChatGPT's context counter: hidden reasoning, system prompts and
 * the tool schema are all invisible from here, so the number is only ever used to
 * suggest compaction, never to claim a limit was reached.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Token weight of one stored event, using the text we actually kept. */
export function eventTokens(event: SessionEvent): number {
  switch (event.kind) {
    case 'user_message':
    case 'assistant_message':
    case 'chat_error':
    case 'note':
      return estimateTokens(event.message.text);
    case 'progress':
      // Live progress/reasoning captions are useful audit evidence but are not stable
      // conversation context, and often restate work that later appears in the final
      // assistant message. Counting every transient caption made the advisory meter
      // roughly double what users saw in the actual conversation on tool-heavy turns.
      return 0;
    case 'agent_message':
      // Real context, unlike a progress caption: a brokered message is appended to a tool
      // result the model actually reads, so it occupies the conversation the same way a
      // tool result does. Leaving it at zero made the meter under-report exactly the runs
      // most likely to need compacting — the multi-agent ones.
      return estimateTokens(event.message.text);
    case 'tool_call':
      return (
        estimateTokens(event.call.args.text) +
        estimateTokens(event.call.result.text) +
        estimateTokens(event.call.summary.title)
      );
    case 'handoff':
      return 0;
    default:
      return 0;
  }
}

/**
 * Collapses every stored snapshot of one page-observed item back into one event.
 *
 * The recorder writes a `progress` or `page_tool` event again whenever the thing it is
 * watching has changed on screen. That is the honest thing to store — an append-only log
 * cannot rewrite a line it has already written — but it is not what anything should
 * *display*: one caption that grew four times is one caption, not four, and one activity
 * row whose label was rewritten as it finished is one step, not two. Rendering the
 * snapshots as siblings is exactly the duplicated-and-reordered transcript this fold
 * exists to undo.
 *
 * The surviving event keeps the *first* snapshot's position (seq, time, turn, agent) and
 * the *last* snapshot's text. Position first, because the thing happened when it first
 * appeared — placing it at the newest snapshot would drag it below tool calls it actually
 * preceded, which is the other half of the same bug. Snapshots with no identity are left
 * exactly as they are: nothing about them says they belong together.
 *
 * Identity is namespaced by kind. A `progressId` and a `messageId` are minted by different
 * code paths and are not required to be disjoint; folding them into one keyspace would let
 * a caption swallow an activity row that happened to be named the same thing.
 */
export function foldProgress(events: readonly SessionEvent[]): SessionEvent[] {
  const anchor = new Map<string, number>();
  const out: Array<SessionEvent | null> = [...events];
  for (let index = 0; index < out.length; index++) {
    const event = out[index];
    if (!event) continue;
    let key: string | null = null;
    if (event.kind === 'progress' && event.progressId) key = `progress\u0000${event.progressId}`;
    else if (event.kind === 'page_tool' && event.messageId) key = `page_tool\u0000${event.messageId}`;
    if (!key) continue;
    const at = anchor.get(key);
    if (at === undefined) {
      anchor.set(key, index);
      continue;
    }
    const held = out[at];
    if (held && held.kind === 'progress' && event.kind === 'progress') {
      out[at] = { ...held, message: event.message };
    } else if (held && held.kind === 'page_tool' && event.kind === 'page_tool') {
      out[at] = { ...held, label: event.label };
    }
    out[index] = null;
  }
  return out.filter((event): event is SessionEvent => event !== null);
}

export interface TokenPressure {
  estimated: number;
  advisory: number;
  limit: number;
  level: 'ok' | 'large' | 'huge';
}

export function tokenPressure(estimated: number, advisory: number, limit: number): TokenPressure {
  return {
    estimated,
    advisory,
    limit,
    level: estimated >= limit ? 'huge' : estimated >= advisory ? 'large' : 'ok'
  };
}
