import type { SessionEvent } from '../shared/session.js';
import type { TurnTrace } from '../shared/turn-trace.js';

/**
 * How a timeline reads a turn's work: in rounds, the way ChatGPT draws them.
 *
 * A round is what the model says before a step (`say`), the step's activity (`work`: this app's
 * calls, ChatGPT's own steps, messages between agents), and the one-line recap ChatGPT closes it
 * with, which titles that activity. Prose and recaps come from the turn's outline
 * (shared/turn-trace.ts) when it was recorded; a turn without one falls back to its recorded
 * interim messages and native steps, in their recorded order.
 *
 * This module is pure: it decides structure and stable keys from recorded data and nothing else.
 * Rows outside a turn's work (your messages, answers, errors, compactions, turn lines) pass
 * through untouched and in order.
 */

/** One row of the flat timeline, in display order. Rows without an event are app-drawn (turn lines, compactions, inputs). */
export interface FlowRow {
  key: string;
  event?: SessionEvent;
  /** The app's line that closes a working timeline (what the turn does right now); work goes before it. */
  tail?: boolean;
}

export type RoundPart =
  /** A row outside any turn's work, unchanged. */
  | { kind: 'row'; key: string }
  /** What the model said between steps: a recorded interim message (`rowKey`) or the outline's text. */
  | { kind: 'say'; key: string; rowKey?: string; text?: string; turnId?: string }
  /**
   * One round's activity. `recap` is ChatGPT's own line for it when the round is closed; `live` is
   * the open round of a turn still working. `rows` keep their recorded order.
   */
  | { kind: 'work'; key: string; rows: string[]; recap: string | null; live: boolean; turnId?: string };

/** Whether a row belongs to a turn's work rather than standing on its own. `answers` are the messages outlines name as a turn's answer. */
export function isActivity(event: SessionEvent | undefined, answers: ReadonlySet<string> = new Set()): boolean {
  if (!event) return false;
  // An answer still being written is not yet final, but it is the answer, not one more sentence.
  if (event.kind === 'assistant_message' && ((event.providerMessageId && answers.has(event.providerMessageId)) ||
      (event.messageId && answers.has(event.messageId)))) return false;
  if (event.kind === 'tool_call' || event.kind === 'page_tool' || event.kind === 'agent_message') return true;
  // ChatGPT's own phase captions belong to the work; the app's notes and approval rows stand alone.
  if (event.kind === 'progress') return event.source !== 'app' && !event.progressId?.startsWith('approval');
  return event.kind === 'assistant_message' && !event.final && event.state !== 'final';
}

/** Text as a reader compares it: page escapes undone, whitespace folded. */
function plain(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, '$1').replace(/\s+/g, ' ').trim();
}

