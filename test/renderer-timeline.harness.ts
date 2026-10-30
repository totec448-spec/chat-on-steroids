/**
 * Shared setup for the renderer-timeline.*.test.ts files: the helpers that used to sit between the tests
 * of renderer-timeline.test.ts. The tests were split into parts so vitest can run them in parallel.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { Lexer } from 'marked';
import { afterEach, expect, vi } from 'vitest';
import { DEFAULT_GOAL_SYSTEM_PROMPT } from '../src/shared/goal.js';
import { defaultAppearance } from '../src/shared/appearance.js';
import { prependUserPrompt } from '../src/shared/user-prompt.js';
import type { Handoff, SessionEvent, SessionSummary } from '../src/shared/session.js';
import { BOOKMARK_EXCERPT_MAX } from '../src/shared/session.js';
import type { InputArgs, InputEntry } from '../src/main/session/input.js';
import type { LocalProject } from '../src/shared/projects.js';
import { positionOf, projectTimeline, residenceOf } from '../src/shared/chronology.js';

/**
 * `vi.waitFor` with room for the slow release runners (Intel macOS, Linux arm64): its default second
 * can run out before the renderer has answered, which fails a test without a bug.
 */
export const waitFor = <T>(check: () => T | Promise<T>, options: { timeout?: number; interval?: number } = {}) =>
  vi.waitFor(check, { timeout: 10_000, ...options });


/**
 * The session timeline as the user reads it while a chat is running.
 *
 * Two things went wrong in the 2026-09-02 test run that only this view can show. A Compact &
 * Resume was recorded as four long rows in observation order — brief request, brief, "handoff
 * saved", bootstrap — that read as three unrelated things. And every repaint rebuilt the whole
 * list, so a tool row the user had unfolded closed again (its `<details>` was a new node) and
 * the scroller jumped while the chat kept appending. Both are checked here against the real
 * renderer booted into jsdom.
 */

export let dom: JSDOM | null = null;
/** Closes the booted window, for a test that boots a second one. */
export function closeDom(): void {
  dom?.window.close();
  dom = null;
}
afterEach(() => {
  closeDom();
  vi.resetModules();
});

export const TOKEN = 'tok_0123456789abcdef';
export const T0 = Date.UTC(2026, 8, 2, 0, 50, 0);

export function text(value: string) {
  return { text: value, truncated: false, chars: value.length };
}

export function summary(events: SessionEvent[]): SessionSummary {
  return {
    id: '2026-09-02-test0001',
    title: 'Loop under test',
    conversationId: 'chat-b',
    selectedModel: { conversationId: 'chat-b', model: 'gpt-5.6-sol', reasoningEffort: 'high', observedAt: T0 },
    chatIds: ['chat-a', 'chat-b'],
    startedAt: T0,
    updatedAt: T0 + 120_000,
    endedAt: null,
    events: events.length,
    userMessages: 2,
    toolCalls: 1,
    lastToolCallAt: null,
    processExitNonzero: 0,
    toolRejected: 0,
    toolInternalErrors: 0,
    errors: 0,
    estimatedTokens: 12_000,
    contextTokens: 900,
    lastHandoffId: null,
    lastHandoffAt: null,
    lastTurnOutcome: null,
    activeTurnId: null,
    agents: [],
    origin: null
  };
}

export function toolCall(seq: number, callId: string): SessionEvent {
  return {
    seq,
    time: T0 + seq * 1000,
    source: 'mcp',
    kind: 'tool_call',
    call: {
      callId,
      tool: 'read',
      attribution: 'request_id',
      requestId: `req-${callId}`,
      conversationId: 'chat-a',
      attributionMethod: 'request_id',
      args: text('{"path":"README.md"}'),
      result: text('# Chat On Steroids'),
      outcome: 'ok',
      durationMs: 40,
      summary: { kind: 'read', title: 'Read README.md', tone: 'neutral' }
    }
  };
}

