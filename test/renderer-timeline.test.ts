import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_GOAL_SYSTEM_PROMPT } from '../src/shared/goal.js';
import { prependUserPrompt } from '../src/shared/user-prompt.js';
import type { Handoff, SessionEvent, SessionSummary } from '../src/shared/session.js';
import type { InputArgs, InputEntry } from '../src/main/session/input.js';
import type { LocalProject } from '../src/shared/projects.js';
vi.mock('../src/renderer/workspace-terminal.js', () => ({ createWorkspaceTerminal: () => ({ update: vi.fn() }) }));
vi.mock('../src/renderer/pet.js', () => ({ initPet: () => () => {} }));
import { positionOf, projectTimeline } from '../src/shared/chronology.js';

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

/**
 * The rows the recorder writes for one Compact & Resume, in the order it observes them.
 *
 * `escaped` is how ChatGPT's composer records the same two prompts since 2026-09-16: it
 * round-trips inserted text through its own Markdown serializer, which escapes ASCII
 * punctuation, so the marker arrives as `[[CLF-RESUME\:<token>]]`. These are the exact shapes
 * read back out of a live install's session store.
 */
function compaction(seq: number, escaped = false): SessionEvent[] {
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

async function settle(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** History paging yields to the browser frame after each bounded read. Timer
 * ticks alone can all finish before that frame on Linux and macOS. */
async function settleHistoryFrame(w: Pick<Window, 'requestAnimationFrame'>): Promise<void> {
  await settle();
  await new Promise<void>(resolve => w.requestAnimationFrame(() => resolve()));
  await settle();
}

async function boot(events: SessionEvent[], selectExisting = true, pausedHelpers: Array<{ id: string; sourceSessionId: string }> = [], projects: LocalProject[] = [], options: { origin?: SessionSummary["origin"]; developerMode?: boolean; sessions?: SessionSummary[]; pro?: boolean; astra?: boolean; reserveOpenings?: boolean; handoff?: Handoff | null } = {}) {
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
  let writeSessionListener: (id: string) => void = () => undefined;
  const taskProgressListeners = new Set<(progress: any) => void>();
  const api: any = new Proxy(
    {
      getState: () => ok(state),
      getChatModels: () => ok({ state: 'ready', requestedAt: 1, observedAt: Date.now(), models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: options.pro ? ['high', 'pro'] : ['none', 'high'] },
        ...(options.astra ? [{ id: 'gpt-6-pro', label: 'GPT-6 Pro', efforts: ['pro'] }] : [])] }),
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
      onWriteSession: (fn: (id: string) => void) => {
        writeSessionListener = fn;
        return () => undefined;
      },
      listSessions: () => {
        const sessions = options.sessions ?? [{ ...summary(live.events), ...(options.origin ? { origin: options.origin } : {}), ...(projects[0] ? { projectId: projects[0].id } : {}) }];
        const known = new Set(sessions.map(row => row.id));
        const openings = live.inputs.filter(row => row.opening && row.sessionId && !known.has(row.sessionId)).map(row => ({
          ...summary(live.events), id: row.sessionId!, title: row.text, conversationId: null, chatIds: []
        }));
        return ok({ sessions: [...openings, ...sessions], activeId: summary(live.events).id, pressure: [] });
      },
      listProjects: () => ok(projects),
      // IPC snapshots cannot share the backend's mutable array with the renderer.
      listInputs: () => ok(structuredClone(live.inputs)),
      cancelInput: vi.fn((id: string) => {
        const entry = live.inputs.find(row => row.id === id);
        if (!entry) return ok(false);
        entry.state = 'cancelled'; entry.cancelledByUser = true;
        return ok(true);
      }),
      listPausedHelpers: () => ok(pausedHelpers),
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
        const eligible = live.events.filter((event) => event.seq >= from &&
          (options?.before === undefined || positionOf(event) < options.before) &&
          (options?.after === undefined || positionOf(event) > options.after))
          .sort((a, b) => options?.from !== undefined ? a.seq - b.seq : positionOf(a) - positionOf(b));
        const limit = options?.limit ?? 30;
        const page = options?.after !== undefined || options?.from !== undefined
          ? eligible.slice(0, limit) : eligible.slice(-limit);
        const opening = live.inputs.find(row => row.opening && row.sessionId === _id);
        return ok({
          summary: opening ? { ...summary(live.events), id: _id, title: opening.text, conversationId: null, chatIds: [] } : summary(live.events),
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
    notifySession: () => sessionListener(),
    writeSession: (id: string) => writeSessionListener(id),
    progress: (value: any) => { for (const listener of taskProgressListeners) listener(value); },
    async append(more: SessionEvent[]) {
      live.events.push(...more);
      sessionListener();
      await settle(500);
    }
  };
}

it('patches native reactions in place and hides streamed envelopes without changing authored messages', async () => {
  const user: SessionEvent = { kind: 'user_message', seq: 1, origin: 1, time: T0, source: 'extension', messageId: 'reaction-user', message: text('Question') };
  const answer: SessionEvent = { kind: 'assistant_message', seq: 2, time: T0 + 1, source: 'extension', messageId: 'reaction-answer', message: text('\uE200message_'), final: false };
  const { w, append } = await boot([user, answer]);
  const bubble = w.document.querySelector('.said.is-user')!;
  expect(w.document.querySelector<HTMLElement>('.ev-assistant_message')!.hidden).toBe(true);
  for (const [index, reaction] of ['😂', '❤️', null].entries()) {
    await append([{ ...user, seq: index + 3, origin: 1, reaction }]);
    expect(w.document.querySelector('.said.is-user')).toBe(bubble);
    expect(w.document.querySelector('.message-reaction')?.textContent ?? null).toBe(reaction);
  }
  expect(bubble.textContent).toContain('Question');
  await append([{ ...answer, seq: 7, origin: 2, message: text('\uE200message_reaction\uE202😂\uE201\nThe answer.'), final: true }]);
  expect(w.document.querySelector('.ev-assistant_message .msg')?.textContent?.trim()).toBe('The answer.');
  expect(w.document.querySelector('.message-reaction')).toBeNull(); // Never infer a target from adjacency.
});

it('keeps a reaction on the native question across 100 interim messages, tool calls and injected corrections', async () => {
  const question: SessionEvent = { kind: 'user_message', seq: 1, origin: 1, time: T0, source: 'extension',
    messageId: 'native-question', message: text('Original native question'), reaction: '👀' };
  const middle: SessionEvent[] = Array.from({ length: 100 }, (_, i) => ({ kind: 'assistant_message', seq: i + 2,
    time: T0 + i + 1, source: 'extension', messageId: `interim-${i}`, message: text(`Update ${i}`), final: false }));
  const tools = Array.from({ length: 15 }, (_, i) => ({ ...toolCall(i + 102, `call-${i}`), time: T0 + i + 101 }));
  const injected: SessionEvent = { kind: 'user_message', seq: 117, time: T0 + 116, source: 'app', messageId: 'input:correction',
    inputId: 'correction', inputDelivery: 'confirmed', message: text('An injected correction') };
  const final: SessionEvent = { kind: 'assistant_message', seq: 118, time: T0 + 117, source: 'extension', messageId: 'final',
    message: text('\uE200message_reaction\uE202👀\uE201\nFinished.'), final: true };
  const { w } = await boot([question, ...middle, ...tools, injected, final]);
  const correction = [...w.document.querySelectorAll('.said.is-user')].find(node => node.textContent?.includes('An injected correction'))!;
  expect(correction.querySelector('.message-reaction')).toBeNull();
  expect(w.document.querySelector('.message-reaction')).toBeNull(); // The native question is on an older page.
  const pane = w.document.getElementById('chatBody')!;
  Object.defineProperties(pane, { clientHeight: { value: 400 }, scrollHeight: { value: 10000 } });
  for (let page = 0; page < 3; page++) {
    pane.scrollTop = 0;
    pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 }));
    await settleHistoryFrame(w);
  }
  const badges = [...w.document.querySelectorAll('.message-reaction')];
  expect(badges).toHaveLength(1);
  expect(badges[0]!.closest('.said')!.textContent).toContain('Original native question');
  expect(w.document.getElementById('timeline')!.textContent).not.toContain('message_reaction');
});

it.each(['compaction', 'blocked', 'worker'])('retires %s control status when leaving its session, including late IPC and locale refresh', async kind => {
  const { w, append } = await boot([]);
  const api = (w as any).api;
  const controls = { sessionId: summary([]).id, automation: 'off', objective: '',
    blocked: kind === 'compaction' ? '' : kind, job: kind === 'compaction' ? { busy: true } : null };
  api.getSessionControls = async () => ({ ok: true, data: controls });
  await append([]);
  const status = w.document.getElementById('sessionControlStatus')!;
  expect(status.textContent).not.toBe('');
  let release!: (value: unknown) => void;
  api.getSessionControls = () => new Promise(resolve => { release = resolve; });
  await append([]);
  // An ordinary refresh of the same selected owner retains its last known status.
  expect(status.textContent).not.toBe('');
  w.document.getElementById('newChat')!.click();
  expect(status.textContent).toBe('');
  expect(w.document.getElementById('compactSession')!.hidden).toBe(true);
  expect(w.document.getElementById('cancelCompaction')!.hidden).toBe(true);
  release({ ok: true, data: controls }); await settle();
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('zh-CN');
  expect(status.textContent).toBe('');
  setLanguage('en');
  // Returning to A is a new selection epoch; only its new read may restore status.
  (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click();
  expect(status.textContent).toBe('');
  release({ ok: true, data: controls }); await settle();
  expect(status.textContent).not.toBe('');
});

it('clears control projections on an existing-session switch and fences A to B to A responses', async () => {
  const first = summary([]), second = { ...summary([]), id: '2026-09-02-test0002', title: 'Other session' };
  const { w, append } = await boot([], true, [], [], { sessions: [first, second] });
  const api = (w as any).api;
  const busy = { automation: 'off', objective: '', blocked: '', job: { busy: true },
    recovery: [{ kind: 'unattributed', deadline: Date.now() + 60_000 }] };
  api.getSessionControls = async () => ({ ok: true, data: busy });
  await append([]);
  const status = w.document.getElementById('sessionControlStatus')!;
  expect(status.textContent).toContain('Compaction');
  expect(w.document.getElementById('recoveryStatus')!.textContent).toContain('Reload in');
  const pending: Array<(value: unknown) => void> = [];
  api.getSessionControls = () => new Promise(resolve => pending.push(resolve));
  await append([]); // old A refresh
  (w.document.querySelector(`#sessionList [data-id="${second.id}"]`) as HTMLElement).click();
  expect(status.textContent).toBe('');
  expect(w.document.getElementById('recoveryStatus')!.hidden).toBe(true);
  expect(w.document.getElementById('cancelCompaction')!.hidden).toBe(true);
  (w.document.querySelector(`#sessionList [data-id="${first.id}"]`) as HTMLElement).click();
  expect(pending).toHaveLength(3);
  pending[2]!({ ok: true, data: { ...busy, job: null, recovery: [] } }); await settle();
  pending[1]!({ ok: true, data: busy });
  pending[0]!({ ok: true, data: busy }); await settle();
  expect(status.textContent).toBe('');
  expect(w.document.getElementById('cancelCompaction')!.hidden).toBe(true);
  expect(w.document.getElementById('recoveryStatus')!.hidden).toBe(true);
});

it('keeps the prior transcript inert until the selected detail arrives and fences A to B to A', async () => {
  const attachment = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'a-only.png', mimeType: 'image/png', size: 42, preview: 'data:image/webp;base64,YQ==' };
  const aEvents: SessionEvent[] = [
    { seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'a-question', message: text('A QUESTION'), attachments: [attachment] },
    { seq: 2, time: T0 + 1, source: 'extension', kind: 'assistant_message', messageId: 'a-answer', message: text('A ANSWER'), state: 'final', final: true }
  ];
  const first = { ...summary(aEvents), title: 'Session A', lastHandoffId: 'handoff-a' };
  const second = { ...summary([]), id: '2026-09-02-test0000', title: 'Session B', lastHandoffId: null };
  const saved: Handoff = { id: 'handoff-a', sessionId: first.id, createdAt: T0, text: 'A HANDOFF', sourceEvents: 2, sourceTokens: 10, notes: [] };
  const app = await boot(aEvents, true, [], [], { sessions: [first, second], handoff: saved });
  const { w } = app;
  const api = (w as any).api;
  api.getSessionControls = async () => ({ ok: true, data: { automation: 'off', objective: '', blocked: '', job: { busy: true }, recovery: [] } });
  await app.append([]);
  const timeline = w.document.getElementById('timeline')!;
  expect(w.document.getElementById('chatTitle')!.textContent).toBe('Session A');
  expect(timeline.textContent).toContain('A QUESTION');
  expect(timeline.querySelector('img[alt="a-only.png"]')).not.toBeNull();
  expect(w.document.getElementById('handoffBox')!.textContent).toContain('A HANDOFF');
  expect(w.document.getElementById('sessionControlStatus')!.textContent).toContain('Compaction');

  type Reply = (value: unknown) => void;
  const details: Array<{ id: string; reply: Reply }> = [];
  const controls: Array<{ id: string; reply: Reply }> = [];
  api.getSession = vi.fn((id: string) => new Promise(resolve => details.push({ id, reply: resolve })));
  api.getSessionControls = vi.fn((id: string) => new Promise(resolve => controls.push({ id, reply: resolve })));
  const detail = (sum: SessionSummary, rows: SessionEvent[]) => ({ ok: true, data: { summary: sum, events: rows, total: rows.length,
    nextFrom: rows.reduce((cursor, event) => Math.max(cursor, event.seq + 1), 0) } });

  // Begin an A refresh, then change ownership twice. A stale response cannot become current
  // merely because the selected id later returns to A.
  app.notifySession();
  await vi.waitFor(() => expect(details.map(entry => entry.id)).toEqual([first.id]));
  (w.document.querySelector(`#sessionList [data-id="${second.id}"]`) as HTMLButtonElement).click();
  expect(w.document.getElementById('chatTitle')!.textContent).toBe('Session B');
  expect(timeline.textContent).toContain('A QUESTION');
  expect(timeline.querySelector('img[alt="a-only.png"]')).not.toBeNull();
  expect(timeline.hasAttribute('inert')).toBe(true);
  expect(timeline.getAttribute('aria-busy')).toBe('true');
  expect(w.document.getElementById('timelineEmpty')!.hidden).toBe(true);
  expect(w.document.getElementById('handoffBox')!.textContent).toBe('');
  expect(w.document.getElementById('sessionControlStatus')!.textContent).toBe('');
  await vi.waitFor(() => expect(details.map(entry => entry.id)).toEqual([first.id, second.id]));
  // The queue read also repaints detail while the destination read remains pending.
  await settle();
  expect(timeline.textContent).toContain('A QUESTION');
  expect(w.document.getElementById('timelineEmpty')!.hidden).toBe(true);

  (w.document.querySelector(`#sessionList [data-id="${first.id}"]`) as HTMLButtonElement).click();
  expect(w.document.getElementById('chatTitle')!.textContent).toBe('Session A');
  expect(timeline.textContent).toContain('A QUESTION');
  await vi.waitFor(() => expect(details.map(entry => entry.id)).toEqual([first.id, second.id, first.id]));

  const staleA: Extract<SessionEvent, { kind: 'user_message' }> = {
    seq: 4, time: T0 + 4, source: 'extension', kind: 'user_message', messageId: 'stale-a', message: text('STALE A QUESTION'), attachments: [attachment]
  };
  details[1]!.reply({ ok: false, error: 'B detail unavailable' });
  details[0]!.reply(detail(first, [staleA]));
  controls[0]!.reply({ ok: true, data: { automation: 'off', objective: '', blocked: '', job: { busy: true } } });
  controls[1]!.reply({ ok: true, data: { automation: 'off', objective: '', blocked: 'blocked', job: null } });
  await settle();
  expect(w.document.getElementById('chatTitle')!.textContent).toBe('Session A');
  expect(timeline.textContent).not.toContain('STALE A QUESTION');
  expect(timeline.textContent).toContain('A QUESTION');
  expect(timeline.hasAttribute('inert')).toBe(true);
  expect(w.document.getElementById('sessionControlStatus')!.textContent).toBe('');

  const current: SessionEvent[] = [{ seq: 3, time: T0 + 3, source: 'extension', kind: 'assistant_message', messageId: 'a-current', message: text('CURRENT A ANSWER'), state: 'final', final: true }];
  details[2]!.reply(detail(first, current));
  controls[2]!.reply({ ok: true, data: { automation: 'off', objective: '', blocked: '', job: null, recovery: [] } });
  await settle();
  expect(timeline.textContent).toContain('CURRENT A ANSWER');
  expect(timeline.textContent).not.toContain('STALE A QUESTION');
  expect(timeline.querySelector('img[alt="a-only.png"]')).toBeNull();
  expect(timeline.hasAttribute('inert')).toBe(false);
  expect(timeline.hasAttribute('aria-busy')).toBe(false);
  expect(w.document.getElementById('timelineEmpty')!.hidden).toBe(true);
});

it.each(['failed', 'empty', 'new-chat'] as const)('retires retained rows after a %s destination without a welcome flash', async outcome => {
  const rows: SessionEvent[] = [{ seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'a', message: text('Previous chat') }];
  const first = summary(rows), second = { ...summary([]), id: 'other', title: 'Other session' };
  const { w } = await boot(rows, true, [], [], { sessions: [first, second] });
  let reply!: (value: unknown) => void;
  (w as any).api.getSession = () => new Promise(resolve => { reply = resolve; });
  const timeline = w.document.getElementById('timeline')!;
  const welcome = w.document.getElementById('timelineEmpty')!;
  (w.document.querySelector(`#sessionList [data-id="${second.id}"]`) as HTMLElement).click();
  await settle();
  expect(timeline.textContent).toContain('Previous chat');
  expect(welcome.hidden).toBe(true);
  if (outcome === 'new-chat') w.document.getElementById('newChat')!.click();
  reply(outcome === 'failed' ? { ok: false, error: 'Read failed' } : { ok: true, data: { summary: second, events: [], total: 0, nextFrom: 0 } });
  await settle();
  expect(timeline.textContent).toBe('');
  expect(timeline.hasAttribute('inert')).toBe(false);
  expect(timeline.hasAttribute('aria-busy')).toBe(false);
  expect(welcome.hidden).toBe(outcome !== 'new-chat');
});

