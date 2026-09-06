import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_GOAL_SYSTEM_PROMPT } from '../src/shared/goal.js';
import type { SessionEvent, SessionSummary } from '../src/shared/session.js';
import type { InputArgs, InputEntry } from '../src/main/session/input.js';
import type { LocalProject } from '../src/shared/projects.js';

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

let dom: JSDOM | null = null;
afterEach(() => {
  dom?.window.close();
  dom = null;
  vi.resetModules();
});

const TOKEN = 'tok_0123456789abcdef';
const T0 = Date.UTC(2026, 8, 2, 0, 50, 0);

function text(value: string) {
  return { text: value, truncated: false, chars: value.length };
}

function summary(events: SessionEvent[]): SessionSummary {
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

function toolCall(seq: number, callId: string): SessionEvent {
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

/** The rows the recorder writes for one Compact & Resume, in the order it observes them. */
function compaction(seq: number): SessionEvent[] {
  return [
    {
      seq,
      time: T0 + seq * 1000,
      source: 'extension',
      kind: 'user_message',
      messageId: 'm-brief-request',
      turnId: 'turn-brief',
      message: text(`[[CLF-HANDOFF:${TOKEN}]] Write the handoff brief for this session.`)
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
      message: text(`[[CLF-RESUME:${TOKEN}]] Continue from this brief: keep the loop running.`)
    }
  ];
}

async function settle(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function boot(events: SessionEvent[], selectExisting = true, pausedHelpers: Array<{ id: string; sourceSessionId: string }> = [], projects: LocalProject[] = [], options: { origin?: SessionSummary["origin"]; developerMode?: boolean; sessions?: SessionSummary[] } = {}) {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
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

  const config = {
    roots: [{ name: 'repo', path: 'C:\\repo' }],
    readOnly: true,
    capabilities: {
      browse: true, search: true, read: true, metadata: true,
      create: false, edit: false, move: false, deleteFile: false, command: false,
      screen: false, control: false, clipboardRead: false, clipboardWrite: false
    },
    tunnel: { kind: 'openai', tunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', desktopTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: true, autoConnect: false, privacyScreenshots: false, theme: 'light', developerMode: options.developerMode ?? false },
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
  const live = { events: [...events], inputs: [] as InputEntry[], sent: [] as InputArgs[], automation: 'off', controlCalls: [] as Array<{ id: string; action: string }>, compacting: false, finishHeld: true };
  let sessionListener: () => void = () => undefined;
  const taskProgressListeners = new Set<(progress: any) => void>();
  const api: any = new Proxy(
    {
      getState: () => ok(state),
      getChatModels: () => ok({ state: 'ready', requestedAt: 1, observedAt: Date.now(), models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['none', 'high'] }] }),
      getSessionControls: (id: string) => ok({ sessionId: id, conversationId: 'chat-a', automation: live.automation, activeTurnId: 'held-turn', finishHeld: live.finishHeld, blocked: '', job: live.compacting ? { busy: true } : null }),
      releaseSessionFinish: (id: string, turn: string) => { live.controlCalls.push({ id, action: `release:${turn}` }); live.finishHeld = false; return ok({}); },
      setSessionAutomation: (id: string, action: string) => { live.controlCalls.push({ id, action }); live.automation = action; return ok({}); },
      compactSession: (id: string) => { live.controlCalls.push({ id, action: 'compact' }); live.compacting = true; return ok({}); },
      cancelSessionCompaction: (id: string) => { live.controlCalls.push({ id, action: 'cancel' }); live.compacting = false; return ok({}); },
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
      listSessions: () => ok({ sessions: options.sessions ?? [{ ...summary(live.events), ...(options.origin ? { origin: options.origin } : {}), ...(projects[0] ? { projectId: projects[0].id } : {}) }], activeId: summary(live.events).id, pressure: [] }),
      listProjects: () => ok(projects),
      // IPC snapshots cannot share the backend's mutable array with the renderer.
      listInputs: () => ok(structuredClone(live.inputs)),
      listPausedHelpers: () => ok(pausedHelpers),
      retryHelper: (id: string, sourceSessionId: string) => {
        live.controlCalls.push({ id: sourceSessionId, action: `retry:${id}` });
        pausedHelpers = pausedHelpers.filter(row => row.id !== id);
        return ok(true);
      },
      sendInput: (input: InputArgs) => {
        live.sent.push(input);
        const row: InputEntry = { ...input, state: 'queued', owner: null, createdAt: Date.now(), conversationId: null };
        live.inputs.push(row);
        return ok(row);
      },
      getSession: (_id: string, options?: { from?: number; before?: number; limit?: number }) => {
        const from = options?.from ?? 0;
        const eligible = live.events.filter((event) => event.seq >= from && (options?.before === undefined || event.seq < options.before));
        const page = options?.before === undefined ? eligible : eligible.slice(-(options.limit ?? 160));
        return ok({
          summary: summary(live.events),
          events: page,
          total: live.events.length,
          nextFrom: live.events.reduce((max, e) => Math.max(max, e.seq + 1), 0)
        });
      },
      getHandoff: () => ok(null)
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
    notifySession: () => sessionListener(),
    progress: (value: any) => { for (const listener of taskProgressListeners) listener(value); },
    async append(more: SessionEvent[]) {
      live.events.push(...more);
      sessionListener();
      await settle(500);
    }
  };
}

it('reorders queued tasks by drag and keyboard through the durable IPC operation', async () => {
  const { w, live, append } = await boot([]);
  const sessionId = summary([]).id;
  for (const [index, label] of ['first', 'second'].entries()) live.inputs.push({
    id: `queue-${index}`, sessionId, text: label, mode: 'finish', dueAt: 0, model: null, reasoningEffort: null,
    state: 'queued', owner: null, createdAt: index, conversationId: 'chat-b'
  });
  const reorder = vi.fn(async () => ({ ok: true, data: true }));
  (w as any).api.reorderQueuedInputs = reorder;
  await append([]);
  let labels = w.document.querySelectorAll<HTMLElement>('#finishQueue .queue-label');
  expect(labels[0]!.draggable).toBe(true);
  labels[1]!.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
  await settle();
  expect(reorder).toHaveBeenCalledWith(sessionId, ['queue-1', 'queue-0']);
  const data = new Map<string, string>();
  const transfer = { setData: (key: string, value: string) => data.set(key, value), getData: (key: string) => data.get(key) ?? '', effectAllowed: '', dropEffect: '' };
  labels = w.document.querySelectorAll<HTMLElement>('#finishQueue .queue-label');
  const start = new w.Event('dragstart', { bubbles: true }); Object.defineProperty(start, 'dataTransfer', { value: transfer });
  labels[1]!.dispatchEvent(start);
  const drop = new w.MouseEvent('drop', { bubbles: true, cancelable: true, clientY: 0 }); Object.defineProperty(drop, 'dataTransfer', { value: transfer });
  labels[0]!.parentElement!.dispatchEvent(drop);
  await settle();
  expect(reorder).toHaveBeenCalledTimes(2);
});

it('shows ordinary after-turn messages in the task dock until actual delivery', async () => {
  const { w, live, append } = await boot([]);
  for (const [index, label] of ['Next task', 'Following task'].entries()) live.inputs.push({
    id: `after-${index}`, sessionId: summary([]).id, text: label, mode: 'after-turn', dueAt: 0,
    model: 'gpt-5.6-sol', reasoningEffort: 'high', state: 'queued', owner: null, createdAt: index, conversationId: 'chat-b'
  });
  await append([]);
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(2);
  expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('Next task');
  live.inputs[0] = { ...live.inputs[0]!, state: 'sent', historyRecorded: true, messageId: 'after-message' };
  await append([{ seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'after-message', inputId: 'after-0', message: text('Next task') }]);
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(1);
  expect(w.document.getElementById('timeline')!.textContent).toContain('Next task');
});

it('shows canonical user attachments as persistent thumbnails for the selected session', async () => {
  const app = await boot([]);
  const { w } = app;
  const message: SessionEvent = { seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'input:one', inputId: 'one', message: text('Inspect this'), assets: [{ id: 'abcdef.bin', mimeType: 'image/webp', bytes: 12 }] };
  const getImage = vi.fn(async () => ({ ok: true, data: 'data:image/webp;base64,YQ==' }));
  // Match the real IPC result envelope used by this harness.
  (w as any).api.getSessionImage = getImage;
  await app.append([message]);
  const attachments = w.document.querySelector('.message-attachments')!;
  expect(attachments.tagName).toBe('DIV');
  expect(attachments.querySelector('summary')).toBeNull();
  await settle();
  expect(getImage).toHaveBeenCalledWith(summary([]).id, 'abcdef.bin');
  expect(attachments.querySelector('img')?.getAttribute('src')).toBe('data:image/webp;base64,YQ==');
});

it('pages project tasks as complete parent/worker groups and keeps the selected task visible after reordering', async () => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Paged', path: '/paged', createdAt: 1 };
  const tasks = Array.from({ length: 8 }, (_, index) => ({ ...summary([]), id: `project-task-${index}`, conversationId: `chat-${index}`, title: `Task ${index}`, projectId: project.id }));
  const worker = { ...summary([]), id: 'project-worker', conversationId: 'worker-chat', projectId: project.id,
    origin: { kind: 'worker' as const, fromSessionId: tasks[0]!.id, agentId: 'worker-1', task: 'Inspect' } };
  const entries = [...tasks, worker];
  const { w, append } = await boot([], true, [], [project], { sessions: entries });
  const section = () => w.document.querySelector('.project-group')!;
  expect(section().querySelectorAll(':scope > .sess')).toHaveLength(5);
  (section().querySelector('.worker-toggle') as HTMLButtonElement).click();
  expect(section().querySelectorAll(':scope > .sess')).toHaveLength(5);
  expect(section().querySelector('.worker-group [data-id="project-worker"]')).not.toBeNull();
  // A refresh can move the selected older task below the default five. Keep its complete
  // group visible without expanding every other old task or splitting off its child.
  entries.splice(0, entries.length, ...tasks.slice(1), tasks[0]!, worker);
  await append([]);
  expect(section().querySelectorAll(':scope > .sess')).toHaveLength(6);
  expect(section().querySelector('[data-id="project-task-0"]')).not.toBeNull();
  expect(section().querySelector('.worker-group [data-id="project-worker"]')).not.toBeNull();
  (section().querySelector('.project-show-more') as HTMLButtonElement).click();
  expect(section().querySelectorAll(':scope > .sess')).toHaveLength(8);
  expect(section().querySelector('.project-show-more')).toBeNull();
  await append([]);
  expect(section().querySelectorAll(':scope > .sess')).toHaveLength(8);
});
it('shows original user text while retaining transport instructions outside the visible bubble', async () => {
  const { w } = await boot([{ seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'native-one', inputId: 'one', authoredText: 'hello', message: text('hello\n\nTransport-only control instruction') }]);
  expect(w.document.querySelector('.said.is-user .msg')?.textContent).toBe('hello');
  expect(w.document.body.textContent).toContain('hello');
});

it('appends dropped images to the originating composer draft and caps attachments', async () => {
  const { w } = await boot([], false);
  const api = (w as any).api;
  const image = { name: 'dropped.webp', dataUrl: 'data:image/webp;base64,YQ==' };
  api.dropImages = vi.fn(async () => ({ ok: true, data: [image] }));
  const composer = w.document.getElementById('composer')!;
  const drop = (count: number) => {
    const event = new w.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: Array.from({ length: count }, () => new w.File(['image'], 'image.png', { type: 'image/png' })) } });
    composer.dispatchEvent(event);
    return event;
  };
  expect(drop(1).defaultPrevented).toBe(true);
  await settle();
  expect(w.document.querySelectorAll('#composerImages img')).toHaveLength(1);
  drop(4);
  await settle();
  expect(api.dropImages).toHaveBeenCalledTimes(1);
  expect(w.document.querySelectorAll('#composerImages img')).toHaveLength(1);
});

