/**
 * The Chat panel: recorded sessions, their timeline, the brief a compaction left behind,
 * and the three numbers those need. The switches that decide what ChatGPT can reach live
 * in the Home permission list, and pairing the extension is a Setup step.
 *
 * This is a viewer, not a second ChatGPT client, and not a place a compaction is started:
 * a session is compacted by the chat it lives in, from the button the extension puts beside
 * ChatGPT's composer. Everything here arrives through the same fixed IPC channels as the
 * rest of the renderer.
 *
 * The timeline is drawn from what the recorder actually stored. Where a value is a
 * local estimate rather than a fact — token counts above all — the UI says so, because
 * the whole point of this panel is to be more honest than the wall of "Called tool".
 */

import type {
  ActivitySummary,
  AgentState,
  Handoff,
  SessionEvent,
  SessionSummary,
  SwarmState,
  TokenPressure
} from '../shared/session.js';
import { ATTRIBUTION_LABELS, TURN_OUTCOME_LABELS, foldProgress } from '../shared/session.js';
import { chronological } from '../shared/chronology.js';
import {
  DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT,
  DEFAULT_GOAL_SYSTEM_PROMPT,
  MAX_GOAL_SYSTEM_PROMPT_CHARS
} from '../shared/goal.js';
import { browserExtensionRequired, type AppState, type Config } from '../shared/types.js';
import { $, ago, clockTime, compactNumber, el, icon, run, toast } from './dom.js';

const api = window.api;

/** Sprite id per tool-call family. Deliberately reuses the existing icon set. */
const KIND_ICON: Record<ActivitySummary['kind'], string> = {
  edit: 'i-pencil',
  create: 'i-plus',
  delete: 'i-trash',
  move: 'i-out',
  read: 'i-eye',
  search: 'i-search',
  browse: 'i-folder',
  run: 'i-terminal',
  process: 'i-terminal',
  screen: 'i-monitor',
  input: 'i-monitor',
  clipboard: 'i-copy',
  session: 'i-steps',
  agent: 'i-bolt',
  other: 'i-bolt'
};

/**
 * How close to the end of the model list counts as asking for the next page, in pixels.
 * A little over one row, so the fetch starts while there is still something to read.
 */
const GOAL_SCROLL_MARGIN = 72;
/** Hard renderer budgets: durable history may be larger, but one paint may not be. */
const MAX_TIMELINE_ROWS = 160;
const MAX_TIMELINE_TEXT_CHARS = 2 * 1024 * 1024;
const MAX_RENDERED_HTML_CHARS = 256 * 1024;
const SESSION_PAGE_SIZE = 60;
const SESSION_SCROLL_MARGIN = 72;

/**
 * Which agent's events the timeline is showing.
 *
 * `null` is everything. `UNATTRIBUTED` is its own bucket rather than being folded into
 * "all", because a call this app could not tie to any agent is a real category — with
 * ChatGPT's stateless connector it is the *default* category — and hiding it inside the
 * total would let a filtered view look complete when it is not.
 */
const UNATTRIBUTED = '\u0000unattributed';
let agentFilter: string | null = null;
/** The session the current filter was chosen in; selecting a different one resets it. */
let filterFor: string | null = null;

interface Deps {
  /** The renderer's single save path — reads every control, including ours. */
  save: () => Promise<void>;
  state: () => AppState | null;
}

let deps: Deps;
let visible = false;

let sessions: SessionSummary[] = [];
let pressure = new Map<string, TokenPressure>();
let sessionTotal = 0;
let sessionPageCursor: { updatedAt: number; id: string } | null = null;
let sessionPageLoading = false;
/** True after the user has explicitly paged beyond the newest page. */
let loadedOlderSessions = false;
let activeId: string | null = null;
let selectedId: string | null = null;
let events: SessionEvent[] = [];
let totalEvents = 0;
/** The session whose `events`/cursor pair belongs together. */
let detailFor: string | null = null;
let detailCursor: number | null = null;
/** The last swarm the app reported, so the header can summarise it without the log. */
let swarm: SwarmState | null = null;
/** Badges the list is currently drawn with. See repaintBadges. */
let badgeKey = '';

/** Handoff currently shown, and the id it was loaded for. */
let handoff: Handoff | null = null;
let handoffFor: string | null = null;

let listTimer: number | undefined;
let sessionsLoadGeneration = 0;
let detailLoadGeneration = 0;
let handoffLoadGeneration = 0;

// ------------------------------------------------------------------ sessions

function pressureOf(id: string): TokenPressure | null {
  return pressure.get(id) ?? null;
}

/** A short word about a session, drawn as a chip on its row. */
interface Badge {
  text: string;
  tone: '' | 'is-active' | 'is-finished' | 'is-failed';
}

/** Live word per worker state, in the user's vocabulary rather than the protocol's. */
const AGENT_BADGE: Record<AgentState, Badge> = {
  invited: { text: 'opening', tone: 'is-active' },
  active: { text: 'active', tone: 'is-active' },
  // Still working, as far as this app knows — only its browser tab is gone. Said as
  // "no tab" rather than "detached" because that is the part a user can act on.
  detached: { text: 'no tab', tone: 'is-active' },
  // Between jobs, not over. Its chat is intact and the prime can put it back to work in it,
  // so the word has to read as a pause rather than as an ending — a user who reads "finished"
  // here closes the tab, which is the one thing that costs nothing and helps nothing.
  sleeping: { text: 'sleeping', tone: '' },
  waking: { text: 'waking', tone: 'is-active' },
  finished: { text: 'finished', tone: 'is-finished' },
  failed: { text: 'failed', tone: 'is-failed' }
};

/**
 * What a row is, and what it is doing right now.
 *
 * Once resume and multi-agent mode are in use, most rows in the list are chats this app
 * opened, and they are all recorded within a minute of each other. A name alone cannot
 * separate them — which run a chat belonged to, whether its tab ever opened, whether the
 * worker in it ever joined — and that is how a user loses track of a delayed tab. The
 * first badge is durable and comes from the session itself; the second is live and comes
 * from the swarm or the compaction currently reported by the app.
 */
function sessionBadges(summary: SessionSummary): Badge[] {
  const badges: Badge[] = [];
  const origin = summary.origin;
  // The one session that is not a chat. Saying so on the row is what stops it reading
  // as a chat that mysteriously lost its name.
  if (summary.conversationId === null) return [{ text: 'not a chat', tone: '' }];
  if (origin?.kind === 'worker') badges.push({ text: origin.agentId ?? 'worker', tone: '' });
  else if (origin?.kind === 'resume') badges.push({ text: 'resumed', tone: '' });
  else if (summary.agents.includes('prime')) badges.push({ text: 'prime', tone: '' });

  // Agent ids are reused across runs (`worker-1`, `worker-2`, ...). Matching only by that
  // short id made old worker sessions inherit the *current* run's live badge, so a worker
  // chat from 20 minutes ago suddenly said "active" again when a new worker-2 started.
  // Conversation id is the durable identity of the actual ChatGPT tab, so only that exact
  // worker session may borrow the live swarm state.
  const agent = origin?.agentId
    ? swarm?.agents.find(
        (entry) =>
          entry.id === origin.agentId &&
          Boolean(entry.conversationId) &&
          entry.conversationId === summary.conversationId
      )
    : swarm?.agents.find(
        (entry) => entry.role === 'prime' && entry.conversationId === summary.conversationId
      );
  if (agent) {
    badges.push(AGENT_BADGE[agent.state]);
    return badges;
  }

  return badges;
}