it('keeps the current transcript and handoff mounted when Write Directly focuses the same session', async () => {
  const attachment = { id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', name: 'current.png', mimeType: 'image/png', size: 42, preview: 'data:image/webp;base64,YQ==' };
  const rows: SessionEvent[] = [
    { seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'current-question', message: text('CURRENT QUESTION'), attachments: [attachment] },
    toolCall(2, 'current-tool')
  ];
  const current = { ...summary(rows), title: 'Current session', lastHandoffId: 'current-handoff' };
  const saved: Handoff = { id: 'current-handoff', sessionId: current.id, createdAt: T0, text: 'CURRENT HANDOFF', sourceEvents: 2, sourceTokens: 10, notes: [] };
  const app = await boot(rows, true, [], [], { sessions: [current], handoff: saved });
  const { w } = app;
  const api = (w as any).api;
  let reject!: (value: unknown) => void;
  api.getSession = vi.fn(() => new Promise(resolve => { reject = resolve; }));

  app.writeSession(current.id);
  expect(w.document.activeElement).toBe(w.document.getElementById('chatInput'));
  expect(w.document.getElementById('chatTitle')!.textContent).toBe('Current session');
  expect(w.document.getElementById('timeline')!.textContent).toContain('CURRENT QUESTION');
  expect(w.document.querySelector('img[alt="current.png"]')).not.toBeNull();
  expect(w.document.querySelector('details.tool')?.textContent).toContain('Read README.md');
  expect(w.document.getElementById('handoffBox')!.textContent).toContain('CURRENT HANDOFF');
  expect(api.getSession).toHaveBeenCalledWith(current.id, { from: 3, limit: 30 });

  reject({ ok: false, error: 'same-session refresh unavailable' });
  await settle();
  expect(w.document.getElementById('timeline')!.textContent).toContain('CURRENT QUESTION');
  expect(w.document.getElementById('handoffBox')!.textContent).toContain('CURRENT HANDOFF');
});

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

it.each([false, true])('closes a saved queue editor while Save has focus (delayed refresh: %s)', async delayedRefresh => {
  const { w, live, append } = await boot([]);
  live.inputs.push({ id: 'edit-task', sessionId: summary([]).id, text: 'Before', mode: 'after-turn', dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b' });
  await append([]);
  (w.document.querySelector('[aria-label="Edit queued task"]') as HTMLButtonElement).click();
  const field = w.document.querySelector<HTMLTextAreaElement>('#finishQueue textarea')!;
  field.value = '  Saved task  ';
  const save = field.nextElementSibling as HTMLButtonElement;
  const edit = vi.fn(async () => { live.inputs[0]!.text = field.value.trim(); return { ok: true, data: true }; });
  (w as any).api.editQueuedInput = edit;
  // A refresh can wait on unrelated outbox work. Its completion is not the save receipt.
  if (delayedRefresh) (w as any).api.listInputs = () => new Promise(() => {});
  save.focus(); save.click(); await settle();
  expect(edit).toHaveBeenCalledWith('edit-task', '  Saved task  ');
  expect(w.document.querySelector('#finishQueue textarea')).toBeNull();
  expect(w.document.querySelector('#finishQueue .queue-label')?.textContent).toBe('Saved task');
});

it('keeps queue edits during refresh and allows only one pending save, retaining failed drafts', async () => {
  const { w, live, append } = await boot([]);
  live.inputs.push({ id: 'edit-task', sessionId: summary([]).id, text: 'Before', mode: 'finish', dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b' });
  await append([]);
  (w.document.querySelector('[aria-label="Edit queued task"]') as HTMLButtonElement).click();
  const field = w.document.querySelector<HTMLTextAreaElement>('#finishQueue textarea')!;
  field.value = 'Keep my edit';
  const save = field.nextElementSibling as HTMLButtonElement;
  let finish!: (result: unknown) => void;
  const edit = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  (w as any).api.editQueuedInput = edit;
  save.focus(); save.click(); save.click();
  expect(edit).toHaveBeenCalledTimes(1);
  expect(save.disabled).toBe(true);
  expect(save.textContent).toBe('Saving…');
  w.document.getElementById('chatInput')!.focus(); await append([]);
  expect(w.document.querySelector('#finishQueue textarea')).toBe(field);
  finish({ ok: false, error: 'Could not save this task' }); await settle();
  expect(field.value).toBe('Keep my edit'); expect(field.readOnly).toBe(false);
  expect(save.disabled).toBe(false); expect(save.textContent).toBe('Save');
  expect(w.document.body.textContent).toContain('Could not save this task');
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

it('identifies automatic Continue without user-task editing or reordering and keeps its cancellation', async () => {
  const { w, live, append } = await boot([]);
  const sessionId = summary([]).id;
  const recovery: InputEntry = { id: 'automatic-continue', sessionId, text: 'Resume the unfinished work.', mode: 'after-turn',
    dueAt: 0, model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b',
    recovery: { questionId: 'source-question', pro: false, busyUntil: Date.now() + 60_000, phase: 'ready' } };
  live.inputs.push(recovery, ...['first', 'second'].map((text, index): InputEntry => ({
    id: `authored-${index}`, sessionId, text, mode: 'after-turn', dueAt: 0, model: null, reasoningEffort: null,
    state: 'queued', owner: null, createdAt: index + 1, conversationId: 'chat-b'
  })));
  const api = (w as any).api;
  api.reorderQueuedInputs = vi.fn(async () => ({ ok: true, data: true }));
  await append([]);
  const card = w.document.querySelector<HTMLElement>('#finishQueue [data-input-id="automatic-continue"]')!;
  expect(card.textContent).toContain('Automatic Continue');
  expect(card.textContent).toContain(recovery.text);
  expect(card.querySelector<HTMLElement>('.queue-label')!.title).toContain('without a final answer');
  expect(card.querySelector('[aria-label="Edit queued task"]')).toBeNull();
  expect(card.querySelector('[draggable="true"]')).toBeNull();
  const second = w.document.querySelector('#finishQueue [data-input-id="authored-1"] .queue-label')!;
  second.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
  await settle();
  expect(api.reorderQueuedInputs).toHaveBeenCalledWith(sessionId, ['authored-1', 'authored-0']);
  w.document.querySelector<HTMLButtonElement>('#finishQueue [aria-label="Cancel automatic Continue"]')!.click();
  await settle();
  expect(api.cancelInput).toHaveBeenCalledWith(recovery.id);
  expect(live.inputs[0]!.state).toBe('cancelled');
  expect(w.document.querySelector('#finishQueue [data-input-id="automatic-continue"]')).toBeNull();
  expect(w.document.querySelectorAll('#finishQueue [aria-label="Edit queued task"]')).toHaveLength(2);
});

it('keeps a transport-deferred immediate upload visible with cancellation instead of an invalid task editor', async () => {
  const { w, live, append } = await boot([]);
  live.inputs.push({ id: 'native-correction', sessionId: summary([]).id, text: 'Waiting upload', mode: 'after-turn', requestedMode: 'auto',
    dueAt: 0, model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b',
    attachments: [{ id: 'native-file', name: 'notes.txt', mimeType: 'text/plain', size: 12 }] });
  await append([]);
  const row = w.document.querySelector('#inputQueue [data-input-id="native-correction"]');
  expect(row?.textContent).toContain('Waiting upload');
  expect(row?.textContent).toContain('notes.txt');
  expect(w.document.querySelector('#finishQueue [data-input-id="native-correction"]')).toBeNull();
  (row!.querySelector('[aria-label="Cancel delivery"]') as HTMLButtonElement).click();
  await settle();
  expect(live.inputs[0]?.state).toBe('cancelled');
  expect(w.document.querySelector('[data-input-id="native-correction"]')).toBeNull();
});

it('keeps cancelled Continue attempts at their own times across a long session instead of stacking them under the current chat', async () => {
  const rows: SessionEvent[] = [0, 1, 2, 3].map(index => ({
    seq: index + 1, time: T0 + index * 60_000, source: 'extension', kind: 'user_message',
    messageId: `night-question-${index}`, message: text(`NIGHT QUESTION ${index}`)
  }));
  const { w, live, append } = await boot(rows);
  for (let index = 0; index < 3; index++) live.inputs.push({
    id: `retired-continue-${index}`, sessionId: summary(rows).id, text: `UNSENT CONTINUE ${index}`,
    mode: 'after-turn', dueAt: T0 + index * 60_000 + 1000, createdAt: T0 + index * 60_000 + 1000,
    model: null, reasoningEffort: null, state: 'cancelled', owner: null, conversationId: `old-chat-${index}`,
    error: 'Automatic Continue cancelled: the source turn, activity or setting changed.',
    recovery: { questionId: `night-question-${index}`, pro: false, busyUntil: T0 + index * 60_000 + 61_000, phase: 'ready' }
  });
  await append([]);
  expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('UNSENT CONTINUE');
  const timeline = w.document.getElementById('timeline')!;
  for (let index = 0; index < 3; index++) {
    const card = timeline.querySelector<HTMLElement>(`[data-input-id="retired-continue-${index}"]`)!;
    expect(card).not.toBeNull();
    expect(card.querySelector('time')?.textContent).toBe(new Date(live.inputs[index]!.createdAt).toLocaleString());
    const content = timeline.textContent!;
    expect(content.indexOf(`NIGHT QUESTION ${index}`)).toBeLessThan(content.indexOf(`UNSENT CONTINUE ${index}`));
    expect(content.indexOf(`UNSENT CONTINUE ${index}`)).toBeLessThan(content.indexOf(`NIGHT QUESTION ${index + 1}`));
  }
});

it.each(['trash', 'empty-save'])('removes a queued message during editing via %s even while a refresh is delayed', async action => {
  const { w, live, append } = await boot([]);
  live.inputs.push({ id: 'remove-edit', sessionId: summary([]).id, text: 'Delete me', mode: 'after-turn', dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b' });
  await append([]);
  (w.document.querySelector('[aria-label="Edit queued task"]') as HTMLButtonElement).click();
  const field = w.document.querySelector<HTMLTextAreaElement>('#finishQueue textarea')!;
  (w as any).api.listInputs = () => new Promise(() => {});
  if (action === 'empty-save') field.value = ' \n\t ';
  const button = action === 'trash' ? w.document.querySelector('#finishQueue [aria-label="Remove queued task"]') : field.nextElementSibling;
  expect(button).not.toBeNull();
  (button as HTMLButtonElement).click(); await settle();
  expect((w as any).api.cancelInput).toHaveBeenCalledWith('remove-edit');
  expect(live.inputs[0]?.state).toBe('cancelled');
  expect(w.document.querySelector('#finishQueue textarea')).toBeNull();
  expect(w.document.getElementById('finishQueue')!.hidden).toBe(true);
});

it.each(['cancelled', 'browser'])('retires the editor when Save learns the queued message became %s', async state => {
  const { w, live, append } = await boot([]);
  live.inputs.push({ id: 'retired-edit', sessionId: summary([]).id, text: 'Original', mode: 'after-turn', dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b' });
  await append([]);
  (w.document.querySelector('[aria-label="Edit queued task"]') as HTMLButtonElement).click();
  const field = w.document.querySelector<HTMLTextAreaElement>('#finishQueue textarea')!;
  field.value = 'Late edit';
  (w as any).api.editQueuedInput = async () => {
    live.inputs[0]!.state = state as InputEntry['state'];
    return { ok: true, data: false };
  };
  (field.nextElementSibling as HTMLButtonElement).click(); await settle();
  expect(w.document.querySelector('#finishQueue textarea')).toBeNull();
  expect(live.inputs[0]?.text).toBe('Original');
  if (state === 'cancelled') expect(w.document.querySelector('#finishQueue [data-input-id="retired-edit"]')).toBeNull();
  else expect(w.document.querySelector('#finishQueue [data-input-id="retired-edit"]')).not.toBeNull();
});

it('retires a queued editor synchronously on New Chat and ignores its delayed save after returning', async () => {
  const { w, live, append } = await boot([]);
  live.inputs.push({ id: 'old-editor', sessionId: summary([]).id, text: 'Original', mode: 'finish', dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b' });
  await append([]);
  (w.document.querySelector('[aria-label="Edit queued task"]') as HTMLButtonElement).click();
  let resolveSave!: (value: unknown) => void;
  (w as any).api.editQueuedInput = () => new Promise(resolve => { resolveSave = resolve; });
  const field = w.document.querySelector<HTMLTextAreaElement>('#finishQueue textarea')!;
  field.value = 'Old save'; (field.nextElementSibling as HTMLButtonElement).click();
  w.document.getElementById('newChat')!.click();
  expect(w.document.querySelector('#finishQueue textarea')).toBeNull();
  expect(w.document.getElementById('finishQueue')!.hidden).toBe(true);
  (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click(); await settle();
  (w.document.querySelector('[aria-label="Edit queued task"]') as HTMLButtonElement).click();
  const fresh = w.document.querySelector<HTMLTextAreaElement>('#finishQueue textarea')!;
  fresh.value = 'New edit'; resolveSave({ ok: true, data: true }); await settle();
  expect(w.document.querySelector('#finishQueue textarea')).toBe(fresh);
  expect(fresh.value).toBe('New edit');
});

it('keeps canonical image attachments above the user text bubble for the selected session', async () => {
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
  expect(attachments.nextElementSibling?.classList.contains('user-message-text')).toBe(true);
  await settle();
  expect(getImage).toHaveBeenCalledWith(summary([]).id, 'abcdef.bin');
  expect(attachments.querySelector('img')?.getAttribute('src')).toBe('data:image/webp;base64,YQ==');
});

it('reserves every saved user-image slot before IPC and keeps missing previews inside their slots', async () => {
  const app = await boot([]);
  const pending: Array<(value: unknown) => void> = [];
  (app.w as any).api.getSessionImage = vi.fn(() => new Promise(resolve => pending.push(resolve)));
  await app.append([{ seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'two-images',
    message: text('Inspect both'), assets: ['one.webp', 'two.webp'].map(id => ({ id, mimeType: 'image/webp', bytes: 12 })) }]);
  const attachments = app.w.document.querySelector('.message-attachments')!;
  const slots = [...attachments.querySelectorAll('.user-image-slot')];
  expect(slots).toHaveLength(2);
  expect(attachments.children).toHaveLength(2);
  pending[0]!({ ok: true, data: null }); await settle();
  expect(slots[0]!.textContent).toContain('Image unavailable');
  pending[1]!({ ok: true, data: 'data:image/webp;base64,YQ==' }); await settle();
  expect(slots[1]!.querySelector('img')).not.toBeNull();
  expect([...attachments.children]).toEqual(slots);
});

it('keeps a retained fallback and its unsaved notice inside the reserved user-image footprint', async () => {
  const app = await boot([]);
  const dataUrl = 'data:image/webp;base64,YQ==';
  app.live.inputs.push({ id: 'fallback-input', sessionId: summary([]).id, state: 'sent', owner: null,
    text: 'Fallback', mode: 'auto', model: null, reasoningEffort: null, dueAt: T0, createdAt: T0,
    conversationId: 'chat-b', messageId: 'fallback-message', toolImages: [{ name: 'fallback.webp', dataUrl }] });
  (app.w as any).api.getSessionImage = vi.fn(async () => ({ ok: true, data: null }));
  await app.append([{ seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'fallback-message',
    inputId: 'fallback-input', message: text('Fallback'), assets: [{ id: 'missing.webp', mimeType: 'image/webp', bytes: 12 }] }]);
  const attachments = app.w.document.querySelector('.message-attachments')!;
  expect(attachments.children).toHaveLength(1);
  const slot = attachments.firstElementChild!;
  expect(slot.className).toBe('user-image-slot');
  expect(slot.querySelector('img')?.getAttribute('src')).toBe(dataUrl);
  expect(slot.querySelector('.retained-image-notice')?.textContent).toBe('Not saved to history');
});

it.each([false, true])('keeps retained image previews at the canonical row across queue/history arrival and off-tail reload (historyFirst=%s)', async historyFirst => {
  const app = await boot([]);
  const { w, live, append } = app;
  const row: InputEntry = { id: 'image-input', sessionId: summary([]).id, state: 'sent', owner: null, text: 'Original image request',
    mode: 'auto', model: null, reasoningEffort: null, dueAt: T0, createdAt: T0, deliveredAt: T0 + 10, conversationId: 'chat-b',
    messageId: 'input:image-input', historyRecorded: false, historyAnchored: true,
    toolImages: [{ name: 'retained.webp', dataUrl: 'data:image/webp;base64,YQ==' }] };
  const message: SessionEvent = { seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: row.messageId,
    inputId: row.id, inputDelivery: 'confirmed', message: text(row.text) };
  if (historyFirst) await append([message]);
  live.inputs.push(row);
  await append(historyFirst ? [] : [message]);
  expect(w.document.querySelectorAll('#timeline .said.is-user img')).toHaveLength(1);
  expect(w.document.querySelector('#timeline .said.is-user img')?.getAttribute('src')).toBe(row.toolImages![0]!.dataUrl);
  const retainedNotice = w.document.querySelector('#timeline .retained-image-notice')!;
  expect(retainedNotice.textContent).toBe('Not saved to history');
  expect(retainedNotice.parentElement?.className).toBe('user-image-slot');
  expect(retainedNotice.previousElementSibling?.tagName).toBe('IMG');
  expect(w.document.querySelector('#inputQueue')!.textContent).not.toContain(row.text);
  // Queue changes must repaint the same canonical row, never borrow another owner.
  live.inputs[0] = { ...row, sessionId: 'another-session' };
  await append([]);
  expect(w.document.querySelector('#timeline .said.is-user img')).toBeNull();
  live.inputs[0] = row; await append([]);
  const api = (w as any).api;
  api.getSessionImage = vi.fn(async () => ({ ok: true, data: row.toolImages![0]!.dataUrl }));
  await append([{ ...message, seq: 2, origin: 1, assets: [{ id: 'saved.webp', mimeType: 'image/webp', bytes: 1 }] }]);
  expect(w.document.querySelectorAll('#timeline .said.is-user img')).toHaveLength(1);
  expect(w.document.querySelector('#timeline .retained-image-notice')).toBeNull();
  await append(Array.from({ length: 180 }, (_, i): SessionEvent => ({ seq: i + 3, time: T0 + i + 20, kind: 'user_message',
    source: 'extension', messageId: `newer-${i}`, message: text(`Newer ${i}`) })));
  const original = api.getSession;
  api.getSession = async (id: string, options: any) => {
    const result = await original(id, options);
    if (options?.from === undefined && options?.before === undefined) result.data.events = result.data.events.slice(-160);
    return result;
  };
  w.document.getElementById('newChat')!.click(); await settle();
  (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click(); await settle();
  expect(w.document.querySelector('#timeline')!.textContent).not.toContain(row.text);
  expect(w.document.querySelector('#inputQueue')!.textContent).not.toContain(row.text);
});

it.each([false, true])('hands a delivered bubble to exact native history without a blank or duplicate (historyFirst=%s)', async historyFirst => {
  const { w, live, append } = await boot([]);
  const row: InputEntry = { id: 'delivery-one', sessionId: summary([]).id, state: 'browser', owner: 'page', text: 'Follow-up once',
    mode: 'auto', model: null, reasoningEffort: null, dueAt: T0, createdAt: T0, conversationId: 'chat-b' };
  live.inputs.push(row); await append([]);
  const original = w.document.querySelector('#inputQueue .pending-message');
  await append([]);
  expect(w.document.querySelector('#inputQueue .pending-message')).toBe(original);
  const message: SessionEvent = { seq: 1, time: T0 + 1, source: 'app', kind: 'user_message', messageId: 'native-followup',
    inputId: row.id, message: text(row.text) };
  if (historyFirst) await append([message]);
  else {
    live.inputs[0] = { ...row, state: 'sent', messageId: 'native-followup', historyAnchored: true, deliveredAt: T0 + 1 };
    await append([]);
  }
  const count = () => [...w.document.querySelectorAll('#timeline .said.is-user, #inputQueue .pending-message')].filter(node => node.textContent?.includes(row.text)).length;
  expect(count()).toBe(1);
  if (historyFirst) live.inputs[0] = { ...row, state: 'sent', messageId: 'native-followup', historyAnchored: true, deliveredAt: T0 + 1 };
  await append(historyFirst ? [] : [message]);
  expect(count()).toBe(1);
  expect(w.document.querySelector('#inputQueue .pending-message')).toBeNull();
});

it.each([undefined, 4])('never resurrects committed off-page inputs beside genuinely waiting inputs when old timestamps reappear (historySeq=%s)', async historySeq => {
  const events = Array.from({ length: 180 }, (_, i): SessionEvent => ({ ...toolCall(i + 10, `receipt-${i}`), time: T0 - 100 }));
  const { w, live, append } = await boot(events);
  const base = { sessionId: summary([]).id, owner: null, mode: 'auto' as const, model: null, reasoningEffort: null,
    dueAt: T0, createdAt: T0, conversationId: 'chat-b' };
  live.inputs.push({ ...base, id: 'old-delivered', text: 'Already delivered correction', state: 'sent',
    messageId: 'input:old-delivered', deliveredAt: T0 + 20, historyAnchored: true, historyRecorded: true, historySeq },
    { ...base, id: 'still-waiting', text: 'Genuinely waiting correction', state: 'queued' },
    { ...base, id: 'history-in-flight', text: 'Receipt preceding history snapshot', state: 'sent',
      messageId: 'input:history-in-flight', deliveredAt: T0 + 30, historyAnchored: true, historySeq: 200 });
  for (let i = 0; i < 2; i++) {
    await append([]);
    const queue = w.document.querySelector('#inputQueue')!;
    expect(queue.textContent).not.toContain('Already delivered correction');
    expect(queue.textContent).toContain('Genuinely waiting correction');
    expect(queue.textContent).toContain('Receipt preceding history snapshot');
  }
  await append([{ seq: 200, origin: 200, time: T0 + 30, kind: 'user_message', source: 'app',
    inputId: 'history-in-flight', messageId: 'input:history-in-flight', message: text('Receipt preceding history snapshot') }]);
  expect(w.document.querySelector('#inputQueue')!.textContent).not.toContain('Receipt preceding history snapshot');
  expect(w.document.querySelector('#timeline')!.textContent).toContain('Receipt preceding history snapshot');
});

it('does not request conversation-only controls for a local chat without a provider binding', async () => {
  const reserved = { ...summary([]), conversationId: null, chatIds: [], origin: { kind: 'desktop' as const, fromSessionId: null, agentId: null, task: '' } };
  const { w, append } = await boot([], true, [], [], { sessions: [reserved] });
  const controls = vi.fn(async () => ({ ok: false, error: 'session_not_recorded' }));
  (w as any).api.getSessionControls = controls;
  await append([]); await append([]);
  expect(controls).not.toHaveBeenCalled();
  expect(w.document.getElementById('compactSession')!.hidden).toBe(true);
});

it('removes a withdrawn newest chat after sidebar pagination while preserving the older page', async () => {
  const opening = { ...summary([]), id: 'reserved-opening', title: 'Withdrawn', updatedAt: T0 + 3,
    conversationId: null, chatIds: [], origin: { kind: 'desktop' as const, fromSessionId: null, agentId: null, task: '' } };
  const retained = { ...summary([]), id: 'retained-chat', updatedAt: T0 + 2 };
  const older = { ...summary([]), id: 'older-chat', updatedAt: T0 + 1 };
  const { w, append } = await boot([], false, [], [], { sessions: [opening, retained] });
  let withdrawn = false, complete = false;
  (w as any).api.listSessions = async (options: any) => ({ ok: true, data: {
    sessions: options?.cursor ? [older] : withdrawn ? [retained] : [opening, retained],
    total: complete ? 1 : withdrawn ? 2 : 3, nextCursor: options?.cursor || complete ? null : { updatedAt: retained.updatedAt, id: retained.id },
    activeId: null, pressure: [], blocked: []
  } });
  await append([]);
  w.document.getElementById('sessionList')!.closest('.scroll')!.dispatchEvent(new w.Event('scroll'));
  await settle();
  expect(w.document.querySelector('[data-id="older-chat"]')).not.toBeNull();
  withdrawn = true; await append([]);
  expect(w.document.querySelector('[data-id="reserved-opening"]')).toBeNull();
  expect(w.document.querySelector('[data-id="older-chat"]')).not.toBeNull();
  complete = true; await append([]);
  expect(w.document.querySelector('[data-id="older-chat"]')).toBeNull();
  expect(w.document.querySelector('[data-id="retained-chat"]')).not.toBeNull();
});

it('reserves geometry and hydrates multiple native generated images independently in source order', async () => {
  const app = await boot([]);
  const { w } = app;
  const pending = new Map<string, (value: unknown) => void>();
  (w as any).api.getSessionImage = vi.fn((_sessionId: string, assetId: string) => new Promise(resolve => pending.set(assetId, resolve)));
  const messageId = '3150f756-bf2d-45fa-ac0f-45010b2239fb';
  const events: SessionEvent[] = [
    { seq: 1, time: T0, source: 'extension', kind: 'native_image', messageId,
      providerAssetId: 'file_blue', providerRole: 'tool', providerChannel: 'final', width: 1254, height: 1254,
      previewStatus: 'available', previewWidth: 12, previewHeight: 12, asset: { id: 'blue.webp', mimeType: 'image/webp', bytes: 12 } },
    { seq: 2, time: T0 + 1, source: 'extension', kind: 'native_image', messageId,
      providerAssetId: 'file_orange', providerRole: 'tool', providerChannel: 'final', width: 1024, height: 768,
      previewStatus: 'available', previewWidth: 16, previewHeight: 12, asset: { id: 'orange.webp', mimeType: 'image/webp', bytes: 12 } }
  ];
  await app.append(events);

  const rows = [...w.document.querySelectorAll<HTMLElement>('.said.native-image')];
  expect(rows).toHaveLength(2);
  expect(w.document.querySelectorAll('.generated-image-gallery')).toHaveLength(1);
  expect(w.document.querySelector('.generated-image-gallery')?.querySelectorAll('.ev-native_image')).toHaveLength(2);
  const frames = rows.map(row => row.querySelector<HTMLElement>('.generated-image-frame')!);
  expect(frames.map(frame => frame.style.aspectRatio)).toEqual(['1254 / 1254', '1024 / 768']);
  expect(frames.every(frame => frame.textContent === 'Image preview is loading')).toBe(true);

  pending.get('orange.webp')?.({ ok: true, data: 'data:image/webp;base64,b3Jhbmdl' });
  await settle();
  expect(frames[1]!.querySelector('img')?.getAttribute('src')).toContain('b3Jhbmdl');
  expect(frames[0]!.querySelector('img')).toBeNull();
  pending.get('blue.webp')?.({ ok: true, data: 'data:image/webp;base64,Ymx1ZQ==' });
  await settle();
  expect(frames[0]!.querySelector('img')?.getAttribute('src')).toContain('Ymx1ZQ==');
});

it('keeps generated-image metadata visible when recording storage is full', async () => {
  const app = await boot([]);
  await app.append([{ seq: 1, time: T0, source: 'extension', kind: 'native_image',
    messageId: '5150f756-bf2d-45fa-ac0f-45010b2239fb', providerAssetId: 'file_quota_fixture',
    providerRole: 'tool', providerChannel: 'final', providerStatus: 'finished_successfully',
    width: 1254, height: 1254, previewStatus: 'unavailable', previewError: 'quota' }]);
  const row = app.w.document.querySelector('.said.native-image')!;
  expect(row.textContent).toContain('recording storage is full');
  expect(row.querySelector('.generated-image-frame')).toBeTruthy();
  expect(row.querySelector('img')).toBeNull();
  expect(row.querySelector('.generated-image-frame')?.classList.contains('is-unavailable')).toBe(true);
  expect(row.querySelector('button')?.textContent).toBe('Free image storage');
});

it('does not group images across an intervening authored message or another turn', async () => {
  const app = await boot([]);
  const image = (seq: number, turnId: string): SessionEvent => ({ seq, time: T0 + seq,
    source: 'extension', kind: 'native_image', messageId: `image-${seq}`, providerAssetId: `file-${seq}`,
    providerRole: 'tool', turnId, previewStatus: 'pending' });
  await app.append([image(1, 'a'), image(2, 'a'),
    { seq: 3, time: T0 + 3, source: 'extension', kind: 'assistant_message', messageId: 'text-3',
      turnId: 'a', final: false, message: { text: 'Between images', chars: 14, truncated: false } },
    image(4, 'a'), image(5, 'b')]);
  const galleries = [...app.w.document.querySelectorAll('.generated-image-gallery')];
  expect(galleries.map(gallery => gallery.querySelectorAll('.ev-native_image').length)).toEqual([2, 1, 1]);
  expect(galleries[0]?.nextElementSibling?.textContent).toContain('Between images');
});

it('retains one exact-message gallery when only one image gains a proven turn', async () => {
  const app = await boot([]);
  const first: SessionEvent = { seq: 1, time: T0, source: 'extension', kind: 'native_image',
    messageId: 'shared-image-message', providerAssetId: 'file-one', providerRole: 'tool', previewStatus: 'pending' };
  await app.append([first, { ...first, seq: 2, time: T0 + 1, providerAssetId: 'file-two' }]);
  const gallery = app.w.document.querySelector('.generated-image-gallery');
  await app.append([{ ...first, seq: 3, origin: 1, turnId: 'proven-turn', previewStatus: 'unavailable', previewError: 'quota' }]);
  expect(app.w.document.querySelectorAll('.generated-image-gallery')).toHaveLength(1);
  expect(app.w.document.querySelector('.generated-image-gallery')).toBe(gallery);
  expect(gallery?.querySelectorAll('.ev-native_image')).toHaveLength(2);
});

it('shows a native image-only message immediately as a card without a guessed caption or image fetch', async () => {
  const app = await boot([]);
  await app.append([{ seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'native-image-only',
    message: text(''), attachments: [{ id: 'native-provider-file', name: 'example.png', size: 123, mimeType: 'image/png' }] }]);
  const row = app.w.document.querySelector('.said.is-user')!;
  expect(row.querySelector('.attachment-card')?.textContent).toContain('example.png');
  expect(row.querySelector('.user-message-text')).toBeNull();
  expect(row.querySelector('img')).toBeNull();
});

it.each(['image', 'txt', 'mixed', 'new-chat', 'after-turn'])('routes the composer attachment action truthfully (%s)', async kind => {
  const app = await boot([], kind !== 'new-chat');
  const image = { id: '11111111-2222-4333-8444-555555555555', name: 'image.png', mimeType: 'image/png', size: 42 };
  const txt = { ...image, id: '22222222-2222-4333-8444-555555555555', name: 'notes.txt', mimeType: 'text/plain' };
  const files = kind === 'txt' ? [txt] : kind === 'mixed' ? [image, txt] : [image];
  (app.w as any).api.chooseFiles = async () => ({ ok: true, data: files });
  app.w.document.getElementById('attachImages')!.click(); await settle();
  expect(app.w.document.getElementById('immediateDeliveryLabel')!.textContent).toBe(
    kind === 'new-chat' ? 'Send' : ['txt', 'mixed'].includes(kind) ? 'After this turn' : 'Inject now');
  if (kind === 'after-turn') (app.w.document.getElementById('sendMode') as HTMLSelectElement).value = 'after-turn';
  app.w.document.getElementById('composer')!.dispatchEvent(new app.w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(app.live.sent).toHaveLength(1);
  expect(app.live.sent[0]).toMatchObject({ text: 'Please look at the attached files.', attachments: files });
  expect(app.live.sent[0]!.attachmentDelivery).toBe(kind === 'image' ? 'tool' : undefined);
});

it('restores the image draft after rejected injection and removes native-only delivery when the document is removed', async () => {
  const app = await boot([]);
  const image = { id: '11111111-2222-4333-8444-555555555555', name: 'image.png', mimeType: 'image/png', size: 42 };
  const txt = { ...image, id: '22222222-2222-4333-8444-555555555555', name: 'notes.txt', mimeType: 'text/plain' };
  (app.w as any).api.getSessionControls = async () => ({ ok: true, data: { sessionId: summary([]).id, activeTurnId: 'held-turn', canInject: true, queueAtFinish: true } });
  await app.append([]);
  (app.w as any).api.chooseFiles = async () => ({ ok: true, data: [image, txt] });
  app.w.document.getElementById('attachImages')!.click(); await settle();
  expect(app.w.document.getElementById('afterTurnLabel')!.textContent).toBe('After this turn');
  expect(app.w.document.getElementById('queueAtFinish')!.hidden).toBe(true);
  (app.w.document.querySelector('[aria-label="Remove notes.txt"]') as HTMLButtonElement).click();
  expect(app.w.document.getElementById('immediateDeliveryLabel')!.textContent).toBe('Inject now');
  (app.w as any).api.sendInput = async () => ({ ok: false, error: 'Image is too large for injection' });
  const field = app.w.document.getElementById('chatInput') as HTMLTextAreaElement;
  field.value = 'Use the original image';
  app.w.document.getElementById('composer')!.dispatchEvent(new app.w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(field.value).toBe('Use the original image');
  expect(app.w.document.querySelectorAll('#composerImages .image-remove')).toHaveLength(1);
  expect(app.w.document.querySelector('[aria-label="Remove image.png"]')).not.toBeNull();
});

it.each([7, 10, 11])('uses the same visible delivery choice and payload for %s attached images', async count => {
  const { w, live } = await boot([]);
  const files = Array.from({ length: count }, (_, index) => ({
    id: `image-${index}`, name: `image-${index}.png`, mimeType: 'image/png', size: 42
  }));
  (w as any).api.chooseFiles = async () => ({ ok: true, data: files });
  w.document.getElementById('attachImages')!.click(); await settle();
  const inject = w.document.querySelector<HTMLElement>('[data-delivery="tool"]')!;
  expect(inject.hidden).toBe(count > 10);
  expect(w.document.getElementById('immediateDeliveryLabel')!.textContent).toBe(count > 10 ? 'After this turn' : 'Inject now');
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]?.attachments).toEqual(files);
  expect(live.sent[0]?.delivery).toBe(count > 10 ? undefined : 'tool');
});

it('uses the same separate image row for pending and recorded native attachments', async () => {
  const app = await boot([]);
  const attachment = { id: 'a'.repeat(32), name: 'meme.png', mimeType: 'image/png', size: 42, preview: 'data:image/webp;base64,YQ==' };
  app.live.inputs.push({ id: 'image-input', sessionId: summary([]).id, text: 'whats that', attachments: [attachment],
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null, state: 'browser', owner: null, createdAt: T0, conversationId: 'chat-b' });
  await app.append([]);
  const pending = app.w.document.querySelector('.pending-message')!;
  expect(pending.querySelector('.message-attachments')?.nextElementSibling?.className).toBe('pending-message-text');
  expect(pending.querySelector('.composer-image')).toBeNull();
  await app.append([{ seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'native-image',
    inputId: 'image-input', message: text('whats that'), attachments: [attachment] }]);
  const recorded = app.w.document.querySelector('.said.is-user')!;
  expect(recorded.querySelector('.message-attachments')?.nextElementSibling?.classList.contains('user-message-text')).toBe(true);
  expect(recorded.querySelector('.message-attachments > img')?.getAttribute('alt')).toBe('meme.png');
  expect(recorded.querySelector('.composer-image')).toBeNull();
});

it('keeps all ten injected image previews when the outbox message gains its canonical history row', async () => {
  const { w, live, append } = await boot([]);
  const images = Array.from({ length: 10 }, (_, index) => ({ name: `reference-${index}.webp`, dataUrl: 'data:image/webp;base64,YQ==' }));
  live.inputs.push({ id: 'ten-images', sessionId: summary([]).id, text: 'Ten references', images, mode: 'auto', dueAt: 0,
    state: 'tool', owner: 'request', createdAt: 0, conversationId: 'chat-b', model: null, reasoningEffort: null });
  await append([]);
  expect(w.document.querySelectorAll('#inputQueue [data-input-id="ten-images"] img')).toHaveLength(10);
  await append([{ seq: 1, source: 'app', time: T0, kind: 'user_message', inputId: 'ten-images', messageId: 'input:ten-images', message: text('Ten references') }]);
  expect(w.document.querySelectorAll('#timeline .user-image-slot img')).toHaveLength(10);
  expect(w.document.querySelector('#inputQueue [data-input-id="ten-images"]')).toBeNull();
});

it('explains a legacy missing image recording without asserting a provider receipt', async () => {
  const app = await boot([]);
  const event = toolCall(1, 'missing-image') as Extract<SessionEvent, { kind: 'tool_call' }>;
  event.call.tool = 'view_image';
  event.call.result = text('');
  await app.append([event]);
  const tool = app.w.document.querySelector('details.tool') as HTMLDetailsElement;
  tool.open = true; tool.dispatchEvent(new app.w.Event('toggle'));
  await settle();
  expect(tool.textContent).toContain('No image preview was retained in this recording.');
  expect(tool.textContent).not.toContain('received');
});

it('loads recorded tool images on expansion and hides truncated binary envelopes', async () => {
  const app = await boot([]);
  const { w } = app;
  const event = toolCall(1, 'plugin-image') as Extract<SessionEvent, { kind: 'tool_call' }>;
  event.call.tool = 'get_viewport_screenshot';
  event.call.result = { text: '{"content":[{"type":"image","data":"AAAA', truncated: true, chars: 140000, assetId: 'aaaaaaaa.txt' };
  event.call.assets = [{ id: 'abcdefab.png', mimeType: 'image/png', bytes: 99000 }];
  const getImage = vi.fn(async () => ({ ok: true, data: 'data:image/png;base64,YQ==' }));
  (w as any).api.getSessionImage = getImage;
  await app.append([event]);
  const tool = w.document.querySelector('details.tool') as HTMLDetailsElement;
  expect(getImage).not.toHaveBeenCalled();
  expect(tool.textContent).not.toContain('AAAA');
  expect(tool.textContent).not.toContain('aaaaaaaa.txt');
  tool.open = true; tool.dispatchEvent(new w.Event('toggle'));
  await settle();
  expect(tool.textContent).toContain('aaaaaaaa.txt');
  expect(tool.textContent).not.toContain('AAAA');
  expect(getImage).toHaveBeenCalledWith(summary([]).id, 'abcdefab.png');
  expect(tool.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,YQ==');
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
it('shows five project chats initially and reveals eight more per click', async () => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Paged', path: '/paged', createdAt: 1 };
  const tasks = Array.from({ length: 22 }, (_, index) => ({ ...summary([]), id: `page-task-${index}`, conversationId: `chat-${index}`, projectId: project.id }));
  const { w, append } = await boot([], false, [], [project], { sessions: tasks });
  const section = () => w.document.querySelector('.project-group')!;
  expect(section().querySelectorAll(':scope > .sess')).toHaveLength(5);
  for (const count of [13, 21, 22]) {
    (section().querySelector('.project-show-more') as HTMLButtonElement).click();
    expect(section().querySelectorAll(':scope > .sess')).toHaveLength(count);
  }
  expect(section().querySelector('.project-show-more')).toBeNull();
  await append([]);
  expect(section().querySelectorAll(':scope > .sess')).toHaveLength(22);
});

it('shows original user text while retaining transport instructions outside the visible bubble', async () => {
  const { w } = await boot([{ seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'native-one', inputId: 'one', authoredText: 'hello', message: text('hello\n\nTransport-only control instruction') }]);
  expect(w.document.querySelector('.said.is-user .msg')?.textContent).toBe('hello');
  expect(w.document.body.textContent).toContain('hello');
});
it.each(['', '\n', '\n\n'])('hides complete worker instructions without an app receipt, including native prefix %j', async prefix => {
  const sent = prefix + prependUserPrompt('Visible authored message', 'Invisible complete guidance');
  const { w } = await boot([{ seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'echo', message: text(sent) }]);
  expect(w.document.querySelector('.said.is-user .msg')?.textContent).toBe('Visible authored message');
  expect(w.document.body.textContent).not.toContain('Invisible complete guidance');
});

it('imports one physical file drop from the composer, timeline, or sidebar exactly once and caps attachments', async () => {
  const { w } = await boot([], false);
  const api = (w as any).api;
  const image = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'dropped.md', size: 12, mimeType: 'text/markdown' };
  api.dropFiles = vi.fn(async () => ({ ok: true, data: [image] }));
  const drop = (target: Element, count: number) => {
    const event = new w.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: Array.from({ length: count }, () => new w.File(['image'], 'image.png', { type: 'image/png' })) } });
    target.dispatchEvent(event);
    return event;
  };
  expect(drop(w.document.getElementById('timeline')!, 1).defaultPrevented).toBe(true);
  await settle();
  expect(api.dropFiles).toHaveBeenCalledTimes(1);
  expect(drop(w.document.getElementById('composer')!, 1).defaultPrevented).toBe(true);
  await settle();
  expect(api.dropFiles).toHaveBeenCalledTimes(2);
  expect(drop(w.document.getElementById('sessionList')!, 1).defaultPrevented).toBe(true);
  await settle();
  expect(api.dropFiles).toHaveBeenCalledTimes(3);
  expect(w.document.querySelectorAll('#composerImages .attachment-card')).toHaveLength(3);
  expect(w.document.getElementById('composerImages')!.textContent).toContain('dropped.md');
  drop(w.document.getElementById('composer')!, 18);
  await settle();
  expect(api.dropFiles).toHaveBeenCalledTimes(3);
  expect(w.document.querySelectorAll('#composerImages .attachment-card')).toHaveLength(3);
});

it('leaves file drops on the Folders card to its explicit folder-import owner', async () => {
  const { w } = await boot([], false);
  const api = (w as any).api;
  api.dropFiles = vi.fn(async () => ({ ok: true, data: [] }));
  api.addRootPath = vi.fn(async () => ({ ok: true, data: null }));
  const folder = new w.File(['folder'], 'folder-entry', { type: '' });
  const event = new w.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [folder] } });
  w.document.getElementById('foldersCard')!.dispatchEvent(event);
  await settle();
  expect(api.addRootPath).toHaveBeenCalledExactlyOnceWith(folder);
  expect(api.dropFiles).not.toHaveBeenCalled();
});

it('keeps ordinary draft edits and parallel imports in the same draft lifetime', async () => {
  const { w } = await boot([], false);
  const api = (w as any).api;
  const finishes: Array<(value: unknown) => void> = [];
  api.dropFiles = vi.fn(() => new Promise(resolve => finishes.push(resolve)));
  const paste = (name: string) => {
    const event = new w.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: [new w.File(['image'], name, { type: 'image/png' })] } });
    w.document.getElementById('chatInput')!.dispatchEvent(event);
  };
  paste('first.png');
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'An ordinary edit while importing'; input.dispatchEvent(new w.Event('input', { bubbles: true }));
  paste('second.png');
  await vi.waitFor(() => expect(api.dropFiles).toHaveBeenCalledTimes(2));
  finishes[1]!({ ok: true, data: [{ id: '11111111-2222-4333-8444-555555555555', name: 'second.png', size: 4, mimeType: 'image/png' }] });
  finishes[0]!({ ok: true, data: [{ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'first.png', size: 4, mimeType: 'image/png' }] });
  await settle();
  expect(w.document.querySelectorAll('#composerImages .attachment-card')).toHaveLength(2);
  expect(w.document.getElementById('composerImages')!.textContent).toContain('first.png');
  expect(w.document.getElementById('composerImages')!.textContent).toContain('second.png');
  expect(input.value).toBe('An ordinary edit while importing');
  expect(w.document.querySelector('.toast')?.textContent ?? '').not.toContain('draft changed');
  (w.document.querySelector(`[data-id="${summary([]).id}"]`) as HTMLButtonElement).click();
  await settle();
  expect(w.document.querySelectorAll('#composerImages .attachment-card')).toHaveLength(0);
  w.document.getElementById('newChat')!.click(); await settle();
  expect(input.value).toBe('An ordinary edit while importing');
  expect(w.document.querySelectorAll('#composerImages .attachment-card')).toHaveLength(2);
});

it.each(['new-same-key', 'a-b-a', 'opening-adopt-new', 'same-session-send-next', 'same-session-failed-send', 'plan-replaces', 'retry-replaces'])('rejects a late attachment import after the draft owner changed (%s)', async mode => {
  const a = { ...summary([]), id: 'draft-a', conversationId: 'chat-a' };
  const b = { ...summary([]), id: 'draft-b', conversationId: 'chat-b' };
  const options = mode === 'a-b-a' ? { sessions: [a, b] }
    : mode.startsWith('same-session') || mode.endsWith('replaces') ? { sessions: [a] }
    : mode === 'opening-adopt-new' ? { reserveOpenings: true } : {};
  const app = await boot([], false, [], [], options);
  const { w } = app;
  if (mode === 'a-b-a' || mode.startsWith('same-session') || mode.endsWith('replaces'))
    (w.document.querySelector('[data-id="draft-a"]') as HTMLButtonElement).click();
  if (mode === 'retry-replaces') {
    app.live.inputs.push({ id: 'failed-retry', sessionId: a.id, text: 'Restored failed message',
      mode: 'auto', dueAt: 0, model: null, reasoningEffort: null, state: 'failed', owner: null,
      createdAt: T0, conversationId: a.conversationId, error: 'Delivery failed' });
    await app.append([]);
  }
  let finish!: () => void;
  const attachment = { id: 'cccccccc-dddd-4eee-8fff-000000000000', name: 'late.png', size: 4, mimeType: 'image/png', preview: 'data:image/webp;base64,AAAA' };
  (w as any).api.dropFiles = vi.fn(() => new Promise(resolve => { finish = () => resolve({ ok: true, data: [attachment] }); }));
  const paste = new w.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [new w.File(['image'], 'late.png', { type: 'image/png' })] } });
  w.document.getElementById('chatInput')!.dispatchEvent(paste);
  await vi.waitFor(() => expect((w as any).api.dropFiles).toHaveBeenCalledTimes(1));

  if (mode === 'new-same-key') {
    w.document.getElementById('newChat')!.click();
  } else if (mode === 'a-b-a') {
    (w.document.querySelector('[data-id="draft-b"]') as HTMLButtonElement).click();
    (w.document.querySelector('[data-id="draft-a"]') as HTMLButtonElement).click();
  } else if (mode === 'opening-adopt-new') {
    const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
    input.value = 'Adopt this opening';
    w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(w.document.querySelector('.sess.is-sel')).not.toBeNull());
    w.document.getElementById('newChat')!.click();
  } else if (mode.startsWith('same-session')) {
    const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
    if (mode === 'same-session-failed-send')
      (w as any).api.sendInput = vi.fn(async () => ({ ok: false, error: 'test rejected send' }));
    input.value = 'Submitted draft';
    w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    if (mode === 'same-session-send-next') await vi.waitFor(() => expect(app.live.sent).toHaveLength(1));
    else await vi.waitFor(() => expect((w as any).api.sendInput).toHaveBeenCalledTimes(1));
    await settle();
    input.value = 'Next draft'; input.dispatchEvent(new w.Event('input', { bubbles: true }));
  } else if (mode === 'plan-replaces') {
    (w as any).api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['Stage one', 'Stage two'] }));
    const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
    input.value = 'Turn this into a plan';
    w.document.getElementById('createPlan')!.click();
    await vi.waitFor(() => expect(input.value).toBe(''));
  } else {
    (w.document.querySelector('.delivery-retry') as HTMLButtonElement).click();
    expect((w.document.getElementById('chatInput') as HTMLTextAreaElement).value).toBe('Restored failed message');
  }
  finish(); await settle();
  expect(w.document.querySelector('#composerImages .attachment-card')).toBeNull();
  expect(w.document.querySelector('.toast')?.textContent).toContain('draft changed');
});