/** The same sentence, or one still growing into the other. */
function sameSaying(a: string, b: string): boolean {
  const x = plain(a), y = plain(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 24 && long.startsWith(short);
}

/** The turn a run of activity belongs to: the one most of its rows name. */
function runTurn(run: FlowRow[]): string | undefined {
  const counts = new Map<string, number>();
  for (const row of run) {
    const id = row.event?.turnId;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best: string | undefined, most = 0;
  for (const [id, count] of counts) if (count > most) { best = id; most = count; }
  return best;
}

function isCall(row: FlowRow): boolean {
  return row.event?.kind === 'tool_call' && row.event.call.nested !== true;
}

/** How far apart a call may first show on the page and start here and still be the same call. */
const SAME_CALL_MS = 90_000;

/**
 * Which recorded call each outline call is. ChatGPT can show a call that never reached this app
 * (a retry, a call that failed on its side), so the outline's calls are matched to the recorded ones
 * as the longest alignment that keeps both orders and agrees on the tool, preferring, between equally
 * long ones, calls that started when the page first showed them. Returns outline index -> row.
 */
function alignCalls(trace: TurnTrace, calls: FlowRow[]): Map<number, FlowRow> {
  const slots = trace.flatMap((item, index) => item.kind === 'call' ? [{ index, item }] : []);
  const n = slots.length, m = calls.length;
  const start = (row: FlowRow) => row.event?.kind === 'tool_call' ? row.event.time : undefined;
  const fits = (i: number, j: number): number | null => {
    const { item } = slots[i]!;
    const event = calls[j]!.event;
    if (event?.kind !== 'tool_call' || (item.tool && item.tool !== event.call.tool)) return null;
    const began = start(calls[j]!);
    if (item.at === undefined || began === undefined) return 0;
    const apart = Math.abs(item.at - began);
    return apart <= SAME_CALL_MS ? apart : null;
  };
  // best[i][j]: the alignment of slots i.. with calls j..: [matches, -distance].
  const count: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const better = (c1: number, d1: number, c2: number, d2: number) => c1 > c2 || (c1 === c2 && d1 < d2);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      let c = count[i + 1]![j]!, d = cost[i + 1]![j]!;
      if (better(count[i]![j + 1]!, cost[i]![j + 1]!, c, d)) { c = count[i]![j + 1]!; d = cost[i]![j + 1]!; }
      const fit = fits(i, j);
      if (fit !== null && better(1 + count[i + 1]![j + 1]!, fit + cost[i + 1]![j + 1]!, c, d)) {
        c = 1 + count[i + 1]![j + 1]!; d = fit + cost[i + 1]![j + 1]!;
      }
      count[i]![j] = c; cost[i]![j] = d;
    }
  }
  const out = new Map<number, FlowRow>();
  for (let i = 0, j = 0; i < n && j < m;) {
    const fit = fits(i, j);
    if (fit !== null && count[i]![j] === 1 + count[i + 1]![j + 1]! && cost[i]![j] === fit + cost[i + 1]![j + 1]!) {
      out.set(slots[i]!.index, calls[j]!); i++; j++;
    } else if (count[i]![j] === count[i + 1]![j] && cost[i]![j] === cost[i + 1]![j]) i++;
    else j++;
  }
  return out;
}

/**
 * Rounds from the outline. Calls are aligned with the recorded ones (`alignCalls`). A recorded call
 * the outline does not show joins the round between the calls recorded around it: ChatGPT's code
 * mode (`exec`) when one stands there, the open round when the outline has moved on since, else the
 * round of the call before it. Everything else in the run (native steps, agent messages, nested
 * calls) follows the row recorded just before it.
 */