function sessionRow(summary: SessionSummary): HTMLElement {
  const row = el('div', 'sess');
  row.dataset.id = summary.id;
  if (summary.id === selectedId) row.classList.add('is-sel');
  if (summary.id === activeId && summary.endedAt === null) row.classList.add('is-live');

  const top = el('div', 'sess-top');
  const title = el('b', '', summary.title || 'Untitled session');
  title.title = summary.title;
  const when = el('em', '', ago(summary.updatedAt));
  top.append(title, when);

  const bits: string[] = [
    `${summary.userMessages} message${summary.userMessages === 1 ? '' : 's'}`,
    `${summary.toolCalls} tool${summary.toolCalls === 1 ? '' : 's'}`
  ];
  if (summary.errors > 0) bits.push(`${summary.errors} error${summary.errors === 1 ? '' : 's'}`);
  if (summary.agents.length > 0)
    bits.push(`${summary.agents.length} agent${summary.agents.length === 1 ? '' : 's'}`);
  const sub = el('div', 'sess-sub');
  for (const badge of sessionBadges(summary)) {
    sub.append(el('span', `chip${badge.tone ? ` ${badge.tone}` : ''}`, badge.text));
  }
  sub.append(el('span', 'sess-bits', bits.join(' · ')));

  const level = pressureOf(summary.id);
  const bar = el('div', `bar${level ? ` is-${level.level}` : ''}`);
  const fill = el('i');
  const share = level && level.limit > 0 ? Math.min(100, (level.estimated / level.limit) * 100) : 0;
  fill.style.width = `${share.toFixed(1)}%`;
  bar.append(fill);
  bar.title = `~${compactNumber(summary.estimatedTokens)} rough context tokens from messages and tool I/O; transient progress is excluded`;

  const remove = document.createElement('button');
  remove.className = 'btn sess-action sess-del';
  remove.type = 'button';
  remove.title = 'Delete this recorded session';
  remove.append(icon('i-trash'));
  remove.addEventListener('click', (event) => {
    event.stopPropagation();
    void deleteSession(summary.id);
  });

  const actions: HTMLButtonElement[] = [];
  if (summary.conversationId) {
    const open = document.createElement('button');
    open.className = 'btn sess-action sess-open';
    open.type = 'button';
    open.title = 'Open this chat in Chrome';
    open.append(icon('i-out'));
    open.addEventListener('click', (event) => {
      event.stopPropagation();
      void run(api.openSessionChat(summary.id));
    });
    actions.push(open);
  }

  row.append(top, sub, bar, ...actions, remove);
  return row;
}

async function deleteSession(id: string): Promise<void> {
  const done = await run(api.deleteSession(id));
  if (done === null) return;
  sessions = sessions.filter((entry) => entry.id !== id);
  pressure.delete(id);
  sessionTotal = Math.max(0, sessionTotal - 1);
  if (selectedId === id) {
    selectedId = null;
    events = [];
    totalEvents = 0;
    detailFor = null;
    detailCursor = null;
    handoff = null;
    handoffFor = null;
    detailLoadGeneration++;
    handoffLoadGeneration++;
  }
  toast('Session deleted');
  await loadSessions();
}

function sortSessionRows(rows: SessionSummary[]): SessionSummary[] {
  return rows.sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
    if (left.id === right.id) return 0;
    return left.id < right.id ? 1 : -1;
  });
}

function mergeSessionRows(rows: SessionSummary[]): void {
  const merged = new Map(sessions.map((entry) => [entry.id, entry]));
  for (const entry of rows) merged.set(entry.id, entry);
  sessions = sortSessionRows([...merged.values()]);
}

async function loadSessions(): Promise<void> {
  const generation = ++sessionsLoadGeneration;
  const list = await run(api.listSessions({ limit: SESSION_PAGE_SIZE }));
  if (!list || generation !== sessionsLoadGeneration) return;
  // Once older pages have been requested, a hot refresh only replaces/updates the newest page.
  // Throwing the older rows away here would make scrolling history vanish every 400 ms while a
  // live chat is recording. Before pagination begins, replacing the first page is cheaper and
  // also removes a session that was deleted elsewhere.
  if (loadedOlderSessions) mergeSessionRows(list.sessions);
  else {
    sessions = list.sessions;
    sessionPageCursor = list.nextCursor ?? null;
  }
  sessionTotal = typeof list.total === 'number' ? list.total : list.sessions.length;
  activeId = list.activeId;
  if (loadedOlderSessions) {
    for (const entry of list.pressure) pressure.set(entry.id, entry);
  } else {
    pressure = new Map(list.pressure.map((entry) => [entry.id, entry]));
  }
  if (selectedId !== null && !sessions.some((s) => s.id === selectedId)) {
    selectedId = null;
    detailFor = null;
    detailCursor = null;
  }
  if (selectedId === null) selectedId = activeId ?? sessions[0]?.id ?? null;
  paintSessions();
  await loadDetail();
}

async function loadMoreSessions(): Promise<void> {
  if (sessionPageLoading || !sessionPageCursor || sessions.length >= sessionTotal) return;
  sessionPageLoading = true;
  const cursor = sessionPageCursor;
  try {
    const page = await run(api.listSessions({ cursor, limit: SESSION_PAGE_SIZE }));
    if (!page) return;
    mergeSessionRows(page.sessions);
    loadedOlderSessions = true;
    sessionTotal = page.total;
    sessionPageCursor = page.nextCursor;
    for (const entry of page.pressure) pressure.set(entry.id, entry);
    paintSessions();
  } finally {
    sessionPageLoading = false;
  }
}

function maybePageSessions(): void {
  if (!visible || !sessionPageCursor || sessions.length >= sessionTotal) return;
  const pane = $('sessionList').closest<HTMLElement>('.scroll');
  if (!pane) return;
  if (pane.scrollHeight - pane.scrollTop - pane.clientHeight <= SESSION_SCROLL_MARGIN) {
    void loadMoreSessions();
  }
}

function paintSessions(): void {
  const list = $('sessionList');
  list.replaceChildren(...sessions.map(sessionRow));
  badgeKey = badgeSignature();
  $('sessionsEmpty').hidden = sessions.length > 0;

  const recording = deps.state()?.config.sessions.record === true;
  const retained = `${sessionTotal} retained session${sessionTotal === 1 ? '' : 's'}`;
  const shown = sessions.length < sessionTotal ? `${sessions.length} of ${retained} shown` : retained;
  const more = sessionPageCursor && sessions.length < sessionTotal ? ' · scroll for older history' : '';
  $('sessionsFoot').textContent = recording
    ? `${shown}${more}${activeId ? ' · one live now' : ''}`
    : `Recording is off · ${shown}${more}`;
}

function canonicalMessageKey(event: SessionEvent): string | null {
  if ((event.kind === 'user_message' || event.kind === 'assistant_message') && event.messageId) {
    return `${event.kind}\u0000${event.messageId}`;
  }
  return null;
}

/** Merge one sequence-cursor delta without letting canonical message revisions duplicate rows. */
function mergeDetailDelta(delta: SessionEvent[]): void {
  const merged = [...events];
  const messageRows = new Map<string, number>();
  for (let index = 0; index < merged.length; index++) {
    const key = canonicalMessageKey(merged[index]!);
    if (key) messageRows.set(key, index);
  }
  for (const event of delta) {
    const key = canonicalMessageKey(event);
    const index = key ? messageRows.get(key) : undefined;
    if (index !== undefined) merged[index] = event;
    else {
      if (key) messageRows.set(key, merged.length);
      merged.push(event);
    }
  }
  const folded = chronological(foldProgress(merged));
  events = folded.slice(Math.max(0, folded.length - MAX_TIMELINE_ROWS));
}

