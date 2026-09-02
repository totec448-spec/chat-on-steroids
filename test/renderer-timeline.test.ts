import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_GOAL_SYSTEM_PROMPT } from '../src/shared/goal.js';
import type { SessionEvent, SessionSummary } from '../src/shared/session.js';

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

async function boot(events: SessionEvent[]) {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(globalThis, {
    window: w,
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
    ui: { minimizeToTray: true, autoConnect: false, privacyScreenshots: false, theme: 'light' },
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
  const live = { events: [...events] };
  let sessionListener: () => void = () => undefined;
  const api: any = new Proxy(
    {
      getState: () => ok(state),
      getLog: () => ok([]),
      getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
      onStateChanged: () => () => undefined,
      onLogEntry: () => () => undefined,
      onSwarmChanged: () => () => undefined,
      onSessionChanged: (fn: any) => {
        sessionListener = fn;
        return () => undefined;
      },
      listSessions: () => ok({ sessions: [summary(live.events)], activeId: summary(live.events).id, pressure: [] }),
      getSession: (_id: string, options?: { from?: number }) => {
        const from = options?.from ?? 0;
        const page = live.events.filter((event) => event.seq >= from);
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
  (w.document.querySelector('nav button[data-tab="chat"]') as HTMLButtonElement).click();
  await settle();

  return {
    w,
    live,
    async append(more: SessionEvent[]) {
      live.events.push(...more);
      sessionListener();
      await settle(500);
    }
  };
}

it('folds a whole Compact & Resume into one card with its three steps', async () => {
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
  expect([...card.querySelectorAll('summary .step')].map((step) => [step.textContent, step.className])).toEqual([
    ['Summary requested', 'step is-ok'],
    ['Summary received', 'step is-ok'],
    ['New chat opened', 'step is-ok']
  ]);

  // The rows the card replaces are gone from the list; nothing else is.
  expect(timeline.querySelector('.ev-handoff')).toBeNull();
  expect(timeline.textContent).not.toContain('[[CLF-');
  expect(timeline.querySelectorAll('.ev-turn_start, .ev-turn_end')).toHaveLength(0);
  expect(timeline.querySelectorAll('.ev-tool_call')).toHaveLength(2);
  // The card sits where the compaction happened, between the two calls.
  const order = [...timeline.children].map((row) => row.className);
  expect(order).toEqual(['ev ev-session_start', 'ev ev-tool_call', 'ev ev-compaction', 'ev ev-tool_call']);

  // Everything is still there for whoever unfolds the card.
  card.toggleAttribute('open', true);
  expect(card.textContent).toContain('Brief request');
  expect(card.textContent).toContain('keep the loop running');
  expect(card.textContent).toContain('Handoff saved');
  expect(card.textContent).toContain('Bootstrap sent into the new chat');
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
  const steps = () => [...timeline.querySelectorAll('details.compaction summary .step')].map((step) => step.textContent);
  // Still the newest thing recorded: the summary is in, the new chat is being opened.
  expect(steps()).toEqual(['Summary requested', 'Summary received', 'Opening chat']);
  expect(timeline.querySelector('details.compaction')!.className).toContain('tone-wait');

  // The old chat carried on instead — the handoff never became a new chat.
  await append([toolCall(9, 'call-late')]);
  expect(steps()).toEqual(['Summary requested', 'Summary received', 'No new chat']);
  expect(timeline.querySelector('details.compaction')!.className).toContain('tone-bad');
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
});
