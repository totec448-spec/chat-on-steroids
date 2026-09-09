import { applyChatModels, applyComposerSessionModel, initChatModels, confirmedComposerModel, ensureComposerModel } from './chat-models.js';
import { marked, Marked } from 'marked';
import { safeExternalLink } from '../shared/external-link.js';
import { createAgentPanel } from './agent-panel.js';
import { preserveTimelineViewport } from './timeline-scroll.js';
import { toolResultText } from './tool-result.js';
import { communicationTitle, foldAgentCommunication } from './agent-communication.js';
import { initContextMeter, paintContextMeter } from './context-meter.js';
import { isAstraModel } from '../shared/chat-models.js';
import type { InputImage, InputAttachment, InputAutomation } from '../shared/input.js';
import type { InputEntry } from '../main/session/input.js';
import type { LocalProject } from '../shared/projects.js';
import type { TaskProgress } from '../shared/task-progress.js';
/**
 * Desktop chat workspace: recorded prose/tool truth, exact-session controls and a composer.
 * The extension remains the ChatGPT transport; main owns permissions, delivery, Goal and
 * compaction. The renderer crosses only the fixed preload API and scopes async views to
 * the selected session generation. Token and cost values remain explicitly estimates.
 */

import type {
  ActivitySummary,
  AgentState,
  Handoff,
  SessionEvent,
  SessionSummary,
  StoredText,
  SwarmState,
  TokenPressure
} from '../shared/session.js';
import {
  ATTRIBUTION_LABELS,
  CHAT_ACTIVE_MS,
  CONTINUATION_MARKER,
  TURN_OUTCOME_LABELS,
  foldProgress
} from '../shared/session.js';
import { chronological } from '../shared/chronology.js';
import {
  DEFAULT_GOAL_MODEL,
  DEFAULT_GOAL_LOOP_SYSTEM_PROMPT,
  DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT,
  DEFAULT_GOAL_SYSTEM_PROMPT,
  MAX_GOAL_SYSTEM_PROMPT_CHARS
} from '../shared/goal.js';
import { browserExtensionRequired, type AppState, type Config } from '../shared/types.js';
import { $, ago, clockTime, compactNumber, el, filterSettingsSections, icon, run, toast } from './dom.js';

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
let newChatSelected = true;
let selectedProjectId: string | null = null;
let projects: LocalProject[] = [];
const collapsedProjects = new Set<string>();
const projectVisibleCounts = new Map<string, number>();
const PROJECT_TASK_PAGE_SIZE = 5;
function draftKey(): string { return selectedId ?? (selectedProjectId ? `project:${selectedProjectId}` : 'new'); }
let selectionGeneration = 0;
let pendingNewInput: { id: string; generation: number } | null = null;
let agentPanel: ReturnType<typeof createAgentPanel> | null = null;
const expandedWorkers = new Set<string>();
const inputDrafts = new Map<string, string>();
const imageDrafts = new Map<string, Array<InputImage | InputAttachment>>();
const startingInputs = new Map<string, InputEntry>();
const visibleInputIds = new Set<string>();
// Window-local presentation only: a new incident or changed status is visible again.
const dismissedRecoveryNotices = new Map<string, string>();
// Dismisses presentation only; durable cancellation and late receipts remain in the outbox.
const INPUT_NOTICE_KEY = 'dismissed-input-notices';
const dismissedInputNotices = new Set<string>((() => {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(INPUT_NOTICE_KEY) ?? '[]');
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string' && id.length <= 64).slice(-100) : [];
  } catch { return []; }
})());
function dismissInputNotice(id: string): void {
  dismissedInputNotices.add(id);
  try { window.localStorage.setItem(INPUT_NOTICE_KEY, JSON.stringify([...dismissedInputNotices].slice(-100))); }
  catch { /* A storage failure still allows dismissal for this window lifetime. */ }
  void refreshInputQueue();
}
function rememberDraft(): void { inputDrafts.set(draftKey(), $<HTMLTextAreaElement>('chatInput').value); }
function restoreDraft(): void { cancelGoalRequest(); cancelTaskPlan(); $('taskPlanPreview').hidden = true; $('taskPlanPreview').replaceChildren(); $('activeGoalRow').hidden = true; $('recoveryStatus').hidden = true; $<HTMLTextAreaElement>('chatInput').value = inputDrafts.get(draftKey()) ?? ''; const automation = $<HTMLSelectElement>('chatAutomation'); automation.value = 'off'; delete automation.dataset.edited; $<HTMLTextAreaElement>('sessionObjective').value = ''; delete $('sessionObjective').dataset.edited; delete $('sessionObjective').dataset.sessionId; paintComposerImages(); }
function paintComposerImages(): void {
  const key = draftKey();
  const images = imageDrafts.get(key) ?? [];
  const box = $('composerImages'); box.hidden = !images.length; box.replaceChildren();
  images.forEach((image, index) => {
    const tile = 'dataUrl' in image ? el('div', 'composer-image') : attachmentCard(image, true);
    if ('dataUrl' in image) { const preview = document.createElement('img'); preview.src = image.dataUrl; preview.alt = image.name; tile.append(preview); }
    const remove = el('button', 'image-remove', '×'); remove.setAttribute('type', 'button'); remove.setAttribute('aria-label', `Remove ${image.name}`);
    remove.addEventListener('click', () => { imageDrafts.set(key, images.filter((_entry, at) => at !== index)); paintComposerImages(); });
    tile.append(remove); box.append(tile);
  });
  paintDeliveryControls();
}
function attachmentCard(file: InputAttachment, inComposer = false): HTMLElement {
  if (file.preview) {
    const image = document.createElement('img'); image.src = file.preview; image.alt = file.name; image.title = file.name;
    if (!inComposer) return image;
    const tile = el('div', 'composer-image'); tile.append(image); return tile;
  }
  const tile = el('div', 'attachment-card'); tile.title = file.name;
  const glyph = el('span', 'attachment-icon');
  glyph.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '24'); svg.setAttribute('height', '24');
  const lines = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  lines.setAttribute('d', 'M7 3h10a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Zm1 6h8M8 13h8M8 17h5');
  lines.setAttribute('fill', 'none'); lines.setAttribute('stroke', 'currentColor'); lines.setAttribute('stroke-width', '1.6'); lines.setAttribute('stroke-linecap', 'round');
  svg.append(lines); glyph.append(svg);
  const details = el('div', 'attachment-details');
  details.append(el('div', 'attachment-name', file.name), el('div', 'attachment-kind', file.mimeType.startsWith('image/') ? 'Image' : 'File'));
  tile.append(glyph, details); return tile;
}

let events: SessionEvent[] = [];
let totalEvents = 0;
/** The session whose `events`/cursor pair belongs together. */
let detailFor: string | null = null;
let detailCursor: number | null = null;
let historyBefore: number | null = null;
let historyLoading = false;
/** The last swarm the app reported, so the header can summarise it without the log. */
let swarm: SwarmState | null = null;
/**
 * ChatGPT conversations the user has blocked from using local tools.
 *
 * Live policy the main process owns, keyed by conversation rather than by session, and pushed
 * with every session list. The renderer only ever mirrors it — pressing the button asks the
 * main process and repaints from the answer it gets back.
 */
let blockedChats = new Set<string>();
/** Badges the list is currently drawn with. See repaintBadges. */
let badgeKey = '';

/** Handoff currently shown, and the id it was loaded for. */
let handoff: Handoff | null = null;
let handoffFor: string | null = null;

let listTimer: number | undefined;
let listRefreshDirty = false;
let toolActivityTimer: number | undefined;
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
/**
 * How long after its session start or last exact attributed tool call a chat still reads as
 * working.
 *
 * Prime owns the run for its whole life, so its agent state alone would light this badge
 * permanently and say nothing. An open turn was the gate instead, which is exact but too
 * narrow: when a page loses its answer stream the recorder has no open turn, while the model
 * behind it goes on calling tools for minutes. That is a chat very much at work, shown as idle
 * — and the moment a user most wants to see that it is still going.
 *
 * The bridge's recovery window is deliberately the shorter of the two, and the authorities remain
 * separate: this derives display state from the durable session summary; the bridge derives a
 * browser action from exact observations and attributed calls. The label outliving the reload
 * window is the point — a chat being reloaded on the app's instruction is mid-repair, and the
 * badge going dark first is what made that reload look like it came out of nowhere.
 */
/**
 * Pro uses the bridge's live ten-minute activity deadline.
 * Other sessions and exact calls stay active for three minutes unless a later turn end finished
 * them — the model's final answer, or the turn ending any other way, the user's stop included.
 * A refused call in a blocked chat still counts as the call it was: the badge is how the user
 * sees that something is still trying, and it goes dark the moment the turn is stopped.
 */
function recentChatActivity(summary: SessionSummary, now = Date.now()): boolean {
  if (summary.activityExpiresAt !== undefined) {
    return summary.activityExpiresAt !== null && now < summary.activityExpiresAt;
  }
  const lastActivityAt = Math.max(summary.startedAt, summary.lastToolCallAt ?? 0);
  const finishedAt = Math.max(summary.lastAssistantFinalAt ?? 0, summary.lastTurnEndAt ?? 0);
  return lastActivityAt > finishedAt && now - lastActivityAt < CHAT_ACTIVE_MS;
}

/**
 * A worker whose newest call was its own finish report has stopped working, whatever the swarm
 * currently says or fails to say: the run parks the moment its last worker stops, and a parked
 * run has no agent view for the list to read.
 */
function workerReportedFinish(summary: SessionSummary): boolean {
  return (
    summary.origin?.kind === 'worker' &&
    typeof summary.lastFinishReportAt === 'number' &&
    summary.lastFinishReportAt >= (summary.lastToolCallAt ?? 0)
  );
}

/** Reload-generated turn boundaries are not activity authority; session start, calls and finals are. */
function sessionWorking(summary: SessionSummary): boolean {
  return summary.endedAt === null && !workerReportedFinish(summary) && recentChatActivity(summary);
}

/**
 * Is the Unattributed stream blocked?
 *
 * There is no per-chat block to read: the whole point of this row is that the app cannot say
 * which chat these calls came from, so the only switch that can answer for them is the
 * app-wide one. Off is a block — a call the app cannot attribute is refused — which is why
 * the row draws it with the same button and the same word as a blocked chat.
 */
function unattributedBlocked(): boolean {
  return deps.state()?.config.multiAgent.allowUnattributedCalls === false;
}

function sessionBadges(summary: SessionSummary): Badge[] {
  const badges: Badge[] = [];
  const origin = summary.origin;
  // The one session that is not a chat. Saying so on the row is what stops it reading
  // as a chat that mysteriously lost its name.
  if (summary.conversationId === null) {
    return unattributedBlocked()
      ? [{ text: 'blocked', tone: 'is-failed' }, { text: 'not a chat', tone: '' }]
      : [{ text: 'not a chat', tone: '' }];
  }
  // First, and in the failure tone: a blocked chat is the one state on this row that says the
  // app is actively refusing work, and the user came to the list to find it at a glance.
  if (blockedChats.has(summary.conversationId)) badges.push({ text: 'blocked', tone: 'is-failed' });
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
  // Owning a run is not the same as running a turn. Exact chat activity wins; only an idle
  // worker falls back to its broker lifecycle label.
  // Exact recorded tool activity belongs to the session, not to the renderer's current swarm
  // projection. A parked/restarted run can lose its AgentView while the chat still makes calls.
  const workerStopped = agent?.role === 'worker' && ['sleeping', 'finished', 'failed'].includes(agent.state);
  if (workerStopped) badges.push(AGENT_BADGE[agent.state]);
  // The swarm no longer shows this worker — its run parked when it and its siblings stopped —
  // but its own session records that its last call was the finish report. That is a worker
  // between jobs, and "sleeping" is the word that says its chat can be woken.
  else if (!agent && workerReportedFinish(summary)) badges.push(AGENT_BADGE.sleeping);
  else if (sessionWorking(summary)) badges.push(AGENT_BADGE.active);
  else if (agent && agent.role !== 'prime') badges.push(AGENT_BADGE[agent.state]);
  return badges;
}

