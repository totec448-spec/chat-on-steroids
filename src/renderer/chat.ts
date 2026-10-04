import { hasProviderDirective, resolvedCapture, withoutProviderDirectives } from '../shared/content-reference.js';
import { createWorkspaceTerminal } from './workspace-terminal.js';
import { createWorkspaceDocks } from './workspace-docks.js';
import { currentLanguage, ui, t } from './i18n.js';
import { initSkills } from './skills.js';
import { imageStorageButton } from './image-storage.js';
import { applyChatModels, applyComposerSessionModel, initChatModels, confirmedComposerModel, composerSendModel, ensureComposerModel } from './chat-models.js';
import { marked, Marked, type TokenizerAndRendererExtension } from 'marked';
import { safeExternalLink } from '../shared/external-link.js';
import { createAgentPanel } from './agent-panel.js';
import { createFilePanel } from './file-panel.js';
import { renderAgentPlan } from './agent-plan.js';
import { userPromptText } from '../shared/user-prompt.js';
import { messageReaction, withoutMessageReaction } from '../shared/message-reaction.js';
import { goalErrorMessage } from '../shared/goal-errors.js';
import type { GoalModel } from '../shared/goal-reasoning.js';
import { renderGoalReasoning } from './goal-reasoning.js';
import { preserveTimelineViewport, ROUNDING_PX } from './timeline-scroll.js';
import { createSidebarOrder, SIDEBAR_PROJECT_SCOPE } from './sidebar-order.js';
import { createSidebarCompletionState } from './sidebar-completion.js';
import { toolResultText } from './tool-result.js';
import { renderEditCards } from './tool-artifacts.js';
import { chatErrorPresentation, duplicateChatErrors } from './chat-error.js';
import { renderRecoveryCountdowns } from './recovery.js';
import type { RecoveryCountdown } from '../shared/recovery.js';
import { communicationTitle, foldAgentCommunication, participatingWorkers, workerAvatar } from './agent-communication.js';
import { initContextMeter, paintContextMeter } from './context-meter.js';
import { installComposerDockMotion, installComposerHeightMotion } from './composer-motion.js';
import { sanitizeHtmlTree } from './sanitize-html.js';
import { isAstraModel } from '../shared/chat-models.js';
import { supportsFinishAutomation } from '../shared/finish.js';
import { answerAnchors } from '../shared/markdown-export.js';
import type { InputImage, InputAttachment, InputAutomation } from '../shared/input.js';
import { injectableAttachments, queuedFollowup, MAX_INPUT_IMAGES } from '../shared/input.js';
import type { InputArgs, InputEntry } from '../main/session/input.js';
import { PROJECT_COLORS, type LocalProject, type ProjectColor } from '../shared/projects.js';
import type { TaskProgress } from '../shared/task-progress.js';
import type { RunningExecProcess } from '../shared/background-exec.js';
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
  MessageReference,
  RunningToolActivity,
  SessionChange,
  SessionEvent,
  SessionSummary,
  StoredText,
  SwarmState,
  TokenPressure
} from '../shared/session.js';
import {
  ATTRIBUTION_LABELS,
  CHAT_ACTIVE_MS,
  committedResumeAncestorsFromSummary,
  continuationMarkerOf,
  TURN_OUTCOME_LABELS,
  foldProgress,
  toolCallSummary
} from '../shared/session.js';
import { chronological, positionOf } from '../shared/chronology.js';
import { recentChatActivity, sessionWorkingAt, workerReportedFinish } from '../shared/session-activity.js';
import {
  DEFAULT_GOAL_MODEL,
  DEFAULT_GOAL_LOOP_SYSTEM_PROMPT,
  DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT,
  DEFAULT_GOAL_SYSTEM_PROMPT,
  MAX_GOAL_SYSTEM_PROMPT_CHARS
} from '../shared/goal.js';
import { DEFAULT_HANDOFF_LENGTH, DEFAULT_HANDOFF_PROMPT, HANDOFF_LENGTHS, MAX_HANDOFF_PROMPT_CHARS, type HandoffLength } from '../shared/handoff.js';
import { browserExtensionRequired, type AppState, type Config } from '../shared/types.js';
import { $, ago, clockTime, compactNumber, disclosureChevron, el, filterSettingsSections, icon, run, setIcon, toast } from './dom.js';

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
/** Page size and bounded staging capacity. A page is not a viewport: hundreds of
 * collapsed tool records can occupy less space than one authored message. */
const MAX_TIMELINE_ROWS = 160;
const TIMELINE_BATCH_SIZE = 30;
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
/** Window-local disclosure intent. Project groups start closed until the user or selection opens one. */
const expandedProjects = new Set<string>();
const projectVisibleCounts = new Map<string, number>();
function projectGroup(id: string | null | undefined): string | null {
  return id && !projects.find(project => project.id === id)?.ungrouped ? id : null;
}
/** A project color as people say it, in the interface language. */
function projectColorName(color: ProjectColor): string {
  return { blue: t('Blue'), green: t('Green'), amber: t('Amber'), purple: t('Purple'), rose: t('Rose'), teal: t('Teal') }[color];
}
let workspaceTerminal: ReturnType<typeof createWorkspaceTerminal> | null = null;
let rightWorkspaceTerminal: ReturnType<typeof createWorkspaceTerminal> | null = null;
let workspaceDocks: ReturnType<typeof createWorkspaceDocks> | null = null;

function selectedLocalProject(): LocalProject | null {
  if (selectedId) {
    const selected = sessions.find(row => row.id === selectedId);
    const inherited = selected?.origin?.kind === 'worker' && selected.origin.fromSessionId
      ? sessions.find(row => row.id === selected.origin?.fromSessionId)?.projectId : undefined;
    const id = selected?.projectId ?? inherited;
    return id ? projects.find(project => project.id === id) ?? null : null;
  }
  return newChatSelected && selectedProjectId
    ? projects.find(project => project.id === selectedProjectId && !project.ungrouped) ?? null : null;
}
const PROJECT_TASK_PAGE_SIZE = 5;
const PROJECT_TASK_PAGE_INCREMENT = 8;
let sidebarOrder: ReturnType<typeof createSidebarOrder> | undefined;
let sidebarCompletion: ReturnType<typeof createSidebarCompletionState> | undefined;
function draftKey(): string { return selectedId ?? (selectedProjectId ? `project:${selectedProjectId}` : 'new'); }
let selectionGeneration = 0;
// Async file import belongs to one visible composer draft, not just to a session key.
// Replacing that draft retires in-flight imports even when navigation returns to the
// same key or a send failure later restores the submitted text.
let composerDraftGeneration = 0;
type ComposerDraftOwner = { key: string; generation: number };
function composerDraftOwner(): ComposerDraftOwner { return { key: draftKey(), generation: composerDraftGeneration }; }
function ownsComposerDraft(owner: ComposerDraftOwner): boolean {
  return owner.key === draftKey() && owner.generation === composerDraftGeneration;
}
function replaceComposerDraft(): void { composerDraftGeneration++; skillPicker?.close(); }
let pendingNewInput: { id: string; generation: number } | null = null;
let agentPanel: ReturnType<typeof createAgentPanel> | null = null;
let filePanel: ReturnType<typeof createFilePanel> | null = null;
let reviewPanel: ReturnType<typeof createFilePanel> | null = null;
const expandedWorkers = new Set<string>();
const inputDrafts = new Map<string, string>();
const newChatTasks = new Map<string, { objective: string; automation: string; loopDelivery: string }>();
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
function authoredComposerText(): string { return skillPicker?.authoredText() ?? $<HTMLTextAreaElement>('chatInput').value; }
function rememberDraft(): void {
  inputDrafts.set(draftKey(), authoredComposerText());
  if (selectedId === null) newChatTasks.set(draftKey(), {
    objective: $<HTMLTextAreaElement>('sessionObjective').value,
    automation: $<HTMLSelectElement>('chatAutomation').value,
    loopDelivery: $<HTMLSelectElement>('loopDelivery').value
  });
}
let skillPicker: ReturnType<typeof initSkills> | undefined;
function restoreDraft(): void {
  skillPicker?.close();
  cancelGoalRequest();
  $('activeGoalRow').hidden = true; $('recoveryStatus').hidden = true;
  $<HTMLTextAreaElement>('chatInput').value = inputDrafts.get(draftKey()) ?? '';
  skillPicker?.restore();
  const task = selectedId === null ? newChatTasks.get(draftKey()) : undefined;
  const automation = $<HTMLSelectElement>('chatAutomation'); automation.value = task?.automation ?? 'off'; delete automation.dataset.edited;
  $<HTMLSelectElement>('loopDelivery').value = task?.loopDelivery ?? 'finish';
  paintLoopDeliveryTitle();
  $<HTMLTextAreaElement>('sessionObjective').value = task?.objective ?? '';
  delete $('sessionObjective').dataset.edited; delete $('sessionObjective').dataset.sessionId; delete $('sessionObjective').dataset.saved;
  paintTaskPlan(); paintComposerImages();
}
function paintComposerImages(): void {
  const key = draftKey();
  const images = imageDrafts.get(key) ?? [];
  const box = $('composerImages'); box.hidden = !images.length; box.replaceChildren();
  images.forEach((image, index) => {
    const tile = 'dataUrl' in image ? el('div', 'composer-image') : attachmentCard(image, true);
    if ('dataUrl' in image) { const preview = document.createElement('img'); preview.src = image.dataUrl; preview.alt = image.name; tile.append(preview); }
    const remove = el('button', 'image-remove', '×'); remove.setAttribute('type', 'button'); ui(remove, 'aria-label', () => t("Remove {0}", [image.name]));
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
  const glyph = el('span', 'attachment-icon'); glyph.append(icon('i-file-text'));
  const details = el('div', 'attachment-details');
  details.append(el('div', 'attachment-name', file.name), el('div', 'attachment-kind', () => file.mimeType.startsWith('image/') ? t("Image") : t("File")));
  tile.append(glyph, details); return tile;
}

let events: SessionEvent[] = [];
let totalEvents = 0;
/** The session whose `events`/cursor pair belongs together. */
let detailFor: string | null = null;
let detailCursor: number | null = null;
let historyBefore: number | null = null;
let historyLoading = false;
let historyRefreshPending = false;
let historyDemand: { sessionId: string; selection: number; direction: number; opening: boolean } | null = null;
let historyStart: number | null = null;
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
/** Exact conversations explicitly allowed while strict chat allowlisting is enabled. */
let trustedChats = new Set<string>();
/** Badges the list is currently drawn with. See repaintBadges. */
let badgeKey = '';

/** Handoff currently shown, and the id it was loaded for. */
let handoff: Handoff | null = null;
let handoffFor: string | null = null;

let listTimer: number | undefined;
let listRefreshDirty = false;
/** Transcript owners named by `session:changed` pushes that no catalog refresh has consumed yet. */
let changedTranscripts: { all: boolean; ids: Set<string> } = { all: false, ids: new Set() };
/** Summary values the selected transcript's latest live-tail read was requested against. */
let detailStamp: { updatedAt: number; events: number } | null = null;
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
  tone: '' | 'is-active' | 'is-finished' | 'is-failed' | 'is-unseen';
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
/** Keep callback arguments separate from the shared predicate's explicit clock. */
function sessionWorking(summary: SessionSummary): boolean {
  return sessionWorkingAt(summary, Date.now());
}

/**
 * Sidebar rows are intentionally rebuilt when fresh activity arrives. Anchor the spinner to a
 * wall-clock phase so a new tool repaint does not visually restart an already-running turn.
 * Keep this period aligned with `.session-status.is-active` in styles.css.
 */
const SESSION_SPIN_MS = 900;
function syncSessionSpinner(indicator: HTMLElement): void {
  indicator.style.animationDelay = `-${Date.now() % SESSION_SPIN_MS}ms`;
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
  const multiAgent = deps.state()?.config.multiAgent;
  return multiAgent?.strictChatAllowlist === true || multiAgent?.allowUnattributedCalls === false;
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
  if (!sessionWorking(summary) && sidebarCompletion?.isUnseen(summary)) badges.push({ text: 'New response', tone: 'is-unseen' });
  return badges;
}

function sessionRow(summary: SessionSummary): HTMLElement {
  const row = el('div', 'sess');
  row.dataset.id = summary.id;
  if (summary.id === selectedId) row.classList.add('is-sel');
  if (summary.id === activeId && summary.endedAt === null) row.classList.add('is-live');

  const top = el('div', 'sess-top');
  top.setAttribute('role', 'button');
  if (summary.id === selectedId) top.setAttribute('aria-current', 'true');
  top.tabIndex = 0;
  top.dataset.sessionSelect = '';
  top.dataset.sortHandle = '';
  const title = el('b', '', () => summary.title || t("Untitled session")); title.dir = 'auto';
  top.append(title);
  const badges = sessionBadges(summary);
  ui(row, 'title', () => [summary.title || t("Untitled session"), ...badges.map((badge) => t(badge.text)), ago(summary.updatedAt)].join(' · '));
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
  // Unseen is presentation only and is appended last, so every existing lifecycle tone keeps
  // its previous priority (blocked/active/worker finished/failed).
  const status = badges.find((badge) => badge.tone);
  if (status) {
    const indicator = el('span', `session-status ${status.tone}`);
    if (status.tone === 'is-active') syncSessionSpinner(indicator);
    ui(indicator, 'title', () => t(status.text));
    ui(indicator, 'aria-label', () => t(status.text));
    top.append(indicator);
  }
  const actionBar = el('div', 'sess-actions');

  const remove = document.createElement('button');
  remove.className = 'btn sess-action sess-del';
  remove.type = 'button';
  ui(remove, 'title', () => t("Remove this chat and its saved history from the app. The chat stays in ChatGPT."));
  remove.append(icon('i-trash'));
  remove.addEventListener('click', (event) => {
    event.stopPropagation();
    void deleteSession(summary.id);
  });

  const actions: HTMLButtonElement[] = [];
  if (summary.conversationId === null) {
    // Strict mode cannot trust an unattributed stream by definition. Do not render an
    // "Allow" button that the kernel will intentionally ignore; the Settings checkbox
    // explains that unattributed calls stay blocked until strict mode is turned off.
    if (deps.state()?.config.multiAgent?.strictChatAllowlist === true) {
      actionBar.append(remove);
      row.append(top, actionBar);
      return row;
    }
    // The same button in the same column as a chat's, because it is the same decision: may
    // this activity use local tools? It has no conversation to be stored against, so it moves
    // the app-wide switch — the checkbox on the settings sheet — and nothing else.
    const blocked = unattributedBlocked();
    const block = document.createElement('button');
    block.className = `btn sess-action sess-block${blocked ? ' is-blocked' : ''}`;
    block.type = 'button';
    ui(block, 'title', () => blocked
      ? t("Allow unattributed calls: self-contained calls run again even when the app cannot prove which chat sent them")
      : t("Block unattributed calls: every call the app cannot attribute to a chat is refused and the chat is told to stop"));
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
    const policyLineage = [
      summary.conversationId,
      ...committedResumeAncestorsFromSummary(summary, summary.conversationId)
    ];
    const strictAllowlist = deps.state()?.config.multiAgent?.strictChatAllowlist === true;
    // Mirror main's exact decision order for presentation: exact Block wins; in strict mode an
    // exact Trust wins before inherited lineage, then each committed predecessor is considered
    // nearest-first with Block ahead of Trust. An older policy hidden behind a nearer decision is
    // not the current effective state and must not paint this row inconsistently with the kernel.
    let effectivePolicy: 'blocked' | 'trusted' | null = blockedChats.has(summary.conversationId)
      ? 'blocked'
      : strictAllowlist && trustedChats.has(summary.conversationId)
        ? 'trusted'
        : null;
    if (strictAllowlist && effectivePolicy === null) {
      for (const conversationId of policyLineage.slice(1)) {
        if (blockedChats.has(conversationId)) { effectivePolicy = 'blocked'; break; }
        if (trustedChats.has(conversationId)) { effectivePolicy = 'trusted'; break; }
      }
    }
    // The stop this app can actually make. It does not touch the running ChatGPT turn — nothing
    // here can — it takes this chat's tools away, and a model whose every call is refused with
    // an instruction to stop finishes its turn on its own.
    // A resumed row is the only control left for its committed predecessors. Project a source
    // Block onto that row so Release can clear the exact lineage that currently fences tools.
    const blocked = effectivePolicy === 'blocked';
    const block = document.createElement('button');
    block.className = `btn sess-action sess-block${blocked ? ' is-blocked' : ''}`;
    block.type = 'button';
    ui(block, 'title', () => blocked
      ? t("Release this chat: its tool calls run again")
      : t("Block this chat: every tool call it makes is refused and it is told to stop"));
    block.append(icon(blocked ? 'i-play' : 'i-ban'));
    block.addEventListener('click', (event) => {
      event.stopPropagation();
      void toggleSessionBlock(summary.id, !blocked);
    });
    actions.push(block);

    if (strictAllowlist && summary.origin?.kind !== 'worker') {
      // `trustedChats` is the explicit durable registry. A committed resumed chat can be
      // effectively trusted by one of those historical ids, so project the same durable lineage
      // that main enforces. This only chooses the button state; IPC remains authoritative.
      const trusted = effectivePolicy === 'trusted';
      const trust = document.createElement('button');
      trust.className = `btn sess-action sess-trust${trusted ? ' is-trusted' : ''}`;
      trust.type = 'button';
      ui(trust, 'title', () => trusted
        ? t("Untrust this chat: strict mode refuses its tool calls")
        : t("Trust this chat: strict mode lets its tool calls run"));
      trust.append(icon(trusted ? 'i-lock' : 'i-check'));
      trust.addEventListener('click', (event) => {
        event.stopPropagation();
        void toggleSessionTrust(summary.id, summary.conversationId!, !trusted);
      });
      actions.push(trust);
    }

    const open = document.createElement('button');
    open.className = 'btn sess-action sess-open';
    open.type = 'button';
    ui(open, 'title', () => t("Open this chat in your browser"));
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

async function toggleSessionTrust(id: string, expectedConversationId: string, trusted: boolean): Promise<void> {
  const next = await run(api.setSessionTrusted(id, expectedConversationId, trusted));
  if (next === null) return;
  trustedChats = new Set(next);
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
  toast(t("Chat removed from the app"));
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

/**
 * Refreshes the catalog and controls. `detail: 'changed'` rereads the selected transcript only
 * when a consumed push named it (or all transcripts) or its refreshed summary proves it stale;
 * explicit refreshes keep `'reread'`. Pushes are consumed after the list arrives, so the
 * detail read that follows always starts after every write they announced.
 */
async function loadSessions(detail: 'reread' | 'changed' = 'reread'): Promise<void> {
  const generation = ++sessionsLoadGeneration;
  const [list, catalog] = await Promise.all([run(api.listSessions({ limit: SESSION_PAGE_SIZE })), run(api.listProjects())]);
  if (!list || generation !== sessionsLoadGeneration) return;
  const changed = changedTranscripts;
  changedTranscripts = { all: false, ids: new Set() };
  if (catalog) projects = catalog;
  // Once older pages have been requested, a hot refresh only replaces/updates the newest page.
  // Throwing the older rows away here would make scrolling history vanish every 400 ms while a
  // live chat is recording. Before pagination begins, replacing the first page is cheaper and
  // also removes a session that was deleted elsewhere.
  if (loadedOlderSessions) {
    // This page is authoritative for its covered range, including withdrawn openings.
    // Keep older pages, but do not merge a deleted newest row back into the sidebar.
    const oldest = list.sessions.at(-1);
    const present = new Set(list.sessions.map(row => row.id));
    sessions = sessions.filter(row => present.has(row.id) || (!!list.nextCursor && !!oldest &&
      (row.updatedAt < oldest.updatedAt || (row.updatedAt === oldest.updatedAt && row.id < oldest.id))));
    mergeSessionRows(list.sessions);
  }
  else {
    sessions = list.sessions;
    sessionPageCursor = list.nextCursor ?? null;
  }
  sessionTotal = typeof list.total === 'number' ? list.total : list.sessions.length;
  activeId = list.activeId;
  // Whole-set replacement on every page, older pages included: a block belongs to a
  // conversation, not to whichever page happened to carry its row.
  blockedChats = new Set(list.blocked);
  trustedChats = new Set(list.trusted ?? []);
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
  const row = selectedId === null ? undefined : sessions.find(entry => entry.id === selectedId);
  if (detail === 'reread' || selectedId === null || detailFor !== selectedId || changed.all || changed.ids.has(selectedId) ||
      row?.updatedAt !== detailStamp?.updatedAt || row?.events !== detailStamp?.events) await loadDetail();
  else void refreshSessionControls();
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
    trustedChats = new Set(page.trusted ?? []);
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

function projectSortEntries(): Array<{ id: string; scope: string }> {
  const ids = new Set(projects.filter(project => !project.ungrouped).map(project => project.id));
  for (const entry of sessions) {
    if (entry.origin?.kind === 'worker' || (!entry.conversationId && entry.origin?.kind !== 'desktop')) continue;
    const id = projectGroup(entry.projectId);
    if (id) ids.add(id);
  }
  return [...ids].map(id => ({ id, scope: SIDEBAR_PROJECT_SCOPE }));
}

function paintSessions(): void {
  // Keep the pointer's elected rows alive while asynchronous activity snapshots arrive.
  if (sidebarOrder?.interacting) return;
  document.getElementById('sessionTooltip')?.remove();
  const projectList = $('projectList'), chatList = $('chatList');
  // Activity replaces sidebar nodes. Keep an actively focused project control (its disclosure
  // or one of its buttons) attached to its exact project, without moving focus from the
  // composer or settings. A keyboard user tabbing to a project's buttons lost focus to the
  // page on the next repaint, and so did the color button after a pick.
  const focused = document.activeElement;
  const focusedControl = focused instanceof HTMLElement && projectList.contains(focused)
    ? ['.project-heading', '.project-color', '.project-new', '.project-remove', '.project-show-more'].find(selector => focused.matches(selector))
    : undefined;
  const focusedProject = focusedControl ? (focused as HTMLElement).closest<HTMLElement>('.project-group')?.dataset.projectId : undefined;
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
    button.append(disclosureChevron());
    ui(button, 'title', () => t("{0} sub-agents · {1} active", [workers.length, workers.filter(sessionWorking).length]));
    ui(button, 'aria-label', () => t("{0} {1} sub-agents", [expandedWorkers.has(key) ? t("Collapse") : t("Expand"), workers.length]));
    button.setAttribute('type', 'button'); button.setAttribute('aria-expanded', String(expandedWorkers.has(key)));
    button.addEventListener('click', (event) => { event.stopPropagation(); expandedWorkers.has(key) ? expandedWorkers.delete(key) : expandedWorkers.add(key); paintSessions(); });
    if (parentRow) { parentRow.append(button); parentRow.title += ` · ${button.title}`; } else target.push(button);
    if (expandedWorkers.has(key)) { const box = el('div', 'worker-group'); box.append(...workers.map(sessionRow)); target.push(box); }
  };
  const orderedSessions = sidebarOrder
    ? [...new Set(sessions.map(entry => projectGroup(entry.projectId) ?? ''))].flatMap(scope =>
      sidebarOrder!.ordered(scope, sessions.filter(entry => (projectGroup(entry.projectId) ?? '') === scope)))
    : sessions;
  for (const entry of orderedSessions) {
    if (entry.origin?.kind === 'worker') continue;
    if (!entry.conversationId && entry.origin?.kind !== 'desktop') { diagnostics.push(entry); continue; }
    const projectId = projectGroup(entry.projectId);
    const target: HTMLElement[] = projectId ? [] : rows;
    const row = sessionRow(entry); target.push(row);
    row.dataset.sortScope = projectId ?? '';
    const workers = children.get(entry.id); if (workers) group(entry.id, workers, row, target);
    if (projectId) {
      const tasks = projectRows.get(projectId) ?? [];
      tasks.push({ rows: target, selected: entry.id === selectedId || workers?.some(worker => worker.id === selectedId) === true });
      projectRows.set(projectId, tasks);
    }
  }
  const otherWorkers = children.get('other-workers') ?? [];
  if (otherWorkers.length) {
    const history = document.createElement('details'); history.className = 'session-diagnostics';
    history.open = expandedWorkers.has('other-workers');
    history.append(el('summary', '', () => t("Sub-agent history · {0}", [otherWorkers.length])));
    history.append(...otherWorkers.map(sessionRow));
    history.addEventListener('toggle', () => { if (history.isConnected) history.open ? expandedWorkers.add('other-workers') : expandedWorkers.delete('other-workers'); });
    rows.push(history);
  }
  const projectEntries = projectSortEntries();
  const orderedProjects = sidebarOrder?.ordered(SIDEBAR_PROJECT_SCOPE, projectEntries) ?? projectEntries;
  const projectSections: HTMLElement[] = [];
  for (const { id } of orderedProjects) {
    const project = projects.find(row => row.id === id);
    const section = document.createElement('details'); section.className = 'project-group'; section.dataset.projectId = id;
    if (project?.color) section.dataset.projectColor = project.color;
    section.dataset.sortId = id; section.dataset.sortScope = SIDEBAR_PROJECT_SCOPE;
    section.open = expandedProjects.has(id);
    const heading = el('summary', 'project-heading');
    heading.dataset.sortHandle = '';
    heading.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
    const label = el('span', 'project-name', () => project?.name ?? t("Unavailable project"));
    ui(heading, 'title', () => project?.path ?? t("Unavailable project"));
    heading.append(icon('i-folder'), label); section.append(heading);
    // Native `toggle` is queued after activation. A concurrent activity repaint can replace
    // this node first and lose the click. Commit the summary's pointer/keyboard click to the
    // one disclosure owner synchronously, then project it onto this details element.
    heading.addEventListener('click', event => {
      event.preventDefault();
      const open = !expandedProjects.has(id);
      if (open) expandedProjects.add(id); else expandedProjects.delete(id);
      section.open = open;
    });
    if (project) {
      const colorWrap = el('span', 'project-color-wrap');
      const color = el('button', 'btn project-color') as HTMLButtonElement;
      color.type = 'button'; color.dataset.color = project.color ?? '';
      color.setAttribute('aria-haspopup', 'menu'); color.setAttribute('aria-expanded', 'false');
      ui(color, 'title', () => t('Change project color'));
      ui(color, 'aria-label', () => t('Change project color'));
      const menu = el('span', 'project-color-menu'); menu.hidden = true; menu.setAttribute('role', 'menu');
      ui(menu, 'aria-label', () => t('Change project color'));
      const closeColorMenu = (restoreFocus = false): void => {
        menu.hidden = true; color.setAttribute('aria-expanded', 'false');
        if (restoreFocus) color.focus();
      };
      const openColorMenu = (): void => {
        menu.hidden = false; color.setAttribute('aria-expanded', 'true');
        const selected = menu.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
          menu.querySelector<HTMLButtonElement>('.project-color-choice');
        selected?.focus();
      };
      color.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation();
        if (color.disabled) return;
        if (menu.hidden) openColorMenu(); else closeColorMenu(true);
      });
      let savingColor = false;
      for (const choice of [null, ...PROJECT_COLORS] as const) {
        const option = el('button', 'project-color-choice') as HTMLButtonElement;
        option.type = 'button'; option.dataset.projectColorChoice = choice ?? ''; option.dataset.color = choice ?? '';
        option.setAttribute('role', 'menuitemradio');
        option.setAttribute('aria-checked', String((project.color ?? null) === choice));
        // The menu is named "Change project color"; each choice says the color itself.
        const label = (): string => choice ? projectColorName(choice) : t('None');
        ui(option, 'aria-label', label); ui(option, 'title', label);
        if (!choice) option.textContent = t('None');
        option.addEventListener('click', async event => {
          event.preventDefault(); event.stopPropagation();
          if (savingColor) return;
          if ((project.color ?? null) === choice) return closeColorMenu(true);
          savingColor = true;
          const selectionAtSave = selectedId;
          const generationAtSave = selectionGeneration;
          let restoreColorFocus = colorWrap.contains(document.activeElement);
          // Disabling a focused choice can move focus to body. A later deliberate focus
          // change belongs to the user, not to the pending save's repaint.
          const noticeFocus = (event: FocusEvent): void => {
            if (event.target !== document.body && !colorWrap.contains(event.target as Node)) restoreColorFocus = false;
          };
          document.addEventListener('focusin', noticeFocus);
          color.disabled = true;
          menu.querySelectorAll<HTMLButtonElement>('.project-color-choice').forEach(button => { button.disabled = true; });
          let updated: LocalProject | null | undefined;
          try { updated = await run(api.setProjectColor(id, choice as ProjectColor | null)); }
          finally { document.removeEventListener('focusin', noticeFocus); }
          // In an inactive document, activeElement can change without a focusin notification.
          // Check its current owner as well before replacing the palette or restoring focus.
          restoreColorFocus = restoreColorFocus &&
            (document.activeElement === document.body || colorWrap.contains(document.activeElement));
          if (!updated) {
            savingColor = false; color.disabled = false;
            menu.querySelectorAll<HTMLButtonElement>('.project-color-choice').forEach(button => { button.disabled = false; });
            if (restoreColorFocus && visible && selectedId === selectionAtSave && selectionGeneration === generationAtSave) openColorMenu();
            return;
          }
          ++sessionsLoadGeneration;
          projects = projects.map(row => row.id === id ? updated : row);
          paintSessions();
          if (restoreColorFocus && visible && selectedId === selectionAtSave && selectionGeneration === generationAtSave) {
            $('projectList').querySelector<HTMLElement>(`.project-group[data-project-id="${id}"] .project-color`)?.focus({ preventScroll: true });
          }
        });
        menu.append(option);
      }
      menu.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); return closeColorMenu(true); }
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        const options = [...menu.querySelectorAll<HTMLButtonElement>('.project-color-choice:not(:disabled)')];
        if (!options.length) return;
        const current = options.indexOf(document.activeElement as HTMLButtonElement);
        const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
        event.preventDefault(); event.stopPropagation();
        options[(Math.max(0, current) + delta + options.length) % options.length]?.focus();
      });
      colorWrap.addEventListener('focusout', () => queueMicrotask(() => {
        if (!colorWrap.contains(document.activeElement)) closeColorMenu();
      }));
      colorWrap.append(color, menu); heading.append(colorWrap);
      const create = el('button', 'btn project-new'); create.append(icon('i-pencil')); create.setAttribute('type', 'button'); create.dataset.newProject = id;
      ui(create, 'title', () => t("New chat in this project")); ui(create, 'aria-label', () => t("New chat in this project"));
      create.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); selectNewChat(id); }); heading.append(create);
      const remove = el('button', 'btn project-remove') as HTMLButtonElement;
      remove.type = 'button'; remove.append(icon('i-trash'));
      ui(remove, 'title', () => t("Remove project from sidebar; keep conversations and files"));
      ui(remove, 'aria-label', () => t("Remove project {0}", [project.name]));
      remove.addEventListener('click', async event => {
        event.preventDefault(); event.stopPropagation();
        if (remove.disabled) return;
        remove.disabled = true;
        try {
          const removed = await run(api.removeProject(id));
          if (!removed) return;
          // Reject list snapshots captured before this newer catalog commit.
          ++sessionsLoadGeneration;
          projects = projects.map(row => row.id === id ? removed : row);
          expandedProjects.delete(id); projectVisibleCounts.delete(id);
          if (selectedProjectId === id) {
            if (!selectedId) {
              const oldKey = draftKey();
              const authoredDraft = authoredComposerText();
              selectedProjectId = null; selectionGeneration++; replaceComposerDraft();
              // Keep the visible draft and its attachments while moving to unfiled.
              inputDrafts.set(draftKey(), authoredDraft); inputDrafts.delete(oldKey); newChatTasks.delete(oldKey);
              skillPicker?.restore();
              const images = imageDrafts.get(oldKey);
              if (images) imageDrafts.set(draftKey(), images);
              else imageDrafts.delete(draftKey());
              imageDrafts.delete(oldKey);
              ui($<HTMLTextAreaElement>('chatInput'), 'placeholder', () => t('Ask anything…'));
            } else selectedProjectId = null;
          }
          paintSessions(); void refreshInputQueue();
          toast(t('Project removed; conversations kept'));
        } finally { remove.disabled = false; }
      });
      heading.append(remove);
    }
    const tasks = projectRows.get(id) ?? [];
    const count = projectVisibleCounts.get(id) ?? PROJECT_TASK_PAGE_SIZE;
    const shown = tasks.filter((task, index) => index < count || task.selected);
    section.append(...shown.flatMap(task => task.rows));
    if (shown.length < tasks.length) {
      const more = el('button', 'btn project-show-more', () => t("Show more")) as HTMLButtonElement;
      more.type = 'button'; ui(more, 'aria-label', () => t("Show more tasks in {0}", [project?.name ?? t("this project")]));
      more.addEventListener('click', () => { projectVisibleCounts.set(id, count + PROJECT_TASK_PAGE_INCREMENT); paintSessions(); });
      section.append(more);
    }
    projectSections.push(section);
  }
  if (diagnostics.length) {
    const disclosure = document.createElement('details');
    disclosure.className = 'session-diagnostics';
    disclosure.open = diagnosticsExpanded;
    disclosure.append(el('summary', '', () => t("Unattributed activity · {0}", [diagnostics.length])));
    disclosure.append(...diagnostics.map(sessionRow));
    disclosure.addEventListener('toggle', () => { diagnosticsExpanded = disclosure.open; });
    rows.push(disclosure);
  }
  // Both scopes keep the existing sessionList drag/order owner and durable project binding.
  projectList.replaceChildren(...projectSections);
  chatList.replaceChildren(...rows);
  if (focusedProject && focusedControl) projectSections.find(section => section.dataset.projectId === focusedProject)
    ?.querySelector<HTMLElement>(focusedControl)?.focus({ preventScroll: true });
  const workers = sessions.filter(entry => entry.origin?.kind === 'worker' && entry.origin.fromSessionId === selectedId && selectedId !== null);
  agentPanel?.update(selectedId, workers);
  filePanel?.update(selectedLocalProject());
  reviewPanel?.update(selectedLocalProject());
  workspaceDocks?.sync();
  workspaceTerminal?.update(selectedLocalProject());
  rightWorkspaceTerminal?.update(selectedLocalProject());
  badgeKey = badgeSignature();
  $('projectsEmpty').hidden = projectSections.length > 0;
  $('sessionsEmpty').hidden = rows.length > 0;

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
  if (event.kind === 'tool_call') return `tool_call\u0000${event.call.callId}`;
  if (event.kind === 'native_image') return `native_image\u0000${event.messageId}\u0000${event.providerAssetId}`;
  if ((event.kind === 'user_message' || event.kind === 'assistant_message') && event.messageId) {
    return `${event.kind}\u0000${event.messageId}`;
  }
  return null;
}