async function loadDetail(): Promise<void> {
  const wanted = selectedId;
  const generation = ++detailLoadGeneration;
  if (wanted === null) {
    handoffLoadGeneration++;
    events = [];
    totalEvents = 0;
    detailFor = null;
    detailCursor = null;
    paintDetail();
    return;
  }
  const incremental = detailFor === wanted && detailCursor !== null;
  const detail = await run(
    api.getSession(wanted, incremental ? { from: detailCursor!, limit: MAX_TIMELINE_ROWS } : { limit: MAX_TIMELINE_ROWS })
  );
  if (!detail || generation !== detailLoadGeneration || selectedId !== wanted) return;
  // User/assistant prose is canonical in messages.json, while structured page activity stays
  // append-only by design: ChatGPT can grow one commentary caption or rewrite one activity
  // label several times. `foldProgress` turns those snapshots back into the one logical row
  // their stable progressId/messageId names, then chronology places that row at its first
  // appearance. This helper existed already but was never wired into the desktop reader,
  // which is why "Inspecting…" and "Inspected…" still appeared as siblings.
  if (incremental) mergeDetailDelta(detail.events);
  else {
    const folded = chronological(foldProgress(detail.events));
    events = folded.slice(Math.max(0, folded.length - MAX_TIMELINE_ROWS));
    detailFor = wanted;
  }
  detailCursor =
    typeof detail.nextFrom === 'number'
      ? detail.nextFrom
      : detail.events.reduce((cursor, event) => Math.max(cursor, event.seq + 1), incremental ? detailCursor! : 0);
  totalEvents = detail.total;
  paintDetail();
  void loadHandoff();
  // A burst can contain more than one renderer-sized page between coalesced notifications.
  // Drain it page by page rather than silently jumping the cursor or lifting the payload cap.
  if (incremental && detail.events.length === MAX_TIMELINE_ROWS && selectedId === wanted) {
    window.setTimeout(() => void loadDetail(), 0);
  }
}

async function loadHandoff(): Promise<void> {
  const sessionId = selectedId;
  const generation = ++handoffLoadGeneration;
  const summary = sessions.find((s) => s.id === sessionId) ?? null;
  const wanted = summary?.lastHandoffId ?? null;
  if (wanted === null) {
    if (generation !== handoffLoadGeneration || selectedId !== sessionId) return;
    handoff = null;
    handoffFor = null;
    paintHandoff();
    return;
  }
  if (handoffFor === wanted) return;
  const loaded = await run(api.getHandoff(summary!.id, wanted));
  if (generation !== handoffLoadGeneration || selectedId !== sessionId) return;
  handoff = loaded ?? null;
  handoffFor = wanted;
  paintHandoff();
}

// ------------------------------------------------------------------ timeline

function textBlock(className: string, value: string, truncated: boolean, chars: number): HTMLElement {
  const node = el('p', className, value);
  if (truncated) {
    node.append(el('span', 'cut', ` … cut, ${compactNumber(chars)} characters in the original`));
  }
  return node;
}

const RENDERED_TAGS = new Set([
  'A', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DIV', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HR', 'KBD', 'LI', 'MARK', 'OL', 'P', 'PRE', 'S', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TABLE',
  'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'
]);
const DROP_RENDERED_TAGS = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON',
  'TEXTAREA', 'SELECT', 'OPTION', 'META', 'LINK'
]);

function safeRenderedHref(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.startsWith('#')) return trimmed;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:' ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Sanitizes ChatGPT's captured rendered HTML without reparsing Markdown.
 *
 * The page is untrusted input even though the extension produced the observation. Preserve
 * semantic Markdown tags, discard executable/form/embed content, strip every attribute by
 * default, and allow only the tiny attribute set that affects normal Markdown semantics.
 */
export function renderedMessage(html: string, fallback: string): HTMLElement {
  const box = el('div', 'msg rich');
  const safeFallback = fallback.slice(0, MAX_RENDERED_HTML_CHARS);
  if (!html) {
    box.textContent = safeFallback;
    return box;
  }
  const template = document.createElement('template');
  // Parsing untrusted captured HTML constructs a second tree before sanitisation. Bound it
  // before innerHTML so a valid but huge recorded turn cannot freeze/OOM the renderer.
  template.innerHTML = html.slice(0, MAX_RENDERED_HTML_CHARS);
  const visit = (parent: ParentNode): void => {
    for (const node of [...parent.childNodes]) {
      // Namespace elements (SVG/MathML) are not HTMLElements. Checking HTMLElement here
      // would let exactly the foreign content in DROP_RENDERED_TAGS bypass traversal and
      // attribute stripping. nodeType is realm-agnostic and covers every DOM Element.
      if (node.nodeType !== 1) continue;
      const element = node as Element;
      const tagName = element.tagName.toUpperCase();
      if (DROP_RENDERED_TAGS.has(tagName)) {
        element.remove();
        continue;
      }
      visit(element);
      if (!RENDERED_TAGS.has(tagName)) {
        element.replaceWith(...element.childNodes);
        continue;
      }
      const href = tagName === 'A' ? safeRenderedHref(element.getAttribute('href') ?? '') : null;
      const title = element.getAttribute('title');
      const start = tagName === 'OL' ? element.getAttribute('start') : null;
      const colSpan = tagName === 'TD' || tagName === 'TH' ? element.getAttribute('colspan') : null;
      const rowSpan = tagName === 'TD' || tagName === 'TH' ? element.getAttribute('rowspan') : null;
      for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
      if (href) {
        element.setAttribute('href', href);
        element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noreferrer noopener');
      }
      if (title) element.setAttribute('title', title.slice(0, 500));
      if (start && /^\d{1,6}$/.test(start)) element.setAttribute('start', start);
      if (colSpan && /^\d{1,3}$/.test(colSpan)) element.setAttribute('colspan', colSpan);
      if (rowSpan && /^\d{1,3}$/.test(rowSpan)) element.setAttribute('rowspan', rowSpan);
    }
  };
  visit(template.content);
  box.append(template.content);
  if (!box.textContent?.trim() && safeFallback) box.textContent = safeFallback;
  return box;
}

/**
 * Tool calls the user has opened, by their durable call id.
 *
 * The timeline is redrawn from scratch whenever anything is recorded, and a fresh
 * `<details>` is closed. So opening a call to read its arguments and then having ChatGPT
 * make one more MCP call — which is to say, the normal case — silently collapsed what you
 * were reading, several times a minute. Remembering the open set outside the DOM is what
 * makes a redraw invisible; the ids are the recorder's own, so they survive the rebuild.
 *
 * Cleared when a different session is selected, not on every repaint: the whole point is
 * that a repaint must not be able to change what is open.
 */
const openTools = new Set<string>();

function toolBody(event: Extract<SessionEvent, { kind: 'tool_call' }>): HTMLElement {
  const { call } = event;
  const box = document.createElement('details');
  box.className = `tool tone-${call.summary.tone}`;
  box.open = openTools.has(call.callId);
  box.addEventListener('toggle', () => {
    if (box.open) openTools.add(call.callId);
    else openTools.delete(call.callId);
  });

  const head = document.createElement('summary');
  head.append(icon(KIND_ICON[call.summary.kind] ?? 'i-bolt', 'ico tool-ico'));
  head.append(el('b', '', call.summary.title));
  if (call.summary.detail) head.append(el('em', '', call.summary.detail));
  if (call.summary.metric) head.append(el('span', 'metric', call.summary.metric));
  box.append(head);

  const raw = el('div', 'raw');
  const facts = el('p', 'raw-facts');
  facts.textContent =
    `${call.tool} · ${call.outcome} · ${Math.round(call.durationMs)} ms · ` +
    `placed by ${ATTRIBUTION_LABELS[call.attribution] ?? call.attribution}`;
  raw.append(facts);

  if (call.changes && call.changes.length > 0) {
    const changes = el('ul', 'changes');
    for (const change of call.changes) {
      const li = el('li');
      li.append(el('code', '', change.path));
      const counts = `+${change.added} −${change.removed}${change.approximate ? ' (approx.)' : ''}`;
      li.append(el('span', 'metric', counts));
      changes.append(li);
    }
    raw.append(changes);
  }

  raw.append(el('h4', '', 'Arguments'));
  raw.append(textBlock('pre', call.args.text, call.args.truncated, call.args.chars));
  raw.append(el('h4', '', 'Result'));
  raw.append(textBlock('pre', call.result.text, call.result.truncated, call.result.chars));

  for (const asset of call.assets ?? []) {
    raw.append(el('p', 'raw-facts', `asset ${asset.id} · ${asset.mimeType} · ${compactNumber(asset.bytes)} bytes`));
  }

  box.append(raw);
  return box;
}