/**
 * The rows the recorder writes for one Compact & Resume, in the order it observes them.
 *
 * `escaped` is how ChatGPT's composer records the same two prompts since 2026-09-16: it
 * round-trips inserted text through its own Markdown serializer, which escapes ASCII
 * punctuation, so the marker arrives as `[[CLF-RESUME\:<token>]]`. These are the exact shapes
 * read back out of a live install's session store.
 */
export function compaction(seq: number, escaped = false): SessionEvent[] {
  const mark = (kind: 'HANDOFF' | 'RESUME') =>
    escaped ? `[[CLF-${kind}\\:${TOKEN}]]` : `[[CLF-${kind}:${TOKEN}]]`;
  return [
    {
      seq,
      time: T0 + seq * 1000,
      source: 'extension',
      kind: 'user_message',
      messageId: 'm-brief-request',
      turnId: 'turn-brief',
      message: text(`${mark('HANDOFF')} Write the handoff brief for this session.`)
    },
    { seq: seq + 1, time: T0 + (seq + 1) * 1000, source: 'extension', kind: 'turn_start', turnId: 'turn-brief' },
    {
      seq: seq + 2,
      time: T0 + (seq + 2) * 1000,
      source: 'extension',
      kind: 'assistant_message',
      messageId: 'm-brief',
      turnId: 'turn-brief',
      message: text('# Brief\n\nGoal: keep the loop running.'),
      state: 'final',
      final: true
    },
    {
      seq: seq + 3,
      time: T0 + (seq + 3) * 1000,
      source: 'extension',
      kind: 'turn_end',
      turnId: 'turn-brief',
      outcome: 'completed'
    },
    { seq: seq + 4, time: T0 + (seq + 4) * 1000, source: 'app', kind: 'handoff', handoffId: 'h-1', chars: 44, reason: 'auto' },
    {
      seq: seq + 5,
      time: T0 + (seq + 5) * 1000,
      source: 'extension',
      kind: 'user_message',
      messageId: 'm-bootstrap',
      message: text(`${mark('RESUME')} Continue from this brief: keep the loop running.`)
    }
  ];
}