/** Merge one sequence-cursor delta without letting canonical message revisions duplicate rows. */
function mergeDetailDelta(delta: SessionEvent[]): void {
  if (delta.length === 0) return;
  const merged = [...events];
  const floor = events.length ? Math.min(...events.map(positionOf)) : 0;
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
      // An old canonical revision is not newly authored history. Its original
      // page still owns it; admitting it here would evict an unrelated live row.
      if (positionOf(event) < floor) continue;
      if (key) messageRows.set(key, merged.length);
      merged.push(event);
    }
  }
  const folded = chronological(foldProgress(merged));
  events = retainTimelinePage(folded, 'newer');
}

let controlsGeneration = 0;
let controlledSessionId: string | null = null;
let controlledTurnId: string | null = null;
let controlledSelection = -1;
let controlledStopPending = false;
let controlledFinishWaiting = false;
let controlledQueueAtFinish = false;
let controlledCanInject = false;
let controlledCanSendDirectly = false;
let controlledRecovery: RecoveryCountdown[] = [];
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
let goalWaitView: import('../shared/goal.js').GoalWait | null = null;
let finishGoalDraftView: GoalDraftPresentation | null = null;
function localizedGoalError(error: string): string {
  const message = goalErrorMessage(error);
  const delivery = /^The helper prompt could not be delivered\. (.+)$/.exec(message);
  if (delivery) return t('The helper prompt could not be delivered. {0}', [delivery[1]!]);
  const http = /^The continuation provider rejected the request \(HTTP (\d{3})\)\. Check its status and the configured model or endpoint\.$/.exec(message);
  if (http) return t('The continuation provider rejected the request (HTTP {0}). Check its status and the configured model or endpoint.', [http[1]!]);
  const code = /^The continuation could not proceed\. Check the app diagnostics for details \(([^)]+)\)\.$/.exec(message);
  if (code) return t('The continuation could not proceed. Check the app diagnostics for details ({0}).', [code[1]!]);
  return t(message);
}
function paintGoalProgress(): void {
  let row = document.getElementById('goalLifecycle');
  if (!row) { row = el('div', 'queued-input'); row.id = 'goalLifecycle'; row.setAttribute('role', 'status'); $('activeGoalRow').before(row); }
  const progress = goalProgress?.selection === selectionGeneration ? goalProgress : null;
  const entry = progress?.inputId ? pendingComposerInputs.find(item => item.id === progress.inputId) : undefined;
  const finishDraft = controlledSessionId === selectedId && controlledSelection === selectionGeneration ? finishGoalDraftView : null;
  const draft = finishDraft ?? (controlledSessionId === selectedId && controlledSelection === selectionGeneration ? goalDraftView : null);
  const wait = controlledSessionId === selectedId && controlledSelection === selectionGeneration ? goalWaitView : null;
  const off = $<HTMLSelectElement>('chatAutomation').value === 'off';
  if (off && !finishDraft) { row.hidden = true; row.replaceChildren(); row.setAttribute('aria-busy', 'false'); return; }
  let phase = progress?.phase ?? '';
  let text = progress?.text ?? '', error = progress?.error;
  if (entry) { phase = entry.state; error = entry.error ?? undefined; }
  if (draft && (!off || finishDraft) && (finishDraft || !['saving', 'failed'].includes(phase))) { phase = draft.stage; text = draft.text; error = draft.error ?? undefined; }
  else if (wait && !['saving', 'failed'].includes(phase)) { phase = 'settling'; text = ''; error = undefined; }
  const labels: Record<string, string> = { saving: t("Saving task…"), saved: t("Task saved · waiting for the next completed answer"),
    preparing: t("Preparing the opening message…"), generating: t("Generating the opening message…"), ready: t("Message ready · awaiting ChatGPT delivery"),
    sending: t("Preparing a continuation…"), answering: t("Generating a continuation…"), queued: t("Opening message queued"),
    browser: t("Sending opening message to ChatGPT…"), sent: t("Opening message sent"), tool: t('Opening message delivered to the active turn'),
    failed: t("Task could not continue"), cancelled: t("Opening message cancelled"), paused: t("Automation paused · task text preserved"), 'no-reply': t("Goal reached") };
  if (phase === 'retrying') { text = ''; error = undefined; }
  labels.retrying = t("Provider busy · retry {0}{1}", [progress?.attempt ?? '', progress?.retryAt ? t(' at {0}', [new Date(progress.retryAt).toLocaleTimeString(currentLanguage())]) : '']);
  const mode = $<HTMLSelectElement>('chatAutomation').value === 'loop' ? t('Loop') : t('Goal');
  labels.settling = `${mode} · ${wait?.reason === 'native-busy' ? t('ChatGPT resumed work · waiting before retry') : wait?.reason === 'silence' ? t('Waiting before recovery reload') : wait?.reason === 'quiet' ? t('Waiting for tool inactivity') :
    wait?.reason === 'workers' ? t('Waiting for this chat’s sub-agents') : wait?.reason === 'tools' ? t('Waiting for running tools') : wait?.reason === 'listening' ? t('Waiting for activity after recovery') : t('Answer settling')}`;
  // The dock already describes this same silence/listening deadline. Keep the
  // Loop/Goal task controls, but do not present its shared wait as another action.
  const sharedRecoveryWait = phase === 'settling' && wait?.until !== undefined &&
    ['silence', 'listening', 'native-busy', 'quiet'].includes(wait.reason) && controlledRecovery.some(countdown =>
      ['silence', 'post-reload', 'native-busy', 'thinking-failed'].includes(countdown.kind) &&
      countdown.deadline === wait.until && (countdown.visibleAt ?? 0) <= Date.now());
  // "Goal reached" is said by the Goal row itself; a second row would only repeat it.
  row.hidden = !phase || sharedRecoveryWait || (phase === 'no-reply' && !error && goalReachedShown());
  if (row.hidden) { row.replaceChildren(); row.setAttribute('aria-busy', 'false'); return; }
  const busy = ['settling', 'saving', 'preparing', 'generating', 'retrying', 'sending', 'answering', 'browser', 'queued', 'ready'].includes(phase) && !error;
  row.setAttribute('aria-busy', String(busy));
  const marker = el('span', busy ? 'session-status is-working' : 'session-status');
  const body = el('div', 'queue-label'); body.append(el('span', '', error ? `${labels.failed}: ${localizedGoalError(error)}` : labels[phase] ?? phase));
  if (text && ['generating', 'answering', 'preparing'].includes(phase)) { const preview = el('pre', 'goal-live-preview', text.slice(-8000)); body.append(preview); }
  row.replaceChildren(marker, body);
  if (phase === 'settling' && wait?.until) {
    const seconds = Math.max(0, Math.ceil((wait.until - Date.now()) / 1000));
    const timer = el('span', 'recovery-countdown', seconds ? t('Check in {0}', [`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`]) : t('Checking for activity…'));
    timer.setAttribute('role', 'timer'); timer.setAttribute('aria-live', 'off'); row.append(timer);
  }
}
const cancelledStarts = new Set<string>();
function pendingComposerInput(): InputEntry | undefined {
  return [...startingInputs.values(), ...pendingComposerInputs].find(entry => (!queuedFollowup(entry) || entry.state === 'browser') && ['queued', 'browser'].includes(entry.state) &&
    (selectedId ? (entry.sessionId ?? entry.deliveredSessionId) === selectedId :
      pendingNewInput?.generation === selectionGeneration && pendingNewInput.id === entry.id));
}
let durationTimer: number | undefined;
function paintDeliveryControls(): void {
  paintGoalProgress();
  const working = selectedId !== null && controlledSessionId === selectedId && controlledSelection === selectionGeneration && controlledTurnId !== null;
  const queueAtFinish = selectedId !== null && controlledSessionId === selectedId && controlledSelection === selectionGeneration && controlledQueueAtFinish;
  const canInject = selectedId !== null && controlledSessionId === selectedId && controlledSelection === selectionGeneration && controlledCanInject;
  const canSendDirectly = selectedId !== null && controlledSessionId === selectedId && controlledSelection === selectionGeneration && controlledCanSendDirectly;
  const files = imageDrafts.get(draftKey()) ?? [];
  const nativeFiles = files.some(file => 'id' in file) && !(canInject && injectableAttachments(files));
  $('queueAtFinish').hidden = !queueAtFinish || nativeFiles;
  ui($('afterTurnLabel'), 'textContent', () => queueAtFinish && !nativeFiles ? t("Queue at Session finish") : t("After this turn"));
  const generate = $<HTMLButtonElement>('generateFinishGoal');
  const queued = [...startingInputs.values(), ...pendingComposerInputs].some(entry =>
    (entry.sessionId ?? entry.deliveredSessionId) === selectedId && ['queued', 'browser', 'tool'].includes(entry.state));
  generate.hidden = !working || !controlledFinishWaiting || queued || controlledStopPending || !!finishGoalDraftView;
  generate.disabled = generate.dataset.busy === `${selectedId}:${controlledTurnId}`;
  const sendOption = $<HTMLSelectElement>('sendMode').querySelector('option[value="auto"]');
  const immediateLabel = () => nativeFiles && working ? t("After this turn") : canSendDirectly ? t("Send directly") : canInject ? t("Inject now") : t("Send");
  if (sendOption) ui(sendOption, 'textContent', immediateLabel);
  ui($('immediateDeliveryLabel'), 'textContent', immediateLabel);
  const immediateAction = $('sendOptions').querySelector<HTMLElement>('[data-delivery="auto"]');
  if (immediateAction) immediateAction.hidden = (nativeFiles && working) || canInject;
  const injectionAction = $('sendOptions').querySelector<HTMLElement>('[data-delivery="tool"]');
  const explicitInjection = (canInject || canSendDirectly) && (!files.length || injectableAttachments(files));
  if (injectionAction) injectionAction.hidden = !explicitInjection;
  if ($<HTMLSelectElement>('sendMode').value === 'tool' && !explicitInjection) $<HTMLSelectElement>('sendMode').value = 'auto';
  if (canInject && explicitInjection && $<HTMLSelectElement>('sendMode').value === 'auto') $<HTMLSelectElement>('sendMode').value = 'tool';
  if (!canInject && !canSendDirectly && !queueAtFinish) $<HTMLSelectElement>('sendMode').value = 'auto';
  const pending = pendingComposerInput();
  const stop = (working || !!pending) && !currentPreparedPlan() && !authoredComposerText().trim() && !(imageDrafts.get(draftKey())?.length);
  // Hover selects delivery for the next message. Clicking the empty-composer
  // Stop still acts immediately; there is no second Stop action in the menu.
  $('sendOptions').hidden = !canInject && !canSendDirectly && !queueAtFinish;
  const send = $<HTMLButtonElement>('chatSend');
  const planMode = taskPlans.has(draftKey()), preparedPlan = currentPreparedPlan();
  send.disabled = !!preparedPlan && (preparedPlan.sending || preparedPlan.stages.some(stage => !stage.trim()));
  send.dataset.action = stop ? 'stop' : 'send';
  ui(send, 'aria-label', () => stop ? (controlledStopPending ? t("Stop requested") : t("Stop turn")) : t("Send message"));
  if (stop && !working && pending) ui(send, 'aria-label', () => t("Cancel delivery"));
  const planAction = selectedId ? t("Queue plan at Session finish") : t("Start full plan");
  if (preparedPlan && !stop) send.setAttribute('aria-label', planAction);
  else if (planMode && !stop) ui(send, 'aria-label', () => t("Generate plan"));
  send.classList.toggle('is-plan-ready', !!preparedPlan && !stop);
  ui(send, 'title', () => stop && !working && pending ? t("Cancel delivery") : preparedPlan && !stop ? planAction : planMode && !stop ? t("Click to generate plan") : '');
  send.classList.toggle('is-stop', stop);
  for (const button of $('sendOptions').querySelectorAll<HTMLElement>('[data-delivery]')) {
    button.setAttribute('aria-checked', String(button.dataset.delivery === (nativeFiles && working && $<HTMLSelectElement>('sendMode').value !== 'tool' ? 'after-turn' : $<HTMLSelectElement>('sendMode').value)));
  }
}
function dockAction(label: string | (() => string), symbol: string, click: (event: MouseEvent) => void): HTMLButtonElement {
  const button = el('button', 'dock-action') as HTMLButtonElement;
  const description = typeof label === 'function' ? label : () => label;
  button.type = 'button'; ui(button, 'title', description); ui(button, 'aria-label', description);
  button.append(icon(symbol)); button.onclick = click; return button;
}
/** Whether the selected chat's last Goal decision, still current, was "the goal is met". */
function goalReachedShown(): boolean {
  return controlledSessionId === selectedId && controlledSelection === selectionGeneration && goalDraftView?.stage === 'no-reply' &&
    !finishGoalDraftView;
}
function paintActiveGoal(): void {
  const row = $('activeGoalRow');
  const mode = $<HTMLSelectElement>('chatAutomation').value;
  row.hidden = mode === 'off';
  if (row.hidden) { row.replaceChildren(); return; }
  const objective = $<HTMLTextAreaElement>('sessionObjective').value.trim();
  // A run whose helper decided the goal is met has ended; the objective stays for a later message.
  const reached = mode === 'goal' && goalReachedShown();
  const label = el('span', 'queue-label', () => `${mode === 'loop' ? t("Loop") : reached ? t("Goal reached") : t("Pursuing goal")}${objective ? ' · ' + objective : ''}`);
  label.title = objective;
  row.replaceChildren(icon(reached ? 'i-check' : 'i-pulse'), label,
    dockAction(() => t("Pause automation"), 'i-power', () => { const select = $<HTMLSelectElement>('chatAutomation'); select.value = 'off'; select.dispatchEvent(new Event('change')); }),
    dockAction(() => t("Edit task"), 'i-pencil', event => {
      // This opener is outside the menu; its click must not immediately dismiss it.
      event.stopPropagation();
      openObjectiveEditor();
    }));
}
// A mode-menu pencil edits that mode's objective without switching automation;
// Save applies the objective and turns the mode on through the existing path.
let objectiveEditMode: 'goal' | 'loop' | null = null;
// Saving hands progress and failures to the dock's lifecycle row; the editor closes.
function closeObjectiveEditor(): void {
  $<HTMLDetailsElement>('composerSettings').open = false;
  $('composerSettings').querySelector<HTMLElement>('summary')!.focus();
}
function openObjectiveEditor(mode: 'goal' | 'loop' | null = null): void {
  const current = $<HTMLSelectElement>('chatAutomation').value;
  const next = mode && mode !== current ? mode : null;
  if (next && next !== $<HTMLSelectElement>('sessionObjectiveMode').value) {
    cancelGoalRequest(); goalIntentGeneration++;
    $('sessionObjective').dataset.edited = 'true'; delete $('sessionObjective').dataset.saved;
  }
  objectiveEditMode = next; paintAutomationSwitch();
  $('composerSettings').classList.remove('mode-picker');
  $<HTMLDetailsElement>('composerSettings').open = true;
  $<HTMLTextAreaElement>('sessionObjective').focus();
}
type TaskPlanDraft = { text: string; requestId: string | null; stages: string[] | null; sending: boolean; progress: TaskProgress | null; error: string | null };
// Planning belongs to its draft key. Completed stages own their captured objective
// independently of composer edits; existing sessions hand them to the durable queue.
const taskPlans = new Map<string, TaskPlanDraft>();
function currentPreparedPlan(): (TaskPlanDraft & { stages: string[] }) | null {
  const plan = taskPlans.get(draftKey());
  return plan?.stages ? plan as TaskPlanDraft & { stages: string[] } : null;
}
function cancelTaskPlan(key = draftKey()): void {
  const plan = taskPlans.get(key);
  taskPlans.delete(key);
  if (plan?.requestId) void api.cancelTaskRequest?.(plan.requestId);
  if (draftKey() === key) paintTaskPlan();
}
function paintTaskPlan(): void {
  const plan = taskPlans.get(draftKey());
  const preview = $('taskPlanPreview'); preview.replaceChildren();
  preview.hidden = !plan || (!plan.requestId && !plan.stages && !plan.error);
  ui($<HTMLTextAreaElement>('chatInput'), 'placeholder', () => plan && !plan.text ? t("Describe the task to turn into a plan…") : t("Ask anything…"));
  if (plan?.stages) paintPreparedPlan();
  else if (plan?.error) {
    const failure = plan.error;
    const error = el('div', 'muted', () => failure === 'invalid_goal_decision_json' ? t("The planner response could not be read.") : localizedGoalError(failure));
    error.title = plan.error;
    preview.append(error, el('div', 'muted', () => t("Send again to retry, or cancel the plan.")));
  } else if (plan?.requestId) {
    const progress = plan.progress;
    const label = () => !progress ? t("Creating plan…") : progress.phase === 'retrying' ? t("Provider busy · retry {0}{1}", [progress.attempt ?? '', progress.retryAt ? t(' at {0}', [new Date(progress.retryAt).toLocaleTimeString(currentLanguage())]) : '']) : progress.phase === 'cancelled' ? t("Plan cancelled") : progress.phase === 'preparing' ? t("Preparing plan…") : progress.phase === 'ready' ? t("Plan ready") : progress.phase === 'failed' ? t("Plan failed") : t("Writing plan…");
    preview.append(el('span', 'muted', label));
    if (progress?.text || progress?.error) preview.append(el('pre', 'task-progress-text', progress.error ? () => localizedGoalError(progress.error!) : progress.text));
  }
  paintTaskActions(); paintDeliveryControls();
}
async function createTaskPlan(backend: 'api' | 'chatgpt'): Promise<void> {
  const input = $<HTMLTextAreaElement>('chatInput'), text = authoredComposerText().trim();
  const key = draftKey();
  cancelTaskPlan(key);
  const sessionId = selectedId, projectId = selectedId ? sessions.find(row => row.id === selectedId)?.projectId ?? null : selectedProjectId;
  const requestId = text ? crypto.randomUUID() : null;
  const plan: TaskPlanDraft = { text, requestId, stages: null, sending: false, progress: null, error: null };
  taskPlans.set(key, plan); paintTaskPlan();
  if (!requestId) { input.focus(); return; }
  const current = () => taskPlans.get(key) === plan;
  const unsubscribe = api.onTaskProgress?.(progress => {
    if (progress.requestId !== requestId || !current()) return;
    plan.progress = progress;
    if (draftKey() === key) paintTaskPlan();
  });
  try {
    const result = await api.draftTaskPlan(text, backend, requestId);
    if (!current()) return;
    const draft = draftKey() === key ? authoredComposerText() : inputDrafts.get(key) ?? '';
    if (draft.trim() !== text) { cancelTaskPlan(key); return; }
    if (result.ok) {
      plan.stages = result.data;
      plan.requestId = null;
      // The accepted result now owns the captured request. Retire only its
      // unchanged source draft, before queue admission can yield to new typing.
      inputDrafts.delete(key);
      if (draftKey() === key) { replaceComposerDraft(); input.value = ''; skillPicker?.restore(); }
      if (sessionId) await queuePreparedPlan(key, plan as TaskPlanDraft & { stages: string[] }, sessionId, projectId);
    }
    else plan.error = result.error;
  } catch (error) {
    if (current()) plan.error = error instanceof Error ? error.message : String(error);
  } finally {
    unsubscribe?.(); plan.requestId = null;
    if (current() && draftKey() === key) paintTaskPlan();
  }
}
function paintPreparedPlan(): void {
  const plan = currentPreparedPlan();
  if (!plan) return;
  const preview = $('taskPlanPreview'); preview.hidden = plan.sending;
  // Sending hands presentation to the outbox/queued-stage rows. Keeping the editable
  // draft visible until the async receipt arrives paints the same plan twice. Retain
  // its data so a rejected send can restore the editable preview in the existing finally.
  if (plan.sending) { preview.replaceChildren(); return; }
  preview.replaceChildren(...plan.stages.map((stage, index) => {
    const row = el('div', 'plan-stage');
    const heading = el('div', 'plan-stage-heading');
    const label = el('span', 'stage-number', String(index + 1)); ui(label, 'aria-label', () => t("Stage {0}", [index + 1]));
    const text = el('span', 'queue-label', stage); text.title = stage; text.dir = 'auto';
    const field = document.createElement('textarea'); field.dir = 'auto'; field.value = stage; field.maxLength = 16000; field.hidden = true;
    ui(field, 'aria-label', () => t("Edit stage {0}", [index + 1]));
    const error = el('span', 'stage-error', () => t("Enter text or delete this stage.")); error.id = `planStageError-${index}`; error.hidden = !!stage.trim();
    const validate = () => { error.hidden = !!field.value.trim(); field.setAttribute('aria-invalid', String(!error.hidden)); paintDeliveryControls(); };
    field.setAttribute('aria-describedby', error.id); field.setAttribute('aria-invalid', String(!error.hidden));
    field.oninput = () => { plan.stages[index] = field.value; text.textContent = field.value; text.title = field.value; validate(); };
    const edit = dockAction(() => t("Edit stage {0}", [index + 1]), 'i-pencil', () => {
      field.hidden = !field.hidden; edit.setAttribute('aria-expanded', String(!field.hidden)); if (!field.hidden) field.focus();
    });
    edit.setAttribute('aria-expanded', 'false');
    const remove = dockAction(() => t("Delete stage {0}", [index + 1]), 'i-trash', () => {
      if (plan.sending) return;
      plan.stages.splice(index, 1);
      if (plan.stages.length) { paintPreparedPlan(); paintDeliveryControls(); } else cancelTaskPlan();
    });
    edit.disabled = remove.disabled = field.disabled = plan.sending;
    ui(heading, 'title', () => selectedId ? t("Queued at Session finish; edit or delete this checkpoint independently.") : index === 0 ? t("Send includes your complete request and the full plan. Later stages are queued as verification checkpoints.") : t("Included in the first message, then queued as a checkpoint at Session finish or after a completed answer when enabled."));
    heading.append(label, text, edit, remove); row.append(heading, field, error); return row;
  }));
}
async function sendPreparedPlan(): Promise<void> {
  const key = draftKey(), plan = currentPreparedPlan();
  if (!plan || plan.sending) return;
  if (selectedId) {
    await queuePreparedPlan(key, plan, selectedId, sessions.find(row => row.id === selectedId)?.projectId ?? null);
    return;
  }
  const tasks = plan.stages.map(stage => stage.trim());
  if (!tasks.length || tasks.some(task => !task) || JSON.stringify(tasks).length > 12000) { toast(t("Keep every stage nonempty and the plan below 12,000 characters.")); return; }
  plan.sending = true; paintPreparedPlan();
  try {
    const sent = await sendComposer(undefined, tasks, plan.text);
    if (taskPlans.get(key) === plan && sent) { await refreshInputQueue(); if (taskPlans.get(key) === plan) cancelTaskPlan(key); }
  } finally {
    if (taskPlans.get(key) === plan) { plan.sending = false; if (draftKey() === key) paintTaskPlan(); }
  }
}
async function queuePreparedPlan(key: string, plan: TaskPlanDraft & { stages: string[] }, sessionId: string, projectId: string | null): Promise<void> {
  if (plan.sending) return;
  const stages = plan.stages.map(stage => stage.trim());
  if (!stages.length || stages.some(stage => !stage) || JSON.stringify(stages).length > 12000) {
    toast(t("Keep every stage nonempty and the plan below 12,000 characters.")); return;
  }
  plan.sending = true;
  if (draftKey() === key) paintTaskPlan();
  try {
    const result = await run(api.sendInput({ id: crypto.randomUUID(), sessionId, projectId,
      text: stages[0]!, objective: plan.text, authoredSource: 'objective', stages: stages.slice(1), mode: 'finish', dueAt: Date.now(), model: null, reasoningEffort: null }));
    if (result) {
      // The result already retired its source prompt. Admission leaves any newer
      // composer draft and attachments alone; the durable queue owns the stages.
      if (taskPlans.get(key) === plan) cancelTaskPlan(key);
      await refreshInputQueue();
    }
  } finally {
    plan.sending = false;
    if (taskPlans.get(key) === plan && draftKey() === key) paintTaskPlan();
  }
}
/** The option names stay short; the title says what the chosen timing does. */
function paintLoopDeliveryTitle(): void {
  const select = $<HTMLSelectElement>('loopDelivery');
  ui(select, 'title', () => select.value === 'after-turn'
    ? t("At Session Finish, or as a new message after verified turn completion")
    : t("Only inside the Session Finish tool result; never start a new turn"));
}
function paintTaskActions(): void {
  const objective = $<HTMLTextAreaElement>('sessionObjective');
  const save = $<HTMLButtonElement>('saveSessionObjective');
  const off = $<HTMLSelectElement>('chatAutomation').value === 'off' && !objectiveEditMode;
  objective.hidden = off;
  document.querySelector<HTMLLabelElement>('label[for="sessionObjective"]')!.hidden = off;
  save.hidden = off;
  const saved = objective.dataset.saved === objective.value && !!objective.value.trim();
  save.disabled = objective.disabled || !objective.value.trim() || save.dataset.busy === 'true' || saved;
  ui(save.querySelector('span')!, 'textContent', () => save.dataset.busy === 'true' ? t("Saving…") : saved ? t("Saved") : t("Save task"));
  for (const id of ['createPlan']) {
    const button = $<HTMLButtonElement>(id);
    const plan = taskPlans.get(draftKey()), planMode = !!plan;
    if (plan?.requestId) { button.dataset.busy = 'true'; button.setAttribute('aria-busy', 'true'); }
    else { delete button.dataset.busy; button.removeAttribute('aria-busy'); }
    button.disabled = plan?.sending === true;
    button.setAttribute('aria-pressed', String(planMode));
    ui(button.querySelector('span')!, 'textContent', () => t("Plan"));
    ui(button, 'aria-label', () => planMode ? t("Cancel plan") : t("Create plan"));
    ui(button, 'title', () => planMode ? t("Return to a normal message; keep your draft") : t("Split your message into editable stages"));
  }
}
function paintLoopDelivery(): void {
  const model = confirmedComposerModel();
  $('loopDeliveryRow').hidden = deps.state()?.config.ui.finishTool !== true || !model ||
    !supportsFinishAutomation($<HTMLSelectElement>('chatAutomation').value as InputAutomation, model.model, model.reasoningEffort);
}
function openingLoopDelivery(): boolean | undefined {
  return selectedId === null ? $<HTMLSelectElement>('loopDelivery').value === 'after-turn' : undefined;
}
function paintAutomationSwitch(): void {
  paintLoopDelivery();
  paintGoalProgress();
  paintActiveGoal();
  const select = $<HTMLSelectElement>('chatAutomation');
  const mode = select.value;
  $('composerModeIcon').className = `ico ph ph-${mode === 'loop' ? 'arrows-clockwise' : mode === 'goal' ? 'target' : 'chat-circle'}`;
  $('composerSettings').dataset.mode = mode;
  ui($('composerModeLabel'), 'textContent', () => mode === 'off' ? t('Normal') : mode === 'goal' ? t('Goal') : t('Loop'));
  for (const button of $('automationSwitch').querySelectorAll<HTMLButtonElement>('[data-mode]')) {
    button.setAttribute('aria-checked', String(button.dataset.mode === select.value));
    button.disabled = select.disabled;
  }
  for (const button of $('automationSwitch').querySelectorAll<HTMLButtonElement>('[data-edit-mode]')) button.disabled = select.disabled;
  if (objectiveEditMode === select.value) objectiveEditMode = null;
  const editMode = objectiveEditMode ?? (select.value === 'loop' ? 'loop' : 'goal');
  $<HTMLSelectElement>('sessionObjectiveMode').value = editMode;
  const loop = editMode === 'loop';
  ui(document.querySelector('label[for="sessionObjective"]')!, 'textContent', () => loop ? t("Loop instructions") : t("Goal"));
  ui($<HTMLTextAreaElement>('sessionObjective'), 'placeholder', () => loop ? t("What should each continuation focus on?") : t("Optional. Leave empty to work toward what you asked in this chat."));
  paintTaskActions();
}
async function refreshSessionControls(): Promise<void> {
  const id = selectedId, generation = ++controlsGeneration;
  const planHost = $('agentPlan');
  if (planHost.dataset.sessionId !== (id ?? '')) renderAgentPlan(planHost, id, null);
  const menu = $('sessionControls');
  if (controlledSessionId !== id || controlledSelection !== selectionGeneration) {
    // Retire the previous selection's projection before awaiting the new owner's IPC.
    // Replace the translation binding too, so a locale refresh cannot revive its status.
    ui($('sessionControlStatus'), 'textContent', () => '');
    for (const action of ['compactSession', 'cancelCompaction']) $(action).hidden = true;
  }
  paintAutomationSwitch();
  if (!id) { controlledSessionId = null; controlledTurnId = null; paintDeliveryControls(); menu.hidden = false;
    $<HTMLTextAreaElement>('sessionObjective').disabled = false;
    paintTaskActions();
    for (const action of ['compactSession', 'cancelCompaction']) $(action).hidden = true;
    return; }
  const opening = pendingComposerInputs.find(row => row.opening && row.sessionId === id && ['queued', 'browser'].includes(row.state));
  if (!sessions.find(row => row.id === id)?.conversationId) {
    controlledSessionId = id; controlledSelection = selectionGeneration; controlledTurnId = null;
    controlledCanInject = false; controlledCanSendDirectly = false; controlledQueueAtFinish = false;
    controlledStopPending = false; controlledFinishWaiting = false;
    menu.hidden = false;
    goalDraftView = null; goalWaitView = null; finishGoalDraftView = null; controlledRecovery = [];
    $<HTMLSelectElement>('chatAutomation').value = opening?.automation ?? 'off';
    $<HTMLSelectElement>('loopDelivery').value = opening?.loopAfterTurn ? 'after-turn' : 'finish';
    paintLoopDeliveryTitle();
    const objective = $<HTMLTextAreaElement>('sessionObjective');
    objective.value = opening?.objective ?? ''; objective.disabled = true;
    objective.dataset.sessionId = id;
    for (const action of ['compactSession', 'cancelCompaction']) $(action).hidden = true;
    paintAutomationSwitch(); paintDeliveryControls();
    return;
  }
  const controls = await run(api.getSessionControls(id));
  if (generation !== controlsGeneration || id !== selectedId) return;
  renderAgentPlan(planHost, id, controls?.plan ?? null);
  controlledSessionId = id;
  controlledSelection = selectionGeneration;
  controlledTurnId = controls?.activeTurnId ?? null;
  goalDraftView = controls?.goalDraft ?? null;
  goalWaitView = controls?.goalWait ?? null;
  finishGoalDraftView = controls?.finishGoalDraft ?? null;
  controlledStopPending = controls?.stopPending === true;
  controlledFinishWaiting = controls?.finishWaiting === true;
  controlledQueueAtFinish = controls?.queueAtFinish === true;
  controlledCanInject = controls?.canInject ?? controlledTurnId !== null;
  controlledCanSendDirectly = controls?.canSendDirectly === true;
  controlledRecovery = controls?.recovery ?? [];
  paintDeliveryControls();
  paintStateLine();
  menu.hidden = !controls;
  $('compactSession').hidden = !controls;
  if (!controls) { $('cancelCompaction').hidden = true; return; }
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
  if (!$<HTMLSelectElement>('loopDelivery').disabled)
    $<HTMLSelectElement>('loopDelivery').value = controls.loopAfterTurn ? 'after-turn' : 'finish';
  paintLoopDeliveryTitle();
  paintAutomationSwitch();
  $<HTMLButtonElement>('compactSession').disabled = !!controls.blocked || !!controls.job?.busy;
  $('cancelCompaction').hidden = !controls.job?.busy;
  ui($('sessionControlStatus'), 'textContent', () => controls.blocked === 'worker' ? t("This sub-agent is managed by its prime.") : controls.blocked === 'blocked' ? t("This chat is blocked.") : controls.job?.busy ? t("Compaction is running in ChatGPT.") : '');
}