function eventBody(event: SessionEvent): HTMLElement {
  switch (event.kind) {
    case 'session_start':
      return el('p', 'meta', `Session started — ${event.title}`);
    case 'user_message': {
      const box = el('div', 'said is-user');
      box.append(el('b', '', 'You'));
      box.append(textBlock('msg', event.message.text, event.message.truncated, event.message.chars));
      return box;
    }
    case 'assistant_message': {
      const box = el('div', 'said');
      box.append(el('b', '', event.final ? 'ChatGPT' : 'ChatGPT (partial)'));
      box.append(renderedMessage(event.renderedHtml?.text ?? '', event.message.text));
      return box;
    }
    case 'progress':
      return el('p', 'meta is-progress', event.message.text);
    case 'page_tool': {
      const line = el('p', 'meta is-progress thinking-line');
      line.append(icon('i-bolt', 'ico thinking-ico'), el('span', '', event.label));
      return line;
    }
    case 'turn_start':
      return el('p', 'meta', 'Turn started');
    case 'turn_end': {
      const line = el(
        'p',
        event.outcome === 'completed' ? 'meta' : 'meta is-warn',
        `Turn ${TURN_OUTCOME_LABELS[event.outcome]}${event.detail ? ` — ${event.detail}` : ''}`
      );
      return line;
    }
    case 'chat_error':
      return textBlock('meta is-bad', event.message.text, event.message.truncated, event.message.chars);
    case 'tool_call':
      return toolBody(event);
    case 'note':
      return el('p', 'meta', event.message.text);
    /**
     * Rendered rather than left to fall through to "Unknown event".
     *
     * The timeline is how the user checks what the agents actually said to each other, and
     * a run of grey "Unknown event" rows in the middle of a multi-agent session reads as a
     * broken log — the one impression a session recorder cannot afford to give.
     */
    case 'agent_message': {
      const box = el('div', 'said');
      // Which end of the message this record is. The same message is written once here and
      // once in the other agent's session, so without this a pair reads as two messages.
      box.title =
        event.delivery === 'sent'
          ? `Sent by ${event.from}; recorded when the app accepted it`
          : `Received by ${event.to}; recorded when it acknowledged delivery`;
      box.append(el('b', '', `${event.from} → ${event.to}`));
      box.append(textBlock('msg', event.message.text, event.message.truncated, event.message.chars));
      return box;
    }
    case 'handoff':
      return el(
        'p',
        'meta is-good',
        `Handoff saved — ${compactNumber(event.chars)} characters (${event.reason})`
      );
    default:
      return el('p', 'meta', 'Unknown event');
  }
}

function eventRow(event: SessionEvent): HTMLElement {
  const row = el('div', `ev ev-${event.kind}`);
  const time = document.createElement('time');
  time.textContent = clockTime(event.time);
  time.title = new Date(event.time).toLocaleString();
  const body = el('div', 'ev-body');
  if (event.agent) body.append(el('span', 'chip', event.agent));
  body.append(eventBody(event));
  row.append(time, body);
  return row;
}

/**
 * The agent chips above the timeline.
 *
 * Drawn only when this session actually has more than one attribution in it, so a
 * single-agent session — which is every session unless multi-agent mode is running —
 * keeps exactly the view it had before.
 */
function paintAgentFilter(): void {
  const box = $('chatAgentFilter');
  const named = [...new Set(events.flatMap((event) => (event.agent ? [event.agent] : [])))].sort();
  const anyUnattributed = events.some((event) => !event.agent);
  // A filter belongs to the session it was chosen in. Carrying it across a selection
  // change showed the next session's timeline as empty with no chip lit to explain why —
  // and agent ids repeat between runs, so it could also silently hide half of one. The
  // same guard catches an agent that simply is not in this session's events.
  if (filterFor !== selectedId) {
    agentFilter = null;
    filterFor = selectedId;
  } else if (agentFilter !== null && agentFilter !== UNATTRIBUTED && !named.includes(agentFilter)) {
    agentFilter = null;
  }
  if (named.length === 0 || (named.length === 1 && !anyUnattributed)) {
    box.hidden = true;
    box.replaceChildren();
    agentFilter = null;
    return;
  }
  const buttons: HTMLElement[] = [];
  const chip = (value: string | null, label: string): HTMLElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.agent = value ?? '';
    if (agentFilter === value) button.classList.add('is-sel');
    return button;
  };
  buttons.push(chip(null, 'All'));
  for (const agent of named) buttons.push(chip(agent, agent));
  if (anyUnattributed) buttons.push(chip(UNATTRIBUTED, 'Unattributed'));
  box.replaceChildren(...buttons);
  box.hidden = false;
}

function visibleEvents(): SessionEvent[] {
  if (agentFilter === null) return events;
  if (agentFilter === UNATTRIBUTED) return events.filter((event) => !event.agent);
  return events.filter((event) => event.agent === agentFilter);
}

function eventTextCost(event: SessionEvent): number {
  switch (event.kind) {
    case 'user_message':
    case 'assistant_message':
      return event.message.text.length + (event.kind === 'assistant_message' ? (event.renderedHtml?.text.length ?? 0) : 0);
    case 'progress':
    case 'chat_error':
    case 'note':
    case 'agent_message':
      return event.message.text.length;
    case 'tool_call':
      return (
        event.call.args.text.length +
        event.call.result.text.length +
        event.call.summary.title.length +
        (event.call.summary.detail?.length ?? 0)
      );
    case 'page_tool':
      return event.label.length;
    case 'turn_end':
      return event.detail?.length ?? 0;
    default:
      return 128;
  }
}

/** Newest-first selection, returned chronologically, under row and text/HTML budgets. */
function boundedTimeline(source: SessionEvent[]): { shown: SessionEvent[]; omitted: number } {
  let chars = 0;
  let start = source.length;
  while (start > 0 && source.length - start < MAX_TIMELINE_ROWS) {
    const next = source[start - 1]!;
    const cost = Math.min(eventTextCost(next), MAX_TIMELINE_TEXT_CHARS);
    if (start < source.length && chars + cost > MAX_TIMELINE_TEXT_CHARS) break;
    chars += cost;
    start -= 1;
  }
  return { shown: source.slice(start), omitted: start };
}

