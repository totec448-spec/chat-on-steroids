/**
 * The order a recorded turn is *read* in, which is not the order it was written in.
 *
 * A tool call is only handed to the recorder once its tool has finished and its attribution
 * has resolved, so it is appended late — but it is stamped with `startedAt`, because that is
 * when it happened. Everything the page observed in the meantime already has a lower `seq`.
 * Reading the log by `seq` therefore shows a call after the commentary it ran underneath, and
 * a slow call after the `turn_end` of the turn that made it: `2026-01-01-00000017` seq 390,
 * `time` 1786982781914, sits after a `turn_start` stamped 1786982783350 — a second and a half
 * in the future of the row above it.
 *
 * The fix is not to sort the log by time. `seq` is the append order and the cursor domain,
 * and it has to stay immutable and gap-free or incremental delivery breaks. And a global
 * sort by time would be actively wrong: a reloaded page re-reports the transcript it can see,
 * and those events carry the time they were *observed*, not the time they were said, so
 * sorting the whole log by time drags days-old history into the middle of the live turn.
 *
 * So ordering is turn-local. A turn this log opened is a durable, bounded group — everything
 * in it carries the same generation id, which the extension mints per turn — and inside that
 * group the recorded times are all live observations of one run, directly comparable. Outside
 * it nothing moves: unowned messages and events retain their recorded position. Store reads
 * carry the owning start as presentation metadata even when it lies outside the loaded page.
 *
 * Both consumers use this. The desktop transcript and the stream the extension injects back
 * into ChatGPT are the same record, and they must not be able to disagree about its order.
 */

/** The minimum an entry needs to be placed. Both consumers' shapes satisfy it structurally. */
export interface Chronological {
  seq: number;
  /** First position of a mutable canonical item; seq may be its newer revision cursor. */
  origin?: number;
  /** When the item logically happened: `startedAt` for a call, first appearance for prose. */
  time: number;
  /** Provider creation time is presentation metadata, never an execution clock. */
  authoredAt?: number;
  /** Recorded owning start, supplied before pagination; null means no proven group. */
  turnOrigin?: number | null;
  messageId?: string;
  inputId?: string;
  kind: string;
  source?: string;
  agent?: string;
  call?: { requestId?: string | null; conversationId?: string | null; attribution?: string };
  turnId?: string | null;
  /** ChatGPT's own terminal flag for the one message that ended a turn. See `closing()`. */
  final?: boolean;
  state?: string;
}

export type TimelineTurns = Record<string, {
  origin: number; time: number; endTime?: number; endOrigin?: number;
  questionId?: string;
  /** Another document observed the same exact request while this response was open. */
  responseTurnId?: string;
}>;

export interface TurnIdentity {
  timelineTurns?: TimelineTurns;
  requestTurns?: RequestTurns;
  /** Latest native question, excluding instructions handed out inside tool results. */
  nativeQuestion?: { messageId: string; origin: number } | null;
}

export function injectedUserMessage(entry: Chronological, turns?: TimelineTurns): boolean {
  // Browser-delivered app messages also retain inputId, and their native echo
  // can carry a provider turn id. Only the tool-input key or a recorded local
  // generation establishes injection; inputId alone is not transport evidence.
  return entry.kind === 'user_message' && !!entry.inputId &&
    (entry.messageId?.startsWith('input:') === true ||
      (!!entry.turnId && !!turns && Object.hasOwn(turns, entry.turnId)));
}

/** The journal keeps document-local ids; this derived relation names their one response. */
export function responseTurnId(turns: TimelineTurns | undefined, id: string): string {
  const turn = turns?.[id], owner = turn?.responseTurnId;
  return owner && turns?.[owner] && turns[owner].origin < turn.origin ? owner : id;
}

/** Only usable alongside a matching, exactly attributed request. A question alone is
 * insufficient: retries after an end and different native questions remain distinct. */
export function overlappingRequestTurns(
  turns: TimelineTurns | undefined, left: string, right: string, requests: RequestTurns | undefined, requestId: string
): boolean {
  if (!turns) return false;
  const first = responseTurnId(turns, left), second = responseTurnId(turns, right);
  const a = turns[first], b = turns[second];
  if (!a || !b || !a.questionId || a.questionId !== b.questionId) return false;
  // A late old call can arrive while Regenerate is already answering the same
  // question. Its new request is positive evidence of a different response,
  // even if the earlier document has not published its end yet.
  if (first !== second && Object.entries(requests ?? {}).some(([id, owner]) => id !== requestId && owner &&
      [first, second].includes(responseTurnId(turns, owner.turnId)))) return false;
  const earlier = a.origin <= b.origin ? a : b, later = earlier === a ? b : a;
  return earlier.endOrigin === undefined || later.origin < earlier.endOrigin;
}