async function loadDetail(navigate = false, olderBefore?: number, newerFrom?: number): Promise<boolean> {
  const prepend = olderBefore !== undefined;
  const wanted = selectedId;
  const selection = selectionGeneration;
  const observed = wanted === null ? undefined : sessions.find(row => row.id === wanted);
  const observedCompletion = observed ? { ...observed } : undefined;
  if (wanted !== null && (historyBefore !== null || historyLoading) && detailFor === wanted && !navigate) {
    if (historyLoading) historyRefreshPending = true;
    void refreshSessionControls(); paintDetail(); return false;
  }
  const generation = ++detailLoadGeneration;
  void refreshSessionControls();
  if (wanted === null) {
    handoffLoadGeneration++;
    historyBefore = null;
    events = [];
    totalEvents = 0;
    detailFor = null;
    detailCursor = null;
    $('timelineContent').style.removeProperty('--timeline-scroll-reserve');
    paintDetail();
    return false;
  }
  const opening = detailFor !== wanted;
  if (opening) { historyBefore = null; historyStart = null; }
  // Live deltas must not evict a historical page while the user is reading it.
  const incremental = !prepend && newerFrom === undefined && historyBefore === null && detailFor === wanted && detailCursor !== null;
  const detail = await run(
    api.getSession(wanted, newerFrom !== undefined ? { after: newerFrom, limit: TIMELINE_BATCH_SIZE } : incremental ? { from: detailCursor!, limit: TIMELINE_BATCH_SIZE } : { ...(olderBefore !== undefined ? { before: olderBefore } : historyBefore !== null ? { before: historyBefore } : {}), limit: TIMELINE_BATCH_SIZE })
  );
  if (generation !== detailLoadGeneration || selection !== selectionGeneration || selectedId !== wanted) return false;
  if (!detail) {
    // A failed destination read must not leave another chat displayed indefinitely.
    // run() already presents the read error; keep the destination empty and retryable.
    if (opening) {
      $('timeline').replaceChildren();
      $('timeline').removeAttribute('inert');
      $('timeline').removeAttribute('aria-busy');
    }
    return false;
  }
  // An empty older page is not navigation. Keep the live cursor and viewport intact.
  if (prepend && !detail.events.length) return true;
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
      events = retainTimelinePage(chronological(foldProgress([...events, ...folded])), 'newer');
      // Reaching the live tail restores ordinary delta reads. Paging itself preserves
      // the reader's row even when they were at the bottom of the previous window.
      if (detail.events.length < TIMELINE_BATCH_SIZE) historyBefore = null;
    } else if (prepend) {
      const boundary = olderBefore!;
      historyBefore = boundary;
      const retained = events.filter(event => positionOf(event) >= boundary);
      events = retainTimelinePage(chronological(foldProgress([...folded, ...retained])), 'older');
    } else events = chronological([...folded].sort((a, b) => positionOf(a) - positionOf(b)).slice(-MAX_TIMELINE_ROWS));
    detailFor = wanted;
  }
  detailCursor = Math.max(opening ? 0 : detailCursor ?? 0,
    typeof detail.nextFrom === 'number'
      ? detail.nextFrom
      : detail.events.reduce((cursor, event) => Math.max(cursor, event.seq + 1), incremental ? detailCursor! : 0));
  totalEvents = detail.total;
  // Stamp from the request-time copy: a summary newer than this read must still prove it stale.
  if (!prepend && newerFrom === undefined)
    detailStamp = observedCompletion ? { updatedAt: observedCompletion.updatedAt, events: observedCompletion.events } : null;
  if (opening) $('timelineContent').style.removeProperty('--timeline-scroll-reserve');
  paintDetail(!prepend && newerFrom === undefined);
  // A sidebar completion becomes read only after this exact selection/load has successfully
  // painted its conversation at the live tail. Keep the completion snapshot from request time:
  // a newer completion observed while this load is in flight must remain unseen.
  if (visible && historyBefore === null && generation === detailLoadGeneration && selection === selectionGeneration && selectedId === wanted) {
    sidebarCompletion?.markSeen(observedCompletion);
    paintSessions();
  }
  // A selection opens at the latest message; the previous chat's viewport is not
  // a reading position in this one. Apply only after the current load has rendered.
  if (opening) $('chatBody').scrollTop = $('chatBody').scrollHeight;
  if (opening) requestHistory(-1, true);
  void loadHandoff();
  // A burst can contain more than one renderer-sized page between coalesced notifications.
  // Drain it page by page rather than silently jumping the cursor or lifting the payload cap.
  if (incremental && detail.events.length === TIMELINE_BATCH_SIZE && selectedId === wanted) {
    window.setTimeout(() => void loadDetail(), 0);
  }
  return true;
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
    node.append(el('span', 'cut', () => t(" … cut, {0} characters in the original", [compactNumber(chars)])));
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
const PROSE_BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'TR', 'TD', 'TH']);

/** Normalized rendered prose immediately before each owned marker, in one DOM walk. */
function prosePrefixes(root: ParentNode, marker: (element: Element) => string | null): Map<string, string> {
  const prefixes = new Map<string, string>();
  let text = '';
  let spacing = false;
  const feed = (value: string): void => {
    for (const chunk of value.match(/\s+|[^\s]+/g) ?? []) {
      if (/^\s+$/.test(chunk)) { spacing = true; continue; }
      if (spacing && text) text += ' ';
      text += chunk;
      spacing = false;
    }
  };
  const visit = (parent: ParentNode): void => {
    for (const node of parent.childNodes) {
      if (node.nodeType === 3) { feed(node.textContent ?? ''); continue; }
      if (node.nodeType !== 1) continue;
      const element = node as Element;
      const key = marker(element);
      if (key !== null) { prefixes.set(key, text); continue; }
      const tag = element.tagName.toUpperCase();
      if (tag === 'BR') { feed('\n'); continue; }
      if (PROSE_BLOCK_TAGS.has(tag)) feed('\n');
      visit(element);
      if (PROSE_BLOCK_TAGS.has(tag)) feed('\n');
    }
  };
  visit(root);
  return prefixes;
}

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
  const capturedPrefixes = prosePrefixes(template.content, element =>
    element.hasAttribute('data-content-reference-start') ? `capture:${element.getAttribute('data-content-reference-start')}:${element.getAttribute('data-content-reference-end')}` : null);

  // Parsing every source prefix once per citation made heavily sourced answers approach
  // quadratic work. Parse canonical Markdown once and collect exact probe prefixes in one walk.
  const probeAttribute = `data-cos-probe-${Math.random().toString(36).slice(2)}`;
  const probeMarkers: string[] = [];
  const probeParser = new Marked({ gfm: true, extensions: [{
    name: 'providerCitationProbe', level: 'inline',
    start: value => value.indexOf('\uE200'),
    tokenizer(value) {
      const match = value.match(PROVIDER_CITATION);
      if (!match) return undefined;
      const probe = probeMarkers.length;
      probeMarkers.push(match[0]);
      return { type: 'providerCitationProbe', raw: match[0], probe };
    },
    renderer(token) { return `<span ${probeAttribute}="${Number((token as unknown as { probe: number }).probe)}"></span>`; }
  }] });
  const canonical = document.createElement('template');
  canonical.innerHTML = probeParser.parse(source, { async: false, gfm: true });
  const probePrefixes = prosePrefixes(canonical.content, element => {
    const value = element.getAttribute(probeAttribute);
    return value !== null && /^\d+$/.test(value) ? `probe:${value}` : null;
  });
  const canonicalPrefixes = new Map<string, string>();
  const markerCounts = new Map<string, number>();
  for (const [probe, marker] of probeMarkers.entries()) {
    markerCounts.set(marker, (markerCounts.get(marker) ?? 0) + 1);
    const prefix = probePrefixes.get(`probe:${probe}`);
    if (prefix !== undefined && !canonicalPrefixes.has(marker)) canonicalPrefixes.set(marker, prefix);
  }
  for (const reference of template.content.querySelectorAll('[data-content-reference-start][data-content-reference-end]')) {
    const from = Number(reference.getAttribute('data-content-reference-start'));
    const to = Number(reference.getAttribute('data-content-reference-end'));
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > points) continue;
    const start = offsets[from]!, end = offsets[to]!;
    const marker = source.slice(start, end);
    if (marker.match(PROVIDER_CITATION)?.[0] !== marker) continue;
    const capturedPrefix = capturedPrefixes.get(`capture:${reference.getAttribute('data-content-reference-start')}:${reference.getAttribute('data-content-reference-end')}`);
    let canonicalPrefix = canonicalPrefixes.get(marker);
    if ((markerCounts.get(marker) ?? 0) > 1) {
      // Repeated markers are rare but legal. Prove this exact source range against its own prefix.
      const exact = document.createElement('template');
      exact.innerHTML = marked.parse(source.slice(0, start).replace(/\uE200(?:cite|filecite)\uE202[^\uE200\uE201]*\uE201/g, ''), { async: false, gfm: true });
      const endProbe = document.createElement('span');
      endProbe.dataset.cosPrefixEnd = '';
      exact.content.append(endProbe);
      canonicalPrefix = prosePrefixes(exact.content, element => element.hasAttribute('data-cos-prefix-end') ? 'end' : null).get('end');
    }
    if (capturedPrefix === undefined || capturedPrefix !== canonicalPrefix) continue;
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
      ui(anchor, 'title', () => candidate.textContent?.trim().slice(0, 500) || t("Source"));
      anchors.push(anchor.outerHTML);
    }
    if (anchors.length) links.set(marker, ` (${anchors.join(', ')})`);
  }
  return links;
}

/**
 * ChatGPT's inline citation directive, `:chatgpt-content-reference{index="0"}` at the end of a
 * sentence, which its page draws as a source pill ("arXiv +2") and plain Markdown shows raw. The
 * directive names an index into the reply's references. When the reply was recorded with them,
 * the pill and every source behind it come from that exact index. Otherwise a pill is taken from
 * the page's own rendering only when the prose before it matches the prose before the directive,
 * as `citationLabels` proves native citation ranges. An unproven directive is dropped: never raw,
 * and never a guessed destination.
 */
const INLINE_REFERENCE = /^:{1,2}chatgpt-content-reference\{[^}\n]*\}/;
/** The sources behind one pill, and how many more its page counted than the recording holds. */
interface CitationPill { sources: MessageReference['sources']; unrecorded: number }

function citationPills(source: string, capture?: StoredText): Map<number, CitationPill> {
  const pills = new Map<number, CitationPill>();
  if (!capture?.text || capture.truncated || capture.text.length > MAX_RENDERED_HTML_CHARS) return pills;
  const template = document.createElement('template');
  template.innerHTML = capture.text;
  const captured = [...template.content.querySelectorAll('a[data-testid="chatgpt-citation"]')];
  if (!captured.length) return pills;
  // Other native citations are pills on the page too; their words are not prose.
  const pillOf = (element: Element): number => captured.indexOf(element);
  const capturedPrefixes = prosePrefixes(template.content, element => {
    const at = pillOf(element);
    return at >= 0 ? `pill:${at}` : element.hasAttribute('data-content-reference-start') ? 'native' : null;
  });
  const probeAttribute = `data-cos-probe-${Math.random().toString(36).slice(2)}`;
  let probes = 0;
  const probeParser = new Marked({ gfm: true, extensions: [{
    name: 'inlineReferenceProbe', level: 'inline',
    start: value => { const at = value.search(/:{1,2}chatgpt-content-reference\{|\uE200/); return at < 0 ? undefined : at; },
    tokenizer(value) {
      const reference = value.match(INLINE_REFERENCE);
      if (reference) return { type: 'inlineReferenceProbe', raw: reference[0], probe: probes++ };
      const native = value.match(PROVIDER_URL) ?? value.match(PROVIDER_CITATION);
      return native ? { type: 'inlineReferenceProbe', raw: native[0], probe: -1 } : undefined;
    },
    renderer(token) {
      const probe = Number((token as unknown as { probe: number }).probe);
      return probe >= 0 ? `<span ${probeAttribute}="${probe}"></span>` : '';
    }
  }] });
  const canonical = document.createElement('template');
  canonical.innerHTML = probeParser.parse(source, { async: false, gfm: true });
  const canonicalPrefixes = prosePrefixes(canonical.content, element => {
    const value = element.getAttribute(probeAttribute);
    return value !== null && /^\d+$/.test(value) ? `probe:${value}` : null;
  });
  const used = new Set<number>();
  for (let probe = 0; probe < probes; probe++) {
    const prefix = canonicalPrefixes.get(`probe:${probe}`);
    if (prefix === undefined) continue;
    // In page order, the first unused pill whose preceding prose is this directive's.
    const at = captured.findIndex((_, index) => !used.has(index) && capturedPrefixes.get(`pill:${index}`) === prefix);
    if (at < 0) continue;
    used.add(at);
    const anchor = captured[at]!;
    const href = safeRenderedHref(anchor.getAttribute('href') ?? '');
    if (!href || !/^https?:/.test(href)) continue;
    const moreNode = [...anchor.querySelectorAll('[aria-hidden="true"]')].find(node => /^\+\d{1,3}$/.test(node.textContent?.trim() ?? ''));
    const more = moreNode ? Number(moreNode.textContent!.trim().slice(1)) : 0;
    const label = (anchor.textContent ?? '').replace(moreNode?.textContent ?? '', '').replace(/\s+/g, ' ').trim().slice(0, 80);
    // The page's label reads "Source: Title, URL, N additional sources".
    const described = anchor.getAttribute('aria-label') ?? '';
    const title = label && described.startsWith(`${label}: `) ? described.slice(label.length + 2).split(`, ${href}`)[0]!.trim() : '';
    pills.set(probe, { sources: [{ title: title.slice(0, 300) || href, url: href, ...(label ? { source: label } : {}) }], unrecorded: more });
  }
  return pills;
}

const siteOf = (url: string): string => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

/**
 * The app's own pill for a proven inline citation, added after sanitising like the code panels.
 * Clicking it opens its source through the message's link handler. Hovering or focusing it shows
 * the card ChatGPT shows: the source's site, title, date and snippet, paging through every source
 * behind the count. A reply recorded without them says how many more its page counted.
 */
function citationPill(pill: CitationPill): HTMLElement {
  const first = pill.sources[0]!;
  const total = pill.sources.length + pill.unrecorded;
  const wrap = el('span', 'citation');
  const link = document.createElement('a');
  link.className = 'citation-pill';
  link.href = first.url;
  link.append(el('span', 'citation-pill-label', first.source || siteOf(first.url)));
  if (total > 1) link.append(el('span', 'citation-pill-more', `+${total - 1}`));
  const card = el('span', 'citation-card');
  card.hidden = true;
  // Built once: paging rewrites only the words, so the arrow just clicked keeps focus and stays
  // under the pointer. Rebuilding the card removed the focused button and closed the card.
  const site = el('span', 'citation-card-site');
  const title = document.createElement('a');
  title.className = 'citation-card-title';
  const detail = el('span', 'citation-card-detail');
  const count = el('span', 'citation-card-count');
  let at = 0;
  const paint = (): void => {
    const source = pill.sources[at]!;
    site.textContent = source.source || siteOf(source.url);
    title.href = source.url; title.textContent = source.title || siteOf(source.url);
    const date = source.date ? new Date(source.date).toLocaleDateString(currentLanguage(), { year: 'numeric', month: 'long', day: 'numeric' }) : '';
    detail.textContent = [date, source.snippet].filter(Boolean).join(' — ');
    detail.hidden = !detail.textContent;
    count.textContent = `${at + 1}/${pill.sources.length}`;
  };
  if (pill.sources.length > 1) {
    const step = (delta: number, name: string, label: string): HTMLButtonElement => {
      const button = el('button', 'citation-card-step') as HTMLButtonElement;
      button.type = 'button'; button.append(icon(name));
      ui(button, 'aria-label', () => t(label));
      button.addEventListener('click', event => {
        event.preventDefault();
        at = (at + delta + pill.sources.length) % pill.sources.length;
        paint();
      });
      return button;
    };
    const nav = el('span', 'citation-card-nav');
    nav.append(step(-1, 'i-arrow-left', 'Previous source'), step(1, 'i-arrow-right', 'Next source'), count);
    card.append(nav);
  }
  card.append(site, title, detail);
  if (pill.unrecorded) card.append(el('span', 'citation-card-note', () => t('{0} more sources were not recorded with this reply.', [pill.unrecorded])));
  let timer: number | undefined;
  let pointerInside = false;
  const show = (): void => {
    window.clearTimeout(timer);
    if (!card.hidden) return;
    at = 0; paint(); card.hidden = false;
    // Near the end of a line the card grows back from the pill instead of past the column.
    card.classList.remove('is-end');
    const column = wrap.closest('.msg')?.getBoundingClientRect();
    if (column && card.getBoundingClientRect().right > column.right) card.classList.add('is-end');
  };
  const hide = (delay: number): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { card.hidden = true; }, delay);
  };
  wrap.addEventListener('pointerenter', () => { pointerInside = true; window.clearTimeout(timer); timer = window.setTimeout(show, 150); });
  wrap.addEventListener('pointerleave', () => { pointerInside = false; hide(200); });
  wrap.addEventListener('focusin', show);
  // Focus leaving for the page while the pointer is still on the card (a click on its words) keeps it.
  wrap.addEventListener('focusout', event => { if (!pointerInside && !wrap.contains(event.relatedTarget as Node | null)) hide(0); });
  wrap.addEventListener('keydown', event => { if (event.key === 'Escape') hide(0); });
  wrap.append(link, card);
  return wrap;
}
const PILL_PLACEHOLDER = /^\uE000(\d{1,4})\uE001$/;

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
/**
 * ChatGPT's writing block: `:::writing{variant="…" id="…" title="…"}`, the text, then `:::`.
 * ChatGPT draws it as a card; as plain Markdown it showed its raw directive. It renders as a
 * quote with its title in bold, a shape the sanitised message view already styles.
 */
const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const WRITING_BLOCK: TokenizerAndRendererExtension = {
  name: 'writingBlock', level: 'block',
  start: value => value.match(/^:::writing\b/m)?.index,
  tokenizer(value) {
    // Without its closing `:::` the block runs to the end of the message, as ChatGPT draws it:
    // the block is still streaming, or the answer was stopped inside it.
    const match = value.match(/^:::writing(\{[^}\n]*\})?[ \t]*\n([\s\S]*?)(?:\n:::[ \t]*(?:\n|$)|$)/);
    if (!match) return undefined;
    const title = match[1]?.match(/\btitle="([^"\n]*)"/)?.[1] ?? '';
    return { type: 'writingBlock', raw: match[0], title, tokens: this.lexer.blockTokens(match[2] ?? '', []) };
  },
  renderer(token) {
    const heading = token['title'] ? `<p><strong>${escapeHtml(String(token['title']))}</strong></p>` : '';
    return `<blockquote>${heading}${this.parser.parse(token.tokens ?? [])}</blockquote>`;
  }
};