export async function settle(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** History paging yields to the browser frame after each bounded read. Timer
 * ticks alone can all finish before that frame on Linux and macOS. */
export async function settleHistoryFrame(w: Pick<Window, 'requestAnimationFrame'>): Promise<void> {
  await settle();
  await new Promise<void>(resolve => w.requestAnimationFrame(() => resolve()));
  await settle();
}

export async function boot(events: SessionEvent[], selectExisting = true, pausedHelpers: Array<{ id: string; sourceSessionId: string }> = [], projects: LocalProject[] = [], options: { origin?: SessionSummary["origin"]; developerMode?: boolean; playfulStatus?: boolean; announceTurns?: boolean; followOutput?: boolean; followUp?: 'steer' | 'queue'; enterSends?: boolean; sessions?: SessionSummary[]; pro?: boolean; astra?: boolean; reserveOpenings?: boolean; handoff?: Handoff | null; deferProcessStop?: boolean; defaultChatModel?: string; noModels?: boolean; approvalCard?: () => unknown; answerApproval?: (id: string, cardId: string, choice: string) => unknown; summary?: Partial<SessionSummary>; holdInputs?: Promise<void>; storage?: Record<string, string>; inbox?: boolean } = {}) {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  Object.assign(globalThis, {
    window: w,
    Event: w.Event,
    document: w.document,
    HTMLElement: w.HTMLElement,
    Element: w.Element,
    Node: w.Node,
    DocumentFragment: w.DocumentFragment,
    HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement,
    HTMLButtonElement: w.HTMLButtonElement
  });
  if (!(w.HTMLElement.prototype as any).scrollIntoView) (w.HTMLElement.prototype as any).scrollIntoView = () => {};
  // What an earlier run of the app left in this window's storage.
  for (const [key, value] of Object.entries(options.storage ?? {})) w.localStorage.setItem(key, value);

  const config = {
    roots: [{ name: 'repo', path: 'C:\\repo' }],
    readOnly: true,
    capabilities: {
      browse: true, search: true, read: true, metadata: true,
      create: false, edit: false, move: false, deleteFile: false, command: false,
      screen: false, control: false, clipboardRead: false, clipboardWrite: false
    },
    commandAllowlist: { enabled: false, mode: 'allow' as const, rules: [] as string[] },
    tunnel: { kind: 'openai', tunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', desktopTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: true, autoConnect: false, privacyScreenshots: false, theme: 'light', developerMode: options.developerMode ?? false, playfulStatus: options.playfulStatus ?? false, ...(options.announceTurns === undefined ? {} : { announceTurns: options.announceTurns }), ...(options.followOutput === undefined ? {} : { followOutput: options.followOutput }), ...(options.followUp === undefined ? {} : { followUp: options.followUp }), ...(options.enterSends === undefined ? {} : { enterSends: options.enterSends }),
      ...(options.defaultChatModel ? { defaultChatModel: options.defaultChatModel, defaultChatReasoning: 'high' } : {}),
      ...(options.inbox ? { appearance: { ...defaultAppearance(), sidebarLayout: 'inbox' as const } } : {}) },
    sessions: { record: true, retainDays: 30, advisoryTokens: 300000, limitTokens: 400000 },
    compaction: { auto: true, autoTokens: 300000 },
    multiAgent: { enabled: false, maxWorkers: 2, allowUnattributedCalls: false, recoverAgentTabs: true },
    goal: { enabled: false, model: 'deepseek/deepseek-v4-flash', reasoning: 'default' as const, prompt: DEFAULT_GOAL_SYSTEM_PROMPT }
  };
  const state = {
    config,
    status: { state: 'disconnected', detail: '', publicUrl: null, localUrl: null, handshakeAt: null, lastRequestAt: null, lastToolCallAt: null, health: null, surfaces: [] },
    hasApiKey: false,
    hasGoalKey: false,
    resolvedBinary: null,
    bundledTunnelVersion: null,
    bridge: { running: true, port: 8765, paired: false, present: false, lastSeenAt: null, extensionVersion: null },
    update: { current: '2.0.3', latest: null, stage: 'idle', error: null, checkedAt: null }
  };
  const ok = (data: any) => Promise.resolve({ ok: true, data });
  const bootOptions = options;
  const live = { events: [...events], inputs: [] as InputEntry[], sent: [] as InputArgs[], automation: 'off', controlCalls: [] as Array<{ id: string; action: string }>, compacting: false, finishHeld: true };
  let sessionListener: (change?: unknown) => void = () => undefined;
  let writeSessionListener: (id: string) => void = () => undefined;
  let backgroundProcessListener: () => void = () => undefined;
  let backgroundProcesses: Array<{ processId: number; incarnation: number; command: string; startedAt: number; tty: boolean }> = [];
  let resolveBackgroundStop: (() => void) | null = null;
  const taskProgressListeners = new Set<(progress: any) => void>();
  const api: any = new Proxy(
    {
      getState: () => ok(state),
      getChatModels: () => options.noModels ? ok({ state: 'unavailable', requestedAt: 1, observedAt: null, models: [] }) : ok({ state: 'ready', requestedAt: 1, observedAt: Date.now(), models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: options.pro ? ['high', 'pro'] : ['none', 'high'] },
        ...(options.astra ? [{ id: 'gpt-6-pro', label: 'GPT-6 Pro', efforts: ['pro'] }] : [])] }),
      getSessionControls: (id: string) => ok({ sessionId: id, conversationId: 'chat-a', automation: live.automation, activeTurnId: 'held-turn', finishHeld: live.finishHeld, blocked: '', job: live.compacting ? { busy: true } : null }),
      releaseSessionFinish: (id: string, turn: string) => { live.controlCalls.push({ id, action: `release:${turn}` }); live.finishHeld = false; return ok({}); },
      setSessionAutomation: (id: string, action: string) => { live.controlCalls.push({ id, action }); live.automation = action; return ok({}); },
      compactSession: (id: string) => { live.controlCalls.push({ id, action: 'compact' }); live.compacting = true; return ok({}); },
      cancelSessionCompaction: (id: string) => { live.controlCalls.push({ id, action: 'cancel' }); live.compacting = false; return ok({}); },
      resumeFromHandoff: (id: string, handoffId: string) => { live.controlCalls.push({ id, action: `resume:${handoffId}` }); return ok({}); },
      getLog: () => ok([]),
      getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
      onStateChanged: () => () => undefined,
      onTaskProgress: (listener: (progress: any) => void) => { taskProgressListeners.add(listener); return () => taskProgressListeners.delete(listener); },
      draftGoalOpening: (text: string) => ok({ reply: `Start: ${text}`, model: 'fixture' }),
      onLogEntry: () => () => undefined,
      onSwarmChanged: () => () => undefined,
      onSessionChanged: (fn: any) => {
        sessionListener = fn;
        return () => undefined;
      },
      onWriteSession: (fn: (id: string) => void) => {
        writeSessionListener = fn;
        return () => undefined;
      },
      listSessions: () => {
        const sessions = options.sessions ?? [{ ...summary(live.events), ...options.summary, ...(options.origin ? { origin: options.origin } : {}), ...(projects[0] ? { projectId: projects[0].id } : {}) }];
        const known = new Set(sessions.map(row => row.id));
        const openings = live.inputs.filter(row => row.opening && row.sessionId && !known.has(row.sessionId)).map(row => ({
          ...summary(live.events), id: row.sessionId!, title: row.text, conversationId: null, chatIds: []
        }));
        return ok({ sessions: [...openings, ...sessions], activeId: summary(live.events).id, pressure: [] });
      },
      listProjects: () => ok(projects),
      // IPC snapshots cannot share the backend's mutable array with the renderer.
      // `holdInputs`: the outbox read answers only once it resolves, like a slow first read after launch.
      listInputs: () => options.holdInputs ? options.holdInputs.then(() => ok(structuredClone(live.inputs))) : ok(structuredClone(live.inputs)),
      cancelInput: vi.fn((id: string) => {
        const entry = live.inputs.find(row => row.id === id);
        if (!entry) return ok(false);
        entry.state = 'cancelled'; entry.cancelledByUser = true;
        return ok(true);
      }),
      runningTools: () => ok([]),
      runningProcesses: () => ok(structuredClone(backgroundProcesses)),
      stopProcess: vi.fn(async (_sessionId: string, processId: number, incarnation: number) => {
        if (options.deferProcessStop) await new Promise<void>(resolve => { resolveBackgroundStop = resolve; });
        backgroundProcesses = backgroundProcesses.filter(row => row.processId !== processId || row.incarnation !== incarnation);
        backgroundProcessListener();
        return { ok: true, data: true };
      }),
      onBackgroundProcessesChanged: (listener: () => void) => {
        backgroundProcessListener = listener;
        return () => undefined;
      },
      approvalCard: () => ok(options.approvalCard?.() ?? null),
      answerApproval: (id: string, cardId: string, choice: string) => ok(options.answerApproval?.(id, cardId, choice) ?? { ok: true }),
      turnTraces: () => ok({}), listPausedHelpers: () => ok(pausedHelpers),
      retryHelper: (id: string, sourceSessionId: string) => {
        live.controlCalls.push({ id: sourceSessionId, action: `retry:${id}` });
        pausedHelpers = pausedHelpers.filter(row => row.id !== id);
        return ok(true);
      },
      sendInput: (input: InputArgs) => {
        live.sent.push(input);
        const row: InputEntry = { ...input, state: 'queued', owner: null, createdAt: Date.now(), conversationId: null };
        if (options.reserveOpenings && input.sessionId === null) Object.assign(row, {
          opening: true, requestedSessionId: null, sessionId: input.id
        });
        if (input.mode === 'finish' && input.stages) {
          row.stagesApplied = true;
          live.inputs.push(row, ...input.stages.map((text, index) => ({ ...row, id: `${input.id}-${index}`, text, stages: undefined })));
          return ok(row);
        }
        live.inputs.push(row);
        return ok(row);
      },
      getSession: (_id: string, options?: { from?: number; before?: number; after?: number; limit?: number }) => {
        const from = options?.from ?? 0;
        // Pages as the store does: by residence (a turn's final answer beside its end). The CI
        // fail-first run executes this file against code without residenceOf; position is its fallback there.
        const residence = residenceOf ?? positionOf;
        const eligible = live.events.filter((event) => event.seq >= from &&
          (options?.before === undefined || residence(event) < options.before) &&
          (options?.after === undefined || residence(event) > options.after))
          .sort((a, b) => options?.from !== undefined ? a.seq - b.seq : residence(a) - residence(b));
        const limit = options?.limit ?? 30;
        const page = options?.after !== undefined || options?.from !== undefined
          ? eligible.slice(0, limit) : eligible.slice(-limit);
        const opening = live.inputs.find(row => row.opening && row.sessionId === _id);
        return ok({
          summary: opening ? { ...summary(live.events), id: _id, title: opening.text, conversationId: null, chatIds: [] }
            : { ...summary(live.events), ...bootOptions.summary, ...(bootOptions.sessions?.find(row => row.id === _id) ?? {}) },
          events: page,
          total: live.events.length,
          nextFrom: page.reduce((max, e) => Math.max(max, e.seq + 1), from)
        });
      },
      getHandoff: (sessionId: string, handoffId: string) => ok(options.handoff?.sessionId === sessionId && options.handoff.id === handoffId ? options.handoff : null)
    },
    {
      get(target, prop) {
        if (prop in target) return (target as any)[prop];
        return (..._args: any[]) => ok(null);
      }
    }
  );
  Object.defineProperty(w, 'api', { value: api, configurable: true });

  await import('../src/renderer/main.js');
  await settle();
  if (selectExisting) {
    (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click();
    await settle();
  }

  return {
    w,
    live,
    // This fixture serves one shared `live.events` for every session id, so a recorder write
    // changes every transcript it can show. Payload-less pushes are catalog/control only.
    notifySession: () => sessionListener({ allTranscripts: true }),
    writeSession: (id: string) => writeSessionListener(id),
    progress: (value: any) => { for (const listener of taskProgressListeners) listener(value); },
    resolveBackgroundStop: () => { const resolve = resolveBackgroundStop; resolveBackgroundStop = null; resolve?.(); },
    async publishBackgroundProcesses(rows: Array<{ processId: number; incarnation: number; command: string; startedAt: number; tty: boolean }>) {
      backgroundProcesses = structuredClone(rows);
      backgroundProcessListener();
      await settle();
    },
    async append(more: SessionEvent[]) {
      live.events.push(...more);
      sessionListener({ allTranscripts: true });
      await settle(500);
    }
  };
}