it('Share a folder creates a sidebar project and keeps it when an older list refresh finishes', async () => {
  const { w, live } = await boot([], false);
  const api = (w as any).api;
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Shared', path: '/shared', createdAt: 1 };
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  let finishList!: (value: unknown) => void;
  api.listSessions = () => new Promise(resolve => { finishList = resolve; });
  (w.document.getElementById('chatRefresh') as HTMLButtonElement).click();
  await settle();
  api.addProject = vi.fn(async () => ({ ok: true, data: project }));
  api.addRoot = vi.fn();
  (w.document.getElementById('composerFolder') as HTMLButtonElement).click();
  await settle();
  expect(api.addProject).toHaveBeenCalledTimes(1);
  expect(api.addRoot).not.toHaveBeenCalled();
  expect(w.document.querySelector(`[data-project-id="${project.id}"]`)).not.toBeNull();
  finishList({ ok: true, data: { sessions: [], activeId: null, pressure: [], blocked: [] } });
  await settle();
  expect(w.document.querySelector(`[data-project-id="${project.id}"]`)).not.toBeNull();
  expect(input.placeholder).toContain('Shared');
  input.value = 'Work in this folder';
  (w.document.getElementById('chatSend') as HTMLButtonElement).click();
  await settle();
  expect(live.sent[0]).toMatchObject({ sessionId: null, projectId: project.id, text: 'Work in this folder' });
});

it('preserves the draft and refuses send while model discovery has no confirmed choices', async () => {
  const { w, live } = await boot([], false);
  (w as any).api.requestChatModels = async () => ({ ok: true, data: { state: 'unavailable', requestedAt: 1, observedAt: null, models: [] } });
  (w.document.getElementById('refreshComposerModels') as HTMLButtonElement).click();
  await settle();
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Keep this until a real model is selected';
  (w.document.getElementById('chatSend') as HTMLButtonElement).click();
  await settle();
  expect(input.value).toBe('Keep this until a real model is selected');
  expect(live.sent).toHaveLength(0);
  expect(w.document.body.textContent).toContain('Reload model choices');
  expect(w.document.querySelector('.pending-message')).toBeNull();
});

it('cancelling Share a folder preserves the selected composer and creates no sidebar group', async () => {
  const { w } = await boot([], false);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Keep this draft';
  (w as any).api.addProject = vi.fn(async () => ({ ok: true, data: null }));
  (w.document.getElementById('composerFolder') as HTMLButtonElement).click();
  await settle();
  expect(input.value).toBe('Keep this draft');
  expect(w.document.querySelector('.project-group')).toBeNull();
});

it('groups project chats and starts an empty composer with the selected project identity', async () => {
  const projects = [{ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Alpha', path: '/alpha', createdAt: 1 }, { id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', name: 'Beta', path: '/beta', createdAt: 2 }];
  const { w, live, append } = await boot([], false, [], projects);
  const groups = w.document.querySelectorAll<HTMLDetailsElement>('.project-group');
  expect(groups).toHaveLength(2);
  expect(groups[0]!.querySelector('[data-id]')?.getAttribute('data-id')).toBe(summary([]).id);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const choose = (id: string) => (w.document.querySelector(`[data-new-project="${id}"]`) as HTMLButtonElement).click();
  choose(projects[0]!.id); input.value = 'Alpha draft';
  choose(projects[1]!.id); expect(input.value).toBe(''); input.value = 'Beta draft';
  (w.document.getElementById('newChat') as HTMLButtonElement).click();
  expect(input.value).toBe(''); input.value = 'Unfiled draft';
  choose(projects[0]!.id); expect(input.value).toBe(''); input.value = 'Alpha request';
  (w.document.getElementById('chatSend') as HTMLButtonElement).click();
  await settle();
  expect(live.sent[0]).toMatchObject({ sessionId: null, projectId: projects[0]!.id, text: 'Alpha request' });
  choose(projects[1]!.id); expect(input.value).toBe('');
  const beta = w.document.querySelector<HTMLDetailsElement>(`[data-project-id="${projects[1]!.id}"]`)!;
  beta.open = false; beta.dispatchEvent(new w.Event('toggle')); await append([]);
  expect(w.document.querySelector<HTMLDetailsElement>(`[data-project-id="${projects[1]!.id}"]`)!.open).toBe(false);
});