it.each([false, true])('removes a project group in one click, keeps its chats and draft, and rejects an older refresh (selectedSkill=%s)', async selectedSkill => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Removed', path: '/removed', createdAt: 1 };
  const other = { id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', name: 'Other', path: '/other', createdAt: 2 };
  const parent = { ...summary([]), projectId: project.id };
  const child = { ...summary([]), id: 'child-session', conversationId: 'child-chat', projectId: project.id,
    origin: { kind: 'worker' as const, fromSessionId: parent.id, agentId: 'worker-1', task: 'Keep working' } };
  const { w, live } = await boot([], false, [], [project, other], { sessions: [parent, child] });
  const api = (w as any).api;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  (w.document.querySelector('.worker-toggle') as HTMLButtonElement).click();
  (w.document.querySelector(`[data-new-project="${project.id}"]`) as HTMLButtonElement).click();
  input.value = 'Keep my draft';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  if (selectedSkill) {
    api.skillLibrary = () => Promise.resolve({ ok: true, data: { skills: [
      { id: 'review', name: 'Review', description: '', path: '/skills/review/SKILL.md', scope: 'managed', source: 'managed', managed: true, allowImplicitInvocation: true }
    ], roots: [], errors: [], includeInstructions: true } });
    input.value = '/re\n' + input.value; input.setSelectionRange(3, 3); input.dispatchEvent(new w.Event('input', { bubbles: true })); await settle();
    w.document.querySelector<HTMLButtonElement>('.skill-choice[data-skill-id="review"]')!.click();
  }
  let finishList!: (value: unknown) => void;
  api.listSessions = () => new Promise(resolve => { finishList = resolve; });
  (w.document.getElementById('chatRefresh') as HTMLButtonElement).click();
  await settle();
  api.removeProject = vi.fn(async () => ({ ok: true, data: { ...project, ungrouped: true } }));
  (w.document.querySelector('.project-remove') as HTMLButtonElement).click();
  await settle();
  expect(api.removeProject).toHaveBeenCalledExactlyOnceWith(project.id);
  expect(w.document.querySelector(`[data-project-id="${project.id}"]`)).toBeNull();
  expect(w.document.querySelector(`[data-project-id="${other.id}"]`)).not.toBeNull();
  expect(w.document.querySelector(`#chatList > [data-id="${parent.id}"]`)).not.toBeNull();
  expect(w.document.querySelector('#chatList > .worker-group [data-id="child-session"]')).not.toBeNull();
  expect(w.document.querySelector(`#projectList [data-id="${parent.id}"]`)).toBeNull();
  expect(input.value).toBe('Keep my draft');
  expect(input.placeholder).toBe('Ask anything…');
  finishList({ ok: true, data: { sessions: [parent, child], activeId: null, pressure: [], blocked: [] } });
  await settle();
  expect(w.document.querySelector(`[data-project-id="${project.id}"]`)).toBeNull();
  (w.document.getElementById('chatSend') as HTMLButtonElement).click();
  await settle();
  expect(live.sent[0]).toMatchObject({ sessionId: null, projectId: null, text: selectedSkill ? '/review\nKeep my draft' : 'Keep my draft' });
});