function paintDetail(): void {
  const summary = sessions.find((s) => s.id === selectedId) ?? null;
  $('chatTitle').textContent = summary ? summary.title || 'Untitled session' : 'No session selected';

  paintAgentFilter();
  const filtered = visibleEvents();
  const windowed = boundedTimeline(filtered);
  const shown = windowed.shown;

  // The scroller is the card body, not the list: a live session appends to the bottom,
  // so stay pinned there unless the user has scrolled up to read something — and if they
  // have, put them back exactly where they were instead of letting the rebuild jump.
  const pane = $('chatBody');
  const atBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 40;
  const was = pane.scrollTop;
  const timelineRows: HTMLElement[] = [];
  if (windowed.omitted > 0) {
    timelineRows.push(
      el(
        'p',
        'timeline-window-note',
        `${windowed.omitted} earlier row${windowed.omitted === 1 ? '' : 's'} kept on disk — showing the newest bounded window`
      )
    );
  }
  timelineRows.push(...shown.map(eventRow));
  $('timeline').replaceChildren(...timelineRows);
  $('timelineEmpty').hidden = shown.length > 0;
  pane.scrollTop = atBottom ? pane.scrollHeight : was;

  const facts: string[] = [];
  if (summary) {
    facts.push(`${totalEvents} event${totalEvents === 1 ? '' : 's'}`);
    if (events.length < totalEvents) facts.push(`showing the last ${events.length}`);
    if (agentFilter !== null) {
      facts.push(`filtered to ${agentFilter === UNATTRIBUTED ? 'unattributed' : agentFilter} — ${filtered.length} matched`);
    }
    if (windowed.omitted > 0) facts.push(`${shown.length} newest rendered`);
    facts.push(`~${compactNumber(summary.estimatedTokens)} rough context tokens`);
    const level = pressureOf(summary.id);
    if (level && level.level !== 'ok') {
      facts.push(
        level.level === 'huge'
          ? 'past the compaction threshold — compact before continuing'
          : 'large — compaction is worth doing soon'
      );
    }
    if (summary.lastTurnOutcome && summary.lastTurnOutcome !== 'completed') {
      facts.push(`last turn ${TURN_OUTCOME_LABELS[summary.lastTurnOutcome]}`);
    }
  }
  $('chatFoot').textContent = facts.join(' · ');
  $('chatFoot').classList.toggle('is-warn', pressureOf(selectedId ?? '')?.level === 'huge');
}

// -------------------------------------------------------------------- handoff

/**
 * The brief the last compaction of this session left behind.
 *
 * A record, not a control. The compaction itself happens in the ChatGPT conversation — the
 * chat writes its own brief as its final answer — so what is worth showing here is the
 * document that came out of it, and any warning attached to it.
 */
function paintHandoff(): void {
  const hand = $('handoffBox');
  if (handoff) {
    const parts: HTMLElement[] = [];
    const head = el('p', 'hint');
    head.textContent = `${compactNumber(handoff.text.length)} characters · from ${handoff.sourceEvents} events (~${compactNumber(handoff.sourceTokens)} tokens) · ${ago(handoff.createdAt)}`;
    parts.push(head);
    for (const note of handoff.notes) parts.push(el('p', 'hint is-warn', note));
    parts.push(el('pre', 'pre', handoff.text));
    hand.replaceChildren(...parts);
    $('handoffHead').hidden = false;
    $('copyHandoff').hidden = false;
  } else {
    hand.replaceChildren();
    $('handoffHead').hidden = true;
    $('copyHandoff').hidden = true;
  }
  paintStateLine();
}

/**
 * One line under the header saying what is happening right now.
 *
 * The complaint this answers: the only place a user could find out whether a worker's chat
 * had opened was the raw Activity log, which is a diagnostics view rather than an answer to
 * "what is happening".
 */
function paintStateLine(): void {
  const note = $('chatState');
  const { text, tone } = stateLine();
  note.textContent = text;
  note.className = `subhead-note${tone ? ` ${tone}` : ''}`;
  repaintBadges();
}

/**
 * Redraws the list when a row's badges would change, and not otherwise.
 *
 * The badges follow live state, which changes as fast as the recorder writes. Rebuilding
 * every row for each of those would be a list that flickers while it is being read, so the
 * redraw is keyed on the badges themselves.
 */
function repaintBadges(): void {
  const key = badgeSignature();
  if (key === badgeKey) return;
  paintSessions();
}

function badgeSignature(): string {
  return sessions.map((entry) => sessionBadges(entry).map((badge) => badge.text).join(',')).join('|');
}

function stateLine(): { text: string; tone: '' | 'is-live' | 'is-bad' } {
  // Recording follows the conversation the browser can see. A tool call arrives over the
  // connector carrying nothing that identifies its caller, so work driven from the phone,
  // from another browser or from another machine can only be recorded as what it is:
  // real, complete, and not placeable in any chat this app can observe.
  const selected = sessions.find((entry) => entry.id === selectedId) ?? null;
  if (selected && selected.conversationId === null) {
    return {
      text: 'Work this app could not place in a chat — driven from another device, or with no ChatGPT tab open',
      tone: ''
    };
  }

  const workers = swarm?.agents.filter((agent) => agent.role === 'worker') ?? [];
  if (workers.length === 0) return { text: '', tone: '' };
  const count = (state: AgentState): number => workers.filter((agent) => agent.state === state).length;
  const parts: string[] = [];
  if (count('active') > 0) parts.push(`${count('active')} working`);
  // "invited" is a worker whose ChatGPT tab has been asked for but has not joined yet.
  if (count('invited') > 0) parts.push(`${count('invited')} opening`);
  // Detached is a live worker with no tab: its turn is running on OpenAI's servers and its
  // tool calls still arrive here, so it is counted among the working rather than the lost.
  if (count('detached') > 0) parts.push(`${count('detached')} working with no tab`);
  if (count('waking') > 0) parts.push(`${count('waking')} waking up`);
  // Said as "waiting" rather than counted with the finished ones: these are the run's reusable
  // chats, and the number the user wants is how much of the run is still available to it.
  if (count('sleeping') > 0) parts.push(`${count('sleeping')} sleeping`);
  if (count('finished') > 0) parts.push(`${count('finished')} finished`);
  if (count('failed') > 0) parts.push(`${count('failed')} failed`);
  const live = count('invited') + count('active') + count('detached') + count('waking');
  return {
    text: `${workers.length === 1 ? '1 worker' : `${workers.length} workers`} · ${parts.join(' · ')}`,
    tone: count('failed') > 0 ? 'is-bad' : live > 0 ? 'is-live' : ''
  };
}

// ----------------------------------------------------------------- settings

/**
 * Shows where the extension actually is on this machine.
 *
 * An installed build has no source tree, so "load extension/ from the repo" is advice
 * that cannot be followed. Asked once and cached, because the answer cannot change while
 * the app is running.
 */
let extensionPathShown = false;
async function showExtensionPath(): Promise<void> {
  if (extensionPathShown) return;
  extensionPathShown = true;
  const dir = await run(api.extensionPath());
  const node = $('extensionPath');
  if (dir) {
    node.textContent = `Extension folder: ${dir}`;
    node.classList.remove('is-warn');
  } else {
    node.textContent =
      'The extension folder is missing from this installation. Reinstall the app, or use the extension/ folder from a source checkout.';
    node.classList.add('is-warn');
    $<HTMLButtonElement>('bridgeFolder').disabled = true;
  }
}