function tracedParts(run: FlowRow[], trace: TurnTrace, turnId: string, live: boolean, recaps: Set<string>): RoundPart[] {
  const parts: RoundPart[] = [];
  const placed = new Map<string, Extract<RoundPart, { kind: 'work' | 'say' }>>();
  const calls = run.filter(isCall);
  const aligned = alignCalls(trace, calls);
  const says = run.filter(row => row.event?.kind === 'assistant_message');
  const usedSays = new Set<string>();
  /** The round each outline call or exec stands in, by outline index. */
  const roundAt = new Map<number, Extract<RoundPart, { kind: 'work' }>>();
  let open: Extract<RoundPart, { kind: 'work' }> | null = null, works = 0;
  const work = () => {
    if (!open) {
      open = { kind: 'work', key: `work:${turnId}:${works++}`, rows: [], recap: null, live: false, turnId };
      parts.push(open);
    }
    return open;
  };
  const put = (part: Extract<RoundPart, { kind: 'work' }>, row: FlowRow) => { part.rows.push(row.key); placed.set(row.key, part); };
  trace.forEach((item, index) => {
    if (item.kind === 'say') {
      open = null;
      const recorded = says.find(row => {
        if (usedSays.has(row.key) || row.event?.kind !== 'assistant_message') return false;
        const event = row.event;
        return (!!item.id && (event.providerMessageId === item.id || event.messageId === item.id)) || sameSaying(event.message.text, item.text);
      });
      if (recorded) usedSays.add(recorded.key);
      const part: RoundPart = recorded
        ? { kind: 'say', key: recorded.key, rowKey: recorded.key, turnId }
        : { kind: 'say', key: `say:${turnId}:${item.id ?? index}`, text: item.text, turnId };
      parts.push(part);
      if (recorded) placed.set(recorded.key, part);
    } else if (item.kind === 'call' || item.kind === 'exec') {
      const part = work();
      roundAt.set(index, part);
      const row = aligned.get(index);
      if (row) put(part, row);
    } else if (item.kind === 'recap') {
      const closing = open ?? [...parts].reverse().find((part): part is Extract<RoundPart, { kind: 'work' }> => part.kind === 'work' && part.recap === null);
      // A recap after prose closes no activity of its own: it stands as its own line.
      const target = closing && parts.indexOf(closing) > parts.findLastIndex(part => part.kind === 'say') ? closing : work();
      target.recap = item.text;
      open = null;
    }
  });
  // Recorded calls the outline does not show, by the aligned calls around them.
  const slotOf = new Map([...aligned].map(([index, row]) => [row.key, index]));
  calls.forEach((row, position) => {
    if (slotOf.has(row.key)) return;
    let before = -1, after = Infinity;
    for (let at = position - 1; at >= 0; at--) { const slot = slotOf.get(calls[at]!.key); if (slot !== undefined) { before = slot; break; } }
    for (let at = position + 1; at < calls.length; at++) { const slot = slotOf.get(calls[at]!.key); if (slot !== undefined) { after = slot; break; } }
    const exec = trace.findIndex((item, index) => item.kind === 'exec' && index > before && index < after);
    if (exec >= 0) { put(roundAt.get(exec)!, row); return; }
    // Past the last aligned call, the outline has since opened another round: the call belongs to
    // the newest one. While the turn runs, a recap there says the same (the outline is read a moment
    // after a call starts); once it is over, a recap only closes the round the call was in.
    const moved = after === Infinity && trace.slice(before + 1).some(item => item.kind === 'say' || (live && item.kind === 'recap'));
    if (moved || (before < 0 && after === Infinity)) {
      const last = parts.at(-1);
      if (last?.kind === 'work' && last.recap === null) put(last, row);
      else { open = null; put(work(), row); }
      return;
    }
    put(roundAt.get(before >= 0 ? before : after)!, row);
  });
  // The rest follows whatever was recorded just before it.
  let before: Extract<RoundPart, { kind: 'work' | 'say' }> | undefined;
  for (const row of run) {
    const known = placed.get(row.key);
    if (known) { before = known; continue; }
    const event = row.event;
    if (event?.kind === 'page_tool' && recaps.has(plain(event.label))) continue;
    if (event?.kind === 'assistant_message' || event?.kind === 'progress') {
      // An interim message or caption the outline does not show: its own words, after what preceded it.
      const part: RoundPart = { kind: 'say', key: row.key, rowKey: row.key, turnId };
      parts.splice(before ? parts.indexOf(before) + 1 : 0, 0, part);
      placed.set(row.key, part); before = part;
      continue;
    }
    let target: Extract<RoundPart, { kind: 'work' }>;
    if (before?.kind === 'work') target = before;
    else {
      const at = before ? parts.indexOf(before) + 1 : 0;
      const following = parts[at];
      if (following?.kind === 'work') target = following;
      else {
        target = { kind: 'work', key: `work:${turnId}:${works++}`, rows: [], recap: null, live: false, turnId };
        parts.splice(at, 0, target);
      }
    }
    target.rows.push(row.key);
    placed.set(row.key, target); before = target;
  }
  // Rows keep their recorded order inside a round.
  const order = new Map(run.map((row, index) => [row.key, index]));
  for (const part of parts) if (part.kind === 'work') part.rows.sort((a, b) => order.get(a)! - order.get(b)!);
  if (live) {
    const last = parts.at(-1);
    if (last?.kind === 'work' && last.recap === null) last.live = true;
  }
  return parts.filter(part => part.kind !== 'work' || part.rows.length > 0 || part.recap !== null || part.live);
}

/**
 * Rounds without an outline, from what was recorded: each interim message opens a round, and a
 * native step that ends a finished round is ChatGPT's recap of it, by position, never by wording.
 */
function recordedParts(run: FlowRow[], turnId: string | undefined, live: boolean, finished: boolean, recaps: Set<string>): RoundPart[] {
  const parts: RoundPart[] = [];
  let open: Extract<RoundPart, { kind: 'work' }> | null = null;
  const prefix = turnId ?? run[0]!.key;
  for (const row of run) {
    const event = row.event!;
    // ChatGPT's interim messages and captions are what it said between steps: each opens a round.
    if (event.kind === 'assistant_message' || event.kind === 'progress') {
      open = null;
      parts.push({ kind: 'say', key: row.key, rowKey: row.key, turnId });
      continue;
    }
    if (event.kind === 'page_tool' && recaps.has(plain(event.label))) continue;
    if (!open) {
      // Keyed by the round's first row, so a page of history that trims the run keeps the rest stable.
      open = { kind: 'work', key: `work:${prefix}:${row.key}`, rows: [], recap: null, live: false, turnId };
      parts.push(open);
    }
    open.rows.push(row.key);
  }
  for (const [index, part] of parts.entries()) {
    if (part.kind !== 'work') continue;
    const closed = index < parts.length - 1 || finished;
    const last = run.find(row => row.key === part.rows.at(-1));
    if (closed && last?.event?.kind === 'page_tool' && part.rows.length > 1) {
      part.recap = last.event.label;
      part.rows.pop();
    }
  }
  if (live) {
    const last = parts.at(-1);
    if (last?.kind === 'work') last.live = true;
  }
  return parts;
}