// #1190: project headings come from the whole project list, chats from the newest page of all
// history. A project whose chats are all older looked empty, and expanding it did nothing.
export async function olderProjectFixture(projectPages?: SessionSummary[][]) {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Older workspace', path: '/fixture', createdAt: 1 };
  const recent = { ...summary([]), id: 'recent-unfiled', projectId: undefined, updatedAt: T0 + 400 };
  const worker = { ...summary([]), id: 'older-worker', projectId: project.id, updatedAt: T0 + 3,
    origin: { kind: 'worker' as const, fromSessionId: 'older-parent', agentId: 'worker-1', task: 'Inspect' } };
  const parent = { ...summary([]), id: 'older-parent', conversationId: 'older-chat', projectId: project.id, updatedAt: T0 + 2 };
  const unused = { ...summary([]), id: 'oldest-unfiled', projectId: undefined, updatedAt: T0 + 1 };
  // The newest page of everything shows no chat of the project; the project's own pages do.
  const all = [[recent], [unused]];
  const own = projectPages ?? [[worker], [parent]];
  const { w, append } = await boot([], false, [], [project], { sessions: [recent] });
  const list = vi.fn(async (options: any) => {
    const pages = options?.projectId === project.id ? own : all;
    const index = options?.cursor ? pages.findIndex(rows => rows.at(-1)?.id === options.cursor.id) + 1 : 0;
    const rows = pages[index] ?? [];
    return { ok: true, data: { sessions: rows, total: 4, nextCursor: index < pages.length - 1 ? { updatedAt: rows.at(-1)!.updatedAt, id: rows.at(-1)!.id } : null,
      activeId: null, pressure: [], blocked: [] } };
  });
  (w as any).api.listSessions = list;
  await append([]); list.mockClear();
  const heading = () => w.document.querySelector('.project-heading') as HTMLElement;
  const projectCalls = () => list.mock.calls.map(([options]) => options).filter(options => options?.projectId);
  return { w, list, heading, parent, worker, own, project, append, projectCalls };
}