function paintSwarm(state: SwarmState): void {
  swarm = state;
  paintStateLine();
  const list = $('swarmList');
  if (state.agents.length === 0) {
    list.replaceChildren(
      el(
        'p',
        'hint',
        state.retainedHistory
          ? 'No workers are running. Reusable worker histories are parked and remain available to their prime chats; Clear swarm permanently removes them.'
          : 'No agents. The prime agent creates workers with the agents tool’s spawn action.'
      )
    );
  } else {
    list.replaceChildren(
      ...state.agents.map((agent) => {
        const row = el('div', 'agent');
        const top = el('div', 'model-top');
        const label = agent.label || agent.id;
        top.append(el('b', '', label));
        if (label !== agent.id) top.append(el('span', 'chip', agent.id));
        top.append(el('span', `chip is-${agent.state}`, agent.state));
        // Clearing is offered where the agent is, not only as one global reset at the
        // bottom of a settings form. The two rows mean different things and the tooltip
        // says which: the prime is the run, a worker is one slot.
        const over = agent.state === 'finished' || agent.state === 'failed';
        if (!over) {
          const clear = el('button', 'btn btn-quiet agent-clear');
          clear.append(icon('i-x'));
          clear.dataset.clear = agent.id;
          clear.title =
            agent.role === 'prime'
              ? 'Clear session — ends this run and every worker in it'
              : `Clear session — ends ${agent.id} and frees its slot`;
          top.append(clear);
        }
        const sub = el('div', 'model-sub');
        const bits = [`${agent.pending} pending`, `${agent.delivered} delivered`];
        if (agent.conversationId) bits.push('chat bound');
        sub.textContent = bits.join(' · ');
        row.append(top, sub);
        if (agent.task) row.append(el('p', 'hint', agent.task));
        // Why it failed, not just that it did. A worker only reaches this state when its
        // chat could not be opened, and the reason is the only actionable part.
        if (agent.state === 'failed' && agent.result) row.append(el('p', 'hint is-warn', agent.result));
        return row;
      })
    );
  }
  // Usable whenever there is a run to clear, not only while a worker is still going.
  // Gating on `running` left finished-but-present swarm state with no way out, which is
  // exactly the state a user wants to clear before starting the next run.
  $<HTMLButtonElement>('swarmReset').disabled = state.agents.length === 0 && state.retainedHistory !== true;
}

/**
 * The meter's red line, derived from the one threshold the user actually sets.
 *
 * There used to be three numbers for one quantity — "suggest at", "urgent at" and
 * "compact at" — all measured in the same local estimate and all editable apart. That is
 * three ways to describe one line, and they drifted: a meter could sit red for an hour on
 * a chat whose automatic trigger was set far higher, or fill only halfway on the turn that
 * compaction actually fired. The threshold is now the amber line by definition, and the red
 * line sits a third further on, which is the relation the app's own defaults have always
 * carried (300k → 400k when the threshold was 300k; 400k → 533k now).
 */
function urgentFrom(threshold: number): number {
  return Math.min(4_000_000, Math.max(10_000, Math.round((threshold * 4) / 3)));
}

/** Reads the three config sections this panel owns, for the renderer's save path. */
export function chatSettingsPatch(current: Config): {
  sessions: Config['sessions'];
  compaction: Config['compaction'];
  multiAgent: Config['multiAgent'];
  goal: Config['goal'];
} {
  const number = (id: string, fallback: number, min: number, max: number): number => {
    const raw = Number($<HTMLInputElement>(id).value);
    if (!Number.isFinite(raw)) return fallback;
    return Math.min(max, Math.max(min, Math.round(raw)));
  };
  const threshold = number('autoCompactTokens', current.compaction.autoTokens, 10_000, 4_000_000);
  return {
    sessions: {
      record: $<HTMLInputElement>('sessRecord').checked,
      retainDays: number('sessRetain', current.sessions.retainDays, 0, 3650),
      // Both follow the single threshold above rather than being typed separately.
      advisoryTokens: threshold,
      limitTokens: urgentFrom(threshold)
    },
    compaction: {
      auto: $<HTMLInputElement>('autoCompact').checked,
      autoTokens: threshold
    },
    multiAgent: {
      // The exposure switch lives with every other ChatGPT tool switch, on Home. This
      // panel keeps only the worker count, so it reads the one control that exists.
      enabled: $<HTMLInputElement>('homeMaEnabled').checked,
      maxWorkers: number('maWorkers', current.multiAgent.maxWorkers, 1, 8),
      allowUnattributedCalls: $<HTMLInputElement>('allowUnattributedCalls').checked,
      recoverAgentTabs: $<HTMLInputElement>('recoverAgentTabs').checked
    },
    goal: {
      enabled: $<HTMLInputElement>('goalEnabled').checked,
      // The chosen model is held here rather than in an input, because it is picked from a
      // list and never typed. `current` is the fallback for the first save after a repaint.
      model: goalModel || current.goal.model,
      reasoning: $<HTMLSelectElement>('goalReasoning').value as Config['goal']['reasoning'],
      // Blank means "restore the safe default", not "send an unconstrained system message".
      prompt: $<HTMLTextAreaElement>('goalPrompt').value.trim() || DEFAULT_GOAL_SYSTEM_PROMPT,
      objectivePrompt:
        $<HTMLTextAreaElement>('goalObjectivePrompt').value.trim() ||
        DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT
    }
  };
}

// --------------------------------------------------------------- the goal loop

/**
 * The OpenRouter model this panel currently has chosen.
 *
 * Kept beside the controls rather than in one, because the picker is a list that is not
 * loaded most of the time: an `<input>` would have to hold an id nobody typed, and a
 * `<select>` would have to hold several hundred options nobody asked for.
 */
let goalModel = '';
/** The catalogue as far as it has been paged in, and how long it actually is. */
let goalModels: Array<{ id: string; name: string; created: number; contextLength: number }> = [];
let goalTotal = 0;
let goalLoading = false;