export function renderedMarkdown(source: string, capture?: StoredText, references?: readonly MessageReference[]): HTMLElement {
  // Fiber's canonical text can be complete while a background provider tab still
  // paints its first words. Render this revision directly; captured DOM HTML is
  // never evidence that it contains the current message revision.
  let text = withoutMessageReaction(source).slice(0, MAX_RENDERED_HTML_CHARS);
  // A ChatGPT directive this app cannot draw (#574 and whatever ChatGPT adds next): the page's own
  // recorded rendering is the faithful presentation; without one, the directive lines are dropped.
  if (hasProviderDirective(text)) {
    const plain = withoutProviderDirectives(text);
    if (resolvedCapture(capture)) return renderedMessage(capture, plain);
    text = plain || t('This reply points to content from another message that was not recorded.');
  }
  const citations = text.includes('\uE200') ? citationLabels(text, capture) : new Map<string, string>();
  const pills = text.includes('chatgpt-content-reference{') ? citationPills(text, capture) : new Map<number, CitationPill>();
  const byIndex = new Map((references ?? []).map(reference => [reference.index, reference]));
  let directives = 0;
  // An inline tokenizer leaves literal citation examples inside code spans/fences intact.
  const parser = new Marked({ gfm: true, extensions: [WRITING_BLOCK, {
    name: 'inlineReference', level: 'inline',
    start: value => { const at = value.search(/:{1,2}chatgpt-content-reference\{/); return at < 0 ? undefined : at; },
    tokenizer(value) { const match = value.match(INLINE_REFERENCE); return match ? { type: 'inlineReference', raw: match[0], probe: directives++ } : undefined; },
    renderer(token) {
      // A proven pill travels the sanitiser as a plain link; the pill itself is drawn afterwards.
      const probe = Number((token as unknown as { probe: number }).probe);
      const index = token.raw.match(/\bindex="(\d{1,4})"/)?.[1];
      const recorded = index === undefined ? undefined : byIndex.get(Number(index));
      if (recorded) pills.set(probe, { sources: recorded.sources, unrecorded: 0 });
      const pill = pills.get(probe);
      return pill ? `<a href="${escapeHtml(pill.sources[0]!.url)}">\uE000${probe}\uE001</a>` : '';
    }
  }, {
    name: 'providerReference', level: 'inline',
    start: value => value.indexOf('\uE200'),
    tokenizer(value) { const match = value.match(PROVIDER_URL) ?? value.match(PROVIDER_CITATION); return match ? { type: 'providerReference', raw: match[0] } : undefined; },
    renderer(token) {
      const url = token.raw.match(PROVIDER_URL);
      if (url) {
        // Unlike opaque citation IDs, a native url token already carries its exact
        // authored label and destination. Captured React anchors may have no href.
        const link = document.createElement('a'); ui(link, 'textContent', () => url[1] || url[2] || t("Link"));
        if (safeExternalLink(url[2] ?? '')) link.setAttribute('href', url[2]!);
        return link.outerHTML;
      }
      if (citations.has(token.raw)) return citations.get(token.raw)!;
      if (token.raw.startsWith('\uE200filecite\uE202')) return '';
      const missing = document.createElement('span');
      missing.title = t('The recording does not include this source URL');
      missing.textContent = t('[source link unavailable]');
      return missing.outerHTML;
    }
  }] });
  const html = parser.parse(text, { async: false });
  const box = renderedMessage({ text: html, chars: html.length, truncated: html.length > MAX_RENDERED_HTML_CHARS }, text);
  if (pills.size) {
    for (const anchor of box.querySelectorAll('a[href]')) {
      const probe = anchor.textContent?.match(PILL_PLACEHOLDER)?.[1];
      const pill = probe === undefined ? undefined : pills.get(Number(probe));
      if (pill) anchor.replaceWith(citationPill(pill));
    }
  }
  return box;
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
  sanitizeHtmlTree(template.content, {
    allowedTags: RENDERED_TAGS,
    dropTags: DROP_RENDERED_TAGS,
    safeHref: safeRenderedHref,
    preserveDirection: true
  });
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
    ui(viewport, 'aria-label', () => t("Table"));
    table.replaceWith(viewport);
    viewport.append(table);
  }
  if (!box.textContent?.trim() && safeFallback) {
    box.classList.remove('rich');
    box.textContent = safeFallback;
  } else {
    // Captured provider toolbars are stripped above. Add app-owned controls only after
    // sanitizing and after the empty-capture fallback has been decided.
    for (const pre of box.querySelectorAll('pre')) {
      const value = pre.textContent ?? '';
      const panel = el('div', 'markdown-code');
      const header = el('div', 'tool-output-header');
      header.append(icon('i-terminal', 'ico'), el('strong', '', () => t('Code')));
      const copy = el('button', 'tool-copy', () => t('Copy')) as HTMLButtonElement;
      copy.type = 'button';
      copy.addEventListener('click', () => void (async () => {
        if (await run(api.writeClipboard(value))) ui(copy, 'textContent', () => t('Copied'));
        else toast(t('Could not copy text.'));
      })());
      header.append(copy);
      pre.replaceWith(panel);
      panel.append(header, pre);
    }
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

/*
 * Sending and following, as ChatGPT, Claude and Codex do. A sent message rides to the top of the
 * view and its answer grows in the reserved space beneath it, so nothing moves while it streams;
 * an answer taller than the view is read from the top rather than chased. Scrolling by the reader
 * releases the hold, and a button brings them back to the end whenever content lies below.
 */
const SEND_TOP_GAP = 16, JUMP_DISTANCE = 150, SEND_GLIDE_MS = 700;
const USER_MESSAGE_KEY = 'message:user_message\u0000';
let sendAnchor: { key: string; inputId: string; messageId?: string; before: Set<string>; session: string | null; seen: boolean; smoothUntil: number } | null = null;
/** The reader scrolled away from a held message: they are reading, not following the end. */
let readingAfterSend = false;
/**
 * "Follow new output" (ui.followOutput, on unless switched off): the reader is at the end and has not
 * scrolled away from it. Only the reader's own scrolling changes this, never growth, so a busy turn
 * whose rows grow between repaints keeps following (2026-10-02: the view stopped short of the end
 * whenever much moved at once). Off keeps the send hold and the per-repaint end check.
 */
let readerAtEnd = true;
const followOutput = (): boolean => deps.state()?.config.ui.followOutput !== false;

function userMessageKeys(): Set<string> {
  const keys = new Set<string>();
  for (const row of $('timelineContent').querySelectorAll<HTMLElement>('[data-timeline-key]')) {
    if (row.dataset.timelineKey!.startsWith(USER_MESSAGE_KEY)) keys.add(row.dataset.timelineKey!);
  }
  return keys;
}

function scrollPane(pane: HTMLElement, top: number, smooth: boolean): void {
  if (typeof pane.scrollTo === 'function') pane.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
  else pane.scrollTop = top;
}

/** Keeps the sent message at the top of the view, reserving room below it for the answer. */
function holdSentMessage(): boolean {
  const anchor = sendAnchor;
  if (!anchor) return false;
  if (anchor.session !== selectedId) { sendAnchor = null; return false; }
  const pane = $('chatBody'), content = $('timelineContent');
  const rows = [...content.querySelectorAll<HTMLElement>('[data-timeline-key]')];
  let row = rows.find(node => node.dataset.timelineKey === anchor.key);
  // ChatGPT records the sent message under its own id, without the input id, and the pending row
  // leaves. Follow the recorded row: by the id the input learned, else as the user message that
  // was not in the chat when this one was sent.
  anchor.messageId ??= pendingComposerInputs.find(entry => entry.id === anchor.inputId)?.messageId;
  if (!row) {
    const key = anchor.messageId && `${USER_MESSAGE_KEY}${anchor.messageId}`;
    row = (key && rows.find(node => node.dataset.timelineKey === key)) ||
      rows.findLast(node => node.dataset.timelineKey!.startsWith(USER_MESSAGE_KEY) && !anchor.before.has(node.dataset.timelineKey!));
    if (row) anchor.key = row.dataset.timelineKey!;
  }
  if (!row || !row.getClientRects().length) return false;
  // The glide starts when the message appears, which for one queued behind a running turn is
  // well after it was sent.
  if (!anchor.seen) { anchor.seen = true; anchor.smoothUntil = Date.now() + SEND_GLIDE_MS; }
  // Measure where the row rests, not where its entrance animation has shifted it for now.
  const transform = getComputedStyle(row).transform;
  const shift = transform && transform !== 'none' && typeof DOMMatrixReadOnly === 'function' ? new DOMMatrixReadOnly(transform).m42 : 0;
  const top = Math.max(0, pane.scrollTop + row.getBoundingClientRect().top - shift - pane.getBoundingClientRect().top - SEND_TOP_GAP);
  // Size the reserve from the content alone, and never drop it first: removing it even for a
  // measurement shrinks the scroll range and the browser clamps the view mid-animation.
  const current = Number.parseFloat(content.style.getPropertyValue('--timeline-scroll-reserve')) || 0;
  const reserve = Math.max(0, Math.ceil(top + pane.clientHeight - (pane.scrollHeight - current)));
  if (reserve !== current) {
    if (reserve > 0) content.style.setProperty('--timeline-scroll-reserve', `${reserve}px`);
    else content.style.removeProperty('--timeline-scroll-reserve');
  }
  if (Math.abs(pane.scrollTop - top) > 0.5) scrollPane(pane, top, Date.now() < anchor.smoothUntil);
  paintJumpLatest();
  return true;
}

/** Distance from the view's bottom to the last real content, ignoring the reserved space. */
function distanceFromTail(): number {
  const pane = $('chatBody');
  const reserve = Number.parseFloat($('timelineContent').style.getPropertyValue('--timeline-scroll-reserve')) || 0;
  return pane.scrollHeight - reserve - pane.clientHeight - pane.scrollTop;
}

function paintJumpLatest(): void {
  const jump = document.getElementById('jumpLatest');
  if (jump) jump.classList.toggle('is-shown', !!selectedId && distanceFromTail() > JUMP_DISTANCE);
}

function jumpToLatest(): void {
  sendAnchor = null; readingAfterSend = false; readerAtEnd = true;
  const pane = $('chatBody');
  $('timelineContent').style.removeProperty('--timeline-scroll-reserve');
  scrollPane(pane, pane.scrollHeight, true);
}

/** Explicit history inspection releases the same follow/send hold as reading upwards. */
function readTimeline(): void {
  readerAtEnd = false; sendAnchor = null; readingAfterSend = true;
}

function roundWorkers(ids: string[], button = el('button', 'activity-workers') as HTMLButtonElement): HTMLButtonElement {
  button.type = 'button';
  button.hidden = ids.length === 0;
  ui(button, 'title', () => t('{0} sub-agents in this round', [ids.length]));
  ui(button, 'aria-label', () => t('{0} sub-agents in this round', [ids.length]));
  if (!button.childElementCount) button.append(icon('i-agents'), el('span'));
  button.lastElementChild!.textContent = String(ids.length);
  const owner = selectedId, epoch = selectionGeneration;
  button.onclick = event => {
    event.preventDefault(); event.stopPropagation();
    if (selectedId !== owner || selectionGeneration !== epoch || !button.isConnected) return;
    const current = ids.filter(id => sessions.some(worker => worker.id === id &&
      worker.origin?.kind === 'worker' && worker.origin.fromSessionId === owner));
    if (!current.length) return;
    readTimeline();
    agentPanel?.showWorkers(current);
    paintJumpLatest();
  };
  return button;
}

function forgetTimelineRows(): void {
  openTools.clear();
  rowCache.clear();
}

/** Line deltas split so removed lines read in red; any other metric stays one text node. */
function toolMetric(value: string, className = 'metric'): HTMLElement {
  const metric = el('span', className);
  const delta = /^(~?)(\+\d+)?(?:\s+)?([−-]\d+)?$/.exec(value);
  if (!delta || (!delta[2] && !delta[3])) {
    metric.textContent = value;
    return metric;
  }
  if (delta[1]) metric.append(delta[1]);
  if (delta[2]) metric.append(el('span', 'metric-added', delta[2]));
  if (delta[3]) {
    if (delta[2]) metric.append(' ');
    metric.append(el('span', 'metric-removed', delta[3]));
  }
  return metric;
}

function toolBody(event: Extract<SessionEvent, { kind: 'tool_call' }>, context?: { id: string; current: () => boolean }): HTMLElement {
  const { call } = event;
  const summary = toolCallSummary(call);
  const box = document.createElement('details');
  box.className = `tool tone-${call.summary.tone}`;
  box.dataset.outcome = call.outcome;
  if (call.changes?.length || ['exec_command', 'write_stdin', 'apply_patch'].includes(call.tool)) box.classList.add('is-artifact');
  box.open = openTools.has(call.callId);
  box.addEventListener('toggle', () => {
    if (box.open) openTools.add(call.callId);
    else openTools.delete(call.callId);
  });

  const head = document.createElement('summary');
  head.append(icon(KIND_ICON[call.summary.kind] ?? 'i-bolt', 'ico tool-ico'));
  if (call.tool === 'exec_command' || call.tool === 'write_stdin') head.append(el('span', 'tool-tag is-shell', 'shell'));
  else if (call.changes?.length || call.tool === 'apply_patch') head.append(el('span', 'tool-tag is-diff', 'diff'));
  head.append(el('b', '', call.summary.title));
  if (call.summary.detail) head.append(el('em', '', call.summary.detail));
  if (call.changes?.length) {
    const added = call.changes.reduce((total, change) => total + change.added, 0);
    const removed = call.changes.reduce((total, change) => total + change.removed, 0);
    const approximate = call.changes.some(change => change.approximate);
    const count = toolMetric(`+${added} −${removed}`, 'tool-change-count');
    if (approximate) count.append(el('span', '', () => t(' (approx.)')));
    // When the outcome metric on the right is already a line delta ("+39", "+2 −13", "~−7"),
    // a second count beside the title only repeats it, whatever its exact formatting.
    const deltaMetric = /^~?(?:\+\d+)?\s*(?:[−-]\d+)?$/.test(summary.metric ?? '') && /\d/.test(summary.metric ?? '');
    if (!deltaMetric) head.append(count);
  }
  if (summary.metric) head.append(toolMetric(summary.metric));
  const project = context ? null : selectedLocalProject();
  const sessionId = context ? null : selectedId;
  const reviewIndices = call.outcome === 'ok' ? (call.changes ?? []).flatMap((change, index) =>
    change.reviewAssetId ? [index] : []).slice(0, 32) : [];
  const unavailable = call.outcome === 'ok' ? (call.changes ?? []).filter(change => change.reviewUnavailable) : [];
  if (project && sessionId && !reviewIndices.length && unavailable.length) {
    // Say why there is nothing to review instead of leaving the row without an action.
    const missing = el('button', 'tool-open-diff is-unavailable') as HTMLButtonElement;
    missing.type = 'button'; missing.setAttribute('aria-disabled', 'true');
    missing.addEventListener('click', click => { click.preventDefault(); click.stopPropagation(); });
    missing.append(icon('i-git-diff'));
    const reason = () => unavailable.some(change => change.reviewUnavailable === 'too-large')
      ? t('Diff unavailable: this edit was too large to keep') : t('Diff unavailable: this edit was not kept');
    ui(missing, 'title', reason);
    ui(missing, 'aria-label', reason);
    head.append(missing);
  }
  if (project && sessionId && reviewIndices.length) {
    const review = el('button', 'tool-open-diff') as HTMLButtonElement;
    review.type = 'button';
    review.append(icon('i-git-diff'));
    const total = reviewIndices.length + unavailable.length;
    const label = () => unavailable.length ? t('Review this edit ({0} of {1} files)', [reviewIndices.length, total]) : t('Review this edit');
    ui(review, 'title', label);
    ui(review, 'aria-label', label);
    review.addEventListener('click', click => {
      click.preventDefault();
      click.stopPropagation();
      if (selectedId !== sessionId || selectedLocalProject()?.id !== project.id) return;
      void reviewPanel?.openReview(project.id, sessionId, call.callId, reviewIndices).then(opened => {
        if (!opened) toast(t('Recorded edit is unavailable.'));
      });
    });
    head.append(review);
  }
  box.append(head);

  // Collapsed calls only need their headline. Large recorded results must not
  // consume layout/DOM work, or evict surrounding prose, before they are opened.
  let populated = false;
  const populate = () => {
    if (populated || !box.open) return;
    populated = true;
    appendToolOutput(box, event, context);
  };
  box.addEventListener('toggle', populate);
  populate();
  return box;
}

/** A batch is storage work, not a wheel detent. Fill the requested visible edge
 * through hidden events/collapsed activity, yielding between bounded IPC reads. */
function requestHistory(direction: number, opening = false): void {
  if (!selectedId || detailFor !== selectedId || !direction) return;
  historyDemand = { sessionId: selectedId, selection: selectionGeneration, direction, opening };
  void fillTimelineHistory();
}

async function fillTimelineHistory(): Promise<void> {
  if (historyLoading) return;
  historyLoading = true;
  let filledOpening = false;
  try {
    while (historyDemand) {
      const demand = historyDemand;
      if (demand.sessionId !== selectedId || demand.selection !== selectionGeneration || detailFor !== selectedId) {
        historyDemand = null;
        break;
      }
      const pane = $('chatBody'), timeline = $('timelineContent');
      const buffer = Math.min(480, Math.max(160, pane.clientHeight / 2));
      const reserve = Number.parseFloat(timeline.style.getPropertyValue('--timeline-scroll-reserve')) || 0;
      const nearEdge = demand.opening
        ? timeline.getBoundingClientRect().height - reserve < pane.clientHeight + buffer
        : demand.direction < 0 ? pane.scrollTop <= buffer
          : pane.scrollHeight - reserve - pane.clientHeight - pane.scrollTop <= buffer;
      if (pane.clientHeight <= 0 || !nearEdge || (demand.direction > 0 && historyBefore === null)) {
        historyDemand = null;
        break;
      }
      const cursor = demand.direction < 0
        ? events.reduce((oldest, event) => Math.min(oldest, positionOf(event)), Infinity)
        : events.reduce((newest, event) => Math.max(newest, positionOf(event)), 0);
      if (!Number.isFinite(cursor) || (demand.direction < 0 && (cursor <= 1 || cursor === historyStart))) {
        historyDemand = null;
        break;
      }
      const loaded = await loadDetail(true, demand.direction < 0 ? cursor : undefined, demand.direction > 0 ? cursor : undefined);
      if (demand.sessionId !== selectedId || demand.selection !== selectionGeneration || detailFor !== selectedId) continue;
      if (!loaded) { if (demand === historyDemand) historyDemand = null; continue; }
      const next = demand.direction < 0
        ? events.reduce((oldest, event) => Math.min(oldest, positionOf(event)), Infinity)
        : events.reduce((newest, event) => Math.max(newest, positionOf(event)), 0);
      if (demand === historyDemand && demand.opening) {
        // Filling a newly selected tail has not navigated away from live work.
        // User input replaces the demand and owns its position from then on.
        historyBefore = null;
        timeline.style.removeProperty('--timeline-scroll-reserve');
        pane.scrollTop = pane.scrollHeight;
        filledOpening = true;
      }
      if (next === cursor) {
        if (demand.direction < 0) historyStart = cursor;
        if (demand === historyDemand) historyDemand = null;
      }
      await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
    }
  } finally {
    historyLoading = false;
    const refresh = filledOpening || historyRefreshPending;
    historyRefreshPending = false;
    if (historyDemand) void fillTimelineHistory();
    else if (refresh && historyBefore === null) void loadDetail();
  }
}

function appendToolOutput(box: HTMLDetailsElement, { call }: Extract<SessionEvent, { kind: 'tool_call' }>,
  context?: { id: string; current: () => boolean }): void {
  const raw = el('div', 'raw');
  const appendText = (label: () => string, value: string, truncated: boolean, chars: number) => {
    const panel = el('div', 'tool-output');
    const header = el('div', 'tool-output-header');
    header.append(icon(KIND_ICON[call.summary.kind] ?? 'i-terminal', 'ico'), el('strong', '', label));
    const copy = el('button', 'tool-copy', () => t('Copy')) as HTMLButtonElement;
    copy.type = 'button';
    copy.addEventListener('click', () => void (async () => {
      if (await run(api.writeClipboard(value))) ui(copy, 'textContent', () => t('Copied'));
      else toast(t('Could not copy text.'));
    })());
    header.append(copy);
    panel.append(header, textBlock('pre', value, truncated, chars));
    raw.append(panel);
  };
  const facts = el('p', 'raw-facts');
  ui(facts, 'textContent', () => `${call.tool} · ${call.outcome} · ${Math.round(call.durationMs)} ms · ` +
    t("placed by {0}", [ATTRIBUTION_LABELS[call.attribution] ?? call.attribution]));
  raw.append(facts);

  const ownerId = context?.id ?? selectedId, generation = selectionGeneration;
  const current = () => context ? context.current() : ownerId === selectedId && generation === selectionGeneration;
  if (call.outcome === 'ok' && call.changes?.length && ownerId) {
    raw.append(renderEditCards(call, ownerId, current));
  } else if (call.changes && call.changes.length > 0) {
    const changes = el('ul', 'changes');
    for (const change of call.changes) {
      const li = el('li');
      li.append(el('code', '', change.path));
      const counts = toolMetric(`+${change.added} −${change.removed}`);
      if (change.approximate) counts.append(t(" (approx.)"));
      li.append(counts);
      changes.append(li);
    }
    raw.append(changes);
  }

  appendText(() => `${t('Arguments')} · ${call.tool}`, call.args.text, call.args.truncated, call.args.chars);
  const images = call.assets?.filter(asset => ['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType)) ?? [];
  const readable = toolResultText(call.result.text, call.result.truncated, images.length > 0);
  if (readable) appendText(() => `${t('Result')} · ${call.tool} · ${Math.round(call.durationMs)} ms`, readable, call.result.truncated && images.length === 0, call.result.chars);
  // Older recordings did not retain the reason an image asset was omitted. Explain
  // the missing local preview without inferring a historical provider receipt.
  if (call.tool === 'view_image' && call.outcome === 'ok' && images.length === 0) {
    raw.append(el('p', 'meta', () => t("No image preview was retained in this recording.")));
  }
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
        if (!data) { attachments.append(el('p', 'meta', () => t("Image unavailable"))); continue; }
        const image = document.createElement('img');
        image.src = data; image.alt = t("{0} result", [call.tool]); image.loading = 'lazy';
        image.style.cssText = 'display:block;max-width:100%;max-height:600px;object-fit:contain;margin:8px 0';
        attachments.append(image);
      }
    };
    box.addEventListener('toggle', () => void load());
    raw.append(attachments);
    void load();
  }
  if (call.result.assetId) raw.append(el('p', 'raw-facts', () => t("Full recorded response: {0}", [call.result.assetId])));

  for (const asset of call.assets ?? []) {
    raw.append(el('p', 'raw-facts', () => t("asset {0} · {1} · {2} bytes", [asset.id, asset.mimeType, compactNumber(asset.bytes)])));
  }

  box.append(raw);
}

function hasLaterModelActivity(time: number): boolean {
  return events.some(event => event.time > time && ['assistant_message', 'native_image', 'tool_call', 'page_tool', 'agent_message'].includes(event.kind));
}

function paintInputReceipt(row: HTMLElement, item: ReturnType<typeof timelineItems>[number]): void {
  if (item.kind !== 'event' || item.event.kind !== 'user_message') return;
  const receipt = row.querySelector<HTMLElement>('.input-receipt');
  if (!receipt) return;
  receipt.hidden = hasLaterModelActivity(item.event.time);
  receipt.parentElement?.classList.toggle('has-input-receipt', !receipt.hidden);
}

/** The exact outbox input retains preview bytes until optional history storage succeeds. */
function retainedInputImages(event: Extract<SessionEvent, { kind: 'user_message' }>, sessionId: string | null): InputImage[] {
  if (!sessionId || !event.inputId) return [];
  const root = pendingComposerInputs.find(entry => entry.id === event.inputId &&
    (entry.sessionId ?? entry.deliveredSessionId) === sessionId &&
    (entry.messageId ? entry.messageId === event.messageId : event.messageId === `input:${entry.id}`));
  if (!root) return [];
  const companion = root.companionInputId ? pendingComposerInputs.find(entry => entry.id === root.companionInputId &&
    (entry.sessionId ?? entry.deliveredSessionId) === sessionId && entry.messageId === root.messageId) : undefined;
  // Match combinedInput's canonical image order for asset-index fallback.
  return [...root.images ?? [], ...companion?.images ?? [], ...root.toolImages ?? []].slice(0, MAX_INPUT_IMAGES);
}

function paintMessageReaction(box: HTMLElement, value: unknown): void {
  const reaction = messageReaction(value);
  const existing = box.querySelector<HTMLElement>('.message-reaction');
  if (!reaction) { existing?.remove(); return; }
  if (existing?.textContent === reaction) return;
  const badge = existing ?? el('span', 'message-reaction');
  badge.textContent = reaction;
  badge.setAttribute('role', 'img');
  ui(badge, 'aria-label', () => t("ChatGPT reacted with {0}", [reaction]));
  if (!existing) box.append(badge);
}

function eventBody(event: SessionEvent, context?: { id: string; current: () => boolean; history: readonly SessionEvent[] }): HTMLElement {
  switch (event.kind) {
    case 'session_start':
      return el('p', 'meta', () => t("Session started — {0}", [event.title]));
    case 'user_message': {
      const box = el('div', 'said is-user');
      box.classList.add('has-reaction-slot');
      box.append(el('b', '', () => t("You")));
      const attachments = el('div', 'message-attachments');
      if (event.attachments?.length) attachments.append(...event.attachments.map(file => attachmentCard(file)));
      const assets = event.assets?.filter(asset => asset.mimeType === 'image/webp').slice(0, MAX_INPUT_IMAGES) ?? [];
      const retained = retainedInputImages(event, context?.id ?? selectedId);
      const preview = (data: string, retainedOnly = false, slot?: HTMLElement) => {
        const image = document.createElement('img');
        image.src = data; image.alt = t("User attachment"); image.loading = 'lazy';
        const frame = slot ?? el('div', 'user-image-slot');
        frame.replaceChildren(image);
        if (!slot) attachments.append(frame);
        if (retainedOnly) {
          const notice = el('span', 'retained-image-notice', () => t("Not saved to history"));
          ui(notice, 'title', () => t("Image preview retained with this delivery; not yet saved to history."));
          frame.append(notice);
        }
      };
      // History selection measures the viewport before IPC completes. Reserve each saved
      // image's final footprint now; loading, pixels and failure all occupy the same slot.
      const slots = assets.map(() => {
        const slot = el('div', 'user-image-slot');
        slot.append(el('span', 'meta', () => t("Image preview is loading")));
        attachments.append(slot);
        return slot;
      });
      if (event.attachments?.length || assets.length || retained.length) box.append(attachments);
      if (!assets.length) for (const image of retained) preview(image.dataUrl, true);
      // Native ChatGPT can prepend a blank paragraph. Ignore it only when a
      // complete instruction frame validates; keep the authored suffix exact.
      const userText = event.authoredText ?? userPromptText(event.message.text.trimStart()) ?? event.message.text;
      if (userText) box.append(textBlock('msg user-message-text', userText, event.authoredText === undefined && event.message.truncated, event.authoredText?.length ?? event.message.chars));
      paintMessageReaction(box, event.reaction);
      if (event.inputDelivery) {
        box.classList.add('has-input-receipt');
        const receipt = el('span', 'input-receipt');
        const label = event.inputDelivery === 'offered' ? t("Sent to the active turn · awaiting receipt") : t("Delivery confirmed");
        receipt.title = label; receipt.setAttribute('aria-label', label);
        receipt.append(icon(event.inputDelivery === 'offered' ? 'i-clock' : 'i-check'));
        box.append(receipt);
      }
      if (assets.length && (context?.id || selectedId)) {
        const id = context?.id ?? selectedId!, generation = selectionGeneration;
        void (async () => {
          for (const [index, asset] of assets.entries()) {
            const data = await run(api.getSessionImage(id, asset.id));
            if (context ? !context.current() : id !== selectedId || generation !== selectionGeneration) return;
            const slot = slots[index]!;
            if (data) preview(data, false, slot);
            else if (retained[index]) preview(retained[index]!.dataUrl, true, slot);
            else slot.replaceChildren(el('span', 'meta', () => t("Image unavailable")));
          }
        })();
      }
      return box;
    }
    case 'assistant_message': {
      const box = el('div', 'said');
      box.append(el('b', '', () => event.final ? 'ChatGPT' : t("ChatGPT (partial)")));
      box.append(renderedMarkdown(event.message.text, event.renderedHtml, event.references));
      return box;
    }
    case 'native_image': {
      const box = el('div', 'said native-image');
      box.append(el('b', '', () => t("ChatGPT generated image")));
      const frame = el('div', 'generated-image-frame');
      const width = event.width ?? event.previewWidth ?? 1;
      const height = event.height ?? event.previewHeight ?? 1;
      frame.style.aspectRatio = `${Math.max(1, width)} / ${Math.max(1, height)}`;
      const unavailable = () => {
        frame.classList.toggle('is-unavailable', event.previewStatus !== 'pending');
        frame.replaceChildren(el('p', 'meta', () => {
        if (event.previewStatus === 'pending') return t("Image preview is loading");
        if (event.previewError === 'removed') return t("Image removed from local storage");
        if (event.previewError === 'quota') return t("Image preview unavailable — recording storage is full");
        if (event.previewError === 'oversized') return t("Image preview unavailable — image exceeds the recording limit");
        return t("Image preview unavailable");
        }));
        if (event.previewStatus !== 'pending') frame.append(imageStorageButton());
      };
      if (event.asset) frame.append(el('p', 'meta', () => t("Image preview is loading")));
      else unavailable();
      box.append(frame);
      const id = context?.id ?? selectedId;
      if (event.asset && id) {
        const generation = selectionGeneration;
        void (async () => {
          const data = await run(api.getSessionImage(id, event.asset!.id));
          if (context ? !context.current() : id !== selectedId || generation !== selectionGeneration) return;
          if (!data) {
            const pane = context ? box.closest<HTMLElement>('.agent-panel-body') : $('chatBody');
            const timeline = context ? pane : $('timelineContent');
            const restore = pane && timeline && box.isConnected ? preserveTimelineViewport(pane, timeline) : () => {};
            unavailable(); restore();
            return;
          }
          const image = document.createElement('img');
          image.src = data;
          image.alt = t("ChatGPT generated image");
          frame.replaceChildren(image);
        })();
      }
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
      return el('p', 'meta', () => event.detail ? t("Turn reopened — {0}", [event.detail]) : t("Turn started"));
    case 'turn_end': {
      const line = el(
        'p',
        event.outcome === 'completed' ? 'meta' : 'meta is-warn',
        () => t("Turn {0}{1}", [t(TURN_OUTCOME_LABELS[event.outcome]), event.detail ? ` — ${event.detail}` : ''])
      );
      return line;
    }
    case 'chat_error': {
      const notice = el('div', 'chat-error-notice');
      notice.setAttribute('role', 'status');
      const presentation = () => chatErrorPresentation(event, context?.history ?? events);
      // The timeline signature includes this projection, so later completion/work repaints it.
      notice.classList.toggle('is-resolved', presentation().resolved);
      notice.classList.toggle('is-reloaded', presentation().reloaded);
      const title = el('strong', '', () => presentation().title);
      notice.append(title, textBlock('msg', presentation().message, event.message.truncated, event.message.chars),
        el('p', 'chat-error-next', () => presentation().next));
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
      ui(box, 'title', () => event.delivery === 'sent'
          ? t("Sent by {0}; recorded when the app accepted it", [event.from])
          : t("Received by {0}; recorded when it acknowledged delivery", [event.to]));
      const summary = el('summary');
      const worker = event.from === 'prime' ? event.to : event.from;
      const avatar = workerAvatar(worker);
      summary.append(avatar, el('span', '', () => communicationTitle(event)));
      const communicationKey = `agent:${context?.id ?? selectedId}:${event.seq}`;
      box.open = openTools.has(communicationKey);
      box.addEventListener('toggle', () => { if (box.open) openTools.add(communicationKey); else openTools.delete(communicationKey); });
      box.append(summary);
      box.append(textBlock('msg', event.message.text, event.message.truncated, event.message.chars));
      if (!context) {
        const matches = sessions.filter(entry => entry.origin?.kind === 'worker' && entry.origin.fromSessionId === selectedId && entry.origin.agentId === worker);
        if (matches.length === 1) {
          const open = el('button', 'btn agent-chat-open'); open.setAttribute('type', 'button');
          ui(open, 'aria-label', () => t("Open {0} chat", [worker]));
          const arrow = icon('i-out'); arrow.setAttribute('aria-hidden', 'true');
          open.append(el('span', '', () => t("Open worker chat")), arrow);
          open.onclick = () => void agentPanel?.open(matches[0]!.id); box.append(open);
        }
      }
      return box;
    }
    case 'handoff':
      return el(
        'p',
        'meta is-good',
        () => t("Handoff saved — {0} characters ({1})", [compactNumber(event.chars), event.reason])
      );
    default:
      return el('p', 'meta', () => t("Unknown event"));
  }
}

/**
 * Copy and Markdown export under the answer of a turn the page reported as completed. Main
 * builds the text from the log, reading back answers that were cut there, so a long answer
 * copies and exports whole; the timeline only decides where the actions appear.
 */
function answerActions(turnId: string): HTMLElement {
  const bar = el('div', 'answer-actions');
  const sessionId = selectedId;
  const exportTo = async (scope: 'answer' | 'session', target: 'clipboard' | 'file') => {
    if (!sessionId || selectedId !== sessionId) return null;
    return run(api.exportMarkdown({ id: sessionId, scope, turnId: scope === 'answer' ? turnId : undefined, target }));
  };
  const copy = el('button', 'answer-action') as HTMLButtonElement;
  copy.type = 'button';
  const copyGlyph = icon('i-copy');
  copy.append(copyGlyph);
  ui(copy, 'title', () => t('Copy answer')); ui(copy, 'aria-label', () => t('Copy answer'));
  let copiedTimer: number | undefined;
  copy.addEventListener('click', async () => {
    const result = await exportTo('answer', 'clipboard');
    if (result?.done !== 'copied') return;
    setIcon(copyGlyph, 'i-check'); copy.classList.add('is-done');
    window.clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => { setIcon(copyGlyph, 'i-copy'); copy.classList.remove('is-done'); }, 1500);
  });
  const menu = document.createElement('details');
  menu.className = 'answer-export';
  const trigger = el('summary', 'answer-action');
  trigger.append(icon('i-export'));
  ui(trigger, 'title', () => t('Export as Markdown')); ui(trigger, 'aria-label', () => t('Export as Markdown'));
  const choices = el('div', 'answer-export-menu');
  for (const [scope, label] of [['answer', 'This answer'], ['session', 'Whole session']] as const) {
    const choice = el('button', 'answer-export-choice', () => t(label)) as HTMLButtonElement;
    choice.type = 'button';
    choice.addEventListener('click', async () => {
      menu.open = false;
      const result = await exportTo(scope, 'file');
      if (result?.done === 'saved') toast(t('Saved {0}', [result.name]));
    });
    choices.append(choice);
  }
  menu.append(trigger, choices);
  const close = (event: Event) => { if (menu.open && !menu.contains(event.target as Node)) menu.open = false; };
  menu.addEventListener('toggle', () => {
    if (menu.open) document.addEventListener('pointerdown', close, true);
    else document.removeEventListener('pointerdown', close, true);
  });
  menu.addEventListener('keydown', event => { if (event.key === 'Escape') { menu.open = false; trigger.focus(); } });
  bar.append(copy, menu);
  return bar;
}

function eventRow(event: SessionEvent): HTMLElement {
  const row = el('div', `ev ev-${event.kind}`);
  // A note the app filed about its own work (a recovery reload), not ChatGPT's phase caption.
  if (event.kind === 'progress' && event.source === 'app') row.dataset.appNote = '';
  if (event.kind === 'assistant_message' && !withoutMessageReaction(event.message.text).trim()) row.hidden = true;
  tagImageRow(row, event);
  const time = document.createElement('time');
  time.textContent = clockTime(event.time);
  time.title = new Date(event.time).toLocaleString(currentLanguage());
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
        () => t("From a chat that Compact & Resume had already replaced — ChatGPT kept running its stopped turn there. Refused by design; nothing to repair.")
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
  buttons.push(chip(null, t("All")));
  for (const agent of named) buttons.push(chip(agent, agent));
  if (anyUnattributed) buttons.push(chip(UNATTRIBUTED, t("Unattributed")));
  box.replaceChildren(...buttons);
  box.hidden = false;
}

function visibleEvents(): SessionEvent[] {
  if (agentFilter === null) return events;
  if (agentFilter === UNATTRIBUTED) return events.filter((event) => !event.agent);
  return events.filter((event) => event.agent === agentFilter);
}

/** Eviction follows the measured reader viewport, not an arbitrary half-page.
 * Keep the current visible rows plus the incoming stage; ordinary tall histories
 * still settle at 160 records. Dense collapsed activity has bounded extra room. */
function retainTimelinePage(source: SessionEvent[], direction: 'older' | 'newer'): SessionEvent[] {
  // Residency and navigation share the immutable origin domain. Display order
  // can move a final across its turn's tools, but must not cut a hole in a page.
  source = [...source].sort((a, b) => positionOf(a) - positionOf(b));
  const pane = $('chatBody');
  const edge = pane.getBoundingClientRect().top;
  const protectedKeys = new Set<string>();
  for (const row of $('timeline').querySelectorAll<HTMLElement>('[data-timeline-key]')) {
    const rect = row.getBoundingClientRect();
    if (rect.height <= 0 || rect.bottom <= edge - pane.clientHeight) continue;
    if (rect.top >= edge + 2 * pane.clientHeight) break;
    protectedKeys.add(row.dataset.timelineKey!);
    if (row.matches('.tool-group:not([open])')) {
      for (const child of row.querySelectorAll<HTMLElement>('[data-timeline-key]')) protectedKeys.add(child.dataset.timelineKey!);
    }
  }
  const protectedSeqs = new Set<number>();
  for (const item of timelineItems(source)) {
    if (item.kind !== 'compaction' || !protectedKeys.has(itemKey(item))) continue;
    const block = item.block;
    protectedSeqs.add(block.seq);
    for (const event of [block.prompt, block.brief, block.end, block.handoff, block.resume, ...block.notes]) {
      if (event) protectedSeqs.add(event.seq);
    }
  }
  const protectedIndexes = source.flatMap((event, index) => protectedSeqs.has(event.seq) || protectedKeys.has(itemKey({ kind: 'event', event })) ? [index] : []);
  const first = protectedIndexes[0] ?? source.length;
  const last = protectedIndexes.at(-1) ?? -1;
  if (direction === 'older') {
    const end = Math.min(source.length, Math.max(MAX_TIMELINE_ROWS, last + 1));
    return chronological(source.slice(0, end));
  }
  const start = Math.max(0, Math.min(source.length - MAX_TIMELINE_ROWS, first));
  return chronological(source.slice(start));
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
  end: Extract<SessionEvent, { kind: 'turn_end' }> | null;
  handoff: Extract<SessionEvent, { kind: 'handoff' }> | null;
  resume: Extract<SessionEvent, { kind: 'user_message' }> | null;
  /** What the app said about this compaction, newest last — an abandonment and why. */
  notes: Array<Extract<SessionEvent, { kind: 'note' }>>;
}

type TimelineItem = { kind: 'event'; event: SessionEvent } | { kind: 'compaction'; block: CompactionBlock };

function continuationMarker(event: SessionEvent): { kind: 'HANDOFF' | 'RESUME'; token: string } | null {
  if (event.kind !== 'user_message') return null;
  const match = continuationMarkerOf(event.message.text);
  return match ? { kind: match.kind, token: match.token } : null;
}

/**
 * The timeline with each compaction folded into one item.
 *
 * A card opens at the marked brief request and absorbs what belongs to it: the turn
 * that answers it, the answer (the brief), the app's
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
        end: null,
        handoff: null,
        resume: null,
        notes: []
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
        if (open.turnId && event.turnId && event.turnId !== open.turnId) {
          items.push({ kind: 'event', event });
          continue;
        }
        open.brief = event;
        if (event.turnId !== undefined) open.turnId = event.turnId;
        continue;
      }
      if (event.kind === 'turn_start' && !open.brief && !open.handoff && !open.end) {
        open.turnId = event.turnId ?? null;
        continue;
      }
      const sameTurn = open.turnId !== null && event.turnId === open.turnId;
      if (sameTurn && (event.kind === 'turn_end' || event.kind === 'progress' || event.kind === 'page_tool')) {
        if (event.kind === 'turn_end') open.end = event;
        continue;
      }
      // Local calls can finish or be refused after the source request. They remain
      // ordinary visible rows and cannot close the summary's grouping or decide its fate.
      // Only another authored user message starts an unrelated conversation step.
      if (event.kind === 'user_message') open = null;
    }
    items.push({ kind: 'event', event });
  }
  return items;
}

type CompactionTone = 'good' | 'wait' | 'bad';

const ABANDONED_NOTE = /^Compact & Resume abandoned\s*[\u2014-]\s*/i;

/**
 * One sentence for where the compaction is, or where it died.
 *
 * Success and failure come from the recorded continuation, never from later activity
 * in this timeline. Refused source calls are compatible with a still-running handoff.
 */
function compactionState(block: CompactionBlock): { text: string; tone: CompactionTone } {
  const chars = block.handoff ? t(" ({0} characters)", [compactNumber(block.handoff.chars)]) : '';
  if (block.resume) return { text: t("New chat opened at {0}{1}", [clockTime(block.resume.time), chars]), tone: 'good' };
  const abandoned = [...block.notes].reverse().find((note) => ABANDONED_NOTE.test(note.message.text));
  if (abandoned) return { text: t("Failed — {0}", [abandoned.message.text.replace(ABANDONED_NOTE, '')]), tone: 'bad' };
  if (block.handoff) {
    return { text: t("Summary saved{0} — opening the new chat…", [chars]), tone: 'wait' };
  }
  if (block.end && block.end.outcome !== 'completed') {
    const status = block.end.outcome === 'stopped' ? t("Summary generation stopped")
      : block.end.outcome === 'failed' ? t("Summary generation failed")
      : t("Summary generation ended without a completed handoff");
    return { text: block.end.detail ? t("{0} — {1}", [status, block.end.detail]) : status, tone: 'bad' };
  }
  if (block.brief?.final) {
    return { text: t("Summary written — saving the handoff…"), tone: 'wait' };
  }
  if (block.brief) return { text: t("ChatGPT is writing the summary…"), tone: 'wait' };
  return { text: t("Summary requested — waiting for ChatGPT…"), tone: 'wait' };
}

function compactionRow(block: CompactionBlock, previous?: HTMLElement): HTMLElement {
  const key = `compaction:${block.token}`;
  const state = compactionState(block);

  const row = previous ?? el('div', 'ev ev-compaction');
  const box = previous?.querySelector<HTMLDetailsElement>('details.compaction') ?? document.createElement('details');
  box.className = `tool compaction tone-${state.tone}`;
  if (!previous) {
    box.open = openTools.has(key);
    box.addEventListener('toggle', () => {
      if (box.open) openTools.add(key);
      else openTools.delete(key);
    });
  }

  if (!previous) {
    const head = document.createElement('summary');
    head.append(icon('i-steps', 'ico tool-ico'));
    head.append(el('b', '', () => t("Compact & Resume:")));
    head.append(el('span', 'state'));
    box.append(head);
  }
  ui(box.querySelector<HTMLElement>('summary .state')!, 'textContent', () => compactionState(block).text);

  const raw = el('div', 'raw');
  if (block.prompt) {
    raw.append(el('h4', '', () => t("Brief request")));
    // The routing marker is the app's, not the user's; the card already says what this is.
    const prompt = userPromptText(block.prompt.message.text) ?? block.prompt.message.text;
    // The marker is stripped in whichever form the page recorded it; `marker` is the exact
    // text that matched, so an escaped one is removed as completely as a clean one.
    const request = prompt.replace(continuationMarkerOf(prompt)?.marker ?? '', '');
    raw.append(textBlock('pre', request, block.prompt.message.truncated, block.prompt.message.chars));
  }
  if (block.brief) {
    const brief = block.brief;
    raw.append(el('h4', '', () => brief.final ? t("Summary") : t("Summary (still writing)")));
    raw.append(renderedMarkdown(block.brief.message.text));
  }
  if (block.handoff) {
    const saved = block.handoff;
    raw.append(
      el('p', 'raw-facts', () => t("Handoff saved — {0} characters ({1})", [compactNumber(saved.chars), saved.reason]))
    );
  }
  if (block.resume) {
    const resumed = block.resume;
    raw.append(
      el(
        'p',
        'raw-facts',
        () => t("Bootstrap sent into the new chat — {0} characters at {1}", [compactNumber(resumed.message.chars), clockTime(resumed.time)])
      )
    );
  }
  for (const note of block.notes) raw.append(el('p', 'raw-facts', `${clockTime(note.time)} — ${note.message.text}`));
  const oldRaw = box.querySelector<HTMLElement>('.raw');
  if (oldRaw) {
    // Streaming changes only the affected section. Keep the disclosure, focus and
    // unchanged request mounted instead of replacing the whole reading surface.
    const oldParts = [...oldRaw.children];
    reconcileChildren(oldRaw, [...raw.children].map((part, index) =>
      (oldParts[index]?.isEqualNode(part) ? oldParts[index] : part) as HTMLElement));
  } else box.append(raw);

  if (previous) return row;
  const time = document.createElement('time');
  time.textContent = clockTime(block.time);
  time.title = new Date(block.time).toLocaleString(currentLanguage());
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
      block.end ? `${block.end.seq}:${block.end.outcome}:${block.end.detail ?? ''}` : '',
      block.handoff?.seq ?? '',
      block.resume?.seq ?? '',
      block.notes.map((note) => note.seq).join(',')
    ].join('|');
  }
  const { event } = item;
  const parts: Array<string | number> = [event.kind === 'user_message' ? '' : event.seq, event.time, event.kind, event.agent ?? ''];
  switch (event.kind) {
    case 'user_message': {
      // A badge-only revision patches the existing bubble, preserving loaded images
      // and selection. Every other recorded field still invalidates its body.
      const { seq: _seq, reaction: _reaction, ...body } = event;
      parts.push(JSON.stringify(body));
      // Bytes are immutable for an accepted input. Queue arrival must repaint a
      // canonical row even if its recorded revision did not change.
      parts.push(...retainedInputImages(event, selectedId).map(image => `${image.name}:${image.dataUrl.length}`));
      break;
    }
    case 'progress':
    case 'chat_error':
    case 'note':
    case 'agent_message':
      parts.push(event.message.chars);
      break;
    case 'assistant_message':
      parts.push(event.message.chars, event.renderedHtml?.chars ?? 0, event.state ?? '', event.final ? 'final' : '');
      break;
    case 'native_image':
      parts.push(event.messageId, event.providerAssetId, event.providerStatus ?? '', event.previewStatus, event.asset?.id ?? '',
        event.previewWidth ?? '', event.previewHeight ?? '', event.previewError ?? '');
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
  if (item.kind === 'compaction') return `compaction:${item.block.token}`;
  if (item.event.kind === 'user_message' && item.event.inputId) return `input:${item.event.inputId}`;
  // A canonical revision advances the update cursor, not the identity of the row
  // anchoring the viewport and the following activity disclosure.
  const message = canonicalMessageKey(item.event);
  return message ? `message:${message}` : `event:${item.event.seq}`;
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
/** Fold presentation noise without merging or dropping any recorded call. */
function foldRoutineActivity(rows: HTMLElement[]): HTMLElement[] {
  const result: HTMLElement[] = [];
  const retained = new Set<HTMLDetailsElement>();
  const routineTitle = (row: HTMLElement) => row.querySelector('.tool[data-outcome="ok"] > summary b')?.textContent ?? '';
  for (let i = 0; i < rows.length;) {
    const title = routineTitle(rows[i]!);
    if (title !== 'Checked agent status' && !title.startsWith('Waited on session ')) {
      result.push(rows[i++]!); continue;
    }
    let end = i + 1;
    while (end < rows.length && routineTitle(rows[end]!) === title) end++;
    if (end - i < 5) { result.push(...rows.slice(i, end)); i = end; continue; }
    const members = rows.slice(i, end);
    const previous = members.map(row => row.closest<HTMLDetailsElement>('.routine-activity'))
      .find((fold): fold is HTMLDetailsElement => !!fold && !retained.has(fold));
    const fold = previous ?? document.createElement('details');
    retained.add(fold);
    if (!previous) {
      fold.className = 'routine-activity';
      fold.open = openTools.has(`routine:${members[0]!.dataset.timelineKey}`);
      fold.addEventListener('toggle', () => {
        const key = `routine:${fold.dataset.firstKey}`;
        if (fold.open) openTools.add(key); else openTools.delete(key);
      });
      fold.append(el('summary'), el('div', 'routine-activity-body'));
    }
    fold.dataset.firstKey = members[0]!.dataset.timelineKey;
    fold.querySelector('summary')!.replaceChildren(
      el('span', 'routine-symbol', '↺'),
      el('span', 'activity-title', title),
      el('span', 'routine-count', `×${members.length}`)
    );
    reconcileChildren(fold.lastElementChild!, members);
    result.push(fold); i = end;
  }
  return result;
}
function groupToolRows(rows: HTMLElement[], scope = selectedId, groups = toolGroups): HTMLElement[] {
  const grouped: HTMLElement[] = [], retained = new Set<string>();
  for (let i = 0; i < rows.length;) {
    if (!rows[i]!.matches('.ev-tool_call, .ev-page_tool, .ev-agent_message')) { grouped.push(rows[i++]!); continue; }
    let end = i + 1;
    while (end < rows.length && rows[end]!.matches('.ev-tool_call, .ev-page_tool, .ev-agent_message') && rows[end]!.dataset.activityBoundary === rows[i]!.dataset.activityBoundary) end++;
    if (end - i === 1) { markNativeStep(rows[i]!, false); grouped.push(rows[i++]!); continue; }
    // Paging can extend or trim the beginning of an activity group. Its first
    // member is therefore not a new disclosure/viewport identity.
    const previous = rows.slice(i, end).map(row => row.closest<HTMLElement>('.tool-group'))
      .find(group => group?.dataset.timelineKey && groups.get(group.dataset.timelineKey) === group && !retained.has(group.dataset.timelineKey));
    const key = previous?.dataset.timelineKey ?? `group:${scope}:${rows[i]!.dataset.timelineKey}`;
    retained.add(key);
    let group = groups.get(key);
    if (!group) {
      group = document.createElement('details'); group.className = 'tool-group';
      group.dataset.timelineKey = key;
      const summary = document.createElement('summary');
      summary.append(el('span', 'activity-symbol'), el('span', 'activity-title'), disclosureChevron('ico activity-chevron'));
      group.append(summary, el('div', 'tool-group-body'));
      group.addEventListener('toggle', () => { if (group!.open) openTools.add(key); else openTools.delete(key); });
      group.open = openTools.has(key) || rows.slice(i, end).some((row) => row.querySelector('details[open]')); groups.set(key, group);
    }
    // Name the group after ChatGPT's recap of the round ("Inspected downloads and updated the plan"):
    // ChatGPT closes each round of work with one, and titles the block with it. The recap is picked
    // by position, never by wording, so it holds in any language of the page: the native step that
    // ends a finished round (prose follows it, or the turn is over). It then heads the group instead
    // of repeating inside it. A step that ends a round still in progress is a note, and a group
    // without a recap is named after its latest real action ("Ran npm test").
    const members = rows.slice(i, end);
    const finished = end < rows.length ? rows[end] !== turnNow : !(groups === toolGroups && turnWorking);
    const last = members[members.length - 1]!;
    const recap = finished && last.matches('.ev-page_tool') ? last : undefined;
    // A native step written after this app's calls in the same round is about that work and is
    // marked done, unless it ends a round still in progress; one before any call (a web search
    // between paragraphs) keeps the globe.
    let afterCall = false;
    for (const member of members) {
      if (member.matches('.ev-page_tool')) markNativeStep(member, afterCall && (finished || member !== last));
      else afterCall = true;
    }
    const latest = recap ?? [...members].reverse().find(row => row.matches('.ev-tool_call, .ev-agent_message')) ?? rows[end - 1]!;
    const latestHead = latest.querySelector('.tool > summary, .agent-communication > summary, .thinking-line');
    // Only ChatGPT's own caption names the phase; the app's recovery notes never title a group.
    const observedPhase = rows[i - 1]?.matches('.ev-progress:not([data-app-note])')
      ? rows[i - 1]!.querySelector('.is-progress')?.textContent?.trim() : '';
    const label = observedPhase || latestHead?.querySelector('b')?.textContent
      || latestHead?.querySelector('span:not(.agent-avatar)')?.textContent || t("Activity");
    group.classList.toggle('has-activity-phase', !!observedPhase);
    group.querySelector('.activity-title')!.textContent = label;
    const listed = members.filter(row => row !== recap || observedPhase);
    ui(group.querySelector('summary')!, 'title', () => t("{0} actions · {1}", [listed.length, label]));
    const symbol = latestHead?.querySelector('.ico, .agent-avatar');
    group.querySelector('.activity-symbol')!.replaceChildren(...(symbol ? [symbol.cloneNode(true)] : []));
    if (groups === toolGroups) {
      const ids = [...new Set(members.flatMap(row => JSON.parse(row.dataset.workerSessions ?? '[]') as string[]))];
      group.dataset.workerSessions = JSON.stringify(ids);
      const links = group.querySelector<HTMLButtonElement>(':scope > summary > .activity-workers');
      if (ids.length) {
        const workers = roundWorkers(ids, links ?? undefined);
        if (!links) group.querySelector('summary')!.insertBefore(workers, group.querySelector('.activity-chevron'));
      } else links?.remove();
    }
    reconcileChildren(group.lastElementChild!, foldRoutineActivity(listed));
    grouped.push(group); i = end;
  }
  for (const key of groups.keys()) if (!retained.has(key)) groups.delete(key);
  return grouped;
}

/** The icon of a native ChatGPT step: a check once it follows this app's calls in its round, else the globe. */
function markNativeStep(row: HTMLElement, done: boolean): void {
  const line = row.querySelector<HTMLElement>('.thinking-line');
  const name = done ? 'i-check-circle' : 'i-globe';
  if (!line || (line.dataset.icon ?? 'i-globe') === name) return;
  line.dataset.icon = name;
  line.querySelector('.ico')?.replaceWith(icon(name, 'ico thinking-ico'));
}

/** Adjacent images from one response share a compact gallery, retaining canonical rows. */
function tagImageRow(row: HTMLElement, event: SessionEvent): void {
  if (event.kind !== 'native_image') return;
  row.dataset.imageAgent = event.agent ?? '';
  row.dataset.imageMessage = event.messageId;
  row.dataset.imageTurn = event.turnId ?? '';
}
function groupImageRows(rows: HTMLElement[]): HTMLElement[] {
  const result: HTMLElement[] = [];
  for (let i = 0; i < rows.length;) {
    const first = rows[i]!;
    if (!first.dataset.imageMessage) { result.push(first); i++; continue; }
    const messages = new Set([first.dataset.imageMessage]);
    const turns = new Set(first.dataset.imageTurn ? [first.dataset.imageTurn] : []);
    let end = i + 1;
    while (end < rows.length) {
      const next = rows[end]!.dataset;
      if (!next.imageMessage || next.imageAgent !== first.dataset.imageAgent) break;
      if (!messages.has(next.imageMessage) && !(next.imageTurn && turns.has(next.imageTurn))) break;
      messages.add(next.imageMessage);
      if (next.imageTurn) turns.add(next.imageTurn);
      end++;
    }
    const gallery = rows.slice(i, end).map(row => row.closest<HTMLElement>('.generated-image-gallery'))
      .find((node): node is HTMLElement => !!node) ?? el('div', 'generated-image-gallery');
    reconcileChildren(gallery, rows.slice(i, end));
    result.push(gallery); i = end;
  }
  return result;
}

function composerSessionSelection(summary: SessionSummary | null | undefined) {
  if (summary?.conversationId) return summary.selectedModel;
  const opening = pendingComposerInputs.find(row => row.opening && row.sessionId === summary?.id && ['queued', 'browser'].includes(row.state));
  return opening?.model ? { model: opening.model, reasoningEffort: opening.reasoningEffort ?? undefined, observedAt: opening.createdAt } : null;
}
function paintDetail(followBottom = historyBefore === null): void {
  paintStateLine();
  paintBackgroundProcesses();
  const summary = sessions.find((s) => s.id === selectedId) ?? null;
  applyComposerSessionModel(selectedId ? `${selectedId}:${selectionGeneration}` : null, composerSessionSelection(summary) ?? null);
  const config = deps.state()?.config;
  if (config) paintContextMeter(summary, config, confirmedComposerModel());
  const project = selectedLocalProject();
  $('chatProjectContext').hidden = !project;
  $('chatProjectName').textContent = project?.name ?? '';
  ui($('chatTitle'), 'textContent', () => summary ? summary.title || t("Untitled session") : t("New chat"));

  paintDeliveryControls();
  paintAgentFilter();
  // Selection retires data/control ownership immediately, but the last painted rows
  // remain inert until the destination arrives. Queue/status repaints must not turn
  // this short loading interval into the New Chat welcome screen.
  if (selectedId !== null && detailFor !== selectedId) {
    $('inputQueue').setAttribute('inert', '');
    $('timelineEmpty').hidden = true;
    $('chatFoot').hidden = true;
    return;
  }
  $('timeline').removeAttribute('inert');
  $('timeline').removeAttribute('aria-busy');
  $('inputQueue').removeAttribute('inert');
  const filtered = visibleEvents();
  // Residency has already preserved the reader. Do not truncate that retained
  // page again by hidden tool-output bytes or a second count-only limit.
  const shown = foldAgentCommunication(filtered);

  // Preserve the visible logical row when late transcript revisions change the
  // height above it; retaining absolute scrollTop would move the reader's content.
  const pane = $('chatBody');
  // Released by the reader, the reserve still fills the view to its bottom; that is a reading
  // position, not the end to follow.
  const restoreViewport = preserveTimelineViewport(pane, $('timelineContent'), followBottom && !readingAfterSend,
    followOutput() ? readerAtEnd : undefined);
  const timelineRows: HTMLElement[] = [];
  const keep = new Set<string>();
  let activityBoundary = '';
  paintRecoveryStatus();
  const oldest = shown.length ? Math.min(...shown.map(event => event.time)) : 0;
  const newest = shown.length ? Math.max(...shown.map(event => event.time)) : 0;
  const retiredInputs = pendingComposerInputs.filter(entry => historicalAutomaticInput(entry) &&
    (entry.sessionId ?? entry.deliveredSessionId) === selectedId && !dismissedInputNotices.has(entry.id) &&
    agentFilter === null && entry.createdAt >= oldest && (historyBefore === null || entry.createdAt <= newest))
    .sort((a, b) => a.createdAt - b.createdAt);
  const appendRetiredInputs = (until: number) => {
    while (retiredInputs.length && retiredInputs[0]!.createdAt <= until) {
      const entry = retiredInputs.shift()!;
      const key = `retired-input:${entry.id}`;
      const sig = JSON.stringify([entry.text, entry.error, entry.createdAt]);
      keep.add(key);
      const cached = rowCache.get(key);
      const row = cached?.sig === sig ? cached.row : inputMessageRow(entry, true);
      if (row !== cached?.row) {
        const time = document.createElement('time');
        time.textContent = new Date(entry.createdAt).toLocaleString(currentLanguage());
        row.prepend(time);
      }
      row.dataset.timelineKey = key;
      rowCache.set(key, { sig, row });
      timelineRows.push(row);
      activityBoundary = key;
    }
  };
  const duplicateErrors = duplicateChatErrors(events);
  // Completed turns and the answer message that carries their copy/export actions.
  const anchors = answerAnchors(events);
  const workedSeconds = exchangeDurations(events);
  const workers = sessions.filter(entry => entry.origin?.kind === 'worker' && entry.origin.fromSessionId === selectedId && selectedId !== null);
  for (const item of timelineItems(shown)) {
    if (item.kind === 'event' && duplicateErrors.has(item.event.seq)) continue;
    appendRetiredInputs(item.kind === 'event' ? item.event.time : item.block.time);
    if (item.kind === 'compaction' || !['tool_call', 'page_tool', 'agent_message'].includes(item.event.kind)) activityBoundary = itemKey(item);
    if (!deps.state()?.config.ui.developerMode && item.kind === 'event' && item.event.source === 'app' && item.event.kind === 'progress' && item.event.progressId?.startsWith('browser-repair:')) continue;
    if (!deps.state()?.config.ui.developerMode && item.kind === 'event' && ['session_start', 'session_end', 'turn_start', 'turn_end', 'note'].includes(item.event.kind)) continue;
    const key = itemKey(item);
    const answerTurn = item.kind === 'event' && item.event.kind === 'assistant_message' && item.event.turnId &&
      anchors.get(item.event.turnId) === item.event.seq ? item.event.turnId : null;
    const sig = itemSignature(item) + (item.kind === 'event' && item.event.kind === 'chat_error'
      ? JSON.stringify(chatErrorPresentation(item.event, events)) : '') + (answerTurn ? '\u0000answer' : '');
    keep.add(key);
    const cached = rowCache.get(key);
    const workerIds = JSON.stringify(item.kind === 'event' ? participatingWorkers(item.event, workers).map(worker => worker.id) : []);
    if (cached && cached.sig === sig) {
      cached.row.dataset.workerSessions = workerIds;
      cached.row.dataset.activityBoundary = activityBoundary;
      if (item.kind === 'event' && item.event.kind === 'user_message') cached.row.dataset.askedAt = String(item.event.time);
      if (item.kind === 'event' && item.event.kind === 'user_message') {
        paintMessageReaction(cached.row.querySelector<HTMLElement>('.said.is-user')!, item.event.reaction);
      }
      paintInputReceipt(cached.row, item);
      timelineRows.push(cached.row);
      continue;
    }
    const row = item.kind === 'compaction' ? compactionRow(item.block, cached?.row) : eventRow(item.event);
    if (answerTurn) row.querySelector('.said')?.append(answerActions(answerTurn));
    row.dataset.timelineKey = key;
    row.dataset.workerSessions = workerIds;
    if (item.kind === 'event' && item.event.kind === 'user_message') row.dataset.askedAt = String(item.event.time);
    row.dataset.activityBoundary = activityBoundary;
    paintInputReceipt(row, item);
    rowCache.set(key, { sig, row });
    timelineRows.push(row);
  }
  appendRetiredInputs(Infinity);
  for (const key of rowCache.keys()) if (!keep.has(key)) rowCache.delete(key);
  placeTurnLines(timelineRows, workedSeconds);
  reconcileChildren($('timeline'), groupImageRows(groupToolRows(timelineRows)));
  paintPendingInputs();
  $('timelineEmpty').hidden = selectedId !== null || timelineRows.length > 0 || $('inputQueue').childElementCount > 0;
  if (!holdSentMessage()) restoreViewport();
  paintJumpLatest();

  const facts: string[] = [];
  if (summary) {
    facts.push(t(totalEvents === 1 ? '{0} event' : '{0} events', [totalEvents]));
    if (events.length < totalEvents) facts.push(t("showing a bounded page of {0}", [events.length]));
    if (agentFilter !== null) {
      facts.push(t("filtered to {0} — {1} matched", [agentFilter === UNATTRIBUTED ? 'unattributed' : agentFilter, filtered.length]));
    }
    facts.push(t("~{0} rough current-chat context tokens", [compactNumber(summary.contextTokens)]));
    const level = pressureOf(summary.id);
    if (level && level.level !== 'ok') {
      facts.push(
        level.level === 'huge'
          ? t("past the compaction threshold — compact before continuing")
          : t("large — compaction is worth doing soon")
      );
    }
    if (summary.lastTurnOutcome && summary.lastTurnOutcome !== 'completed') {
      facts.push(t("last turn {0}", [t(TURN_OUTCOME_LABELS[summary.lastTurnOutcome])]));
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
    const saved = handoff;
    const parts: HTMLElement[] = [];
    const head = el('p', 'hint');
    ui(head, 'textContent', () => t("{0} characters · from {1} events (~{2} tokens) · {3}", [compactNumber(saved.text.length), saved.sourceEvents, compactNumber(saved.sourceTokens), ago(saved.createdAt)]));
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

/** The live deadline takes precedence over the existing dismissible repair receipt. */
function paintRecoveryStatus(): boolean {
  const host = $('recoveryStatus');
  const countdowns = selectedId && controlledSessionId === selectedId && controlledSelection === selectionGeneration ? controlledRecovery : [];
  const sessionForCountdown = controlledSessionId;
  // #1032: the user may keep a visibly working answer from being reloaded. Main refuses once the
  // browser has claimed the reload, and a later question gets its own again.
  const cancelReload = (countdown: RecoveryCountdown) => countdown.kind === 'assistant-error' && sessionForCountdown
    ? dockAction(() => t("Don't reload this answer"), 'i-x', async () => {
      const cancelled = await run(api.cancelRecovery(sessionForCountdown));
      if (cancelled === false) toast(t('The reload has already started.'));
      await refreshSessionControls();
    })
    : null;
  if (renderRecoveryCountdowns(host, countdowns, Date.now(), cancelReload)) return true;
  const recovery = detailFor === selectedId ? [...events].reverse().find(event => event.source === 'app' && event.kind === 'progress' && event.progressId?.startsWith('browser-repair:')) : undefined;
  const sessionId = selectedId;
  const revision = recovery?.kind === 'progress' ? JSON.stringify([recovery.progressId, recovery.time, recovery.message.text]) : '';
  // Once the next question/turn is recorded, the old reload remains history.
  // Removing the live Continue countdown must not revive its earlier receipt.
  const advanced = recovery && events.some(event => positionOf(event) > positionOf(recovery) &&
    ((event.kind === 'turn_start' && event.turnId !== recovery.turnId) ||
      (event.kind === 'user_message' && event.source === 'extension')));
  host.hidden = !recovery || !!advanced || Date.now() - recovery.time > 120000 || (!!sessionId && dismissedRecoveryNotices.get(sessionId) === revision);
  host.replaceChildren();
  if (host.hidden) return paintRecoveryVerdict(host, sessionId);
  if (!host.hidden && recovery?.kind === 'progress') {
    const row = el('div', 'recovery-notice');
    row.append(icon('i-pulse'), el('span', 'queue-label', recovery.message.text),
      dockAction(() => t('Dismiss recovery notice'), 'i-x', () => {
        if (sessionId) dismissedRecoveryNotices.set(sessionId, revision);
        host.hidden = true; host.replaceChildren();
      }));
    host.append(row);
  }
  return false;
}

/**
 * The app's latest verdict about this chat, kept in view until the chat works again.
 *
 * A stopped chat used to be explained only by a note in its timeline — "this chat stopped",
 * "stopped reloading", "could not restart it automatically: …" — which scrolls away, while the
 * repair line above disappears after two minutes. On 2026-09-26 a prime sat stopped for hours
 * with every reason written somewhere nobody was looking. The newest app note (never a handoff
 * note) stays here until a newer question or turn supersedes it, or it is dismissed.
 */
function paintRecoveryVerdict(host: HTMLElement, sessionId: string | null): boolean {
  const verdict = detailFor === selectedId ? [...events].reverse().find(event => event.source === 'app' && event.kind === 'note' && !event.continuation) : undefined;
  if (verdict?.kind !== 'note') return false;
  const revision = JSON.stringify(['note', verdict.time, verdict.message.text]);
  const superseded = events.some(event => positionOf(event) > positionOf(verdict) &&
    (event.kind === 'turn_start' || (event.kind === 'user_message' && event.source === 'extension')));
  if (superseded || (!!sessionId && dismissedRecoveryNotices.get(sessionId) === revision)) return false;
  const row = el('div', 'recovery-notice');
  row.append(icon('i-pulse'), el('span', 'queue-label', verdict.message.text),
    dockAction(() => t('Dismiss recovery notice'), 'i-x', () => {
      if (sessionId) dismissedRecoveryNotices.set(sessionId, revision);
      host.hidden = true; host.replaceChildren();
    }));
  host.append(row);
  host.hidden = false;
  return false;
}

/**
 * Each turn opens with how long it has worked, as in Codex: "Working for 12s" live on the turn in
 * progress, "Worked for 17s" once the page reports its end. The live line mirrors the status caption
 * (same text, same clock) and the header no longer repeats it; earlier completed turns keep a still
 * line. Nothing folds. A running turn with no row on screen yet (just sent, or a page that reports no
 * turn) shows its line right after your pending message, where the turn will begin, so the line is
 * born in place instead of appearing in the header and moving. A finished turn with no row on screen
 * (an empty chat, a folded Compact & Resume) keeps the caption in the header.
 */
const turnStatusLine = turnLine('turn-worked turn-status');

/*
 * What the turn is doing right now, as the last row of its work, where the next thing will appear,
 * as ChatGPT and Claude show it: the tool call running in this app ("Running npm test", with its own
 * clock once it lasts), else the step ChatGPT's own page names ("Searching the web"), else
 * "Thinking". Streaming prose needs no row; it is the feedback. A call only reaches the list once it
 * has finished, so without this a long command read as an idle chat.
 */
/** Whether the latest turn was working at the last paint; the status line's class is never cleared. */
let turnWorking = false;
const turnNow = el('p', 'meta is-progress thinking-line turn-now');
const turnNowIcon = el('span', 'turn-now-icon');
const turnNowText = el('span', 'turn-now-text');
const turnNowTime = el('span', 'turn-now-time');
const turnNowBody = el('span', 'turn-now-body');
turnNowBody.append(turnNowText, turnNowTime);
turnNow.append(turnNowIcon, turnNowBody);
turnNow.hidden = true;
let runningTools: RunningToolActivity[] = [];
let runningToolsFor: string | null = null;
let runningToolsAt = 0;
let runningToolsEvents = -1;
let runningToolsRequest = 0;
let backgroundProcesses: RunningExecProcess[] = [];
let backgroundProcessesFor: string | null = null;
let backgroundProcessesRequest = 0;
let backgroundProcessClock: number | null = null;
let backgroundProcessStopping: string | null = null;
let backgroundProcessFocusAfterRefresh: { session: string; selection: number } | null = null;
const expandedBackgroundProcessSessions = new Set<string>();

function backgroundProcessKey(row: RunningExecProcess): string {
  return row.processId + ':' + row.incarnation;
}

function backgroundCommand(command: string): string {
  const compact = command.replace(/\s+/g, ' ').trim();
  return compact.length > 120 ? compact.slice(0, 117) + '…' : compact;
}

function backgroundElapsed(startedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function syncBackgroundProcessClock(visible: boolean): void {
  if (visible && backgroundProcessClock === null) {
    backgroundProcessClock = window.setInterval(() => paintBackgroundProcessTimes(), 1_000);
  } else if (!visible && backgroundProcessClock !== null) {
    window.clearInterval(backgroundProcessClock);
    backgroundProcessClock = null;
  }
}

function sortedBackgroundProcesses(): RunningExecProcess[] {
  return backgroundProcessesFor === selectedId
    ? [...backgroundProcesses].sort((a, b) => a.startedAt - b.startedAt)
    : [];
}

function paintBackgroundProcessTimes(): void {
  const rows = sortedBackgroundProcesses();
  if (!selectedId || !rows.length) return;
  const first = rows[0]!;
  const host = $('backgroundExecStatus');
  ui(host.querySelector<HTMLElement>('.background-exec-time')!, 'textContent', () => t('Running for {0}', [backgroundElapsed(first.startedAt)]));
  $('backgroundExecList').querySelectorAll<HTMLElement>('.background-exec-process-time').forEach(time => {
    const startedAt = Number(time.dataset.startedAt);
    if (Number.isFinite(startedAt)) ui(time, 'textContent', () => t('Running for {0}', [backgroundElapsed(startedAt)]));
  });
}

async function stopBackgroundProcess(row: RunningExecProcess, restoreFocus: boolean): Promise<void> {
  if (!selectedId || backgroundProcessStopping !== null) return;
  const session = selectedId;
  if (restoreFocus) backgroundProcessFocusAfterRefresh = { session, selection: selectionGeneration };
  backgroundProcessStopping = backgroundProcessKey(row);
  paintBackgroundProcessStops();
  const reply = await api.stopProcess(session, row.processId, row.incarnation);
  if (session !== selectedId) {
    if (backgroundProcessFocusAfterRefresh?.session === session) backgroundProcessFocusAfterRefresh = null;
    return;
  }
  backgroundProcessStopping = null;
  paintBackgroundProcessStops();
  if (!reply.ok || !reply.data) {
    toast(reply.ok ? t('Background process is no longer running') : reply.error);
    refreshBackgroundProcesses();
    return;
  }
  refreshBackgroundProcesses();
}

function backgroundProcessStopLabel(row: RunningExecProcess): string {
  const command = backgroundCommand(row.command);
  return t('Stop background process') + ': #' + row.processId + (command ? ' ' + command : '');
}

function configureBackgroundProcessStop(stop: HTMLButtonElement, row: RunningExecProcess): void {
  ui(stop, 'title', () => t('Stop background process'));
  ui(stop, 'aria-label', () => backgroundProcessStopLabel(row));
  const label = stop.querySelector<HTMLElement>('span');
  if (label) ui(label, 'textContent', () => t('Stop'));
  stop.disabled = backgroundProcessStopping !== null;
  stop.onclick = event => {
    event.stopPropagation();
    void stopBackgroundProcess(row, event.detail === 0);
  };
}

function paintBackgroundProcessStops(): void {
  const disabled = backgroundProcessStopping !== null;
  $('backgroundExecStatus').querySelectorAll<HTMLButtonElement>('.background-exec-stop').forEach(stop => { stop.disabled = disabled; });
  $('backgroundExecList').querySelectorAll<HTMLButtonElement>('.background-exec-stop').forEach(stop => { stop.disabled = disabled; });
}

function paintBackgroundProcesses(): void {
  const host = $('backgroundExecStatus');
  const liveStatus = $('backgroundExecLiveStatus');
  const list = $('backgroundExecList');
  const rows = sortedBackgroundProcesses();
  if (!selectedId || !rows.length) {
    if (selectedId) expandedBackgroundProcessSessions.delete(selectedId);
    host.hidden = true;
    host.removeAttribute('title');
    host.removeAttribute('aria-expanded');
    host.removeAttribute('aria-controls');
    host.removeAttribute('tabindex');
    host.setAttribute('role', 'status');
    host.classList.remove('is-expandable', 'is-expanded');
    host.onclick = null;
    host.onkeydown = null;
    list.hidden = true;
    list.replaceChildren();
    liveStatus.textContent = '';
    liveStatus.hidden = true;
    syncBackgroundProcessClock(false);
    return;
  }
  const first = rows[0]!;
  const multiple = rows.length > 1;
  if (!multiple) expandedBackgroundProcessSessions.delete(selectedId);
  const expanded = multiple && expandedBackgroundProcessSessions.has(selectedId);
  const command = backgroundCommand(first.command) || '#' + first.processId;
  ui(host.querySelector<HTMLElement>('.queue-label')!, 'textContent', () => rows.length === 1
    ? t('Background process running · {0}', [command])
    : t('{0} background processes running', [rows.length]));
  // Native title tooltips reset while hovered when their text changes. Keep this attribute
  // lifecycle-stable; the visible elapsed labels still tick once per second.
  host.title = rows.map(row => '#' + row.processId + ' ' + backgroundCommand(row.command)).join('\n');
  liveStatus.hidden = !multiple;
  liveStatus.textContent = multiple ? t('{0} background processes running', [rows.length]) : '';
  const stop = host.querySelector<HTMLButtonElement>('.background-exec-stop')!;
  stop.hidden = multiple;
  configureBackgroundProcessStop(stop, first);
  const chevron = host.querySelector<HTMLElement>('.background-exec-chevron')!;
  chevron.hidden = !multiple;
  host.classList.toggle('is-expandable', multiple);
  host.classList.toggle('is-expanded', expanded);
  if (multiple) {
    host.setAttribute('role', 'button');
    host.setAttribute('aria-expanded', String(expanded));
    host.setAttribute('aria-controls', 'backgroundExecList');
    host.tabIndex = 0;
    const toggle = () => {
      if (!selectedId) return;
      if (expandedBackgroundProcessSessions.has(selectedId)) expandedBackgroundProcessSessions.delete(selectedId);
      else expandedBackgroundProcessSessions.add(selectedId);
      paintBackgroundProcesses();
    };
    host.onclick = event => {
      if ((event.target as HTMLElement).closest('button')) return;
      toggle();
    };
    host.onkeydown = event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggle();
    };
  } else {
    host.setAttribute('role', 'status');
    host.removeAttribute('aria-expanded');
    host.removeAttribute('aria-controls');
    host.removeAttribute('tabindex');
    host.onclick = null;
    host.onkeydown = null;
  }
  list.hidden = !expanded;
  list.replaceChildren();
  if (expanded) {
    for (const row of rows) {
      const item = el('div', 'background-exec-process');
      item.setAttribute('role', 'listitem');
      item.dataset.processId = String(row.processId);
      item.dataset.incarnation = String(row.incarnation);
      item.title = row.command;
      const compactCommand = backgroundCommand(row.command);
      const itemCommand = el('span', 'background-exec-process-command', '#' + row.processId + (compactCommand ? ' ' + compactCommand : ''));
      const itemTime = el('span', 'background-exec-time background-exec-process-time');
      itemTime.dataset.startedAt = String(row.startedAt);
      const itemStop = el('button', 'background-exec-stop') as HTMLButtonElement;
      itemStop.type = 'button';
      const stopIcon = el('i', 'ico ph ph-power');
      stopIcon.setAttribute('aria-hidden', 'true');
      itemStop.append(stopIcon, el('span'));
      configureBackgroundProcessStop(itemStop, row);
      item.append(itemCommand, itemTime, itemStop);
      list.append(item);
    }
  }
  host.hidden = false;
  paintBackgroundProcessTimes();
  syncBackgroundProcessClock(true);
}

function refreshBackgroundProcesses(): void {
  const session = selectedId;
  const request = ++backgroundProcessesRequest;
  if (!session) {
    backgroundProcesses = [];
    backgroundProcessesFor = null;
    backgroundProcessStopping = null;
    paintBackgroundProcesses();
    return;
  }
  void api.runningProcesses(session).then(reply => {
    if (request !== backgroundProcessesRequest || session !== selectedId) return;
    // Older preloads and isolated UI fixtures may not implement this new read yet. Treat a
    // successful-but-non-array payload as no projection instead of throwing from presentation.
    backgroundProcesses = reply.ok && Array.isArray(reply.data) ? reply.data : [];
    backgroundProcessesFor = session;
    if (!backgroundProcesses.some(row => backgroundProcessKey(row) === backgroundProcessStopping)) backgroundProcessStopping = null;
    paintBackgroundProcesses();
    const focus = backgroundProcessFocusAfterRefresh;
    if (focus?.session === session) {
      backgroundProcessFocusAfterRefresh = null;
      if (focus.selection === selectionGeneration && !$('composerDock').hidden) {
        const rows = sortedBackgroundProcesses();
        if (rows.length > 1) $('backgroundExecStatus').focus();
        else if (rows.length === 1) $('backgroundExecStatus').querySelector<HTMLButtonElement>('.background-exec-stop')?.focus();
      }
    }
  });
}
/** The newest sentence the running turn shows that ChatGPT has not published yet (#942). */
let livePreviewText: string | null = null;
let livePreviewFor: string | null = null;
/**
 * Prose speaks for itself only while it is being written. Interim paragraphs stay "streaming" once
 * finished, so what counts is whether its text changed in the last moments, not its state.
 */
let proseSeen: { key: string; chars: number; changedAt: number } | null = null;
const PROSE_QUIET_MS = 2500;
function proseMoving(event: Extract<SessionEvent, { kind: 'assistant_message' }>): boolean {
  const key = event.messageId ?? `seq:${event.seq}`;
  const chars = event.message.chars ?? event.message.text.length;
  if (proseSeen?.key !== key || proseSeen.chars !== chars) proseSeen = { key, chars, changedAt: Date.now() };
  return Date.now() - proseSeen.changedAt < PROSE_QUIET_MS;
}
/**
 * ChatGPT names its own steps in the progressive ("Searching…", "Reading…"); a finished one does not
 * describe now. This reads English wording only: on a ChatGPT page in another language no label
 * matches and the row says "Thinking", which is always true. The page reports no
 * language-independent "in progress" for a step, and taking the newest step by position would
 * show a finished one ("Searched 3 websites") as if it were running. Calls this app runs do not
 * depend on it.
 */
const NATIVE_STEP_NOW = /^\S+ing\b/i;

/**
 * The step in progress, with the icon its finished row will wear: a call of this app by its kind,
 * a ChatGPT step by the globe its rows use. Thinking is not a step and does not look like one: it
 * shows ChatGPT's own sign for it, a white dot that breathes.
 */
function liveActivity(): { text: string; icon: string; working: boolean; since?: number } | null {
  const call = runningToolsFor === selectedId ? runningTools.at(-1) : undefined;
  if (call) return { text: call.title, icon: KIND_ICON[call.kind] ?? KIND_ICON.other, working: true, since: call.since };
  const thinking = { text: t('Thinking'), icon: '', working: false };
  // A message not yet recorded opens a turn that has done nothing visible so far.
  if ($('inputQueue').querySelector('.pending-message')) return thinking;
  // A new chat's first turn: ChatGPT shows the model's sentences long before it publishes them as
  // messages, so the newest one stands here until it can be recorded in its place.
  const preview = livePreviewFor === selectedId ? livePreviewText : null;
  if (preview) return { text: preview, icon: '', working: false };
  let asked = Number.NEGATIVE_INFINITY;
  for (const event of events) if (event.kind === 'user_message') asked = Math.max(asked, event.time);
  let newest: SessionEvent | undefined;
  for (const event of events) {
    if (event.time < asked || !['assistant_message', 'tool_call', 'page_tool', 'progress'].includes(event.kind)) continue;
    if (!newest || event.time >= newest.time) newest = event;
  }
  if (newest?.kind === 'assistant_message' && proseMoving(newest)) return null;
  if (newest?.kind === 'page_tool' && NATIVE_STEP_NOW.test(newest.label)) return { text: newest.label, icon: 'i-globe', working: true, since: newest.time };
  return thinking;
}

function paintTurnNow(): void {
  const now = turnStatusLine.classList.contains('is-working') ? liveActivity() : null;
  const text = now?.text ?? '';
  if (now && turnNowIcon.dataset.icon !== now.icon) {
    turnNowIcon.dataset.icon = now.icon;
    turnNowIcon.replaceChildren(...(now.icon ? [icon(now.icon)] : []));
  }
  turnNow.classList.toggle('is-thinking', now !== null && !now.working);
  if (turnNow.dataset.text !== text) {
    turnNow.dataset.text = text;
    turnNowText.textContent = text;
    turnNowText.title = text;
    // A new step fades in; restarting the animation needs the class off for one style pass.
    turnNow.classList.remove('is-new');
    void turnNow.offsetWidth;
    if (text) turnNow.classList.add('is-new');
  }
  const seconds = now?.since === undefined ? 0 : Math.max(0, Math.floor((Date.now() - now.since) / 1000));
  // Short steps keep no clock; the one worth watching is the one that lasts.
  turnNowTime.textContent = seconds >= 3
    ? `${seconds >= 60 ? `${t('{0}m', [Math.floor(seconds / 60)])} ` : ''}${seconds % 60}s` : '';
  turnNow.hidden = !text;
}

/**
 * Asks, at most once a second while the chat works, what its tool calls are doing, and again as
 * soon as new rows arrive, so a call that just finished never reads as running beside its own row.
 */
function pollRunningTools(): void {
  const summary = sessions.find(entry => entry.id === selectedId);
  if (!summary || !turnStatusLine.classList.contains('is-working')) { runningTools = []; livePreviewText = null; return; }
  if (Date.now() - runningToolsAt < 900 && events.length === runningToolsEvents) return;
  runningToolsAt = Date.now();
  runningToolsEvents = events.length;
  const conversationIds = [...new Set([summary.conversationId, ...summary.chatIds].filter((id): id is string => !!id))].slice(0, 16);
  if (!conversationIds.length) return;
  const request = ++runningToolsRequest, session = selectedId;
  void api.runningTools(conversationIds).then(reply => {
    if (request !== runningToolsRequest || session !== selectedId) return;
    runningTools = reply.ok ? reply.data : [];
    runningToolsFor = session;
    paintTurnNow();
  });
  void api.livePreview(conversationIds).then(reply => {
    if (request !== runningToolsRequest || session !== selectedId) return;
    livePreviewText = reply.ok ? reply.data : null;
    livePreviewFor = session;
    paintTurnNow();
  });
}

/** A turn line: the text sits in its own span so the working shimmer spans the words, not the rule. */
function turnLine(className: string): HTMLElement {
  const line = el('div', className);
  line.append(el('span', 'turn-worked-label'));
  return line;
}
const workedLines = new Map<string, HTMLElement>();

/**
 * How long each of your messages was worked on, keyed by the message's time: from it to the last
 * end the page reported before your next message (a completed turn end or ChatGPT's final answer,
 * whichever came later). Anchored to your messages rather than ChatGPT's turn ids, which a page
 * can report empty or leave off the rows that did the work.
 */
function exchangeDurations(list: readonly SessionEvent[]): Map<number, number> {
  const asks = list.filter(event => event.kind === 'user_message').map(event => event.time).sort((a, b) => a - b);
  const durations = new Map<number, number>();
  asks.forEach((asked, index) => {
    const next = asks[index + 1] ?? Number.POSITIVE_INFINITY;
    let ended = -1;
    for (const event of list) {
      if (event.time < asked || event.time >= next) continue;
      if ((event.kind === 'turn_end' && event.outcome === 'completed') || (event.kind === 'assistant_message' && event.final)) {
        ended = Math.max(ended, event.time);
      }
    }
    if (ended >= asked) durations.set(asked, Math.floor((ended - asked) / 1000));
  });
  return durations;
}

function workedLine(asked: number, seconds: number): HTMLElement {
  const line = workedLines.get(String(asked)) ?? turnLine('turn-worked');
  ui(line.firstElementChild as HTMLElement, 'textContent', () => t("{0} for {1}{2}s", [t("Worked"), seconds >= 60 ? `${t('{0}m', [Math.floor(seconds / 60)])} ` : '', seconds % 60]));
  workedLines.set(String(asked), line);
  return line;
}

/**
 * Opens each of your messages' work with its line, right after the message: the last one shows the
 * live caption while the chat works, earlier ones how long they worked. A message still in the
 * outbox (or work with no message of yours on screen) has the live line parked after the outbox.
 */
function placeTurnLines(rows: HTMLElement[], workedSeconds: ReadonlyMap<number, number>): void {
  const status = deps.state()?.config.ui.developerMode ? null : stateLine();
  const working = status?.working === true;
  turnWorking = working;
  const asks = rows.map((row, index) => ({ row, index, asked: Number(row.dataset.askedAt) }))
    .filter(entry => entry.row.matches('.ev-user_message') && Number.isFinite(entry.asked));
  const pending = !!$('inputQueue').querySelector('.pending-message');
  const used = new Set<string>();
  // Insert from the end so earlier indices stay valid.
  for (let i = asks.length - 1; i >= 0; i--) {
    const { index, asked } = asks[i]!;
    const latest = i === asks.length - 1;
    if (latest && working && !pending) { rows.splice(index + 1, 0, turnStatusLine); rows.push(turnNow); continue; }
    const seconds = workedSeconds.get(asked);
    if (seconds === undefined || (latest && working)) continue;
    rows.splice(index + 1, 0, workedLine(asked, seconds)); used.add(String(asked));
  }
  for (const key of workedLines.keys()) if (!used.has(key)) workedLines.delete(key);
  const inTimeline = rows.includes(turnStatusLine);
  if (!inTimeline) parkTurnStatus(working);
  if (working && status) paintTurnStatus(status);
  $('chatState').classList.toggle('is-mirrored', !deps.state()?.config.ui.developerMode);
}

/** A running turn with no row yet: its line waits right after your pending message. */
function parkTurnStatus(working: boolean): void {
  if (working) $('inputQueue').after(turnStatusLine, turnNow);
  else if (!turnStatusLine.closest('#timeline')) { turnStatusLine.remove(); turnNow.remove(); }
}

function paintTurnStatus(status: ReturnType<typeof stateLine>): void {
  ui(turnStatusLine.firstElementChild as HTMLElement, 'textContent', () => stateLine().text);
  turnStatusLine.classList.toggle('is-working', status.working === true);
  paintTurnNow();
  pollRunningTools();
}

/** One line under the header saying what is happening right now. */
function paintStateLine(): void {
  window.clearTimeout(durationTimer);
  durationTimer = undefined;
  const note = $('chatState');
  const { tone, working, ticking } = stateLine();
  ui(note, 'textContent', () => stateLine().text);
  note.className = `subhead-note${tone ? ` ${tone}` : ''}`;
  // Running state and timer ownership cannot depend on a translated label.
  note.classList.toggle('is-working', working === true);
  // When the turn's own line is on screen it carries this, and the header does not repeat it. A turn
  // that starts before its first row parks the line now, so it never shows in the header first.
  const developer = deps.state()?.config.ui.developerMode;
  if (!developer && !turnStatusLine.closest('#timeline')) parkTurnStatus(working === true);
  if (!developer && working === true) paintTurnStatus({ text: note.textContent ?? '', tone, working, ticking });
  // The turn lines carry the caption outside developer mode; the header keeps developer detail.
  note.classList.toggle('is-mirrored', !developer);
  const recovering = paintRecoveryStatus();
  const goalWaiting = controlledSessionId === selectedId && controlledSelection === selectionGeneration && !!goalWaitView;
  if (goalWaiting) paintGoalProgress();
  if (visible && (ticking || recovering || goalWaiting)) durationTimer = window.setTimeout(paintStateLine, 1000);
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

/**
 * How recently a recorded tool call still means "working now" for the caption above.
 *
 * Short enough that a finished chat stops claiming to work within a minute and a half, long
 * enough to survive the gaps between calls of a chat that is thinking between them. The app's
 * own blind-work stretch uses three minutes before it starts repairing; this is the display
 * half of the same fact and may be quicker, because being wrong here costs a stale word rather
 * than an interrupted page.
 */
const BLIND_CAPTION_MS = 90_000;

// Opt-in (Settings → Playful status words). Kept in English: they are wordplay, not labels.
const TURN_WORK_WORDS = [
  'Pumping tokens', 'Juicing context', 'Bulking output', 'Repping prompts', 'Spotting agents',
  'Loading creatine', 'Chasing gains', 'Flexing neurons', 'TRT mode', 'Testosterone boost',
  'Tren thoughts', 'Deca stack', 'Anavar cutting', 'Dianabol bulking', 'Winstrol drying',
  'Primobolan polishing', 'Pissing OpenAI off a little more', 'Clauding deez nuts',
  'Warming up the GPUs', 'Deadlifting the context window', 'Carb-loading tokens', 'Doing reps on the repo',
  'Hitting a new PR', 'Skipping leg day', 'Pre-workout kicking in', 'Protein-shaking the stack trace',
  'Benching the build', 'Spotting the next token', 'Stretching the attention span', 'Counting macros',
  'Pumping iron and ideas', 'Cutting the fluff', 'Going beast mode', 'One more set',
  'Oiling up the prompt', 'Flexing for the mirror', 'Grinding through the backlog', 'Chugging creatine', 'No pain, no merge'
] as const;

/** Stable per turn, then advances every five seconds so it reads as authored rather than jittery. */
function turnWorkWord(turnId: string, elapsedSeconds: number): string {
  let seed = 0;
  for (const character of turnId) seed = (seed * 31 + character.charCodeAt(0)) >>> 0;
  return TURN_WORK_WORDS[(seed + Math.floor(elapsedSeconds / 5)) % TURN_WORK_WORDS.length]!;
}

function workingLabel(turnId: string, elapsedSeconds: number): string {
  return deps.state()?.config.ui.playfulStatus === true ? turnWorkWord(turnId, elapsedSeconds) : t("Working");
}

function stateLine(): { text: string; tone: '' | 'is-live' | 'is-bad'; working?: boolean; ticking?: boolean } {
  if (!deps.state()?.config.ui.developerMode) {
    const summary = sessions.find(entry => entry.id === selectedId);
    if (!summary || detailFor !== selectedId) return { text: '', tone: '' };
    const active = controlledSessionId === selectedId && controlledSelection === selectionGeneration ? controlledTurnId : null;
    const lastBoundary = [...events].reverse().find(event => event.kind === 'turn_start' || event.kind === 'turn_end');
    /*
     * A chat whose page never opened a turn is still working, and this app knows it.
     *
     * Every line below needs a turn to describe, and a page that stopped reporting supplies
     * none — so the caption fell silent, or worse, kept describing the *previous* turn as
     * "Worked for 12s" while the chat went on editing files. Measured on 2026-09-25: a
     * conversation resumed after an automatic compaction made 650 exactly attributed tool
     * calls over two and a half hours without its page reporting a single turn, and the app
     * said nothing about any of it. The complaint that follows is always the same one — the
     * chat looks idle, there is no Stop control, and the person sits and waits for something
     * that is already happening.
     *
     * The recorded tool clock is the honest witness the page is not: the app keeps
     * `lastToolCallAt` from calls the request-id join has already tied to this exact
     * conversation. A call in the last ninety seconds means work now, whatever the page says.
     * This only changes what the caption admits — no turn is invented, and nothing here
     * offers a Stop the app could not carry out.
     */
    // The tool clock only speaks for work the page has not accounted for: a call newer than the
    // last reported end (turn end or final answer), the same rule the sidebar applies. When the
    // page reports the end after the last call, the turn is over; letting the ninety-second
    // window run on kept a finished chat saying "Working…" long after it had stopped.
    const reportedEnd = Math.max(lastBoundary?.kind === 'turn_end' ? lastBoundary.time : 0,
      summary.lastTurnEndAt ?? 0, summary.lastAssistantFinalAt ?? 0);
    const blind = !active && summary.lastToolCallAt !== null &&
      Date.now() - summary.lastToolCallAt < BLIND_CAPTION_MS &&
      summary.lastToolCallAt > reportedEnd
      ? { text: t("Working…"), tone: '' as const, working: true }
      : null;
    const turnId = active ?? lastBoundary?.turnId;
    if (!turnId) return blind ?? { text: '', tone: '' };
    const startedAt = summary.finishTurn?.turnId === turnId ? summary.finishTurn.startedAt
      : events.find(event => event.kind === 'turn_start' && event.turnId === turnId)?.time;
    const endedAt = events.find(event => event.kind === 'turn_end' && event.turnId === turnId)?.time;
    if (startedAt === undefined) return active
      ? { text: deps.state()?.config.ui.playfulStatus === true ? `${turnWorkWord(turnId, 0)}…` : t("Working…"), tone: '', working: true }
      : blind ?? { text: '', tone: '' };
    if (!active && endedAt === undefined) return blind ?? { text: '', tone: '' };
    if (blind) return blind;
    const seconds = Math.max(0, Math.floor(((active ? Date.now() : endedAt!) - startedAt) / 1000));
    return { text: t("{0} for {1}{2}s", [active ? workingLabel(turnId, seconds) : t("Worked"), seconds >= 60 ? `${t('{0}m', [Math.floor(seconds / 60)])} ` : '', seconds % 60]), tone: '', working: !!active, ticking: !!active };
  }
  // Recording follows the conversation the browser can see. A tool call arrives over the
  // connector carrying nothing that identifies its caller, so work driven from the phone,
  // from another browser or from another machine can only be recorded as what it is:
  // real, complete, and not placeable in any chat this app can observe.
  const selected = sessions.find((entry) => entry.id === selectedId) ?? null;
  if (selected && selected.conversationId === null) {
    return {
      text: t("Work this app could not place in a chat — driven from another device, or with no ChatGPT tab open"),
      tone: ''
    };
  }

  const workers = swarm?.agents.filter((agent) => agent.role === 'worker') ?? [];
  if (workers.length === 0) return { text: '', tone: '' };
  const count = (state: AgentState): number => workers.filter((agent) => agent.state === state).length;
  const parts: string[] = [];
  if (count('active') > 0) parts.push(t("{0} working", [count('active')]));
  // "invited" is a worker whose ChatGPT tab has been asked for but has not joined yet.
  if (count('invited') > 0) parts.push(t("{0} opening", [count('invited')]));
  // Detached is a live worker with no tab: its turn is running on OpenAI's servers and its
  // tool calls still arrive here, so it is counted among the working rather than the lost.
  if (count('detached') > 0) parts.push(t("{0} working with no tab", [count('detached')]));
  if (count('waking') > 0) parts.push(t("{0} waking up", [count('waking')]));
  // Said as "waiting" rather than counted with the finished ones: these are the run's reusable
  // chats, and the number the user wants is how much of the run is still available to it.
  if (count('sleeping') > 0) parts.push(t("{0} sleeping", [count('sleeping')]));
  if (count('finished') > 0) parts.push(t("{0} finished", [count('finished')]));
  if (count('failed') > 0) parts.push(t("{0} failed", [count('failed')]));
  const live = count('invited') + count('active') + count('detached') + count('waking');
  return {
    text: `${workers.length === 1 ? t("1 worker") : t("{0} workers", [workers.length])} · ${parts.join(' · ')}`,
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
    ui(node, 'textContent', () => t("Extension folder: {0}", [dir]));
    node.classList.remove('is-warn');
  } else {
    ui(node, 'textContent', () => t("The extension folder is missing from this installation. Reinstall the app, or use the extension/ folder from a source checkout."));
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
        () => state.retainedHistory
          ? t("No workers are running. Their histories stay available to the chats that started them; Clear workers removes them for good.")
          : t("No agents. The prime agent creates workers with the agents tool’s spawn action.")
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
          ui(clear, 'title', () => agent.role === 'prime'
              ? t("Clear session — ends this run and every worker in it")
              : t("Clear session — ends {0} and frees its slot", [agent.id]));
          top.append(clear);
        }
        const sub = el('div', 'model-sub');
        const bits = [t("{0} pending", [agent.pending]), t("{0} delivered", [agent.delivered])];
        if (agent.conversationId) bits.push(t("chat bound"));
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
      // Main enforces these invariants too. Keeping the canonical values in the complete
      // renderer snapshot prevents an old/foreign control value from being proposed at all.
      record: true,
      retainDays: 0,
      // Both follow the single threshold above rather than being typed separately.
      advisoryTokens: threshold,
      limitTokens: urgentFrom(threshold)
    },
    compaction: {
      auto: $<HTMLInputElement>('autoCompact').checked,
      autoTokens: threshold,
      handoffPrompt: $<HTMLTextAreaElement>('handoffPrompt').value.trim() || DEFAULT_HANDOFF_PROMPT,
      handoffLength: (HANDOFF_LENGTHS as readonly string[]).includes($<HTMLSelectElement>('handoffLength').value)
        ? $<HTMLSelectElement>('handoffLength').value as HandoffLength
        : DEFAULT_HANDOFF_LENGTH
    },
    multiAgent: {
      defaultModel: $<HTMLSelectElement>('workerModel').value,
      defaultReasoning: $<HTMLSelectElement>('workerReasoning').value as Config['multiAgent']['defaultReasoning'],
      // The exposure switch lives with every other ChatGPT tool switch, on Home. Settings owns
      // the per-family worker limit and the optional broker-wide admission cap below.
      enabled: $<HTMLInputElement>('homeMaEnabled').checked,
      maxWorkers: number('maWorkers', current.multiAgent.maxWorkers, 1, 8),
      globalMaxWorkers: number('globalMaWorkers', current.multiAgent.globalMaxWorkers ?? 0, 0, 64),
      allowUnattributedCalls: $<HTMLInputElement>('allowUnattributedCalls').checked,
      strictChatAllowlist: $<HTMLInputElement>('strictChatAllowlist').checked,
      recoverAgentTabs: $<HTMLInputElement>('recoverAgentTabs').checked,
      waitForSubAgents: $<HTMLInputElement>('waitForSubAgents').checked,
      endSleepingWorkerProcesses: $<HTMLInputElement>('endSleepingWorkerProcesses').checked
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
    // The retired editor no longer owns this stored configuration.
    mcp: current.mcp ?? { instructions: '' }
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
let goalModels: GoalModel[] = [];
let selectedGoalModel: GoalModel | undefined;
let goalCatalogEpoch = 0;
let goalTotal = 0;
let goalLoading = false;
let goalModelQuery = '';

function invalidateGoalModels(): void {
  goalCatalogEpoch++;
  goalModels = [];
  selectedGoalModel = undefined;
  goalTotal = 0;
}

function paintGoalReasoning(selected?: Config['goal']['reasoning'], changingModel = false): void {
  const select = $<HTMLSelectElement>('goalReasoning');
  const model = goalModels.find(model => model.id === goalModel) ?? (selectedGoalModel?.id === goalModel ? selectedGoalModel : undefined);
  const custom = $<HTMLSelectElement>('goalProvider').value === 'custom';
  renderGoalReasoning(select, custom ? undefined : model, custom,
    selected ?? (select.value || 'default') as Config['goal']['reasoning'], changingModel);
}

/** The release date OpenRouter publishes, as a person would date a model. */
function releasedOn(created: number): string {
  if (!created) return t("release date not published");
  return new Date(created * 1000).toLocaleDateString(currentLanguage(), { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Loads the next twenty models, newest first.
 *
 * Paged rather than fetched whole because the catalogue is several hundred entries long and
 * the question this list answers — what is new — is answered by the first screen of it.
 */
async function loadGoalModels(reset: boolean): Promise<void> {
  // A new query invalidates an older in-flight page immediately. The older request may still
  // finish, but its epoch can no longer paint rows for the new query.
  if (reset) invalidateGoalModels();
  if (goalLoading) return;
  goalLoading = true;
  const epoch = goalCatalogEpoch;
  const query = goalModelQuery;
  ui($('goalModelsState'), 'textContent', () => t("Loading models from OpenRouter…"));
  $<HTMLButtonElement>('goalMore').disabled = true;
  const page = await run(api.listGoalModels(goalModels.length, query));
  goalLoading = false;
  if (epoch !== goalCatalogEpoch || query !== goalModelQuery) {
    // If search changed while the request was in flight, service the newest query now that the
    // old request released the single-flight guard. It starts at offset zero because reset()
    // cleared the visible rows when the query changed.
    void loadGoalModels(false);
    return;
  }
  if (!page) {
    // `run` has already shown the reason. Say what it means *here*: the list is empty and
    // the model in use has not changed.
    ui($('goalModelsState'), 'textContent', () => t("OpenRouter could not be reached. The model in use is unchanged."));
    $<HTMLButtonElement>('goalMore').disabled = goalModels.length === 0;
    return;
  }
  goalModels = [...goalModels, ...page.models];
  selectedGoalModel = page.selectedModel;
  goalTotal = page.total;
  paintGoalReasoning();
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
    const meta = [releasedOn(model.created), model.contextLength > 0 ? t("{0} ctx", [compactNumber(model.contextLength)]) : '']
      .filter(Boolean)
      .join(' · ');
    row.append(el('em', 'goal-model-meta', `${model.id} · ${meta}`));
    list.append(row);
  }
  const shown = goalModels.length;
  ui($('goalModelsState'), 'textContent', () => shown === 0 ? t("No models came back.") : t("Showing the {0} newest of {1}, newest release first.", [shown, goalTotal]));
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
  automation.disabled = false;
  ui(automation, 'title', () => t("Continue this chat automatically"));
  paintAutomationSwitch();
  const secureStorageAvailable = state.secureStorage?.available ?? true;
  // This picker owns the last known OpenRouter selection. A custom deployment uses
  // its own input and must not replace that selection during an unrelated repaint.
  // A session opened directly on custom starts with the picker's defined default.
  if (config.goal.provider?.kind !== 'custom') goalModel = config.goal.model;
  const reasoningSelect = $<HTMLSelectElement>('goalReasoning');
  const reasoning = document.activeElement === reasoningSelect && previous && reasoningSelect.value !== previous.goal.reasoning
    ? reasoningSelect.value as Config['goal']['reasoning'] : config.goal.reasoning;
  if (previous && JSON.stringify(previous.goal.provider) !== JSON.stringify(config.goal.provider)) invalidateGoalModels();
  applyChatValue($<HTMLTextAreaElement>('goalPrompt'), config.goal.prompt, previous?.goal.prompt);
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
  ui(goalKey, 'placeholder', () => state.hasGoalKey ? t("•••••••• stored") : 'sk-or-v1-…');
  goalKey.disabled = !secureStorageAvailable;
  ui($('goalKeyState'), 'textContent', () => !secureStorageAvailable
    ? (state.secureStorage?.detail ?? t("Secure credential storage is unavailable."))
    : state.hasGoalKey
      ? t("A key is stored with secure OS credential storage. Type a new one to replace it.")
      : t("Stored with secure OS credential storage. It never leaves this app, and the browser is only ever handed the reply."));
  $('goalKeyState').classList.toggle('is-warn', !secureStorageAvailable);
  $<HTMLButtonElement>('goalKeyRemove').disabled = !state.hasGoalKey || !secureStorageAvailable;
  const goalCustomKey = $<HTMLInputElement>('goalCustomKey');
  ui(goalCustomKey, 'placeholder', () => state.hasCustomProviderKey ? t("•••••••• stored") : t("leave empty for a keyless local server"));
  goalCustomKey.disabled = !secureStorageAvailable;
  ui($('goalCustomKeyState'), 'textContent', () => !secureStorageAvailable
    ? (state.secureStorage?.detail ?? t("Secure credential storage is unavailable."))
    : state.hasCustomProviderKey
      ? t("A key is stored with secure OS credential storage. Type a new one to replace it.")
      : t("Optional. Stored with secure OS credential storage and sent only by the app to your configured API endpoint. The browser receives only the reply."));
  $('goalCustomKeyState').classList.toggle('is-warn', !secureStorageAvailable);
  $<HTMLButtonElement>('goalCustomKeyRemove').disabled = !state.hasCustomProviderKey || !secureStorageAvailable;
  paintGoalReasoning(reasoning);
  if (goalModels.length > 0) paintGoalModels();
}

function wireGoal(save: () => Promise<void>): void {
  $<HTMLTextAreaElement>('handoffPrompt').maxLength = MAX_HANDOFF_PROMPT_CHARS;
  $('handoffPromptEdit').addEventListener('click', () => {
    const panel = $('handoffPromptPanel');
    panel.hidden = !panel.hidden;
    $('handoffPromptEdit').textContent = panel.hidden ? 'Edit prompt' : 'Close prompt';
    if (!panel.hidden) $<HTMLTextAreaElement>('handoffPrompt').focus();
  });
  $('handoffPromptReset').addEventListener('click', async () => {
    $<HTMLTextAreaElement>('handoffPrompt').value = DEFAULT_HANDOFF_PROMPT;
    await save();
    toast('Handoff prompt restored to default');
  });
  $<HTMLTextAreaElement>('goalPrompt').maxLength = MAX_GOAL_SYSTEM_PROMPT_CHARS;
  $('goalPromptEdit').addEventListener('click', () => {
    const panel = $('goalPromptPanel');
    panel.hidden = !panel.hidden;
    ui($('goalPromptEdit'), 'textContent', () => panel.hidden ? t('Edit prompt') : t('Close prompt'));
    if (!panel.hidden) $<HTMLTextAreaElement>('goalPrompt').focus();
  });
  $('goalPromptReset').addEventListener('click', async () => {
    $<HTMLTextAreaElement>('goalPrompt').value = DEFAULT_GOAL_SYSTEM_PROMPT;
    await save();
    toast(t('Goal prompt (no task) restored to default'));
  });
  $<HTMLTextAreaElement>('goalObjectivePrompt').maxLength = MAX_GOAL_SYSTEM_PROMPT_CHARS;
  $('goalObjectivePromptEdit').addEventListener('click', () => {
    const panel = $('goalObjectivePromptPanel');
    panel.hidden = !panel.hidden;
    ui($('goalObjectivePromptEdit'), 'textContent', () => panel.hidden ? t('Edit prompt') : t('Close prompt'));
    if (!panel.hidden) $<HTMLTextAreaElement>('goalObjectivePrompt').focus();
  });
  $('goalObjectivePromptReset').addEventListener('click', async () => {
    $<HTMLTextAreaElement>('goalObjectivePrompt').value = DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT;
    await save();
    toast(t('Goal prompt (with a task) restored to default'));
  });
  $<HTMLTextAreaElement>('goalLoopPrompt').maxLength = MAX_GOAL_SYSTEM_PROMPT_CHARS;
  $('goalLoopPromptEdit').addEventListener('click', () => {
    const panel = $('goalLoopPromptPanel');
    panel.hidden = !panel.hidden;
    ui($('goalLoopPromptEdit'), 'textContent', () => panel.hidden ? t('Edit prompt') : t('Close prompt'));
    if (!panel.hidden) $<HTMLTextAreaElement>('goalLoopPrompt').focus();
  });
  $('goalLoopPromptReset').addEventListener('click', async () => {
    $<HTMLTextAreaElement>('goalLoopPrompt').value = DEFAULT_GOAL_LOOP_SYSTEM_PROMPT;
    await save();
    toast(t('Loop prompt restored to default'));
  });
  // The catalogue is fetched on the first press and kept afterwards: the picker closing is
  // not a reason to spend another round trip on a list that changes weekly.
  $('goalPick').addEventListener('click', () => {
    const panel = $('goalModels');
    panel.hidden = !panel.hidden;
    ui($('goalPick'), 'textContent', () => panel.hidden ? t('Select model') : t('Close'));
    if (!panel.hidden && goalModels.length === 0) void loadGoalModels(true);
  });
  const modelSearch = $<HTMLInputElement>('goalModelSearch');
  modelSearch.maxLength = 160;
  modelSearch.addEventListener('input', () => {
    const next = modelSearch.value.slice(0, 160);
    if (next === goalModelQuery) return;
    goalModelQuery = next;
    void loadGoalModels(true);
  });
  $('goalMore').addEventListener('click', () => void loadGoalModels(false));
  $('goalReasoning').addEventListener('focus', () => {
    if ($<HTMLSelectElement>('goalProvider').value !== 'custom' && !goalModels.some(model => model.id === goalModel) && selectedGoalModel?.id !== goalModel)
      void loadGoalModels(true);
  });
  $('goalModelList').addEventListener('scroll', maybePageGoalModels);
  $('goalModelList').addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-model]');
    if (!row?.dataset.model) return;
    goalModel = row.dataset.model;
    $('goalModelName').textContent = goalModel;
    paintGoalReasoning(undefined, true);
    paintGoalModels();
    void save();
    toast(t('Goal model set to {0}', [goalModel]));
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
      invalidateGoalModels();
      // A blur can be followed immediately by refocus + new typing while IPC is in flight.
      // Clear only the exact value that successfully crossed the secret-store boundary.
      if (input.value === submitted) input.value = '';
      applyGoal(next);
      toast(t('OpenRouter key stored'));
    }
  });
  $('goalKeyRemove').addEventListener('click', async () => {
    const next = await run(api.setGoalKey(''));
    if (next) {
      invalidateGoalModels();
      applyGoal(next);
      toast(t('OpenRouter key removed'));
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
      toast(t('Custom provider key stored'));
    }
  });
  $('goalCustomKeyRemove').addEventListener('click', async () => {
    const next = await run(api.setCustomProviderKey(''));
    if (next) {
      applyGoal(next);
      toast(t('Custom provider key removed'));
    }
  });
}

/**
 * One clause under the row, not a paragraph: what the switch will do, and the fact that
 * the number it fires on is this app's own estimate rather than ChatGPT's accounting.
 */
function applyAutoCompactHint(config: Config): void {
  ui($('autoCompactHint'), 'textContent', () => config.compaction.auto
    ? t("Interrupts an active answer at this many tokens, writes a handoff, and opens a fresh chat.")
    : t("Off — only the Compact & resume button in the ChatGPT tab compacts."));
}

/**
 * Every control on the settings sheet, and the whole of it.
 *
 * A field that is not here does not save: it keeps what was typed until the next repaint
 * and then quietly reverts. `autoCompactTokens` was missing, which made the one number the
 * automatic trigger fires on the one control in the app that never kept what you typed.
 * Recording and age retention are absent because history is always recorded and does not
 * expire by age.
 */
const CHAT_INPUTS = [
  'chatBrowser', 'browserBridgePort',
  'goalIncludeToolCalls',
  'planBackend',
  'finishTool', 'finishLeadMinutes', 'defaultChatModel', 'defaultChatReasoning', 'workerModel', 'workerReasoning', 'autoSelectSkills', 'backgroundChats', 'browserOnly', 'autoRefreshPlugins',
  'goalBackend',
  'loopBackend',
  'helperModel', 'helperReasoning',
  'autoCompact',
  'autoCompactTokens',
  'maWorkers', 'globalMaWorkers',
  'allowUnattributedCalls',
  'strictChatAllowlist',
  'recoverAgentTabs',
  'waitForSubAgents',
  'endSleepingWorkerProcesses',
  'autoContinue',
  'goalProvider',
  'goalBaseUrl',
  'goalCustomModel',
  'goalReasoning',
  'handoffPrompt',
  'handoffLength',
  'goalPrompt',
  'goalObjectivePrompt',
  'goalLoopPrompt'
];

/** Writes app state into this panel's controls. Called from the renderer's apply(). */
export function chatApply(state: AppState, previous?: Config): void {
  const { config, bridge } = state;
  if (visible && selectedId) void refreshSessionControls();
  paintContextMeter(sessions.find(session => session.id === selectedId) ?? null, config, confirmedComposerModel());
  applyChatModels(config, previous);

  applyChatChecked($<HTMLInputElement>('autoCompact'), config.compaction.auto, previous?.compaction.auto);
  applyChatValue(
    $<HTMLInputElement>('autoCompactTokens'),
    String(config.compaction.autoTokens),
    previous?.compaction.autoTokens
  );
  applyChatValue(
    $<HTMLTextAreaElement>('handoffPrompt'),
    config.compaction.handoffPrompt ?? DEFAULT_HANDOFF_PROMPT,
    previous?.compaction.handoffPrompt
  );
  applyChatValue(
    $<HTMLSelectElement>('handoffLength'),
    config.compaction.handoffLength ?? DEFAULT_HANDOFF_LENGTH,
    previous?.compaction.handoffLength
  );
  applyAutoCompactHint(config);
  $<HTMLInputElement>('autoCompactTokens').disabled = !config.compaction.auto;

  applyChatValue($<HTMLInputElement>('maWorkers'), String(config.multiAgent.maxWorkers), previous?.multiAgent.maxWorkers);
  applyChatValue(
    $<HTMLInputElement>('globalMaWorkers'),
    String(config.multiAgent.globalMaxWorkers ?? 0),
    previous?.multiAgent.globalMaxWorkers
  );
  applyChatChecked(
    $<HTMLInputElement>('allowUnattributedCalls'),
    config.multiAgent.allowUnattributedCalls,
    previous?.multiAgent.allowUnattributedCalls
  );
  applyChatChecked(
    $<HTMLInputElement>('strictChatAllowlist'),
    config.multiAgent.strictChatAllowlist === true,
    previous?.multiAgent.strictChatAllowlist
  );
  $<HTMLInputElement>('allowUnattributedCalls').disabled = config.multiAgent.strictChatAllowlist === true;
  applyChatChecked(
    $<HTMLInputElement>('recoverAgentTabs'),
    config.multiAgent.recoverAgentTabs,
    previous?.multiAgent.recoverAgentTabs
  );
  applyChatChecked(
    $<HTMLInputElement>('waitForSubAgents'),
    config.multiAgent.waitForSubAgents === true,
    previous?.multiAgent.waitForSubAgents
  );
  applyChatChecked(
    $<HTMLInputElement>('endSleepingWorkerProcesses'),
    config.multiAgent.endSleepingWorkerProcesses === true,
    previous?.multiAgent.endSleepingWorkerProcesses
  );

  applyChatValue($<HTMLSelectElement>('workerModel'), config.multiAgent.defaultModel ?? '', previous?.multiAgent.defaultModel);
  applyChatValue($<HTMLSelectElement>('workerReasoning'), config.multiAgent.defaultReasoning ?? '', previous?.multiAgent.defaultReasoning);
  applyChatValue($<HTMLSelectElement>('defaultChatModel'), config.ui.defaultChatModel ?? '', previous?.ui.defaultChatModel);
  applyChatValue($<HTMLSelectElement>('defaultChatReasoning'), config.ui.defaultChatReasoning ?? '', previous?.ui.defaultChatReasoning);
  applyChatValue($<HTMLSelectElement>('goalBackend'), config.goal.backend ?? 'chatgpt', previous?.goal.backend);
  applyChatValue($<HTMLSelectElement>('loopBackend'), config.goal.loopBackend ?? 'chatgpt', previous?.goal.loopBackend);
  applyChatValue($<HTMLSelectElement>('helperModel'), config.goal.helperModel ?? 'gpt-5.6-sol', previous?.goal.helperModel);
  applyChatValue($<HTMLSelectElement>('helperReasoning'), config.goal.helperReasoning ?? 'high', previous?.goal.helperReasoning);
  applyGoal(state, previous);

  // Extension bridge. Connecting is automatic, so this reports rather than asks.
  const browserRequired = browserExtensionRequired(config);
  $<HTMLButtonElement>('bridgeUnpair').disabled = !bridge.paired;
  const secureStorageAvailable = state.secureStorage?.available ?? true;
  ui($('bridgeState'), 'textContent', () => !browserRequired
    ? t("Browser-backed features are off. The extension is not needed right now.")
    : !secureStorageAvailable
      ? (state.secureStorage?.detail ?? t("Secure credential storage is unavailable, so the extension cannot pair safely."))
    : !bridge.running && bridge.error
      ? t("Browser bridge could not start: {0}", [bridge.error])
    : !bridge.running
      ? t("The local bridge is off even though recording or multi-agent mode needs it.")
      : bridge.present
        ? t("Connected. Listening on 127.0.0.1:{0} · last message {1}.", [bridge.port ?? '?', ago(bridge.lastSeenAt)])
        : bridge.paired
          ? t("Authorized, but the browser extension is not currently connected. {0}", [bridge.lastSeenAt === null ? t("It has not checked in since this app started.") : t("Last seen {0}.", [ago(bridge.lastSeenAt)])])
          : t("Listening on 127.0.0.1:{0} · no browser is authorized or connected yet.", [bridge.port ?? '?']));
  $('bridgeState').classList.toggle('is-warn', browserRequired && (!bridge.present || !secureStorageAvailable));
  void showExtensionPath();

  if (sessions.length > 0) paintSessions();
}

/** Called when the Chat tab becomes visible or is left, so it only polls when shown. */
export function chatVisible(next: boolean): void {
  if (visible === next) return;
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
function scheduleReload(change?: SessionChange): void {
  if (!visible) return;
  if (change?.allTranscripts) changedTranscripts.all = true;
  for (const id of change?.sessionIds ?? []) changedTranscripts.ids.add(id);
  // One refresh owns the timer until its asynchronous read completes. Starting a
  // newer read every 400 ms can invalidate every result on a busy/slower store.
  if (listTimer !== undefined) { listRefreshDirty = true; return; }
  listTimer = window.setTimeout(() => {
    listRefreshDirty = false;
    void loadSessions('changed').finally(() => {
      listTimer = undefined;
      if (listRefreshDirty) scheduleReload();
    });
  }, 400);
}

/** Retired automatic drafts belong to their creation time, never the live composer queue. */
function historicalAutomaticInput(entry: InputEntry): boolean {
  return (!!entry.recovery || (!!entry.finishOwner && !entry.finishOwner.userRequested)) &&
    entry.state === 'cancelled' && !!entry.error;
}

function inputMessageRow(entry: InputEntry, notice: boolean): HTMLElement {
  const row = el('div', 'pending-message');
  row.classList.toggle('is-delivered', !entry.error && ['sent', 'tool'].includes(entry.state));
  row.classList.toggle('is-delivery-error', !!entry.error || entry.state === 'failed');
  row.dataset.inputId = entry.id;
  row.dataset.timelineKey = `input:${entry.id}`;
  if (!visibleInputIds.has(entry.id)) row.classList.add('is-entering');
  visibleInputIds.add(entry.id);
  if (visibleInputIds.size > 100) visibleInputIds.delete(visibleInputIds.values().next().value!);
  const status = () => entry.error ? t(entry.error) : (entry.state === 'failed' ? t("Delivery not confirmed") : entry.state === 'decision' ? t("Preparing follow-up") : entry.state === 'browser' ? t("Delivery confirmation pending") : entry.state === 'tool' ? t("Sent to the active turn · awaiting receipt") : entry.dueAt > Date.now() ? t("Scheduled {0}", [new Date(entry.dueAt).toLocaleString(currentLanguage())]) : entry.delivery === 'tool' ? t("Waiting for the next tool call") : t("Queued"));
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
  ui(receipt, 'title', status); ui(receipt, 'aria-label', status);
  if (entry.error || entry.state === 'failed') {
    ui(receipt, 'textContent', status);
  }
  else receipt.append(icon(['sent', 'tool'].includes(entry.state) ? 'i-check' : 'i-clock'));
  receipt.hidden = !entry.error && ['sent', 'tool'].includes(entry.state) && hasLaterModelActivity(entry.deliveredAt ?? entry.offeredAt ?? entry.createdAt);
  row.append(receipt);
  if (notice) {
    const dismiss = dockAction(() => t("Dismiss delivery notice"), 'i-x', () => {});
    dismiss.onclick = async () => {
      dismiss.disabled = true;
      const result = await run(api.cancelInput(entry.id));
      if (result) dismissInputNotice(entry.id);
      else dismiss.disabled = false;
      void refreshInputQueue();
    };
    row.append(dismiss);
    const retry = dockAction(() => t("Retry delivery"), 'i-retry', () => {});
    retry.classList.add('delivery-retry');
    const unqueuedPlan = entry.stages !== undefined && !entry.stagesApplied;
    ui(retry, 'title', () => unqueuedPlan ? t("Retry stage one with the complete plan and queued checkpoints") : t("Restore this message to the composer for review and sending"));
    retry.onclick = () => {
      if (unqueuedPlan) { void retryPlannedInput(entry); return; }
      const input = $<HTMLTextAreaElement>('chatInput');
      if (authoredComposerText().trim() || imageDrafts.get(draftKey())?.length) { toast(t("Send or clear your current draft before retrying this message.")); return; }
      replaceComposerDraft();
      input.value = entry.text;
      if (entry.images?.length) imageDrafts.set(draftKey(), [...entry.images]);
      if (entry.attachments?.length) imageDrafts.set(draftKey(), [...(entry.images ?? []), ...entry.attachments]);
      rememberDraft(); skillPicker?.restore(); paintComposerImages(); paintDeliveryControls(); input.focus();
      dismissInputNotice(entry.id);
    };
    row.append(retry);
  }
  if (['queued', 'browser'].includes(entry.state)) {
    const cancel = dockAction(() => t("Cancel delivery"), 'i-x', () => {});
    cancel.onclick = async () => {
      cancel.disabled = true;
      const result = await run(api.cancelInput(entry.id));
      if (result) dismissInputNotice(entry.id);
      void refreshInputQueue();
    };
    row.append(cancel);
  }
  if (entry.state === 'queued' && (entry.error?.startsWith('Message queued. Browser startup failed:') ||
      entry.error?.startsWith('Message queued. Finish Setup to send:') || entry.error?.startsWith('Local chat setup failed:'))) {
    const retry = dockAction(() => t("Retry browser"), 'i-retry', () => {});
    retry.classList.add('delivery-retry');
    retry.onclick = async () => { retry.setAttribute('disabled', ''); await run(api.retryInputBrowser(entry.id)); void refreshInputQueue(); };
    row.append(retry);
  }
  return row;
}

/** Local admission moves the draft; a native receipt alone may mark it sent. */
async function adoptAcceptedOpening(entry: InputEntry): Promise<boolean> {
  const pending = pendingNewInput;
  const id = entry.opening ? entry.sessionId : entry.state === 'sent' ? entry.deliveredSessionId : null;
  if (!id || !pending || pending.id !== entry.id || pending.generation !== selectionGeneration || !newChatSelected || selectedId !== null) return false;
  let summary = sessions.find(row => row.id === id);
  if (!summary) summary = (await run(api.getSession(id, { limit: 1 })))?.summary ?? undefined;
  if (!summary || pendingNewInput !== pending || pending.generation !== selectionGeneration || selectedId !== null) return false;
  pendingNewInput = null;
  mergeSessionRows([summary]);
  const from = draftKey();
  inputDrafts.set(summary.id, authoredComposerText());
  const images = imageDrafts.get(from);
  if (images) imageDrafts.set(summary.id, images);
  selectSession(summary.id);
  inputDrafts.delete(from); imageDrafts.delete(from); newChatTasks.delete(from);
  return true;
}
function paintPendingInputs(): void {
  const all = pendingComposerInputs;
  const belongsToSelection = (entry: InputEntry): boolean => selectedId === null
    ? pendingNewInput?.generation === selectionGeneration && entry.id === pendingNewInput.id
    : (entry.sessionId ?? entry.deliveredSessionId) === selectedId;
  // A pre-acceptance or failed-materialization row belongs only to its exact draft.
  // A fresh New Chat never inherits another opening.
  const unbound = (entry: InputEntry) => selectedId === null && pendingNewInput?.id === entry.id && pendingNewInput.generation === selectionGeneration && !entry.deliveredSessionId && entry.purpose !== 'decision' && ['queued', 'browser'].includes(entry.state);
  const notice = (entry: InputEntry) => belongsToSelection(entry) && entry.purpose !== 'decision' &&
    ['failed', 'cancelled'].includes(entry.state) && !!entry.error && !dismissedInputNotices.has(entry.id);
  const anchored = (entry: InputEntry) => detailFor === selectedId && (events.some(event =>
    event.kind === 'user_message' && (event.inputId === entry.id ||
      event.messageId === (entry.messageId ?? `input:${entry.id}`))) ||
    // History owns committed off-page rows. Keep only receipts newer than our
    // loaded publication cursor while the corresponding live snapshot arrives.
    ((entry.historyAnchored || entry.historyRecorded) &&
      (historyBefore !== null || (entry.historySeq !== undefined
        ? (detailCursor ?? 0) > entry.historySeq
        : events.length > 0))));
  const rows = all.filter((entry) => !dismissedInputNotices.has(entry.id) && !(!notice(entry) && anchored(entry)) && !(queuedFollowup(entry) && ['queued', 'tool', 'browser'].includes(entry.state)) && (belongsToSelection(entry) || unbound(entry) || notice(entry)) &&
    (notice(entry) || unbound(entry) || selectedId !== null || projectGroup(entry.projectId) === selectedProjectId) &&
    (notice(entry) || !['sent', 'cancelled'].includes(entry.state) || (entry.state === 'sent' && entry.messageId && !anchored(entry))));
  for (const entry of startingInputs.values()) if (belongsToSelection(entry) && !all.some(row => row.id === entry.id)) rows.push(entry);
  const host = $('inputQueue');
  const previous = new Map([...host.querySelectorAll<HTMLElement>(':scope > .pending-message')].map(row => [row.dataset.inputId, row]));
  const next = rows.filter(entry => !historicalAutomaticInput(entry)).map(entry => {
    const sig = JSON.stringify([entry.text, entry.state, entry.error, entry.dueAt, notice(entry), entry.stagesApplied,
      entry.stages, entry.attachments?.map(file => file.id), entry.images?.map(image => [image.name, image.dataUrl.length]),
      hasLaterModelActivity(entry.deliveredAt ?? entry.offeredAt ?? entry.createdAt)]);
    const old = previous.get(entry.id);
    if (old?.dataset.inputSignature === sig) return old;
    const row = inputMessageRow(entry, notice(entry)); row.dataset.inputSignature = sig; return row;
  });
  // Helper controls have their own owner and are refreshed by the queue read below.
  reconcileChildren(host, [...next, ...host.querySelectorAll<HTMLElement>(':scope > .queued-input')]);
  holdSentMessage();
}
async function refreshInputQueue(): Promise<void> {
  const request = ++inputQueueGeneration;
  const selection = selectionGeneration;
  const [all, pausedHelpers] = await Promise.all([run(api.listInputs()), run(api.listPausedHelpers())]);
  if (!all || selection !== selectionGeneration || request !== inputQueueGeneration) return;
  pendingComposerInputs = all;
  for (const id of dismissedInputNotices) if (!all.some(entry => entry.id === id)) dismissedInputNotices.delete(id);
  paintDeliveryControls();
  const accepted = pendingNewInput && all.find(entry => entry.id === pendingNewInput!.id);
  if (accepted && await adoptAcceptedOpening(accepted)) return;
  if (selection !== selectionGeneration || request !== inputQueueGeneration) return;
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
    const ids = queuedTasks.filter(row => row.state === 'queued' && !row.recovery).map(row => row.id);
    if (from === to || !ids.includes(from) || !ids.includes(to)) return;
    ids.splice(ids.indexOf(from), 1);
    ids.splice(ids.indexOf(to) + Number(after), 0, from);
    const saved = await run(api.reorderQueuedInputs(queueSession, ids));
    if (saved === false) toast(t("The queue changed during the move. Try again."));
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
    if (projectedIds.has(entry.id)) ui(card, 'aria-label', () => t("Plan stage · waiting for the first message to be sent"));
    if (entry.recovery) ui(card, 'aria-label', () => t('Automatic Continue'));
    const label = el('span', 'queue-label', entry.recovery ? () => `${t('Automatic Continue')} · ${entry.text}` : entry.text);
    ui(label, 'title', () => `${entry.recovery
      ? t('Resumes without a final answer. If ChatGPT is still generating, the silent turn is stopped before Continue is sent.')
      : entry.state === 'queued' ? (entry.mode === 'after-turn' ? t("After the next completed answer") : t("At Session finish or after a completed answer")) : t("Awaiting receipt")} · ${entry.text}`);
    label.dir = 'auto';
    card.append(icon(entry.recovery ? 'i-pulse' : 'i-clock'), label);
    if (entry.state === 'queued') {
      const retireCard = () => { card.remove(); taskList.hidden = taskList.childElementCount === 0; };
      const cancel = dockAction(() => entry.recovery ? t('Cancel automatic Continue') : t("Remove queued task"), 'i-trash', () => {});
      cancel.onclick = async () => {
        if (cancel.disabled || !card.isConnected || selection !== selectionGeneration) return;
        cancel.disabled = true;
        const removed = await run(api.cancelInput(entry.id));
        if (!card.isConnected || selection !== selectionGeneration) return;
        if (removed === true || removed === false) {
          inputQueueGeneration++;
          if (removed) pendingComposerInputs = pendingComposerInputs.filter(row => row.id !== entry.id);
          retireCard();
          void refreshInputQueue();
        } else cancel.disabled = false;
      };
      if (entry.recovery) { card.append(cancel); return card; }
      const queueSessionSummary = sessions.find(row => row.id === selectedId);
      const modelSelection = queueSessionSummary?.selectedModel;
      if (entry.mode === 'finish' && modelSelection?.conversationId === queueSessionSummary?.conversationId && isAstraModel(modelSelection?.model, modelSelection?.reasoningEffort)) {
        const delivery = el('button', 'btn queue-delivery', () => entry.afterTurn === true ? t("Also after turn") : t("Finish only")) as HTMLButtonElement;
        delivery.type = 'button';
        ui(delivery, 'aria-label', () => t("Also send this task as a new message after Astra finishes its turn"));
        delivery.setAttribute('aria-pressed', String(entry.afterTurn === true));
        ui(delivery, 'title', () => entry.afterTurn === true ? t("At Session Finish, or as a new message after verified turn completion") : t("Only inside the Session Finish tool result; never start a new turn"));
        delivery.onclick = async () => {
          delivery.disabled = true;
          await run(api.editQueuedInput(entry.id, entry.text, entry.afterTurn !== true));
          void refreshInputQueue();
        };
        card.append(delivery);
      }
      label.draggable = true;
      label.tabIndex = 0;
      ui(label, 'title', () => t("Drag to reorder. Alt + Up/Down also moves this task."));
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
        const ids = queuedTasks.filter(row => row.state === 'queued' && !row.recovery).map(row => row.id);
        const next = ids[ids.indexOf(entry.id) + (event.key === 'ArrowDown' ? 1 : -1)];
        if (next) void reorder(entry.id, next, event.key === 'ArrowDown');
      };
      const edit = dockAction(() => t("Edit queued task"), 'i-pencil', () => {});
      edit.onclick = () => {
        if (!card.isConnected || selection !== selectionGeneration) return;
        const field = document.createElement('textarea'); field.dir = 'auto'; field.value = entry.text; ui(field, 'aria-label', () => t("Queued task"));
        const contents = [...card.childNodes];
        const save = el('button', 'btn', () => t("Save")) as HTMLButtonElement; save.type = 'button';
        save.onclick = async () => {
          if (save.disabled || cancel.disabled || !card.isConnected || selection !== selectionGeneration) return;
          const value = field.value;
          if (!value.trim()) { cancel.click(); return; }
          save.disabled = true; cancel.disabled = true; ui(save, 'textContent', () => t("Saving…")); field.readOnly = true;
          try {
            const saved = await run(api.editQueuedInput(entry.id, value));
            if (!card.isConnected || selection !== selectionGeneration) return;
            if (saved) {
              // The durable edit receipt ends editing, regardless of focus or a slower
              // queue refresh. Refreshes preserve drafts; they do not own Save completion.
              entry.text = value.trim(); label.textContent = entry.text;
              card.classList.remove('is-editing'); card.replaceChildren(...contents);
              inputQueueGeneration++;
              void refreshInputQueue();
            } else if (saved === false) {
              // A claimed or removed row no longer owns an editor. Refresh projects
              // its actual delivery state; it must never preserve this stale draft.
              inputQueueGeneration++;
              retireCard();
              void refreshInputQueue();
            }
          } catch (error) { toast(error instanceof Error ? error.message : t("Could not save this task.")); }
          finally { save.disabled = false; cancel.disabled = false; ui(save, 'textContent', () => t("Save")); field.readOnly = false; }
        };
        card.classList.add('is-editing'); card.replaceChildren(field, save, cancel); field.focus();
      };
      card.append(edit, cancel);
    }
    return card;
  }));
  paintDetail(false);
  for (const node of $('inputQueue').querySelectorAll(':scope > .queued-input')) node.remove();
  for (const helper of pausedHelpers ?? []) {
    if (helper.sourceSessionId !== selectedId) continue;
    const row = el('div', 'queued-input');
    row.append(el('span', '', () => t("Helper delivery was not confirmed. Its old chat may still be running.")));
    const retry = el('button', 'btn', () => t("Start a new helper"));
    retry.setAttribute('type', 'button');
    retry.onclick = async () => {
      retry.setAttribute('disabled', '');
      const accepted = await run(api.retryHelper(helper.id, helper.sourceSessionId));
      if (accepted) toast(t("New helper authorized for this chat"));
      else toast(t("This helper has changed. Refreshing its status."));
      void refreshInputQueue();
    };
    row.append(retry);
    $('inputQueue').append(row);
  }
}
async function retryPlannedInput(entry: InputEntry): Promise<void> {
  if (dismissedInputNotices.has(entry.id) || entry.stagesApplied || !['failed', 'cancelled'].includes(entry.state)) return;
  // The outbox retains the authored workflow after failure. Retry that payload, not
  // its stage-one display text, and never revive the old browser claim/receipt.
  const { sessionId, projectId, text, objective, stages, images, attachments, attachmentDelivery, automation, loopAfterTurn, model, reasoningEffort, afterTurn } = entry;
  const args: InputArgs = { id: crypto.randomUUID(), sessionId, projectId, text, objective, stages, images, attachments, attachmentDelivery,
    automation, loopAfterTurn, model, reasoningEffort, afterTurn, mode: entry.requestedMode ?? entry.mode, dueAt: Date.now() };
  const generation = selectionGeneration;
  // Hide during the attempt, but persist dismissal only after its replacement is durable.
  dismissedInputNotices.add(entry.id); void refreshInputQueue();
  let accepted = false;
  try {
    if (entry.error === 'Requested model or reasoning could not be confirmed') {
      const selection = await ensureComposerModel(true);
      if (generation !== selectionGeneration || cancelledStarts.has(args.id)) return;
      // This message asked for an exact model; Automatic would quietly replace it (#864).
      if (!selection?.model) { toast(t("Model refresh could not confirm your selection. Choose an available model, then retry the plan.")); return; }
      Object.assign(args, selection);
    }
    startingInputs.set(args.id, { ...args, state: 'queued', owner: null, createdAt: args.dueAt, conversationId: null });
    if (sessionId === null) pendingNewInput = { id: args.id, generation };
    paintDeliveryControls(); void refreshInputQueue();
    const result = await run(api.sendInput(args));
    if (cancelledStarts.has(args.id)) return;
    if (!result) return;
    accepted = true;
    inputQueueGeneration++;
    pendingComposerInputs = [...pendingComposerInputs.filter(row => row.id !== result.id), result];
    showAutoSkillReceipt(result);
    await adoptAcceptedOpening(result);
  } finally {
    if (accepted) dismissInputNotice(entry.id);
    if (!accepted && !cancelledStarts.has(args.id)) dismissedInputNotices.delete(entry.id);
    if (!accepted && pendingNewInput?.id === args.id) pendingNewInput = null;
    cancelledStarts.delete(args.id); startingInputs.delete(args.id);
    paintDeliveryControls(); void refreshInputQueue();
  }
}
function showAutoSkillReceipt(entry: Pick<InputEntry, 'autoSkills'>): void {
  if (entry.autoSkills?.length) toast(t('Auto-selected Skill: /{0}', [entry.autoSkills[0]!.id]));
}
async function stopCurrentTurn(): Promise<void> {
  const id = selectedId, turnId = controlledTurnId, generation = selectionGeneration;
  if (!id || controlledSessionId !== id || controlledSelection !== generation || !turnId || controlledStopPending) return;
  controlledStopPending = true; paintDeliveryControls();
  try { await run(api.stopSessionTurn(id, turnId)); }
  finally { if (selectedId === id && selectionGeneration === generation) { controlledStopPending = false; void refreshSessionControls(); } }
}
let composerDiscoveryGeneration = 0;
async function sendComposer(delivery?: 'finish', plan?: string[], planObjective?: string, controlAction = false): Promise<boolean | void> {
  const input = $<HTMLTextAreaElement>('chatInput');
  const key = draftKey();
  const projectId = selectedId ? sessions.find(row => row.id === selectedId)?.projectId ?? null : selectedProjectId;
  const images = imageDrafts.get(key) ?? [];
  const text = plan?.[0] ?? (authoredComposerText().trim() || (images.length ? 'Please look at the attached files.' : ''));
  if ($<HTMLButtonElement>('chatSend').disabled) return;
  if (!text) {
    // An empty/repeated form submission is not a Stop gesture. Only activation
    // of the button while it actually displays Stop/Cancel owns this branch.
    if (!controlAction) return;
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
  const discoverySelection = selectionGeneration, discoverySession = selectedId, discoveryDraft = authoredComposerText();
  const modelSettings = composerSendModel() ?? await ensureComposerModel();
  // Discovery can outlive navigation or draft edits. Only the latest unchanged
  // authored send may continue; a second click must never send the same text twice.
  if (discoveryGeneration !== composerDiscoveryGeneration || discoverySelection !== selectionGeneration || discoverySession !== selectedId ||
      authoredComposerText() !== discoveryDraft || (imageDrafts.get(key) ?? []).some((image, index) => image !== images[index]) ||
      (imageDrafts.get(key)?.length ?? 0) !== images.length) return false;
  if (!modelSettings) { toast(t("Model discovery could not confirm your selection. Choose an available model and thinking effort, then send again.")); return false; }
  const sessionId = selectedId;
  const generation = selectionGeneration;
  const chosenMode = delivery ?? $<HTMLSelectElement>('sendMode').value;
  const mode = chosenMode === 'tool' ? 'auto' : chosenMode === 'after-turn' && controlledSessionId === selectedId && controlledSelection === selectionGeneration && controlledQueueAtFinish ? 'finish' : chosenMode;
  const dueAt = Date.now();
  const id = crypto.randomUUID();
  const authoredDraft = authoredComposerText();
  const attachmentPayload = { images: images.filter((file): file is InputImage => 'dataUrl' in file), attachments: images.filter((file): file is InputAttachment => 'id' in file),
    ...(chosenMode === 'tool' && !plan ? { delivery: 'tool' as const } : {}),
    ...(mode === 'auto' && !plan && selectedId && controlledSessionId === selectedId && controlledSelection === generation &&
      controlledCanInject && images.some(file => 'id' in file) && injectableAttachments(images) ? { attachmentDelivery: 'tool' as const } : {}) };
  const objective = plan ? planObjective : mode === 'finish' ? undefined : $<HTMLTextAreaElement>('sessionObjective').value.trim() || undefined;
  const authoredSource = plan ? 'objective' as const : 'text' as const;
  startingInputs.set(id, { id, sessionId, projectId, text, ...attachmentPayload, stages: plan?.slice(1), objective, authoredSource, mode: mode === 'finish' ? 'finish' : mode === 'auto' ? 'auto' : 'after-turn',
    dueAt, ...modelSettings, state: 'queued', owner: null, createdAt: dueAt, conversationId: null });
  replaceComposerDraft();
  input.value = ''; inputDrafts.delete(key);
  skillPicker?.restore();
  imageDrafts.delete(key); paintComposerImages();
  if (sessionId === null) pendingNewInput = { id, generation };
  if (mode !== 'finish' && followOutput()) { sendAnchor = null; readingAfterSend = false; readerAtEnd = true; }
  else if (mode !== 'finish') { sendAnchor = { key: `input:${id}`, inputId: id, before: userMessageKeys(), session: selectedId, seen: false, smoothUntil: 0 }; readingAfterSend = false; }
  void refreshInputQueue();
  paintDeliveryControls();
  try {
    const result = await run(api.sendInput({ id, sessionId, projectId, text, ...attachmentPayload, stages: plan?.slice(1), objective, authoredSource, automation: mode === 'finish' ? undefined : $<HTMLSelectElement>('chatAutomation').value as InputAutomation, loopAfterTurn: openingLoopDelivery(), mode: mode === 'finish' ? 'finish' : mode === 'auto' ? 'auto' : 'after-turn', dueAt, ...modelSettings }));
    if (cancelledStarts.has(id)) return;
    if (!result) {
      // A disk failure after outbox commit still owns this input. Keep its exact
      // queue/error visible rather than restoring a second copy into the composer.
      const retained = (await run(api.listInputs()))?.find(row => row.id === id);
      if (retained) {
        pendingComposerInputs = [...pendingComposerInputs.filter(row => row.id !== id), retained];
        showAutoSkillReceipt(retained);
        await adoptAcceptedOpening(retained);
        return true;
      }
      if (selectedId === sessionId && selectionGeneration === generation && !authoredComposerText()) {
        inputDrafts.set(key, authoredDraft); input.value = authoredDraft; skillPicker?.restore();
      }
      else if (!inputDrafts.get(key)) inputDrafts.set(key, authoredDraft);
      if (images.length) imageDrafts.set(key, [...images, ...(imageDrafts.get(key) ?? [])]);
      if (draftKey() === key) paintComposerImages();
      if (pendingNewInput?.id === id) pendingNewInput = null;
      return;
    }
    // The accepted IPC result is newer than any queue read started before it. Keep
    // that durable row visible while the next listing crosses the process boundary.
    inputQueueGeneration++;
    pendingComposerInputs = [...pendingComposerInputs.filter(row => row.id !== result.id), result];
    showAutoSkillReceipt(result);
    if (sessionId === null && selectionGeneration === generation && pendingNewInput?.id === id && result.automation &&
        ($<HTMLSelectElement>('chatAutomation').value !== result.automation || openingLoopDelivery() !== result.loopAfterTurn))
      await run(api.setInputAutomation(result.id, $<HTMLSelectElement>('chatAutomation').value as InputAutomation, openingLoopDelivery()));
    if (sessionId === null && selectionGeneration === generation) {
      pendingNewInput = { id: result.id, generation };
      await adoptAcceptedOpening(result);
    }
    $('composerStatus').textContent = '';
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
  const ownerChanged = id !== selectedId;
  rememberDraft();
  selectionGeneration++; replaceComposerDraft();
  inputQueueGeneration++;
  $('finishQueue').replaceChildren(); $('finishQueue').hidden = true;
  newChatSelected = false;
  selectedId = id;
  refreshBackgroundProcesses();
  const selected = sessions.find(row => row.id === id);
  applyComposerSessionModel(`${id}:${selectionGeneration}`, composerSessionSelection(selected) ?? null);
  const parent = selected?.origin?.kind === 'worker' ? selected.origin.fromSessionId : null;
  if (parent) expandedWorkers.add(parent);
  selectedProjectId = projectGroup(parent ? sessions.find(row => row.id === parent)?.projectId : selected?.projectId);
  if (selectedProjectId) expandedProjects.add(selectedProjectId);
  ui($<HTMLTextAreaElement>('chatInput'), 'placeholder', () => t("Ask anything…"));
  restoreDraft();
  if (ownerChanged) {
    // Retire the prior owner now; retain only its inert painted transcript until the
    // selected detail arrives. Existing async image/load generation fences still apply.
    // Reading away from a sent message belongs to the chat it happened in.
    sendAnchor = null; readingAfterSend = false; readerAtEnd = true;
    events = [];
    totalEvents = 0;
    historyBefore = null;
    detailFor = null;
    detailCursor = null;
    forgetTimelineRows();
    $('timeline').setAttribute('inert', '');
    $('timeline').setAttribute('aria-busy', 'true');
    handoff = null;
    handoffFor = null;
    handoffLoadGeneration++;
  }
  paintSessions();
  if (ownerChanged) {
    paintDetail(false);
    paintHandoff();
  }
  void loadDetail();
  void refreshInputQueue();
}

function selectNewChat(projectId: string | null = null): void {
  rememberDraft(); selectionGeneration++; replaceComposerDraft(); pendingNewInput = null;
  inputQueueGeneration++;
  $('finishQueue').replaceChildren(); $('finishQueue').hidden = true;
  newChatSelected = true; selectedId = null; selectedProjectId = projectId; detailFor = null; detailCursor = null;
  refreshBackgroundProcesses();
  sendAnchor = null; readingAfterSend = false; readerAtEnd = true;
  if (projectId) expandedProjects.add(projectId);
  applyComposerSessionModel(null, null);
  // New Chat selects its existing draft, just like a session. Navigation is not
  // permission to discard authored text, attachments or a prepared workflow.
  $('inputQueue').replaceChildren();
  restoreDraft(); showView('timeline'); paintSessions(); void loadDetail();
  if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    $('composer').animate?.([{ opacity: 0.45 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' });
  }
  ui($<HTMLTextAreaElement>('chatInput'), 'placeholder', () => projectId ? t("Message in {0}…", [projects.find(project => project.id === projectId)?.name ?? 'project']) : t("Ask anything…"));
  $<HTMLTextAreaElement>('chatInput').focus();
}

export function initChat(next: Deps): void {
  sidebarCompletion = createSidebarCompletionState();
  sidebarOrder = createSidebarOrder($('sessionList'), () => [
    ...projectSortEntries(),
    ...sessions.filter(entry => (entry.conversationId || entry.origin?.kind === 'desktop') && entry.origin?.kind !== 'worker')
      .map(entry => ({ id: entry.id, scope: projectGroup(entry.projectId) ?? '' }))
  ], paintSessions);
  deps = next;
  const stopComposerHeightMotion = installComposerHeightMotion($('composer'));
  const stopComposerDockMotion = installComposerDockMotion($('composerDock'));
  window.addEventListener('beforeunload', () => {
    stopComposerHeightMotion(); stopComposerDockMotion();
  }, { once: true });
  const chatHost = document.querySelector<HTMLElement>('[data-panel="chat"]')!;
  const docks = createWorkspaceDocks(chatHost);
  workspaceDocks = docks;
  const agentToolGroups = new Map<string, HTMLDetailsElement>();
  agentPanel = createAgentPanel({
    host: chatHost, mount: docks.body,
    onShow: () => { filePanel?.hide(); docks.adopt('agents'); },
    onEscape: () => { docks.setOpen(false); docks.rightToggle.focus(); },
    load: id => run(api.getSession(id, { limit: 160 })), openMain: selectSession, working: sessionWorking,
    agent: worker => swarm?.agents.find(entry => entry.role === 'worker' && entry.id === worker.origin?.agentId &&
      !!entry.conversationId && entry.conversationId === worker.conversationId) ?? null,
    render: (source, id, current) => {
      let boundary = '';
      const rows = foldAgentCommunication(source).flatMap(event => {
        if (!['tool_call', 'page_tool', 'agent_message'].includes(event.kind)) boundary = `event:${event.seq}`;
        if (!['user_message', 'assistant_message', 'native_image', 'tool_call', 'page_tool', 'agent_message', 'chat_error'].includes(event.kind)) return [];
        const row = el('div', `ev ev-${event.kind}`); const body = el('div', 'ev-body');
        tagImageRow(row, event);
        row.dataset.timelineKey = `pane:${id}:event:${event.seq}`; row.dataset.activityBoundary = boundary;
        body.append(eventBody(event, { id, current, history: source })); row.append(body); return [row];
      });
      return groupImageRows(groupToolRows(rows, `pane:${id}`, agentToolGroups));
    }
  });
  initChatModels(() => {
    paintLoopDelivery();
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
    const edit = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-edit-mode]');
    if (edit) {
      if (edit.disabled) return;
      openObjectiveEditor(edit.dataset.editMode as 'goal' | 'loop');
      return;
    }
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-mode]');
    if (!button || button.disabled) return;
    const select = $<HTMLSelectElement>('chatAutomation');
    select.value = button.dataset.mode!;
    select.dispatchEvent(new Event('change'));
    $<HTMLDetailsElement>('composerSettings').open = false;
    $('composerSettings').querySelector<HTMLElement>('summary')!.focus();
  });
  $('chatAutomation').addEventListener('change', async () => {
    goalIntentGeneration++;
    const select = $<HTMLSelectElement>('chatAutomation');
    objectiveEditMode = null;
    cancelGoalRequest();
    if (select.value === 'off') goalDraftView = null;
    select.dataset.edited = 'true'; paintAutomationSwitch();
    const id = selectedId, generation = selectionGeneration;
    const mode = select.value as InputAutomation;
    const opening = id && pendingComposerInputs.find(row => row.sessionId === id && row.opening && !row.deliveredAt && ['queued', 'browser'].includes(row.state));
    if (opening) {
      inputQueueGeneration++;
      opening.automation = mode;
      await run(api.setInputAutomation(opening.id, mode));
      void refreshInputQueue(); return;
    }
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
  paintLoopDeliveryTitle();
  $('loopDelivery').addEventListener('change', async () => {
    const id = selectedId, generation = selectionGeneration;
    const select = $<HTMLSelectElement>('loopDelivery');
    paintLoopDeliveryTitle();
    const opening = id && pendingComposerInputs.find(row => row.sessionId === id && row.opening && !row.deliveredAt && ['queued', 'browser'].includes(row.state));
    if (opening) {
      inputQueueGeneration++;
      opening.loopAfterTurn = select.value === 'after-turn';
      opening.automation = $<HTMLSelectElement>('chatAutomation').value as InputAutomation;
      await run(api.setInputAutomation(opening.id, opening.automation, opening.loopAfterTurn));
      void refreshInputQueue(); return;
    }
    if (!id) {
      const pending = pendingNewInput;
      if (pending?.generation === generation)
        await run(api.setInputAutomation(pending.id, $<HTMLSelectElement>('chatAutomation').value as InputAutomation, select.value === 'after-turn'));
      return;
    }
    select.disabled = true;
    try { await run(api.setSessionAutomation(id, $<HTMLSelectElement>('chatAutomation').value as InputAutomation, select.value === 'after-turn')); }
    finally {
      select.disabled = false;
      if (id === selectedId && generation === selectionGeneration) void refreshSessionControls();
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
        if (!settings) { toast(t('Reload model choices and select an available model and thinking effort before sending.')); return; }
        closeObjectiveEditor();
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
          const entry: InputEntry = { id: inputId, sessionId: null, projectId, text: opening.reply, objective: draft.trim(), authoredSource: 'objective', automation: mode,
            loopAfterTurn: openingLoopDelivery(),
            mode: 'auto', dueAt, model, reasoningEffort, state: 'queued', owner: null, createdAt: dueAt, conversationId: null };
          startingInputs.set(inputId, entry); pendingNewInput = { id: inputId, generation: selection };
          goalProgress = { requestId, selection, inputId, phase: 'queued', text: '' }; paintDeliveryControls();
          try {
            const accepted = await run(api.sendInput(entry));
            if (accepted) { inputQueueGeneration++; pendingComposerInputs = [...pendingComposerInputs.filter(row => row.id !== inputId), accepted];
              // Off may arrive while sendInput is still validating/enqueuing, before
              // the outbox row exists. Reconcile that same pending intent after acceptance.
              if (selectionGeneration === selection && pendingNewInput?.id === inputId &&
                  (automation.value !== mode || openingLoopDelivery() !== entry.loopAfterTurn))
                await run(api.setInputAutomation(inputId, automation.value as InputAutomation, openingLoopDelivery()));
              await adoptAcceptedOpening(accepted);
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
      closeObjectiveEditor();
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
  const appendImages = (owner: ComposerDraftOwner, chosen: InputAttachment[] | null | undefined): boolean => {
    if (!chosen?.length) return false;
    if (!ownsComposerDraft(owner)) { toast(t("Files were not added because the draft changed.")); return false; }
    const combined = [...(imageDrafts.get(owner.key) ?? []), ...chosen];
    if (combined.length > 20 || combined.reduce((sum, file) => sum + ('size' in file ? file.size : 0), 0) > 512 * 1024 * 1024) { toast(t("Attach up to 20 files and 512 MB per message")); return false; }
    imageDrafts.set(owner.key, combined); paintComposerImages();
    return true;
  };
  filePanel = createFilePanel({
    host: chatHost, mount: docks.body,
    onShow: () => { agentPanel?.hide(); docks.adopt('files'); },
    onOpenChanges: () => docks.activate('review'),
    onEscape: () => { docks.setOpen(false); docks.rightToggle.focus(); },
    captureAttachment: () => {
      const owner = composerDraftOwner();
      return attachment => appendImages(owner, [attachment]);
    }
  });
  filePanel.update(selectedLocalProject());
  reviewPanel = createFilePanel({
    host: chatHost, mount: docks.body, reviewOnly: true,
    onShow: () => docks.adopt('review'),
    onEscape: () => { docks.setOpen(false); docks.rightToggle.focus(); }
  });
  reviewPanel.update(selectedLocalProject());
  workspaceTerminal = createWorkspaceTerminal(() => docks.toggleBottomTerminal(), docks.bottomBody,
    { onEmpty: () => docks.setBottomOpen(false), onClosePanel: () => docks.setBottomOpen(false) });
  workspaceTerminal.update(selectedLocalProject());
  rightWorkspaceTerminal = createWorkspaceTerminal(() => docks.toggleBottomTerminal(), docks.body,
    { id: 'workspaceTerminalRight', dockedTabs: true, onTabsChanged: () => docks.sync() });
  rightWorkspaceTerminal.update(selectedLocalProject());
  docks.register('review', 'Review', 'i-git-diff', mount => {
    reviewPanel?.mountAt(mount); void reviewPanel?.show();
  }, () => reviewPanel?.hide(), () => selectedLocalProject() !== null);
  docks.registerTerminal({
    show: (mount, createIfEmpty) => rightWorkspaceTerminal?.show(mount, createIfEmpty),
    hide: () => rightWorkspaceTerminal?.hide(), canCreate: () => true,
    newTab: () => rightWorkspaceTerminal?.newTab() ?? null,
    tabs: () => rightWorkspaceTerminal?.tabs() ?? [],
    selectTab: id => rightWorkspaceTerminal?.selectTab(id), closeTab: id => rightWorkspaceTerminal?.closeTab(id)
  }, {
    show: (mount, createIfEmpty) => workspaceTerminal?.show(mount, createIfEmpty),
    hide: () => workspaceTerminal?.hide()
  });
  docks.register('files', 'Files', 'i-folder', mount => {
    filePanel?.mountAt(mount); void filePanel?.show();
  }, () => filePanel?.hide(), () => selectedLocalProject() !== null);
  docks.register('agents', 'Sub-agents', 'i-agents', () => agentPanel?.show(), () => agentPanel?.hide(), () => selectedId !== null);
  $('attachImages').addEventListener('click', async () => {
    const owner = composerDraftOwner();
    appendImages(owner, await run(api.chooseFiles()));
  });
  skillPicker = initSkills({ input: $<HTMLTextAreaElement>('chatInput'), host: $('skillPicker'),
    openButton: $('composerSkills'), addButton: $('composerAddSkill'),
    selectedHost: $('composerSelectedSkills'), owner: () => `${draftKey()}:${composerDraftGeneration}`,
    scope: () => ({ sessionId: selectedId, projectId: selectedLocalProject()?.id ?? selectedProjectId }),
    draft: () => inputDrafts.get(draftKey()), saveDraft: text => inputDrafts.set(draftKey(), text),
    list: scope => api.skillLibrary(scope), command: name => {
      if (name === 'plan') { $('createPlan').click(); return; }
      if (name === 'compact') { $('compactSession').click(); return; }
      const automation = $<HTMLSelectElement>('chatAutomation'); automation.value = name;
      automation.dispatchEvent(new Event('change', { bubbles: true }));
    } });
  skillPicker.restore();
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
    if (!event.dataTransfer?.types.some(type => type === 'text/plain') || event.dataTransfer.types.includes('Files')) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
  });
  $('composer').addEventListener('drop', async event => {
    if (!event.dataTransfer?.types.some(type => type === 'text/plain') || event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    const text = event.dataTransfer.getData('text/plain'), owner = composerDraftOwner();
    if (text) { const file = await run(api.attachText(text)); if (file) appendImages(owner, [file]); }
  });
  window.addEventListener('paste', async event => {
    const files = Array.from(event.clipboardData?.files ?? []).filter(file => file.type.startsWith('image/'));
    if (!files.length) return;
    event.preventDefault();
    const owner = composerDraftOwner();
    if (files.length + (imageDrafts.get(owner.key)?.length ?? 0) > 20) { toast(t('Attach up to 20 files per message')); return; }
    appendImages(owner, await run(api.dropFiles(files)));
  });
  window.addEventListener('dragover', event => {
    if ((event.target as Element | null)?.closest?.('#foldersCard') || !event.dataTransfer?.types?.includes?.('Files')) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', async event => {
    if ((event.target as Element | null)?.closest?.('#foldersCard') || !event.dataTransfer?.types?.includes?.('Files')) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files), owner = composerDraftOwner();
    if (!files.length) return;
    if (files.length + (imageDrafts.get(owner.key)?.length ?? 0) > 20) { toast(t('Attach up to 20 files per message')); return; }
    appendImages(owner, await run(api.dropFiles(files)));
  });
  api.onWriteSession?.(id => { selectSession(id); $<HTMLTextAreaElement>('chatInput').focus(); });
  $('newChat').addEventListener('click', () => {
    selectNewChat();
  });
  $('addProject').addEventListener('click', async event => {
    event.preventDefault();
    const button = $<HTMLButtonElement>('addProject'); button.disabled = true;
    const generation = selectionGeneration;
    try {
      const project = await run(api.addProject());
      if (!project) return;
      // The picker published a newer durable catalog. A list refresh started before it
      // may still return an empty catalog and otherwise erase this sidebar group.
      ++sessionsLoadGeneration;
      projects = [...projects.filter(row => row.id !== project.id), project];
      expandedProjects.add(project.id);
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
    const hasText = !!authoredComposerText().trim();
    const plan = taskPlans.get(draftKey());
    if (plan && !plan.stages && plan.requestId) {
      cancelTaskPlan();
      if (hasText) taskPlans.set(draftKey(), { text: '', requestId: null, stages: null, sending: false, progress: null, error: null });
    }
    paintDeliveryControls(); paintTaskActions();
  });
  $('chatInput').addEventListener('keydown', (event) => {
    if (skillPicker?.keydown(event)) return;
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (currentPreparedPlan() || authoredComposerText().trim() || imageDrafts.get(draftKey())?.length) $<HTMLFormElement>('composer').requestSubmit(); }
  });
  $('composerSettings').addEventListener('toggle', paintTaskActions);
  $('composerSettings').querySelector('summary')!.addEventListener('click', () => {
    // Retain the same contents through closing; switching views here on close
    // would flash the task editor during the exit transition.
    if (!$<HTMLDetailsElement>('composerSettings').open) {
      $('composerSettings').classList.add('mode-picker');
      if (objectiveEditMode) { objectiveEditMode = null; paintAutomationSwitch(); }
    }
  });
  initContextMeter();
  {
    // Only the reader's own scrolling releases the send hold: the wheel, touch, scrolling keys and
    // the scrollbar itself. Clicking content (a tool group, a call's details, a link) never does,
    // nor does a key that acts on a focused control (Space toggling a disclosure), nor
    // programmatic scrolling.
    const pane = $('chatBody');
    let intent: { generation: number; scrolled: boolean } | null = null;
    let heldPointer: { id: number; generation: number; middle: boolean; released: boolean } | null = null;
    let intentFrame: number | null = null;
    const clearIntent = (): void => {
      intent = null;
      heldPointer = null;
      if (intentFrame !== null) window.cancelAnimationFrame(intentFrame);
      intentFrame = null;
    };
    const noteIntent = (): void => {
      if (heldPointer && heldPointer.generation !== selectionGeneration) heldPointer = null;
      const owner = intent?.generation === selectionGeneration ? intent : { generation: selectionGeneration, scrolled: false };
      intent = owner;
      if (intentFrame !== null) window.cancelAnimationFrame(intentFrame);
      // Scroll events precede animation-frame callbacks. A slow/hidden rendering opportunity
      // must not age out real input; input that did not move anything expires at that frame.
      intentFrame = window.requestAnimationFrame(() => {
        intentFrame = null;
        if (intent === owner && !owner.scrolled && heldPointer?.generation !== owner.generation) intent = null;
      });
    };
    const scrollKeys = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
    pane.addEventListener('wheel', noteIntent, { passive: true });
    pane.addEventListener('touchmove', noteIntent, { passive: true });
    pane.addEventListener('keydown', event => {
      if (scrollKeys.has(event.key) && !(event.target as Element).closest('summary, button, a, input, textarea, select, [contenteditable]')) noteIntent();
    });
    // The scrollbar itself, and middle-button autoscroll, which starts anywhere over the content.
    pane.addEventListener('pointerdown', event => {
      // A second middle click only cancels the toggle. A new scrollbar press may itself
      // move the viewport, so retire the old owner before classifying that new input.
      if (heldPointer?.released && heldPointer.generation === selectionGeneration) {
        clearIntent();
        if (event.button === 1) return;
      }
      if (event.target !== pane && event.button !== 1) return;
      const middle = event.button === 1 && pane.scrollHeight > pane.clientHeight &&
        !(event.target as Element).closest('a, button, input, textarea, select, [contenteditable]');
      heldPointer = { id: event.pointerId, generation: selectionGeneration, middle, released: false };
      noteIntent();
    }, { passive: true, capture: true });
    const releasePointer = (event: PointerEvent): void => {
      if (heldPointer?.id !== event.pointerId) return;
      const generation = heldPointer.generation;
      // Chromium's middle-click toggle starts moving after the button was released in its
      // deadzone. Keep that pending input until its first scroll, or an explicit cancellation.
      if (heldPointer.middle && !intent?.scrolled && event.type === 'pointerup') {
        heldPointer.released = true;
        return;
      }
      heldPointer = null;
      if (intent?.generation === generation && (!intent.scrolled || event.type === 'pointercancel')) clearIntent();
    };
    window.addEventListener('pointerup', releasePointer, { passive: true });
    window.addEventListener('pointercancel', releasePointer, { passive: true });
    window.addEventListener('blur', () => { if (heldPointer) clearIntent(); });
    window.addEventListener('pointerdown', event => {
      if (heldPointer?.released && !pane.contains(event.target as Node)) clearIntent();
    }, { passive: true, capture: true });
    window.addEventListener('keydown', event => { if (event.key === 'Escape' && heldPointer?.released) clearIntent(); }, { capture: true });
    pane.addEventListener('scroll', () => {
      if (intent?.generation === selectionGeneration) {
        intent.scrolled = true;
        if (heldPointer?.released) heldPointer = null;
        // The absolute end, reserve included: scrolling up out of an underfilled page's blank
        // space is reading too, and must not be pulled back down by the next delivery.
        readerAtEnd = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2;
        if (sendAnchor) { sendAnchor = null; readingAfterSend = true; }
        if (readingAfterSend && distanceFromTail() <= 1) readingAfterSend = false;
      }
      paintJumpLatest();
    }, { passive: true });
    // Keep a smooth/inertial gesture through its final position, then retire its authority.
    pane.addEventListener('scrollend', () => {
      if (intent && heldPointer?.generation === intent.generation) intent.scrolled = false;
      else clearIntent();
    }, { passive: true });
    const dock = el('div', 'jump-latest-dock');
    const jump = el('button', 'jump-latest') as HTMLButtonElement;
    jump.id = 'jumpLatest'; jump.type = 'button'; jump.append(icon('i-arrow-down'));
    ui(jump, 'title', () => t('Jump to latest')); ui(jump, 'aria-label', () => t('Jump to latest'));
    jump.addEventListener('click', jumpToLatest);
    dock.append(jump); pane.append(dock);
  }
  $('createPlan').addEventListener('click', () => {
    // The toolbar toggle only arms planning; Send/Enter generates from the draft.
    if (taskPlans.has(draftKey())) cancelTaskPlan();
    else { taskPlans.set(draftKey(), { text: '', requestId: null, stages: null, sending: false, progress: null, error: null }); paintTaskPlan(); $('chatInput').focus(); }
  });
  $('composer').addEventListener('submit', (event) => {
    event.preventDefault();
    const controlAction = event.submitter === $('chatSend') && $('chatSend').dataset.action === 'stop';
    if (currentPreparedPlan()) void sendPreparedPlan();
    else if (taskPlans.has(draftKey())) {
      if (!$('createPlan').dataset.busy) void createTaskPlan(deps.state()?.config.ui.planBackend ?? 'chatgpt');
    } else void sendComposer(undefined, undefined, undefined, controlAction);
  });

  $('sessionList').addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-id]');
    if (!row?.dataset.id || row.dataset.id === selectedId) return;
    pendingNewInput = null;
    selectSession(row.dataset.id);
  });
  $('sessionList').addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || !['Enter', ' '].includes(event.key)) return;
    const target = event.target as HTMLElement;
    const control = target.closest<HTMLElement>('[data-session-select]');
    const row = control?.closest<HTMLElement>('[data-id]');
    if (!control || target !== control || !row?.dataset.id) return;
    event.preventDefault();
    if (row.dataset.id === selectedId) return;
    pendingNewInput = null;
    selectSession(row.dataset.id);
  });
  $('sessionList').closest<HTMLElement>('.scroll')?.addEventListener('scroll', maybePageSessions);
  // Prefetch the visible edge, retaining direction across collapsed batches.
  // Layout restoration alone never starts another history read.
  const historyPane = $('chatBody');
  let pendingScrollDirection = 0;
  historyPane.addEventListener('wheel', event => {
    pendingScrollDirection = Math.sign(event.deltaY);
    requestHistory(pendingScrollDirection);
  }, { passive: true });
  let pointerScrollTop: number | null = null;
  historyPane.addEventListener('pointerdown', () => { pointerScrollTop = historyPane.scrollTop; });
  window.addEventListener('pointerup', () => { pointerScrollTop = null; });
  historyPane.addEventListener('keydown', event => {
    pendingScrollDirection = ['ArrowUp', 'PageUp', 'Home'].includes(event.key) ? -1 : ['ArrowDown', 'PageDown', 'End'].includes(event.key) ? 1 : 0;
    requestHistory(pendingScrollDirection);
  });
  historyPane.addEventListener('scroll', () => {
    if (pointerScrollTop !== null) {
      const direction = Math.sign(historyPane.scrollTop - pointerScrollTop);
      pointerScrollTop = historyPane.scrollTop;
      requestHistory(direction);
    } else if (pendingScrollDirection) {
      const direction = pendingScrollDirection;
      pendingScrollDirection = 0;
      requestHistory(direction);
    }
    if (historyDemand) void fillTimelineHistory();
  }, { passive: true });
  // The visible chat area also shrinks without new content: opening the bottom terminal or a
  // side panel, or a growing message box. Use the reader's existing intent here too: explicit
  // round inspection releases following even when its indicator was reached at the tail.
  if (typeof ResizeObserver === 'function') {
    let lastHeight = historyPane.clientHeight;
    new ResizeObserver(() => {
      const height = historyPane.clientHeight;
      if (height !== lastHeight && readerAtEnd && !sendAnchor && !readingAfterSend) historyPane.scrollTop = historyPane.scrollHeight;
      lastHeight = height;
    }).observe(historyPane);
  }
  $('timeline').addEventListener('click', event => {
    // Disclosure changes deliberately change geometry. Padding retained for an
    // earlier reconciliation is not part of the collapsed headline's height.
    // A held sent message keeps its padding: the hold measures it again once the disclosure moved.
    if (!sendAnchor && (event.target as Element).closest('summary')) $('timelineContent').style.removeProperty('--timeline-scroll-reserve');
  });
  // Opening a disclosure or resizing the window changes geometry between repaints. Observing the
  // content and the pane corrects the hold after layout and before paint, so the held message never
  // shows a clamped frame.
  if (typeof ResizeObserver === 'function') {
    // Content height at the last observation. Following needs real growth: at a fractional zoom a
    // badge can move the height by a rounding pixel, and following that moved every message.
    let observedHeight = $('chatBody').scrollHeight;
    const observer = new ResizeObserver(() => {
      holdSentMessage();
      // Growth that no repaint saw (a row expanding, an image loading, streamed text): follow it
      // while the reader is at the end. Older history pages never follow.
      const pane = $('chatBody');
      const grew = pane.scrollHeight - observedHeight >= ROUNDING_PX;
      observedHeight = pane.scrollHeight;
      if (grew && followOutput() && readerAtEnd && !sendAnchor && !readingAfterSend && historyBefore === null &&
          distanceFromTail() >= ROUNDING_PX) {
        pane.scrollTop = pane.scrollHeight;
        paintJumpLatest();
      }
    });
    observer.observe($('timelineContent')); observer.observe($('chatBody'));
  } else $('timeline').addEventListener('toggle', () => { holdSentMessage(); }, true);

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

  $('chatRefresh').addEventListener('click', event => { event.preventDefault(); void refreshAll(); });

  $('copyHandoff').addEventListener('click', async () => {
    if (!handoff) return;
    const copied = await run(api.writeClipboard(handoff.text));
    if (copied) toast(t('Handoff copied'));
  });

  $('swarmReset').addEventListener('click', async () => {
    // Permanent, like removing recorded images: ask first. A misclick used to end running
    // workers and delete every worker history at once.
    if (!window.confirm(t('Clear all workers? Running workers stop, and their saved histories are removed for good. Their chats stay in ChatGPT.'))) return;
    const state = await run(api.resetSwarm());
    if (state) {
      paintSwarm(state);
      toast(t('Workers cleared'));
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
        ? t('Run cleared — every worker ended')
        : outcome.cleared === 'worker'
          ? t('{0} cleared — its slot is free', [id])
          : t(outcome.reason)
    );
  });

  for (const id of CHAT_INPUTS) {
    $(id).addEventListener('change', () => void deps.save());
  }

  wireGoal(() => deps.save());

  $('bridgeUnpair').addEventListener('click', async () => {
    const state = await run(api.unpairExtension());
    if (state) toast(t('Browser disconnected'));
  });
  $('bridgeFolder').addEventListener('click', async () => {
    const dir = await run(api.openExtensionFolder());
    if (dir) toast(t('Extension folder opened'));
  });

  api.onSessionChanged(scheduleReload);
  api.onBackgroundProcessesChanged(refreshBackgroundProcesses);
  api.onTaskProgress(progress => {
    if (!goalProgress || progress.requestId !== goalProgress.requestId || goalProgress.selection !== selectionGeneration) return;
    Object.assign(goalProgress, progress); paintGoalProgress();
  });
  api.onSwarmChanged(paintSwarm);
}