/** Opens a project's "⋯" menu; its items live in the document body, outside the repainted sidebar. */
export function projectMenu(w: any, id: string): HTMLButtonElement {
  const button = w.document.querySelector(`.project-group[data-project-id="${id}"] .project-menu`) as HTMLButtonElement;
  button.click();
  return button;
}
export const menuItem = (w: any, action: string): HTMLButtonElement => w.document.querySelector(`.row-menu [data-row-action="${action}"]`) as HTMLButtonElement;
/** Opens the project's Color submenu and returns the choice for `color` ('none' clears it). */
export function colorChoice(w: any, id: string, color: string): HTMLButtonElement {
  projectMenu(w, id);
  menuItem(w, 'color').click();
  return menuItem(w, `color-${color}`);
}

export const PLAYFUL_WORDS = /^(Pumping tokens|Juicing context|Bulking output|Repping prompts|Spotting agents|Loading creatine|Chasing gains|Flexing neurons|TRT mode|Testosterone boost|Tren thoughts|Deca stack|Anavar cutting|Dianabol bulking|Winstrol drying|Primobolan polishing|Pissing OpenAI off a little more|Clauding deez nuts|Warming up the GPUs|Deadlifting the context window|Carb-loading tokens|Doing reps on the repo|Hitting a new PR|Skipping leg day|Pre-workout kicking in|Protein-shaking the stack trace|Benching the build|Spotting the next token|Stretching the attention span|Counting macros|Pumping iron and ideas|Cutting the fluff|Going beast mode|One more set|Oiling up the prompt|Flexing for the mirror|Grinding through the backlog|Chugging creatine|No pain, no merge) for /;