/** The release date OpenRouter publishes, as a person would date a model. */
function releasedOn(created: number): string {
  if (!created) return 'release date not published';
  return new Date(created * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Loads the next twenty models, newest first.
 *
 * Paged rather than fetched whole because the catalogue is several hundred entries long and
 * the question this list answers — what is new — is answered by the first screen of it.
 */
async function loadGoalModels(reset: boolean): Promise<void> {
  if (goalLoading) return;
  goalLoading = true;
  if (reset) {
    goalModels = [];
    goalTotal = 0;
  }
  $('goalModelsState').textContent = 'Loading models from OpenRouter…';
  $<HTMLButtonElement>('goalMore').disabled = true;
  const page = await run(api.listGoalModels(goalModels.length));
  goalLoading = false;
  if (!page) {
    // `run` has already shown the reason. Say what it means *here*: the list is empty and
    // the model in use has not changed.
    $('goalModelsState').textContent = 'OpenRouter could not be reached. The model in use is unchanged.';
    $<HTMLButtonElement>('goalMore').disabled = goalModels.length === 0;
    return;
  }
  goalModels = [...goalModels, ...page.models];
  goalTotal = page.total;
  paintGoalModels();
}

function paintGoalModels(): void {
  const list = $('goalModelList');
  // Emptying an element scrolls it back to the top, and this repaints the whole list every
  // time a page lands. Without holding the offset, paging in the next twenty threw the
  // reader back to the newest model — which is the one place they had already decided
  // against by scrolling away from it.
  const keep = list.scrollTop;
  list.textContent = '';
  for (const model of goalModels) {
    const row = el('button', 'goal-model');
    row.setAttribute('type', 'button');
    row.dataset.model = model.id;
    if (model.id === goalModel) row.dataset.chosen = '1';
    row.append(el('b', 'goal-model-name', model.name));
    const meta = [releasedOn(model.created), model.contextLength > 0 ? `${compactNumber(model.contextLength)} ctx` : '']
      .filter(Boolean)
      .join(' · ');
    row.append(el('em', 'goal-model-meta', `${model.id} · ${meta}`));
    list.append(row);
  }
  const shown = goalModels.length;
  $('goalModelsState').textContent =
    shown === 0 ? 'No models came back.' : `Showing the ${shown} newest of ${goalTotal}, newest release first.`;
  $<HTMLButtonElement>('goalMore').disabled = shown >= goalTotal;
  $<HTMLButtonElement>('goalMore').hidden = shown >= goalTotal;
  list.scrollTop = keep;
  // A page that did not fill the box leaves nothing to scroll, so the scroll handler can
  // never fire and the list would stop at twenty with more still to come. Ask again here.
  maybePageGoalModels();
}

/**
 * Pages the catalogue in as the list is scrolled.
 *
 * "Load 20 more" is the deliberate way to ask; scrolling to the bottom is the way people
 * actually ask. It fires a screenful early rather than at the exact bottom, so the next
 * twenty are usually already in place by the time the scroll arrives where they go.
 */
function maybePageGoalModels(): void {
  if (goalLoading || goalModels.length === 0 || goalModels.length >= goalTotal) return;
  const list = $('goalModelList');
  // A closed picker measures zero in every direction, which reads as "scrolled to the end"
  // and would page the whole catalogue in behind a panel nobody has open.
  if (list.clientHeight === 0) return;
  if (list.scrollHeight - list.scrollTop - list.clientHeight > GOAL_SCROLL_MARGIN) return;
  void loadGoalModels(false);
}

/** Keep an in-progress form edit when an unrelated main-process push carries the old value. */
function applyChatValue(
  input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
  previous: string | number | undefined
): void {
  if (document.activeElement === input && previous !== undefined && input.value !== String(previous)) return;
  input.value = value;
}

/** Checkbox counterpart to applyChatValue. */
function applyChatChecked(input: HTMLInputElement, value: boolean, previous: boolean | undefined): void {
  if (document.activeElement === input && previous !== undefined && input.checked !== previous) return;
  input.checked = value;
}

/** Writes the goal block from app state. Called from chatApply, so it never guesses. */
function applyGoal(state: AppState, previous?: Config): void {
  const { config } = state;
  const secureStorageAvailable = state.secureStorage?.available ?? true;
  goalModel = config.goal.model;
  const goalToggle = $<HTMLInputElement>('goalEnabled');
  applyChatChecked(goalToggle, config.goal.enabled, previous?.goal.enabled);
  // Goal reads the local recorded transcript. Keep the dependency visible at the switch rather
  // than accepting a click that the config boundary must immediately repair back to off.
  goalToggle.disabled = !config.sessions.record;
  applyChatValue($<HTMLSelectElement>('goalReasoning'), config.goal.reasoning, previous?.goal.reasoning);
  applyChatValue($<HTMLTextAreaElement>('goalPrompt'), config.goal.prompt, previous?.goal.prompt);
  applyChatValue(
    $<HTMLTextAreaElement>('goalObjectivePrompt'),
    config.goal.objectivePrompt,
    previous?.goal.objectivePrompt
  );
  // The one sentence somebody switching this on needs, and the exact words the extension
  // shows under the same switch — two places saying the same thing differently is how a
  // missing key turns into a support question.
  $('goalHint').textContent = !config.sessions.record
    ? 'Turn on session recording first — Goal needs the recorded conversation to decide what is still missing.'
    : !state.hasGoalKey
      ? 'OpenRouter API key essential for goal feature.'
      : config.goal.enabled
        ? 'A second model reads each finished answer and writes your next message, until it decides the goal is met.'
        : 'Off — nothing is sent to OpenRouter and nothing is typed into your chats.';
  $('goalHint').classList.toggle('is-warn', !config.sessions.record || !state.hasGoalKey);
  $('goalModelName').textContent = config.goal.model;
  const goalKey = $<HTMLInputElement>('goalKey');
  goalKey.placeholder = state.hasGoalKey ? '•••••••• stored' : 'sk-or-v1-…';
  goalKey.disabled = !secureStorageAvailable;
  $('goalKeyState').textContent = !secureStorageAvailable
    ? (state.secureStorage?.detail ?? 'Secure credential storage is unavailable.')
    : state.hasGoalKey
      ? 'A key is stored with secure OS credential storage. Type a new one to replace it.'
      : 'Stored with secure OS credential storage. It never leaves this app, and the browser is only ever handed the reply.';
  $('goalKeyState').classList.toggle('is-warn', !secureStorageAvailable);
  $<HTMLButtonElement>('goalKeyRemove').disabled = !state.hasGoalKey || !secureStorageAvailable;
  if (goalModels.length > 0) paintGoalModels();
}

function wireGoal(save: () => Promise<void>): void {
  $<HTMLTextAreaElement>('goalPrompt').maxLength = MAX_GOAL_SYSTEM_PROMPT_CHARS;
  $('goalPromptEdit').addEventListener('click', () => {
    const panel = $('goalPromptPanel');
    panel.hidden = !panel.hidden;
    $('goalPromptEdit').textContent = panel.hidden ? 'Edit prompt' : 'Close prompt';
    if (!panel.hidden) $<HTMLTextAreaElement>('goalPrompt').focus();
  });
  $('goalPromptReset').addEventListener('click', async () => {
    $<HTMLTextAreaElement>('goalPrompt').value = DEFAULT_GOAL_SYSTEM_PROMPT;
    await save();
    toast('Goal prompt restored to default');
  });
  $<HTMLTextAreaElement>('goalObjectivePrompt').maxLength = MAX_GOAL_SYSTEM_PROMPT_CHARS;
  $('goalObjectivePromptEdit').addEventListener('click', () => {
    const panel = $('goalObjectivePromptPanel');
    panel.hidden = !panel.hidden;
    $('goalObjectivePromptEdit').textContent = panel.hidden ? 'Edit prompt' : 'Close prompt';
    if (!panel.hidden) $<HTMLTextAreaElement>('goalObjectivePrompt').focus();
  });
  $('goalObjectivePromptReset').addEventListener('click', async () => {
    $<HTMLTextAreaElement>('goalObjectivePrompt').value = DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT;
    await save();
    toast('Goal driver prompt restored to default');
  });
  // The catalogue is fetched on the first press and kept afterwards: the picker closing is
  // not a reason to spend another round trip on a list that changes weekly.
  $('goalPick').addEventListener('click', () => {
    const panel = $('goalModels');
    panel.hidden = !panel.hidden;
    $('goalPick').textContent = panel.hidden ? 'Select model' : 'Close';
    if (!panel.hidden && goalModels.length === 0) void loadGoalModels(true);
  });
  $('goalMore').addEventListener('click', () => void loadGoalModels(false));
  $('goalModelList').addEventListener('scroll', maybePageGoalModels);
  $('goalModelList').addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-model]');
    if (!row?.dataset.model) return;
    goalModel = row.dataset.model;
    $('goalModelName').textContent = goalModel;
    paintGoalModels();
    void save();
    toast(`Goal model set to ${goalModel}`);
  });
  // On blur, like every other key in this app: not saved keystroke by keystroke, and the
  // field is emptied the moment it has been handed over.
  $('goalKey').addEventListener('blur', async () => {
    const input = $<HTMLInputElement>('goalKey');
    const submitted = input.value;
    const key = submitted.trim();
    // Whitespace is not a key. Passing it through trim as an empty string used to invoke the
    // remove-key path and then claim a key was stored.
    if (key === '') return;
    const next = await run(api.setGoalKey(key));
    if (next) {
      // A blur can be followed immediately by refocus + new typing while IPC is in flight.
      // Clear only the exact value that successfully crossed the secret-store boundary.
      if (input.value === submitted) input.value = '';
      applyGoal(next);
      toast('OpenRouter key stored');
    }
  });
  $('goalKeyRemove').addEventListener('click', async () => {
    const next = await run(api.setGoalKey(''));
    if (next) {
      applyGoal(next);
      toast('OpenRouter key removed');
    }
  });
}

/**
 * One clause under the row, not a paragraph: what the switch will do, and the fact that
 * the number it fires on is this app's own estimate rather than ChatGPT's accounting.
 */
function applyAutoCompactHint(config: Config): void {
  $('autoCompactHint').textContent = config.compaction.auto
    ? 'Interrupts an active answer at this many tokens, writes a handoff, and opens a fresh chat.'
    : 'Off — only the Compact & resume button in the ChatGPT tab compacts.';
}