it('keeps the project visible when its removal fails', async () => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Keep', path: '/keep', createdAt: 1 };
  const { w } = await boot([], false, [], [project]);
  (w as any).api.removeProject = async () => ({ ok: false, error: 'Could not save' });
  (w.document.querySelector('.project-remove') as HTMLButtonElement).click();
  await settle();
  expect(w.document.querySelector('.project-group')).not.toBeNull();
  expect((w.document.querySelector('.project-remove') as HTMLButtonElement).disabled).toBe(false);
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
  expect(w.document.querySelector<HTMLDetailsElement>(`[data-project-id="${project.id}"]`)?.open).toBe(true);
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
  const discover = vi.fn(async () => ({ ok: true, data: { state: 'unavailable', requestedAt: 1, observedAt: null, models: [] } }));
  (w as any).api.requestChatModels = discover;
  (w.document.getElementById('refreshComposerModels') as HTMLButtonElement).click();
  await settle();
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Keep this until a real model is selected';
  (w.document.getElementById('chatSend') as HTMLButtonElement).click();
  await settle();
  expect(input.value).toBe('Keep this until a real model is selected');
  expect(live.sent).toHaveLength(0);
  expect(discover).toHaveBeenCalledTimes(2); // Manual Reload, then automatic discovery on Send.
  expect(w.document.body.textContent).toContain('Model discovery could not confirm your selection');
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

it('groups project chats and restores each project composer with its selected identity', async () => {
  const projects = [{ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Alpha', path: '/alpha', createdAt: 1 }, { id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', name: 'Beta', path: '/beta', createdAt: 2 }];
  const { w, live, append } = await boot([], false, [], projects);
  const groups = w.document.querySelectorAll<HTMLDetailsElement>('.project-group');
  expect(groups).toHaveLength(2);
  expect([...groups].map(group => group.open)).toEqual([false, false]);
  expect(groups[0]!.querySelector('[data-id]')?.getAttribute('data-id')).toBe(summary([]).id);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const choose = (id: string) => (w.document.querySelector(`[data-new-project="${id}"]`) as HTMLButtonElement).click();
  choose(projects[0]!.id); expect(w.document.querySelector<HTMLDetailsElement>(`[data-project-id="${projects[0]!.id}"]`)!.open).toBe(true); input.value = 'Alpha draft';
  choose(projects[1]!.id); expect(w.document.querySelector<HTMLDetailsElement>(`[data-project-id="${projects[1]!.id}"]`)!.open).toBe(true); expect(input.value).toBe(''); input.value = 'Beta draft';
  (w.document.getElementById('newChat') as HTMLButtonElement).click();
  expect(input.value).toBe(''); input.value = 'Unfiled draft';
  choose(projects[0]!.id); expect(input.value).toBe('Alpha draft'); input.value = 'Alpha request';
  (w.document.getElementById('chatSend') as HTMLButtonElement).click();
  await settle();
  expect(live.sent[0]).toMatchObject({ sessionId: null, projectId: projects[0]!.id, text: 'Alpha request' });
  choose(projects[1]!.id); expect(input.value).toBe('Beta draft');
  const beta = w.document.querySelector<HTMLDetailsElement>(`[data-project-id="${projects[1]!.id}"]`)!;
  beta.querySelector('summary')!.click(); await append([]);
  expect(w.document.querySelector<HTMLDetailsElement>(`[data-project-id="${projects[1]!.id}"]`)!.open).toBe(false);
});

it('reorders whole project groups without changing chat selection, ownership or disclosure across refresh', async () => {
  const projects: LocalProject[] = [
    { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Alpha', path: '/alpha', createdAt: 1 },
    { id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', name: 'Beta', path: '/beta', createdAt: 2 }
  ];
  const chats = projects.map((project, index) => ({ ...summary([]), id: `chat-${index}`, conversationId: `conversation-${index}`, projectId: project.id }));
  const { w, append, live } = await boot([], false, [], projects, { sessions: chats });
  const list = w.document.getElementById('sessionList')!;
  list.setPointerCapture = vi.fn(); list.hasPointerCapture = () => false;
  const groups = () => [...w.document.querySelectorAll<HTMLDetailsElement>('.project-group')];
  const ids = () => groups().map(group => group.dataset.projectId);
  const geometry = () => groups().forEach((group, index) => {
    group.getClientRects = () => [{ top: index * 100, height: 80 }] as unknown as DOMRectList;
    group.getBoundingClientRect = () => ({ top: index * 100, height: 80 }) as DOMRect;
  });
  const pointer = (target: Element | Window, type: string, y: number) => target.dispatchEvent(new w.MouseEvent(type, {
    bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: y
  }));
  groups()[0]!.querySelector('summary')!.click();
  expect(groups()[0]!.open).toBe(true);
  expect(groups().every(group => !group.hasAttribute('data-id'))).toBe(true);
  geometry();
  pointer(groups()[1]!.querySelector('summary')!, 'pointerdown', 110);
  pointer(list, 'pointermove', -20); pointer(w as unknown as Window, 'pointerup', -20);
  expect(ids()).toEqual([projects[1]!.id, projects[0]!.id]);
  expect(groups()[1]!.open).toBe(true);
  for (const chat of chats) expect(w.document.querySelector(`[data-project-id="${chat.projectId}"] [data-id="${chat.id}"]`)).not.toBeNull();
  expect(w.document.querySelector('.sess.is-sel')).toBeNull();
  await append([]);
  expect(ids()).toEqual([projects[1]!.id, projects[0]!.id]);
  geometry();
  const beta = groups()[0]!.querySelector<HTMLElement>('summary')!;
  beta.focus(); beta.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
  expect(ids()).toEqual(projects.map(project => project.id));
  expect(w.document.activeElement).toBe(groups()[1]!.querySelector('summary'));
  const saved = w.localStorage.getItem('chat-on-steroids.sidebar-order');
  pointer(groups()[0]!.querySelector('.project-new')!, 'pointerdown', 10);
  pointer(list, 'pointermove', 500); pointer(w as unknown as Window, 'pointerup', 500);
  expect(w.localStorage.getItem('chat-on-steroids.sidebar-order')).toBe(saved);
  expect(live.sent).toEqual([]);
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

it('folds a Compact & Resume whose marker ChatGPT escaped as Markdown', async () => {
  // Same fold, same assertions, but the two prompts are recorded the way the composer has
  // written them since 2026-09-16. Every reader of the shared marker regex reads text that
  // came back out of the page, so they all stopped matching at once: this card was not built
  // at all, and the raw marker was left on screen in the rows it should have replaced.
  const { w } = await boot([
    { seq: 1, time: T0, source: 'app', kind: 'session_start', conversationId: 'chat-a', title: 'Loop under test' },
    toolCall(2, 'call-1'),
    ...compaction(3, true),
    toolCall(9, 'call-2')
  ]);
  const timeline = w.document.getElementById('timeline')!;

  const cards = timeline.querySelectorAll('details.compaction');
  expect(cards).toHaveLength(1);
  expect(cards[0]!.querySelector('summary')!.textContent).toMatch(/^Compact & Resume:New chat opened at .* \(44 characters\)$/);
  // Stripped in the form it was recorded in, so no half-removed marker survives either.
  expect(timeline.textContent).not.toContain('[[CLF-');
  expect(timeline.textContent).not.toContain('CLF-RESUME');
  expect([...timeline.children].map((row) => row.className)).toEqual(['ev ev-tool_call', 'ev ev-compaction', 'ev ev-tool_call']);

  cards[0]!.toggleAttribute('open', true);
  expect(cards[0]!.textContent).toContain('Brief request');
  expect(cards[0]!.textContent).toContain('keep the loop running');
});

it('retires a pending Skills picker when sending replaces its draft', async () => {
  const { w, live } = await boot([], false);
  let resolve!: (value: unknown) => void;
  (w as any).api.skillLibrary = () => new Promise(done => { resolve = done; });
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = '/'; input.setSelectionRange(1, 1); input.dispatchEvent(new w.Event('input', { bubbles: true }));
  expect((w.document.getElementById('skillPicker') as HTMLElement).hidden).toBe(false);
  input.value = 'Complete my task'; input.dispatchEvent(new w.Event('input', { bubbles: true }));
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(live.sent[0]?.text).toBe('Complete my task');
  expect((w.document.getElementById('skillPicker') as HTMLElement).hidden).toBe(true);
  input.value = 'Next task';
  resolve({ ok: true, data: { skills: [{ id: 'old', name: 'Old', description: '', path: '/skills/old/SKILL.md', scope: 'managed', managed: true, source: 'managed', allowImplicitInvocation: true }], roots: [], errors: [], includeInstructions: true } });
  await settle();
  expect(input.value).toBe('Next task');
  expect((w.document.getElementById('skillPicker') as HTMLElement).hidden).toBe(true);
});

it('uses slash Skills completion and delivers the selected directive once with the unchanged task', async () => {
  const { w, live } = await boot([], false);
  (w as any).api.skillLibrary = vi.fn(async () => ({ ok: true, data: { skills: [
    { id: 'review', name: 'Review code', description: 'Inspect before editing', path: '/skills/review/SKILL.md', managed: true, source: 'managed', scope: 'managed', allowImplicitInvocation: true }
  ], roots: [], errors: [], includeInstructions: true } }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Do my entire task.\nKeep the second line.';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  input.value = '/re\n' + input.value; input.setSelectionRange(3, 3); input.dispatchEvent(new w.Event('input', { bubbles: true })); await settle();
  w.document.querySelector<HTMLButtonElement>('.skill-choice[data-skill-id="review"]')!.click();
  expect(input.value).toBe('Do my entire task.\nKeep the second line.');
  expect(w.document.querySelectorAll('.composer-selected-skill')).toHaveLength(1);
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]!.text).toBe('/review\nDo my entire task.\nKeep the second line.');
  expect(w.document.querySelectorAll('.composer-selected-skill')).toHaveLength(0);
});

it('keeps Projects and Chats separate while preserving disclosure state through activity refresh', async () => {
  const project: LocalProject = { id: '33333333-3333-4333-8333-333333333333', name: 'Workspace', path: '/workspace', createdAt: T0 };
  const linked = { ...summary([]), id: 'linked-chat', projectId: project.id };
  const standalone = { ...summary([]), id: 'standalone-chat', projectId: undefined };
  const app = await boot([], false, [], [project], { sessions: [linked, standalone] });
  expect(app.w.document.querySelector('#projectList [data-id="linked-chat"]')).not.toBeNull();
  expect(app.w.document.querySelector('#chatList [data-id="standalone-chat"]')).not.toBeNull();
  expect(app.w.document.querySelector('#chatList [data-id="linked-chat"]')).toBeNull();
  const projects = app.w.document.getElementById('projectsSection') as HTMLDetailsElement;
  projects.open = false; await app.append([]);
  expect(app.w.document.getElementById('projectsSection')).toBe(projects);
  expect(projects.open).toBe(false);
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
  expect(live.sent[0]).toMatchObject({ sessionId: null, text: 'A new request', automation: 'loop', authoredSource: 'text' });
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
  const app = await boot([], false, [], [], { reserveOpenings: true });
  const { w, live } = app;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Old attempt';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  const owner = live.inputs[0]!.sessionId!;
  expect(w.document.querySelector('#sessionList .is-sel')?.getAttribute('data-id')).toBe(owner);
  expect(w.document.getElementById('inputQueue')!.textContent).toContain('Old attempt');
  live.inputs[0] = { ...live.inputs[0]!, state: 'browser' };
  input.value = 'Discard this draft';
  w.document.getElementById('newChat')!.click();
  await app.append([]);
  expect(input.value).toBe('');
  expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('Old attempt');
  expect(live.inputs[0]!.state).toBe('browser'); // Preserve ambiguous receipts; never retry them.
  (w.document.querySelector(`#sessionList [data-id="${owner}"]`) as HTMLButtonElement).click();
  await settle();
  expect(w.document.getElementById('inputQueue')!.textContent).toContain('Old attempt');
  input.value = ''; input.dispatchEvent(new w.Event('input'));
  const cancel = vi.fn(async (id: string) => { live.inputs = live.inputs.map(row => row.id === id ? { ...row, state: 'cancelled' as const, error: 'Not sent: this delivery was cancelled before Send was authorized.' } : row); return { ok: true, data: true }; });
  (w as any).api.cancelInput = cancel;
  expect(w.document.getElementById('chatSend')!.getAttribute('aria-label')).toBe('Cancel delivery');
  if (control === 'composer') w.document.getElementById('chatSend')!.click();
  else (w.document.querySelector('#inputQueue [title="Cancel delivery"]') as HTMLButtonElement).click();
  await settle();
  expect(cancel).toHaveBeenCalledWith(live.inputs[0]!.id);
  expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('Old attempt');
  w.document.getElementById('newChat')!.click();
  input.value = 'Fresh attempt';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(w.document.getElementById('inputQueue')!.textContent).toContain('Fresh attempt');
  expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('Old attempt');
});

it.each([false, true])('dismisses retired delivery errors in selected-chat=%s without resending', async selected => {
  const app = await boot([], selected, [], [], { reserveOpenings: true });
  const { w, live } = app;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const submit = () => w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  input.value = 'Expired request'; submit(); await settle();
  const owner = live.inputs[0]!.sessionId!;
  live.inputs[0] = { ...live.inputs[0]!, state: 'cancelled', error: 'Delivery confirmation timed out. The message may already have reached ChatGPT.' };
  if (!selected) {
    w.document.getElementById('newChat')!.click();
    await app.append([]);
    expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('Expired request');
    (w.document.querySelector(`#sessionList [data-id="${owner}"]`) as HTMLButtonElement).click();
  }
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
  w.document.getElementById('newChat')!.click();
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
  w.document.getElementById('newChat')!.click();
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

it.each(['stopped', 'failed'] as const)('shows the exact summary turn %s instead of writing, then updates the same card on recovery', async outcome => {
  const [request, start, brief, end, handoff, resume] = compaction(2);
  const app = await boot([request!, start!, { ...brief!, final: false, state: 'streaming' } as SessionEvent]);
  const card = app.w.document.querySelector<HTMLDetailsElement>('details.compaction')!;
  const state = () => card.querySelector('summary .state')!.textContent;
  expect(state()).toBe('ChatGPT is writing the summary…');
  await app.append([{ ...end!, outcome, detail: outcome === 'failed' ? 'Provider request limit' : undefined } as SessionEvent]);
  expect(state()).toBe(outcome === 'stopped' ? 'Summary generation stopped' : 'Summary generation failed — Provider request limit');
  expect(card.className).toContain('tone-bad');
  await app.append([{ ...handoff!, seq: 9, time: T0 + 9000 }]);
  expect(state()).toContain('Summary saved');
  expect(card.className).toContain('tone-wait');
  await app.append([{ ...resume!, seq: 10, time: T0 + 10000 }]);
  expect(app.w.document.querySelector('details.compaction')).toBe(card);
  expect(state()).toContain('New chat opened');
  expect(card.className).toContain('tone-good');
});

it('keeps a stopped empty summary truthful without adopting another turn or its completed outcome', async () => {
  const [request, start, , end] = compaction(2);
  const app = await boot([request!, start!, { ...end!, outcome: 'stopped' } as SessionEvent]);
  await app.append([
    { seq: 10, time: T0 + 10000, source: 'extension', kind: 'turn_start', turnId: 'other' },
    { seq: 11, time: T0 + 11000, source: 'extension', kind: 'turn_end', turnId: 'other', outcome: 'completed' }
  ]);
  expect(app.w.document.querySelector('details.compaction summary .state')!.textContent).toBe('Summary generation stopped');
});

it('a committed resume supersedes an older abandonment on the same compaction', async () => {
  const [request, start, , end, , resume] = compaction(2);
  const app = await boot([request!, start!, { ...end!, outcome: 'failed' } as SessionEvent,
    { seq: 8, time: T0 + 8000, source: 'app', kind: 'note', continuation: TOKEN, message: text('Compact & Resume abandoned — earlier failure') }]);
  await app.append([{ ...resume!, seq: 9, time: T0 + 9000 }]);
  expect(app.w.document.querySelector('details.compaction summary .state')!.textContent).toContain('New chat opened');
});

it('does not infer compaction failure from a later tool call while the handoff is being saved', async () => {
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

  // A late call does not settle the continuation transaction.
  await append([toolCall(9, 'call-late')]);
  expect(state()).toBe('Summary written — saving the handoff…');
  expect(timeline.querySelector('details.compaction')!.className).toContain('tone-wait');
});

it('keeps one live compaction across refused source calls and unrelated old-turn commentary', async () => {
  const [request, start, brief, end, handoff, resume] = compaction(2);
  const app = await boot([request!, start!]);
  const card = app.w.document.querySelector<HTMLDetailsElement>('details.compaction')!;
  const state = () => card.querySelector('summary .state')!.textContent;
  const late = toolCall(4, 'late-source-call') as Extract<SessionEvent, { kind: 'tool_call' }>;
  late.call.outcome = 'tool_rejected';
  late.call.result = text('COMPACTION_IN_PROGRESS: no local tool was run.');
  await app.append([late, { seq: 5, time: T0 + 5000, source: 'extension', kind: 'assistant_message',
    messageId: 'old-commentary', turnId: 'old-turn', final: false, message: text('Still reading the old task.') }]);
  expect(state()).toBe('Summary requested — waiting for ChatGPT…');
  expect(card.className).toContain('tone-wait');
  expect(card.textContent).not.toContain('Still reading the old task.');
  expect(app.w.document.querySelector('.ev-assistant_message')!.textContent).toContain('Still reading the old task.');
  await app.append([{ ...brief!, seq: 6, time: T0 + 6000 }, { ...end!, seq: 7, time: T0 + 7000 }]);
  expect(state()).toBe('Summary written — saving the handoff…');
  expect(card.textContent).toContain('Goal: keep the loop running.');
  await app.append([{ ...handoff!, seq: 8, time: T0 + 8000 }, toolCall(9, 'late-recording')]);
  expect(state()).toContain('opening the new chat');
  await app.append([{ ...resume!, seq: 10, time: T0 + 10000 }]);
  expect(app.w.document.querySelector('details.compaction')).toBe(card);
  expect(app.w.document.querySelectorAll('details.compaction')).toHaveLength(1);
  expect(card.className).toContain('tone-good');
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

it('retains the open compaction disclosure and brief request while the summary streams and completes', async () => {
  const [request, start, original, , handoff, resume] = compaction(2);
  const brief = { ...original, origin: original!.seq, state: 'streaming', final: false } as Extract<SessionEvent, { kind: 'assistant_message' }>;
  const { w, append } = await boot([request!, start!, brief]);
  const card = w.document.querySelector<HTMLDetailsElement>('details.compaction')!;
  card.open = true;
  card.dispatchEvent(new w.Event('toggle'));
  const requestText = card.querySelector('.pre')!;
  const head = card.querySelector('summary')!;
  head.focus();
  for (let i = 0; i < 3; i++) {
    await append([{ ...brief, seq: 20 + i, message: text('# Brief\n\n' + 'More summary text. '.repeat(i + 2)), final: i === 2, state: i === 2 ? 'final' : 'streaming' }]);
    expect(w.document.querySelector('details.compaction')).toBe(card);
    expect(card.open).toBe(true);
    expect(card.querySelector('.pre')).toBe(requestText);
    expect(w.document.activeElement).toBe(head);
    expect(card.querySelector('.rich')!.textContent).toContain('More summary text.');
  }
  expect(card.querySelector('summary .state')!.textContent).toBe('Summary written — saving the handoff…');
  await append([{ ...handoff!, seq: 23 }, { ...resume!, seq: 24 }]);
  expect(w.document.querySelector('details.compaction')).toBe(card);
  expect(card.className).toContain('tone-good');
  card.open = false;
  card.dispatchEvent(new w.Event('toggle'));
  await append([toolCall(25, 'after-resume')]);
  expect(card.open).toBe(false);
});

it('keeps a streaming message anchor and its following tool group across canonical revisions', async () => {
  const message: Extract<SessionEvent, { kind: 'assistant_message' }> = { seq: 1, origin: 1, time: T0, source: 'extension',
    kind: 'assistant_message', messageId: 'live-message', message: text('Working'), state: 'streaming', final: false };
  const { w, append } = await boot([message, toolCall(2, 'live-tool'), toolCall(3, 'next-tool')]);
  const timeline = w.document.getElementById('timeline')!;
  const anchor = timeline.querySelector<HTMLElement>('.ev-assistant_message')!.dataset.timelineKey;
  const group = timeline.querySelector<HTMLDetailsElement>('.tool-group')!;
  group.open = true;
  group.dispatchEvent(new w.Event('toggle'));
  await append([{ ...message, seq: 4, message: text('Working on the next step') }]);
  expect(timeline.querySelector<HTMLElement>('.ev-assistant_message')!.dataset.timelineKey).toBe(anchor);
  expect(timeline.querySelector('.tool-group')).toBe(group);
  expect(group.open).toBe(true);
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

it('shows Send directly before MCP, keeps After this turn selected, and changes the visible menu after MCP', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api;
  const original = api.getSessionControls;
  let tools = false;
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data,
    activeTurnId: 'plain-turn', canInject: tools, canSendDirectly: !tools, queueAtFinish: false } });
  await append([]);
  const options = w.document.getElementById('sendOptions')!;
  expect(options.hidden).toBe(false);
  expect(options.querySelector('[data-delivery="auto"]')!.textContent).toBe('Send directly');
  expect((options.querySelector('[data-delivery="tool"]') as HTMLElement).hidden).toBe(false);
  (options.querySelector('[data-delivery="after-turn"]') as HTMLButtonElement).click();
  await append([]);
  expect((w.document.getElementById('sendMode') as HTMLSelectElement).value).toBe('after-turn');
  tools = true;
  await append([toolCall(1, 'first-mcp-call')]);
  expect(options.querySelector('[data-delivery="auto"]')!.textContent).toBe('Inject now');
  expect((w.document.getElementById('sendMode') as HTMLSelectElement).value).toBe('after-turn');
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
  send.click();
  await settle();
  expect(cancel).toHaveBeenCalledWith(live.sent[0]!.id);
  expect(send.dataset.action).toBe('send');
});

it('opens the saved task editor from the Goal dock and still closes it on outside clicks', async () => {
  const { w } = await boot([]);
  (w.document.querySelector('#automationSwitch [data-mode="goal"]') as HTMLButtonElement).click();
  await settle();
  const menu = w.document.getElementById('composerSettings') as HTMLDetailsElement;
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  const edit = w.document.querySelector('#activeGoalRow button[aria-label="Edit task"]') as HTMLButtonElement;
  expect(edit).not.toBeNull();
  menu.open = false;
  edit.click();
  expect(menu.open).toBe(true);
  expect(w.document.activeElement).toBe(objective);
  w.document.body.click();
  expect(menu.open).toBe(false);
  await settle();
});

it.each(['off', 'goal', 'loop'])('retains the first-message draft and task across chat navigation (%s)', async mode => {
  const { w, live } = await boot([], false, [], [], { reserveOpenings: true });
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  const automation = w.document.getElementById('chatAutomation') as HTMLSelectElement;
  const delivery = w.document.getElementById('loopDelivery') as HTMLSelectElement;
  (w.document.querySelector(`#automationSwitch [data-mode="${mode}"]`) as HTMLButtonElement).click();
  input.value = 'First message\nwith pasted context'; input.dispatchEvent(new w.Event('input'));
  objective.value = 'Keep the original task'; objective.dispatchEvent(new w.Event('input'));
  delivery.value = 'after-turn'; delivery.dispatchEvent(new w.Event('change'));
  const visitExisting = () => (w.document.querySelector(`[data-id="${summary([]).id}"]`) as HTMLButtonElement).click();
  const returnToDraft = () => w.document.getElementById('newChat')!.click();
  visitExisting(); await settle();
  expect(input.value).toBe('');
  input.value = 'Separate existing-chat draft';
  returnToDraft(); await settle();
  returnToDraft(); await settle();
  expect(input.value).toBe('First message\nwith pasted context');
  expect(objective.value).toBe('Keep the original task');
  expect(automation.value).toBe(mode);
  expect(delivery.value).toBe('after-turn');
  visitExisting(); await settle();
  expect(input.value).toBe('Separate existing-chat draft');
  returnToDraft(); await settle();
  input.value = ''; objective.value = '';
  visitExisting(); returnToDraft(); await settle();
  expect(input.value).toBe(''); expect(objective.value).toBe('');
  input.value = 'Actually send this';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(live.sent.at(-1)).toMatchObject({ text: 'Actually send this', automation: mode });
  returnToDraft(); await settle();
  expect(input.value).toBe(''); expect(objective.value).toBe(''); expect(automation.value).toBe('off');
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

it('keeps editable stages and sends the original request with the full workflow exactly once', async () => {
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
  expect(w.document.getElementById('chatSend')!.getAttribute('aria-label')).toBe('Start full plan');
  (w.document.querySelector(`[data-id="${summary([]).id}"]`) as HTMLButtonElement).click();
  await settle();
  w.document.getElementById('newChat')!.click(); await settle();
  expect(w.document.getElementById('taskPlanPreview')!.textContent).toContain('Build the edited foundation');
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ text: 'Build the edited foundation', stages: ['Verify it'], objective: 'Build the whole task', authoredSource: 'objective' });
  expect(w.document.getElementById('taskPlanPreview')!.hidden).toBe(true);
  expect(w.document.getElementById('finishQueue')!.hidden).toBe(false);
  expect(w.document.getElementById('finishQueue')!.textContent).toContain('Verify it');
  expect(w.document.querySelector('[aria-label="Plan stage · waiting for the first message to be sent"]')).not.toBeNull();
});

it.each([true, false])('hands plan presentation to queued stages while sending and restores a rejected draft (accepted=%s)', async accepted => {
  const { w, live, append } = await boot([], false);
  const api = (w as any).api;
  const stages = ['Define the build', 'Assign first worker', 'Assign second worker', 'Integrate', 'Verify', 'Acceptance'];
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: stages }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Build the whole task'; input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click();
  await settle();
  const preview = w.document.getElementById('taskPlanPreview')!;
  expect(preview.hidden).toBe(false);
  expect(preview.querySelectorAll('.plan-stage')).toHaveLength(6);
  let finish!: (result: unknown) => void;
  let first!: InputEntry;
  api.sendInput = vi.fn((args: InputArgs) => {
    live.sent.push(args);
    first = { ...args, state: 'queued', owner: null, createdAt: Date.now(), conversationId: 'chat-b' };
    // An outbox observation can arrive before the original send IPC response. Its
    // checkpoint projection must not coexist with the editable six-stage draft.
    live.inputs = [first];
    return new Promise(resolve => { finish = resolve; });
  });
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await append([]);
  expect(preview.hidden).toBe(true);
  expect(preview.querySelectorAll('.plan-stage')).toHaveLength(0);
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(5);
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ text: stages[0], stages: stages.slice(1) });
  if (!accepted) live.inputs = [];
  finish(accepted ? { ok: true, data: first } : { ok: false, error: 'Fixture send rejected' });
  await settle();
  expect(preview.hidden).toBe(accepted);
  expect(preview.querySelectorAll('.plan-stage')).toHaveLength(accepted ? 0 : 6);
  if (!accepted) expect(input.value).toBe('');
});

it.each(['delivery', 'model', 'refresh-failed', 'enqueue-failed'])('retries the durable full plan without pasting stage one (%s)', async failure => {
  const { w, live, append } = await boot([], true);
  const api = (w as any).api;
  const original: InputEntry = { id: 'failed-plan', sessionId: summary([]).id, requestedSessionId: null, opening: true, projectId: null, text: 'Implement everything',
    objective: 'Original complete request', stages: ['Verify gameplay', 'Verify voice', 'Final review'], automation: 'off',
    model: 'gpt-5.6-sol', reasoningEffort: 'high', mode: 'auto', dueAt: 1, createdAt: 1, state: 'failed',
    owner: 'old-page', conversationId: null, error: failure === 'model' || failure === 'refresh-failed'
      ? 'Requested model or reasoning could not be confirmed' : 'Delivery failed' };
  live.inputs = [original]; await append([]);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'An independent draft'; input.dispatchEvent(new w.Event('input'));
  api.requestChatModels = vi.fn(async () => ({ ok: true, data: failure === 'refresh-failed'
    ? { state: 'unavailable', models: [], error: 'Unavailable' }
    : { state: 'ready', models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['high'] }] } }));
  if (failure === 'enqueue-failed') api.sendInput = vi.fn(async () => ({ ok: false, error: 'Connection failed' }));
  const retry = w.document.querySelector<HTMLButtonElement>('[aria-label="Retry delivery"]')!;
  retry.click(); retry.click(); await settle(); await append([]);
  expect(input.value).toBe('An independent draft');
  if (failure === 'refresh-failed' || failure === 'enqueue-failed') {
    expect(live.sent).toHaveLength(0);
    expect(w.document.querySelector('[aria-label="Retry delivery"]')).not.toBeNull();
    expect(live.inputs[0]!.stages).toEqual(original.stages);
    expect(w.localStorage.getItem('dismissed-input-notices') ?? '').not.toContain(original.id);
  } else {
    expect(live.sent).toHaveLength(1);
    expect(live.sent[0]).toMatchObject({ text: original.text, objective: original.objective, stages: original.stages,
      automation: 'off', model: original.model, reasoningEffort: 'high', mode: 'auto' });
    expect(live.sent[0]!.id).not.toBe(original.id);
    expect(live.sent[0]).not.toHaveProperty('owner');
    expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(3);
  }
  expect(api.requestChatModels).toHaveBeenCalledTimes(failure === 'model' || failure === 'refresh-failed' ? 1 : 0);
});

it('disables empty task actions and confirms saving without the old helper sentence', async () => {
  const { w } = await boot([], false);
  const save = w.document.getElementById('saveSessionObjective') as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  const plan = w.document.getElementById('createPlan') as HTMLButtonElement;
  plan.click();
  expect(w.document.activeElement?.id).toBe('chatInput');
  expect((w.document.getElementById('chatInput') as HTMLTextAreaElement).placeholder).toContain('plan');
  expect(w.document.getElementById('chatSend')!.title).toBe('Click to generate plan');
  expect(w.document.getElementById('chatSend')!.getAttribute('aria-label')).toBe('Generate plan');
  expect(plan.getAttribute('aria-pressed')).toBe('true');
  plan.click();
  expect(plan.getAttribute('aria-pressed')).toBe('false');
  expect((w.document.getElementById('chatInput') as HTMLTextAreaElement).placeholder).toBe('Ask anything…');
  expect(w.document.getElementById('chatSend')!.title).toBe('');
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

it('renders one legacy interrupted-response card across reloads and updates it after completion', async () => {
  const error: SessionEvent = { seq: 2, time: T0 + 2, source: 'extension', kind: 'chat_error', turnId: 'original', recoverable: true, message: text('Connection interrupted') };
  const { w, append } = await boot([
    { seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'question', message: text('Build') },
    error, { ...error, seq: 3, turnId: undefined }, { ...error, seq: 4, turnId: 'replacement' },
    { seq: 5, time: T0 + 5, source: 'app', kind: 'progress', turnId: 'replacement', progressId: 'browser-repair:test', message: text('Reloaded chat') }
  ]);
  expect(w.document.querySelectorAll('.chat-error-notice')).toHaveLength(1);
  expect(w.document.querySelector('.chat-error-notice')!.textContent).toContain('Reloaded chat');
  expect(w.document.querySelector('.chat-error-notice')!.classList.contains('is-resolved')).toBe(false);
  await append([{ seq: 6, time: T0 + 6, source: 'extension', kind: 'assistant_message', final: true, messageId: 'answer', message: text('Done') }]);
  expect(w.document.querySelectorAll('.chat-error-notice')).toHaveLength(1);
  expect(w.document.querySelector('.chat-error-notice')!.textContent).toContain('later completed');
  expect(w.document.querySelector('.chat-error-notice')!.classList.contains('is-resolved')).toBe(true);
  expect(w.document.querySelector('.chat-error-notice strong')!.textContent).toBe('Recovered after interruption');
  await append([{ seq: 7, time: T0 + 7, source: 'app', kind: 'turn_start', turnId: 'replacement' }]);
  expect(w.document.querySelector('.chat-error-notice')!.classList.contains('is-resolved')).toBe(false);
  expect(w.document.querySelector('.chat-error-notice')!.textContent).toContain('Work continued');
});

it('explicitly queues an image injection before the first MCP call without choosing browser delivery', async () => {
  const app = await boot([]);
  const api = (app.w as any).api;
  api.getSessionControls = async () => ({ ok: true, data: { sessionId: summary([]).id,
    activeTurnId: 'plain-turn', canInject: false, canSendDirectly: true, queueAtFinish: false } });
  await app.append([]);
  const image = { id: '11111111-2222-4333-8444-555555555555', name: 'image.png', mimeType: 'image/png', size: 42 };
  api.chooseFiles = async () => ({ ok: true, data: [image] });
  app.w.document.getElementById('attachImages')!.click(); await settle();
  const action = app.w.document.querySelector('[data-delivery="tool"]') as HTMLButtonElement;
  expect(action.hidden).toBe(false); action.click();
  (app.w.document.getElementById('chatInput') as HTMLTextAreaElement).value = 'Describe this image';
  app.w.document.getElementById('composer')!.dispatchEvent(new app.w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(app.live.sent).toHaveLength(1);
  expect(app.live.sent[0]).toMatchObject({ mode: 'auto', delivery: 'tool', text: 'Describe this image', attachments: [image] });
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

it('keeps completed stages after clearing or replacing the composer until explicitly deleted', async () => {
  const { w, live } = await boot([], false);
  const api = (w as any).api;
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['Build foundation', 'Verify it'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Build the whole task'; input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click(); await settle();
  for (const replacement of ['', 'Unrelated next message', '']) {
    input.value = replacement; input.dispatchEvent(new w.Event('input'));
    expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(2);
    expect(w.document.getElementById('taskPlanPreview')!.textContent).toContain('Verify it');
  }
  expect(live.sent).toHaveLength(0);
  w.document.querySelector<HTMLButtonElement>('[aria-label="Delete stage 1"]')!.click();
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(1);
  w.document.querySelector<HTMLButtonElement>('[aria-label="Delete stage 1"]')!.click();
  expect(w.document.getElementById('taskPlanPreview')!.hidden).toBe(true);
});

it('queues every generated stage in an existing session without Send and preserves them after clearing the composer', async () => {
  const { w, live } = await boot([]);
  const api = (w as any).api;
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['Build foundation', 'Verify it'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Build the whole task'; input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click(); await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ sessionId: summary([]).id, text: 'Build foundation', stages: ['Verify it'], mode: 'finish', model: null, reasoningEffort: null, authoredSource: 'objective' });
  expect(input.value).toBe('');
  input.value = ''; input.dispatchEvent(new w.Event('input'));
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(2);
  expect(w.document.querySelectorAll('[aria-label="Remove queued task"]')).toHaveLength(2);
  expect(w.document.getElementById('taskPlanPreview')!.hidden).toBe(true);
  api.cancelInput = vi.fn(async (id: string) => { live.inputs = live.inputs.filter(row => row.id !== id); return { ok: true, data: true }; });
  w.document.querySelector<HTMLButtonElement>('[aria-label="Remove queued task"]')!.click(); await settle();
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(1);
  expect(w.document.getElementById('finishQueue')!.textContent).toContain('Verify it');
  expect(live.sent).toHaveLength(1);
});

it('retries a materialized finish checkpoint without recreating its already independent siblings', async () => {
  const { w, live, append } = await boot([]);
  live.inputs = [{ id: 'failed-first-checkpoint', sessionId: summary([]).id, text: 'Retry just this checkpoint', stages: ['Deleted sibling'],
    stagesApplied: true, mode: 'finish', dueAt: 0, model: null, reasoningEffort: null, state: 'failed', owner: null,
    createdAt: 0, conversationId: 'chat-b', error: 'Provider rejected opted-in after-turn delivery' }];
  await append([]);
  w.document.querySelector<HTMLButtonElement>('[aria-label="Retry delivery"]')!.click(); await settle();
  expect((w.document.getElementById('chatInput') as HTMLTextAreaElement).value).toBe('Retry just this checkpoint');
  expect(live.sent).toHaveLength(0);
  expect(w.document.getElementById('finishQueue')!.hidden).toBe(true);
});

it('retains a rejected queue admission independently of composer edits and retries as finish only', async () => {
  const { w, live } = await boot([]);
  const api = (w as any).api, send = api.sendInput;
  let reject!: (value: unknown) => void;
  api.sendInput = vi.fn(() => new Promise(resolve => { reject = resolve; }));
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['First checkpoint', 'Last checkpoint'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Plan the remaining checks';
  w.document.getElementById('createPlan')!.click(); await settle();
  input.value = ''; input.dispatchEvent(new w.Event('input'));
  reject({ ok: false, error: 'Queue full' }); await settle();
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(2);
  expect(w.document.getElementById('chatSend')!.getAttribute('aria-label')).toBe('Queue plan at Session finish');
  api.sendInput = send;
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ mode: 'finish', text: 'First checkpoint', stages: ['Last checkpoint'] });
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(2);
  expect(input.value).toBe('');
});

it.each([false, true])('clears the planner prompt and starts a new-chat plan with Enter from the empty composer (pro=%s)', async pro => {
  const { w, live } = await boot([], false, [], [], { pro });
  const effort = w.document.getElementById('composerReasoning') as HTMLSelectElement;
  effort.value = pro ? 'pro' : 'high'; effort.dispatchEvent(new w.Event('change')); await settle();
  (w as any).api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['Build foundation', 'Verify it'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Original objective';
  w.document.getElementById('createPlan')!.click(); await settle();
  expect(input.value).toBe('');
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true }));
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, cancelable: true }));
  await settle(); expect(live.sent).toHaveLength(0);
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', cancelable: true })); await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ objective: 'Original objective', text: 'Build foundation', stages: ['Verify it'], reasoningEffort: pro ? 'pro' : 'high' });
});

it('does not erase a new composer draft while completed-plan queue admission is pending', async () => {
  const { w } = await boot([]);
  const api = (w as any).api, send = api.sendInput;
  let admit!: () => Promise<void>;
  api.sendInput = vi.fn((args: InputArgs) => new Promise(resolve => { admit = async () => resolve(await send(args)); }));
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['First checkpoint', 'Last checkpoint'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Planner request';
  w.document.getElementById('createPlan')!.click(); await settle();
  expect(input.value).toBe('');
  input.value = 'My next correction'; input.dispatchEvent(new w.Event('input'));
  await admit(); await settle();
  expect(input.value).toBe('My next correction');
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(2);
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

it('does not turn an empty or repeated form submission into a Stop request', async () => {
  const { w, live } = await boot([]);
  const api = (w as any).api;
  const stop = vi.fn(async () => ({ ok: true, data: {} }));
  api.stopSessionTurn = stop;
  const form = w.document.getElementById('composer')!;
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(stop).not.toHaveBeenCalled();
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'A single correction'; input.dispatchEvent(new w.Event('input'));
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(live.sent.map(row => row.text)).toEqual(['A single correction']);
  expect(stop).not.toHaveBeenCalled();
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
  send.click();
  await settle();
  expect(stop).toHaveBeenCalledWith('2026-09-02-test0001', 'held-turn');
  expect(cancel).not.toHaveBeenCalled();
  expect(input.value).toBe('');
});

it('does not retarget an awaiting Stop after leaving and reselecting the same chat', async () => {
  const { w } = await boot([]);
  const api = (w as any).api;
  const baseControls = api.getSessionControls;
  const original = async (id: string) => ({ ok: true, data: { ...(await baseControls(id)).data,
    plan: { updatedAt: 2, plan: [{ step: 'Current plan', status: 'in_progress', details: 'Current selection' }] } } });
  const stop = vi.fn(async () => ({ ok: true, data: {} }));
  api.stopSessionTurn = stop;
  let resolve!: (value: any) => void;
  api.getSessionControls = () => new Promise(done => { resolve = done; });
  w.document.getElementById('chatSend')!.click();
  api.getSessionControls = original;
  w.document.getElementById('newChat')!.click();
  (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click();
  await settle();
  expect(w.document.getElementById('agentPlan')!.textContent).toContain('Current plan');
  resolve({ ok: true, data: { ...(await original('2026-09-02-test0001')).data,
    plan: { updatedAt: 1, plan: [{ step: 'Stale plan', status: 'pending' }] } } });
  await settle();
  expect(stop).not.toHaveBeenCalled();
  expect(w.document.getElementById('chatSend')!.dataset.action).toBe('stop');
  expect(w.document.getElementById('agentPlan')!.textContent).toContain('Current plan');
  expect(w.document.getElementById('agentPlan')!.textContent).not.toContain('Stale plan');
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
  expect(live.sent[0]).toMatchObject({ text: 'Inspect and implement the task', objective: 'Implement and verify', automation: 'goal', authoredSource: 'objective' });
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

it('shows Loop settling, its real waiting deadline, and generated text in the same row', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api;
  const controls = { automation: 'loop', objective: 'Continue the task', blocked: '', job: null,
    goalWait: { reason: 'quiet', until: Date.now() + 125_000 }, goalDraft: null as unknown };
  api.getSessionControls = async () => ({ ok: true, data: controls });
  await append([]);
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.hidden).toBe(false);
  expect(row.textContent).toContain('Loop · Waiting for tool inactivity');
  expect(row.querySelector('[role="timer"]')?.textContent).toContain('2:05');
  expect(row.getAttribute('aria-busy')).toBe('true');
  controls.goalDraft = { stage: 'answering', model: 'fixture', text: 'Continue with the remaining checks', error: null };
  await append([]);
  expect(w.document.getElementById('goalLifecycle')).toBe(row);
  expect(row.textContent).toContain('Generating a continuation');
  expect(row.textContent).toContain('Continue with the remaining checks');
  expect(row.querySelector('[role="timer"]')).toBeNull();
  controls.automation = 'off'; await append([]);
  expect(row.hidden).toBe(true);
  expect(row.textContent).toBe('');
});

it('follows the accepted New Chat receipt while preserving a typed follow-up', async () => {
  const { w, live, append } = await boot([], false);
  const composer = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  composer.value = 'Opening message';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(live.sent).toHaveLength(1);
  composer.value = 'Follow-up while delivery is pending';
  composer.dispatchEvent(new w.Event('input'));
  live.inputs = live.inputs.map(row => ({ ...row, state: 'sent', deliveredSessionId: summary([]).id }));
  await append([]);
  expect(w.document.querySelector('#sessionList [data-id].is-sel')).not.toBeNull();
  expect(composer.value).toBe('Follow-up while delivery is pending');
});

it('shows Pro Loop delivery before sending and freezes changes made while the opening is being accepted', async () => {
  const { w, live } = await boot([], false, [], [], { pro: true });
  (await (w as any).api.getState()).data.config.ui.finishTool = true;
  const row = w.document.getElementById('loopDeliveryRow')!;
  const effort = w.document.getElementById('composerReasoning') as HTMLSelectElement;
  const delivery = w.document.getElementById('loopDelivery') as HTMLSelectElement;
  const choose = (value: string) => { effort.value = value; effort.dispatchEvent(new w.Event('change')); };
  w.document.querySelector<HTMLButtonElement>('#automationSwitch [data-mode="loop"]')!.click();
  expect(row.hidden).toBe(true);
  choose('pro'); expect(row.hidden).toBe(false);
  expect(delivery.value).toBe('finish');
  delivery.value = 'after-turn'; delivery.dispatchEvent(new w.Event('change'));
  choose('high'); expect(row.hidden).toBe(true);
  choose('pro'); expect(row.hidden).toBe(false);
  expect(delivery.value).toBe('after-turn');
  const api = (w as any).api;
  const originalSend = api.sendInput;
  let accept!: () => void;
  api.sendInput = vi.fn((input: InputArgs) => new Promise(resolve => { accept = () => resolve(originalSend(input)); }));
  api.setInputAutomation = vi.fn(async () => ({ ok: true, data: true }));
  (w.document.getElementById('chatInput') as HTMLTextAreaElement).value = 'First Pro Loop message';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(api.sendInput.mock.calls[0][0]).toMatchObject({ sessionId: null, automation: 'loop', loopAfterTurn: true });
  delivery.value = 'finish'; delivery.dispatchEvent(new w.Event('change'));
  accept(); await settle();
  expect(api.setInputAutomation).toHaveBeenLastCalledWith(live.sent[0]!.id, 'loop', false);
  w.document.querySelector<HTMLButtonElement>('#automationSwitch [data-mode="goal"]')!.click();
  expect(row.hidden).toBe(true);
  w.document.getElementById('newChat')!.click();
  expect(delivery.value).toBe('finish');
});

it.each(['goal', 'loop'] as const)('keeps Astra %s selected when changing delivery and hides finish choices when finish is disabled', async mode => {
  const { w, append } = await boot([], true, [], [], { astra: true });
  const api = (w as any).api;
  const state = (await api.getState()).data;
  state.config.ui.finishTool = true;
  const getSession = api.getSession;
  api.getSession = async (...args: unknown[]) => {
    const result = await getSession(...args);
    result.data.summary.selectedModel = { conversationId: 'chat-b', model: 'gpt-6-pro', reasoningEffort: 'pro', observedAt: Date.now() };
    return result;
  };
  const model = w.document.getElementById('composerModel') as HTMLSelectElement;
  model.value = 'gpt-6-pro'; model.dispatchEvent(new w.Event('change'));
  const controls = { sessionId: summary([]).id, conversationId: 'chat-b', automation: mode, loopAfterTurn: false, blocked: '' };
  api.getSessionControls = async () => ({ ok: true, data: controls });
  api.setSessionAutomation = vi.fn(async (_id: string, next: string, afterTurn: boolean) => {
    controls.automation = next as typeof mode; controls.loopAfterTurn = afterTurn;
    return { ok: true, data: controls };
  });
  await append([]);
  // Re-select after the session's recorded model projection has settled.
  model.value = 'gpt-6-pro'; model.dispatchEvent(new w.Event('change'));
  const row = w.document.getElementById('loopDeliveryRow')!;
  const delivery = w.document.getElementById('loopDelivery') as HTMLSelectElement;
  expect(row.hidden).toBe(false);
  delivery.value = 'after-turn'; delivery.dispatchEvent(new w.Event('change'));
  await settle();
  expect(api.setSessionAutomation).toHaveBeenLastCalledWith(summary([]).id, mode, true);
  expect((w.document.getElementById('chatAutomation') as HTMLSelectElement).value).toBe(mode);
  state.config.ui.finishTool = false;
  await append([]);
  expect(row.hidden).toBe(true);
  expect(delivery.value).toBe('after-turn');
  state.config.ui.finishTool = true;
  model.value = 'gpt-6-pro'; model.dispatchEvent(new w.Event('change'));
  expect(row.hidden).toBe(false);
  expect(delivery.value).toBe('after-turn');
});

it('applies Off to the exact accepted New Chat opening while preserving an unrelated composer draft', async () => {
  const { w, live, append } = await boot([], false);
  const api = (w as any).api;
  api.draftGoalOpening = vi.fn(async () => ({ ok: true, data: { reply: 'Say hello once', model: 'fixture' } }));
  const controls = api.getSessionControls;
  api.getSessionControls = async (id: string) => { const result = await controls(id); result.data.objective = 'Greeting goal'; return result; };
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

it('cancels pending plan generation when its own draft changes', async () => {
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
  input.value = 'Replacement plan'; input.dispatchEvent(new w.Event('input'));
  expect(api.cancelTaskRequest).toHaveBeenCalledWith(requestId);
  progress({ requestId, phase: 'generating', text: 'Old plan text' });
  expect(w.document.getElementById('taskPlanPreview')!.textContent).not.toContain('Old plan text');
  finish({ ok: true, data: ['Old first stage', 'Old second stage'] }); await settle();
  expect(live.sent).toHaveLength(0);
});

it('preserves composer drafts across chat and settings navigation without forcing a fixed height', async () => {
  const first = summary([]), second = { ...first, id: 'second-chat', title: 'Second chat' };
  const { w } = await boot([], true, [], [], { sessions: [first, second] });
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Long draft\n'.repeat(60); input.dispatchEvent(new w.Event('input'));
  const draft = input.value;
  expect(input.style.height).toBe('');
  (w.document.querySelector('#sessionList [data-id="second-chat"]') as HTMLElement).click(); await settle();
  expect(input.value).toBe('');
  expect(input.style.height).toBe('');
  (w.document.querySelector(`#sessionList [data-id="${first.id}"]`) as HTMLElement).click(); await settle();
  expect(input.value).toBe(draft);
  expect(input.style.height).toBe('');
  const chat = await import('../src/renderer/chat.js');
  chat.openChatView('settings');
  (w.document.querySelector('#sessionList [data-id="second-chat"]') as HTMLElement).click(); await settle();
  (w.document.querySelector(`#sessionList [data-id="${first.id}"]`) as HTMLElement).click(); await settle();
  chat.openChatView('timeline');
  expect(input.value).toBe(draft);
  expect(input.style.height).toBe('');
});

it('retains an existing running chat planner across navigation and accepts its result only in that draft', async () => {
  const first = summary([]), second = { ...first, id: 'second-chat', title: 'Second chat' };
  const { w, live, progress } = await boot([], true, [], [], { sessions: [first, second] });
  const api = (w as any).api;
  api.cancelTaskRequest = vi.fn(async () => ({ ok: true, data: true }));
  let finish!: (value: any) => void;
  api.draftTaskPlan = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Plan for this running chat'; input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click(); await settle();
  const requestId = api.draftTaskPlan.mock.calls[0][2];
  (w.document.querySelector('#sessionList [data-id="second-chat"]') as HTMLElement).click(); await settle();
  input.value = 'Unrelated draft'; input.dispatchEvent(new w.Event('input'));
  expect(api.cancelTaskRequest).not.toHaveBeenCalled();
  progress({ requestId, phase: 'generating', text: 'Original chat progress' });
  expect(w.document.getElementById('taskPlanPreview')!.textContent).not.toContain('Original chat progress');
  (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click(); await settle();
  expect(input.value).toBe('Plan for this running chat');
  expect(w.document.getElementById('taskPlanPreview')!.textContent).toContain('Original chat progress');
  expect(w.document.getElementById('createPlan')!.getAttribute('aria-busy')).toBe('true');
  (w.document.querySelector('#sessionList [data-id="second-chat"]') as HTMLElement).click(); await settle();
  finish({ ok: true, data: ['Original first stage', 'Original checkpoint'] }); await settle();
  expect(input.value).toBe('Unrelated draft');
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(0);
  (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click(); await settle();
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(2);
  expect(input.value).toBe('');
  expect(w.document.getElementById('taskPlanPreview')!.hidden).toBe(true);
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ sessionId: summary([]).id, mode: 'finish', text: 'Original first stage', stages: ['Original checkpoint'] });
});

it('keeps two planner owners independent and ignores a cancelled result after returning to its chat', async () => {
  const first = summary([]), second = { ...first, id: 'second-chat', title: 'Second chat' };
  const { w, live } = await boot([], true, [], [], { sessions: [first, second] });
  const api = (w as any).api;
  const pending = new Map<string, (value: any) => void>();
  api.draftTaskPlan = vi.fn((text: string) => new Promise(resolve => { pending.set(text, resolve); }));
  api.cancelTaskRequest = vi.fn(async () => ({ ok: true, data: true }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const generate = () => w.document.getElementById('createPlan')!.click();
  const select = async (id: string) => { (w.document.querySelector(`#sessionList [data-id="${id}"]`) as HTMLElement).click(); await settle(); };
  input.value = 'Plan A'; generate(); await settle();
  const requestA = api.draftTaskPlan.mock.calls[0][2];
  await select(second.id);
  input.value = 'Plan B'; generate(); await settle();
  pending.get('Plan A')!({ ok: true, data: ['A first', 'A check'] }); await settle();
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(0);
  expect(w.document.getElementById('createPlan')!.getAttribute('aria-busy')).toBe('true');
  await select(first.id);
  expect(w.document.getElementById('finishQueue')!.textContent).toContain('A first');
  await select(second.id);
  const requestB = api.draftTaskPlan.mock.calls[1][2];
  generate(); // Explicitly cancel B; A and navigation did not cancel it.
  expect(api.cancelTaskRequest.mock.calls).toEqual([[requestB]]);
  expect(api.cancelTaskRequest).not.toHaveBeenCalledWith(requestA);
  input.value = 'B replacement'; generate(); await settle();
  pending.get('Plan B')!({ ok: true, data: ['Stale B result'] }); await settle();
  expect(w.document.getElementById('taskPlanPreview')!.textContent).not.toContain('Stale B');
  pending.get('B replacement')!({ ok: false, error: 'Planner unavailable' }); await settle();
  await select(first.id); await select(second.id);
  expect(w.document.getElementById('taskPlanPreview')!.textContent).toContain('Planner unavailable');
  expect(input.value).toBe('B replacement');
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ sessionId: first.id, text: 'A first', mode: 'finish' });
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
  expect(row.textContent).toContain('No API key is configured for the continuation provider.');
  expect(row.textContent).not.toContain('no_api_key');
  expect(row.getAttribute('aria-busy')).toBe('false');
  expect(opening).not.toHaveBeenCalled();
});

it('shows the immediate recovery deadline before a draft exists and clears it on fresh work', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api, original = api.getSessionControls;
  let goalWait: object | null = { reason: 'silence', until: Date.now() + 120_000 };
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data,
    automation: 'loop', goalWait, goalDraft: null } });
  await append([]);
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.hidden).toBe(false);
  expect(row.textContent).toContain('Loop · Waiting before recovery reload');
  expect(row.querySelector('[role="timer"]')).not.toBeNull();
  goalWait = null;
  await append([]);
  expect(row.hidden).toBe(true);
});

it.each([
  { reason: 'silence', kind: 'silence' },
  { reason: 'listening', kind: 'post-reload' },
  { reason: 'native-busy', kind: 'native-busy' },
  { reason: 'quiet', kind: 'post-reload' }
] as const)('shows the shared $reason deadline once while keeping independent Loop waits', async ({ reason, kind }) => {
  const { w, append } = await boot([]);
  const api = (w as any).api, original = api.getSessionControls;
  const deadline = Date.now() + 60_000;
  const goalWait = { reason, until: deadline };
  const recovery = [{ kind: kind as string, deadline, visibleAt: 0 }];
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data,
    automation: 'loop', objective: 'Keep working', goalWait, recovery, goalDraft: null } });
  await append([]);
  const lifecycle = w.document.getElementById('goalLifecycle')!;
  expect(lifecycle.hidden).toBe(true);
  expect(lifecycle.querySelector('[role="timer"]')).toBeNull();
  expect(w.document.getElementById('recoveryStatus')!.hidden).toBe(false);
  expect(w.document.getElementById('activeGoalRow')!.hidden).toBe(false);
  expect(w.document.querySelectorAll('#composerDock [role="timer"]')).toHaveLength(1);

  // A different deadline is independent, even when both owners happen to be waiting.
  goalWait.until += 15_000;
  await append([]);
  expect(lifecycle.hidden).toBe(false);
  expect(w.document.querySelectorAll('#composerDock [role="timer"]')).toHaveLength(2);

  // A hidden recovery row must not swallow the only visible indication of a wait.
  goalWait.until = deadline; recovery[0]!.visibleAt = deadline - 15_000;
  await append([]);
  expect(lifecycle.hidden).toBe(false);
  expect(w.document.getElementById('recoveryStatus')!.hidden).toBe(true);

  // Attribution and pickup have their own actions, even at the same timestamp.
  recovery[0]!.visibleAt = 0; recovery[0]!.kind = 'pickup';
  await append([]);
  expect(lifecycle.hidden).toBe(false);
  expect(w.document.querySelectorAll('#composerDock [role="timer"]')).toHaveLength(2);
});

it.each([false, true])('does not redisplay the old reload receipt after Continue starts the next turn (developer mode: %s)', async developerMode => {
  const reloadedAt = Date.now() - 60_000;
  const repair: SessionEvent = { seq: 1, time: reloadedAt, source: 'app', kind: 'progress',
    progressId: 'browser-repair:fixture', turnId: 'silent-turn',
    message: text('Reloaded chat to recover an unresponsive open turn.') };
  const { w, append, live } = await boot([repair], true, [], [], { developerMode });
  const host = w.document.getElementById('recoveryStatus')!;
  expect(host.hidden).toBe(false);
  await append([{ seq: 2, time: Date.now(), source: 'app', kind: 'turn_start', turnId: 'silent-turn' }]);
  expect(host.hidden).toBe(false); // Reopening the same source is not a new question.
  await append([
    { seq: 3, time: Date.now(), source: 'extension', kind: 'user_message', messageId: 'continue-message', message: text('Continue the work.') },
    { seq: 4, time: Date.now(), source: 'extension', kind: 'turn_start', turnId: 'continued-turn' }
  ]);
  expect(host.hidden).toBe(true);
  expect(live.events).toContainEqual(repair);
  if (developerMode) expect(w.document.getElementById('timeline')!.textContent).toContain(repair.message.text);
  await append([{ ...repair, seq: 5, time: Date.now(), turnId: 'continued-turn', progressId: 'browser-repair:new-turn' }]);
  expect(host.hidden).toBe(false);
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

it('opens every selected chat at the bottom and preserves manual reading during live updates', async () => {
  const rows = Array.from({ length: 160 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `opening-${i}`, message: text(`Opening item ${i + 1}`) }));
  const first = summary(rows), second = { ...summary(rows), id: '2026-09-02-test0002', title: 'Other chat' };
  const { w, append } = await boot(rows, false, [], [], { sessions: [first, second] });
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  Object.defineProperties(pane, { clientHeight: { value: 400 },
    scrollHeight: { get: () => timeline.querySelectorAll('[data-timeline-key]').length * 100 } });
  w.document.getElementById('timelineContent')!.getBoundingClientRect = () => ({ height: pane.scrollHeight } as DOMRect);
  const select = async (id: string) => {
    (w.document.querySelector(`#sessionList [data-id="${id}"]`) as HTMLElement).click();
    await settle();
    expect(pane.scrollTop).toBe(pane.scrollHeight); // Chromium clamps to the actual bottom.
  };
  await select(first.id);
  // A global notification from another chat still refreshes this idle selection.
  // A deliberate small scroll away from its bottom must remain a reading position.
  pane.scrollTop = pane.scrollHeight - pane.clientHeight - 20;
  const nearTail = pane.scrollTop;
  for (let index = 0; index < 3; index++) {
    await append([]);
    expect(pane.scrollTop).toBe(nearTail);
  }
  for (let i = 0; i < 3; i++) {
    pane.scrollTop = 700;
    await append([]);
    expect(pane.scrollTop).toBe(700);
    await select(second.id);
    pane.scrollTop = 0;
    await select(first.id);
  }

  // A late opening response must neither replace the current chat nor drag its reader down.
  const api = (w as any).api, original = api.getSession;
  const pending: Array<() => void> = [];
  api.getSession = async (id: string, options: unknown) => {
    await new Promise<void>(resolve => pending.push(resolve));
    return original(id, options);
  };
  await append([]); // Old A refresh is still in flight when A -> B -> A begins.
  (w.document.querySelector(`#sessionList [data-id="${second.id}"]`) as HTMLElement).click();
  (w.document.querySelector(`#sessionList [data-id="${first.id}"]`) as HTMLElement).click();
  expect(pending).toHaveLength(3);
  pending[2]!(); await settle();
  expect(pane.scrollTop).toBe(pane.scrollHeight);
  pane.scrollTop = 850;
  pending[1]!(); pending[0]!(); await settle();
  expect(pane.scrollTop).toBe(850);
  expect(w.document.getElementById('chatTitle')!.textContent).toBe(first.title);
});

it.each(['empty', 'failed'])('keeps a fitting chat live after an %s older-page read', async outcome => {
  const { w, append } = await boot([{ seq: 12, time: T0, source: 'extension', kind: 'user_message',
    messageId: 'short', message: text('Short chat') }]);
  const api = (w as any).api, original = api.getSession;
  const read = vi.fn((id: string, options: any) => options?.before && outcome === 'failed'
    ? Promise.resolve({ ok: false, error: 'Read failed' }) : original(id, options));
  api.getSession = read;
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  Object.defineProperties(pane, { clientHeight: { value: 800 }, scrollHeight: { value: 800 } });
  pane.scrollTop = 0;
  pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 })); await settle();
  expect(read).toHaveBeenCalledWith(expect.any(String), { before: 12, limit: 30 });
  expect(pane.scrollTop).toBe(0);
  expect(timeline.querySelector('.timeline-window-note')).toBeNull();
  expect(w.document.getElementById('timelineContent')!.style.getPropertyValue('--timeline-scroll-reserve')).toBe('');
  await append([{ seq: 13, time: T0 + 1, source: 'extension', kind: 'assistant_message',
    messageId: 'fresh', message: text('Still receiving live output'), final: true }]);
  expect(timeline.textContent).toContain('Still receiving live output');
  expect(read).toHaveBeenLastCalledWith(expect.any(String), { from: 13, limit: 30 });
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
  };
  const up = async () => {
    pane.scrollTop = 0;
    pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 }));
    await settleHistoryFrame(w);
  };
  await up();
  expect(pane.scrollTop).toBe(600);
  expect(timeline.textContent).toContain('History item 301');
  expect(timeline.textContent).toContain('History item 360');
  await append([{ seq: 361, time: T0 + 361, source: 'extension', kind: 'user_message', messageId: 'newest', message: text('Newest live input') }]);
  expect(timeline.textContent).toContain('History item 301');
  expect(timeline.textContent).not.toContain('Newest live input');
  for (let page = 0; page < 12 && !timeline.textContent?.includes('History item 1'); page++) await up();
  expect(timeline.textContent).toContain('History item 1');
  expect(timeline.querySelectorAll('[data-timeline-key]').length).toBeLessThanOrEqual(160);
  expect(timeline.querySelector('[data-history="latest"]')).toBeNull();
});
it('scrolls forward through evicted history with wheel, keyboard and scrollbar, then resumes live deltas', async () => {
  const rows = Array.from({ length: 400 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `bidirectional-${i}`, message: text(`Bidirectional item ${i + 1}.`) }));
  const { w, live, append } = await boot(rows);
  const api = (w as any).api;
  const read = vi.fn(async (_id: string, options: { from?: number; before?: number; after?: number; limit: number }) => {
    const eligible = live.events.filter(e => (options.from === undefined || e.seq >= options.from) && (options.before === undefined || positionOf(e) < options.before) && (options.after === undefined || positionOf(e) > options.after));
    const page = options.from === undefined && options.after === undefined ? eligible.slice(-options.limit) : eligible.slice(0, options.limit);
    return { ok: true, data: { summary: summary(live.events), events: page, total: live.events.length,
      nextFrom: page.reduce((next, e) => Math.max(next, e.seq + 1), options.from ?? 0) } };
  });
  api.getSession = read;
  const timeline = w.document.getElementById('timeline')!;
  const pane = w.document.getElementById('chatBody')!;
  Object.defineProperties(pane, { clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, get: () => timeline.querySelectorAll('[data-timeline-key]').length * 20 } });
  // Model one layout snapshot per DOM revision. A selector scan inside every
  // rectangle read made this mock quadratic and exhausted Windows CI's timeout.
  let geometryRows: Map<Element, number> | null = null;
  const geometryChanges = new w.MutationObserver(() => { geometryRows = null; });
  geometryChanges.observe(timeline, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-timeline-key'] });
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    if (geometryChanges.takeRecords().length) geometryRows = null;
    geometryRows ??= new Map([...timeline.querySelectorAll('[data-timeline-key]')].map((row, index) => [row, index]));
    const index = geometryRows.get(this) ?? -1;
    const top = index < 0 ? 0 : index * 20 - pane.scrollTop;
    return { top, bottom: top + 20, height: 20 } as DOMRect;
  };
  for (let i = 0; i < 14 && !timeline.textContent?.includes('Bidirectional item 1.'); i++) {
    pane.scrollTop = 0;
    pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 }));
    await settleHistoryFrame(w);
  }
  expect(timeline.textContent).toContain('Bidirectional item 1.');
  expect(timeline.textContent).not.toContain('Bidirectional item 400.');
  const downward = async (kind: string) => {
    pane.scrollTop = pane.scrollHeight - pane.clientHeight;
    const anchor = [...timeline.querySelectorAll<HTMLElement>('[data-timeline-key]')].find(row => {
      const rect = row.getBoundingClientRect(); return rect.bottom > 0 && rect.top >= 0;
    })!;
    const before = anchor.getBoundingClientRect().top;
    if (kind === 'wheel') pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: 100 }));
    else if (kind === 'keyboard') pane.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'PageDown' }));
    else {
      pane.scrollTop -= 100;
      pane.dispatchEvent(new w.Event('pointerdown'));
      pane.scrollTop += 100; pane.dispatchEvent(new w.Event('scroll'));
      w.dispatchEvent(new w.Event('pointerup'));
    }
    await settleHistoryFrame(w);
    expect(anchor.isConnected).toBe(true);
    expect(anchor.getBoundingClientRect().top).toBe(before);
    expect(timeline.querySelectorAll('[data-timeline-key]').length).toBeLessThanOrEqual(160);
    const count = read.mock.calls.length;
    pane.dispatchEvent(new w.Event('scroll')); await settleHistoryFrame(w);
    expect(read).toHaveBeenCalledTimes(count);
  };
  for (let page = 0; page < 14 && !timeline.textContent?.includes('Bidirectional item 400.'); page++) {
    await downward(['wheel', 'keyboard', 'scrollbar'][page % 3]!);
  }
  expect(timeline.textContent).toContain('Bidirectional item 400.');
  expect(read.mock.calls.every(([, options]) => options.limit === 30)).toBe(true);
  await downward('wheel'); // Empty forward page proves we reached the current tail.
  await append([{ seq: 401, time: T0 + 401, source: 'extension', kind: 'user_message', messageId: 'live-again', message: text('Live again') }]);
  expect(timeline.textContent).toContain('Live again');
  geometryChanges.disconnect();
});