it('folds a whole Compact & Resume into one row that says the new chat opened', async () => {
  const { w } = await boot([
    { seq: 1, time: T0, source: 'app', kind: 'session_start', conversationId: 'chat-a', title: 'Loop under test' },
    toolCall(2, 'call-1'),
    ...compaction(3),
    toolCall(9, 'call-2')
  ]);
  const timeline = w.document.getElementById('timeline')!;

  const cards = timeline.querySelectorAll('details.compaction');
  expect(cards).toHaveLength(1);
  const card = cards[0]!;
  expect(card.className).toContain('tone-good');
  expect(card.querySelector('summary')!.textContent).toMatch(/^Compact & Resume:New chat opened at .* \(44 characters\)$/);
  expect(card.querySelectorAll('summary .step')).toHaveLength(0);

  // The rows the card replaces are gone from the list; nothing else is.
  expect(timeline.querySelector('.ev-handoff')).toBeNull();
  expect(timeline.textContent).not.toContain('[[CLF-');
  expect(timeline.querySelectorAll('.ev-turn_start, .ev-turn_end')).toHaveLength(0);
  expect(timeline.querySelectorAll('.ev-tool_call')).toHaveLength(2);
  // The card sits where the compaction happened, between the two calls.
  const order = [...timeline.children].map((row) => row.className);
  expect(order).toEqual(['ev ev-tool_call', 'ev ev-compaction', 'ev ev-tool_call']);

  // Everything is still there for whoever unfolds the card.
  card.toggleAttribute('open', true);
  expect(card.textContent).toContain('Brief request');
  expect(card.textContent).toContain('keep the loop running');
  expect(card.textContent).toContain('Handoff saved');
  expect(card.textContent).toContain('Bootstrap sent into the new chat');
});

it('starts in New Chat despite active history and selects only the exact acknowledged send', async () => {
  const app = await boot([], false);
  const { w, live } = app;
  expect(w.document.querySelector('#sessionList .is-sel')).toBeNull();
  await app.append([]);
  expect(w.document.querySelector('#sessionList .is-sel')).toBeNull();
  (w.document.getElementById('chatInput') as HTMLTextAreaElement).value = 'A new request';
  (w.document.getElementById('chatAutomation') as HTMLSelectElement).value = 'loop';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(live.sent[0]).toMatchObject({ sessionId: null, text: 'A new request', automation: 'loop' });
  live.inputs[0] = { ...live.inputs[0]!, state: 'sent', conversationId: 'chat-b', deliveredSessionId: summary([]).id };
  await app.append([]);
  expect(w.document.querySelector('#sessionList .is-sel')?.getAttribute('data-id')).toBe(summary([]).id);
});

it('selects an acknowledged New Chat while recording notifications keep arriving', async () => {
  const app = await boot([], false);
  const { w, live } = app;
  (w.document.getElementById('chatInput') as HTMLTextAreaElement).value = 'Streaming request';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  live.inputs[0] = { ...live.inputs[0]!, state: 'sent', conversationId: 'chat-b', deliveredSessionId: summary([]).id };
  const timer = setInterval(app.notifySession, 30);
  try {
    await vi.waitFor(() => expect(w.document.querySelector('#sessionList .is-sel')?.getAttribute('data-id')).toBe(summary([]).id), { timeout: 2000 });
  } finally { clearInterval(timer); }
});

it.each(['composer', 'bubble'])('clears New Chat drafts and removes a delivery cancelled with %s', async (control) => {
  const app = await boot([], false);
  const { w, live } = app;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Old attempt';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(w.document.getElementById('inputQueue')!.textContent).toContain('Old attempt');
  live.inputs[0] = { ...live.inputs[0]!, state: 'browser' };
  input.value = 'Discard this draft';
  w.document.getElementById('newChat')!.click();
  await app.append([]);
  expect(input.value).toBe('');
  expect(w.document.getElementById('inputQueue')!.textContent).toContain('Old attempt');
  expect(live.inputs[0]!.state).toBe('browser'); // Preserve ambiguous receipts; never retry them.
  const cancel = vi.fn(async (id: string) => { live.inputs = live.inputs.map(row => row.id === id ? { ...row, state: 'cancelled' as const, error: 'Not sent: this delivery was cancelled before Send was authorized.' } : row); return { ok: true, data: true }; });
  (w as any).api.cancelInput = cancel;
  expect(w.document.getElementById('chatSend')!.getAttribute('aria-label')).toBe('Cancel delivery');
  if (control === 'composer') w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  else (w.document.querySelector('#inputQueue [title="Cancel delivery"]') as HTMLButtonElement).click();
  await settle();
  expect(cancel).toHaveBeenCalledWith(live.inputs[0]!.id);
  expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('Old attempt');
  input.value = 'Fresh attempt';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(w.document.getElementById('inputQueue')!.textContent).toContain('Fresh attempt');
  expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('Old attempt');
});

it.each([false, true])('dismisses retired delivery errors in selected-chat=%s without resending', async selected => {
  const app = await boot([], selected);
  const { w, live } = app;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const submit = () => w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  input.value = 'Expired request'; submit(); await settle();
  live.inputs[0] = { ...live.inputs[0]!, state: 'cancelled', error: 'Delivery confirmation timed out. The message may already have reached ChatGPT.' };
  if (!selected) w.document.getElementById('newChat')!.click();
  await app.append([]);
  const queue = w.document.getElementById('inputQueue')!;
  expect(queue.textContent).toContain('Expired request');
  expect(queue.textContent).toContain('may already have reached ChatGPT');
  const retry = queue.querySelector<HTMLButtonElement>('[aria-label="Retry delivery"]')!;
  expect(retry.classList.contains('delivery-retry')).toBe(true);
  expect(retry.textContent).toBe('');
  expect(retry.querySelector('use')?.getAttribute('href')).toBe('#i-retry');
  expect(w.document.getElementById('chatSend')!.getAttribute('aria-label')).not.toBe('Cancel delivery');
  (queue.querySelector('[title="Dismiss delivery notice"]') as HTMLButtonElement).click();
  await app.append([]);
  expect(queue.textContent).not.toContain('Expired request');
  input.value = 'Fresh request'; submit(); await settle();
  expect(live.sent.at(-1)).toMatchObject({ text: 'Fresh request' });
  expect(queue.textContent).not.toContain('Expired request');
});

it('does not steal a newer New Chat draft when an older queued send is acknowledged', async () => {
  const app = await boot([], false);
  const { w, live } = app;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'First request';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  input.value = 'Newer unsent draft';
  live.inputs[0] = { ...live.inputs[0]!, state: 'sent', conversationId: 'chat-b', deliveredSessionId: summary([]).id };
  await app.append([]);
  expect(w.document.querySelector('#sessionList .is-sel')).toBeNull();
  expect(input.value).toBe('Newer unsent draft');
  w.document.getElementById('newChat')!.click();
  input.value = '';
  await app.append([]);
  expect(w.document.querySelector('#sessionList .is-sel')).toBeNull();
});

it('shows a compaction that never made it into a new chat as failed once the chat moved on', async () => {
  const [request, start, brief, end] = compaction(2);
  const { w, append } = await boot([
    { seq: 1, time: T0, source: 'app', kind: 'session_start', conversationId: 'chat-a', title: 'Loop under test' },
    request!,
    start!,
    brief!,
    end!
  ]);
  const timeline = w.document.getElementById('timeline')!;
  const state = () => timeline.querySelector('details.compaction summary .state')!.textContent;
  // Still the newest thing recorded: the summary is written, the app is saving it.
  expect(state()).toBe('Summary written — saving the handoff…');
  expect(timeline.querySelector('details.compaction')!.className).toContain('tone-wait');

  // The old chat carried on instead — the handoff never became a new chat.
  await append([toolCall(9, 'call-late')]);
  expect(state()).toBe('Summary written, but the app never saved it — the chat carried on here');
  expect(timeline.querySelector('details.compaction')!.className).toContain('tone-bad');
});

/**
 * The shape the live recorder actually writes. The brief request is typed by the app, so its
 * row carries no local turn id; the turn ChatGPT answers it in opens right after it. Folding by
 * the request's own turn id left the start, the brief, the end and the handoff loose under an
 * empty card — twenty rows for one compaction.
 */