/** Store-owned, rebuildable identity projection. Raw events and MCP attribution stay intact. */
export function applyTurnIdentity(identity: TurnIdentity, event: Chronological): void {
  const origin = positionOf(event);
  if (event.kind === 'user_message' && event.messageId && !injectedUserMessage(event, identity.timelineTurns) &&
      (!identity.nativeQuestion || origin > identity.nativeQuestion.origin)) {
    identity.nativeQuestion = { messageId: event.messageId, origin };
  }
  let turns = identity.timelineTurns ?? {};
  if (event.turnId && event.kind === 'turn_start' && !Object.hasOwn(turns, event.turnId)) {
    identity.timelineTurns = turns = { ...turns, [event.turnId]: { origin, time: event.time,
      ...(identity.nativeQuestion ? { questionId: identity.nativeQuestion.messageId } : {}) } };
  } else if (event.turnId && event.kind === 'turn_end' && turns[event.turnId]) {
    const start = turns[event.turnId]!;
    identity.timelineTurns = turns = { ...turns, [event.turnId]: { ...start,
      endTime: Math.max(start.endTime ?? 0, event.time), endOrigin: Math.min(start.endOrigin ?? Infinity, origin) } };
  }
  if (event.kind !== 'tool_call' || event.source !== 'mcp' || !event.turnId ||
      event.call?.attribution !== 'request_id' || !event.call.requestId || !event.call.conversationId) return;
  const { requestId, conversationId } = event.call;
  const requests = identity.requestTurns ?? {};
  const held = recordedRequestTurn(requests, requestId, conversationId);
  let owner = responseTurnId(turns, event.turnId);
  if (held && responseTurnId(turns, held.turnId) !== owner) {
    if (!overlappingRequestTurns(turns, held.turnId, owner, requests, requestId)) {
      identity.requestTurns = { ...requests, [requestId]: null };
      return;
    }
    const prior = responseTurnId(turns, held.turnId);
    const earlier = turns[prior]!.origin <= turns[owner]!.origin ? prior : owner;
    const later = earlier === prior ? owner : prior;
    const joined = { ...turns };
    for (const [id, turn] of Object.entries(turns)) {
      if (id === later || turn.responseTurnId === later) joined[id] = { ...turn, responseTurnId: earlier };
    }
    identity.timelineTurns = turns = joined;
    owner = earlier;
  }
  if (held === null) {
    if (requests[requestId] !== null) identity.requestTurns = { ...requests, [requestId]: null };
    return;
  }
  if (held && held.turnId === owner && held.origin <= origin) return;
  identity.requestTurns = { ...requests, [requestId]: {
    turnId: owner, conversationId, origin: Math.min(held?.origin ?? Infinity, origin)
  } };
}

/** Derived from exact, already turn-owned MCP records. Null retains contradictory proof. */
export type RequestTurns = Record<string, { turnId: string; conversationId: string; origin: number } | null>;

/** Undefined is unobserved; null is conflicting. Neither grants a turn or a conversation. */
export function recordedRequestTurn(
  requests: RequestTurns | undefined, requestId: string | null | undefined, conversationId: string | null | undefined
): RequestTurns[string] | undefined {
  if (!requestId || !requests || !Object.hasOwn(requests, requestId)) return undefined;
  const owner = requests[requestId];
  return owner && owner.conversationId === conversationId ? owner : null;
}

/** The older canonical assistant key already contains this exact provider timestamp. */
export function authoredTimeOf(entry: Chronological): number | undefined {
  if (Number.isFinite(entry.authoredAt) && entry.authoredAt! > 0) return entry.authoredAt;
  if (entry.kind !== 'assistant_message') return undefined;
  const id = entry.messageId?.match(/^assistant:([a-f0-9-]{36})?:([a-f0-9-]{36})?:(\d{13})$/i);
  return id && (id[1] || id[2]) ? Number(id[3]) : undefined;
}

/** Both canonical formats retain the native response's working/exchange UUIDs.
 * The parent or creation stamp identifies a message inside it, not another response. */