/** A page_tool event, and how a test reads the group title and the latest call's own title. */
export const nativeStep = (seq: number, label: string): SessionEvent => ({ seq, time: T0 + seq * 1000, source: 'extension', kind: 'page_tool', messageId: `note-${seq}`, label });
export const groupTitle = (document: Document) => document.querySelector('#timeline details.tool-group .activity-title')!.textContent;
export const latestCallTitle = (document: Document) => {
  const tool = [...document.querySelectorAll<HTMLElement>('#timeline .ev-tool_call')].at(-1)!;
  return tool.querySelector('.tool > summary b')?.textContent ?? tool.querySelector('.tool > summary span')?.textContent;
};

/** Counts how often the running turn's two lines are taken out of the page and put back. */
export function lineMoves(w: JSDOM['window']): { stop: () => number } {
  let moves = 0;
  const watched = (node: Node) => node instanceof w.HTMLElement && (node.matches('.turn-status') || node.matches('.turn-now'));
  const observer = new w.MutationObserver(records => {
    for (const record of records) for (const node of [...record.addedNodes, ...record.removedNodes]) if (watched(node)) moves++;
  });
  observer.observe(w.document.getElementById('timelineContent')!, { childList: true, subtree: true });
  return { stop: () => { observer.takeRecords().forEach(record => { for (const node of [...record.addedNodes, ...record.removedNodes]) if (watched(node)) moves++; }); observer.disconnect(); return moves; } };
}

// Codex's "Follow-up behavior": messages typed while a turn runs join it, or wait for its end.
// Cmd/Ctrl+Shift+Enter sends the other way.
export async function sendDuringTurn(followUp: 'steer' | 'queue' | undefined, keys: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {}) {
  const app = await boot([], true, [], [], followUp === undefined ? {} : { followUp });
  const api = (app.w as any).api;
  api.getSessionControls = async () => ({ ok: true, data: { sessionId: summary([]).id, activeTurnId: 'running-turn', canInject: false, canSendDirectly: true, queueAtFinish: false } });
  await app.append([]);
  const input = app.w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Also check the logs';
  input.dispatchEvent(new app.w.Event('input', { bubbles: true }));
  input.dispatchEvent(new app.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...keys }));
  await waitFor(() => expect(app.live.sent).toHaveLength(1));
  return { app, sent: app.live.sent[0]! };
}