function sessionRow(summary: SessionSummary): HTMLElement {
  const row = el('div', 'sess');
  row.dataset.id = summary.id;
  if (summary.id === selectedId) row.classList.add('is-sel');
  if (summary.id === activeId && summary.endedAt === null) row.classList.add('is-live');

  const top = el('div', 'sess-top');
  const title = el('b', '', summary.title || 'Untitled session');
  top.append(title);
  const badges = sessionBadges(summary);
  row.title = [summary.title || 'Untitled session', ...badges.map((badge) => badge.text), ago(summary.updatedAt)].join(' · ');
  const showTip = () => {
    document.getElementById('sessionTooltip')?.remove();
    const tip = el('div', 'session-tooltip', row.title);
    tip.id = 'sessionTooltip'; tip.setAttribute('role', 'tooltip');
    const bounds = row.getBoundingClientRect();
    tip.style.left = `${Math.min(bounds.right + 10, window.innerWidth - 290)}px`;
    tip.style.top = `${Math.min(bounds.top, window.innerHeight - 110)}px`;
    document.body.append(tip);
  };
  row.addEventListener('pointerenter', showTip);
  row.addEventListener('pointerleave', () => document.getElementById('sessionTooltip')?.remove());
  row.addEventListener('click', () => document.getElementById('sessionTooltip')?.remove());
  const status = badges.find((badge) => badge.tone);
  if (status) {
    const indicator = el('span', `session-status ${status.tone}`);
    indicator.title = status.text;
    indicator.setAttribute('aria-label', status.text);
    top.append(indicator);
  }
  const actionBar = el('div', 'sess-actions');

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
  if (summary.conversationId === null) {
    // The same button in the same column as a chat's, because it is the same decision: may
    // this activity use local tools? It has no conversation to be stored against, so it moves
    // the app-wide switch — the checkbox on the settings sheet — and nothing else.
    const blocked = unattributedBlocked();
    const block = document.createElement('button');
    block.className = `btn sess-action sess-block${blocked ? ' is-blocked' : ''}`;
    block.type = 'button';
    block.title = blocked
      ? 'Allow unattributed calls: self-contained calls run again even when the app cannot prove which chat sent them'
      : 'Block unattributed calls: every call the app cannot attribute to a chat is refused and the chat is told to stop';
    block.append(icon(blocked ? 'i-play' : 'i-ban'));
    block.addEventListener('click', (event) => {
      event.stopPropagation();
      void toggleUnattributedBlock(!blocked);
    });
    actions.push(block);

    actionBar.append(...actions, remove);
    row.append(top, actionBar);
    return row;
  }
  if (summary.conversationId) {
    // The stop this app can actually make. It does not touch the running ChatGPT turn — nothing
    // here can — it takes this chat's tools away, and a model whose every call is refused with
    // an instruction to stop finishes its turn on its own.
    const blocked = blockedChats.has(summary.conversationId);
    const block = document.createElement('button');
    block.className = `btn sess-action sess-block${blocked ? ' is-blocked' : ''}`;
    block.type = 'button';
    block.title = blocked
      ? 'Release this chat: its tool calls run again'
      : 'Block this chat: every tool call it makes is refused and it is told to stop';
    block.append(icon(blocked ? 'i-play' : 'i-ban'));
    block.addEventListener('click', (event) => {
      event.stopPropagation();
      void toggleSessionBlock(summary.id, !blocked);
    });
    actions.push(block);

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

  actionBar.append(...actions, remove);
  row.append(top, actionBar);
  return row;
}

/**
 * Blocks or releases the Unattributed stream by moving the one switch that governs it.
 *
 * The settings sheet's checkbox is the stored state, and the renderer's save path reads every
 * control from the DOM — so this presses that checkbox rather than inventing a second way to
 * write the same setting. One switch, two places to reach it.
 */
async function toggleUnattributedBlock(blocked: boolean): Promise<void> {
  $<HTMLInputElement>('allowUnattributedCalls').checked = !blocked;
  await deps.save();
  paintSessions();
}

async function toggleSessionBlock(id: string, blocked: boolean): Promise<void> {
  const next = await run(api.setSessionBlocked(id, blocked));
  if (next === null) return;
  blockedChats = new Set(next);
  paintSessions();
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
  const [list, catalog] = await Promise.all([run(api.listSessions({ limit: SESSION_PAGE_SIZE })), run(api.listProjects())]);
  if (!list || generation !== sessionsLoadGeneration) return;
  if (catalog) projects = catalog;
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
  // Whole-set replacement on every page, older pages included: a block belongs to a
  // conversation, not to whichever page happened to carry its row.
  blockedChats = new Set(list.blocked);
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
  paintSessions();
  await loadDetail();
  void refreshInputQueue();
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
    blockedChats = new Set(page.blocked);
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

let diagnosticsExpanded = false;

function paintSessions(): void {
  document.getElementById('sessionTooltip')?.remove();
  const list = $('sessionList');
  const children = new Map<string, SessionSummary[]>();
  const ids = new Set(sessions.map((entry) => entry.id));
  for (const entry of sessions) {
    if (entry.origin?.kind !== 'worker') continue;
    const parent = entry.origin.fromSessionId;
    const key = parent && ids.has(parent) && parent !== entry.id ? parent : 'other-workers';
    children.set(key, [...(children.get(key) ?? []), entry]);
  }
  const rows: HTMLElement[] = [];
  // A task and its expanded workers are one sidebar item for project pagination.
  const projectRows = new Map<string, Array<{ rows: HTMLElement[]; selected: boolean }>>();
  const diagnostics: SessionSummary[] = [];
  const group = (key: string, workers: SessionSummary[], parentRow?: HTMLElement, target = rows): void => {
    const button = el('button', 'worker-toggle');
    button.append(icon('i-chev'));
    button.title = `${workers.length} sub-agents · ${workers.filter(sessionWorking).length} active`;
    button.setAttribute('aria-label', `${expandedWorkers.has(key) ? 'Collapse' : 'Expand'} ${workers.length} sub-agents`);
    button.setAttribute('type', 'button'); button.setAttribute('aria-expanded', String(expandedWorkers.has(key)));
    button.addEventListener('click', (event) => { event.stopPropagation(); expandedWorkers.has(key) ? expandedWorkers.delete(key) : expandedWorkers.add(key); paintSessions(); });
    if (parentRow) { parentRow.append(button); parentRow.title += ` · ${button.title}`; } else target.push(button);
    if (expandedWorkers.has(key)) { const box = el('div', 'worker-group'); box.append(...workers.map(sessionRow)); target.push(box); }
  };
  for (const entry of sessions) {
    if (entry.origin?.kind === 'worker') continue;
    if (!entry.conversationId) { diagnostics.push(entry); continue; }
    const target: HTMLElement[] = entry.projectId ? [] : rows;
    const row = sessionRow(entry); target.push(row);
    const workers = children.get(entry.id); if (workers) group(entry.id, workers, row, target);
    if (entry.projectId) {
      const tasks = projectRows.get(entry.projectId) ?? [];
      tasks.push({ rows: target, selected: entry.id === selectedId || workers?.some(worker => worker.id === selectedId) === true });
      projectRows.set(entry.projectId, tasks);
    }
  }
  const otherWorkers = children.get('other-workers') ?? [];
  if (otherWorkers.length) {
    const history = document.createElement('details'); history.className = 'session-diagnostics';
    history.open = expandedWorkers.has('other-workers');
    history.append(el('summary', '', `Sub-agent history · ${otherWorkers.length}`));
    history.append(...otherWorkers.map(sessionRow));
    history.addEventListener('toggle', () => { if (history.isConnected) history.open ? expandedWorkers.add('other-workers') : expandedWorkers.delete('other-workers'); });
    rows.push(history);
  }
  const projectIds = [...new Set([...projects.map(project => project.id), ...projectRows.keys()])];
  const projectSections: HTMLElement[] = [];
  for (const id of projectIds) {
    const project = projects.find(row => row.id === id);
    const section = document.createElement('details'); section.className = 'project-group'; section.dataset.projectId = id;
    section.open = !collapsedProjects.has(id);
    const heading = el('summary', 'project-heading');
    const label = el('span', 'project-name', project?.name ?? 'Unavailable project');
    heading.title = project?.path ?? 'Unavailable project';
    heading.append(icon('i-folder'), label); section.append(heading);
    section.addEventListener('toggle', () => { if (section.isConnected) section.open ? collapsedProjects.delete(id) : collapsedProjects.add(id); });
    if (project) {
      const create = el('button', 'btn project-new'); create.append(icon('i-plus')); create.setAttribute('type', 'button'); create.dataset.newProject = id;
      create.title = 'New chat in this project'; create.setAttribute('aria-label', create.title);
      create.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); selectNewChat(id); }); heading.append(create);
    }
    const tasks = projectRows.get(id) ?? [];
    const count = projectVisibleCounts.get(id) ?? PROJECT_TASK_PAGE_SIZE;
    const shown = tasks.filter((task, index) => index < count || task.selected);
    section.append(...shown.flatMap(task => task.rows));
    if (shown.length < tasks.length) {
      const more = el('button', 'btn project-show-more', 'Show more') as HTMLButtonElement;
      more.type = 'button'; more.setAttribute('aria-label', `Show more tasks in ${project?.name ?? 'this project'}`);
      more.addEventListener('click', () => { projectVisibleCounts.set(id, count + PROJECT_TASK_PAGE_SIZE); paintSessions(); });
      section.append(more);
    }
    projectSections.push(section);
  }
  if (diagnostics.length) {
    const disclosure = document.createElement('details');
    disclosure.className = 'session-diagnostics';
    disclosure.open = diagnosticsExpanded;
    disclosure.append(el('summary', '', `Unattributed activity · ${diagnostics.length}`));
    disclosure.append(...diagnostics.map(sessionRow));
    disclosure.addEventListener('toggle', () => { diagnosticsExpanded = disclosure.open; });
    rows.push(disclosure);
  }
  // Projects must remain discoverable without scrolling through the entire ungrouped history.
  list.replaceChildren(...projectSections, ...rows);
  agentPanel?.update(selectedId, sessions.filter(entry => entry.origin?.kind === 'worker' && entry.origin.fromSessionId === selectedId && selectedId !== null));
  badgeKey = badgeSignature();
  $('sessionsEmpty').hidden = sessions.length > 0 || projects.length > 0;

  scheduleToolActivityExpiry();
}