it('keeps a revised long answer reachable in both directions and never uses its revision as a history boundary', async () => {
  const rows = Array.from({ length: 360 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `origin-${i}`, message: text(`Origin row ${i + 1}.`) }));
  rows[99] = { seq: 1000, origin: 100, time: T0 + 99, source: 'extension', kind: 'assistant_message',
    messageId: 'long-reviewed-answer', message: text('Detailed ratings. '.repeat(1000)), final: true };
  const { w } = await boot(rows);
  const api = (w as any).api;
  const read = vi.fn(api.getSession);
  api.getSession = read;
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  // The renderer fills a requested edge across animation frames. A permanently
  // underfilled mock kept that demand alive, making the last read depend on timing.
  Object.defineProperties(pane, { clientHeight: { value: 400 },
    scrollHeight: { get: () => Math.max(400, timeline.querySelectorAll('[data-timeline-key]').length * 20) } });
  let geometryRows: Map<Element, number> | null = null;
  const geometryChanges = new w.MutationObserver(() => { geometryRows = null; });
  geometryChanges.observe(timeline, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-timeline-key'] });
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    if (geometryChanges.takeRecords().length) geometryRows = null;
    geometryRows ??= new Map([...timeline.querySelectorAll('[data-timeline-key]')].map((row, index) => [row, index]));
    const index = geometryRows.get(this) ?? -1;
    const top = index < 0 ? 0 : index * 20 - pane.scrollTop;
    return { top, bottom: top + 20, height: 20 } as DOMRect;
  };
  const page = async (deltaY: number) => {
    pane.scrollTop = deltaY < 0 ? 0 : pane.scrollHeight - pane.clientHeight;
    pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY }));
    await settleHistoryFrame(w);
  };
  for (let index = 0; index < 12 && !timeline.textContent?.includes('Detailed ratings.'); index++) await page(-100);
  expect(timeline.textContent).toContain('Detailed ratings.');
  expect(timeline.querySelectorAll('.ev-assistant_message')).toHaveLength(1);
  expect(read).toHaveBeenLastCalledWith(expect.any(String), { before: 121, limit: 30 });
  const newestBefore = Math.max(...[...timeline.querySelectorAll<HTMLElement>('.ev-user_message')]
    .map(row => Number(row.textContent?.match(/Origin row (\d+)\./)?.[1] ?? 0)));
  await page(100);
  expect(read).toHaveBeenLastCalledWith(expect.any(String), { after: newestBefore, limit: 30 });
  expect(timeline.textContent).toContain(`Origin row ${newestBefore + 30}.`);
  await page(-100);
  expect(timeline.textContent).toContain('Detailed ratings.');
  expect(timeline.querySelectorAll('.ev-assistant_message')).toHaveLength(1);
  geometryChanges.disconnect();
});