// A typed app command sent the other way with Cmd/Ctrl+Shift+Enter during a turn went out as a Skill
// directive ("/goal …" as text); it now runs as Enter runs it, and its rest goes the other way.
export async function typedDuringTurn(text: string, skills: Array<{ id: string; name: string }> = []) {
  const app = await boot([], true);
  const api = (app.w as any).api;
  api.getSessionControls = async () => ({ ok: true, data: { sessionId: summary([]).id, automation: app.live.automation, activeTurnId: 'running-turn', canInject: false, canSendDirectly: true, queueAtFinish: false } });
  api.skillLibrary = async () => ({ ok: true, data: { skills: skills.map(skill => ({ ...skill, description: '', path: `/skills/${skill.id}/SKILL.md`, scope: 'user', source: 'user', managed: true })), roots: [], errors: [], includeInstructions: true } });
  await app.append([]);
  const input = app.w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = text;
  input.dispatchEvent(new app.w.Event('input', { bubbles: true }));
  const mac = /^Mac/.test(globalThis.navigator.platform);
  input.dispatchEvent(new app.w.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, ctrlKey: !mac, metaKey: mac, bubbles: true, cancelable: true }));
  await settle(); await settle();
  return { ...app, input };
}

// Codex's slash commands, each opening what the app already has.
export async function slash(command: string, selectExisting = true) {
  const app = await boot([], selectExisting);
  (app.w as any).api.skillLibrary = async () => ({ ok: true, data: { skills: [], roots: [], errors: [], includeInstructions: true } });
  const input = app.w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = `/${command}`; input.setSelectionRange(input.value.length, input.value.length);
  input.dispatchEvent(new app.w.Event('input', { bubbles: true }));
  await settle();
  const row = app.w.document.querySelector<HTMLElement>(`#skillPicker .slash-menu-option[title="/${command}"]`);
  return { ...app, input, row };
}

// 2.1.41 release round: "/goal …" typed or pasted and sent without picking it from the menu went out as
// a Skill named "goal" and failed ("Skill "goal" is unavailable in this project"). A leading app command
// is that command unless a Skill has the name; Goal, Loop and Plan then send the rest as the mode would.
export async function typed(text: string, skills: Array<{ id: string; name: string }> = [], selectExisting = false) {
  const app = await boot([], selectExisting);
  (app.w as any).api.skillLibrary = async () => ({ ok: true, data: { skills: skills.map(skill => ({ ...skill, description: '', path: `/skills/${skill.id}/SKILL.md`, scope: 'user', source: 'user', managed: true })), roots: [], errors: [], includeInstructions: true } });
  const input = app.w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = text;
  app.w.document.getElementById('composer')!.dispatchEvent(new app.w.Event('submit', { bubbles: true, cancelable: true }));
  await settle(); await settle();
  return { ...app, input };
}

// Codex's "Enter key behavior": Enter sends, or Cmd/Ctrl+Enter sends and Enter adds a line.
export async function pressInComposer(enterSends: boolean | undefined, keys: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }) {
  const app = await boot([], true, [], [], enterSends === undefined ? {} : { enterSends });
  const input = app.w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Run the tests';
  input.dispatchEvent(new app.w.Event('input', { bubbles: true }));
  const event = new app.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...keys });
  input.dispatchEvent(event);
  await settle(300);
  return { sent: app.live.sent.length, prevented: event.defaultPrevented };
}

export { fs, path, JSDOM, Lexer, DEFAULT_GOAL_SYSTEM_PROMPT, defaultAppearance, prependUserPrompt, BOOKMARK_EXCERPT_MAX, positionOf, projectTimeline, residenceOf };
export type { Handoff, SessionEvent, SessionSummary, InputArgs, InputEntry, LocalProject };