/**
 * Every control on the settings sheet, and the whole of it.
 *
 * A field that is not here does not save: it keeps what was typed until the next repaint
 * and then quietly reverts. `autoCompactTokens` was missing, which made the one number the
 * automatic trigger fires on the one control in the app that never kept what you typed.
 * `sessRecord` is deliberately absent — it lives in the Home permission list now, with
 * every other switch that decides what ChatGPT can reach, and saves from there.
 */
const CHAT_INPUTS = [
  'sessRetain',
  'autoCompact',
  'autoCompactTokens',
  'maWorkers',
  'allowUnattributedCalls',
  'recoverAgentTabs',
  'goalEnabled',
  'goalReasoning',
  'goalPrompt',
  'goalObjectivePrompt'
];

/** Writes app state into this panel's controls. Called from the renderer's apply(). */
export function chatApply(state: AppState, previous?: Config): void {
  const { config, bridge } = state;

  // `sessRecord` is painted by the renderer's own apply(): it lives in the Home
  // permission list now, with every other switch that decides what ChatGPT can reach.
  applyChatValue($<HTMLInputElement>('sessRetain'), String(config.sessions.retainDays), previous?.sessions.retainDays);

  applyChatChecked($<HTMLInputElement>('autoCompact'), config.compaction.auto, previous?.compaction.auto);
  applyChatValue(
    $<HTMLInputElement>('autoCompactTokens'),
    String(config.compaction.autoTokens),
    previous?.compaction.autoTokens
  );
  applyAutoCompactHint(config);

  applyChatValue($<HTMLInputElement>('maWorkers'), String(config.multiAgent.maxWorkers), previous?.multiAgent.maxWorkers);
  applyChatChecked(
    $<HTMLInputElement>('allowUnattributedCalls'),
    config.multiAgent.allowUnattributedCalls,
    previous?.multiAgent.allowUnattributedCalls
  );
  applyChatChecked(
    $<HTMLInputElement>('recoverAgentTabs'),
    config.multiAgent.recoverAgentTabs,
    previous?.multiAgent.recoverAgentTabs
  );

  applyGoal(state, previous);

  // Extension bridge. Connecting is automatic, so this reports rather than asks.
  const browserRequired = browserExtensionRequired(config);
  $<HTMLButtonElement>('bridgeUnpair').disabled = !bridge.paired;
  const secureStorageAvailable = state.secureStorage?.available ?? true;
  $('bridgeState').textContent = !browserRequired
    ? 'Browser-backed features are off. The extension is not needed right now.'
    : !secureStorageAvailable
      ? (state.secureStorage?.detail ?? 'Secure credential storage is unavailable, so the extension cannot pair safely.')
    : !bridge.running
      ? 'The local bridge is off even though recording or multi-agent mode needs it.'
      : bridge.present
        ? `Connected. Listening on 127.0.0.1:${bridge.port ?? '?'} · last message ${ago(bridge.lastSeenAt)}.`
        : bridge.paired
          ? `Authorized, but the browser extension is not currently connected. ${
              bridge.lastSeenAt === null ? 'It has not checked in since this app started.' : `Last seen ${ago(bridge.lastSeenAt)}.`
            }`
          : `Listening on 127.0.0.1:${bridge.port ?? '?'} · no browser is authorized or connected yet.`;
  $('bridgeState').classList.toggle('is-warn', browserRequired && (!bridge.present || !secureStorageAvailable));
  void showExtensionPath();

  if (sessions.length > 0) paintSessions();
}

/** Called when the Chat tab becomes visible or is left, so it only polls when shown. */
export function chatVisible(next: boolean): void {
  visible = next;
  if (next) void refreshAll();
}

async function refreshAll(): Promise<void> {
  await loadSessions();
  const swarmNow = await run(api.getSwarm());
  if (swarmNow) paintSwarm(swarmNow);
}

/** Sessions change on every recorded event, so the reload is coalesced. */
function scheduleReload(): void {
  if (!visible) return;
  window.clearTimeout(listTimer);
  listTimer = window.setTimeout(() => void loadSessions(), 400);
}

// ------------------------------------------------------------------- wiring

/**
 * Switches the session card's body.
 *
 * Settings is reachable only from the gear, so it is deliberately not one of the switcher
 * buttons: while it is open no switcher button is selected, and the gear itself carries
 * the selected state instead. That is what keeps a property sheet from reading as a third
 * view of this session.
 */
function showView(name: string): void {
  for (const button of $('chatView').querySelectorAll<HTMLButtonElement>('[data-view]')) {
    button.classList.toggle('is-sel', button.dataset.view === name);
  }
  for (const view of document.querySelectorAll<HTMLElement>('#chatBody > .view')) {
    view.hidden = view.dataset.view !== name;
  }
  $('chatSettingsBtn').classList.toggle('is-on', name === 'settings');
}

/** Timeline or Compaction — whichever the gear was opened over. */
let lastContentView = 'timeline';

/** The gear toggles: pressing it again returns to the view the user came from. */
function toggleSettings(): void {
  const settings = document.querySelector<HTMLElement>('#chatBody > .view[data-view="settings"]');
  showView(settings && !settings.hidden ? lastContentView : 'settings');
}

export function initChat(next: Deps): void {
  deps = next;

  $('sessionList').addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-id]');
    if (!row?.dataset.id || row.dataset.id === selectedId) return;
    selectedId = row.dataset.id;
    detailFor = null;
    detailCursor = null;
    // A different session is a different set of calls; nothing here should arrive open.
    openTools.clear();
    handoff = null;
    handoffFor = null;
    paintSessions();
    void loadDetail();
  });
  $('sessionList').closest<HTMLElement>('.scroll')?.addEventListener('scroll', maybePageSessions);

  $('chatView').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-view]');
    if (!button?.dataset.view) return;
    lastContentView = button.dataset.view;
    showView(button.dataset.view);
  });

  $('chatSettingsBtn').addEventListener('click', () => toggleSettings());

  $('chatAgentFilter').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-agent]');
    if (!button) return;
    agentFilter = button.dataset.agent === '' ? null : (button.dataset.agent ?? null);
    paintDetail();
  });

  $('chatRefresh').addEventListener('click', () => void refreshAll());

  $('copyHandoff').addEventListener('click', async () => {
    if (!handoff) return;
    const copied = await run(api.writeClipboard(handoff.text));
    if (copied) toast('Handoff copied');
  });

  $('swarmReset').addEventListener('click', async () => {
    const state = await run(api.resetSwarm());
    if (state) {
      paintSwarm(state);
      toast('Swarm cleared');
    }
  });

  // Which of the two things happened is decided in the main process and reported back,
  // so the toast describes the actual outcome rather than the intent of the click.
  $('swarmList').addEventListener('click', async (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLElement>('[data-clear]');
    const id = button?.dataset.clear;
    if (!id) return;
    const outcome = await run(api.clearAgent(id));
    if (!outcome) return;
    paintSwarm(outcome.swarm);
    toast(
      outcome.cleared === 'run'
        ? 'Run cleared — every worker ended'
        : outcome.cleared === 'worker'
          ? `${id} cleared — its slot is free`
          : outcome.reason
    );
  });

  for (const id of CHAT_INPUTS) {
    $(id).addEventListener('change', () => void deps.save());
  }

  wireGoal(() => deps.save());

  $('bridgeUnpair').addEventListener('click', async () => {
    const state = await run(api.unpairExtension());
    if (state) toast('Browser disconnected');
  });
  $('bridgeFolder').addEventListener('click', async () => {
    const dir = await run(api.openExtensionFolder());
    if (dir) toast('Extension folder opened');
  });

  api.onSessionChanged(scheduleReload);
  api.onSwarmChanged(paintSwarm);
}