it('keeps reloaded interim messages above their tool groups through live results and repaint', async () => {
  const working = '11111111-1111-4111-8111-111111111111';
  const exchange = '22222222-2222-4222-8222-222222222222';
  const parent = '33333333-3333-4333-8333-333333333333';
  const turns = { working: { origin: 1, time: T0 } };
  const rows: SessionEvent[] = [
    { seq: 1, time: T0, kind: 'turn_start', source: 'extension', turnId: 'working' },
    { seq: 2, time: T0 + 2000, kind: 'assistant_message', source: 'extension', turnId: 'working',
      messageId: `assistant:${parent}:${working}:${exchange}`, message: text('FIRST UPDATE'), final: false },
    ...[3, 4].map(seq => ({ ...toolCall(seq, `before-${seq}`), turnId: 'working' })),
    { seq: 7, origin: 5, time: T0 + 5000, kind: 'assistant_message', source: 'extension',
      messageId: `assistant:${exchange}:${working}:${exchange}`, message: text('SECOND UPDATE'), final: false },
    { ...toolCall(6, 'after-6'), turnId: 'working' },
    { ...toolCall(8, 'after-8'), turnId: 'working' }
  ];
  const { w, append } = await boot(projectTimeline(rows, turns));
  const timeline = w.document.getElementById('timeline')!;
  const reading = () => [...timeline.children].filter(row => row.matches('.ev-assistant_message, .tool-group'));
  expect(reading().map(row => row.classList.contains('tool-group') ? 'TOOLS' : row.textContent))
    .toEqual([expect.stringContaining('FIRST UPDATE'), 'TOOLS', expect.stringContaining('SECOND UPDATE'), 'TOOLS']);
  const group = reading()[3] as HTMLDetailsElement;
  group.open = true;
  group.dispatchEvent(new w.Event('toggle'));
  await append(projectTimeline([{ ...toolCall(9, 'after-9'), turnId: 'working' }], turns, {}, rows));
  expect(reading()[3]).toBe(group);
  expect(group.open).toBe(true);
  expect(group.querySelectorAll('.ev-tool_call')).toHaveLength(3);
  await append([]);
  expect(reading()[2]?.textContent).toContain('SECOND UPDATE');
  expect(reading()[3]).toBe(group);
  expect(timeline.querySelectorAll('.ev-assistant_message')).toHaveLength(2);
});