function assistantResponseKey(entry: Chronological): string | undefined {
  if (entry.kind !== 'assistant_message' || entry.source !== 'extension') return undefined;
  const parts = entry.messageId?.split(':');
  if (parts?.length !== 4 || parts[0] !== 'assistant') return undefined;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const timestamped = /^\d{13}$/.test(parts[3]!);
  if (!timestamped && !uuid.test(parts[1]!)) return undefined;
  const working = parts[timestamped ? 1 : 2]!, exchange = parts[timestamped ? 2 : 3]!;
  if (!uuid.test(working) || !uuid.test(exchange)) return undefined;
  return `${entry.agent ?? ''}\u0000${working.toLowerCase()}:${exchange.toLowerCase()}`;
}

/** Attach the session's recorded boundaries before selecting/rendering a small page.
 * These fields affect presentation only; seq, origin, time and turnId stay untouched. */
export function projectTimeline<T extends Chronological>(
  entries: readonly T[], turns: TimelineTurns = {}, requests: RequestTurns = {},
  messages: Iterable<Chronological> = entries
): T[] {
  const starts = Object.values(turns).sort((a, b) => a.origin - b.origin);
  // Reload can lose the document-local owner of later public prose. An earlier
  // canonical message of that exact native response still proves its display group.
  // Resolve from all canonical messages, including anchors/conflicts outside this
  // page. This neither coalesces sibling messages nor grants a lifecycle turnId.
  const responses = new Map<string, TimelineTurns[string] | null>();
  for (const message of messages) {
    if (!message.turnId) continue;
    const key = assistantResponseKey(message);
    if (!key) continue;
    const boundary = turns[responseTurnId(turns, message.turnId)] ?? null;
    if (!responses.has(key)) responses.set(key, boundary);
    else if (!boundary || responses.get(key)?.origin !== boundary.origin) responses.set(key, null);
  }
  return entries.map(entry => {
    let boundary = entry.turnId ? turns[responseTurnId(turns, entry.turnId)] : undefined;
    if (!entry.turnId) {
      const response = assistantResponseKey(entry);
      if (response) boundary = responses.get(response) ?? undefined;
    }
    // Older recorders dropped the local turn after its end. Its earlier exact request
    // proof still places the call, including when that proof lies outside this page.
    const requestOwner = !entry.turnId && entry.kind === 'tool_call' && entry.source === 'mcp' && entry.call?.attribution === 'request_id'
      ? recordedRequestTurn(requests, entry.call.requestId, entry.call.conversationId) : undefined;
    if (requestOwner) boundary = turns[responseTurnId(turns, requestOwner.turnId)];
    if (!boundary && requestOwner === undefined && !entry.turnId && entry.kind !== 'user_message' && entry.kind !== 'assistant_message' && entry.kind !== 'native_image') {
      let low = 0, high = starts.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (starts[mid]!.origin < positionOf(entry)) low = mid + 1; else high = mid;
      }
      const candidate = starts[low - 1];
      if (candidate && (candidate.endTime === undefined || entry.time <= candidate.endTime)) boundary = candidate;
    }
    const authoredAt = authoredTimeOf(entry);
    return { ...entry, turnOrigin: boundary?.origin ?? null, ...(authoredAt !== undefined ? { authoredAt } : {}) };
  });
}

/** Where an entry sits in the log: its first appearance if it has revisions, else its seq. */
export function positionOf(entry: Chronological): number {
  return typeof entry.origin === 'number' && Number.isFinite(entry.origin) ? entry.origin : entry.seq;
}

/**
 * The assistant message that ended a turn, if this group holds one.
 *
 * A message carries the `create_time` ChatGPT stamped when it *opened* that message, and
 * ChatGPT can open the final answer and still run another connector call before the prose is
 * written. Session `2026-01-01-00000019` is the live case: the answer of turn `…-1-9` is
 * stamped 08:40:34, with `write_stdin` at 08:40:37 and `git show` at 08:40:42 after it. Order
 * that group by time alone and two tool rows are drawn *underneath* the finished answer —
 * which is neither what ChatGPT itself shows nor a thing that can have happened.
 *
 * The message that ended a turn is the last thing in that turn by definition: nothing else in
 * the turn can follow the message that closed it. So it is placed there, rather than trusted
 * to a timestamp that describes when it was opened.
 *
 * Only one message per group moves, the one furthest along the log. A turn re-observed after a
 * reload can have every message marked final, and interim prose must keep interleaving with
 * the tool calls it ran between — the terminal message is the only one whose position is a
 * matter of definition rather than observation.
 */
function closing<T extends Chronological>(group: readonly T[]): T | null {
  let found: T | null = null;
  for (const entry of group) {
    if (entry.kind !== 'assistant_message') continue;
    if (entry.final !== true && entry.state !== 'final') continue;
    if (!found || positionOf(entry) > positionOf(found)) found = entry;
  }
  return found;
}