it('folds the answer turn into the card when the request row has no turn id', async () => {
  const [request, start, brief, end, handoff, resume] = compaction(2) as [
    SessionEvent, SessionEvent, SessionEvent, SessionEvent, SessionEvent, SessionEvent
  ];
  delete (request as { turnId?: string }).turnId;
  const { w } = await boot([
    { seq: 1, time: T0, source: 'app', kind: 'session_start', conversationId: 'chat-a', title: 'Loop under test' },
    request,
    start,
    brief,
    end,
    handoff,
    { seq: 8, time: T0 + 8000, source: 'extension', kind: 'turn_start', turnId: 'turn-next' },
    resume
  ]);
  const timeline = w.document.getElementById('timeline')!;
  const order = [...timeline.children].map((row) => row.className);
  expect(order).toEqual(['ev ev-compaction']);
  expect(timeline.querySelector('details.compaction')!.className).toContain('tone-good');
});

it('says why a compaction died when the app abandoned it', async () => {
  const [request, start, brief, end] = compaction(2);
  const { w } = await boot([
    { seq: 1, time: T0, source: 'app', kind: 'session_start', conversationId: 'chat-a', title: 'Loop under test' },
    request!,
    start!,
    brief!,
    end!,
    {
      seq: 7,
      time: T0 + 7000,
      source: 'app',
      kind: 'note',
      continuation: TOKEN,
      message: text('Compact & Resume abandoned — the handover never landed and was given up on')
    },
    toolCall(8, 'call-after')
  ]);
  const timeline = w.document.getElementById('timeline')!;
  const card = timeline.querySelector('details.compaction')!;
  expect(card.className).toContain('tone-bad');
  expect(card.querySelector('summary .state')!.textContent).toBe('Failed — the handover never landed and was given up on');
  // The note is the card's, not a loose row of its own.
  expect(timeline.querySelectorAll('.ev-note')).toHaveLength(0);
  card.toggleAttribute('open', true);
  expect(card.textContent).toContain('abandoned');
});

it('keeps an unfolded tool row as the same open node while the chat keeps appending', async () => {
  const { w, append } = await boot([
    { seq: 1, time: T0, source: 'app', kind: 'session_start', conversationId: 'chat-a', title: 'Loop under test' },
    toolCall(2, 'call-1')
  ]);
  const timeline = w.document.getElementById('timeline')!;
  const before = timeline.querySelector('.ev-tool_call details.tool') as HTMLDetailsElement;
  expect(before.open).toBe(false);
  before.open = true;
  before.dispatchEvent(new w.Event('toggle'));

  await append([toolCall(3, 'call-2'), toolCall(4, 'call-3')]);
  const rows = timeline.querySelectorAll('.ev-tool_call');
  expect(rows).toHaveLength(3);
  const after = rows[0]!.querySelector('details.tool') as HTMLDetailsElement;
  // Not rebuilt: the very node the user unfolded, still unfolded.
  expect(after).toBe(before);
  expect(after.open).toBe(true);
  const group = timeline.querySelector('details.tool-group') as HTMLDetailsElement;
  expect(group.open).toBe(true);
  group.open = false;
  group.dispatchEvent(new w.Event('toggle'));
  const detached: Node[] = [];
  const observer = new w.MutationObserver(records => records.forEach(record => detached.push(...record.removedNodes)));
  observer.observe(timeline, { childList: true, subtree: true });
  await append([toolCall(5, 'call-4')]);
  observer.disconnect();
  expect(detached.some(node => node === group || node === before || (node as Element).contains?.(before))).toBe(false);
  expect(timeline.querySelector('details.tool-group')).toBe(group);
  expect(group.open).toBe(false);
  expect(group.querySelector('summary')!.textContent).toBe('Read README.md');
  expect(group.querySelector('summary')!.title).toContain('4 actions');
});

it('keeps mixed tool and agent activity in one latest-action disclosure between authored messages', async () => {
  const { w, append } = await boot([
    { seq: 1, time: T0, source: 'extension', kind: 'progress', message: text('Checking the implementation') },
    toolCall(2, 'first'),
    { seq: 3, time: T0 + 3000, source: 'app', kind: 'agent_message', messageId: 'agent-update', from: 'worker-2', to: 'prime', delivery: 'delivered', message: text('Found the root cause') },
    toolCall(4, 'last')
  ]);
  const timeline = w.document.getElementById('timeline')!;
  const group = timeline.querySelector<HTMLDetailsElement>('.tool-group')!;
  expect(group.open).toBe(false);
  expect(group.querySelector('.activity-title')!.textContent).toBe('Read README.md');
  expect(group.querySelector('.agent-communication summary')!.textContent).toContain('Message from worker-2');
  expect(group.querySelector('.agent-avatar')).not.toBeNull();
  expect(group.querySelectorAll('.ev')).toHaveLength(3);
  await append([
    { seq: 5, time: T0 + 5000, source: 'extension', kind: 'progress', message: text('Now validating') },
    toolCall(6, 'next'), toolCall(7, 'next-2')
  ]);
  expect(timeline.querySelectorAll('.tool-group')).toHaveLength(2);
  expect(timeline.children[0]!.className).toContain('ev-progress');
});

it('controls the selected session without submitting another user message', async () => {
  const { w, live } = await boot([]);
  const mode = w.document.getElementById('chatAutomation') as HTMLSelectElement;
  mode.value = 'loop'; mode.dispatchEvent(new w.Event('change'));
  await settle();
  expect(live.controlCalls).toEqual([{ id: summary([]).id, action: 'loop' }]);
  expect(live.sent).toEqual([]);
  w.document.getElementById('compactSession')!.click(); await settle();
  expect(live.controlCalls.at(-1)).toEqual({ id: summary([]).id, action: 'compact' });
  expect((w.document.getElementById('compactSession') as HTMLButtonElement).disabled).toBe(true);
  expect((w.document.getElementById('cancelCompaction') as HTMLElement).hidden).toBe(false);
  w.document.getElementById('cancelCompaction')!.click(); await settle();
  expect(live.controlCalls.at(-1)).toEqual({ id: summary([]).id, action: 'cancel' });
  w.document.getElementById('newChat')!.click(); await settle();
  expect((w.document.getElementById('sessionControls') as HTMLElement).hidden).toBe(false);
});

it('offers deliberate helper retry only for the selected source session', async () => {
  const sourceSessionId = summary([]).id;
  const { w, live } = await boot([], true, [
    { id: 'paused-selected', sourceSessionId },
    { id: 'paused-other', sourceSessionId: 'another-session' }
  ]);
  const queue = w.document.getElementById('inputQueue')!;
  expect(queue.textContent).toContain('Its old chat may still be running');
  expect(queue.querySelectorAll('button')).toHaveLength(1);
  expect(live.controlCalls).toEqual([]);
  (queue.querySelector('button') as HTMLButtonElement).click();
  await settle();
  expect(live.controlCalls).toEqual([{ id: sourceSessionId, action: 'retry:paused-selected' }]);
  expect(queue.querySelectorAll('button')).toHaveLength(0);
});

it('does not expose the retired End turn menu action', async () => {
  const { w, live } = await boot([]);
  expect(w.document.getElementById('releaseFinish')).toBeNull();
  expect(live.controlCalls).toEqual([]);
  expect(live.sent).toEqual([]);
});

it('updates an offered injection receipt in its existing transcript position', async () => {
  const message: SessionEvent = { seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'input:receipt-test', message: text('Injected instruction'), inputDelivery: 'offered' };
  const app = await boot([message, toolCall(2, 'later-work')]);
  expect(app.w.document.querySelector('.input-receipt')?.getAttribute('aria-label')).toBe('Sent to the active turn · awaiting receipt');
  app.live.events[0] = { ...message, seq: 3, inputDelivery: 'confirmed' };
  await app.append([]);
  expect(app.w.document.querySelectorAll('.input-receipt')).toHaveLength(1);
  expect(app.w.document.querySelector('.input-receipt')?.getAttribute('aria-label')).toBe('Delivery confirmed');
});

it.each(['menu', 'send'])('queues an Astra finish message through %s using the existing staged queue', async action => {
  const app = await boot([]);
  const { w, live } = app;
  const api = (w as any).api;
  const original = api.getSessionControls;
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, queueAtFinish: true, canInject: true } });
  await app.append([]);
  expect(w.document.getElementById('queueAtFinish')!.hidden).toBe(false);
  expect(w.document.getElementById('afterTurnLabel')!.textContent).toBe('Queue at Session finish');
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'The next stage';
  input.dispatchEvent(new w.Event('input'));
  if (action === 'menu') w.document.getElementById('queueAtFinish')!.click();
  else {
    (w.document.getElementById('sendMode') as HTMLSelectElement).value = 'after-turn';
    w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  }
  await settle();
  expect(live.sent.at(-1)).toMatchObject({ text: 'The next stage', mode: 'finish' });
});