/**
 * The timeline as rounds. `working` says the newest turn is still running: its last round is the
 * live one, unless a recap already closed it. `liveTurnId` names that turn, so its outline shows
 * even before any of its work is recorded (a new chat's first sentences come before its first call).
 */
export function structureTimeline(rows: readonly FlowRow[], traces: Readonly<Record<string, TurnTrace>>, working: boolean,
  liveTurnId?: string | null): RoundPart[] {
  const out: RoundPart[] = [];
  const runs: Array<{ start: number; rows: FlowRow[] }> = [];
  let current: FlowRow[] | null = null;
  const answers = new Set(Object.values(traces).flatMap(trace => trace.flatMap(item => item.kind === 'answer' ? [item.id] : [])));
  rows.forEach((row, index) => {
    if (!isActivity(row.event, answers)) { current = null; return; }
    if (!current) { current = []; runs.push({ start: index, rows: current }); }
    current.push(row);
  });
  const lastRun = runs.at(-1);
  // The newest run is live only when nothing of the turn's own stands after it.
  const liveRun = working && lastRun && !rows.slice(lastRun.start + lastRun.rows.length).some(row => row.event) ? lastRun : undefined;
  const traced = new Set<string>();
  // The recaps an outline already places. A native step with the same words is that recap recorded
  // again, often late and without its turn (a chat reopened after the turn ended), so it is not repeated.
  const recapsIn = (list: readonly TurnTrace[]) => new Set(list.flatMap(trace => trace.flatMap(item => item.kind === 'recap' ? [plain(item.text)] : [])));
  const everyRecap = recapsIn(Object.values(traces));
  const recapsOf = (turnId: string | undefined) => turnId ? recapsIn(traces[turnId] ? [traces[turnId]!] : []) : everyRecap;
  const passThrough = (row: FlowRow) => {
    // An outlined turn with no recorded work still says what it said, before its answer.
    const event = row.event;
    if (event?.kind === 'assistant_message' && event.turnId && traces[event.turnId] && !traced.has(event.turnId) &&
        !runs.some(run => runTurn(run.rows) === event.turnId)) {
      traced.add(event.turnId);
      out.push(...tracedParts([], traces[event.turnId]!, event.turnId, false, recapsOf(event.turnId)));
    }
    out.push({ kind: 'row', key: row.key });
  };
  let at = 0;
  for (const run of runs) {
    while (at < run.start) passThrough(rows[at++]!);
    const turnId = runTurn(run.rows);
    const trace = turnId ? traces[turnId] : undefined;
    const live = run === liveRun;
    // An outline describes a turn once; a later run of the same turn (after an error row, say) reads as recorded.
    if (turnId && trace && !traced.has(turnId)) {
      traced.add(turnId);
      out.push(...tracedParts(run.rows, trace, turnId, live, recapsOf(turnId)));
    } else {
      out.push(...recordedParts(run.rows, turnId, live, !live, recapsOf(turnId)));
    }
    at = run.start + run.rows.length;
  }
  while (at < rows.length) passThrough(rows[at++]!);
  if (working && liveTurnId && traces[liveTurnId] && !traced.has(liveTurnId)) {
    // Before the app's own lines that close the timeline (what the turn does right now).
    let end = out.length;
    while (end > 0 && out[end - 1]!.kind === 'row' && rows.find(row => row.key === out[end - 1]!.key)?.tail) end--;
    out.splice(end, 0, ...tracedParts([], traces[liveTurnId]!, liveTurnId, true, recapsOf(liveTurnId)));
  }
  return out;
}