/**
 * Reorders one window of recorded events for reading.
 *
 * Stable, total and deterministic: equal times fall back to `seq`, so nothing depends on the
 * order the window happened to arrive in and re-running it on a rebuilt window gives the same
 * answer. Never mutates the input.
 */
export function chronological<T extends Chronological>(entries: readonly T[]): T[] {
  const position = (entry: T): number => positionOf(entry);
  const bySeq = [...entries].sort((a, b) => position(a) - position(b) || a.seq - b.seq);
  // A page retains the durable start even when the start row is outside its window.
  // Old callers with no projection still use only boundaries they actually hold.
  const anchors = new Map<string, number>();
  // Where each opened turn stops, so an event that names no turn can be told whether it
  // happened inside one. A turn still running has no end and holds everything after it.
  const ends = new Map<number, number>();
  for (const entry of bySeq) {
    // A new delta can join this exact local turn to an earlier response origin.
    // Apply the store's monotonic proof to older rows already resident in the UI.
    if (entry.turnId && Number.isFinite(entry.turnOrigin))
      anchors.set(entry.turnId, Math.min(anchors.get(entry.turnId) ?? Infinity, entry.turnOrigin!));
    if (entry.kind === 'turn_start' && entry.turnId && !anchors.has(entry.turnId)) {
      anchors.set(entry.turnId, position(entry));
    }
  }
  for (const entry of bySeq) {
    if (entry.kind === 'turn_end' && entry.turnId) {
      const anchor = anchors.get(entry.turnId);
      if (anchor !== undefined) ends.set(anchor, Math.max(ends.get(anchor) ?? 0, entry.time));
    }
  }

  // Position within a turn. The boundaries are the boundaries whatever their timestamps say:
  // a turn cannot begin after its own first observation or end before its last, and the times
  // on those two events are the moment the page noticed, not the moment the turn moved. The
  // message that ended the turn sits between the two for the same reason — see `closing()`.
  const rank = (entry: T, ends: T | null): number =>
    entry.kind === 'turn_start' ? -1 : entry.kind === 'turn_end' ? 1 : entry === ends ? 0.5 : 0;

  // An entry with no usable time is ordered by its stable position (`origin` for a mutable
  // canonical item, otherwise `seq`) rather than being flung to one end of its turn: a
  // missing timestamp is not evidence about when the thing happened.
  const byTime = (a: T, b: T): number => {
    const apart = (authoredTimeOf(a) ?? a.time) - (authoredTimeOf(b) ?? b.time);
    return Number.isFinite(apart) && apart !== 0
      ? apart
      : position(a) - position(b) || a.seq - b.seq;
  };

  const groups = new Map<number, T[]>();
  // The previous implementation found the open turn for every untagged event by rescanning
  // `bySeq` from the beginning. A long session with many app-authored/untagged rows therefore
  // became O(n²) and could freeze Electron's main process for tens of seconds. `bySeq` is
  // already ordered, so carry the latest start from strictly earlier positions forward once.
  // Starts sharing the same canonical position are intentionally activated only when the
  // position advances, matching the old `position(candidate) >= position(entry)` boundary.
  let activeAnchor: number | undefined;
  let pendingAnchor: number | undefined;
  let currentPosition: number | undefined;
  for (const entry of bySeq) {
    const entryPosition = position(entry);
    if (currentPosition === undefined || entryPosition !== currentPosition) {
      if (pendingAnchor !== undefined) activeAnchor = pendingAnchor;
      pendingAnchor = undefined;
      currentPosition = entryPosition;
    }
    let inferredAnchor: number | undefined;
    if (entry.turnOrigin !== null && !entry.turnId && entry.kind !== 'user_message' && activeAnchor !== undefined) {
      const end = ends.get(activeAnchor);
      if (end === undefined || entry.time <= end) inferredAnchor = activeAnchor;
    }
    const anchor = (entry.turnId ? anchors.get(entry.turnId) : undefined) ?? entry.turnOrigin ?? inferredAnchor ?? entryPosition;
    const held = groups.get(anchor);
    if (held) held.push(entry);
    else groups.set(anchor, [entry]);
    if (entry.kind === 'turn_start' && entry.turnId) pendingAnchor = anchors.get(entry.turnId);
  }

  const out: T[] = [];
  for (const anchor of [...groups.keys()].sort((a, b) => a - b)) {
    const group = groups.get(anchor)!;
    const ends = closing(group);
    group.sort((a, b) => rank(a, ends) - rank(b, ends) || byTime(a, b));
    out.push(...group);
  }
  return out;
}