it('shows injection only for an exact active turn, never merely recent chat activity', async () => {
  const { w, append } = await boot([toolCall(1, 'recent-call')]);
  const options = w.document.getElementById('sendOptions')!;
  expect(options.hidden).toBe(false);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'An authored follow-up'; input.dispatchEvent(new w.Event('input'));
  expect(options.hidden).toBe(false);
  (w as any).api.getSessionControls = (id: string) => Promise.resolve({ ok: true, data: { sessionId: id, automation: 'off', activeTurnId: null, finishHeld: false, blocked: '', job: null } });
  await append([toolCall(2, 'more-recent-call')]);
  expect(options.hidden).toBe(true);
  expect((w.document.getElementById('sendMode') as HTMLSelectElement).value).toBe('auto');
});

it('shows elapsed work for the exact recorded turn without exposing lifecycle rows', async () => {
  const { w, append } = await boot([{ seq: 1, time: T0, source: 'extension', kind: 'turn_start', turnId: 'held-turn' }]);
  expect(w.document.getElementById('chatState')!.textContent).toMatch(/^Working for /);
  (w as any).api.getSessionControls = (id: string) => Promise.resolve({ ok: true, data: { sessionId: id, automation: 'off', activeTurnId: null, finishHeld: false, blocked: '', job: null } });
  await append([{ seq: 2, time: T0 + 65_000, source: 'extension', kind: 'turn_end', turnId: 'held-turn', outcome: 'completed' }]);
  expect(w.document.getElementById('chatState')!.textContent).toBe('Worked for 1m 5s');
});


it('stops directly from the empty composer without a second Stop menu action', async () => {
  const { w } = await boot([]);
  const stop = vi.fn(async () => ({ ok: true, data: {} }));
  (w as any).api.stopSessionTurn = stop;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const send = w.document.getElementById('chatSend') as HTMLButtonElement;
  expect(send.getAttribute('aria-label')).toBe('Stop turn');
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle(); expect(stop).not.toHaveBeenCalled();
  input.value = 'Keep this draft'; input.dispatchEvent(new w.Event('input'));
  expect(send.getAttribute('aria-label')).toBe('Send message');
  expect(w.document.getElementById('sendOptions')!.hidden).toBe(false);
  expect(w.document.getElementById('stopTurnAction')).toBeNull();
  input.value = ''; input.dispatchEvent(new w.Event('input'));
  expect(w.document.getElementById('sendOptions')!.hidden).toBe(false);
  send.click();
  await settle();
  expect(stop).toHaveBeenCalledWith('2026-09-02-test0001', 'held-turn');
  expect(input.value).toBe('');
});

it('shows Stop immediately for a queued first send, switches to Send for a new draft, and cancels through the same button', async () => {
  const { w, live } = await boot([], false);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const send = w.document.getElementById('chatSend') as HTMLButtonElement;
  const form = w.document.getElementById('composer')!;
  input.value = 'First request';
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  expect(send.dataset.action).toBe('stop');
  expect(send.disabled).toBe(false);
  await settle();
  expect(send.dataset.action).toBe('stop');
  expect(w.document.querySelector('#inputQueue button')?.textContent).not.toBe('Cancel');
  input.value = 'Second request'; input.dispatchEvent(new w.Event('input'));
  expect(send.dataset.action).toBe('send');
  input.value = ''; input.dispatchEvent(new w.Event('input'));
  expect(send.dataset.action).toBe('stop');
  const cancel = vi.fn(async (id: string) => { live.inputs = live.inputs.map(row => row.id === id ? { ...row, state: 'cancelled' } : row); return { ok: true, data: true }; });
  (w as any).api.cancelInput = cancel;
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(cancel).toHaveBeenCalledWith(live.sent[0]!.id);
  expect(send.dataset.action).toBe('send');
});

it('retains the New Chat objective through Goal, Off and Goal toggles', async () => {
  const { w } = await boot([], false);
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Build and verify the requested feature';
  objective.dispatchEvent(new w.Event('input'));
  for (const mode of ['goal', 'off', 'goal']) {
    (w.document.querySelector(`#automationSwitch [data-mode="${mode}"]`) as HTMLButtonElement).click();
    await settle();
    expect(objective.value).toBe('Build and verify the requested feature');
    expect(objective.hidden).toBe(mode === 'off');
    expect(w.document.getElementById('saveSessionObjective')!.hidden).toBe(mode === 'off');
    expect((w.document.getElementById('chatAutomation') as HTMLSelectElement).value).toBe(mode);
  }
  expect(w.document.getElementById('clearSessionObjective')).toBeNull();
  expect(w.document.getElementById('showHandoff')).toBeNull();
});

it('keeps editable stages until the composer sends the first stage exactly once', async () => {
  const { w, live } = await boot([], false);
  const api = (w as any).api;
  (await api.getState()).data.config.ui.finishTool = true;
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['Build foundation', 'Verify it'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Build the whole task';
  input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click();
  await settle();
  expect(live.sent).toHaveLength(0);
  expect(w.document.getElementById('taskPlanPreview')!.textContent).not.toMatch(/Start plan|Review stages/);
  const edit = w.document.querySelector<HTMLButtonElement>('[aria-label="Edit stage 1"]')!;
  edit.click();
  const stage = w.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit stage 1"]')!;
  stage.value = 'Build the edited foundation'; stage.dispatchEvent(new w.Event('input'));
  expect(w.document.getElementById('chatSend')!.getAttribute('aria-label')).toBe('Send first stage');
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ text: 'Build the edited foundation', stages: ['Verify it'] });
});

it('disables empty task actions and confirms saving without the old helper sentence', async () => {
  const { w } = await boot([], false);
  const save = w.document.getElementById('saveSessionObjective') as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  const plan = w.document.getElementById('createPlan') as HTMLButtonElement;
  plan.click();
  expect(w.document.activeElement?.id).toBe('chatInput');
  expect((w.document.getElementById('chatInput') as HTMLTextAreaElement).placeholder).toContain('plan');
  expect(plan.getAttribute('aria-pressed')).toBe('true');
  plan.click();
  expect(plan.getAttribute('aria-pressed')).toBe('false');
  expect((w.document.getElementById('chatInput') as HTMLTextAreaElement).placeholder).toBe('Ask anything…');
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Implement and verify'; objective.dispatchEvent(new w.Event('input'));
  expect(save.disabled).toBe(false); save.click(); await settle();
  expect(save.textContent).toContain('Saved'); expect(save.disabled).toBe(true);
  expect(w.document.getElementById('sessionControlStatus')!.textContent).toBe('');
  objective.value += ' everything'; objective.dispatchEvent(new w.Event('input'));
  expect(save.disabled).toBe(false); expect(save.textContent).not.toContain('Saved');
});


it('omits the selected worker identity but retains a different sender', async () => {
  const events: SessionEvent[] = [
    { seq: 1, time: T0, source: 'extension', kind: 'assistant_message', agent: 'worker-2', message: text('Own reply'), final: true },
    { seq: 2, time: T0 + 1, source: 'extension', kind: 'assistant_message', agent: 'worker-3', message: text('Other reply'), final: true }
  ];
  const { w } = await boot(events, true, [], [], { origin: { kind: 'worker', agentId: 'worker-2', fromSessionId: 'parent', task: 'Audit' } });
  const labels = [...w.document.querySelectorAll('.ev-body > .chip')].map(el => el.textContent);
  expect(labels).toEqual(['worker-3']);
  expect(w.document.querySelector('.timeline')?.textContent ?? w.document.body.textContent).toContain('Own reply');
});

it('docks recent app repair progress without hiding authored lookalikes', async () => {
  const events: SessionEvent[] = [
    { seq: 1, time: Date.now(), source: 'app', kind: 'progress', progressId: 'browser-repair:test', message: text('Restored the browser connection') },
    { seq: 2, time: Date.now(), source: 'extension', kind: 'assistant_message', message: text('Reopened chat to recover a missing browser tab.'), final: true }
  ];
  const { w } = await boot(events);
  expect(w.document.getElementById('recoveryStatus')!.hidden).toBe(false);
  expect(w.document.getElementById('recoveryStatus')!.textContent).toContain('Restored the browser connection');
  expect(w.document.querySelectorAll('.ev-progress')).toHaveLength(0);
  expect(w.document.querySelector('.ev-assistant_message')!.textContent).toContain('Reopened chat');
  w.document.getElementById('newChat')!.click();
  expect(w.document.getElementById('recoveryStatus')!.hidden).toBe(true);
});