/** Repaint once at the nearest activity-window boundary; no polling clock is needed. */
function scheduleToolActivityExpiry(): void {
  window.clearTimeout(toolActivityTimer);
  toolActivityTimer = undefined;
  if (!visible) return;
  const now = Date.now();
  let nearest = Number.POSITIVE_INFINITY;
  for (const summary of sessions) {
    const lastToolCallAt = summary.lastToolCallAt;
    const lastActivityAt = Math.max(summary.startedAt, lastToolCallAt ?? 0);
    if (!recentChatActivity(summary, now)) continue;
    const expiry = summary.activityExpiresAt ?? lastActivityAt + CHAT_ACTIVE_MS;
    if (expiry > now) nearest = Math.min(nearest, expiry);
  }
  if (!Number.isFinite(nearest)) return;
  toolActivityTimer = window.setTimeout(() => paintSessions(), Math.max(1, nearest - now + 1));
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

let controlsGeneration = 0;
let controlledSessionId: string | null = null;
let controlledTurnId: string | null = null;
let controlledSelection = -1;
let controlledStopPending = false;
let controlledFinishWaiting = false;
let controlledQueueAtFinish = false;
let controlledCanInject = false;
let pendingComposerInputs: InputEntry[] = [];
let inputQueueGeneration = 0;
let goalIntentGeneration = 0;
let goalProgress: (Omit<TaskProgress, 'phase'> & { phase: string; selection: number; inputId?: string }) | null = null;
function cancelGoalRequest(): void {
  const requestId = goalProgress?.requestId;
  goalProgress = null;
  if (requestId) void api.cancelTaskRequest?.(requestId);
  paintGoalProgress();
}
type GoalDraftPresentation = { stage: string; model: string; text: string; error: string | null };
let goalDraftView: GoalDraftPresentation | null = null;
let finishGoalDraftView: GoalDraftPresentation | null = null;
function paintGoalProgress(): void {
  let row = document.getElementById('goalLifecycle');
  if (!row) { row = el('div', 'queued-input'); row.id = 'goalLifecycle'; row.setAttribute('role', 'status'); $('activeGoalRow').before(row); }
  const progress = goalProgress?.selection === selectionGeneration ? goalProgress : null;
  const entry = progress?.inputId ? pendingComposerInputs.find(item => item.id === progress.inputId) : undefined;
  const finishDraft = controlledSessionId === selectedId && controlledSelection === selectionGeneration ? finishGoalDraftView : null;
  const draft = finishDraft ?? (controlledSessionId === selectedId && controlledSelection === selectionGeneration ? goalDraftView : null);
  const off = $<HTMLSelectElement>('chatAutomation').value === 'off';
  if (off && !finishDraft) { row.hidden = true; row.replaceChildren(); row.setAttribute('aria-busy', 'false'); return; }
  let phase = progress?.phase ?? '';
  let text = progress?.text ?? '', error = progress?.error;
  if (entry) { phase = entry.state; error = entry.error ?? undefined; }
  if (draft && (!off || finishDraft) && (finishDraft || !['saving', 'failed'].includes(phase))) { phase = draft.stage; text = draft.text; error = draft.error ?? undefined; }
  const labels: Record<string, string> = { saving: 'Saving task…', saved: 'Task saved · waiting for the next completed answer',
    preparing: 'Preparing the opening message…', generating: 'Generating the opening message…', ready: 'Message ready · awaiting ChatGPT delivery',
    sending: 'Preparing a continuation…', answering: 'Generating a continuation…', queued: 'Opening message queued',
    browser: 'Sending opening message to ChatGPT…', sent: 'Opening message sent', tool: 'Opening message delivered to the active turn',
    failed: 'Task could not continue', cancelled: 'Opening message cancelled', paused: 'Automation paused · task text preserved', 'no-reply': 'Goal reached' };
  if (phase === 'retrying') { text = ''; error = undefined; }
  labels.retrying = `Provider busy · retry ${progress?.attempt ?? ''}${progress?.retryAt ? ' at ' + new Date(progress.retryAt).toLocaleTimeString() : ''}`;
  row.hidden = !phase; if (!phase) return;
  const busy = ['saving', 'preparing', 'generating', 'retrying', 'sending', 'answering', 'browser', 'queued', 'ready'].includes(phase) && !error;
  row.setAttribute('aria-busy', String(busy));
  const marker = el('span', busy ? 'session-status is-working' : 'session-status');
  const body = el('div', 'queue-label'); body.append(el('span', '', error ? `${labels.failed}: ${error}` : labels[phase] ?? phase));
  if (text && ['generating', 'answering', 'preparing'].includes(phase)) { const preview = el('pre', 'goal-live-preview', text.slice(-8000)); body.append(preview); }
  row.replaceChildren(marker, body);
}
const cancelledStarts = new Set<string>();
const queuedFollowup = (entry: InputEntry): boolean => entry.mode === 'finish' || (entry.mode === 'after-turn' && !!entry.sessionId && entry.purpose !== 'decision');
function pendingComposerInput(): InputEntry | undefined {
  return [...startingInputs.values(), ...pendingComposerInputs].find(entry => (!queuedFollowup(entry) || entry.state === 'browser') && ['queued', 'browser'].includes(entry.state) &&
    (selectedId ? (entry.sessionId ?? entry.deliveredSessionId) === selectedId :
      (pendingNewInput?.generation === selectionGeneration && pendingNewInput.id === entry.id) || (!entry.sessionId && !entry.deliveredSessionId && entry.purpose !== 'decision')));
}
let durationTimer: number | undefined;
function paintDeliveryControls(): void {
  paintGoalProgress();
  const working = selectedId !== null && controlledSessionId === selectedId && controlledSelection === selectionGeneration && controlledTurnId !== null;
  const queueAtFinish = selectedId !== null && controlledSessionId === selectedId && controlledSelection === selectionGeneration && controlledQueueAtFinish;
  const canInject = selectedId !== null && controlledSessionId === selectedId && controlledSelection === selectionGeneration && controlledCanInject;
  $('queueAtFinish').hidden = !queueAtFinish;
  $('afterTurnLabel').textContent = queueAtFinish ? 'Queue at Session finish' : 'After this turn';
  const generate = $<HTMLButtonElement>('generateFinishGoal');
  const queued = [...startingInputs.values(), ...pendingComposerInputs].some(entry =>
    (entry.sessionId ?? entry.deliveredSessionId) === selectedId && ['queued', 'browser', 'tool'].includes(entry.state));
  generate.hidden = !working || !controlledFinishWaiting || queued || controlledStopPending || !!finishGoalDraftView;
  generate.disabled = generate.dataset.busy === `${selectedId}:${controlledTurnId}`;
  const sendOption = $<HTMLSelectElement>('sendMode').querySelector('option[value="auto"]');
  if (sendOption) sendOption.textContent = canInject ? 'Inject now' : 'Send';
  if (!canInject && !queueAtFinish) $<HTMLSelectElement>('sendMode').value = 'auto';
  const pending = pendingComposerInput();
  const stop = (working || !!pending) && !$<HTMLTextAreaElement>('chatInput').value.trim() && !(imageDrafts.get(draftKey())?.length);
  // Hover selects delivery for the next message. Clicking the empty-composer
  // Stop still acts immediately; there is no second Stop action in the menu.
  $('sendOptions').hidden = !canInject && !queueAtFinish;
  const send = $<HTMLButtonElement>('chatSend');
  send.disabled = !!preparedPlan && (preparedPlan.sending || preparedPlan.stages.some(stage => !stage.trim()));
  send.dataset.action = stop ? 'stop' : 'send';
  send.setAttribute('aria-label', stop ? (controlledStopPending ? 'Stop requested' : 'Stop turn') : 'Send message');
  if (stop && !working && pending) send.setAttribute('aria-label', 'Cancel delivery');
  if (preparedPlan && !stop) send.setAttribute('aria-label', 'Start full plan');
  else if (planMode && !stop) send.setAttribute('aria-label', 'Generate plan');
  send.classList.toggle('is-plan-ready', !!preparedPlan && !stop);
  send.title = stop && !working && pending ? 'Cancel delivery' : preparedPlan && !stop ? 'Start full plan' : planMode && !stop ? 'Click to generate plan' : '';
  send.classList.toggle('is-stop', stop);
  for (const button of $('sendOptions').querySelectorAll<HTMLElement>('[data-delivery]')) {
    button.setAttribute('aria-checked', String(button.dataset.delivery === $<HTMLSelectElement>('sendMode').value));
  }
}
function dockAction(label: string, symbol: string, click: () => void): HTMLButtonElement {
  const button = el('button', 'dock-action') as HTMLButtonElement;
  button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
  button.append(icon(symbol)); button.onclick = click; return button;
}
function paintActiveGoal(): void {
  const row = $('activeGoalRow');
  const mode = $<HTMLSelectElement>('chatAutomation').value;
  row.hidden = !selectedId || mode === 'off';
  if (row.hidden) { row.replaceChildren(); return; }
  const objective = $<HTMLTextAreaElement>('sessionObjective').value.trim();
  const label = el('span', 'queue-label', `${mode === 'loop' ? 'Loop' : 'Pursuing goal'}${objective ? ' · ' + objective : ''}`);
  label.title = objective;
  row.replaceChildren(icon('i-pulse'), label,
    dockAction('Pause automation', 'i-power', () => { const select = $<HTMLSelectElement>('chatAutomation'); select.value = 'off'; select.dispatchEvent(new Event('change')); }),
    dockAction('Edit task', 'i-pencil', () => { $<HTMLDetailsElement>('composerSettings').open = true; $<HTMLTextAreaElement>('sessionObjective').focus(); }));
}
let planGeneration = 0;
let planMode = false;
let planRequestId: string | null = null;
let preparedPlan: { selection: number; text: string; stages: string[]; sending: boolean } | null = null;
function cancelTaskPlan(): void {
  if (planRequestId) void api.cancelTaskRequest?.(planRequestId);
  planRequestId = null;
  preparedPlan = null;
  ++planGeneration; planMode = false;
  $('taskPlanPreview').hidden = true; $('taskPlanPreview').replaceChildren();
  const button = $<HTMLButtonElement>('createPlan');
  delete button.dataset.busy; button.removeAttribute('aria-busy');
  $<HTMLTextAreaElement>('chatInput').placeholder = 'Ask anything…';
  paintTaskActions();
  paintDeliveryControls();
}
async function createTaskPlan(backend: 'api' | 'chatgpt'): Promise<void> {
  const input = $<HTMLTextAreaElement>('chatInput'), text = input.value.trim();
  planMode = true; paintTaskActions(); paintDeliveryControls();
  if (!text) { input.placeholder = 'Describe the task to turn into a plan…'; input.focus(); return; }
  const generation = ++planGeneration, selection = selectionGeneration;
  const preview = $('taskPlanPreview'); preview.hidden = false;
  preview.replaceChildren(el('span', 'muted', 'Creating plan…'));
  const button = $<HTMLButtonElement>('createPlan');
  const caption = button.querySelector('span')!; const previous = caption.textContent;
  button.dataset.busy = 'true'; button.setAttribute('aria-busy', 'true'); caption.textContent = 'Creating plan…'; paintTaskActions();
  const requestId = crypto.randomUUID();
  if (planRequestId) void api.cancelTaskRequest?.(planRequestId);
  planRequestId = requestId;
  const unsubscribe = api.onTaskProgress?.(progress => {
    if (progress.requestId !== requestId || generation !== planGeneration || selection !== selectionGeneration) return;
    const label = progress.phase === 'retrying' ? `Provider busy · retry ${progress.attempt ?? ''}${progress.retryAt ? ' at ' + new Date(progress.retryAt).toLocaleTimeString() : ''}` : progress.phase === 'cancelled' ? 'Plan cancelled' : progress.phase === 'preparing' ? 'Preparing plan…' : progress.phase === 'ready' ? 'Plan ready' : progress.phase === 'failed' ? 'Plan failed' : 'Writing plan…';
    preview.replaceChildren(el('span', 'muted', label));
    if (progress.text || progress.error) preview.append(el('pre', 'task-progress-text', progress.error || progress.text));
  });
  let stages: string[] | null;
  try {
    const result = await api.draftTaskPlan(text, backend, requestId);
    stages = result.ok ? result.data : null;
    if (!result.ok && generation === planGeneration && selection === selectionGeneration) {
      const error = el('div', 'muted', result.error === 'invalid_goal_decision_json' ? 'The planner response could not be read.' : result.error);
      error.title = result.error; preview.replaceChildren(error);
    }
  }
  finally { unsubscribe?.(); if (planRequestId === requestId) planRequestId = null; if (generation === planGeneration) { delete button.dataset.busy; button.removeAttribute('aria-busy'); caption.textContent = previous; paintTaskActions(); } }
  if (generation !== planGeneration || selection !== selectionGeneration) return;
  if (!stages) { preview.hidden = false; preview.append(el('div', 'muted', 'Send again to retry, or cancel the plan.')); return; }
  if (input.value.trim() !== text) { preview.hidden = true; toast('Your draft changed; generate a plan from the updated task.'); return; }
  preparedPlan = { selection, text, stages, sending: false };
  paintPreparedPlan();
  paintDeliveryControls();
}
function paintPreparedPlan(): void {
  const plan = preparedPlan;
  if (!plan) return;
  const preview = $('taskPlanPreview'); preview.hidden = plan.sending;
  // Sending hands presentation to the outbox/queued-stage rows. Keeping the editable
  // draft visible until the async receipt arrives paints the same plan twice. Retain
  // its data so a rejected send can restore the editable preview in the existing finally.
  if (plan.sending) { preview.replaceChildren(); return; }
  preview.replaceChildren(...plan.stages.map((stage, index) => {
    const row = el('div', 'plan-stage');
    const heading = el('div', 'plan-stage-heading');
    const label = el('span', 'stage-number', String(index + 1)); label.setAttribute('aria-label', `Stage ${index + 1}`);
    const text = el('span', 'queue-label', stage); text.title = stage;
    const field = document.createElement('textarea'); field.value = stage; field.maxLength = 16000; field.hidden = true;
    field.setAttribute('aria-label', `Edit stage ${index + 1}`);
    const error = el('span', 'stage-error', 'Enter text or delete this stage.'); error.id = `planStageError-${index}`; error.hidden = !!stage.trim();
    const validate = () => { error.hidden = !!field.value.trim(); field.setAttribute('aria-invalid', String(!error.hidden)); paintDeliveryControls(); };
    field.setAttribute('aria-describedby', error.id); field.setAttribute('aria-invalid', String(!error.hidden));
    field.oninput = () => { plan.stages[index] = field.value; text.textContent = field.value; text.title = field.value; validate(); };
    const edit = dockAction(`Edit stage ${index + 1}`, 'i-pencil', () => {
      field.hidden = !field.hidden; edit.setAttribute('aria-expanded', String(!field.hidden)); if (!field.hidden) field.focus();
    });
    edit.setAttribute('aria-expanded', 'false');
    const remove = dockAction(`Delete stage ${index + 1}`, 'i-trash', () => {
      if (plan.sending) return;
      plan.stages.splice(index, 1);
      if (plan.stages.length) { paintPreparedPlan(); paintDeliveryControls(); } else cancelTaskPlan();
    });
    edit.disabled = remove.disabled = field.disabled = plan.sending;
    heading.title = index === 0 ? 'Send includes your complete request and the full plan. Later stages are queued as verification checkpoints.' : 'Included in the first message, then queued as a checkpoint at Session finish or after a completed answer when enabled.';
    heading.append(label, text, edit, remove); row.append(heading, field, error); return row;
  }));
}
async function sendPreparedPlan(): Promise<void> {
  const plan = preparedPlan;
  if (!plan || plan.sending) return;
  if (plan.selection !== selectionGeneration || $<HTMLTextAreaElement>('chatInput').value.trim() !== plan.text) { cancelTaskPlan(); return; }
  const tasks = plan.stages.map(stage => stage.trim());
  if (!tasks.length || tasks.some(task => !task) || JSON.stringify(tasks).length > 12000) { toast('Keep every stage nonempty and the plan below 12,000 characters.'); return; }
  plan.sending = true; paintPreparedPlan();
  try {
    const sent = await sendComposer(undefined, tasks);
    if (preparedPlan === plan && sent) { await refreshInputQueue(); if (preparedPlan === plan) cancelTaskPlan(); }
  } finally {
    if (preparedPlan === plan) { plan.sending = false; paintPreparedPlan(); paintDeliveryControls(); }
  }
}
function paintTaskActions(): void {
  const objective = $<HTMLTextAreaElement>('sessionObjective');
  const save = $<HTMLButtonElement>('saveSessionObjective');
  const off = $<HTMLSelectElement>('chatAutomation').value === 'off';
  objective.hidden = off;
  document.querySelector<HTMLLabelElement>('label[for="sessionObjective"]')!.hidden = off;
  save.hidden = off;
  const saved = objective.dataset.saved === objective.value && !!objective.value.trim();
  save.disabled = objective.disabled || !objective.value.trim() || save.dataset.busy === 'true' || saved;
  save.querySelector('span')!.textContent = save.dataset.busy === 'true' ? 'Saving…' : saved ? 'Saved' : 'Save task';
  const text = $<HTMLTextAreaElement>('chatInput').value.trim();
  for (const id of ['createPlan']) {
    const button = $<HTMLButtonElement>(id);
    button.disabled = false;
    button.setAttribute('aria-pressed', String(planMode));
    button.querySelector('span')!.textContent = planMode ? 'Cancel plan' : 'Create plan';
    button.title = planMode ? 'Return to a normal message; keep your draft' : text ? 'Split your message into editable stages' : 'Write a message in the composer first';
  }
}
function paintAutomationSwitch(): void {
  paintGoalProgress();
  paintActiveGoal();
  const select = $<HTMLSelectElement>('chatAutomation');
  for (const button of $('automationSwitch').querySelectorAll<HTMLButtonElement>('[data-mode]')) {
    button.setAttribute('aria-checked', String(button.dataset.mode === select.value));
    button.disabled = select.disabled;
  }
  $<HTMLSelectElement>('sessionObjectiveMode').value = select.value === 'loop' ? 'loop' : 'goal';
  const loop = select.value === 'loop';
  document.querySelector('label[for="sessionObjective"]')!.textContent = loop ? 'Loop instructions' : 'Goal';
  $<HTMLTextAreaElement>('sessionObjective').placeholder = loop ? 'What should each continuation focus on?' : 'What should this chat achieve?';
  paintTaskActions();
}
async function refreshSessionControls(): Promise<void> {
  const id = selectedId, generation = ++controlsGeneration;
  const menu = $('sessionControls');
  paintAutomationSwitch();
  if (!id) { controlledSessionId = null; controlledTurnId = null; paintDeliveryControls(); menu.hidden = false;
    $<HTMLTextAreaElement>('sessionObjective').disabled = false;
    paintTaskActions();
    for (const action of ['compactSession', 'cancelCompaction']) $(action).hidden = true;
    return; }
  const controls = await run(api.getSessionControls(id));
  if (generation !== controlsGeneration || id !== selectedId) return;
  controlledSessionId = id;
  controlledSelection = selectionGeneration;
  controlledTurnId = controls?.activeTurnId ?? null;
  goalDraftView = controls?.goalDraft ?? null;
  finishGoalDraftView = controls?.finishGoalDraft ?? null;
  controlledStopPending = controls?.stopPending === true;
  controlledFinishWaiting = controls?.finishWaiting === true;
  controlledQueueAtFinish = controls?.queueAtFinish === true;
  controlledCanInject = controls?.canInject ?? controlledTurnId !== null;
  paintDeliveryControls();
  paintStateLine();
  menu.hidden = !controls;
  $('compactSession').hidden = false;
  if (!controls) return;
  const objective = $<HTMLTextAreaElement>('sessionObjective');
  if (objective.dataset.sessionId !== id || !objective.dataset.edited) {
    objective.value = controls.objective;
    objective.dataset.saved = controls.objective;
    objective.dataset.sessionId = id;
    delete objective.dataset.edited;
    $<HTMLSelectElement>('sessionObjectiveMode').value = controls.automation === 'loop' ? 'loop' : 'goal';
  }
  objective.disabled = !!controls.blocked;
  paintTaskActions();
  const draftMode = $<HTMLSelectElement>('chatAutomation');
  if (!draftMode.dataset.edited) draftMode.value = controls.automation;
  paintAutomationSwitch();
  $<HTMLButtonElement>('compactSession').disabled = !!controls.blocked || !!controls.job?.busy;
  $('cancelCompaction').hidden = !controls.job?.busy;
  $('sessionControlStatus').textContent = controls.blocked === 'worker' ? 'This sub-agent is managed by its prime.' : controls.blocked === 'blocked' ? 'This chat is blocked.' : controls.job?.busy ? 'Compaction is running in ChatGPT.' : '';
}

async function navigateHistory(before: number | null, prepend = false): Promise<void> {
  const selected = selectedId;
  const selection = selectionGeneration;
  historyBefore = before;
  detailCursor = null;
  const loading = loadDetail(true, prepend);
  const generation = detailLoadGeneration;
  await loading;
  if (selectedId !== selected || selectionGeneration !== selection || detailLoadGeneration !== generation) return;
  if (!prepend) $('chatBody').scrollTop = before === null ? $('chatBody').scrollHeight : 0;
}
async function loadDetail(navigate = false, prepend = false, newerFrom?: number): Promise<void> {
  const wanted = selectedId;
  if (wanted !== null && historyBefore !== null && detailFor === wanted && !navigate) { void refreshSessionControls(); paintDetail(); return; }
  const generation = ++detailLoadGeneration;
  void refreshSessionControls();
  if (wanted === null) {
    handoffLoadGeneration++;
    historyBefore = null;
    events = [];
    totalEvents = 0;
    detailFor = null;
    detailCursor = null;
    paintDetail();
    return;
  }
  if (detailFor !== wanted) historyBefore = null;
  // Live deltas must not evict a historical page while the user is reading it.
  const incremental = newerFrom === undefined && historyBefore === null && detailFor === wanted && detailCursor !== null;
  const detail = await run(
    api.getSession(wanted, newerFrom !== undefined ? { from: newerFrom, limit: MAX_TIMELINE_ROWS / 2 } : incremental ? { from: detailCursor!, limit: MAX_TIMELINE_ROWS } : { ...(historyBefore !== null ? { before: historyBefore } : {}), limit: prepend ? MAX_TIMELINE_ROWS / 2 : MAX_TIMELINE_ROWS })
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
    if (newerFrom !== undefined) {
      events = chronological(foldProgress([...events, ...folded])).slice(-MAX_TIMELINE_ROWS);
      // Reaching the live tail restores ordinary delta reads. Paging itself preserves
      // the reader's row even when they were at the bottom of the previous window.
      if (detail.events.length < MAX_TIMELINE_ROWS / 2) historyBefore = null;
    } else if (prepend) {
      const boundary = historyBefore!;
      const retained = events.filter(event => event.seq >= boundary).slice(0, MAX_TIMELINE_ROWS - folded.length);
      events = chronological(foldProgress([...folded, ...retained]));
      // Keep the newly requested history reachable even if one retained answer exceeds
      // the text budget by itself. The bounded page then starts at the older content.
      let textCost = events.reduce((sum, event) => sum + eventTextCost(event), 0);
      while (events.length > folded.length && textCost > MAX_TIMELINE_TEXT_CHARS) textCost -= eventTextCost(events.pop()!);
    } else events = folded.slice(Math.max(0, folded.length - MAX_TIMELINE_ROWS));
    detailFor = wanted;
  }
  detailCursor =
    typeof detail.nextFrom === 'number'
      ? detail.nextFrom
      : detail.events.reduce((cursor, event) => Math.max(cursor, event.seq + 1), incremental ? detailCursor! : 0);
  totalEvents = detail.total;
  paintDetail(!prepend && newerFrom === undefined);
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
  // Recorded text is whatever language the user and ChatGPT were speaking. The stylesheet is
  // written left-to-right throughout, so an Arabic or Hebrew message rendered without this
  // reads with its punctuation and numbers on the wrong side. `auto` resolves from the first
  // strong character, so Latin text is unaffected.
  node.setAttribute('dir', 'auto');
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
  return safeExternalLink(trimmed) ? trimmed : null;
}

const PROVIDER_CITATION = /^\uE200(?:cite|filecite)\uE202[^\uE200\uE201]*\uE201/;
const PROVIDER_URL = /^\uE200url\uE202([^\uE200-\uE202]*)\uE202([^\uE200-\uE202]*)\uE201/;
/** Native citation labels and URLs may arrive before the DOM paints the rest of a canonical
 * revision. Use only exact source ranges with matching preceding prose, never substitute
 * the whole captured HTML or guess a destination from an opaque provider reference id. */
function citationLabels(source: string, capture?: StoredText): Map<string, string> {
  const links = new Map<string, string>();
  if (!capture?.text || capture.truncated || capture.text.length > MAX_RENDERED_HTML_CHARS) return links;
  const template = document.createElement('template');
  template.innerHTML = capture.text;
  // Provider reference ranges count Unicode code points; JS slice counts UTF-16
  // units. Emoji before a citation otherwise move every subsequent range.
  const offsets = new Uint32Array(source.length + 1);
  let points = 0, units = 0;
  for (const char of source) { offsets[points++] = units; units += char.length; }
  offsets[points] = units;
  const normalized = (text: string) => text.replace(/\s+/g, ' ').trim();
  const prose = (fragment: DocumentFragment) => {
    // Native HTML and Markdown emit different whitespace around hard breaks and
    // list paragraphs. Compare the same rendered word boundaries in both trees.
    for (const br of fragment.querySelectorAll('br')) br.replaceWith('\n');
    for (const block of fragment.querySelectorAll('p,div,li,ul,ol,blockquote,pre,h1,h2,h3,h4,h5,h6,table,tr,td,th')) {
      block.prepend('\n'); block.append('\n');
    }
    return normalized(fragment.textContent ?? '');
  };
  for (const reference of template.content.querySelectorAll('[data-content-reference-start][data-content-reference-end]')) {
    const from = Number(reference.getAttribute('data-content-reference-start'));
    const to = Number(reference.getAttribute('data-content-reference-end'));
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > points) continue;
    const start = offsets[from]!, end = offsets[to]!;
    const marker = source.slice(start, end);
    if (marker.match(PROVIDER_CITATION)?.[0] !== marker) continue;
    const before = document.createRange(); before.setStart(template.content, 0); before.setEndBefore(reference);
    const preceding = before.cloneContents();
    for (const prior of preceding.querySelectorAll('[data-content-reference-start]')) prior.remove();
    const canonical = document.createElement('template');
    canonical.innerHTML = marked.parse(source.slice(0, start).replace(/\uE200(?:cite|filecite)\uE202[^\uE200\uE201]*\uE201/g, ''), { async: false, gfm: true });
    if (prose(preceding) !== prose(canonical.content)) continue;
    if (marker.startsWith('\uE200filecite\uE202')) {
      const names = [...reference.querySelectorAll('[data-file-citation-primary-file-id] button')]
        .map(node => normalized(node.textContent ?? '')).filter(name => name.length > 0 && name.length <= 500);
      if (names.length) {
        const label = document.createElement('span');
        label.textContent = ` (${[...new Set(names)].join(', ')})`;
        links.set(marker, label.outerHTML);
      }
      continue;
    }
    const anchors: string[] = [], seen = new Set<string>();
    for (const candidate of reference.querySelectorAll('a[href]')) {
      const href = safeRenderedHref(candidate.getAttribute('href') ?? '');
      if (!href || !/^https?:/.test(href) || seen.has(href)) continue;
      seen.add(href);
      const anchor = document.createElement('a'); anchor.href = href;
      anchor.textContent = new URL(href).hostname;
      anchor.title = candidate.textContent?.trim().slice(0, 500) || 'Source';
      anchors.push(anchor.outerHTML);
    }
    if (anchors.length) links.set(marker, ` (${anchors.join(', ')})`);
  }
  return links;
}