it('keeps long surrounding prose while materializing large tool results only on expansion', async () => {
  const call = toolCall(2, 'large-output');
  if (call.kind !== 'tool_call') throw new Error('Expected fixture tool');
  call.call.result = text('Recorded output. '.repeat(150000));
  const { w, append } = await boot([
    { seq: 1, time: T0, kind: 'assistant_message', source: 'extension', messageId: 'before-large', message: text('Prose before the large tool'), final: false },
    call,
    { seq: 3, time: T0 + 3000, kind: 'assistant_message', source: 'extension', messageId: 'after-large', message: text('Prose after the large tool'), final: true }
  ]);
  const timeline = w.document.getElementById('timeline')!;
  const disclosure = timeline.querySelector<HTMLDetailsElement>('details.tool')!;
  expect(disclosure.querySelector('.raw')).toBeNull();
  expect(timeline.textContent).toContain('Prose before the large tool');
  expect(timeline.textContent).toContain('Prose after the large tool');
  disclosure.open = true; disclosure.dispatchEvent(new w.Event('toggle')); await settle();
  expect(disclosure.querySelector('.raw')?.textContent).toContain('Recorded output.');
  await append([]);
  expect(timeline.querySelector('details.tool')).toBe(disclosure);
  expect(disclosure.open).toBe(true);
  expect(timeline.textContent).toContain('Prose before the large tool');
});