it('keeps historical repair details in developer mode without reviving a status', async () => {
  const { w } = await boot([{ seq: 1, time: T0, source: 'app', kind: 'progress', progressId: 'browser-repair:old', message: text('Historical repair') }], true, [], [], { developerMode: true });
  expect(w.document.getElementById('recoveryStatus')!.hidden).toBe(true);
  expect(w.document.querySelector('.ev-progress')!.textContent).toContain('Historical repair');
});

it('keeps accepted pending-send Stop while the durable queue refresh is still in flight', async () => {
  const { w } = await boot([], false);
  const api = (w as any).api;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const send = w.document.getElementById('chatSend') as HTMLButtonElement;
  const form = w.document.getElementById('composer')!;
  const listings: Array<(value: any) => void> = [];
  api.listInputs = () => new Promise(resolve => listings.push(resolve));
  api.sendInput = async (value: InputArgs) => ({ ok: true, data: { ...value, state: 'queued', owner: null, createdAt: Date.now(), conversationId: null } });
  input.value = 'First request';
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  expect(send.dataset.action).toBe('stop');
  await settle();
  expect(send.dataset.action).toBe('stop');
  listings[0]!({ ok: true, data: [] });
  await settle();
  expect(send.dataset.action).toBe('stop');
});

it('dismisses only the displayed recovery revision and reveals a changed status or new incident', async () => {
  const time = Date.now();
  const repair: SessionEvent = { seq: 1, time, source: 'app', kind: 'progress', progressId: 'browser-repair:dismiss', message: text('Reloaded chat to recover an unresponsive open turn.') };
  const { w, append, live } = await boot([repair], true, [], [], { developerMode: true });
  const status = w.document.getElementById('recoveryStatus')!;
  const dismiss = () => (status.querySelector('[aria-label="Dismiss recovery notice"]') as HTMLButtonElement).click();
  expect(status.hidden).toBe(false); dismiss(); expect(status.hidden).toBe(true);
  expect(live.events).toEqual([repair]);
  expect(w.document.querySelector('.ev-progress')?.textContent).toContain('Reloaded chat');
  await append([]); expect(status.hidden).toBe(true);
  await append([{ ...repair, seq: 2, message: text('The browser connection is restored.') }]);
  expect(status.hidden).toBe(false); expect(status.textContent).toContain('connection is restored');
  dismiss(); await append([]); expect(status.hidden).toBe(true);
  await append([{ ...repair, seq: 3, progressId: 'browser-repair:new' }]);
  expect(status.hidden).toBe(false);
  expect((w.document.getElementById('chatInput') as HTMLTextAreaElement).disabled).toBe(false);
});

it('blocks an empty stage, deletes it explicitly, and hides the whole dock in settings', async () => {
  const { w, live } = await boot([], false);
  const api = (w as any).api;
  (await api.getState()).data.config.ui.finishTool = true;
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['Write poem', 'Verify lines'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Rain poem'; input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click(); await settle();
  const stage = w.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit stage 1"]')!;
  stage.value = ''; stage.dispatchEvent(new w.Event('input'));
  expect(stage.getAttribute('aria-invalid')).toBe('true');
  expect((w.document.getElementById('chatSend') as HTMLButtonElement).disabled).toBe(true);
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle(); expect(live.sent).toHaveLength(0);
  w.document.querySelector<HTMLButtonElement>('[aria-label="Delete stage 1"]')!.click();
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(1);
  expect((w.document.getElementById('chatSend') as HTMLButtonElement).disabled).toBe(false);
  const chat = await import('../src/renderer/chat.js');
  chat.openChatView('settings');
  expect(w.document.getElementById('composerDock')!.hidden).toBe(true);
  chat.openChatView('timeline');
  expect(w.document.getElementById('composerDock')!.hidden).toBe(false);
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(1);
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle(); expect(live.sent[0]).toMatchObject({ text: 'Verify lines', stages: [] });
});

it('cancels pending planning without replacing the draft with a late result', async () => {
  const { w, live, progress } = await boot([], false);
  const api = (w as any).api;
  api.cancelTaskRequest = vi.fn(async () => ({ ok: true, data: true }));
  (await api.getState()).data.config.ui.finishTool = true;
  let finish!: (value: unknown) => void;
  api.draftTaskPlan = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Keep this draft';
  const plan = w.document.getElementById('createPlan') as HTMLButtonElement;
  plan.click(); await settle();
  const requestId = api.draftTaskPlan.mock.calls[0][2];
  expect(plan.getAttribute('aria-pressed')).toBe('true');
  plan.click();
  expect(api.cancelTaskRequest).toHaveBeenCalledWith(requestId);
  progress({ requestId, phase: 'generating', text: 'Stale cancelled plan' });
  expect(w.document.getElementById('taskPlanPreview')!.textContent).not.toContain('Stale cancelled plan');
  finish({ ok: true, data: ['First', 'Second'] }); await settle();
  expect(input.value).toBe('Keep this draft');
  expect(plan.getAttribute('aria-pressed')).toBe('false');
  expect(w.document.getElementById('taskPlanPreview')!.hidden).toBe(true);
  expect(live.sent).toHaveLength(0);
});

it('clearing the complete planner task cancels generation and restores Create plan', async () => {
  const { w, live } = await boot([], false);
  const api = (w as any).api;
  (await api.getState()).data.config.ui.finishTool = true;
  let finish!: (value: unknown) => void;
  api.draftTaskPlan = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  api.cancelTaskRequest = vi.fn(async () => ({ ok: true, data: true }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Write a poem'; w.document.getElementById('createPlan')!.click(); await settle();
  input.value = ''; input.dispatchEvent(new w.Event('input'));
  expect(api.cancelTaskRequest).toHaveBeenCalled();
  expect(w.document.getElementById('createPlan')!.getAttribute('aria-pressed')).toBe('false');
  expect(w.document.getElementById('createPlan')!.textContent).toBe('Create plan');
  finish({ ok: true, data: ['Old stage', 'Old check'] }); await settle();
  expect(live.sent).toHaveLength(0);
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(0);
});

it('routes an armed empty-composer plan through the planner and paints only its live progress', async () => {
  const { w, live, progress } = await boot([], false);
  const api = (w as any).api;
  (await api.getState()).data.config.ui.finishTool = true;
  let finish!: (value: unknown) => void;
  api.draftTaskPlan = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  w.document.getElementById('createPlan')!.click();
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Create an SVG cat';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(live.sent).toHaveLength(0);
  expect(api.draftTaskPlan.mock.calls[0][0]).toBe('Create an SVG cat');
  const requestId = api.draftTaskPlan.mock.calls[0][2];
  progress({ requestId: 'another-request', phase: 'generating', text: 'Wrong work' });
  expect(w.document.getElementById('taskPlanPreview')!.textContent).not.toContain('Wrong work');
  progress({ requestId, phase: 'generating', text: 'Design the SVG paths' });
  expect(w.document.getElementById('taskPlanPreview')!.textContent).toContain('Design the SVG paths');
  progress({ requestId, phase: 'retrying', text: '', attempt: 2, retryAt: Date.now() + 30000, error: 'rate_limited' });
  expect(w.document.getElementById('taskPlanPreview')!.textContent).toContain('Provider busy · retry 2');
  expect(w.document.getElementById('createPlan')!.getAttribute('aria-busy')).toBe('true');
  finish({ ok: true, data: ['Write SVG paths', 'Validate the SVG'] }); await settle();
  expect(live.sent).toHaveLength(0);
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ text: 'Write SVG paths', stages: ['Validate the SVG'] });
});

it('keeps actual-turn Stop through two authored sends and stops only the captured active turn', async () => {
  const { w, live } = await boot([]);
  const api = (w as any).api;
  const stop = vi.fn(async () => ({ ok: true, data: {} }));
  api.stopSessionTurn = stop;
  const cancel = vi.fn(async () => ({ ok: true, data: true }));
  api.cancelInput = cancel;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const send = w.document.getElementById('chatSend') as HTMLButtonElement;
  const form = w.document.getElementById('composer')!;
  for (const text of ['First new direction', 'Second new direction']) {
    expect(send.dataset.action).toBe('stop');
    input.value = text; input.dispatchEvent(new w.Event('input'));
    expect(send.dataset.action).toBe('send');
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    expect(send.dataset.action).toBe('stop');
    await settle();
    expect(send.dataset.action).toBe('stop');
  }
  expect(live.sent.map(row => row.text)).toEqual(['First new direction', 'Second new direction']);
  expect(live.sent.every(row => row.sessionId === '2026-09-02-test0001' && row.mode === 'auto')).toBe(true);
  // A queued follow-up does not replace the real active turn as Stop's authority.
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(stop).toHaveBeenCalledWith('2026-09-02-test0001', 'held-turn');
  expect(cancel).not.toHaveBeenCalled();
  expect(input.value).toBe('');
});

it('does not retarget an awaiting Stop after leaving and reselecting the same chat', async () => {
  const { w } = await boot([]);
  const api = (w as any).api;
  const original = api.getSessionControls;
  const stop = vi.fn(async () => ({ ok: true, data: {} }));
  api.stopSessionTurn = stop;
  let resolve!: (value: any) => void;
  api.getSessionControls = () => new Promise(done => { resolve = done; });
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  api.getSessionControls = original;
  w.document.getElementById('newChat')!.click();
  (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click();
  await settle();
  resolve(await original('2026-09-02-test0001'));
  await settle();
  expect(stop).not.toHaveBeenCalled();
  expect(w.document.getElementById('chatSend')!.dataset.action).toBe('stop');
});

it('streams a new Goal opening, queues it once, and displays authoritative delivery failure', async () => {
  const { w, live, progress, append } = await boot([], false);
  let finish!: (value: any) => void;
  const opening = vi.fn((_text: string, _mode: string, _requestId: string) => new Promise(resolve => { finish = resolve; }));
  (w as any).api.draftGoalOpening = opening;
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Implement and verify'; objective.dispatchEvent(new w.Event('input'));
  (w.document.getElementById('saveSessionObjective') as HTMLButtonElement).click();
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.textContent).toContain('Preparing the opening message');
  expect(row.getAttribute('aria-busy')).toBe('true');
  const requestId = opening.mock.calls[0]![2];
  progress({ requestId: 'unrelated-request', phase: 'generating', text: 'Wrong Goal' });
  expect(row.textContent).not.toContain('Wrong Goal');
  progress({ requestId, phase: 'retrying', text: '', error: 'rate_limited', attempt: 2, retryAt: Date.now() + 30000 });
  expect(row.textContent).toContain('Provider busy · retry 2');
  expect(row.getAttribute('aria-busy')).toBe('true');
  progress({ requestId, phase: 'generating', text: 'Inspect the existing code first' });
  expect(row.textContent).toContain('Inspect the existing code first');
  expect(live.sent).toEqual([]);
  finish({ ok: true, data: { reply: 'Inspect and implement the task', model: 'fixture' } });
  await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ text: 'Inspect and implement the task', objective: 'Implement and verify', automation: 'goal' });
  expect(row.textContent).toContain('Opening message queued');
  live.inputs = live.inputs.map(input => ({ ...input, state: 'failed', error: 'Model could not be selected' }));
  await append([]);
  expect(row.textContent).toContain('Model could not be selected');
  expect(row.getAttribute('aria-busy')).toBe('false');
});