/**
 * Sanitizes ChatGPT's captured rendered HTML without reparsing Markdown.
 *
 * The page is untrusted input even though the extension produced the observation. Preserve
 * semantic Markdown tags, discard executable/form/embed content, strip every attribute by
 * default, and allow only the tiny attribute set that affects normal Markdown semantics.
 */
/**
 * One assistant message, as ChatGPT rendered it when that is available and whole, and as its
 * own markdown source when it is not.
 *
 * The two are laid out differently on purpose. Rendered markup carries its own block
 * structure, so it is flowed (`rich`). Markdown source is plain text whose every line break,
 * heading and list item is a newline, so it keeps `msg`'s pre-wrap — flowing it would run a
 * whole brief together into one paragraph.
 */
export function renderedMarkdown(source: string, capture?: StoredText): HTMLElement {
  // Fiber's canonical text can be complete while a background provider tab still
  // paints its first words. Render this revision directly; captured DOM HTML is
  // never evidence that it contains the current message revision.
  const text = source.slice(0, MAX_RENDERED_HTML_CHARS);
  const citations = text.includes('\uE200') ? citationLabels(text, capture) : new Map<string, string>();
  // An inline tokenizer leaves literal citation examples inside code spans/fences intact.
  const parser = new Marked({ gfm: true, extensions: [{
    name: 'providerReference', level: 'inline',
    start: value => value.indexOf('\uE200'),
    tokenizer(value) { const match = value.match(PROVIDER_URL) ?? value.match(PROVIDER_CITATION); return match ? { type: 'providerReference', raw: match[0] } : undefined; },
    renderer(token) {
      const url = token.raw.match(PROVIDER_URL);
      if (url) {
        // Unlike opaque citation IDs, a native url token already carries its exact
        // authored label and destination. Captured React anchors may have no href.
        const link = document.createElement('a'); link.textContent = url[1] || url[2] || 'Link';
        if (safeExternalLink(url[2] ?? '')) link.setAttribute('href', url[2]!);
        return link.outerHTML;
      }
      return citations.get(token.raw) ?? (token.raw.startsWith('\uE200filecite\uE202') ? '' : '<span title="The recording does not include this source URL">[source link unavailable]</span>');
    }
  }] });
  const html = parser.parse(text, { async: false });
  return renderedMessage({ text: html, chars: html.length, truncated: html.length > MAX_RENDERED_HTML_CHARS }, text);
}