it('retains the visible collapsed group beyond the normal resident target and still admits newer data', async () => {
  const rows = Array.from({ length: 400 }, (_, i) => toolCall(i + 1, `dense-${i}`));
  const { w, live, append } = await boot(rows);
  const api = (w as any).api;
  api.getSession = async (_id: string, options: { from?: number; before?: number; after?: number; limit: number }) => {
    const eligible = live.events.filter(e => (options.from === undefined || e.seq >= options.from) && (options.before === undefined || positionOf(e) < options.before) && (options.after === undefined || positionOf(e) > options.after));
    const page = options.from === undefined && options.after === undefined ? eligible.slice(-options.limit) : eligible.slice(0, options.limit);
    return { ok: true, data: { summary: summary(live.events), events: page, total: live.events.length,
      nextFrom: page.reduce((next, e) => Math.max(next, e.seq + 1), options.from ?? 0) } };
  };
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  Object.defineProperties(pane, { clientHeight: { value: 400 }, scrollHeight: { value: 400 } });
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    return { top: 0, bottom: this.classList.contains('tool-group') ? 30 : 0,
      height: this.classList.contains('tool-group') ? 30 : 0 } as DOMRect;
  };
  const group = timeline.querySelector('.tool-group');
  // One deliberate movement keeps filling the edge through collapsed batches.
  // Await the actual read result, including its animation-frame yields.
  pane.scrollTop = 0; pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 }));
  await vi.waitFor(() => expect(timeline.querySelectorAll('.ev-tool_call')).toHaveLength(rows.length), { timeout: 5000 });
  expect(timeline.querySelector('.tool-group')).toBe(group);
  expect(timeline.querySelectorAll('.raw')).toHaveLength(0);
  for (let i = 0; i < 14; i++) {
    pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: 100 })); await settle();
  }
  await append([{ seq: 401, time: T0 + 401_000, source: 'extension', kind: 'user_message',
    messageId: 'dense-live', message: text('New data at the resident bound') }]);
  expect(timeline.textContent).toContain('New data at the resident bound');
  expect(timeline.querySelector('.tool-group')).toBe(group);
  expect(timeline.querySelectorAll('.ev').length).toBeLessThanOrEqual(rows.length + 1);
});

it.each(['older', 'newer'])('does not apply a %s-page response or scroll after switching to a new chat', async direction => {
  const rows = Array.from({ length: 200 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `prior-${i}`, message: text(`Prior row ${i}`) }));
  const { w } = await boot(rows);
  const api = (w as any).api;
  const pane = w.document.getElementById('chatBody')!;
  if (direction === 'newer') {
    pane.scrollTop = 0; pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 })); await settle();
  }
  const original = api.getSession;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  api.getSession = async (id: string, options: any) => { if (options?.before || options?.after !== undefined) await pending; return original(id, options); };
  pane.scrollTop = 0; pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: direction === 'older' ? -100 : 100 }));
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


it('keeps a cancelled automatic draft at its creation time as later messages arrive', async () => {
  const app = await boot([
    { seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'before-draft', message: text('Original work') },
    { seq: 2, time: T0 + 2000, source: 'extension', kind: 'user_message', messageId: 'after-draft', message: text('Later continuation') }
  ]);
  const { w, live } = app;
  live.inputs.push({ id: 'retired-auto', sessionId: summary([]).id, conversationId: 'chat-b', text: 'Unused automatic instruction',
    mode: 'auto', dueAt: T0 + 1000, createdAt: T0 + 1000, state: 'cancelled', owner: null, model: null, reasoningEffort: null,
    finishOwner: { turnId: 'old-turn', periodic: false },
    error: 'Automatic follow-up cancelled because its active turn or setting changed.' });
  await app.append([]);
  const timeline = w.document.getElementById('timeline')!;
  const retired = timeline.querySelector<HTMLElement>('[data-input-id="retired-auto"]')!;
  expect(retired).not.toBeNull();
  expect(retired.querySelector('time')!.textContent).toBe(new Date(T0 + 1000).toLocaleString());
  expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('Unused automatic instruction');
  const before = () => timeline.textContent!.indexOf('Unused automatic instruction') < timeline.textContent!.indexOf('Later continuation');
  expect(before()).toBe(true);
  await app.append([{ seq: 3, time: T0 + 3000, source: 'extension', kind: 'assistant_message', messageId: 'new-progress', message: text('New work continues'), final: false }]);
  expect(timeline.querySelector('[data-input-id="retired-auto"]')).toBe(retired);
  expect(before()).toBe(true);
  expect(live.sent).toHaveLength(0);
  retired.querySelector<HTMLButtonElement>('[title="Dismiss delivery notice"]')!.click();
  await app.append([]);
  expect(timeline.textContent).not.toContain('Unused automatic instruction');
  expect(live.sent).toHaveLength(0);
});