it('preserves an Off goal and never sends its late generated opening after Off and On', async () => {
  const { w, live, progress } = await boot([], false);
  const cancel = vi.fn(async () => ({ ok: true, data: true }));
  (w as any).api.cancelTaskRequest = cancel;
  let finish!: (value: any) => void;
  let requestId = '';
  (w as any).api.draftGoalOpening = (_text: string, _mode: string, id: string) => { requestId = id; return new Promise(resolve => { finish = resolve; }); };
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Keep this objective'; objective.dispatchEvent(new w.Event('input'));
  w.document.getElementById('saveSessionObjective')!.click();
  for (const mode of ['off', 'goal']) (w.document.querySelector(`#automationSwitch [data-mode="${mode}"]`) as HTMLButtonElement).click();
  expect(cancel).toHaveBeenCalledWith(requestId);
  progress({ requestId, phase: 'generating', text: 'Late provider text' });
  finish({ ok: true, data: { reply: 'Must not send', model: 'fixture' } });
  await settle();
  expect(live.sent).toEqual([]);
  expect(objective.value).toBe('Keep this objective');
  expect(w.document.getElementById('goalLifecycle')!.hidden).toBe(true);
  expect(w.document.getElementById('goalLifecycle')!.textContent).not.toContain('Late provider text');
});

it.each(['navigate', 'objective edit', 'mode change', 'automation change'] as const)('cancels native Goal generation on %s and ignores stale progress', async (action) => {
  const { w, live, progress } = await boot([], false);
  const api = (w as any).api;
  api.cancelTaskRequest = vi.fn(async () => ({ ok: true, data: true }));
  let finish!: (value: any) => void;
  api.draftGoalOpening = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Original task'; objective.dispatchEvent(new w.Event('input'));
  w.document.getElementById('saveSessionObjective')!.click();
  const requestId = api.draftGoalOpening.mock.calls[0][2];
  if (action === 'navigate') {
    (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click();
    await settle();
  } else if (action === 'objective edit') {
    objective.value = 'Replacement task'; objective.dispatchEvent(new w.Event('input'));
  } else if (action === 'mode change') {
    const mode = w.document.getElementById('sessionObjectiveMode') as HTMLSelectElement;
    mode.value = 'loop'; mode.dispatchEvent(new w.Event('change'));
  } else {
    (w.document.querySelector('#automationSwitch [data-mode="loop"]') as HTMLButtonElement).click();
  }
  expect(api.cancelTaskRequest).toHaveBeenCalledWith(requestId);
  progress({ requestId, phase: 'generating', text: 'Obsolete provider progress' });
  expect(w.document.getElementById('goalLifecycle')!.textContent).not.toContain('Obsolete provider progress');
  finish({ ok: true, data: { reply: 'Obsolete opening', model: 'fixture' } });
  await settle();
  expect(live.sent).toHaveLength(0);
});

it('applies Off to the exact accepted New Chat opening while preserving an unrelated composer draft', async () => {
  const { w, live, append } = await boot([], false);
  const api = (w as any).api;
  api.draftGoalOpening = vi.fn(async () => ({ ok: true, data: { reply: 'Say hello once', model: 'fixture' } }));
  api.setInputAutomation = vi.fn(async (id: string, mode: 'off' | 'goal' | 'loop') => {
    live.inputs = live.inputs.map(row => row.id === id ? { ...row, automation: mode } : row);
    return { ok: true, data: true };
  });
  const composer = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  composer.value = 'Keep my separate draft';
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Greeting goal'; objective.dispatchEvent(new w.Event('input'));
  w.document.getElementById('saveSessionObjective')!.click(); await settle();
  expect(live.sent).toHaveLength(1);
  const id = live.sent[0]!.id;
  (w.document.querySelector('#automationSwitch [data-mode="off"]') as HTMLButtonElement).click(); await settle();
  expect(api.setInputAutomation).toHaveBeenCalledWith(id, 'off');
  live.inputs = live.inputs.map(row => ({ ...row, state: 'sent', deliveredSessionId: summary([]).id }));
  await append([]);
  expect(composer.value).toBe('Keep my separate draft');
  expect(objective.value).toBe('Greeting goal');
  expect(live.sent).toHaveLength(1);
});

it.each(['navigate', 'draft edit'] as const)('cancels pending plan generation on %s', async (action) => {
  const { w, live, progress } = await boot([], false);
  const api = (w as any).api;
  (await api.getState()).data.config.ui.finishTool = true;
  api.cancelTaskRequest = vi.fn(async () => ({ ok: true, data: true }));
  let finish!: (value: any) => void;
  api.draftTaskPlan = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Original plan';
  w.document.getElementById('createPlan')!.click(); await settle();
  const requestId = api.draftTaskPlan.mock.calls[0][2];
  if (action === 'navigate') {
    (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click(); await settle();
  } else {
    input.value = 'Replacement plan'; input.dispatchEvent(new w.Event('input'));
  }
  expect(api.cancelTaskRequest).toHaveBeenCalledWith(requestId);
  progress({ requestId, phase: 'generating', text: 'Old plan text' });
  expect(w.document.getElementById('taskPlanPreview')!.textContent).not.toContain('Old plan text');
  finish({ ok: true, data: ['Old first stage', 'Old second stage'] }); await settle();
  expect(live.sent).toHaveLength(0);
});

it('renders existing-chat Goal draft stages from main controls without starting another request', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api;
  const original = api.getSessionControls;
  let draft = { stage: 'answering', model: 'fixture', text: 'Actual continuation text', error: null as string | null };
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, automation: 'goal', goalDraft: draft } });
  const opening = vi.fn(); api.draftGoalOpening = opening;
  await append([]);
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.textContent).toContain('Actual continuation text');
  expect(row.getAttribute('aria-busy')).toBe('true');
  draft = { ...draft, stage: 'ready' }; await append([]);
  expect(row.textContent).toContain('awaiting ChatGPT delivery');
  draft = { ...draft, stage: 'failed', error: 'no_api_key' }; await append([]);
  expect(row.textContent).toContain('no_api_key');
  expect(row.getAttribute('aria-busy')).toBe('false');
  expect(opening).not.toHaveBeenCalled();
});