export function renderedMessage(html: StoredText | null | undefined, fallback: string): HTMLElement {
  const box = el('div', 'msg');
  // Same reason as textBlock, for the markdown path — and it is the fallback rather than the
  // authority: an element below that carried its own direction keeps it.
  box.setAttribute('dir', 'auto');
  const safeFallback = fallback.slice(0, MAX_RENDERED_HTML_CHARS);
  // A capture the store had to cut is markup that stops mid-element — very often inside a
  // code block, whose wrapper chrome is far larger than the code in it — so it presents part
  // of the message and ends as an unclosed box. It is not a presentation of this message and
  // is not shown as one.
  if (!html || html.truncated || !html.text) {
    box.textContent = safeFallback;
    return box;
  }
  box.classList.add('rich');
  const template = document.createElement('template');
  // Parsing untrusted captured HTML constructs a second tree before sanitisation. Bound it
  // before innerHTML so a valid but huge recorded turn cannot freeze/OOM the renderer.
  template.innerHTML = html.text.slice(0, MAX_RENDERED_HTML_CHARS);
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
      // ChatGPT marks the direction of its own right-to-left content. Stripping every
      // attribute threw that away and re-rendered the message left-to-right; the container's
      // `dir="auto"` then resolved the whole message from its first strong character, which a
      // mixed-language answer gets wrong paragraph by paragraph. Presentational only, with a
      // closed set of values, so it carries no script or navigation surface.
      const dir = element.getAttribute('dir')?.toLowerCase();
      for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
      if (dir === 'ltr' || dir === 'rtl' || dir === 'auto') element.setAttribute('dir', dir);
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
  const openLink = (event: MouseEvent): void => {
    if (event.type === 'auxclick' && event.button !== 1) return;
    const anchor = (event.target as Element | null)?.closest?.('a[href]');
    if (!anchor || !box.contains(anchor)) return;
    const href = safeRenderedHref(anchor.getAttribute('href') ?? '');
    event.preventDefault();
    if (!href) return;
    if (href.startsWith('#')) { document.getElementById(href.slice(1))?.scrollIntoView(); return; }
    // Electron deliberately denies arbitrary renderer navigation/window.open. A user
    // activation crosses the existing, independently validated main-process link API.
    void run(api.openLink(href));
  };
  box.addEventListener('click', openLink);
  box.addEventListener('auxclick', openLink);
  // Tables wrap to the transcript column. Extremely wide structural tables retain
  // their own horizontal scroll instead of widening/clipping the whole conversation.
  for (const table of box.querySelectorAll('table')) {
    const viewport = el('div', 'markdown-table');
    viewport.tabIndex = 0;
    viewport.setAttribute('role', 'region');
    viewport.setAttribute('aria-label', 'Table');
    table.replaceWith(viewport);
    viewport.append(table);
  }
  if (!box.textContent?.trim() && safeFallback) {
    box.classList.remove('rich');
    box.textContent = safeFallback;
  }
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

/**
 * The rows currently on screen, by timeline key, with the signature they were drawn from.
 *
 * A repaint rebuilds only the rows whose signature changed and reuses every other element
 * as it is. That is what keeps the scroll position honest: a row the user has opened keeps
 * its height and its place, so the pane does not lurch when ChatGPT records one more call —
 * and the rebuilt-from-scratch list, which made the whole pane re-lay out on every event,
 * is what made reading an open call impossible while a chat was working.
 */
const rowCache = new Map<string, { sig: string; row: HTMLElement }>();

function forgetTimelineRows(): void {
  openTools.clear();
  rowCache.clear();
}

function toolBody(event: Extract<SessionEvent, { kind: 'tool_call' }>, context?: { id: string; current: () => boolean }): HTMLElement {
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
  const images = call.assets?.filter(asset => ['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType)) ?? [];
  const readable = toolResultText(call.result.text, call.result.truncated, images.length > 0);
  if (readable) raw.append(textBlock('pre', readable, call.result.truncated && images.length === 0, call.result.chars));
  if (images.length && (context?.id || selectedId)) {
    const id = context?.id ?? selectedId!, generation = selectionGeneration;
    const attachments = el('div', 'tool-images');
    let loaded = false;
    const load = async () => {
      if (!box.open || loaded) return;
      loaded = true;
      for (const asset of images) {
        const data = await run(api.getSessionImage(id, asset.id));
        if (context ? !context.current() : id !== selectedId || generation !== selectionGeneration) return;
        if (!data) { attachments.append(el('p', 'meta', 'Image unavailable')); continue; }
        const image = document.createElement('img');
        image.src = data; image.alt = `${call.tool} result`; image.loading = 'lazy';
        image.style.cssText = 'display:block;max-width:100%;max-height:600px;object-fit:contain;margin:8px 0';
        attachments.append(image);
      }
    };
    box.addEventListener('toggle', () => void load());
    raw.append(attachments);
    void load();
  }
  if (call.result.assetId) raw.append(el('p', 'raw-facts', `Full recorded response: ${call.result.assetId}`));

  for (const asset of call.assets ?? []) {
    raw.append(el('p', 'raw-facts', `asset ${asset.id} · ${asset.mimeType} · ${compactNumber(asset.bytes)} bytes`));
  }

  box.append(raw);
  return box;
}

function hasLaterModelActivity(time: number): boolean {
  return events.some(event => event.time > time && ['assistant_message', 'tool_call', 'page_tool', 'agent_message'].includes(event.kind));
}

function paintInputReceipt(row: HTMLElement, item: ReturnType<typeof timelineItems>[number]): void {
  if (item.kind !== 'event' || item.event.kind !== 'user_message') return;
  const receipt = row.querySelector<HTMLElement>('.input-receipt');
  if (!receipt) return;
  receipt.hidden = hasLaterModelActivity(item.event.time);
  receipt.parentElement?.classList.toggle('has-input-receipt', !receipt.hidden);
}

function eventBody(event: SessionEvent, context?: { id: string; current: () => boolean }): HTMLElement {
  switch (event.kind) {
    case 'session_start':
      return el('p', 'meta', `Session started — ${event.title}`);
    case 'user_message': {
      const box = el('div', 'said is-user');
      box.append(el('b', '', 'You'));
      const attachments = el('div', 'message-attachments');
      if (event.attachments?.length) attachments.append(...event.attachments.map(file => attachmentCard(file)));
      const assets = event.assets?.filter(asset => asset.mimeType === 'image/webp').slice(0, 4) ?? [];
      if (event.attachments?.length || assets.length) box.append(attachments);
      const userText = event.authoredText ?? event.message.text;
      if (userText) box.append(textBlock('msg user-message-text', userText, event.authoredText === undefined && event.message.truncated, event.authoredText?.length ?? event.message.chars));
      if (event.inputDelivery) {
        box.classList.add('has-input-receipt');
        const receipt = el('span', 'input-receipt');
        const label = event.inputDelivery === 'offered' ? 'Sent to the active turn · awaiting receipt' : 'Delivery confirmed';
        receipt.title = label; receipt.setAttribute('aria-label', label);
        receipt.append(icon(event.inputDelivery === 'offered' ? 'i-clock' : 'i-check'));
        box.append(receipt);
      }
      if (assets.length && (context?.id || selectedId)) {
        const id = context?.id ?? selectedId!, generation = selectionGeneration;
        void (async () => {
          for (const asset of assets) {
            const data = await run(api.getSessionImage(id, asset.id));
            if (context ? !context.current() : id !== selectedId || generation !== selectionGeneration) return;
            if (!data) { attachments.append(el('p', 'meta', 'Image unavailable')); continue; }
            const image = document.createElement('img');
            image.src = data; image.alt = 'User attachment'; image.loading = 'lazy';
            attachments.append(image);
          }
        })();
      }
      return box;
    }
    case 'assistant_message': {
      const box = el('div', 'said');
      box.append(el('b', '', event.final ? 'ChatGPT' : 'ChatGPT (partial)'));
      box.append(renderedMarkdown(event.message.text, event.renderedHtml));
      return box;
    }
    case 'progress':
      return el('p', 'meta is-progress', event.message.text);
    case 'page_tool': {
      const line = el('p', 'meta is-progress thinking-line');
      line.append(icon('i-globe', 'ico thinking-ico'), el('span', '', event.label));
      return line;
    }
    case 'turn_start':
      return el('p', 'meta', event.detail ? `Turn reopened — ${event.detail}` : 'Turn started');
    case 'turn_end': {
      const line = el(
        'p',
        event.outcome === 'completed' ? 'meta' : 'meta is-warn',
        `Turn ${TURN_OUTCOME_LABELS[event.outcome]}${event.detail ? ` — ${event.detail}` : ''}`
      );
      return line;
    }
    case 'chat_error': {
      const notice = el('div', 'chat-error-notice');
      notice.setAttribute('role', 'status');
      const title = el('strong', '', 'ChatGPT reported a problem');
      notice.append(title, textBlock('msg', event.message.text, event.message.truncated, event.message.chars));
      return notice;
    }
    case 'tool_call':
      return toolBody(event, context);
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
      const box = document.createElement('details');
      box.className = 'agent-communication';
      // Which end of the message this record is. The same message is written once here and
      // once in the other agent's session, so without this a pair reads as two messages.
      box.title =
        event.delivery === 'sent'
          ? `Sent by ${event.from}; recorded when the app accepted it`
          : `Received by ${event.to}; recorded when it acknowledged delivery`;
      const summary = el('summary');
      const worker = event.from === 'prime' ? event.to : event.from;
      const avatar = el('span', 'agent-avatar', worker.replace(/^worker-/, ''));
      avatar.dataset.color = String([...worker].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 6);
      avatar.setAttribute('aria-hidden', 'true');
      summary.append(avatar, el('span', '', communicationTitle(event)));
      const communicationKey = `agent:${context?.id ?? selectedId}:${event.seq}`;
      box.open = openTools.has(communicationKey);
      box.addEventListener('toggle', () => { if (box.open) openTools.add(communicationKey); else openTools.delete(communicationKey); });
      box.append(summary);
      box.append(textBlock('msg', event.message.text, event.message.truncated, event.message.chars));
      if (!context) {
        const matches = sessions.filter(entry => entry.origin?.kind === 'worker' && entry.origin.fromSessionId === selectedId && entry.origin.agentId === worker);
        if (matches.length === 1) {
          const open = el('button', 'btn agent-chat-open'); open.setAttribute('type', 'button');
          open.setAttribute('aria-label', `Open ${worker} chat`);
          const arrow = icon('i-out'); arrow.setAttribute('aria-hidden', 'true');
          open.append(el('span', '', 'Open worker chat'), arrow);
          open.onclick = () => void agentPanel?.open(matches[0]!.id); box.append(open);
        }
      }
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
  const currentWorker = sessions.find(session => session.id === selectedId)?.origin;
  if (event.agent && event.agent !== 'prime' && !(currentWorker?.kind === 'worker' && currentWorker.agentId === event.agent)) {
    body.append(el('span', 'chip', event.agent));
  }
  body.append(eventBody(event));
  // A refused call from a chat Compact & Resume already replaced is not a placement failure:
  // its request id proved exactly which chat it came from, and that chat's stopped turn simply
  // kept calling from OpenAI's side. Say so beside the row, or a full Unattributed bucket of
  // these reads as the attribution chain having broken.
  if (event.kind === 'tool_call' && event.call.attributionMethod === 'superseded') {
    body.append(
      el(
        'p',
        'meta',
        'From a chat that Compact & Resume had already replaced — ChatGPT kept running its stopped turn there. Refused by design; nothing to repair.'
      )
    );
  }
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
  if (!deps.state()?.config.ui.developerMode) { box.hidden = true; agentFilter = null; return; }
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
  return { shown: foldAgentCommunication(source.slice(start)), omitted: start };
}

// ------------------------------------------------------------ compaction rows

/**
 * One Compact & Resume, folded out of the rows the recorder wrote for it.
 *
 * The recorder stores a compaction as it happened: the brief request typed into chat A, the
 * brief ChatGPT answered with, the app's own "handoff saved" line, and the bootstrap typed
 * into chat B — four rows, three of them long, in an order that reflects when each was
 * observed rather than what they were. Read as a timeline they look like three separate
 * things going on; they are one thing with three steps, and this is that thing.
 */
interface CompactionBlock {
  token: string;
  /** The row this card takes the place of. */
  seq: number;
  time: number;
  prompt: Extract<SessionEvent, { kind: 'user_message' }> | null;
  /**
   * The turn ChatGPT answered the brief request in. The request is typed by the app, so its
   * row carries no local turn id of its own; the turn is the one that opens right after it.
   */
  turnId: string | null;
  brief: Extract<SessionEvent, { kind: 'assistant_message' }> | null;
  handoff: Extract<SessionEvent, { kind: 'handoff' }> | null;
  resume: Extract<SessionEvent, { kind: 'user_message' }> | null;
  /** What the app said about this compaction, newest last — an abandonment and why. */
  notes: Array<Extract<SessionEvent, { kind: 'note' }>>;
  /** Something was recorded after this compaction, so a step still missing has failed. */
  moved: boolean;
}

type TimelineItem = { kind: 'event'; event: SessionEvent } | { kind: 'compaction'; block: CompactionBlock };

function continuationMarker(event: SessionEvent): { kind: 'HANDOFF' | 'RESUME'; token: string } | null {
  if (event.kind !== 'user_message') return null;
  const match = CONTINUATION_MARKER.exec(event.message.text);
  return match ? { kind: match[1] as 'HANDOFF' | 'RESUME', token: match[2]! } : null;
}

/**
 * The timeline with each compaction folded into one item.
 *
 * A card opens at the marked brief request and, until anything unrelated is recorded,
 * absorbs what belongs to it: the turn that answers it, the answer (the brief), the app's
 * handoff line. The marked bootstrap in the replacement chat closes the same card by token,
 * wherever it lands, and so does an app note naming the token. A bootstrap whose request has
 * scrolled out of the window still gets a card, with the steps it implies already done.
 *
 * Which turn answers the request is read from the log, not from the request row. The
 * request is typed by the app into the chat, so the extension records it with no local turn
 * id (or, on a reload, with the previous turn's); the generation ChatGPT opens for it is the
 * first `turn_start` after it. Keying on the request's own `turnId` left that start, the
 * brief, the end and the handoff as four loose rows under an empty card — the live shape.
 */
function timelineItems(source: SessionEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const blocks = new Map<string, CompactionBlock>();
  let open: CompactionBlock | null = null;
  const blockFor = (token: string, event: SessionEvent): CompactionBlock => {
    let block = blocks.get(token);
    if (!block) {
      block = {
        token,
        seq: event.seq,
        time: event.time,
        prompt: null,
        turnId: null,
        brief: null,
        handoff: null,
        resume: null,
        notes: [],
        moved: false
      };
      blocks.set(token, block);
      items.push({ kind: 'compaction', block });
    }
    return block;
  };
  for (const event of source) {
    const marker = continuationMarker(event);
    if (marker && event.kind === 'user_message') {
      const block = blockFor(marker.token, event);
      if (marker.kind === 'HANDOFF') {
        block.prompt = event;
        block.turnId = event.turnId ?? null;
        open = block;
        // Chronology puts a turn's start before the message that opened it, so the request
        // turn's own start row is already on the list; it belongs to the card like the rest.
        const previous = items[items.length - 2];
        if (
          previous?.kind === 'event' &&
          previous.event.kind === 'turn_start' &&
          event.turnId !== undefined &&
          previous.event.turnId === event.turnId
        ) {
          items.splice(items.length - 2, 1);
        }
      } else {
        block.resume = event;
        if (open === block) open = null;
      }
      continue;
    }
    if (event.kind === 'note' && event.continuation) {
      const block = blockFor(event.continuation, event);
      block.notes.push(event);
      if (open === block) open = null;
      continue;
    }
    if (open) {
      if (event.kind === 'handoff') {
        open.handoff = event;
        continue;
      }
      if (event.kind === 'assistant_message') {
        open.brief = event;
        if (event.turnId !== undefined) open.turnId = event.turnId;
        continue;
      }
      if (event.kind === 'turn_start' && !open.brief && !open.handoff) {
        open.turnId = event.turnId ?? null;
        continue;
      }
      const sameTurn = open.turnId !== null && event.turnId === open.turnId;
      if (sameTurn && (event.kind === 'turn_end' || event.kind === 'progress' || event.kind === 'page_tool')) {
        continue;
      }
      open = null;
    }
    items.push({ kind: 'event', event });
  }
  for (let index = 0; index < items.length - 1; index++) {
    const item = items[index]!;
    if (item.kind === 'compaction') item.block.moved = true;
  }
  return items;
}

type CompactionTone = 'good' | 'wait' | 'bad';

const ABANDONED_NOTE = /^Compact & Resume abandoned\s*[\u2014-]\s*/i;

/**
 * One sentence for where the compaction is, or where it died.
 *
 * Green is a replacement chat that opened; red is a step that will not come — the app said
 * so, or the chat carried on without it; grey is the step still in flight. The app's own
 * abandonment note wins over any inference, because it names the reason.
 */
function compactionState(block: CompactionBlock): { text: string; tone: CompactionTone } {
  const abandoned = [...block.notes].reverse().find((note) => ABANDONED_NOTE.test(note.message.text));
  if (abandoned) return { text: `Failed — ${abandoned.message.text.replace(ABANDONED_NOTE, '')}`, tone: 'bad' };
  const chars = block.handoff ? ` (${compactNumber(block.handoff.chars)} characters)` : '';
  if (block.resume) return { text: `New chat opened at ${clockTime(block.resume.time)}${chars}`, tone: 'good' };
  if (block.handoff) {
    return block.moved
      ? { text: `Summary saved${chars}, but no new chat was opened — the chat carried on here`, tone: 'bad' }
      : { text: `Summary saved${chars} — opening the new chat…`, tone: 'wait' };
  }
  if (block.brief?.final) {
    return block.moved
      ? { text: 'Summary written, but the app never saved it — the chat carried on here', tone: 'bad' }
      : { text: 'Summary written — saving the handoff…', tone: 'wait' };
  }
  if (block.brief) return { text: 'ChatGPT is writing the summary…', tone: 'wait' };
  return block.moved
    ? { text: 'No summary was written — the chat carried on here', tone: 'bad' }
    : { text: 'Summary requested — waiting for ChatGPT…', tone: 'wait' };
}

function compactionRow(block: CompactionBlock): HTMLElement {
  const key = `compaction:${block.token}`;
  const state = compactionState(block);

  const box = document.createElement('details');
  box.className = `tool compaction tone-${state.tone}`;
  box.open = openTools.has(key);
  box.addEventListener('toggle', () => {
    if (box.open) openTools.add(key);
    else openTools.delete(key);
  });

  const head = document.createElement('summary');
  head.append(icon('i-steps', 'ico tool-ico'));
  head.append(el('b', '', 'Compact & Resume:'));
  head.append(el('span', 'state', state.text));
  box.append(head);

  const raw = el('div', 'raw');
  if (block.prompt) {
    raw.append(el('h4', '', 'Brief request'));
    // The routing marker is the app's, not the user's; the card already says what this is.
    const request = block.prompt.message.text.replace(CONTINUATION_MARKER, '');
    raw.append(textBlock('pre', request, block.prompt.message.truncated, block.prompt.message.chars));
  }
  if (block.brief) {
    raw.append(el('h4', '', block.brief.final ? 'Summary' : 'Summary (still writing)'));
    raw.append(renderedMarkdown(block.brief.message.text));
  }
  if (block.handoff) {
    raw.append(
      el('p', 'raw-facts', `Handoff saved — ${compactNumber(block.handoff.chars)} characters (${block.handoff.reason})`)
    );
  }
  if (block.resume) {
    raw.append(
      el(
        'p',
        'raw-facts',
        `Bootstrap sent into the new chat — ${compactNumber(block.resume.message.chars)} characters at ${clockTime(block.resume.time)}`
      )
    );
  }
  for (const note of block.notes) raw.append(el('p', 'raw-facts', `${clockTime(note.time)} — ${note.message.text}`));
  box.append(raw);

  const row = el('div', 'ev ev-compaction');
  const time = document.createElement('time');
  time.textContent = clockTime(block.time);
  time.title = new Date(block.time).toLocaleString();
  const body = el('div', 'ev-body');
  body.append(box);
  row.append(time, body);
  return row;
}

/** What a row was drawn from; a different signature is a different row. */
function itemSignature(item: TimelineItem): string {
  if (item.kind === 'compaction') {
    const { block } = item;
    return [
      block.token,
      block.prompt?.seq ?? '',
      block.brief ? `${block.brief.seq}:${block.brief.message.chars}:${block.brief.renderedHtml?.chars ?? 0}:${block.brief.state}` : '',
      block.handoff?.seq ?? '',
      block.resume?.seq ?? '',
      block.notes.map((note) => note.seq).join(','),
      block.moved ? 'moved' : ''
    ].join('|');
  }
  const { event } = item;
  const parts: Array<string | number> = [event.seq, event.time, event.kind, event.agent ?? ''];
  switch (event.kind) {
    case 'user_message':
      parts.push(event.message.chars, event.authoredText ?? '', event.inputDelivery ?? '');
      break;
    case 'progress':
    case 'chat_error':
    case 'note':
    case 'agent_message':
      parts.push(event.message.chars);
      break;
    case 'assistant_message':
      parts.push(event.message.chars, event.renderedHtml?.chars ?? 0, event.state ?? '', event.final ? 'final' : '');
      break;
    case 'tool_call':
      parts.push(
        event.call.outcome,
        event.call.attribution,
        event.call.durationMs,
        event.call.args.chars,
        event.call.result.chars,
        event.call.summary.title,
        event.call.summary.detail ?? ''
      );
      break;
    case 'page_tool':
      parts.push(event.label);
      break;
    case 'turn_end':
      parts.push(event.outcome, event.detail ?? '');
      break;
    case 'handoff':
      parts.push(event.chars);
      break;
    default:
      break;
  }
  return parts.join('|');
}

function itemKey(item: TimelineItem): string {
  return item.kind === 'compaction' ? `compaction:${item.block.token}` : `event:${item.event.seq}`;
}

/** One activity disclosure between authored messages; communication keeps its own identity inside. */
const toolGroups = new Map<string, HTMLDetailsElement>();
/** Keep retained scroll containers mounted: rebuilding a feed must not restart
 * disclosure animations or detach a result while the user is scrolling it. */
function reconcileChildren(parent: Element, children: HTMLElement[]): void {
  const keep = new Set<Node>(children);
  for (const old of [...parent.childNodes]) if (!keep.has(old)) old.remove();
  let cursor = parent.firstChild;
  for (const child of children) {
    if (child !== cursor) parent.insertBefore(child, cursor);
    cursor = child.nextSibling;
  }
}
function groupToolRows(rows: HTMLElement[], scope = selectedId, groups = toolGroups): HTMLElement[] {
  const grouped: HTMLElement[] = [], retained = new Set<string>();
  for (let i = 0; i < rows.length;) {
    if (!rows[i]!.matches('.ev-tool_call, .ev-page_tool, .ev-agent_message')) { grouped.push(rows[i++]!); continue; }
    let end = i + 1;
    while (end < rows.length && rows[end]!.matches('.ev-tool_call, .ev-page_tool, .ev-agent_message') && rows[end]!.dataset.activityBoundary === rows[i]!.dataset.activityBoundary) end++;
    if (end - i === 1) { grouped.push(rows[i++]!); continue; }
    const key = `group:${scope}:${rows[i]!.dataset.timelineKey}`;
    retained.add(key);
    let group = groups.get(key);
    if (!group) {
      group = document.createElement('details'); group.className = 'tool-group';
      group.dataset.timelineKey = key;
      const summary = document.createElement('summary');
      summary.append(el('span', 'activity-symbol'), el('span', 'activity-title'), icon('i-chev', 'ico activity-chevron'));
      group.append(summary, el('div', 'tool-group-body'));
      group.addEventListener('toggle', () => { if (group!.open) openTools.add(key); else openTools.delete(key); });
      group.open = openTools.has(key) || rows.slice(i, end).some((row) => row.querySelector('details[open]')); groups.set(key, group);
    }
    const latest = rows[end - 1]!;
    const latestHead = latest.querySelector('.tool > summary, .agent-communication > summary, .thinking-line');
    const label = latestHead?.querySelector('b, span:not(.agent-avatar)')?.textContent || 'Activity';
    group.querySelector('.activity-title')!.textContent = label;
    group.querySelector('summary')!.title = `${end - i} actions · ${label}`;
    const symbol = latestHead?.querySelector('svg, .agent-avatar');
    group.querySelector('.activity-symbol')!.replaceChildren(...(symbol ? [symbol.cloneNode(true)] : []));
    reconcileChildren(group.lastElementChild!, rows.slice(i, end));
    grouped.push(group); i = end;
  }
  for (const key of groups.keys()) if (!retained.has(key)) groups.delete(key);
  return grouped;
}

function paintDetail(followBottom = true): void {
  paintStateLine();
  const summary = sessions.find((s) => s.id === selectedId) ?? null;
  applyComposerSessionModel(selectedId ? `${selectedId}:${selectionGeneration}` : null, summary?.selectedModel ?? null);
  const config = deps.state()?.config;
  if (config) paintContextMeter(summary, config, confirmedComposerModel());
  $('chatTitle').textContent = summary ? summary.title || 'Untitled session' : 'New chat';

  paintDeliveryControls();
  paintAgentFilter();
  const filtered = visibleEvents();
  const windowed = boundedTimeline(filtered);
  const shown = windowed.shown;

  // Preserve the visible logical row when late transcript revisions change the
  // height above it; retaining absolute scrollTop would move the reader's content.
  const pane = $('chatBody');
  const restoreViewport = preserveTimelineViewport(pane, $('timeline'), followBottom);
  const timelineRows: HTMLElement[] = [];
  if (selectedId && historyBefore !== null) {
    const navigation = el('div', 'timeline-window-note');
    const latest = el('button', 'btn small', 'Back to latest');
    latest.dataset.history = 'latest';
    latest.addEventListener('click', () => void navigateHistory(null));
    navigation.append(latest);
    timelineRows.push(navigation);
  }
  const keep = new Set<string>();
  let activityBoundary = '';
  const recovery = [...shown].reverse().find(event => event.source === 'app' && event.kind === 'progress' && event.progressId?.startsWith('browser-repair:'));
  const recoveryStatus = $('recoveryStatus');
  const recoverySession = selectedId;
  const recoveryRevision = recovery?.kind === 'progress' ? JSON.stringify([recovery.progressId, recovery.time, recovery.message.text]) : '';
  recoveryStatus.hidden = !recovery || Date.now() - recovery.time > 120000 || (!!recoverySession && dismissedRecoveryNotices.get(recoverySession) === recoveryRevision);
  recoveryStatus.replaceChildren();
  if (!recoveryStatus.hidden && recovery?.kind === 'progress') recoveryStatus.append(icon('i-pulse'), el('span', 'queue-label', recovery.message.text),
    dockAction('Dismiss recovery notice', 'i-x', () => {
      if (recoverySession) dismissedRecoveryNotices.set(recoverySession, recoveryRevision);
      recoveryStatus.hidden = true; recoveryStatus.replaceChildren();
    }));
  for (const item of timelineItems(shown)) {
    if (item.kind === 'compaction' || !['tool_call', 'page_tool', 'agent_message'].includes(item.event.kind)) activityBoundary = itemKey(item);
    if (!deps.state()?.config.ui.developerMode && item.kind === 'event' && item.event.source === 'app' && item.event.kind === 'progress' && item.event.progressId?.startsWith('browser-repair:')) continue;
    if (!deps.state()?.config.ui.developerMode && item.kind === 'event' && ['session_start', 'session_end', 'turn_start', 'turn_end', 'note'].includes(item.event.kind)) continue;
    const key = itemKey(item);
    const sig = itemSignature(item);
    keep.add(key);
    const cached = rowCache.get(key);
    if (cached && cached.sig === sig) {
      cached.row.dataset.activityBoundary = activityBoundary;
      paintInputReceipt(cached.row, item);
      timelineRows.push(cached.row);
      continue;
    }
    const row = item.kind === 'compaction' ? compactionRow(item.block) : eventRow(item.event);
    row.dataset.timelineKey = key;
    row.dataset.activityBoundary = activityBoundary;
    paintInputReceipt(row, item);
    rowCache.set(key, { sig, row });
    timelineRows.push(row);
  }
  for (const key of rowCache.keys()) if (!keep.has(key)) rowCache.delete(key);
  reconcileChildren($('timeline'), groupToolRows(timelineRows));
  $('timelineEmpty').hidden = timelineRows.length > 0 || $('inputQueue').childElementCount > 0;
  restoreViewport();

  const facts: string[] = [];
  if (summary) {
    facts.push(`${totalEvents} event${totalEvents === 1 ? '' : 's'}`);
    if (events.length < totalEvents) facts.push(`showing a bounded page of ${events.length}`);
    if (agentFilter !== null) {
      facts.push(`filtered to ${agentFilter === UNATTRIBUTED ? 'unattributed' : agentFilter} — ${filtered.length} matched`);
    }
    if (windowed.omitted > 0) facts.push(`${shown.length} newest rendered`);
    facts.push(`~${compactNumber(summary.contextTokens)} rough current-chat context tokens`);
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
  $('chatFoot').hidden = !deps.state()?.config.ui.developerMode;
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
  window.clearTimeout(durationTimer);
  durationTimer = undefined;
  const note = $('chatState');
  const { text, tone } = stateLine();
  note.textContent = text;
  note.className = `subhead-note${tone ? ` ${tone}` : ''}`;
  note.classList.toggle('is-working', text.startsWith('Working'));
  if (visible && text.startsWith('Working for ')) durationTimer = window.setTimeout(paintStateLine, 1000);
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
  if (!deps.state()?.config.ui.developerMode) {
    const summary = sessions.find(entry => entry.id === selectedId);
    if (!summary || detailFor !== selectedId) return { text: '', tone: '' };
    const active = controlledSessionId === selectedId && controlledSelection === selectionGeneration ? controlledTurnId : null;
    const lastBoundary = [...events].reverse().find(event => event.kind === 'turn_start' || event.kind === 'turn_end');
    const turnId = active ?? lastBoundary?.turnId;
    if (!turnId) return { text: '', tone: '' };
    const startedAt = summary.finishTurn?.turnId === turnId ? summary.finishTurn.startedAt
      : events.find(event => event.kind === 'turn_start' && event.turnId === turnId)?.time;
    const endedAt = events.find(event => event.kind === 'turn_end' && event.turnId === turnId)?.time;
    if (startedAt === undefined) return { text: active ? 'Working…' : '', tone: '' };
    if (!active && endedAt === undefined) return { text: '', tone: '' };
    const seconds = Math.max(0, Math.floor(((active ? Date.now() : endedAt!) - startedAt) / 1000));
    return { text: `${active ? 'Working' : 'Worked'} for ${seconds >= 60 ? `${Math.floor(seconds / 60)}m ` : ''}${seconds % 60}s`, tone: '' };
  }
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
  // Session rows borrow their live badge from the swarm, so a worker that just went to sleep
  // must not keep saying "active" until some unrelated session update repaints the list.
  paintSessions();
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
          if (agent.runId) clear.dataset.runId = agent.runId;
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
  mcp: Config['mcp'];
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
      defaultModel: $<HTMLSelectElement>('workerModel').value,
      defaultReasoning: $<HTMLSelectElement>('workerReasoning').value as Config['multiAgent']['defaultReasoning'],
      // The exposure switch lives with every other ChatGPT tool switch, on Home. This
      // panel keeps only the worker count, so it reads the one control that exists.
      enabled: $<HTMLInputElement>('homeMaEnabled').checked,
      maxWorkers: number('maWorkers', current.multiAgent.maxWorkers, 1, 8),
      allowUnattributedCalls: $<HTMLInputElement>('allowUnattributedCalls').checked,
      recoverAgentTabs: $<HTMLInputElement>('recoverAgentTabs').checked
    },
    goal: {
      enabled: current.goal.enabled, mode: current.goal.mode,
      includeToolCalls: $<HTMLInputElement>('goalIncludeToolCalls').checked,
      backend: $<HTMLSelectElement>('goalBackend').value as Config['goal']['backend'],
      loopBackend: $<HTMLSelectElement>('loopBackend').value as Config['goal']['loopBackend'],
      helperModel: $<HTMLSelectElement>('helperModel').value || current.goal.helperModel || 'gpt-5.6-sol',
      helperReasoning: ($<HTMLSelectElement>('helperReasoning').value || current.goal.helperReasoning || 'high') as Config['goal']['helperReasoning'],
      provider: {
        kind: ($<HTMLSelectElement>('goalProvider').value || current.goal.provider?.kind || 'openrouter') as Config['goal']['provider']['kind'],
        baseUrl: $<HTMLInputElement>('goalBaseUrl').value
      },
      // The api-backend model is picked from the catalogue and never typed, except on a
      // custom endpoint whose id is typed in its own field instead. `current` is the
      // fallback for the first save after a repaint.
      model:
        $<HTMLSelectElement>('goalProvider').value === 'custom'
          ? $<HTMLInputElement>('goalCustomModel').value.trim() || current.goal.model
          : goalModel || current.goal.model,
      reasoning: $<HTMLSelectElement>('goalReasoning').value as Config['goal']['reasoning'],
      // Blank means "restore the safe default", not "send an unconstrained system message".
      prompt: $<HTMLTextAreaElement>('goalPrompt').value.trim() || DEFAULT_GOAL_SYSTEM_PROMPT,
      objectivePrompt:
        $<HTMLTextAreaElement>('goalObjectivePrompt').value.trim() ||
        DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT,
      loopPrompt:
        $<HTMLTextAreaElement>('goalLoopPrompt').value.trim() || DEFAULT_GOAL_LOOP_SYSTEM_PROMPT
    },
    // Empty is a real choice here, not a value to repair: it means "add nothing of mine".
    mcp: { instructions: $<HTMLTextAreaElement>('mcpInstructions').value.trim() }
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
let goalModel = DEFAULT_GOAL_MODEL;
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
  applyChatChecked($<HTMLInputElement>('goalIncludeToolCalls'), config.goal.includeToolCalls === true, previous?.goal.includeToolCalls);
  const automation = $<HTMLSelectElement>('chatAutomation');
  automation.disabled = !config.sessions.record;
  automation.title = config.sessions.record ? 'Continue this chat automatically' : 'Enable session recording to use Goal or Loop';
  paintAutomationSwitch();
  const secureStorageAvailable = state.secureStorage?.available ?? true;
  // This picker owns the last known OpenRouter selection. A custom deployment uses
  // its own input and must not replace that selection during an unrelated repaint.
  // A session opened directly on custom starts with the picker's defined default.
  if (config.goal.provider?.kind !== 'custom') goalModel = config.goal.model;
  applyChatValue($<HTMLSelectElement>('goalReasoning'), config.goal.reasoning, previous?.goal.reasoning);
  applyChatValue($<HTMLTextAreaElement>('goalPrompt'), config.goal.prompt, previous?.goal.prompt);
  applyChatValue($<HTMLTextAreaElement>('mcpInstructions'), config.mcp?.instructions ?? '', previous?.mcp?.instructions);
  applyChatValue(
    $<HTMLTextAreaElement>('goalObjectivePrompt'),
    config.goal.objectivePrompt,
    previous?.goal.objectivePrompt
  );
  applyChatValue(
    $<HTMLTextAreaElement>('goalLoopPrompt'),
    config.goal.loopPrompt,
    previous?.goal.loopPrompt
  );
  // Which endpoint the api backend talks to. The key sentence below only applies to
  // OpenRouter: a custom endpoint is often keyless, so a missing key never means custom.
  const customProvider = config.goal.provider?.kind === 'custom';
  const providerBaseUrl = config.goal.provider?.baseUrl ?? '';
  applyChatValue($<HTMLSelectElement>('goalProvider'), customProvider ? 'custom' : 'openrouter', previous?.goal.provider?.kind);
  applyChatValue($<HTMLInputElement>('goalBaseUrl'), providerBaseUrl, previous?.goal.provider?.baseUrl);
  applyChatValue($<HTMLInputElement>('goalCustomModel'), config.goal.model, previous?.goal.model);
  $('goalCustomPanel').hidden = !customProvider;
  $('goalPickerRow').hidden = customProvider;
  if (customProvider) $('goalModels').hidden = true;
  $('goalKeyField').hidden = customProvider;
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
  const goalCustomKey = $<HTMLInputElement>('goalCustomKey');
  goalCustomKey.placeholder = state.hasCustomProviderKey ? '•••••••• stored' : 'leave empty for a keyless local server';
  goalCustomKey.disabled = !secureStorageAvailable;
  $('goalCustomKeyState').textContent = !secureStorageAvailable
    ? (state.secureStorage?.detail ?? 'Secure credential storage is unavailable.')
    : state.hasCustomProviderKey
      ? 'A key is stored with secure OS credential storage. Type a new one to replace it.'
      : 'Optional. Stored with secure OS credential storage and sent only by the app to your configured API endpoint. The browser receives only the reply.';
  $('goalCustomKeyState').classList.toggle('is-warn', !secureStorageAvailable);
  $<HTMLButtonElement>('goalCustomKeyRemove').disabled = !state.hasCustomProviderKey || !secureStorageAvailable;
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
    toast('Goal prompt (no task) restored to default');
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
    toast('Goal prompt (with a task) restored to default');
  });
  $<HTMLTextAreaElement>('goalLoopPrompt').maxLength = MAX_GOAL_SYSTEM_PROMPT_CHARS;
  $('goalLoopPromptEdit').addEventListener('click', () => {
    const panel = $('goalLoopPromptPanel');
    panel.hidden = !panel.hidden;
    $('goalLoopPromptEdit').textContent = panel.hidden ? 'Edit prompt' : 'Close prompt';
    if (!panel.hidden) $<HTMLTextAreaElement>('goalLoopPrompt').focus();
  });
  $('goalLoopPromptReset').addEventListener('click', async () => {
    $<HTMLTextAreaElement>('goalLoopPrompt').value = DEFAULT_GOAL_LOOP_SYSTEM_PROMPT;
    await save();
    toast('Loop prompt restored to default');
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
  // Same blur-to-save discipline as the OpenRouter key above. Empty submits nothing:
  // a keyless local endpoint is a supported configuration, not a key being removed.
  $('goalCustomKey').addEventListener('blur', async () => {
    const input = $<HTMLInputElement>('goalCustomKey');
    const submitted = input.value;
    const key = submitted.trim();
    if (key === '') return;
    const next = await run(api.setCustomProviderKey(key));
    if (next) {
      if (input.value === submitted) input.value = '';
      applyGoal(next);
      toast('Custom provider key stored');
    }
  });
  $('goalCustomKeyRemove').addEventListener('click', async () => {
    const next = await run(api.setCustomProviderKey(''));
    if (next) {
      applyGoal(next);
      toast('Custom provider key removed');
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
  'chatBrowser',
  'goalIncludeToolCalls',
  'planBackend',
  'finishTool', 'finishAction', 'finishLeadMinutes', 'workerModel', 'workerReasoning', 'backgroundChats', 'browserOnly', 'autoRefreshPlugins',
  'goalBackend',
  'loopBackend',
  'helperModel', 'helperReasoning',
  'sessRetain',
  'autoCompact',
  'autoCompactTokens',
  'maWorkers',
  'allowUnattributedCalls',
  'recoverAgentTabs',
  'goalProvider',
  'goalBaseUrl',
  'goalCustomModel',
  'goalReasoning',
  'goalPrompt',
  'goalObjectivePrompt',
  'goalLoopPrompt',
  'mcpInstructions'
];

/** Writes app state into this panel's controls. Called from the renderer's apply(). */
export function chatApply(state: AppState, previous?: Config): void {
  const { config, bridge } = state;
  paintContextMeter(sessions.find(session => session.id === selectedId) ?? null, config, confirmedComposerModel());
  applyChatModels(config, previous);

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

  applyChatValue($<HTMLSelectElement>('workerModel'), config.multiAgent.defaultModel ?? '', previous?.multiAgent.defaultModel);
  applyChatValue($<HTMLSelectElement>('workerReasoning'), config.multiAgent.defaultReasoning ?? '', previous?.multiAgent.defaultReasoning);
  applyChatValue($<HTMLSelectElement>('goalBackend'), config.goal.backend ?? 'chatgpt', previous?.goal.backend);
  applyChatValue($<HTMLSelectElement>('loopBackend'), config.goal.loopBackend ?? 'chatgpt', previous?.goal.loopBackend);
  applyChatValue($<HTMLSelectElement>('helperModel'), config.goal.helperModel ?? 'gpt-5.6-sol', previous?.goal.helperModel);
  applyChatValue($<HTMLSelectElement>('helperReasoning'), config.goal.helperReasoning ?? 'high', previous?.goal.helperReasoning);
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
  else {
    window.clearTimeout(toolActivityTimer);
    window.clearTimeout(durationTimer);
    toolActivityTimer = undefined;
  }
}

async function refreshAll(): Promise<void> {
  await loadSessions();
  const swarmNow = await run(api.getSwarm());
  if (swarmNow) paintSwarm(swarmNow);
}

/** Sessions change on every recorded event, so the reload is coalesced. */
function scheduleReload(): void {
  if (!visible) return;
  // One refresh owns the timer until its asynchronous read completes. Starting a
  // newer read every 400 ms can invalidate every result on a busy/slower store.
  if (listTimer !== undefined) { listRefreshDirty = true; return; }
  listTimer = window.setTimeout(() => {
    listRefreshDirty = false;
    void loadSessions().finally(() => {
      listTimer = undefined;
      if (listRefreshDirty) scheduleReload();
    });
  }, 400);
}

async function refreshInputQueue(): Promise<void> {
  const request = ++inputQueueGeneration;
  const selection = selectionGeneration;
  const [all, pausedHelpers] = await Promise.all([run(api.listInputs()), run(api.listPausedHelpers())]);
  if (!all || selection !== selectionGeneration || request !== inputQueueGeneration) return;
  pendingComposerInputs = all;
  for (const id of dismissedInputNotices) if (!all.some(entry => entry.id === id)) dismissedInputNotices.delete(id);
  paintDeliveryControls();
  const pending = pendingNewInput;
  const delivered = pending && all.find((entry) => entry.id === pending.id && entry.state === 'sent' && entry.deliveredSessionId);
  if (delivered?.deliveredSessionId && pending && pending.generation === selectionGeneration && newChatSelected && selectedId === null &&
      !$<HTMLTextAreaElement>('chatInput').value.trim() && !(imageDrafts.get(draftKey())?.length)) {
    let summary = sessions.find((entry) => entry.id === delivered.deliveredSessionId);
    if (!summary) summary = (await run(api.getSession(delivered.deliveredSessionId, { limit: 1 })))?.summary ?? undefined;
    if (summary && pendingNewInput === pending && selection === selectionGeneration &&
        !$<HTMLTextAreaElement>('chatInput').value.trim() && !(imageDrafts.get(draftKey())?.length)) {
      pendingNewInput = null;
      mergeSessionRows([summary]);
      selectSession(summary.id);
      return;
    }
  }
  const belongsToSelection = (entry: { id: string; sessionId: string | null; deliveredSessionId?: string | null }): boolean => selectedId === null
    ? pendingNewInput?.generation === selectionGeneration && entry.id === pendingNewInput.id
    : (entry.sessionId ?? entry.deliveredSessionId) === selectedId;
  const queuedTasks = all.filter(entry => belongsToSelection(entry) && queuedFollowup(entry) && ['queued', 'tool', 'browser'].includes(entry.state));
  // The first input already durably owns every later stage. Show that authority
  // until its native receipt materializes the actual queue, without a blank gap.
  const staged = [...all, ...[...startingInputs.values()].filter(entry => !all.some(row => row.id === entry.id))]
    .filter(entry => belongsToSelection(entry) && !entry.stagesApplied && ['queued', 'browser', 'tool'].includes(entry.state));
  const projectedIds = new Set<string>();
  for (const entry of staged) for (const [index, text] of (entry.stages ?? []).entries()) {
    const id = `${entry.id}:stage:${index}`; projectedIds.add(id);
    queuedTasks.push({ ...entry, id, text, mode: 'finish', state: 'browser', stages: undefined });
  }
  const queueSession = selectedId;
  const reorder = async (from: string, to: string, after: boolean) => {
    if (!queueSession || selectedId !== queueSession) return;
    const ids = queuedTasks.filter(row => row.state === 'queued').map(row => row.id);
    if (from === to || !ids.includes(from) || !ids.includes(to)) return;
    ids.splice(ids.indexOf(from), 1);
    ids.splice(ids.indexOf(to) + Number(after), 0, from);
    const saved = await run(api.reorderQueuedInputs(queueSession, ids));
    if (saved === false) toast('The queue changed during the move. Try again.');
    void refreshInputQueue();
  };
  const taskList = $('finishQueue'); taskList.hidden = queuedTasks.length === 0;
  const oldCards = new Map([...taskList.children].map(node => [(node as HTMLElement).dataset.inputId, node as HTMLElement]));
  const dragging = !!taskList.querySelector('.is-dragging');
  reconcileChildren(taskList, queuedTasks.map(entry => {
    const existing = oldCards.get(entry.id);
    if (dragging && existing) return existing;
    if (entry.state === 'queued' && existing?.classList.contains('is-editing')) return existing;
    const card = el('div', 'queued-input'); card.dataset.inputId = entry.id;
    if (projectedIds.has(entry.id)) card.setAttribute('aria-label', 'Plan stage · waiting for the first message to be sent');
    const label = el('span', 'queue-label', entry.text); label.title = `${entry.state === 'queued' ? (entry.mode === 'after-turn' ? 'After the next completed answer' : 'At Session finish or after a completed answer') : 'Awaiting receipt'} · ${entry.text}`;
    card.append(icon('i-clock'), label);
    if (entry.state === 'queued') {
      const queueSessionSummary = sessions.find(row => row.id === selectedId);
      const modelSelection = queueSessionSummary?.selectedModel;
      if (entry.mode === 'finish' && modelSelection?.conversationId === queueSessionSummary?.conversationId && isAstraModel(modelSelection?.model, modelSelection?.reasoningEffort)) {
        const delivery = el('button', 'btn queue-delivery', entry.afterTurn === true ? 'Also after turn' : 'Finish only') as HTMLButtonElement;
        delivery.type = 'button';
        delivery.setAttribute('aria-label', 'Also send this task as a new message after Astra finishes its turn');
        delivery.setAttribute('aria-pressed', String(entry.afterTurn === true));
        delivery.title = entry.afterTurn === true ? 'At Session Finish, or as a new message after verified turn completion' : 'Only inside the Session Finish tool result; never start a new turn';
        delivery.onclick = async () => {
          delivery.disabled = true;
          await run(api.editQueuedInput(entry.id, entry.text, entry.afterTurn !== true));
          void refreshInputQueue();
        };
        card.append(delivery);
      }
      label.draggable = true;
      label.tabIndex = 0;
      label.title = 'Drag to reorder. Alt + Up/Down also moves this task.';
      label.ondragstart = event => {
        card.classList.add('is-dragging');
        event.dataTransfer?.setData('application/x-cos-queued-input', `${queueSession}:${entry.id}`);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      };
      label.ondragend = () => { card.classList.remove('is-dragging'); void refreshInputQueue(); };
      card.ondragover = event => {
        if (event.dataTransfer?.types.includes('application/x-cos-queued-input')) {
          event.preventDefault(); event.dataTransfer.dropEffect = 'move';
        }
      };
      card.ondrop = event => {
        const value = event.dataTransfer?.getData('application/x-cos-queued-input') ?? '';
        if (!queueSession || !value.startsWith(`${queueSession}:`)) return;
        event.preventDefault();
        void reorder(value.slice(queueSession.length + 1), entry.id, event.clientY > card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2);
      };
      label.onkeydown = event => {
        if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const ids = queuedTasks.filter(row => row.state === 'queued').map(row => row.id);
        const next = ids[ids.indexOf(entry.id) + (event.key === 'ArrowDown' ? 1 : -1)];
        if (next) void reorder(entry.id, next, event.key === 'ArrowDown');
      };
      const edit = dockAction('Edit queued task', 'i-pencil', () => {});
      edit.onclick = () => {
        const field = document.createElement('textarea'); field.value = entry.text; field.maxLength = 16000; field.setAttribute('aria-label', 'Queued task');
        const contents = [...card.childNodes];
        const save = el('button', 'btn', 'Save') as HTMLButtonElement; save.type = 'button';
        save.onclick = async () => {
          if (save.disabled) return;
          const value = field.value;
          save.disabled = true; save.textContent = 'Saving…'; field.readOnly = true;
          try {
            const saved = await run(api.editQueuedInput(entry.id, value));
            if (!card.isConnected || selection !== selectionGeneration) return;
            if (saved) {
              // The durable edit receipt ends editing, regardless of focus or a slower
              // queue refresh. Refreshes preserve drafts; they do not own Save completion.
              entry.text = value.trim(); label.textContent = entry.text;
              card.classList.remove('is-editing'); card.replaceChildren(...contents);
              void refreshInputQueue();
            } else if (saved === false) toast('This task is no longer queued and could not be edited.');
          } catch (error) { toast(error instanceof Error ? error.message : 'Could not save this task.'); }
          finally { save.disabled = false; save.textContent = 'Save'; field.readOnly = false; }
        };
        card.classList.add('is-editing'); card.replaceChildren(field, save); field.focus();
      };
      const cancel = dockAction('Remove queued task', 'i-trash', () => {}); cancel.onclick = async () => { await run(api.cancelInput(entry.id)); void refreshInputQueue(); };
      card.append(edit, cancel);
    }
    return card;
  }));
  // Active unbound sends still occupy the global admission limit after New Chat or
  // restart. Show that existing outbox authority, without reviving terminal drafts.
  const unbound = (entry: InputEntry) => selectedId === null && !entry.sessionId && !entry.deliveredSessionId && entry.purpose !== 'decision' && ['queued', 'browser'].includes(entry.state);
  const notice = (entry: InputEntry) => (belongsToSelection(entry) || (selectedId === null && !entry.sessionId && !entry.deliveredSessionId)) && entry.purpose !== 'decision' &&
    ['failed', 'cancelled'].includes(entry.state) && !!entry.error && !dismissedInputNotices.has(entry.id);
  const rows = all.filter((entry) => !dismissedInputNotices.has(entry.id) && !(entry.state === 'tool' && entry.historyRecorded) && !(queuedFollowup(entry) && ['queued', 'tool', 'browser'].includes(entry.state)) && (belongsToSelection(entry) || unbound(entry) || notice(entry)) &&
    (notice(entry) || unbound(entry) || selectedId !== null || (entry.projectId ?? null) === selectedProjectId) &&
    (notice(entry) || !['sent', 'cancelled'].includes(entry.state) || (entry.state === 'sent' && entry.messageId && !entry.historyRecorded)));
  for (const entry of startingInputs.values()) if (belongsToSelection(entry) && !all.some(row => row.id === entry.id)) rows.push(entry);
  $('inputQueue').replaceChildren(...rows.map((entry) => {
    const row = el('div', 'pending-message');
    row.classList.toggle('is-delivered', !entry.error && ['sent', 'tool'].includes(entry.state));
    row.classList.toggle('is-delivery-error', !!entry.error || entry.state === 'failed');
    row.dataset.inputId = entry.id;
    if (!visibleInputIds.has(entry.id)) row.classList.add('is-entering');
    visibleInputIds.add(entry.id);
    if (visibleInputIds.size > 100) visibleInputIds.delete(visibleInputIds.values().next().value!);
    const status = entry.error || (entry.state === 'failed' ? 'Delivery not confirmed' : entry.state === 'decision' ? 'Preparing follow-up' : entry.state === 'browser' ? 'Delivery confirmation pending' : entry.state === 'tool' ? 'Sent to the active turn · awaiting receipt' : entry.dueAt > Date.now() ? `Scheduled ${new Date(entry.dueAt).toLocaleString()}` : 'Queued');
    const files = el('div', 'message-attachments');
    if (entry.attachments?.length) files.append(...entry.attachments.map(file => attachmentCard(file)));
    for (const image of entry.images ?? []) { const preview = document.createElement('img'); preview.src = image.dataUrl; preview.alt = image.name; files.append(preview); }
    if (files.childElementCount) row.append(files);
    if (entry.text) {
      const text = el('div', 'pending-message-text', entry.text);
      text.setAttribute('dir', 'auto');
      row.append(text);
    }
    const receipt = el('span', 'pending-message-status');
    receipt.title = status; receipt.setAttribute('aria-label', status);
    if (entry.error || entry.state === 'failed') {
      receipt.textContent = status;
    }
    else receipt.append(icon(['sent', 'tool'].includes(entry.state) ? 'i-check' : 'i-clock'));
    receipt.hidden = !entry.error && ['sent', 'tool'].includes(entry.state) && hasLaterModelActivity(entry.deliveredAt ?? entry.offeredAt ?? entry.createdAt);
    row.append(receipt);
    if (notice(entry)) {
      row.append(dockAction('Dismiss delivery notice', 'i-x', () => dismissInputNotice(entry.id)));
      const retry = dockAction('Retry delivery', 'i-retry', () => {});
      retry.classList.add('delivery-retry');
      retry.title = 'Restore this message to the composer for review and sending';
      retry.onclick = () => {
        const input = $<HTMLTextAreaElement>('chatInput');
        if (input.value.trim() || imageDrafts.get(draftKey())?.length) { toast('Send or clear your current draft before retrying this message.'); return; }
        input.value = entry.text;
        if (entry.images?.length) imageDrafts.set(draftKey(), [...entry.images]);
        if (entry.attachments?.length) imageDrafts.set(draftKey(), [...(entry.images ?? []), ...entry.attachments]);
        rememberDraft(); paintComposerImages(); paintDeliveryControls(); input.focus();
        dismissInputNotice(entry.id);
      };
      row.append(retry);
    }
    if (['queued', 'browser'].includes(entry.state)) {
      const cancel = dockAction('Cancel delivery', 'i-x', () => {});
      cancel.onclick = async () => {
        cancel.disabled = true;
        const result = await run(api.cancelInput(entry.id));
        if (result) dismissInputNotice(entry.id);
        void refreshInputQueue();
      };
      row.append(cancel);
    }
    if (entry.state === 'queued' && entry.error?.startsWith('Message queued. Browser startup failed:')) {
      const retry = dockAction('Retry browser', 'i-retry', () => {});
      retry.classList.add('delivery-retry');
      retry.onclick = async () => { retry.setAttribute('disabled', ''); await run(api.retryInputBrowser(entry.id)); void refreshInputQueue(); };
      row.append(retry);
    }
    return row;
  }));
  $('timelineEmpty').hidden = events.length > 0 || rows.length > 0;
  for (const helper of pausedHelpers ?? []) {
    if (helper.sourceSessionId !== selectedId) continue;
    const row = el('div', 'queued-input');
    row.append(el('span', '', 'Helper delivery was not confirmed. Its old chat may still be running.'));
    const retry = el('button', 'btn', 'Start a new helper');
    retry.setAttribute('type', 'button');
    retry.onclick = async () => {
      retry.setAttribute('disabled', '');
      const accepted = await run(api.retryHelper(helper.id, helper.sourceSessionId));
      if (accepted) toast('New helper authorized for this chat');
      else toast('This helper has changed. Refreshing its status.');
      void refreshInputQueue();
    };
    row.append(retry);
    $('inputQueue').append(row);
  }
}
async function stopCurrentTurn(): Promise<void> {
  const id = selectedId, turnId = controlledTurnId, generation = selectionGeneration;
  if (!id || controlledSessionId !== id || controlledSelection !== generation || !turnId || controlledStopPending) return;
  controlledStopPending = true; paintDeliveryControls();
  try { await run(api.stopSessionTurn(id, turnId)); }
  finally { if (selectedId === id && selectionGeneration === generation) { controlledStopPending = false; void refreshSessionControls(); } }
}
let composerDiscoveryGeneration = 0;
async function sendComposer(delivery?: 'finish', plan?: string[]): Promise<boolean | void> {
  const input = $<HTMLTextAreaElement>('chatInput');
  const key = draftKey();
  const projectId = selectedId ? sessions.find(row => row.id === selectedId)?.projectId ?? null : selectedProjectId;
  const images = imageDrafts.get(key) ?? [];
  const text = plan?.[0] ?? (input.value.trim() || (images.length ? 'Please look at the attached files.' : ''));
  if ($<HTMLButtonElement>('chatSend').disabled) return;
  if (!text) {
    const target = selectedId, selection = selectionGeneration;
    const sameSelection = () => selectedId === target && selectionGeneration === selection;
    await refreshSessionControls();
    if (!sameSelection()) return;
    // An actual turn takes precedence over queued follow-ups. Stop never silently
    // becomes cancellation of a different pending input in that same chat.
    if (target && controlledSessionId === target && controlledSelection === selection && controlledTurnId) {
      await stopCurrentTurn(); return;
    }
    const pending = pendingComposerInput();
    if (pending && ['queued', 'browser'].includes(pending.state)) {
      const wasStarting = startingInputs.has(pending.id);
      if (wasStarting) cancelledStarts.add(pending.id);
      const cancelled = await run(api.cancelInput(pending.id));
      if (cancelled) {
        startingInputs.delete(pending.id);
        pendingComposerInputs = pendingComposerInputs.filter(row => row.id !== pending.id);
        dismissInputNotice(pending.id);
        paintDeliveryControls();
      } else {
        cancelledStarts.delete(pending.id);
        if (sameSelection()) { await refreshSessionControls(); if (sameSelection()) await stopCurrentTurn(); }
      }
      void refreshInputQueue();
    }
    return;
  }
  const discoveryGeneration = ++composerDiscoveryGeneration;
  const discoverySelection = selectionGeneration, discoverySession = selectedId, discoveryDraft = input.value;
  const modelSettings = confirmedComposerModel() ?? await ensureComposerModel();
  // Discovery can outlive navigation or draft edits. Only the latest unchanged
  // authored send may continue; a second click must never send the same text twice.
  if (discoveryGeneration !== composerDiscoveryGeneration || discoverySelection !== selectionGeneration || discoverySession !== selectedId ||
      input.value !== discoveryDraft || (imageDrafts.get(key) ?? []).some((image, index) => image !== images[index]) ||
      (imageDrafts.get(key)?.length ?? 0) !== images.length) return false;
  if (!modelSettings) { toast('Model discovery could not confirm your selection. Choose an available model and thinking effort, then send again.'); return false; }
  const sessionId = selectedId;
  const generation = selectionGeneration;
  const chosenMode = delivery ?? $<HTMLSelectElement>('sendMode').value;
  const mode = chosenMode === 'after-turn' && controlledSessionId === selectedId && controlledSelection === selectionGeneration && controlledQueueAtFinish ? 'finish' : chosenMode;
  const dueAt = Date.now();
  const id = crypto.randomUUID();
  const authoredDraft = input.value;
  const attachmentPayload = { images: images.filter((file): file is InputImage => 'dataUrl' in file), attachments: images.filter((file): file is InputAttachment => 'id' in file) };
  const objective = plan ? authoredDraft.trim() : mode === 'finish' ? undefined : $<HTMLTextAreaElement>('sessionObjective').value.trim() || undefined;
  startingInputs.set(id, { id, sessionId, projectId, text, ...attachmentPayload, stages: plan?.slice(1), objective, mode: mode === 'finish' ? 'finish' : mode === 'auto' ? 'auto' : 'after-turn',
    dueAt, ...modelSettings, state: 'queued', owner: null, createdAt: dueAt, conversationId: null });
  input.value = ''; input.style.height = 'auto'; inputDrafts.delete(key);
  if (sessionId === null) pendingNewInput = { id, generation };
  void refreshInputQueue();
  paintDeliveryControls();
  try {
    const result = await run(api.sendInput({ id, sessionId, projectId, text, ...attachmentPayload, stages: plan?.slice(1), objective, automation: mode === 'finish' ? undefined : $<HTMLSelectElement>('chatAutomation').value as InputAutomation, mode: mode === 'finish' ? 'finish' : mode === 'auto' ? 'auto' : 'after-turn', dueAt, ...modelSettings }));
    if (cancelledStarts.has(id)) return;
    if (!result) {
      if (selectedId === sessionId && selectionGeneration === generation && !input.value) input.value = authoredDraft;
      else if (!inputDrafts.get(key)) inputDrafts.set(key, authoredDraft);
      if (pendingNewInput?.id === id) pendingNewInput = null;
      return;
    }
    // The accepted IPC result is newer than any queue read started before it. Keep
    // that durable row visible while the next listing crosses the process boundary.
    inputQueueGeneration++;
    pendingComposerInputs = [...pendingComposerInputs.filter(row => row.id !== result.id), result];
    if (sessionId === null && selectionGeneration === generation && pendingNewInput?.id === id && result.automation &&
        $<HTMLSelectElement>('chatAutomation').value !== result.automation)
      await run(api.setInputAutomation(result.id, $<HTMLSelectElement>('chatAutomation').value as InputAutomation));
    if (selectedId === sessionId && selectionGeneration === generation && (!input.value.trim())) { input.value = ''; inputDrafts.delete(key); if (imageDrafts.get(key) === images) imageDrafts.delete(key); paintComposerImages(); }
    if (sessionId === null && selectionGeneration === generation) pendingNewInput = { id: result.id, generation };
    $('composerStatus').textContent = '';
    input.style.height = 'auto';
    void refreshInputQueue();
    return true;
  } finally { cancelledStarts.delete(id); startingInputs.delete(id); paintDeliveryControls(); void refreshInputQueue(); }
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
export function openChatView(name: string): void {
  showView(name);
}

function showView(name: string): void {
  $('composer').hidden = name === 'settings';
  $('composerDock').hidden = name === 'settings';
  $('inputQueue').hidden = name !== 'timeline';
  for (const button of $('chatView').querySelectorAll<HTMLButtonElement>('[data-view]')) {
    button.classList.toggle('is-sel', button.dataset.view === name);
  }
  for (const view of document.querySelectorAll<HTMLElement>('#chatBody > .view')) {
    view.hidden = view.dataset.view !== name;
  }
  $('chatSettingsBtn').classList.toggle('is-on', name === 'settings');
}

function selectSession(id: string): void {
  rememberDraft();
  selectionGeneration++;
  newChatSelected = false;
  selectedId = id;
  const selected = sessions.find(row => row.id === id);
  applyComposerSessionModel(`${id}:${selectionGeneration}`, selected?.selectedModel ?? null);
  const parent = selected?.origin?.kind === 'worker' ? selected.origin.fromSessionId : null;
  if (parent) expandedWorkers.add(parent);
  selectedProjectId = (parent ? sessions.find(row => row.id === parent)?.projectId : selected?.projectId) ?? null;
  if (selectedProjectId) collapsedProjects.delete(selectedProjectId);
  $<HTMLTextAreaElement>('chatInput').placeholder = 'Ask anything…';
  restoreDraft();
  detailFor = null;
  detailCursor = null;
  forgetTimelineRows();
  handoff = null;
  handoffFor = null;
  paintSessions();
  void loadDetail();
  void refreshInputQueue();
}

function selectNewChat(projectId: string | null = null): void {
  rememberDraft(); selectionGeneration++; pendingNewInput = null;
  newChatSelected = true; selectedId = null; selectedProjectId = projectId; detailFor = null; detailCursor = null;
  applyComposerSessionModel(null, null);
  inputDrafts.delete(draftKey()); imageDrafts.delete(draftKey());
  $('inputQueue').replaceChildren();
  restoreDraft(); showView('timeline'); paintSessions(); void loadDetail();
  if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    $('composer').animate?.([{ opacity: 0.45 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' });
  }
  $<HTMLTextAreaElement>('chatInput').placeholder = projectId ? `Message in ${projects.find(project => project.id === projectId)?.name ?? 'project'}…` : 'Ask anything…';
  $<HTMLTextAreaElement>('chatInput').focus();
}

export function initChat(next: Deps): void {
  deps = next;
  const agentToggle = el('button', 'btn btn-icon', '◫') as HTMLButtonElement;
  agentToggle.id = 'agentPanelToggle'; agentToggle.type = 'button'; agentToggle.hidden = true;
  agentToggle.setAttribute('aria-label', 'Toggle sub-agent side panel'); agentToggle.setAttribute('aria-expanded', 'false');
  $('themeBtn').before(agentToggle);
  const agentToolGroups = new Map<string, HTMLDetailsElement>();
  agentPanel = createAgentPanel({
    host: document.querySelector<HTMLElement>('[data-panel="chat"]')!, toggle: agentToggle,
    load: id => run(api.getSession(id, { limit: 160 })), openMain: selectSession, working: sessionWorking,
    render: (source, id, current) => {
      let boundary = '';
      const rows = boundedTimeline(source).shown.flatMap(event => {
        if (!['tool_call', 'page_tool', 'agent_message'].includes(event.kind)) boundary = `event:${event.seq}`;
        if (!['user_message', 'assistant_message', 'tool_call', 'page_tool', 'agent_message', 'chat_error'].includes(event.kind)) return [];
        const row = el('div', `ev ev-${event.kind}`); const body = el('div', 'ev-body');
        row.dataset.timelineKey = `event:${event.seq}`; row.dataset.activityBoundary = boundary;
        body.append(eventBody(event, { id, current })); row.append(body); return [row];
      });
      return groupToolRows(rows, `pane:${id}`, agentToolGroups);
    }
  });
  initChatModels(() => {
    const config = deps.state()?.config;
    if (config) paintContextMeter(sessions.find(session => session.id === selectedId) ?? null, config, confirmedComposerModel());
  });
  $('queueAtFinish').addEventListener('click', () => {
    if ($('queueAtFinish').hidden) return;
    $<HTMLSelectElement>('sendMode').value = 'after-turn';
    const input = $<HTMLTextAreaElement>('chatInput');
    if (input.value.trim() || imageDrafts.get(draftKey())?.length) void sendComposer('finish');
    else { input.focus(); paintDeliveryControls(); }
  });
  $('sendOptions').addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-delivery]');
    if (!button || $('sendOptions').hidden) return;
    $<HTMLSelectElement>('sendMode').value = button.dataset.delivery!;
    paintDeliveryControls();
  });
  $('automationSwitch').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-mode]');
    if (!button || button.disabled) return;
    const select = $<HTMLSelectElement>('chatAutomation');
    select.value = button.dataset.mode!;
    select.dispatchEvent(new Event('change'));
  });
  $('chatAutomation').addEventListener('change', async () => {
    goalIntentGeneration++;
    const select = $<HTMLSelectElement>('chatAutomation');
    cancelGoalRequest();
    if (select.value === 'off') goalDraftView = null;
    select.dataset.edited = 'true'; paintAutomationSwitch();
    const id = selectedId, generation = selectionGeneration;
    const mode = select.value as InputAutomation;
    if (!id) {
      const pending = pendingNewInput;
      if (pending?.generation === generation) await run(api.setInputAutomation(pending.id, mode));
      return;
    }
    select.disabled = true; paintAutomationSwitch();
    try { await run(api.setSessionAutomation(id, mode)); }
    finally {
      select.disabled = false;
      if (id === selectedId && generation === selectionGeneration) { delete select.dataset.edited; void refreshSessionControls(); }
      paintAutomationSwitch();
    }
  });
  $('sessionObjective').addEventListener('input', () => { cancelGoalRequest(); goalIntentGeneration++; $('sessionObjective').dataset.edited = 'true'; delete $('sessionObjective').dataset.saved; paintTaskActions(); });
  $('sessionObjectiveMode').addEventListener('change', () => { cancelGoalRequest(); goalIntentGeneration++; $('sessionObjective').dataset.edited = 'true'; delete $('sessionObjective').dataset.saved; paintTaskActions(); });
  for (const buttonId of ['saveSessionObjective'] as const) {
    $(buttonId).addEventListener('click', async () => {
      const id = selectedId;
      const objective = $<HTMLTextAreaElement>('sessionObjective');
      if (!id) {
        const draft = objective.value, mode = $<HTMLSelectElement>('sessionObjectiveMode').value as 'goal' | 'loop';
        if (!draft.trim()) return;
        const settings = confirmedComposerModel();
        if (!settings) { toast('Reload model choices and select an available model and thinking effort before sending.'); return; }
        const selection = selectionGeneration, intent = goalIntentGeneration, requestId = crypto.randomUUID();
        const projectId = selectedProjectId;
        const { model, reasoningEffort } = settings;
        const automation = $<HTMLSelectElement>('chatAutomation');
        automation.value = mode;
        automation.dataset.edited = 'true'; paintAutomationSwitch();
        goalProgress = { requestId, selection, phase: 'preparing', text: '' };
        const button = $<HTMLButtonElement>(buttonId); button.dataset.busy = 'true'; paintTaskActions(); paintGoalProgress();
        const current = () => selectedId === null && selectionGeneration === selection && goalIntentGeneration === intent && objective.value === draft && automation.value === mode;
        try {
          const result = await api.draftGoalOpening(draft.trim(), mode, requestId);
          const opening = result.ok ? result.data : null;
          if (!result.ok && current() && goalProgress?.requestId === requestId) goalProgress.error = result.error;
          if (!current()) { if (goalProgress?.requestId === requestId) { goalProgress.phase = 'paused'; paintGoalProgress(); } return; }
          if (!opening) { if (goalProgress?.requestId === requestId) { goalProgress.phase = 'failed'; goalProgress.error ||= 'Opening message generation failed'; paintGoalProgress(); } return; }
          const dueAt = Date.now(), inputId = crypto.randomUUID();
          const entry: InputEntry = { id: inputId, sessionId: null, projectId, text: opening.reply, objective: draft.trim(), automation: mode,
            mode: 'auto', dueAt, model, reasoningEffort, state: 'queued', owner: null, createdAt: dueAt, conversationId: null };
          startingInputs.set(inputId, entry); pendingNewInput = { id: inputId, generation: selection };
          goalProgress = { requestId, selection, inputId, phase: 'queued', text: '' }; paintDeliveryControls();
          try {
            const accepted = await run(api.sendInput(entry));
            if (accepted) { inputQueueGeneration++; pendingComposerInputs = [...pendingComposerInputs.filter(row => row.id !== inputId), accepted];
              // Off may arrive while sendInput is still validating/enqueuing, before
              // the outbox row exists. Reconcile that same pending intent after acceptance.
              if (selectionGeneration === selection && pendingNewInput?.id === inputId && automation.value !== mode)
                await run(api.setInputAutomation(inputId, automation.value as InputAutomation));
              if (current()) objective.dataset.saved = draft;
            } else if (goalProgress?.requestId === requestId) { goalProgress.phase = 'failed'; goalProgress.error = 'Opening message could not be queued'; }
          } finally { startingInputs.delete(inputId); paintDeliveryControls(); void refreshInputQueue(); }
        } finally { delete button.dataset.busy; paintTaskActions(); }
        return;
      }
      if (objective.dataset.sessionId !== id) return;
      const selection = selectionGeneration, draft = objective.value;
      const text = objective.value.trim();
      if (!text) return;
      const mode = $<HTMLSelectElement>('sessionObjectiveMode').value as 'goal' | 'loop';
      const button = $<HTMLButtonElement>(buttonId); button.dataset.busy = 'true'; paintTaskActions();
      const requestId = crypto.randomUUID(); goalProgress = { requestId, selection, phase: 'saving', text: '' }; paintGoalProgress();
      try {
        const saved = await run(api.setSessionObjective(id, text, mode));
        if (goalProgress?.requestId === requestId) { goalProgress.phase = saved ? 'saved' : 'failed'; if (!saved) goalProgress.error = 'Task could not be saved'; paintGoalProgress(); }
        if (saved && selectedId === id && selectionGeneration === selection && objective.value === draft &&
            $<HTMLSelectElement>('sessionObjectiveMode').value === mode) { delete objective.dataset.edited; objective.dataset.saved = objective.value; }
      } finally {
        delete button.dataset.busy; paintTaskActions();
        if (selectedId === id) void refreshSessionControls();
      }
    });
  }
  for (const [buttonId, cancel] of [['compactSession', false], ['cancelCompaction', true]] as const) {
    $(buttonId).addEventListener('click', async () => {
      const id = selectedId; if (!id) return;
      const button = $<HTMLButtonElement>(buttonId); button.disabled = true;
      try { await run(cancel ? api.cancelSessionCompaction(id) : api.compactSession(id)); }
      finally { button.disabled = false; if (selectedId === id) void refreshSessionControls(); }
    });
  }
  const appendImages = (key: string, chosen: InputAttachment[] | null | undefined): void => {
    if (!chosen?.length) return;
    const combined = [...(imageDrafts.get(key) ?? []), ...chosen];
    if (combined.length > 20 || combined.reduce((sum, file) => sum + ('size' in file ? file.size : 0), 0) > 512 * 1024 * 1024) { toast('Attach up to 20 files and 512 MB per message'); return; }
    imageDrafts.set(key, combined); if (draftKey() === key) paintComposerImages();
  };
  $('attachImages').addEventListener('click', async () => {
    const key = draftKey();
    appendImages(key, await run(api.chooseFiles()));
  });
  $('generateFinishGoal').addEventListener('click', async () => {
    const button = $<HTMLButtonElement>('generateFinishGoal'), id = selectedId, turnId = controlledTurnId;
    if (!id || !turnId || button.hidden || button.disabled || controlledSessionId !== id || controlledSelection !== selectionGeneration) return;
    const owner = `${id}:${turnId}`;
    button.dataset.busy = owner; paintDeliveryControls();
    try { await run(api.generateFinishGoal(id, turnId)); }
    finally {
      if (button.dataset.busy === owner) delete button.dataset.busy;
      if (selectedId === id) void refreshSessionControls();
      else paintDeliveryControls();
    }
  });
  $('composer').addEventListener('dragover', event => {
    if (!event.dataTransfer?.types.some(type => type === 'Files' || type === 'text/plain')) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
  });
  $('composer').addEventListener('drop', async event => {
    if (!event.dataTransfer?.types.some(type => type === 'Files' || type === 'text/plain')) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files), key = draftKey();
    if (!files.length) { const text = event.dataTransfer.getData('text/plain'); if (text) { const file = await run(api.attachText(text)); if (file) appendImages(key, [file]); } return; }
    if (files.length + (imageDrafts.get(key)?.length ?? 0) > 20) { toast('Attach up to 20 files per message'); return; }
    appendImages(key, await run(api.dropFiles(files)));
  });
  $('chatInput').addEventListener('paste', async event => {
    const files = Array.from(event.clipboardData?.files ?? []).filter(file => file.type.startsWith('image/'));
    if (!files.length) return;
    event.preventDefault();
    const key = draftKey();
    if (files.length + (imageDrafts.get(key)?.length ?? 0) > 20) { toast('Attach up to 20 files per message'); return; }
    appendImages(key, await run(api.dropFiles(files)));
  });
  api.onWriteSession?.(id => { selectSession(id); $<HTMLTextAreaElement>('chatInput').focus(); });
  $('newChat').addEventListener('click', () => {
    selectNewChat();
  });
  $('addProject').addEventListener('click', async () => {
    const button = $<HTMLButtonElement>('addProject'); button.disabled = true;
    const generation = selectionGeneration;
    try {
      const project = await run(api.addProject());
      if (!project) return;
      // The picker published a newer durable catalog. A list refresh started before it
      // may still return an empty catalog and otherwise erase this sidebar group.
      ++sessionsLoadGeneration;
      projects = [...projects.filter(row => row.id !== project.id), project];
      collapsedProjects.delete(project.id);
      if (generation === selectionGeneration) selectNewChat(project.id); else paintSessions();
    } finally { button.disabled = false; }
  });
  $('settingsSearch').addEventListener('input', () => {
    filterSettingsSections(document.querySelector<HTMLElement>('[data-view="settings"]')!, $<HTMLInputElement>('settingsSearch').value);
  });
  const composerMenus = [...document.querySelectorAll<HTMLDetailsElement>('.composer-menu, .session-controls')];
  document.addEventListener('click', (event) => {
    for (const menu of composerMenus) if (!menu.contains(event.target as Node) || ((event.target as HTMLElement).closest('button') && !(event.target as HTMLElement).closest('[data-keep-menu]'))) menu.open = false;
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') for (const menu of composerMenus) menu.open = false; });
  $('chatInput').addEventListener('input', () => {
    const hasText = !!$<HTMLTextAreaElement>('chatInput').value.trim();
    if (planRequestId || preparedPlan || (planMode && !hasText)) { cancelTaskPlan(); planMode = hasText; }
    const input = $<HTMLTextAreaElement>('chatInput'); input.style.height = 'auto'; input.style.height = `${Math.min(220, input.scrollHeight)}px`;
    paintDeliveryControls(); paintTaskActions();
  });
  $('chatInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if ($<HTMLTextAreaElement>('chatInput').value.trim() || imageDrafts.get(draftKey())?.length) $<HTMLFormElement>('composer').requestSubmit(); }
  });
  $('composerSettings').addEventListener('toggle', paintTaskActions);
  initContextMeter();
  $('createPlan').addEventListener('click', () => { if (planMode) cancelTaskPlan(); else void createTaskPlan(deps.state()?.config.ui.planBackend ?? 'chatgpt'); });
  $('composer').addEventListener('submit', (event) => { event.preventDefault(); if (preparedPlan) void sendPreparedPlan(); else if (planMode) { if (!$('createPlan').dataset.busy) void createTaskPlan(deps.state()?.config.ui.planBackend ?? 'chatgpt'); } else void sendComposer(); });

  $('sessionList').addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-id]');
    if (!row?.dataset.id || row.dataset.id === selectedId) return;
    pendingNewInput = null;
    selectSession(row.dataset.id);
  });
  $('sessionList').closest<HTMLElement>('.scroll')?.addEventListener('scroll', maybePageSessions);
  // One bounded window pages in either direction, only on deliberate navigation.
  // Layout restoration must never drain history or jump straight to the live tail.
  const historyPane = $('chatBody');
  let historyIntent: string | null = null;
  let historyDirection = 0;
  const loadAtEdge = () => {
    if (!historyIntent || historyIntent !== selectedId || historyLoading || !selectedId || detailFor !== selectedId) return;
    const older = historyDirection < 0 && historyPane.scrollTop <= 80;
    const newer = historyDirection > 0 && historyBefore !== null && historyPane.scrollHeight - historyPane.clientHeight - historyPane.scrollTop <= 80;
    if (!older && !newer) return;
    historyIntent = null;
    if (newer) {
      const from = events.reduce((cursor, event) => Math.max(cursor, event.seq + 1), 0);
      historyLoading = true;
      void loadDetail(true, false, from).finally(() => { historyLoading = false; });
      return;
    }
    const windowed = boundedTimeline(visibleEvents());
    const boundaryRows = windowed.omitted > 0 && windowed.shown.length ? windowed.shown : events;
    const before = boundaryRows.length ? Math.min(...boundaryRows.map(event => event.seq)) : 1;
    if (before <= 1) return;
    historyLoading = true;
    void navigateHistory(before, true).finally(() => { historyLoading = false; });
  };
  historyPane.addEventListener('wheel', event => { historyIntent = selectedId; historyDirection = Math.sign(event.deltaY); loadAtEdge(); }, { passive: true });
  let pointerScrollTop: number | null = null;
  historyPane.addEventListener('pointerdown', () => { pointerScrollTop = historyPane.scrollTop; });
  window.addEventListener('pointerup', () => { pointerScrollTop = null; });
  historyPane.addEventListener('keydown', event => {
    historyIntent = selectedId;
    historyDirection = ['ArrowUp', 'PageUp', 'Home'].includes(event.key) ? -1 : ['ArrowDown', 'PageDown', 'End'].includes(event.key) ? 1 : 0;
    loadAtEdge();
  });
  historyPane.addEventListener('scroll', () => {
    if (pointerScrollTop !== null) {
      historyDirection = Math.sign(historyPane.scrollTop - pointerScrollTop);
      pointerScrollTop = historyPane.scrollTop;
      historyIntent = selectedId;
    }
    loadAtEdge();
  }, { passive: true });

  $('chatView').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-view]');
    if (!button?.dataset.view) return;
    showView(button.dataset.view);
  });


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
    const outcome = await run(api.clearAgent(id, button?.dataset.runId));
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
  api.onTaskProgress(progress => {
    if (!goalProgress || progress.requestId !== goalProgress.requestId || goalProgress.selection !== selectionGeneration) return;
    Object.assign(goalProgress, progress); paintGoalProgress();
  });
  api.onSwarmChanged(paintSwarm);
}