it('reuses the Goal animation for a session-finish draft while ordinary automation is off', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api, original = api.getSessionControls;
  let finishGoalDraft: object | null = { stage: 'answering', model: 'fixture', text: 'Next useful action', error: null };
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, automation: 'off', finishGoalDraft } });
  await append([]);
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.hidden).toBe(false);
  expect(row.textContent).toContain('Next useful action');
  expect(row.getAttribute('aria-busy')).toBe('true');
  finishGoalDraft = null; await append([]);
  expect(row.hidden).toBe(true);
  expect(row.getAttribute('aria-busy')).toBe('false');
});

it('shows the active finish animation after an earlier ordinary Goal save failed', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api, original = api.getSessionControls;
  let finishGoalDraft: object | null = null;
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, automation: 'goal', finishGoalDraft } });
  api.setSessionObjective = vi.fn(async () => ({ ok: false, error: 'Save failed' }));
  await append([]);
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Verify remaining work'; objective.dispatchEvent(new w.Event('input'));
  w.document.getElementById('saveSessionObjective')!.click(); await settle();
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.textContent).toContain('Task could not be saved');
  finishGoalDraft = { stage: 'answering', model: 'fixture', text: 'Check the active task', error: null };
  await append([]);
  expect(row.textContent).toContain('Check the active task');
  expect(row.textContent).not.toContain('Task could not be saved');
  expect(row.getAttribute('aria-busy')).toBe('true');
  expect(row.querySelector('.session-status.is-working')).not.toBeNull();
});

it('offers Generate Goal only at an empty finish wait and preserves the manual draft', async () => {
  const { w, append, live } = await boot([]);
  const api = (w as any).api, original = api.getSessionControls;
  let waiting = false;
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, finishWaiting: waiting } });
  const generate = vi.fn(async () => ({ ok: true, data: 'Goal queued' })); api.generateFinishGoal = generate;
  const button = w.document.getElementById('generateFinishGoal') as HTMLButtonElement;
  await append([]); expect(button.hidden).toBe(true);
  waiting = true; await append([]); expect(button.hidden).toBe(false);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'My own follow-up'; input.dispatchEvent(new w.Event('input', { bubbles: true }));
  expect(input.disabled).toBe(false);
  button.click(); await settle();
  expect(generate).toHaveBeenCalledWith(summary(live.events).id, 'held-turn');
  expect(input.value).toBe('My own follow-up');
  live.inputs.push({ id: 'pending', sessionId: summary(live.events).id, state: 'queued', mode: 'finish', text: 'Prior task', dueAt: Date.now(), createdAt: Date.now() } as InputEntry);
  await append([]); expect(button.hidden).toBe(true);
  button.click(); await settle(); expect(generate).toHaveBeenCalledTimes(1);
});

it('offers a per-task post-turn opt-in only for Astra', async () => {
  const { w, live, append } = await boot([]);
  const current = summary([]);
  live.inputs.push({ id: 'choice-task', sessionId: current.id, text: 'Next task', mode: 'finish', dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b' });
  await append([]);
  expect(w.document.querySelector('.queue-delivery')).toBeNull();
  current.selectedModel = { conversationId: 'chat-b', model: 'gpt-6-pro', reasoningEffort: 'pro', observedAt: T0 };
  (w as any).api.listSessions = async () => ({ ok: true, data: { sessions: [current], activeId: current.id, pressure: [] } });
  (w as any).api.getSession = async () => ({ ok: true, data: { summary: current, events: [], total: 0, nextFrom: 0 } });
  const edit = vi.fn(async () => ({ ok: true, data: true }));
  (w as any).api.editQueuedInput = edit;
  await append([]);
  const toggle = w.document.querySelector<HTMLButtonElement>('.queue-delivery');
  expect(toggle?.getAttribute('aria-pressed')).toBe('false');
  toggle!.click();
  await settle();
  expect(edit).toHaveBeenCalledWith('choice-task', 'Next task', true);
});

it('loads bounded earlier pages on deliberate upward scrolling without draining on render', async () => {
  const rows = Array.from({ length: 360 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `history-${i}`, message: text(`History item ${i + 1}`) }));
  const { w, append } = await boot(rows);
  const timeline = w.document.getElementById('timeline')!;
  const pane = w.document.getElementById('chatBody')!;
  expect(timeline.querySelector('[data-history="older"]')).toBeNull();
  pane.dispatchEvent(new w.Event('scroll')); await settle();
  expect(timeline.textContent).toContain('History item 360');
  expect(timeline.textContent).not.toContain('History item 121');
  Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 400 });
  Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: 10000 });
  for (const row of timeline.querySelectorAll<HTMLElement>('[data-timeline-key]')) row.getBoundingClientRect = () => {
    const top = [...timeline.querySelectorAll('[data-timeline-key]')].indexOf(row) * 20 - pane.scrollTop;
    return { top, bottom: top + 20, height: 20, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) };
  };  const up = async () => { pane.scrollTop = 0; pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 })); await settle(); };
  await up();
  expect(pane.scrollTop).toBe(1600);
  expect(timeline.textContent).toContain('History item 121');
  expect(timeline.textContent).not.toContain('History item 360');
  await append([{ seq: 361, time: T0 + 361, source: 'extension', kind: 'user_message', messageId: 'newest', message: text('Newest live input') }]);
  expect(timeline.textContent).toContain('History item 121');
  expect(timeline.textContent).not.toContain('Newest live input');
  await up(); expect(timeline.textContent).toContain('History item 41');
  await up(); expect(timeline.textContent).toContain('History item 1');
  expect(timeline.querySelectorAll('[data-timeline-key]').length).toBeLessThanOrEqual(160);
  (timeline.querySelector('[data-history="latest"]') as HTMLElement).click(); await settle();
  expect(timeline.textContent).toContain('Newest live input');
});
it('does not apply an older-page response or scroll after switching to a new chat', async () => {
  const rows = Array.from({ length: 200 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `prior-${i}`, message: text(`Prior row ${i}`) }));
  const { w } = await boot(rows);
  const api = (w as any).api;
  const original = api.getSession;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  api.getSession = async (id: string, options: any) => { if (options?.before) await pending; return original(id, options); };
  const pane = w.document.getElementById('chatBody')!;
  pane.scrollTop = 0; pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 }));
  await settle();
  (w.document.getElementById('newChat') as HTMLElement).click(); await settle();
  pane.scrollTop = 73;
  release(); await settle();
  expect(w.document.getElementById('timeline')!.textContent).not.toContain('Prior row');
  expect(pane.scrollTop).toBe(73);
});

it('clears a delivered check when later model activity arrives without a timer', async () => {
  const message: SessionEvent = { seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'input:receipt', inputId: 'receipt', inputDelivery: 'confirmed', message: text('Continue') };
  const app = await boot([message]);
  const receipt = app.w.document.querySelector('.input-receipt') as HTMLElement;
  expect(receipt.hidden).toBe(false);
  await app.append([toolCall(2, 'next-tool')]);
  expect(app.w.document.querySelector('.input-receipt')).toBe(receipt);
  expect(receipt.hidden).toBe(true);
});
