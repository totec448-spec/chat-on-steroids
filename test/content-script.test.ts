/**
 * The content script, running against a real DOM.
 *
 * These are the regressions behind the complaint that started all of this: a live ChatGPT
 * page showing a wall of faint "Called tool" rows, and no Compact & resume control
 * anywhere near the composer. Both failures were invisible to the existing tests because
 * those exercise the DOM adapter against structural fakes and never run content.js at all.
 *
 * So this file runs the shipped extension/chatgpt-dom.js and extension/content.js in a
 * jsdom window, against markup shaped like the live page, with a fake service worker
 * standing in for Chrome. Nothing is reimplemented.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { chronological } from '../src/shared/chronology.js';

let domSource = '';
let contentSource = '';

beforeAll(async () => {
  [domSource, contentSource] = await Promise.all([
    fs.readFile(path.join(process.cwd(), 'extension', 'chatgpt-dom.js'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'extension', 'content.js'), 'utf8')
  ]);
});

// ------------------------------------------------------------------ harness

interface ActivityEntry {
  seq: number;
  time: number;
  tool: string;
  callId: string;
  turnId: string | null;
  attribution: string;
  outcome: string;
  durationMs: number;
  summary: { kind: string; tone: string; title: string; detail?: string; metric?: string };
  /** Which agent ran it. Absent, and shown as nothing, in a chat with no agents. */
  agent?: string | null;
  /** ChatGPT's own id for the connector request, which outlives the page load. */
  requestId?: string | null;
}

interface Descriptor {
  index: number;
  tool: string | null;
  path: string | null;
  app: string | null;
  resource: string | null;
  messageId: string | null;
  turnId: string | null;
  conversationId: string | null;
  createTime: number | null;
  hidden: number;
  localCount: number | null;
  answered: boolean;
}

/** The caption, the bar under it, and how far along the bar the run has got. */
interface StagePanelView {
  stage: string;
  detail: string;
  body: string;
  kind: string;
  steps: string[];
  at: number;
  done: boolean;
}

interface Hook {
  /** Legacy test archive only. Production 1.8 removed row-count ownership evidence. */
  connectorBlockCount(section: Element | null): number;
  planLabels(
    blocks: Array<{ callId: string | null; original: string; hidden?: number; tool?: string | null }>,
    calls: ActivityEntry[]
  ): Array<[number, ActivityEntry | null, ActivityEntry[]]>;
  refreshFiber(settled?: Record<string, unknown> | null): Promise<void>;
  fiberFor(block: Element): Descriptor | null;
  readDescriptor(raw: unknown): Descriptor | null;
  controlState(input: Record<string, unknown>): { mode: string; label: string; hint: string; action: string };
  stageView(input: Record<string, unknown>): StagePanelView | null;
  /** The goal loop's half of the same panel, testable without a job in the way. */
  goalStageView(goal: Record<string, unknown> | null): StagePanelView | null;
  settingsView(input: Record<string, unknown>): {
    tip: string;
    rows: Array<{ key: string; label: string; note: string; on: boolean; warn: boolean; disabled?: boolean }>;
    /** The specific goal this chat is being driven towards, and the affordance that sets it. */
    objective: {
      text: string;
      editing: boolean;
      label: string;
      summary: string;
      hint: string;
      available: boolean;
      unavailable: string;
    };
    action: { label: string; hint: string; action: string };
  };
  toggleMenu(): void;
  closeMenu(): void;
  renderControl(): void;
  /** The goal loop's entry point, called with the generation that just ended. */
  noteGoalTurn(ended: unknown, outcome: string, endedTurnId: string | null): void;
  maybeSendGoalReply(): Promise<void>;
  /** How long a finished turn must hold still before the loop believes it. */
  GOAL_STABLE_MS: number;
  emit(observation: Record<string, unknown>): void;
  flush(): Promise<void>;
  observe(): void;
  syncTheme(): void;
  meterView(): { filled: number; level: string; status: string; tip: string } | null;
  paint(): void;
  renderStreams(): void;
  foldBootstrap(): void;
  injectControl(): void;
  injectStage(): void;
  pullActivity(): Promise<void>;
  runCommand(): Promise<void>;
  startCompact(): Promise<void>;
  chronological<T extends { seq: number; time: number; kind: string; turnId?: string | null }>(entries: T[]): T[];
  streamTurnGroups(
    entries: Array<{ seq: number; time: number; kind: string; turnId?: string | null }>
  ): Array<{ id: string; entries: Array<{ seq: number; kind: string; turnId?: string | null }> }>;
  visibleStream(entries: Array<Record<string, any>>, groupId?: string | null): Array<Record<string, any>>;
  /** How long the stop button must stay gone before content.js calls a turn finished. */
  TURN_SETTLE_MS: number;
  /** Test seam for the no-visible-progress fallback. */
  STALL_MS: number;
  /** Test-only gate; production defaults ON while the harness starts presentation OFF. */
  setRenderStream(on: boolean): void;
  renderStreamEnabled(): boolean;
  setShowTimes(on: boolean): void;
  /** How long Overwrite leaves a user-driven scroll completely presentation-stable. */
  PRESENTATION_SCROLL_IDLE_MS: number;
}

interface Harness {
  dom: JSDOM;
  window: JSDOM['window'];
  document: Document;
  hook: Hook;
  /** Every message the content script sent to the "service worker". */
  sent: Array<Record<string, any>>;
  /** Answers, keyed by message type. */
  reply: Map<string, (message: Record<string, any>) => unknown>;
  /** Sends one popup/background message to the content script's runtime listener. */
  runtimeMessage(message: Record<string, any>): Promise<unknown>;
  /** Browser-extension listeners still owned by live recorder instances in this document. */
  listenerCounts(): { runtime: number; storage: number };
  /** Moves the clock the script reads. Nothing else advances it between ticks. */
  advance(ms: number): void;
  close(): void;
}

const PAGE = `<!doctype html><html><body>
  <main id="thread"></main>
  <form id="composer-form">
    <div id="prompt-textarea" contenteditable="true"></div>
    <div data-testid="composer-trailing-actions">
      <button type="button" data-testid="composer-speech-button" aria-label="Dictate"></button>
      <button type="button" data-testid="send-button" aria-label="Send prompt"></button>
    </div>
  </form>
</body></html>`;

/**
 * Builds a page with the content script running on it.
 *
 * Worker answers are registered *before* the script starts, because content.js talks to
 * the worker the moment it loads — redeeming the command its URL names is the first thing
 * it does — and a harness that only answered afterwards would be testing a retry.
 */
async function harness(
  url = 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  replies: Record<string, (message: Record<string, any>) => unknown> = {},
  before: (document: Document, dom: JSDOM) => void = () => undefined
): Promise<Harness> {
  const dom = new JSDOM(PAGE, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const window = dom.window as unknown as Window & typeof globalThis & Record<string, any>;
  await new Promise<void>((resolve) => {
    if (window.document.readyState === 'complete') resolve();
    else window.addEventListener('load', () => resolve());
  });

  const sent: Array<Record<string, any>> = [];
  const reply = new Map<string, (message: Record<string, any>) => unknown>();
  type RuntimeListener = (
    message: Record<string, any>,
    sender: Record<string, any>,
    sendResponse: (reply: unknown) => void
  ) => boolean | void;
  let runtimeListener: RuntimeListener | null = null;
  const runtimeListeners = new Set<RuntimeListener>();
  const storageListeners = new Set<(changes: Record<string, any>, areaName: string) => void>();
  reply.set('register_document', () => ({ ok: true }));
  reply.set('status', () => ({ connected: true, paired: true, port: 8765, pending: 0 }));
  reply.set('events', () => ({ ok: true, pending: 0, durable: true }));
  reply.set('bind', () => ({ ok: true, bound: 0 }));
  reply.set('poll', () => ({ ok: true }));
  reply.set('closed', () => ({ ok: true }));
  reply.set('defer_revival', () => ({ ok: true, deferred: true }));
  reply.set('forget_revival', () => ({ ok: true }));
  for (const [type, answer] of Object.entries(replies)) reply.set(type, answer);
  before(window.document, dom);

  window.chrome = {
    runtime: {
      async sendMessage(message: Record<string, any>) {
        sent.push(message);
        const answer = reply.get(message.type);
        return answer ? answer(message) : { ok: false, error: 'unknown_message' };
      },
      onMessage: {
        addListener(listener: typeof runtimeListener) {
          runtimeListener = listener;
          if (listener) runtimeListeners.add(listener);
        },
        removeListener(listener: typeof runtimeListener) {
          if (listener) runtimeListeners.delete(listener);
          if (runtimeListener === listener) runtimeListener = [...runtimeListeners].at(-1) ?? null;
        }
      }
    },
    storage: {
      onChanged: {
        addListener(listener: (changes: Record<string, any>, areaName: string) => void) {
          storageListeners.add(listener);
        },
        removeListener(listener: (changes: Record<string, any>, areaName: string) => void) {
          storageListeners.delete(listener);
        }
      }
    }
  };

  // The periodic loops are the live page's business, not the test's: every behaviour here
  // is driven through the hook so a case cannot pass by accident on a stray tick.
  window.setInterval = (() => 0) as unknown as typeof window.setInterval;
  // Keeps ordering while making the script's own waits instant. content.js waits half a
  // second at a time for ChatGPT to settle, up to eighty times.
  //
  // The clock moves with them. Several of those waits are budgets — "stop within fifteen
  // seconds" — and a budget measured against a real clock that instant timers never advance
  // is a busy loop for the whole budget. Advancing a fake clock by exactly the sleep that
  // was asked for makes a give-up path arrive after the right number of attempts, instantly.
  let clock = 1_700_000_000_000;
  window.setTimeout = ((fn: () => void, ms?: number) => {
    clock += Number(ms) || 0;
    void Promise.resolve().then(fn);
    return 0;
  }) as unknown as typeof window.setTimeout;
  window.Date.now = () => clock;
  // Time the script measures but never sleeps through. The settle window a turn has to
  // survive before it counts as finished is one of these: content.js only ever *reads* the
  // clock for it, so nothing in the script advances it and a test has to say so itself.
  const advance = (ms: number): void => {
    clock += ms;
  };
  // jsdom has no editing host; ChatGPT's composer is one, and insertPrompt() drives it
  // through execCommand because that is the path React listens on.
  // It is a rich-text editor rather than a textarea, and that difference is load-bearing:
  // inserted text becomes one paragraph per line, so reading it back through `textContent`
  // returns the words with every newline gone. A fake that kept the newlines was why the
  // suite stayed green while every worker whose task was short enough for the bootstrap's
  // blank line to land inside the first 80 characters failed to start in the real browser.
  window.document.execCommand = (command: string, _ui: boolean, value: string) => {
    if (command !== 'insertText') return false;
    const box = window.document.querySelector('#prompt-textarea');
    if (!box) return false;
    for (const line of String(value).split('\n')) {
      const paragraph = window.document.createElement('p');
      paragraph.textContent = line;
      box.append(paragraph);
    }
    return true;
  };

  let hook: Hook | null = null;
  window.CLF_TEST_HOOK = (api: Hook) => {
    hook = api;
  };

  window.eval(domSource);
  window.eval(contentSource);
  if (!hook) throw new Error('content.js did not expose its test hook');

  // The script's own start-up. A marked app-opened page delivers its command first; an
  // ordinary page does the normal status/restore handshake before its first observation.
  await settle();
  return {
    dom,
    window: window as unknown as JSDOM['window'],
    document: window.document,
    hook,
    sent,
    reply,
    runtimeMessage: (message) =>
      new Promise((resolve) => {
        if (!runtimeListener) return resolve(undefined);
        let answered = false;
        const async = runtimeListener(message, {}, (value) => {
          answered = true;
          resolve(value);
        });
        if (async !== true && !answered) resolve(undefined);
      }),
    listenerCounts: () => ({ runtime: runtimeListeners.size, storage: storageListeners.size }),
    advance,
    close: () => dom.window.close()
  };
}

/**
 * The `/compact` requests that asked the app to *start* a compaction.
 *
 * The same message type carries three different things now: opening the transaction, handing
 * back the brief the watched generation produced, and withdrawing an abandoned one. Only the
 * first is a compaction being started, so counting the raw messages counts a page that did
 * its job twice.
 */
const startedCompactions = (harness: Harness): any[] =>
  harness.sent.filter((message) => message.type === 'compact' && !message.cancel && !message.summary);

/** Lets the content script's promise chains run to a stop. */
const settle = async (rounds = 40): Promise<void> => {
  for (let round = 0; round < rounds; round++) await Promise.resolve();
};

let live: Harness | null = null;

afterEach(() => {
  live?.close();
  live = null;
});

describe('one synchronous page snapshot per observer turn', () => {
  it('walks ChatGPT turns once even though several capture decisions need them', async () => {
    live = await harness();
    assistantTurn(live.document, 'snapshot-turn', []);
    const domApi = (live.window as any).CLF_DOM;
    expect(domApi).toBeTruthy();
    const originalTurns = domApi.turns;
    let reads = 0;
    domApi.turns = (...args: unknown[]) => {
      reads++;
      return originalTurns(...args);
    };

    live.hook.observe();

    expect(reads).toBe(1);
  });
});

// ------------------------------------------------------------------ markup

function assistantTurn(document: Document, id: string, labels: string[]): HTMLElement {
  const section = document.createElement('section');
  section.setAttribute('data-testid', 'conversation-turn-2');
  section.setAttribute('data-turn', 'assistant');
  section.setAttribute('data-turn-id', id);
  for (const label of labels) section.append(toolBlock(document, label));
  document.querySelector('#thread')!.append(section);
  return section;
}

/** One user message, in the shape the page renders it. */
function userTurn(document: Document, id: string, text: string): HTMLElement {
  const section = document.createElement('section');
  section.setAttribute('data-testid', 'conversation-turn-1');
  section.setAttribute('data-turn', 'user');
  section.setAttribute('data-turn-id', id);
  const message = document.createElement('div');
  message.setAttribute('data-message-id', `m-${id}`);
  message.setAttribute('data-message-author-role', 'user');
  const body = document.createElement('div');
  body.className = 'whitespace-pre-wrap';
  body.textContent = text;
  message.append(body);
  section.append(message);
  document.querySelector('#thread')!.append(section);
  return section;
}

/** The app-owned Overwrite surface for one logical assistant turn. */
function overwriteStream(section: HTMLElement): HTMLElement | null {
  const legacy = section.querySelector('.clf-stream') as HTMLElement | null;
  if (legacy) return legacy;
  const key = section.getAttribute('data-clf-stream-key');
  if (!key) return null;
  return (
    [...section.ownerDocument.querySelectorAll<HTMLElement>('.clf-stream')].find(
      (root) => root.getAttribute('data-clf-key') === key
    ) ?? null
  );
}

function overwriteText(section: HTMLElement): string {
  return overwriteStream(section)?.textContent ?? '';
}

function overwriteRows(section: HTMLElement, selector: string): HTMLElement[] {
  return [...(overwriteStream(section)?.querySelectorAll<HTMLElement>(selector) ?? [])];
}

/**
 * One tool row.
 *
 * A label ending in `!` means a connector row: it gets the control ChatGPT only puts in
 * those, copied from the live page. Everything else is a built-in row — "Searched the
 * web" and friends — which looks identical apart from that control and its name.
 */
function toolBlock(document: Document, label: string): HTMLElement {
  const connector = label.endsWith('!');
  const block = document.createElement('div');
  block.className = 'pointer-events-none contents';
  const button = document.createElement('button');
  button.type = 'button';
  if (connector) button.setAttribute('aria-label', 'Open tool call list');
  const span = document.createElement('span');
  span.className = 'text-start';
  span.textContent = connector ? label.slice(0, -1) : label;
  button.append(span);
  block.append(button);
  return block;
}

/** The tool rows of a turn, as content.js sees them. */
function blocksOf(section: HTMLElement): Element[] {
  return [...section.querySelectorAll('.pointer-events-none.contents')];
}

/** Puts the page into the generating state content.js requires before it reports blocks. */
function startGenerating(document: Document): void {
  const stop = document.createElement('button');
  stop.setAttribute('data-testid', 'stop-button');
  document.querySelector('[data-testid="composer-trailing-actions"]')!.append(stop);
}

/** Ends it again: ChatGPT swaps stop back for send the moment the turn is over. */
function stopGenerating(document: Document): void {
  document.querySelector('[data-testid="stop-button"]')?.remove();
}

/**
 * Takes the page from generating to genuinely settled, the way the observer sees it.
 *
 * The stop button going away is not on its own the end of a turn — ChatGPT unmounts it
 * across tool phases and rerenders — so content.js waits for the button to stay gone for
 * TURN_SETTLE_MS before it will call a turn finished. A test that means "and then the turn
 * really ended" has to sit through that window, which is what this does: one observation to
 * open the window, the clock moved past it, and one more to close the turn.
 */
async function settleTurn(harnessed: Harness): Promise<void> {
  stopGenerating(harnessed.document);
  harnessed.hook.observe();
  await settle();
  harnessed.advance(harnessed.hook.TURN_SETTLE_MS);
  harnessed.hook.observe();
  // A compaction turn ending starts a second, longer watch — the brief has to stop changing
  // and the app has to say it has nothing running — and that watch runs off the script's own
  // sleeps, which this harness makes instant while still advancing the clock. Draining them
  // is what makes this helper mean "the turn really ended" for the brief as well.
  await settle(800);
}

/** What is sitting in the composer right now. */
const composerText = (document: Document): string =>
  (document.querySelector('#prompt-textarea')?.textContent || '').trim();

/** Counts the sends the content script asked ChatGPT for. */
function watchSend(document: Document): () => number {
  let sends = 0;
  document.querySelector('[data-testid="send-button"]')!.addEventListener('click', () => {
    sends++;
  });
  return () => sends;
}

let nextSeq = 1;

function call(overrides: Partial<ActivityEntry> & { turnId: string }): ActivityEntry {
  const seq = overrides.seq ?? nextSeq++;
  return {
    seq,
    time: 1_700_000_000_000 + seq,
    tool: 'read_file',
    callId: `call-${seq}`,
    attribution: 'turn',
    outcome: 'ok',
    durationMs: 12,
    summary: { kind: 'read', tone: 'neutral', title: 'Read src/main/bridge.ts' },
    ...overrides
  };
}

/** Answers one scan with `rows` (and optional turn-level calls), as fiber.js would. */
async function replyFiber(
  rows: unknown[],
  turns: unknown[] = [],
  settled: Record<string, unknown> | null = null,
  restamp = true
): Promise<void> {
  const window = live!.window as any;
  // The harness makes every timeout instant so the script's own waits do not slow the
  // suite down. Here that would fire the scan's give-up timer before jsdom could
  // deliver the request, so this one case runs on real timers.
  const instant = window.setTimeout;
  window.setTimeout = (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms);
  const onAsk = (event: any) => {
    if (!event.data || event.data.source !== 'clf-fiber-ask') return;
    const scanToken = event.data.nonce;
    // Tests manually mark the exact DOM↔descriptor joins they intend. Upgrade those legacy
    // numeric fixtures to the shipped scan-token stamp at reply time, matching what fiber.js
    // does synchronously before it posts the descriptor frame.
    for (const selector of ['[data-clf-fiber]', '[data-clf-fiber-turn]']) {
      for (const node of window.document.querySelectorAll(selector)) {
        const attr = selector === '[data-clf-fiber]' ? 'data-clf-fiber' : 'data-clf-fiber-turn';
        const value = node.getAttribute(attr);
        if (!restamp || !value) continue;
        const split = value.lastIndexOf(':');
        const rawIndex = split >= 0 ? value.slice(split + 1) : value;
        if (!/^\d+$/.test(rawIndex)) continue;
        node.setAttribute(attr, `${scanToken}:${Number(rawIndex)}`);
      }
    }
    const indexedTurns = turns.map((turn: any, index) =>
      turn && typeof turn === 'object' && Number.isInteger(turn.index) ? turn : { ...(turn as Record<string, unknown>), index }
    );
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: { source: 'clf-fiber-reply', nonce: event.data.nonce, scanToken, v: 10, scanOk: true, rows, turns: indexedTurns },
        source: window
      })
    );
  };
  window.addEventListener('message', onAsk);
  try {
    await live!.hook.refreshFiber(settled);
  } finally {
    window.removeEventListener('message', onAsk);
    window.setTimeout = instant;
  }
}

/**
 * The visible text of each tool block in a turn, in DOM order, minus the parts that are
 * not the label.
 *
 * The clock reading is stripped because it is a real local time formatted in the runner's
 * locale, so asserting on it would be asserting on the machine. The folded-call list is
 * stripped because it belongs to the rows *inside* this one; the tests that care about it
 * read it directly.
 */
function labels(section: HTMLElement): string[] {
  return [...section.querySelectorAll('.pointer-events-none.contents')].map((block) => {
    const copy = block.cloneNode(true) as HTMLElement;
    for (const node of copy.querySelectorAll('.clf-when, .clf-fold-list')) node.remove();
    return (copy.textContent || '').replace(/\s+/g, ' ').trim();
  });
}

// ------------------------------------------------------------------- tests

describe('matching recorded calls to ChatGPT tool blocks', () => {
  it('relabels the blocks it is sure about instead of giving up on the whole turn', async () => {
    const plan = (blocks: Array<[string | null, string]>, calls: ActivityEntry[]) =>
      live!.hook.planLabels(
        blocks.map(([callId, original]) => ({ callId, original })),
        calls
      );
    live = await harness();

    // Two of ours and one ChatGPT named itself. The old rule required the counts to match
    // exactly, so this turn kept three identical "Called tool" rows forever.
    const calls = [call({ turnId: 't1' }), call({ turnId: 't1' })];
    const result = plan(
      [
        [null, 'Called tool'],
        [null, 'Searched the web'],
        [null, 'Called tool']
      ],
      calls
    );
    expect(result).toEqual([
      [0, calls[0], []],
      [2, calls[1], []]
    ]);
  });

  it('pairs blocks and calls one for one when the counts agree', async () => {
    live = await harness();
    const calls = [call({ turnId: 't1' }), call({ turnId: 't1' })];
    expect(
      live.hook.planLabels(
        [
          { callId: null, original: 'Called tool' },
          { callId: null, original: 'Called tool' }
        ],
        calls
      )
    ).toEqual([
      [0, calls[0], []],
      [1, calls[1], []]
    ]);
  });

  it('leaves a genuinely ambiguous turn alone', async () => {
    live = await harness();
    // Two unlabelled blocks ChatGPT named differently, one recorded call: there is no
    // evidence which of them it was, and a wrong label is worse than none.
    expect(
      live.hook.planLabels(
        [
          { callId: null, original: 'Searched the web' },
          { callId: null, original: 'Ran a canvas action' }
        ],
        [call({ turnId: 't1' })]
      )
    ).toEqual([]);
  });

  it('never moves a label from the block it is already on', async () => {
    live = await harness();
    const first = call({ turnId: 't1', callId: 'call-a' });
    const second = call({ turnId: 't1', callId: 'call-b' });
    const result = live.hook.planLabels(
      [
        { callId: 'call-a', original: 'Called tool' },
        { callId: null, original: 'Called tool' }
      ],
      [first, second]
    );
    expect(result).toEqual([
      [0, first, []],
      [1, second, []]
    ]);
  });

  it('keeps a block whose call has scrolled out of the feed rather than reassigning it', async () => {
    live = await harness();
    const fresh = call({ turnId: 't1', callId: 'call-new' });
    expect(
      live.hook.planLabels(
        [
          { callId: 'call-forgotten', original: 'Called tool' },
          { callId: null, original: 'Called tool' }
        ],
        [fresh]
      )
    ).toEqual([[1, fresh, []]]);
  });
});

/**
 * ChatGPT folds a run of calls to the same tool into a single row — observed live as
 * "4 earlier tool calls hidden" over a `collapsedSameToolCallCount: 4`, so five calls
 * behind one row. Every rule above used to count a row as one call, which meant that on
 * any turn where something was collapsed the even-count fast path fired against
 * mismatched sets and put confidently wrong labels on real calls.
 */
describe('a tool row that stands for several calls', () => {
  const five = (): ActivityEntry[] =>
    [0, 1, 2, 3, 4].map((n) =>
      call({ turnId: 't1', callId: `call-${n}`, seq: n, summary: { kind: 'agent', tone: 'neutral', title: `Step ${n}` } })
    );

  it('gives the row the last call of its group, not the first', async () => {
    live = await harness();
    const calls = five();
    expect(live.hook.planLabels([{ callId: null, original: 'Called tool', hidden: 4 }], calls)).toEqual([
      [0, calls[4], calls.slice(0, 4)]
    ]);
  });

  it('counts a folded row as the calls it hides when sizing the turn', async () => {
    live = await harness();
    const calls = five();
    // One row hiding two, then two ordinary rows: 3 + 1 + 1 = 5 calls across 3 rows.
    expect(
      live.hook.planLabels(
        [
          { callId: null, original: 'Called tool', hidden: 2 },
          { callId: null, original: 'Called tool' },
          { callId: null, original: 'Called tool' }
        ],
        calls
      )
    ).toEqual([
      [0, calls[2], calls.slice(0, 2)],
      [1, calls[3], []],
      [2, calls[4], []]
    ]);
  });

  it('does not mislabel when the old one-row-one-call rule would have matched', async () => {
    live = await harness();
    const calls = five();
    // Five rows, five calls — but the first row hides four, so this turn really shows
    // eight calls and only five are known. The old rule paired them off regardless.
    const plan = live.hook.planLabels(
      [
        { callId: null, original: 'Called tool', hidden: 4 },
        { callId: null, original: 'Called tool' },
        { callId: null, original: 'Called tool' },
        { callId: null, original: 'Called tool' },
        { callId: null, original: 'Called tool' }
      ],
      calls
    );
    // The fast path must not fire (5 rows span 9 calls, not 5), and the fallback must not
    // spend the fold count either: nothing here says the four calls this row folded away
    // are the four sitting in front of it in the recorder's list rather than four the
    // recorder never saw. It used to assume they were, and hand the row call five.
    expect(plan).toEqual([]);
  });

  /**
   * Failing closed on the fold count is not the same as giving up on the turn, and it is
   * emphatically not the same as making the row generic: the row still carries the name
   * the page's own descriptor gave it, which is evidence about that row alone. What stops
   * is the *arithmetic* — every row after a fold is at an unknown offset.
   */
  it('labels what it can before a folded row and stops there', async () => {
    live = await harness();
    // Three rows standing for five calls, four of them recorded. The fold count fits
    // arithmetically — 1 + 3 lands exactly on the four — which is precisely the trap: it
    // fits any four calls, and it used to hand the second row the last of them.
    const calls = five().slice(0, 4);
    expect(
      live.hook.planLabels(
        [
          { callId: null, original: 'Called tool' },
          { callId: null, original: 'Called tool', hidden: 2 },
          { callId: null, original: 'Called tool' }
        ],
        calls
      )
    ).toEqual([[0, calls[0], []]]);
  });

  it('keeps a bound folded row bound, along with the calls behind it', async () => {
    live = await harness();
    const calls = five();
    expect(
      live.hook.planLabels(
        [
          { callId: 'call-2', original: 'Called tool', hidden: 2 },
          { callId: null, original: 'Called tool' },
          { callId: null, original: 'Called tool' }
        ],
        calls
      )
    ).toEqual([
      [0, calls[2], calls.slice(0, 2)],
      [1, calls[3], []],
      [2, calls[4], []]
    ]);
  });

  it('treats a missing or nonsense fold count as no folding at all', async () => {
    live = await harness();
    const calls = [call({ turnId: 't1', callId: 'a' })];
    for (const hidden of [undefined, 0, -3, 1.5, '4', null]) {
      expect(
        live.hook.planLabels([{ callId: null, original: 'Called tool', hidden } as never], calls)
      ).toEqual([[0, calls[0], []]]);
    }
  });
});

/**
 * Every rule in planLabels is an argument from position, and position is what goes wrong
 * when the recorder's view of a turn and the page's view of it are not the same set of
 * calls. The row's own Fiber descriptor is the one piece of evidence that is about *that
 * row* and nothing else, so it gets a veto over all of them.
 *
 * Both fixtures here were taken from live chats on 2026-08-16, where in each case the
 * single bound row on the page was wearing another call's name: a row whose descriptor
 * said `screenshot` labelled with a recorded `list_windows`, and a row whose descriptor
 * said `run_powershell` labelled with a recorded `computer`. Both were produced by rules
 * that "fit" — the counts came out even, so the pairing looked proven.
 */
describe('a row refusing a call the page says it did not make', () => {
  const named = (tool: string, title: string) =>
    call({ turnId: 't1', tool, summary: { kind: 'agent', tone: 'neutral', title } });

  it('refuses the pairing when the descriptor names a different tool', async () => {
    live = await harness();
    // The live row 9 case: one row, one recorded call, the counts could not fit better.
    const calls = [named('computer', 'Focused a window and 1 more')];
    expect(
      live.hook.planLabels([{ callId: null, original: 'Called tool', tool: 'run_powershell' }], calls)
    ).toEqual([]);
  });

  it('pairs exactly as before when the descriptor agrees', async () => {
    live = await harness();
    const calls = [named('run_powershell', 'Ran a script')];
    expect(
      live.hook.planLabels([{ callId: null, original: 'Called tool', tool: 'run_powershell' }], calls)
    ).toEqual([[0, calls[0], []]]);
  });

  it('says nothing either way when the page did not name the row', async () => {
    live = await harness();
    const calls = [named('computer', 'Clicked something')];
    for (const tool of [undefined, null]) {
      expect(
        live.hook.planLabels([{ callId: null, original: 'Called tool', tool }], calls)
      ).toEqual([[0, calls[0], []]]);
    }
  });

  it('abandons the whole even pairing when one row contradicts it', async () => {
    live = await harness();
    // Two rows, two calls, in order — the strongest signal this file has. One descriptor
    // disagreeing means these are not the same two calls, so the other pair is worth no
    // more than this one. The contradiction is on the first row, so nothing downstream
    // can label it either: if the even pairing had fired, both rows would be named.
    const calls = [named('read_file', 'Read a.ts'), named('computer', 'Clicked something')];
    expect(
      live.hook.planLabels(
        [
          { callId: null, original: 'Called tool', tool: 'screenshot' },
          { callId: null, original: 'Called tool', tool: 'computer' }
        ],
        calls
      )
    ).toEqual([]);
  });

  it('stops the generic run at the first row the page contradicts', async () => {
    live = await harness();
    // Three rows and four calls, so the counts do not fit and the weakest rule is reached.
    // It walks in order, which means one wrong row puts every later row at an unknown
    // offset — so it ends the run rather than skipping the entry.
    const calls = [
      named('read_file', 'Read a.ts'),
      named('screenshot', 'Took a picture'),
      named('computer', 'Clicked something'),
      named('read_file', 'Read b.ts')
    ];
    expect(
      live.hook.planLabels(
        [
          { callId: null, original: 'Called tool', tool: 'read_file' },
          { callId: null, original: 'Called tool', tool: 'list_windows' },
          { callId: null, original: 'Called tool', tool: 'computer' }
        ],
        calls
      )
    ).toEqual([[0, calls[0], []]]);
  });

  /**
   * "Never move a label" exists so labels do not shuffle between repaints. It is not a
   * reason to let a label the page has since contradicted stay on a row: the first paint
   * can happen before any descriptor has arrived, which is exactly how the live rows got
   * their wrong names.
   */
  it('takes back a bound label the page contradicts, and re-lands both calls', async () => {
    live = await harness();
    const first = call({
      turnId: 't1',
      callId: 'call-b',
      seq: 1,
      tool: 'computer',
      summary: { kind: 'agent', tone: 'neutral', title: 'Clicked something' }
    });
    const second = call({
      turnId: 't1',
      callId: 'call-a',
      seq: 2,
      tool: 'run_powershell',
      summary: { kind: 'agent', tone: 'neutral', title: 'Ran a script' }
    });
    const plan = live.hook.planLabels(
      [
        { callId: 'call-a', original: 'Called tool', tool: 'computer' },
        { callId: null, original: 'Called tool', tool: 'run_powershell' }
      ],
      [first, second]
    );
    // A null call is the instruction to take the label off. The call it was wearing goes
    // back into the pool unconsumed, and both rows then land on the call they name.
    expect(plan).toEqual([
      [0, null, []],
      [0, first, []],
      [1, second, []]
    ]);
  });
});

/**
 * Which agent ran which tool.
 *
 * A run with a prime and two workers puts three streams of calls into one chat. The rows
 * said three tools ran and nothing about who ran them, so a worker's failed command read
 * as the prime's. The app attributes this itself, having run the call, which is why it can
 * be shown flatly rather than hedged the way page-sourced evidence has to be.
 */
describe('naming the agent behind a row', () => {
  async function turnOf(entries: ActivityEntry[]): Promise<HTMLElement> {
    // Relabelling a row is presentation, so it lives behind the same switch as the stream
    // and a test that wants it has to ask. See renderingOn().
    renderingOn();
    const section = assistantTurn(
      live!.document,
      'turn-1',
      entries.map(() => 'Called tool')
    );
    live!.reply.set('activity', () => ({
      ok: true,
      data: {
        entries,
        job: null
      }
    }));
    await live!.hook.pullActivity();
    await settle();
    return section;
  }

  it('puts the agent in front of what it did', async () => {
    live = await harness();
    const section = await turnOf([
      call({ turnId: 'turn-1', seq: 1, agent: 'prime', summary: { kind: 'read', tone: 'neutral', title: 'Read a.ts' } }),
      call({
        turnId: 'turn-1',
        seq: 2,
        agent: 'worker-1',
        outcome: 'error',
        summary: { kind: 'run', tone: 'bad', title: 'Command failed' }
      })
    ]);
    expect(labels(section)).toEqual(['primeRead a.ts', 'worker-1Command failed']);
    expect(section.querySelectorAll('.clf-tool-icon svg')).toHaveLength(2);
    expect([...section.querySelectorAll('[data-clf-agent]')].map((node) => node.getAttribute('data-clf-agent'))).toEqual(
      ['prime', 'worker-1']
    );
  });

  it('says nothing in a chat that has no agents', async () => {
    live = await harness();
    const section = await turnOf([
      call({ turnId: 'turn-1', seq: 1, summary: { kind: 'read', tone: 'neutral', title: 'Read a.ts' } })
    ]);
    expect(labels(section)).toEqual(['Read a.ts']);
    expect(section.querySelectorAll('.clf-tool-icon svg')).toHaveLength(1);
    expect(section.querySelector('.clf-agent')).toBeNull();
  });

  /** An id long enough to push the tool's own name off the row would hide the row's point. */
  it('ignores an agent id that is not one', async () => {
    live = await harness();
    for (const agent of ['', '   ', 'w'.repeat(41), 42 as never, null]) {
      const section = await turnOf([
        call({ turnId: 'turn-1', seq: 1, agent, summary: { kind: 'read', tone: 'neutral', title: 'Read a.ts' } })
      ]);
      expect(section.querySelector('.clf-agent'), String(agent)).toBeNull();
      section.remove();
    }
  });

  /**
   * ChatGPT collapses a run of rows by *tool name*, which says nothing about who called
   * it — so one folded row can hide two agents' work behind a third agent's label. That
   * makes the folded list the place where mixing them up is easiest and worst.
   */
  it('names the agent on each call a row folded away', async () => {
    live = await harness();
    renderingOn();
    const section = assistantTurn(live.document, 'turn-1', ['Called tool!']);
    section.querySelector('[aria-label="Open tool call list"]')!.setAttribute('data-clf-fiber', '0');
    // The recorded tool matches the one the row's descriptor names below, as it does for a
    // row that really is these calls — a row only takes a call it does not contradict.
    const entries = ['prime', 'worker-1', 'worker-2'].map((agent, n) =>
      call({
        turnId: 'turn-1',
        seq: n + 1,
        agent,
        tool: 'run_command',
        summary: { kind: 'run', tone: 'neutral', title: `Step ${n}` }
      })
    );
    live.reply.set('activity', () => ({
      ok: true,
      data: {
        entries,
        job: null
      }
    }));
    await replyFiber([
      {
        v: 10,
        index: 0,
        tool: 'run_command',
        path: null,
        app: null,
        resource: null,
        messageId: null,
        turnId: 'turn-1',
        conversationId: null,
        createTime: null,
        hidden: 2,
        answered: true
      }
    ]);
    await live.hook.pullActivity();
    await settle();

    expect(labels(section)).toEqual(['worker-2Step 2+2']);
    expect(section.querySelectorAll('.clf-tool-icon svg')).toHaveLength(1);
    expect([...section.querySelectorAll('.clf-fold-list .clf-agent')].map((node) => node.textContent)).toEqual([
      'prime',
      'worker-1'
    ]);
  });
});

/**
 * One transcript, not a transcript plus a shadow log.
 *
 * The appended "Local timeline" block existed because relabelling was unreliable, and it
 * restated rows that were already on the page a few pixels above it. Its other half was
 * ChatGPT's own progress captions, which `progressLine()` reads straight out of the
 * reasoning box the page is already showing — so both halves were duplication.
 *
 * The calls that genuinely had nowhere to appear are the ones ChatGPT collapsed into a
 * neighbouring row. Those go inside the row that swallowed them.
 */
describe('the calls a row folded away', () => {
  const FOLDED = {
    v: 10,
    index: 0,
    tool: 'run_command',
    path: '/TobisComputer/mcp/run_command',
    app: 'TobisComputer',
    resource: null,
    messageId: 'msg-1',
    turnId: 'turn-1',
    conversationId: 'conv-1',
    createTime: 1_700_000_000,
    hidden: 4,
    localCount: 5,
    answered: true
  };

  /** A turn of one row that stands for five recorded calls. */
  async function foldedTurn(): Promise<HTMLElement> {
    renderingOn();
    const section = assistantTurn(live!.document, 'turn-1', ['Called tool!']);
    section.querySelector('[aria-label="Open tool call list"]')!.setAttribute('data-clf-fiber', '0');
    const calls = [0, 1, 2, 3, 4].map((n) =>
      call({
        turnId: 'turn-1',
        callId: `call-${n}`,
        seq: n + 1,
        tool: 'run_command',
        summary: { kind: 'run', tone: 'neutral', title: `Step ${n}`, metric: n === 0 ? '3 lines' : '' }
      })
    );
    live!.reply.set('activity', () => ({
      ok: true,
      data: {
        entries: calls,
        job: null
      }
    }));
    await replyFiber([FOLDED]);
    await live!.hook.pullActivity();
    await settle();
    return section;
  }

  it('never appends a second transcript to the turn', async () => {
    live = await harness();
    const section = await foldedTurn();
    expect(section.querySelector('.clf-timeline')).toBeNull();
    expect((section.textContent || '')).not.toContain('Local timeline');
  });

  it('puts them under the row that hides them, closed until asked', async () => {
    live = await harness();
    const section = await foldedTurn();
    expect(labels(section)).toEqual(['Step 4+4']);
    expect(section.querySelectorAll('.clf-tool-icon svg')).toHaveLength(1);

    const list = section.querySelector('.clf-fold-list') as HTMLElement;
    expect(list.hasAttribute('hidden')).toBe(true);
    expect([...list.querySelectorAll('.clf-label')].map((node) => node.textContent)).toEqual([
      'Step 0',
      'Step 1',
      'Step 2',
      'Step 3'
    ]);
    // The row's own metric belongs to the row; a folded call keeps its own.
    expect(list.querySelector('.clf-metric')!.textContent).toBe('3 lines');
  });

  /**
   * The chip sits inside ChatGPT's own header button, so an unhandled click would open
   * the row's card as well — two things from one press, neither of them asked for.
   */
  it('opens and closes them without also working ChatGPT’s own control', async () => {
    live = await harness();
    const section = await foldedTurn();
    const chip = section.querySelector('.clf-folded') as HTMLElement;
    const list = section.querySelector('.clf-fold-list') as HTMLElement;
    const header = section.querySelector('button') as HTMLElement;

    let reached = 0;
    header.addEventListener('click', () => {
      reached++;
    });

    const press = () =>
      chip.dispatchEvent(new live!.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    press();
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    expect(list.hasAttribute('hidden')).toBe(false);

    press();
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(list.hasAttribute('hidden')).toBe(true);
    expect(reached).toBe(0);
  });

  it('leaves it open across a repaint', async () => {
    live = await harness();
    const section = await foldedTurn();
    const chip = section.querySelector('.clf-folded') as HTMLElement;
    chip.dispatchEvent(new live.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    await live.hook.pullActivity();
    await settle();
    expect((section.querySelector('.clf-folded') as HTMLElement).getAttribute('aria-expanded')).toBe('true');
    expect((section.querySelector('.clf-fold-list') as HTMLElement).hasAttribute('hidden')).toBe(false);
  });

  /** Hidden by default; the popup switch restores it for debugging. */
  it('gives every relabelled row the time the app ran the call when enabled', async () => {
    live = await harness();
    live.hook.setShowTimes(true);
    const section = await foldedTurn();
    const when = section.querySelector('.clf-when') as HTMLElement;
    expect(when.textContent).toBe(new Date(1_700_000_000_005).toLocaleTimeString());
    expect([...section.querySelectorAll('.clf-fold-list .clf-time')].map((node) => node.textContent)).toEqual(
      [1, 2, 3, 4].map((n) => new Date(1_700_000_000_000 + n).toLocaleTimeString())
    );
  });
});

describe('page-native tool presentation and archived row evidence', () => {
  /**
   * Measured live on 2026-08-17: sampling the page every 400ms caught the moment ChatGPT
   * replaces a settling reasoning row, with the outgoing and incoming node both on screen
   * holding `Read README and provided intermediate updates`. Identity taken from the row
   * recorded that step twice, once per node.
   */
  /**
   * The other half of the same measurement: React does not keep these rows, so the stamp on
   * a destroyed row is freed and the *next* step's row claims it. A genuinely new step then
   * arrived under the previous step's id and overwrote it.
   */
  /**
   * The live 1.7.1 failure, from the other end. `isConnectorBlock` reads a control ChatGPT
   * removes on re-render, so Fiber is what keeps a row classified as ours. While that test
   * still spelled the single pre-1.7.1 connector name, a row belonging to the renamed
   * connector failed it — and a local call was then recorded a second time as ChatGPT's own
   * page-native activity, which is what put `ChatGPT: Inspected repository…` into the
   * desktop timeline as if the assistant had said it.
   */
  it('restores stock ChatGPT presentation when Overwrite is explicitly switched off', async () => {
    // Production now defaults Overwrite ON. The harness deliberately starts presentation
    // disabled so capture-only tests stay isolated; this case pins the user-facing OFF path:
    // a row the app *could* name, with a matching recorded call, is still left saying exactly
    // what ChatGPT wrote. Invisible capture stamps are allowed through and deliberately not
    // asserted against: they are how the recorder keeps a row's identity across rewrites.
    live = await harness();
    live.hook.setRenderStream(false);
    const section = assistantTurn(live.document, 'turn-untouched', ['Called tool!']);
    const row = section.querySelector('.pointer-events-none.contents') as HTMLElement;
    const label = row.querySelector('.text-start') as HTMLElement;
    const said = label.textContent;
    live.reply.set('activity', () => ({
      ok: true,
      data: {
        entries: [call({ turnId: 'turn-untouched', callId: 'call-visible' })],
        job: null
      }
    }));
    startGenerating(live.document);
    live.hook.observe();
    await live.hook.pullActivity();
    await settle();
    live.hook.renderStreams();
    live.hook.paint();

    expect(label.textContent).toBe(said);
    expect(label.getAttribute('title')).toBeNull();
    expect(label.classList.contains('clf-tool-title')).toBe(false);
    expect(row.className).toBe('pointer-events-none contents');
    expect(row.dataset['clfCall']).toBeUndefined();
    expect(row.dataset['clfPage']).toBeUndefined();
    expect(live.document.querySelectorAll('.clf-stream')).toHaveLength(0);
    expect(live.document.querySelectorAll('.clf-tool, .clf-page')).toHaveLength(0);
    expect(section.querySelectorAll('[data-clf-native-hidden]')).toHaveLength(0);
    // Nothing of ours inserted into the row either — no icon, no duration, no agent chip.
    expect(row.querySelectorAll('[class^="clf-"], [class*=" clf-"]')).toHaveLength(0);
  });

  it('takes its own labels back off the page when the renderer is switched off', async () => {
    // The disabled path runs the restore rather than skipping the loop. Without that, a
    // switch flipped mid-session would leave this app's names frozen over ChatGPT's for the
    // life of the tab — the page would keep asserting a record nobody is maintaining.
    live = await harness();
    const section = assistantTurn(live.document, 'turn-restored', ['Called tool!']);
    const row = section.querySelector('.pointer-events-none.contents') as HTMLElement;
    const label = row.querySelector('.text-start') as HTMLElement;
    const said = label.textContent;
    live.reply.set('activity', () => ({
      ok: true,
      data: {
        entries: [call({ turnId: 'turn-restored', callId: 'call-restored' })],
        job: null
      }
    }));
    renderingOn();
    await live.hook.pullActivity();
    await settle();
    live.hook.paint();
    expect(label.textContent).not.toBe(said);
    expect(row.classList.contains('clf-tool')).toBe(true);

    live.hook.setRenderStream(false);
    live.hook.paint();

    expect(label.textContent).toBe(said);
    expect(label.classList.contains('clf-tool-title')).toBe(false);
    expect(row.classList.contains('clf-tool')).toBe(false);
    expect(row.dataset['clfCall']).toBeUndefined();
  });

  it('does not close a bound conversation when ChatGPT temporarily loses its route id', async () => {
    const chat = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    live = await harness(`https://chatgpt.com/c/${chat}`);
    live.hook.observe();
    await settle();
    live.sent.splice(0);

    // React/router churn can briefly leave the document without a /c/<id> even though the
    // tab and conversation are still alive. That absence must never become a lifecycle
    // event: background.js owns real tab closure via chrome.tabs.onRemoved.
    live.window.history.replaceState({}, '', '/');
    live.hook.observe();
    await settle();
    expect(live.sent.filter((message) => message.type === 'closed')).toEqual([]);

    // When the same route comes back, it is still the same bound conversation.
    live.window.history.replaceState({}, '', `/c/${chat}`);
    live.hook.observe();
    await settle();
    expect(live.sent.filter((message) => message.type === 'closed')).toEqual([]);
  });

  it('does not file a fresh composer’s first turn into the chat whose route just disappeared', async () => {
    const first = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const second = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    live = await harness(`https://chatgpt.com/c/${first}`);
    userTurn(live.document, 'turn-a1', 'question in chat A');
    live.hook.observe();
    await settle();

    // The real failure window: React has already replaced A with the fresh composer/turn,
    // but ChatGPT has not assigned /c/B yet. The old code kept `conversationId === A` here
    // and durably emitted B's user message, generation, Fiber prose/activity and request-id
    // evidence as A.
    live.document.querySelector('[data-turn-id="turn-a1"]')!.remove();
    live.dom.reconfigure({ url: 'https://chatgpt.com/' });
    userTurn(live.document, 'turn-b1', 'question in chat B');
    startGenerating(live.document);
    assistantTurn(live.document, 'page-turn-b', []);
    live.hook.observe();
    await settle();
    await replyFiber([], [{
      turnId: 'page-turn-b',
      conversationId: second,
      calls: [{
        messageId: 'fiber-call-b',
        tool: 'read_file',
        order: 0,
        answered: false,
        requestId: 'wfr-chat-b'
      }],
      messages: [{
        messageId: 'site-message-b',
        stable: true,
        rawText: 'working in chat B',
        renderedHtml: '<p>working in chat B</p>'
      }],
      activities: [{ messageId: 'thought-b-0', label: 'Inspecting chat B' }]
    }]);
    await live.hook.flush();
    await settle();

    expect(emitted(live.sent, 'user_message').map((entry) => [entry.conversationId, entry.event.text])).toEqual([
      [first, 'question in chat A']
    ]);
    expect(emitted(live.sent, 'turn_start')).toEqual([]);
    expect(emitted(live.sent, 'assistant_message')).toEqual([]);
    expect(emitted(live.sent, 'page_tool')).toEqual([]);
    expect(emitted(live.sent, 'tool_evidence')).toEqual([]);

    // Once the page supplies a concrete identity, A is retired first and the exact same DOM
    // is now safe to observe as B. Nothing is guessed from elapsed time or tail position.
    live.dom.reconfigure({ url: `https://chatgpt.com/c/${second}` });
    live.hook.observe();
    await settle();
    await replyFiber([], [{
      turnId: 'page-turn-b',
      conversationId: second,
      calls: [{
        messageId: 'fiber-call-b',
        tool: 'read_file',
        order: 0,
        answered: false,
        requestId: 'wfr-chat-b'
      }],
      messages: [{
        messageId: 'site-message-b',
        stable: true,
        rawText: 'working in chat B',
        renderedHtml: '<p>working in chat B</p>'
      }],
      activities: [{ messageId: 'thought-b-0', label: 'Inspecting chat B' }]
    }]);
    await live.hook.flush();
    await settle();

    expect(emitted(live.sent, 'user_message').map((entry) => [entry.conversationId, entry.event.text])).toEqual([
      [first, 'question in chat A'],
      [second, 'question in chat B']
    ]);
    for (const kind of ['turn_start', 'assistant_message', 'page_tool', 'tool_evidence']) {
      const entries = emitted(live.sent, kind);
      expect(entries.length, kind).toBeGreaterThan(0);
      expect(entries.every((entry) => entry.conversationId === second), kind).toBe(true);
    }
  });

  it('does close the old conversation when a different concrete chat replaces it', async () => {
    const first = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const second = '11111111-2222-3333-4444-555555555555';
    live = await harness(`https://chatgpt.com/c/${first}`);
    live.hook.observe();
    await settle();
    live.sent.splice(0);

    live.window.history.replaceState({}, '', `/c/${second}`);
    live.hook.observe();
    await settle();
    expect(live.sent.filter((message) => message.type === 'closed')).toEqual([
      { type: 'closed', conversationId: first, navigationEpoch: expect.any(Number) }
    ]);
  });

  /**
   * The turn that began and ended between two ticks.
   *
   * This is the race that made the poll unusable on its own. The app now answers a tool
   * call without waiting to work out where it came from, so a quick read can be answered,
   * consumed and the whole reply finished inside one observe interval. A page that only
   * looked once a second would find nothing generating and report nothing, and the chat's
   * own call would be recorded as if it had come from another device.
   */
});

/** Every observation of one kind the content script has sent, in order. */
function emitted(sent: Array<Record<string, any>>, kind: string): Array<Record<string, any>> {
  return sent
    .filter((message) => message.type === 'events')
    .flatMap((message) => (message.entries ?? []) as Array<Record<string, any>>)
    .filter((entry) => entry.event?.kind === kind);
}

/** One error banner, in the shape ChatGPT renders a toast. */
function alertBanner(document: Document, text: string): HTMLElement {
  const node = document.createElement('div');
  node.setAttribute('role', 'alert');
  node.textContent = text;
  document.body.append(node);
  return node;
}

/**
 * Moving between chats in a single-page app.
 *
 * ChatGPT changes `/c/<id>` and replaces the transcript as two separate steps, and there
 * is no promise about which comes first. The content script cannot wait a fixed time for
 * the DOM to catch up — a guess that is too short files the old chat into the new one and
 * a guess that is too long drops the new chat's opening message — so what it does instead
 * is prove which sections it was already watching before the URL moved.
 */
describe('recording authored message text', () => {
  it('reports ChatGPT’s generated document title as conversation metadata and ignores the generic shell title', async () => {
    live = await harness();
    live.document.title = 'Fix Local Files Reconstruction | ChatGPT';
    live.hook.observe();
    await settle();
    expect(emitted(live.sent, 'conversation_title').map((entry) => entry.event.text)).toEqual([
      'Fix Local Files Reconstruction'
    ]);

    live.document.title = 'ChatGPT';
    live.hook.observe();
    await settle();
    expect(emitted(live.sent, 'conversation_title')).toHaveLength(1);
  });

  it('does not persist Show more / Show less controls as part of a user message', async () => {
    live = await harness();
    const section = userTurn(live.document, 'turn-user-chrome', 'the exact authored message');
    const message = section.querySelector('[data-message-id]')!;
    for (const label of ['Show more', 'Show less']) {
      const button = live.document.createElement('button');
      button.textContent = label;
      message.append(button);
    }

    live.hook.observe();
    await settle();

    const messages = emitted(live.sent, 'user_message');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.event.text).toBe('the exact authored message');
  });

  /**
   * A turn that streamed commentary and called tools but never produced authored prose.
   *
   * The preferred path reads `.markdown`, which excludes commentary by construction. The
   * whole-node fallback did not: it stripped our own surfaces, ChatGPT's controls and the
   * tool rows, and then returned everything else — including the `[data-interrupted]`
   * commentary. So a turn with no answer at all promoted its own thinking-out-loud to
   * `assistant_message` with `final: true`, which is a completed turn as far as every
   * reader downstream is concerned. Recovery then treats the turn as answered, and the
   * text it "answered" with is a caption the user watched scroll past.
   */
  /**
   * The double transcription: one answer recorded twice, the first copy a truncated prefix
   * of the second.
   *
   * The stop button is not a statement that the answer is finished. ChatGPT unmounts it
   * between phases and across rerenders, so the page reports "not generating" in the middle
   * of a turn that is still being written — which is why a turn is not closed until the
   * button has stayed gone for a settle window.
   *
   * The guard that was supposed to cover that window asked whether the section had changed
   * since the previous observation. A live answer is momentarily unchanged between render
   * frames, so a flicker that landed on a still frame answered "settled", and the prefix on
   * screen at that instant was published as the final answer. The rest of the answer then
   * arrived as a second message under a different digest, and the session held both.
   */
  /**
   * The double transcription, from session 2026-08-18-6098b925: one answer recorded twice,
   * the first copy a frozen truncated prefix of the second, both in the same turn.
   *
   * The two families of streaming text are told apart by where they sit — prose is
   * `.markdown` outside a `[data-interrupted]` container, commentary is what is inside one
   * — and ChatGPT moves text across that line mid-answer, mounting the markdown first and
   * wrapping it a moment later. So the same words were reported under `#a0` and then under
   * `#p0`. The `#p0` chain revised itself correctly with every token; nothing could ever
   * revise `#a0`, because no later observation used that id again. The user's screen kept
   * "Yeah bro, I'll stay on the **current" above the finished paragraph, for good.
   */
  /**
   * Two different answers that ChatGPT gave the same id and that happen to be the same
   * length.
   *
   * Streaming assistant prose has no id of its own, so one is derived from the section's
   * turn id — and the page reuses those. After a content-script reload the map that would
   * make the derived id unique is empty, which is exactly when the whole visible transcript
   * is offered again. The occurrence key therefore has to separate them by *what they say*.
   * It used to be a 32-bit FNV hash plus the length; a collision there drops a real message
   * before the recorder ever sees it, and the log cannot be repaired from a message that
   * was never sent.
   */
});

describe('canonical Fiber transcript ingestion in 1.8', () => {
  it('records the first unstable assistant interim before any MCP request id exists', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'page-turn-first-interim', []);
    live.hook.observe();
    await settle();

    await replyFiber([], [{
      turnId: 'page-turn-first-interim',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calls: [],
      messages: [{
        messageId: 'assistant-first-interim-raw-id',
        rawMessageId: 'assistant-first-interim-raw-id',
        role: 'assistant',
        stable: false,
        createTime: 1_787_165_100_125,
        rawText: 'Starting with the first visible interim.',
        renderedHtml: '<p>Starting with the first visible interim.</p>'
      }],
      activities: []
    }]);
    await live.hook.flush();
    await settle();

    const first = emitted(live.sent, 'assistant_message').map((entry) => entry.event);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      messageId: 'assistant-first-interim-raw-id',
      text: 'Starting with the first visible interim.',
      state: 'streaming',
      final: false
    });
    expect(first[0]!.authoredTime).toBeUndefined();
    expect(first[0]!.time).toBeGreaterThanOrEqual(emitted(live.sent, 'turn_start').at(-1)!.event.time);
    expect(emitted(live.sent, 'tool_evidence')).toHaveLength(0);

    // Streaming growth under the same ChatGPT id is another revision of the same logical
    // transcript row, not a second interim.
    await replyFiber([], [{
      turnId: 'page-turn-first-interim',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calls: [],
      messages: [{
        messageId: 'assistant-first-interim-raw-id',
        rawMessageId: 'assistant-first-interim-raw-id',
        role: 'assistant',
        stable: false,
        createTime: 1_787_165_100_125,
        rawText: 'Starting with the first visible interim. Still working.',
        renderedHtml: '<p>Starting with the first visible interim. Still working.</p>'
      }],
      activities: []
    }]);
    await live.hook.flush();
    await settle();

    const revisions = emitted(live.sent, 'assistant_message').map((entry) => entry.event);
    expect(revisions).toHaveLength(2);
    expect(new Set(revisions.map((entry) => entry.messageId))).toEqual(new Set(['assistant-first-interim-raw-id']));
  });

  it('records a page-model user message even when the DOM has not exposed data-message-id yet', async () => {
    live = await harness();
    assistantTurn(live.document, 'page-turn-model-user', []);

    await replyFiber([], [{
      turnId: 'page-turn-model-user',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calls: [],
      messages: [{
        messageId: 'user-model-opening-id',
        rawMessageId: 'user-model-opening-id',
        role: 'user',
        stable: true,
        createTime: 1_787_165_090_500,
        rawText: 'opening prompt from the page model',
        renderedHtml: ''
      }],
      activities: []
    }]);
    await live.hook.flush();
    await settle();

    expect(emitted(live.sent, 'user_message').map((entry) => entry.event)).toContainEqual(
      expect.objectContaining({
        messageId: 'user-model-opening-id',
        text: 'opening prompt from the page model',
        time: 1_787_165_090_500,
        authoredTime: true
      })
    );
  });

  it('records exact historical transcript from a Fiber descriptor with no page turn id', async () => {
    live = await harness();
    await replyFiber([], [{
      turnId: null,
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calls: [],
      messages: [{
        messageId: 'assistant-idless-history',
        rawMessageId: 'assistant-idless-history',
        role: 'assistant',
        stable: true,
        createTime: 1_780_000_000_000,
        rawText: 'Historical answer from an id-less virtualized section.',
        renderedHtml: ''
      }],
      activities: []
    }]);
    await live.hook.flush();
    await settle();

    expect(emitted(live.sent, 'assistant_message').map((entry) => entry.event)).toContainEqual(
      expect.objectContaining({
        messageId: 'assistant-idless-history',
        text: 'Historical answer from an id-less virtualized section.',
        time: 1_780_000_000_000,
        authoredTime: true,
        turnId: undefined
      })
    );
  });

  it('publishes streaming and final revisions under one ChatGPT message id with rendered HTML', async () => {
    live = await harness();
    startGenerating(live.document);
    const section = assistantTurn(live.document, 'page-turn-canonical', []);
    const prose = live.document.createElement('div');
    prose.className = 'markdown';
    prose.textContent = 'I inspected';
    section.append(prose);
    live.hook.observe();
    await settle();

    await replyFiber([], [{
      turnId: 'page-turn-canonical',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calls: [],
      messages: [{
        messageId: 'msg-canonical-123',
        stable: true,
        rawText: 'I inspected',
        renderedHtml: '<p>I <strong>inspected</strong></p>'
      }]
    }]);
    await settle();
    await live.hook.flush();
    await settle();

    await settleTurn(live);
    await replyFiber([], [{
      turnId: 'page-turn-canonical',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      endMessageId: 'msg-canonical-123',
      calls: [],
      messages: [{
        messageId: 'msg-canonical-123',
        stable: true,
        rawText: 'I inspected the tree.',
        renderedHtml: '<p>I <strong>inspected</strong> the tree.</p><pre><code>ok</code></pre>'
      }]
    }]);
    await settle();
    await live.hook.flush();
    await settle();

    const messages = emitted(live.sent, 'assistant_message');
    expect(messages).toHaveLength(2);
    expect(messages.map((entry) => entry.event.messageId)).toEqual(['msg-canonical-123', 'msg-canonical-123']);
    expect(messages[0]!.event.state).toBe('streaming');
    expect(messages[1]!.event.state).toBe('final');
    expect(messages[1]!.event.renderedHtml).toContain('<strong>inspected</strong>');
    expect(messages[1]!.event.renderedHtml).toContain('<pre><code>ok</code></pre>');
  });

  it('does not publish the same Fiber snapshot twice', async () => {
    live = await harness();
    startGenerating(live.document);
    const section = assistantTurn(live.document, 'page-turn-repeat', []);
    const prose = live.document.createElement('div');
    prose.className = 'markdown';
    prose.textContent = 'Same';
    section.append(prose);
    live.hook.observe();
    await settle();
    const turn = {
      turnId: 'page-turn-repeat',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calls: [],
      messages: [{ messageId: 'msg-repeat', stable: true, rawText: 'Same', renderedHtml: '<p>Same</p>' }]
    };
    await replyFiber([], [turn]);
    await settle();
    await live.hook.flush();
    await settle();
    await replyFiber([], [turn]);
    await settle();
    await live.hook.flush();
    await settle();
    expect(emitted(live.sent, 'assistant_message')).toHaveLength(1);
  });

  it('re-publishes a canonical Fiber snapshot when exact local turn ownership becomes known later', async () => {
    live = await harness();
    // This section is already on screen before generation begins. Until ChatGPT visibly
    // changes it, generationTurn() correctly refuses to guess that it belongs to the new run.
    const section = assistantTurn(live.document, 'page-turn-late-owner', []);
    live.hook.observe();
    await settle();
    startGenerating(live.document);
    live.hook.observe();
    await settle();
    const opened = emitted(live.sent, 'turn_start')[0]!.event.turnId as string;

    const descriptor = {
      turnId: 'page-turn-late-owner',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calls: [{
        messageId: 'call-late-owner',
        tool: 'read_file',
        order: 0,
        answered: false,
        requestId: 'wfr-late-owner'
      }],
      messages: [{
        messageId: 'msg-late-owner',
        stable: true,
        rawText: 'Checking ownership.',
        renderedHtml: '<p>Checking ownership.</p>'
      }],
      activities: [{ messageId: 'thought-late-owner-0', label: 'Inspecting ownership' }]
    };
    await replyFiber([], [descriptor]);
    await live.hook.flush();
    await settle();
    expect(emitted(live.sent, 'assistant_message').at(-1)!.event).toMatchObject({
      turnId: undefined,
      state: 'streaming',
      final: false
    });
    expect(emitted(live.sent, 'page_tool').at(-1)!.event.turnId).toBeUndefined();
    expect(emitted(live.sent, 'tool_evidence').at(-1)!.event.turnId).toBeUndefined();

    // The page now proves that the pre-existing section is the one this generation is
    // writing into. The Fiber payload itself is byte-identical; only ownership improved.
    const authored = live.document.createElement('div');
    authored.className = 'markdown';
    authored.textContent = 'Checking ownership.';
    section.append(authored);
    live.hook.observe();
    await settle();
    await replyFiber([], [descriptor]);
    await live.hook.flush();
    await settle();

    expect(emitted(live.sent, 'assistant_message').at(-1)!.event.turnId).toBe(opened);
    expect(emitted(live.sent, 'page_tool').at(-1)!.event.turnId).toBe(opened);
    expect(emitted(live.sent, 'tool_evidence').at(-1)!.event.turnId).toBe(opened);
  });

  it('publishes one stable native activity id and revises only its label', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'page-turn-activity', []);
    live.hook.observe();
    await settle();

    const base = {
      turnId: 'page-turn-activity',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calls: [],
      messages: []
    };
    await replyFiber([], [{
      ...base,
      activities: [{ messageId: 'thought-activity-uuid-0', label: 'Inspecting the repository' }]
    }]);
    await settle();
    await live.hook.flush();
    await replyFiber([], [{
      ...base,
      activities: [{ messageId: 'thought-activity-uuid-0', label: 'Inspected the repository' }]
    }]);
    await settle();
    await live.hook.flush();

    const activity = emitted(live.sent, 'page_tool').map((entry) => entry.event);
    expect(activity.map((entry) => entry.messageId)).toEqual([
      'thought-activity-uuid-0',
      'thought-activity-uuid-0'
    ]);
    expect(activity.map((entry) => entry.text)).toEqual([
      'Inspecting the repository',
      'Inspected the repository'
    ]);
  });

  it('keeps ChatGPT model order when a thinking headline and interim prose arrive in one scan', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'page-turn-interleaved', []);
    live.hook.observe();
    await settle();

    await replyFiber([], [{
      turnId: 'page-turn-interleaved',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calls: [],
      messages: [{
        messageId: 'interim-public',
        rawMessageId: 'interim-public',
        stable: true,
        order: 3,
        rawText: 'I have the first result; now I am checking the next part.',
        renderedHtml: '<p>I have the first result; now I am checking the next part.</p>'
      }],
      activities: [{
        messageId: 'thought-before-interim',
        label: 'Inspected the first part',
        order: 1
      }]
    }]);
    await live.hook.flush();
    await settle();

    const ordered = live.sent
      .filter((message) => message.type === 'events')
      .flatMap((message) => (message.entries ?? []) as Array<Record<string, any>>)
      .map((entry) => entry.event as Record<string, any>)
      .filter((event) => event?.kind === 'page_tool' || event?.kind === 'assistant_message')
      .map((event) => [event.kind, event.text]);
    expect(ordered).toEqual([
      ['page_tool', 'Inspected the first part'],
      ['assistant_message', 'I have the first result; now I am checking the next part.']
    ]);
  });

  it('keeps interim public prose partial when a later public message ends the turn', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'page-turn-partial-final', []);
    live.hook.observe();
    await settle();

    await replyFiber([], [{
      turnId: 'page-turn-partial-final',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      endMessageId: 'final-public',
      calls: [],
      messages: [
        {
          messageId: 'interim-public',
          rawMessageId: 'interim-public',
          stable: true,
          order: 1,
          rawText: 'Interim explanation.',
          renderedHtml: '<p>Interim explanation.</p>'
        },
        {
          messageId: 'final-public',
          rawMessageId: 'final-public',
          stable: true,
          order: 3,
          rawText: 'Final answer.',
          renderedHtml: '<p>Final answer.</p>'
        }
      ],
      activities: []
    }]);
    await live.hook.flush();
    await settle();

    expect(emitted(live.sent, 'assistant_message').map((entry) => [entry.event.text, entry.event.state, entry.event.final])).toEqual([
      ['Interim explanation.', 'streaming', false],
      ['Final answer.', 'final', true]
    ]);
  });

  it('does not turn the last commentary into a final answer merely because an unknown turn stopped', async () => {
    live = await harness();
    startGenerating(live.document);
    const section = assistantTurn(live.document, 'page-turn-unknown-commentary', []);
    section.setAttribute('data-clf-fiber-turn', '0');
    live.hook.observe();
    await settle();
    const localTurn = emitted(live.sent, 'turn_start').at(-1)!.event.turnId as string;

    const descriptor = {
      turnId: 'page-turn-unknown-commentary',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      endMessageId: null,
      calls: [],
      messages: [{
        messageId: 'commentary-before-tools',
        rawMessageId: 'commentary-before-tools',
        stable: true,
        createTime: 1_699_999_986_000,
        rawText: 'I have the repro. I am checking the recorder next.',
        renderedHtml: '<p>I have the repro. I am checking the recorder next.</p>'
      }],
      activities: []
    };
    await replyFiber([], [descriptor]);
    await live.hook.flush();
    await settle();

    const first = emitted(live.sent, 'assistant_message').at(-1)!.event;
    expect(first).toMatchObject({ turnId: localTurn, state: 'streaming', final: false });
    // ChatGPT's server-authored clock can differ from the PC clock. A live message belongs to
    // the local turn that is happening now, so its display/ordering time may never be dragged
    // fourteen seconds before the turn merely because create_time is skewed.
    expect(first.time).toBeGreaterThanOrEqual(emitted(live.sent, 'turn_start').at(-1)!.event.time);

    // Exact live 2026-08-25 failure: Stop disappears with no Fiber end_turn, then the next user
    // message supplies the only hard boundary. The post-turn Fiber settle scan must not revise
    // the old commentary to final just because `generating` is now false.
    stopGenerating(live.document);
    live.hook.observe();
    await settle();
    userTurn(live.document, 'followup-after-unknown-commentary', 'look at that transcription');
    live.hook.observe();
    await settle();
    expect(emitted(live.sent, 'turn_end').at(-1)!.event).toMatchObject({ turnId: localTurn, outcome: 'unknown' });

    await replyFiber([], [descriptor], {
      pageTurnId: 'page-turn-unknown-commentary',
      localTurnId: localTurn,
      pageTurn: { id: 'page-turn-unknown-commentary', node: section, nodes: [section] }
    });
    await live.hook.flush();
    await settle();

    const revisions = emitted(live.sent, 'assistant_message')
      .map((entry) => entry.event)
      .filter((event) => event.messageId === 'commentary-before-tools');
    expect(revisions.length).toBeGreaterThan(0);
    expect(revisions.every((event) => event.state === 'streaming' && event.final === false)).toBe(true);
  });

  it('fails closed for native activity without a stable site id and for generic busy captions', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'page-turn-activity-closed', []);
    live.hook.observe();
    await settle();
    await replyFiber([], [{
      turnId: 'page-turn-activity-closed',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calls: [],
      messages: [],
      activities: [
        { label: 'Searched the web' },
        { messageId: 'thought-busy-0', label: 'Thinking' }
      ]
    }]);
    await settle();
    await live.hook.flush();
    expect(emitted(live.sent, 'page_tool')).toHaveLength(0);
  });
});

/**
 * Turns the synthetic renderer on for one test.
 *
 * Production ships enabled by default as of 1.7.4. The test harness still starts it off so
 * renderer side effects cannot contaminate capture/attribution fixtures that are testing a
 * different concern; renderer cases opt in explicitly here.
 */
function renderingOn(): void {
  live!.hook.setRenderStream(true);
}

/**
 * Gives one or more synthetic assistant sections the same ephemeral Fiber-turn stamp the
 * real MAIN-world helper writes, then feeds the stable website objects used for ownership.
 * The numeric index is test plumbing only; production never persists it as identity.
 */
async function bindFiberTurns(
  bindings: Array<{ section: HTMLElement; turn: Record<string, unknown> }>
): Promise<void> {
  bindings.forEach(({ section }, index) => section.setAttribute('data-clf-fiber-turn', String(index)));
  await replyFiber(
    [],
    bindings.map(({ turn }, index) => ({
      index,
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calls: [],
      messages: [],
      activities: [],
      ...turn
    }))
  );
  await settle();
}

async function bindFiberRequest(section: HTMLElement, requestId: string, tool = 'read_file'): Promise<void> {
  await bindFiberTurns([{ section, turn: {
    turnId: section.getAttribute('data-turn-id'),
    calls: [{ messageId: `fiber-${requestId}`, tool, order: 0, answered: true, requestId }]
  } }]);
}

describe('naming rows in a chat that has been reloaded', () => {
  /**
   * The live failure: relabelling worked, the tab was refreshed, and the same chat came
   * back wearing nothing but ChatGPT's own names. Nothing had been switched off — the join
   * had expired. `data-turn-id` is minted per page load (`g-…` live, `request-WEB:<load>-…`
   * after a refresh), so the turn id every recorded call carries names no visible turn any
   * more. ChatGPT's connector request id is on both sides and means the same thing across
   * a reload, so that is what the fallback matches on.
   */
  it('names a reloaded turn from the request id, when its recorded turn id is gone', async () => {
    live = await harness();
    renderingOn();
    const section = assistantTurn(live!.document, 'request-WEB:6b1f2f0a-4d2c-4f2e-9a6a-2c1d6f0b0a11-3', [
      'Called tool!'
    ]);
    live!.reply.set('activity', () => ({
      ok: true,
      data: {
        entries: [
          call({ turnId: 'g-1s6atlm1inbjf2-0-1', callId: 'call-before-reload', requestId: 'wfr_reloaded_turn' })
        ],
        job: null
      }
    }));
    await live!.hook.pullActivity();
    await settle();
    await bindFiberRequest(section, 'wfr_reloaded_turn');
    live!.hook.paint();

    const row = section.querySelector('.pointer-events-none.contents') as HTMLElement;
    expect(row.dataset['clfCall']).toBe('call-before-reload');
    expect(labels(section)[0]).toContain('Read src/main/bridge.ts');
    // Not the quieter page-named treatment, which is what this row used to fall back to:
    // that one has no result, no duration and no outcome behind it.
    expect(row.dataset['clfPage']).toBeUndefined();
  });

  it('gives one response’s calls to one visible turn and no more', async () => {
    live = await harness();
    renderingOn();
    const first = assistantTurn(live!.document, 'request-WEB:6b1f2f0a-0000-4f2e-9a6a-2c1d6f0b0a11-0', [
      'Called tool!'
    ]);
    const second = assistantTurn(live!.document, 'request-WEB:6b1f2f0a-0000-4f2e-9a6a-2c1d6f0b0a11-1', [
      'Called tool!'
    ]);
    live!.reply.set('activity', () => ({
      ok: true,
      data: {
        entries: [call({ turnId: 'g-shared-0-1', callId: 'call-once', requestId: 'wfr_one_response' })],
        job: null
      }
    }));
    await live!.hook.pullActivity();
    await settle();
    // Both sections claim the same request. One response's calls cannot have been made by
    // two visible turns, so the second must not be handed the same call over again.
    await bindFiberTurns([
      {
        section: first,
        turn: {
          turnId: first.getAttribute('data-turn-id'),
          calls: [{ messageId: 'fiber-first', tool: 'read_file', order: 0, answered: true, requestId: 'wfr_one_response' }]
        }
      },
      {
        section: second,
        turn: {
          turnId: second.getAttribute('data-turn-id'),
          calls: [{ messageId: 'fiber-second', tool: 'read_file', order: 0, answered: true, requestId: 'wfr_one_response' }]
        }
      }
    ]);
    live!.hook.paint();

    expect((first.querySelector('.pointer-events-none.contents') as HTMLElement).dataset['clfCall']).toBe('call-once');
    expect(
      (second.querySelector('.pointer-events-none.contents') as HTMLElement).dataset['clfCall']
    ).toBeUndefined();
  });
});

describe('the app-owned chronological stream', () => {
  const turnId = 'turn-app-stream';
  const activity = () => ({
    ok: true,
    data: {
      entries: [],
      stream: [
        { seq: 1, time: 100, kind: 'turn_start', turnId, agent: 'prime' },
        {
          seq: 4,
          time: 400,
          kind: 'tool_call',
          turnId,
          agent: 'prime',
          tool: 'read_file',
          callId: 'call-third',
          requestId: 'wfr-app-stream',
          outcome: 'ok',
          durationMs: 3,
          summary: { kind: 'read', tone: 'neutral', title: 'Read third.ts' }
        },
        { seq: 2, time: 200, kind: 'progress', turnId, agent: 'prime', text: 'Checking the repository' },
        {
          seq: 3,
          time: 300,
          kind: 'tool_call',
          turnId,
          agent: 'prime',
          tool: 'read_file',
          callId: 'call-second',
          requestId: 'wfr-app-stream',
          outcome: 'ok',
          durationMs: 2,
          summary: { kind: 'read', tone: 'neutral', title: 'Read second.ts' }
        }
      ],
      job: null
    }
  });

  it('shows local calls even when ChatGPT rendered no native tool row for them', async () => {
    live = await harness(undefined, { activity });
    renderingOn();
    const section = assistantTurn(live.document, turnId, []);
    await bindFiberRequest(section, 'wfr-app-stream');

    live.hook.renderStreams();

    const rows = overwriteRows(section, '.clf-stream-row .clf-stream-text').map((node) =>
      (node.textContent || '').trim()
    );
    expect(rows).toEqual(['Turn started', 'Checking the repository', 'Read second.ts', 'Read third.ts']);
    expect(overwriteRows(section, '.clf-stream-tool_call')).toHaveLength(2);
    expect(section.querySelectorAll('.pointer-events-none.contents')).toHaveLength(0);
    expect(section.getAttribute('data-clf-turn-replaced')).toBe('1');
  });

  it('keeps recorder calls with no turn id visible in the turn whose time window they ran in', async () => {
    const orphanActivity = () => ({
      ok: true,
      data: {
        entries: [],
        stream: [
          { seq: 1, time: 100, kind: 'turn_start', turnId: 'g-one', agent: null },
          { seq: 2, time: 140, kind: 'turn_end', turnId: 'g-one', outcome: 'unknown', detail: '' },
          {
            seq: 3,
            time: 120,
            kind: 'tool_call',
            turnId: null,
            tool: 'read_file',
            callId: 'orphan-call',
            requestId: 'wfr-orphan-render',
            outcome: 'ok',
            durationMs: 2,
            summary: { kind: 'read', tone: 'neutral', title: 'Read recorder.ts' }
          },
          { seq: 4, time: 200, kind: 'turn_start', turnId: 'g-two', agent: null }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: orphanActivity });
    renderingOn();
    const first = assistantTurn(live.document, 'dom-one', []);
    const second = assistantTurn(live.document, 'dom-two', []);
    await bindFiberRequest(first, 'wfr-orphan-render');
    await live.hook.pullActivity();
    live.hook.renderStreams();

    expect(overwriteText(first)).toContain('Read recorder.ts');
    expect(overwriteText(second)).not.toContain('Read recorder.ts');
  });

  it('reconstructs exact orphan assistant/activity rows after a prematurely recorded turn end', async () => {
    const brokenTurn = 'g-broken-interrupted';
    const brokenActivity = () => ({
      ok: true,
      data: {
        entries: [],
        stream: [
          { seq: 1, time: 100, kind: 'turn_start', turnId: brokenTurn, agent: 'prime' },
          { seq: 2, time: 110, kind: 'assistant_message', turnId: brokenTurn, agent: 'prime', messageId: 'site-before-dropout', text: 'Before the dropout.', final: true },
          { seq: 3, time: 120, kind: 'turn_end', turnId: brokenTurn, agent: 'prime', outcome: 'interrupted', detail: '' },
          { seq: 4, origin: 4, time: 130, kind: 'assistant_message', turnId: null, agent: 'prime', messageId: 'site-orphan-one', text: 'Still working after it.', final: true },
          {
            seq: 5,
            time: 140,
            kind: 'tool_call',
            turnId: null,
            agent: 'prime',
            tool: 'read_file',
            callId: 'orphan-after-end',
            requestId: 'wfr-after-broken-end',
            outcome: 'ok',
            durationMs: 2,
            summary: { kind: 'read', tone: 'neutral', title: 'Read after the false end' }
          },
          { seq: 6, time: 150, kind: 'page_tool', turnId: null, agent: 'prime', messageId: 'thought-orphan-after-end-0', label: 'Inspected after the false end' },
          { seq: 7, origin: 7, time: 160, kind: 'assistant_message', turnId: null, agent: 'prime', messageId: 'site-orphan-two', text: 'And kept going.', final: true }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: brokenActivity });
    renderingOn();
    const section = assistantTurn(live.document, 'page-broken-interrupted', []);
    await bindFiberTurns([{ section, turn: {
      turnId: 'page-broken-interrupted',
      calls: [{ messageId: 'fiber-broken-call', tool: 'read_file', order: 0, answered: true, requestId: 'wfr-after-broken-end' }],
      messages: [
        { messageId: 'site-before-dropout', stable: true, rawText: 'Before the dropout.', renderedHtml: '' },
        { messageId: 'site-orphan-one', stable: true, rawText: 'Still working after it.', renderedHtml: '' },
        { messageId: 'site-orphan-two', stable: true, rawText: 'And kept going.', renderedHtml: '' }
      ],
      activities: [{ messageId: 'thought-orphan-after-end-0', label: 'Inspected after the false end' }]
    } }]);
    await live.hook.pullActivity();
    live.hook.renderStreams();

    const rows = overwriteRows(section, '.clf-stream-row .clf-stream-text').map((node) =>
      (node.textContent || '').trim()
    );
    expect(rows).toEqual([
      'Turn started',
      'Before the dropout.',
      'Still working after it.',
      'Read after the false end',
      'Inspected after the false end',
      'And kept going.',
      'Turn interrupted'
    ]);
    expect(section.getAttribute('data-clf-turn-replaced')).toBe('1');
  });

  it('reconstructs a visible Fiber turn from canonical assistant ids even with no local lifecycle group', async () => {
    const messageOnlyActivity = () => ({
      ok: true,
      data: {
        entries: [],
        stream: [
          { seq: 10, origin: 4, time: 100, kind: 'assistant_message', turnId: null, agent: null, messageId: 'site-message-only-one', text: 'First canonical partial.', final: true },
          { seq: 11, origin: 9, time: 200, kind: 'assistant_message', turnId: null, agent: null, messageId: 'site-message-only-two', text: 'Second canonical partial.', final: true }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: messageOnlyActivity });
    renderingOn();
    const section = assistantTurn(live.document, 'page-message-only', []);
    const native = live.document.createElement('div');
    native.className = 'markdown';
    native.textContent = 'Second canonical partial.';
    section.append(native);
    await bindFiberTurns([{ section, turn: {
      turnId: 'page-message-only',
      messages: [
        { messageId: 'site-message-only-one', stable: true, rawText: 'First canonical partial.', renderedHtml: '' },
        { messageId: 'site-message-only-two', stable: true, rawText: 'Second canonical partial.', renderedHtml: '' }
      ]
    } }]);
    await live.hook.pullActivity();
    live.hook.renderStreams();

    const rows = overwriteRows(section, '.clf-stream-assistant_message .clf-stream-text').map((node) =>
      (node.textContent || '').trim()
    );
    expect(rows).toEqual(['First canonical partial.', 'Second canonical partial.']);
    expect(section.getAttribute('data-clf-turn-replaced')).toBe('1');
  });

  it('updates one reload-only overwrite in place when another canonical assistant id arrives later', async () => {
    let expanded = false;
    const messageOnlyActivity = () => ({
      ok: true,
      data: {
        entries: [],
        stream: [
          { seq: 10, origin: 4, time: 100, kind: 'assistant_message', turnId: null, agent: null, messageId: 'site-growing-one', text: 'First canonical partial.', final: true },
          ...(expanded
            ? [{ seq: 11, origin: 9, time: 200, kind: 'assistant_message', turnId: null, agent: null, messageId: 'site-growing-two', text: 'Second canonical partial.', final: true }]
            : [])
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: messageOnlyActivity });
    renderingOn();
    const section = assistantTurn(live.document, 'page-message-growing', []);
    await bindFiberTurns([{ section, turn: {
      turnId: 'page-message-growing',
      messages: [{ messageId: 'site-growing-one', stable: true, rawText: 'First canonical partial.', renderedHtml: '' }]
    } }]);
    await live.hook.pullActivity();
    live.hook.renderStreams();
    const firstRoot = overwriteStream(section)!;
    expect(firstRoot).toBeTruthy();
    expect(live.document.querySelectorAll('.clf-stream')).toHaveLength(1);

    expanded = true;
    await bindFiberTurns([{ section, turn: {
      turnId: 'page-message-growing',
      messages: [
        { messageId: 'site-growing-one', stable: true, rawText: 'First canonical partial.', renderedHtml: '' },
        { messageId: 'site-growing-two', stable: true, rawText: 'Second canonical partial.', renderedHtml: '' }
      ]
    } }]);
    await live.hook.pullActivity();
    live.hook.renderStreams();

    expect(overwriteStream(section)).toBe(firstRoot);
    expect(live.document.querySelectorAll('.clf-stream')).toHaveLength(1);
    expect(overwriteRows(section, '.clf-stream-assistant_message .clf-stream-text').map((node) => node.textContent)).toEqual([
      'First canonical partial.',
      'Second canonical partial.'
    ]);
  });

  it('never hides native assistant prose when the local stream has the tool call but not that message yet', async () => {
    const incompleteActivity = () => ({
      ok: true,
      data: {
        entries: [],
        stream: [
          { seq: 1, time: 100, kind: 'turn_start', turnId: 'g-incomplete-overwrite', agent: 'prime' },
          {
            seq: 2,
            time: 120,
            kind: 'tool_call',
            turnId: 'g-incomplete-overwrite',
            agent: 'prime',
            tool: 'read_file',
            callId: 'call-incomplete-overwrite',
            requestId: 'wfr-incomplete-overwrite',
            outcome: 'ok',
            durationMs: 2,
            summary: { kind: 'read', tone: 'neutral', title: 'Read while transcript catches up' }
          }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: incompleteActivity });
    renderingOn();
    const section = assistantTurn(live.document, 'page-incomplete-overwrite', []);
    const native = live.document.createElement('div');
    native.className = 'markdown';
    native.textContent = 'This native interim has not reached the local app yet.';
    section.append(native);
    await bindFiberTurns([{ section, turn: {
      turnId: 'page-incomplete-overwrite',
      calls: [{
        messageId: 'fiber-incomplete-call',
        tool: 'read_file',
        order: 0,
        answered: true,
        requestId: 'wfr-incomplete-overwrite'
      }],
      messages: [{
        messageId: 'site-incomplete-interim',
        stable: false,
        rawText: 'This native interim has not reached the local app yet.',
        renderedHtml: ''
      }]
    } }]);
    await live.hook.pullActivity();
    live.hook.renderStreams();

    expect(section.getAttribute('data-clf-turn-replaced')).toBeNull();
    expect(overwriteStream(section)).toBeNull();
    expect(native.textContent).toBe('This native interim has not reached the local app yet.');
  });

  it('keeps a proven overwrite mounted through a transient incomplete Fiber scan', async () => {
    const activity = () => ({
      ok: true,
      data: {
        entries: [],
        stream: [
          { seq: 1, time: 100, kind: 'turn_start', turnId: 'g-sticky-overwrite', agent: null },
          {
            seq: 2,
            time: 110,
            kind: 'assistant_message',
            turnId: 'g-sticky-overwrite',
            messageId: 'site-sticky-one',
            text: 'First complete local snapshot',
            final: false
          }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity });
    renderingOn();
    const section = assistantTurn(live.document, 'page-sticky-overwrite', []);
    await bindFiberTurns([{ section, turn: {
      turnId: 'page-sticky-overwrite',
      messages: [{
        messageId: 'site-sticky-one',
        stable: true,
        rawText: 'First complete local snapshot',
        renderedHtml: ''
      }]
    } }]);
    await live.hook.pullActivity();
    live.hook.renderStreams();
    expect(section.getAttribute('data-clf-turn-replaced')).toBe('1');
    expect(overwriteText(section)).toContain('First complete local snapshot');

    await bindFiberTurns([{ section, turn: {
      turnId: 'page-sticky-overwrite',
      messages: [
        { messageId: 'site-sticky-one', stable: true, rawText: 'First complete local snapshot', renderedHtml: '' },
        { messageId: 'site-sticky-two', stable: false, rawText: 'Second snapshot still in flight', renderedHtml: '' }
      ]
    } }]);
    live.hook.renderStreams();

    expect(section.getAttribute('data-clf-turn-replaced')).toBe('1');
    expect(overwriteText(section)).toContain('First complete local snapshot');
  });

  it('drops a stale overwrite immediately when Fiber exposes a new exact in-flight call', async () => {
    const activity = () => ({
      ok: true,
      data: {
        entries: [],
        stream: [
          { seq: 1, time: 100, kind: 'turn_start', turnId: 'g-live-call-gap', agent: null },
          {
            seq: 2,
            time: 110,
            kind: 'tool_call',
            turnId: 'g-live-call-gap',
            agent: null,
            tool: 'read_file',
            callId: 'call-one',
            requestId: 'wfr-live-one',
            outcome: 'ok',
            durationMs: 2,
            summary: { kind: 'read', tone: 'neutral', title: 'First call' }
          }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity });
    renderingOn();
    const section = assistantTurn(live.document, 'page-live-call-gap', []);
    await bindFiberTurns([{ section, turn: {
      turnId: 'page-live-call-gap',
      calls: [{ messageId: 'fiber-one', tool: 'read_file', order: 0, answered: true, requestId: 'wfr-live-one' }]
    } }]);
    await live.hook.pullActivity();
    live.hook.renderStreams();
    expect(section.getAttribute('data-clf-turn-replaced')).toBe('1');

    // ChatGPT knows call two has begun, but the handler has not returned yet, so /activity
    // necessarily still contains only call one. The native page must become visible now rather
    // than remain hidden behind the grace period's stale replacement.
    await bindFiberTurns([{ section, turn: {
      turnId: 'page-live-call-gap',
      calls: [
        { messageId: 'fiber-one', tool: 'read_file', order: 0, answered: true, requestId: 'wfr-live-one' },
        { messageId: 'fiber-two', tool: 'exec_command', order: 1, answered: false, requestId: 'wfr-live-two' }
      ]
    } }]);
    live.hook.renderStreams();

    expect(section.getAttribute('data-clf-turn-replaced')).toBeNull();
    expect(overwriteStream(section)).toBeNull();
  });

  it('does not merge separate assistant turns when ChatGPT reuses the same DOM turn id', async () => {
    const reusedActivity = () => ({
      ok: true,
      data: {
        entries: [],
        stream: [
          { seq: 1, time: 100, kind: 'turn_start', turnId: 'g-one', agent: null },
          { seq: 2, time: 120, kind: 'progress', turnId: 'g-one', text: 'First work' },
          { seq: 3, time: 130, kind: 'assistant_message', turnId: 'g-one', messageId: 'site-reused-one', text: 'First answer', final: true },
          { seq: 4, time: 140, kind: 'turn_end', turnId: 'g-one', outcome: 'unknown', detail: '' },
          { seq: 5, time: 200, kind: 'turn_start', turnId: 'g-two', agent: null },
          { seq: 6, time: 220, kind: 'progress', turnId: 'g-two', text: 'Second work' },
          { seq: 7, time: 230, kind: 'assistant_message', turnId: 'g-two', messageId: 'site-reused-two', text: 'Second answer', final: true }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: reusedActivity });
    renderingOn();
    const first = assistantTurn(live.document, 'request-reused', []);
    userTurn(live.document, 'user-between', 'next');
    const second = assistantTurn(live.document, 'request-reused', []);
    await bindFiberTurns([
      { section: first, turn: { turnId: 'request-reused', messages: [{ messageId: 'site-reused-one', stable: true, rawText: 'First answer', renderedHtml: '' }] } },
      { section: second, turn: { turnId: 'request-reused', messages: [{ messageId: 'site-reused-two', stable: true, rawText: 'Second answer', renderedHtml: '' }] } }
    ]);
    await live.hook.pullActivity();
    live.hook.renderStreams();

    expect(overwriteText(first)).toContain('First work');
    expect(overwriteText(first)).not.toContain('Second work');
    expect(overwriteText(second)).toContain('Second work');
    expect(live.document.querySelectorAll('.clf-stream')).toHaveLength(2);
  });

  it('hides timestamps by default and can show them without changing the stream', async () => {
    live = await harness(undefined, { activity });
    renderingOn();
    const section = assistantTurn(live.document, turnId, []);
    await bindFiberRequest(section, 'wfr-app-stream');
    live.hook.renderStreams();
    expect(overwriteStream(section)?.querySelector('.clf-when') ?? null).toBeNull();

    live.hook.setShowTimes(true);
    live.hook.renderStreams();
    expect(overwriteStream(section)?.querySelector('.clf-when') ?? null).not.toBeNull();
  });

  it('does not present an exec yield duration as if it were a finished-command duration', async () => {
    const metricActivity = () => ({
      ok: true,
      data: {
        entries: [],
        stream: [
          { seq: 1, time: 100, kind: 'turn_start', turnId, agent: null },
          {
            seq: 2,
            time: 110,
            kind: 'tool_call',
            turnId,
            agent: null,
            tool: 'exec_command',
            callId: 'still-running',
            requestId: 'wfr-metric-stream',
            outcome: 'ok',
            durationMs: 10_000,
            summary: { kind: 'run', tone: 'good', title: 'Ran npm run verify', metric: '✓ 10.0s' }
          },
          {
            seq: 3,
            time: 120,
            kind: 'tool_call',
            turnId,
            agent: null,
            tool: 'exec_command',
            callId: 'failed',
            requestId: 'wfr-metric-stream',
            outcome: 'error',
            durationMs: 900,
            summary: { kind: 'run', tone: 'bad', title: 'Command failed npm test', metric: '✕ exit 1' }
          }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: metricActivity });
    renderingOn();
    const section = assistantTurn(live.document, turnId, []);
    await bindFiberRequest(section, 'wfr-metric-stream', 'exec_command');
    live.hook.renderStreams();

    expect(overwriteText(section)).toContain('Ran npm run verify');
    expect(overwriteText(section)).not.toContain('✓ 10.0s');
    expect(overwriteText(section)).toContain('✕ exit 1');
  });

  it('ignores ChatGPT DOM reasoning order and renders only the order recorded by the app', async () => {
    const orderedActivity = () => ({
      ok: true,
      data: {
        entries: [],
        stream: [
          { seq: 0, time: 90, kind: 'turn_start', turnId, agent: null },
          {
            seq: 1,
            time: 100,
            kind: 'tool_call',
            turnId,
            agent: null,
            tool: 'list_roots',
            callId: 'roots-call',
            requestId: 'wfr-order-stream',
            outcome: 'ok',
            durationMs: 2,
            summary: { kind: 'read', tone: 'neutral', title: 'Listed approved folders' }
          },
          {
            seq: 2,
            time: 200,
            kind: 'tool_call',
            turnId,
            agent: null,
            tool: 'list_windows',
            callId: 'windows-call',
            requestId: 'wfr-order-stream',
            outcome: 'ok',
            durationMs: 2,
            summary: { kind: 'read', tone: 'neutral', title: 'Listed open windows' }
          }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: orderedActivity });
    renderingOn();
    const section = assistantTurn(live.document, turnId, []);
    const reasoning = live.document.createElement('div');
    reasoning.setAttribute('data-interrupted', 'false');
    reasoning.append(toolBlock(live.document, 'Checked available roots'));
    const prose = live.document.createElement('p');
    prose.textContent = 'checking windows';
    reasoning.append(prose);
    reasoning.append(toolBlock(live.document, 'Listed roots and windows'));
    section.append(reasoning, toolBlock(live.document, 'Called tool!'), toolBlock(live.document, 'Called tool!'));
    await bindFiberRequest(section, 'wfr-order-stream', 'list_roots');

    live.hook.renderStreams();

    const rows = overwriteRows(section, '.clf-stream-row .clf-stream-text').map((node) =>
      (node.textContent || '').trim()
    );
    expect(rows).toEqual(['Turn started', 'Listed approved folders', 'Listed open windows']);
    expect(section.getAttribute('data-clf-turn-replaced')).toBe('1');
    expect(reasoning.getAttribute('data-clf-native-hidden')).toBeNull();
    for (const block of blocksOf(section)) expect(block.getAttribute('data-clf-native-hidden')).toBeNull();
  });

  it('replaces a recorded ChatGPT-native web row while leaving connector attribution separate', async () => {
    const nativeActivity = () => ({
      ok: true,
      data: {
        entries: [],
        stream: [
          { seq: 1, time: 100, kind: 'turn_start', turnId, agent: null },
          { seq: 2, time: 200, kind: 'page_tool', turnId, agent: null, label: 'Searched the web', messageId: 'native-web' }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: nativeActivity });
    renderingOn();
    const section = assistantTurn(live.document, turnId, ['Searched the web']);
    await bindFiberTurns([{ section, turn: {
      turnId,
      activities: [{ messageId: 'native-web', label: 'Searched the web' }]
    } }]);

    live.hook.renderStreams();

    expect(overwriteStream(section)?.querySelector('.clf-stream-page_tool')?.textContent).toContain('Searched the web');
    expect(section.getAttribute('data-clf-turn-replaced')).toBe('1');
    expect(blocksOf(section)[0]!.getAttribute('data-clf-native-hidden')).toBeNull();
  });

  it('keeps a settled turn app-owned and renders its final assistant message from the app feed', async () => {
    const settledActivity = () => ({
      ok: true,
      data: {
        entries: [],
        stream: [
          { seq: 1, time: 100, kind: 'turn_start', turnId, agent: 'prime' },
          { seq: 2, time: 200, kind: 'progress', turnId, agent: 'prime', text: 'Checking the repository' },
          {
            seq: 3,
            time: 300,
            kind: 'tool_call',
            turnId,
            agent: 'prime',
            tool: 'read_file',
            callId: 'call-second',
            outcome: 'ok',
            durationMs: 2,
            summary: { kind: 'read', tone: 'neutral', title: 'Read second.ts' }
          },
          { seq: 4, time: 400, kind: 'assistant_message', turnId, agent: 'prime', messageId: 'site-settled-answer', text: 'Here is the answer.', final: true },
          { seq: 5, time: 500, kind: 'turn_end', turnId, agent: 'prime', outcome: 'completed', detail: '' }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: settledActivity });
    renderingOn();
    const section = assistantTurn(live.document, turnId, ['Called tool!']);
    const reasoning = live.document.createElement('div');
    reasoning.setAttribute('data-interrupted', 'false');
    reasoning.textContent = 'Checking the repository';
    const prose = live.document.createElement('div');
    prose.className = 'markdown';
    prose.textContent = 'Here is the answer.';
    section.append(reasoning, prose);

    await bindFiberTurns([{ section, turn: {
      turnId,
      messages: [{ messageId: 'site-settled-answer', stable: true, rawText: 'Here is the answer.', renderedHtml: '' }]
    } }]);
    live.hook.renderStreams();
    expect(section.getAttribute('data-clf-turn-replaced')).toBe('1');
    expect(overwriteStream(section)?.querySelector('.clf-stream-assistant_message')?.textContent).toContain('Here is the answer.');
    expect(overwriteStream(section)?.querySelector('.clf-stream-turn_end')?.textContent).toContain('Turn completed');
    // React's original answer is deliberately still mounted underneath the replacement.
    expect(prose.textContent).toBe('Here is the answer.');
  });

  it('aligns durable app turns to visible assistant turns after a page reload even when DOM ids differ', async () => {
    const reloadedActivity = () => ({
      ok: true,
      data: {
        entries: [],
        stream: [
          { seq: 1, time: 100, kind: 'turn_start', turnId: 'g-recorded-1', agent: null },
          { seq: 2, time: 200, kind: 'assistant_message', turnId: 'g-recorded-1', agent: null, messageId: 'site-reload-one', text: 'First answer', final: true },
          { seq: 3, time: 300, kind: 'turn_end', turnId: 'g-recorded-1', agent: null, outcome: 'completed', detail: '' },
          { seq: 4, time: 400, kind: 'turn_start', turnId: 'g-recorded-2', agent: null },
          { seq: 5, time: 500, kind: 'assistant_message', turnId: 'g-recorded-2', agent: null, messageId: 'site-reload-two', text: 'Second answer', final: true },
          { seq: 6, time: 600, kind: 'turn_end', turnId: 'g-recorded-2', agent: null, outcome: 'completed', detail: '' }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: reloadedActivity });
    renderingOn();
    const first = assistantTurn(live.document, 'request-reused-x', []);
    const second = assistantTurn(live.document, 'request-reused-y', []);
    await bindFiberTurns([
      { section: first, turn: { turnId: 'request-reused-x', messages: [{ messageId: 'site-reload-one', stable: true, rawText: 'First answer', renderedHtml: '' }] } },
      { section: second, turn: { turnId: 'request-reused-y', messages: [{ messageId: 'site-reload-two', stable: true, rawText: 'Second answer', renderedHtml: '' }] } }
    ]);
    await live.hook.pullActivity();
    live.hook.renderStreams();

    expect(overwriteStream(first)?.querySelector('.clf-stream-assistant_message')?.textContent).toContain('First answer');
    expect(overwriteStream(second)?.querySelector('.clf-stream-assistant_message')?.textContent).toContain('Second answer');
    expect(first.getAttribute('data-clf-turn-replaced')).toBe('1');
    expect(second.getAttribute('data-clf-turn-replaced')).toBe('1');
  });

  it('uses stable website message ids when one MCP request id spans several durable turns', async () => {
    const sharedRequest = 'wfr-shared-across-local-turns';
    const splitActivity = () => ({
      ok: true,
      data: {
        entries: [],
        stream: [
          { seq: 1, time: 100, kind: 'turn_start', turnId: 'g-split-one', agent: 'prime' },
          {
            seq: 2,
            time: 110,
            kind: 'tool_call',
            turnId: 'g-split-one',
            agent: 'prime',
            tool: 'read_file',
            callId: 'split-one',
            requestId: sharedRequest,
            outcome: 'ok',
            durationMs: 2,
            summary: { kind: 'read', tone: 'neutral', title: 'Read first turn' }
          },
          { seq: 3, time: 120, kind: 'assistant_message', turnId: 'g-split-one', agent: 'prime', messageId: 'site-split-one', text: 'First answer', final: true },
          { seq: 4, time: 130, kind: 'turn_end', turnId: 'g-split-one', agent: 'prime', outcome: 'completed', detail: '' },
          {
            seq: 5,
            time: 140,
            kind: 'tool_call',
            turnId: null,
            agent: 'prime',
            tool: 'search_files',
            callId: 'split-orphan',
            requestId: sharedRequest,
            outcome: 'ok',
            durationMs: 2,
            summary: { kind: 'search', tone: 'neutral', title: 'Searched between turns' }
          },
          { seq: 6, time: 200, kind: 'turn_start', turnId: 'g-split-two', agent: 'prime' },
          {
            seq: 7,
            time: 210,
            kind: 'tool_call',
            turnId: 'g-split-two',
            agent: 'prime',
            tool: 'read_file',
            callId: 'split-two',
            requestId: sharedRequest,
            outcome: 'ok',
            durationMs: 2,
            summary: { kind: 'read', tone: 'neutral', title: 'Read second turn' }
          },
          { seq: 8, time: 220, kind: 'assistant_message', turnId: 'g-split-two', agent: 'prime', messageId: 'site-split-two', text: 'Second answer', final: true },
          { seq: 9, time: 230, kind: 'turn_end', turnId: 'g-split-two', agent: 'prime', outcome: 'completed', detail: '' }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: splitActivity });
    renderingOn();
    const first = assistantTurn(live.document, 'page-split-one', []);
    const second = assistantTurn(live.document, 'page-split-two', []);
    await bindFiberTurns([
      {
        section: first,
        turn: {
          turnId: 'page-split-one',
          calls: [{ messageId: 'fiber-split-one', tool: 'read_file', order: 0, answered: true, requestId: sharedRequest }],
          messages: [{ messageId: 'site-split-one', stable: true, rawText: 'First answer', renderedHtml: '' }]
        }
      },
      {
        section: second,
        turn: {
          turnId: 'page-split-two',
          calls: [{ messageId: 'fiber-split-two', tool: 'read_file', order: 0, answered: true, requestId: sharedRequest }],
          messages: [{ messageId: 'site-split-two', stable: true, rawText: 'Second answer', renderedHtml: '' }]
        }
      }
    ]);
    await live.hook.pullActivity();
    live.hook.renderStreams();

    expect(first.getAttribute('data-clf-turn-replaced')).toBe('1');
    expect(overwriteText(first)).toContain('Read first turn');
    expect(overwriteText(first)).toContain('Searched between turns');
    expect(overwriteText(first)).not.toContain('Read second turn');
    expect(second.getAttribute('data-clf-turn-replaced')).toBe('1');
    expect(overwriteText(second)).toContain('Read second turn');
    expect(overwriteText(second)).not.toContain('Read first turn');
  });

  it('uses the preceding user message to reconstruct one response split across local lifecycle turns', async () => {
    const sharedRequest = 'wfr-shared-even-across-user-boundaries';
    const anchoredActivity = () => ({
      ok: true,
      data: {
        entries: [],
        userAnchors: [
          { seq: 1, time: 100, messageId: 'm-user-anchor-one' },
          { seq: 10, time: 1000, messageId: 'm-user-anchor-two' }
        ],
        stream: [
          { seq: 2, time: 110, kind: 'turn_start', turnId: 'g-anchor-one-a', agent: 'prime' },
          {
            seq: 3, time: 120, kind: 'tool_call', turnId: 'g-anchor-one-a', agent: 'prime',
            tool: 'read_file', callId: 'anchor-one-a', requestId: sharedRequest, outcome: 'ok', durationMs: 2,
            summary: { kind: 'read', tone: 'neutral', title: 'Read first response part' }
          },
          { seq: 4, time: 130, kind: 'turn_end', turnId: 'g-anchor-one-a', agent: 'prime', outcome: 'unknown', detail: '' },
          { seq: 5, time: 140, kind: 'turn_start', turnId: 'g-anchor-one-b', agent: 'prime' },
          {
            seq: 6, time: 150, kind: 'tool_call', turnId: 'g-anchor-one-b', agent: 'prime',
            tool: 'exec_command', callId: 'anchor-one-b', requestId: sharedRequest, outcome: 'ok', durationMs: 2,
            summary: { kind: 'exec', tone: 'neutral', title: 'Ran second response part' }
          },
          { seq: 7, time: 160, kind: 'turn_end', turnId: 'g-anchor-one-b', agent: 'prime', outcome: 'unknown', detail: '' },
          { seq: 11, time: 1010, kind: 'turn_start', turnId: 'g-anchor-two', agent: 'prime' },
          {
            seq: 12, time: 1020, kind: 'tool_call', turnId: 'g-anchor-two', agent: 'prime',
            tool: 'read_file', callId: 'anchor-two', requestId: sharedRequest, outcome: 'ok', durationMs: 2,
            summary: { kind: 'read', tone: 'neutral', title: 'Read next user response' }
          }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: anchoredActivity });
    renderingOn();
    userTurn(live.document, 'user-anchor-one', 'first question');
    const first = assistantTurn(live.document, 'page-anchor-one', []);
    userTurn(live.document, 'user-anchor-two', 'second question');
    const second = assistantTurn(live.document, 'page-anchor-two', []);
    await bindFiberTurns([
      {
        section: first,
        turn: {
          turnId: 'page-anchor-one',
          calls: [{ messageId: 'fiber-anchor-one', tool: 'exec_command', order: 0, answered: true, requestId: sharedRequest }]
        }
      },
      {
        section: second,
        turn: {
          turnId: 'page-anchor-two',
          calls: [{ messageId: 'fiber-anchor-two', tool: 'read_file', order: 0, answered: true, requestId: sharedRequest }]
        }
      }
    ]);
    await live.hook.pullActivity();
    live.hook.renderStreams();

    expect(first.getAttribute('data-clf-turn-replaced')).toBe('1');
    expect(overwriteText(first)).toContain('Read first response part');
    expect(overwriteText(first)).toContain('Ran second response part');
    expect(overwriteText(first)).toContain('prime');
    expect(overwriteText(first)).not.toContain('Read next user response');
    expect(second.getAttribute('data-clf-turn-replaced')).toBe('1');
    expect(overwriteText(second)).toContain('Read next user response');
    expect(overwriteText(second)).not.toContain('Read first response part');
  });

  it('keeps the recorded text user-message anchor when the same turn also contains an image attachment id', async () => {
    const sharedRequest = 'wfr-image-anchor-shared';
    const anchoredActivity = () => ({
      ok: true,
      data: {
        entries: [],
        userAnchors: [
          { seq: 1, time: 100, messageId: 'm-user-image-anchor' },
          { seq: 10, time: 1000, messageId: 'm-user-after-image' }
        ],
        stream: [
          { seq: 2, time: 110, kind: 'turn_start', turnId: 'g-image-a', agent: 'prime' },
          {
            seq: 3, time: 120, kind: 'tool_call', turnId: 'g-image-a', agent: 'prime',
            tool: 'read_file', callId: 'image-a', requestId: sharedRequest, outcome: 'ok', durationMs: 2,
            summary: { kind: 'read', tone: 'neutral', title: 'Read before image remount' }
          },
          { seq: 4, time: 130, kind: 'turn_end', turnId: 'g-image-a', agent: 'prime', outcome: 'unknown', detail: '' },
          { seq: 5, time: 140, kind: 'turn_start', turnId: 'g-image-b', agent: 'prime' },
          {
            seq: 6, time: 150, kind: 'tool_call', turnId: 'g-image-b', agent: 'prime',
            tool: 'exec_command', callId: 'image-b', requestId: sharedRequest, outcome: 'ok', durationMs: 2,
            summary: { kind: 'exec', tone: 'neutral', title: 'Ran after image remount' }
          },
          { seq: 7, time: 160, kind: 'turn_end', turnId: 'g-image-b', agent: 'prime', outcome: 'completed', detail: '' },
          { seq: 11, time: 1010, kind: 'turn_start', turnId: 'g-after-image', agent: 'prime' },
          {
            seq: 12, time: 1020, kind: 'tool_call', turnId: 'g-after-image', agent: 'prime',
            tool: 'read_file', callId: 'after-image', requestId: sharedRequest, outcome: 'ok', durationMs: 2,
            summary: { kind: 'read', tone: 'neutral', title: 'Read later response' }
          }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: anchoredActivity });
    renderingOn();
    const user = userTurn(live.document, 'user-image-anchor', 'question with screenshot');
    // Live image/file turns can expose another page message object in the same user section.
    // It is not a recorded authored-text boundary, so it must not make the real durable anchor
    // ambiguous and force Overwrite to flap between native and synthetic on virtualization.
    const attachment = live.document.createElement('div');
    attachment.setAttribute('data-message-id', 'm-image-attachment-object');
    attachment.setAttribute('data-message-author-role', 'user');
    const image = live.document.createElement('img');
    image.setAttribute('alt', 'uploaded screenshot');
    attachment.append(image);
    user.append(attachment);
    const first = assistantTurn(live.document, 'page-image-anchor', []);
    userTurn(live.document, 'user-after-image', 'later question');
    const second = assistantTurn(live.document, 'page-after-image', []);
    await bindFiberTurns([
      {
        section: first,
        turn: {
          turnId: 'page-image-anchor',
          calls: [{ messageId: 'fiber-image-anchor', tool: 'exec_command', order: 0, answered: true, requestId: sharedRequest }]
        }
      },
      {
        section: second,
        turn: {
          turnId: 'page-after-image',
          calls: [{ messageId: 'fiber-after-image', tool: 'read_file', order: 0, answered: true, requestId: sharedRequest }]
        }
      }
    ]);
    await live.hook.pullActivity();
    live.hook.renderStreams();

    expect(first.getAttribute('data-clf-turn-replaced')).toBe('1');
    expect(overwriteText(first)).toContain('Read before image remount');
    expect(overwriteText(first)).toContain('Ran after image remount');
    expect(overwriteText(first)).not.toContain('Read later response');
  });

  it('keeps an id-less assistant section native until Fiber proves the local replacement is complete', async () => {
    const anchoredActivity = () => ({
      ok: true,
      data: {
        entries: [],
        userAnchors: [{ seq: 1, time: 100, messageId: 'm-user-idless-anchor' }],
        stream: [
          { seq: 2, time: 110, kind: 'turn_start', turnId: 'g-idless-anchor', agent: 'prime' },
          {
            seq: 3,
            time: 120,
            kind: 'tool_call',
            turnId: 'g-idless-anchor',
            agent: 'prime',
            tool: 'read_file',
            callId: 'idless-anchor-call',
            outcome: 'ok',
            durationMs: 2,
            summary: { kind: 'read', tone: 'neutral', title: 'Read anchored file' }
          },
          { seq: 4, time: 130, kind: 'turn_end', turnId: 'g-idless-anchor', agent: 'prime', outcome: 'completed', detail: '' }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: anchoredActivity });
    renderingOn();
    userTurn(live.document, 'user-idless-anchor', 'keep this user turn visible');
    const section = assistantTurn(live.document, 'temporary-page-id', []);
    section.removeAttribute('data-turn-id');
    await live.hook.pullActivity();
    live.hook.renderStreams();

    expect(section.getAttribute('data-clf-turn-replaced')).toBeNull();
    expect(overwriteStream(section)).toBeNull();
    expect(live.document.body.textContent).toContain('keep this user turn visible');
  });

  /**
   * One response, split by ChatGPT into two sections that carry no `data-turn-id`.
   *
   * `presentationTurns()` folds split sections into one logical turn by role + id, so the
   * id-less pair stays two turns. Both then reconstruct from the same user anchor — the
   * anchored render is a function of the user message, not of the section — and both were
   * painted, so the answer appeared twice, once per section, each hiding the native copy
   * underneath it. Only the first section owns the render; the rest of the response is the
   * same answer and stays behind it.
   */
  it('renders one answer once when ChatGPT splits it across sections with no turn id', async () => {
    const splitActivity = () => ({
      ok: true,
      data: {
        entries: [],
        userAnchors: [{ seq: 1, time: 100, messageId: 'm-user-split' }],
        stream: [
          { seq: 2, time: 110, kind: 'turn_start', turnId: 'g-split', agent: 'prime' },
          {
            seq: 3,
            time: 120,
            kind: 'assistant_message',
            turnId: 'g-split',
            agent: 'prime',
            messageId: 'site-split',
            text: 'The one and only answer',
            final: true
          },
          { seq: 4, time: 130, kind: 'turn_end', turnId: 'g-split', agent: 'prime', outcome: 'completed', detail: '' }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: splitActivity });
    renderingOn();
    userTurn(live.document, 'user-split', 'ask one question');
    const first = assistantTurn(live.document, 'temporary-split-a', []);
    const second = assistantTurn(live.document, 'temporary-split-b', []);
    first.removeAttribute('data-turn-id');
    second.removeAttribute('data-turn-id');
    const message = { messageId: 'site-split', stable: true, rawText: 'The one and only answer', renderedHtml: '' };
    await bindFiberTurns([
      { section: first, turn: { turnId: null, messages: [message] } },
      { section: second, turn: { turnId: null, messages: [message] } }
    ]);
    await live.hook.pullActivity();
    live.hook.renderStreams();

    expect(live.document.querySelectorAll('.clf-stream')).toHaveLength(1);
    expect(overwriteStream(first)).not.toBeNull();
    // The trailing section is part of the same response, so it is hidden rather than left
    // showing ChatGPT's own copy of prose the reconstruction above already carries.
    expect(second.getAttribute('data-clf-turn-replaced')).toBe('1');
  });

  it('does not merge a genuine reissue after the same user message when its request id changed', async () => {
    const reissueActivity = () => ({
      ok: true,
      data: {
        entries: [],
        userAnchors: [
          { seq: 1, time: 100, messageId: 'm-user-reissue' },
          { seq: 20, time: 2000, messageId: 'm-user-after-reissue' }
        ],
        stream: [
          { seq: 2, time: 110, kind: 'turn_start', turnId: 'g-reissue-old', agent: 'prime' },
          {
            seq: 3, time: 120, kind: 'tool_call', turnId: 'g-reissue-old', agent: 'prime',
            tool: 'read_file', callId: 'reissue-old', requestId: 'wfr-old-response', outcome: 'ok', durationMs: 2,
            summary: { kind: 'read', tone: 'neutral', title: 'Read superseded response' }
          },
          { seq: 4, time: 130, kind: 'turn_end', turnId: 'g-reissue-old', agent: 'prime', outcome: 'unknown', detail: '' },
          { seq: 5, time: 140, kind: 'turn_start', turnId: 'g-reissue-current', agent: 'prime' },
          {
            seq: 6, time: 150, kind: 'tool_call', turnId: 'g-reissue-current', agent: 'prime',
            tool: 'exec_command', callId: 'reissue-current', requestId: 'wfr-current-response', outcome: 'ok', durationMs: 2,
            summary: { kind: 'exec', tone: 'neutral', title: 'Ran current response' }
          },
          { seq: 7, time: 160, kind: 'turn_end', turnId: 'g-reissue-current', agent: 'prime', outcome: 'completed', detail: '' }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: reissueActivity });
    renderingOn();
    userTurn(live.document, 'user-reissue', 'same user message');
    const section = assistantTurn(live.document, 'page-current-reissue', []);
    await bindFiberTurns([{
      section,
      turn: {
        turnId: 'page-current-reissue',
        calls: [{ messageId: 'fiber-current-reissue', tool: 'exec_command', order: 0, answered: true, requestId: 'wfr-current-response' }]
      }
    }]);
    await live.hook.pullActivity();
    live.hook.renderStreams();

    expect(section.getAttribute('data-clf-turn-replaced')).toBe('1');
    expect(overwriteText(section)).toContain('Ran current response');
    expect(overwriteText(section)).not.toContain('Read superseded response');
  });

  it('does not tail-align the previous recorded turn into a new assistant turn before its activity arrives', async () => {
    const previousActivity = () => ({
      ok: true,
      data: {
        entries: [],
        stream: [
          { seq: 1, time: 100, kind: 'turn_start', turnId: 'g-recorded-old', agent: null },
          { seq: 2, time: 200, kind: 'assistant_message', turnId: 'g-recorded-old', agent: null, messageId: 'site-old-answer', text: 'Previous answer', final: true },
          { seq: 3, time: 300, kind: 'turn_end', turnId: 'g-recorded-old', agent: null, outcome: 'completed', detail: '' }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: previousActivity });
    renderingOn();

    // Reload recovery is by the stable website message id, never by list position.
    const previous = assistantTurn(live.document, 'request-old', []);
    await bindFiberTurns([{ section: previous, turn: {
      turnId: 'request-old',
      messages: [{ messageId: 'site-old-answer', stable: true, rawText: 'Previous answer', renderedHtml: '' }]
    } }]);
    live.hook.observe();
    live.hook.renderStreams();
    expect(overwriteStream(previous)?.querySelector('.clf-stream-assistant_message')?.textContent).toContain('Previous answer');

    // The next user message and assistant section are on screen before /activity has had the
    // round trip needed to return this new turn_start. That gap must never make reload-only
    // tail alignment reinterpret the previous durable group as the new turn.
    userTurn(live.document, 'user-next', 'Next question');
    const next = assistantTurn(live.document, 'request-new', []);
    await bindFiberTurns([
      { section: previous, turn: { turnId: 'request-old', messages: [{ messageId: 'site-old-answer', stable: true, rawText: 'Previous answer', renderedHtml: '' }] } },
      { section: next, turn: { turnId: 'request-new', messages: [{ messageId: 'site-new-answer', stable: true, rawText: 'New answer beginning', renderedHtml: '' }] } }
    ]);
    live.hook.observe();
    live.hook.renderStreams();

    expect(overwriteStream(previous)?.querySelector('.clf-stream-assistant_message')?.textContent).toContain('Previous answer');
    expect(overwriteStream(next)).toBeNull();
    expect(next.textContent).not.toContain('Previous answer');
  });

  it('reattaches the same recorded stream after React replaces the assistant section', async () => {
    live = await harness(undefined, { activity });
    renderingOn();
    const first = assistantTurn(live.document, turnId, []);
    await bindFiberRequest(first, 'wfr-app-stream');
    live.hook.renderStreams();
    expect(overwriteStream(first)).not.toBeNull();

    first.remove();
    const replacement = assistantTurn(live.document, turnId, []);
    // A replacement DOM node is not allowed to inherit a bare descriptor index from the
    // previous scan. Let the next real scan stamp the replacement with its own frame token,
    // then the same stable request id proves that the durable stream belongs here again.
    await bindFiberRequest(replacement, 'wfr-app-stream');
    live.hook.renderStreams();

    expect(overwriteStream(replacement) ? [overwriteStream(replacement)] : []).toHaveLength(1);
    expect(overwriteText(replacement)).toContain('Read second.ts');
    expect(overwriteText(replacement)).toContain('Read third.ts');
  });

  it('keeps the visible overwrite before the next user message when React moves its native assistant host', async () => {
    live = await harness(undefined, { activity });
    renderingOn();
    const section = assistantTurn(live.document, turnId, []);
    await bindFiberRequest(section, 'wfr-app-stream');
    live.hook.renderStreams();

    const root = overwriteStream(section)!;
    const thread = live.document.querySelector('#thread')!;
    expect(root).toBeTruthy();
    expect(root.parentElement).toBe(thread);
    expect(root.parentElement).not.toBe(section);

    const user = userTurn(live.document, 'user-after-overwrite', 'newer user message');
    expect(Boolean(root.compareDocumentPosition(user) & live.window.Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);

    // The live page briefly does this while reconciling split/reused assistant sections: the
    // native section crosses the freshly mounted user row, then moves back. The synthetic
    // answer must not ride inside that React-owned node and flash below the user's message.
    thread.append(section);
    expect(Boolean(root.compareDocumentPosition(user) & live.window.Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);

    live.hook.renderStreams();
    expect(overwriteStream(section)).toBe(root);
    expect(Boolean(root.compareDocumentPosition(user) & live.window.Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it('keeps an older stream before the user while it updates, then mounts a truly later transcription after that user', async () => {
    const pageTurnId = 'request-reused-presentation-order';
    let phase: 'old' | 'old-updated' | 'new' = 'old';
    const orderedActivity = () => ({
      ok: true,
      data: {
        entries: [],
        stream: [
          { seq: 1, time: 100, kind: 'turn_start', turnId: 'g-order-old', agent: null },
          {
            seq: 2,
            time: 120,
            kind: 'assistant_message',
            turnId: 'g-order-old',
            messageId: 'site-order-old',
            text: phase === 'old' ? 'Older answer still streaming' : 'Older answer final transcription',
            final: phase !== 'old'
          },
          ...(phase === 'new'
            ? [
                {
                  // This is the live missing edge: canonical assistant capture can arrive before
                  // the local lifecycle has a turn id after React reuses the section. Stable page
                  // message identity is enough to render it, but it must not inherit the previous
                  // response's sibling root merely because the reused DOM node still carries that
                  // root's data-clf-stream-key.
                  seq: 20,
                  time: 220,
                  kind: 'assistant_message',
                  turnId: null,
                  messageId: 'site-order-new',
                  text: 'Truly later assistant transcription',
                  final: true
                }
              ]
            : [])
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: orderedActivity });
    renderingOn();
    const section = assistantTurn(live.document, pageTurnId, []);
    await bindFiberTurns([{
      section,
      turn: {
        turnId: pageTurnId,
        messages: [{ messageId: 'site-order-old', stable: true, rawText: 'Older answer still streaming', renderedHtml: '' }]
      }
    }]);
    await live.hook.pullActivity();
    live.hook.renderStreams();

    const oldRoot = overwriteStream(section)!;
    const oldKey = section.getAttribute('data-clf-stream-key');
    const thread = live.document.querySelector('#thread')!;
    expect(oldRoot).toBeTruthy();
    expect(oldKey).toBeTruthy();

    const user = userTurn(live.document, 'presentation-order-user', 'This is the newer user turn');
    // Model the same transient React move as the existing regression. A late update to the old
    // response must stay in its already-correct sibling before the user instead of riding the
    // native section across the boundary.
    thread.append(section);
    phase = 'old-updated';
    await live.hook.pullActivity();
    await bindFiberTurns([{
      section,
      turn: {
        turnId: pageTurnId,
        messages: [{ messageId: 'site-order-old', stable: true, rawText: 'Older answer final transcription', renderedHtml: '' }]
      }
    }]);
    live.hook.renderStreams();

    expect(overwriteStream(section)).toBe(oldRoot);
    expect(oldRoot.textContent).toContain('Older answer final transcription');
    expect(Boolean(oldRoot.compareDocumentPosition(user) & live.window.Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);

    // React now reuses that same native section for the response caused by the newer user turn.
    // The Fiber/canonical website identity changes before a new local generation id exists.
    // There must be no intermediate paint where the old root above the user is rewritten with
    // the new response, and the reused section must shed the stale old-root association.
    phase = 'new';
    await live.hook.pullActivity();
    await bindFiberTurns([{
      section,
      turn: {
        turnId: pageTurnId,
        messages: [{ messageId: 'site-order-new', stable: true, rawText: 'Truly later assistant transcription', renderedHtml: '' }]
      }
    }]);
    live.hook.renderStreams();

    expect(oldRoot.textContent).toContain('Older answer final transcription');
    expect(oldRoot.textContent).not.toContain('Truly later assistant transcription');
    expect(Boolean(oldRoot.compareDocumentPosition(user) & live.window.Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    const laterRoot = overwriteStream(section)!;
    expect(laterRoot).toBeTruthy();
    expect(laterRoot).not.toBe(oldRoot);
    expect(laterRoot.textContent).toContain('Truly later assistant transcription');
    expect(Boolean(user.compareDocumentPosition(laterRoot) & live.window.Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(section.getAttribute('data-clf-stream-key')).not.toBe(oldKey);
  });

  it('does not hide or inject a virtualized historical remount while the user is scrolling', async () => {
    live = await harness(undefined, { activity });
    renderingOn();
    const first = assistantTurn(live.document, turnId, []);
    await bindFiberRequest(first, 'wfr-app-stream');
    live.hook.renderStreams();
    expect(first.getAttribute('data-clf-turn-replaced')).toBe('1');

    // ChatGPT virtualizes old history by dropping a section and mounting a fresh native copy
    // as it approaches the viewport. Overwrite used to hide that new native subtree and inject
    // a differently-sized synthetic one in the same scroll gesture, changing document height
    // underneath the browser's scroll anchoring.
    first.remove();
    const remount = assistantTurn(live.document, turnId, []);
    await bindFiberRequest(remount, 'wfr-app-stream');
    live.window.dispatchEvent(new live.window.Event('wheel'));

    live.hook.renderStreams();

    expect(remount.getAttribute('data-clf-turn-replaced')).toBeNull();
    expect(overwriteStream(remount)).toBeNull();

    live.advance(live.hook.PRESENTATION_SCROLL_IDLE_MS + 1);
    live.hook.renderStreams();
    expect(remount.getAttribute('data-clf-turn-replaced')).toBe('1');
    expect(overwriteStream(remount)).not.toBeNull();
  });

  it('freezes an already-mounted synthetic stream for the whole user scroll gesture', async () => {
    live = await harness(undefined, { activity });
    renderingOn();
    const section = assistantTurn(live.document, turnId, []);
    await bindFiberRequest(section, 'wfr-app-stream');
    live.hook.renderStreams();
    expect(overwriteStream(section)?.querySelector('.clf-when') ?? null).toBeNull();

    // A render-signature change stands in for the Fiber/activity changes that arrive while
    // ChatGPT is virtualizing history. No root.replaceChildren is allowed during the gesture.
    live.window.dispatchEvent(new live.window.Event('wheel'));
    live.hook.setShowTimes(true);
    live.hook.renderStreams();
    expect(overwriteStream(section)?.querySelector('.clf-when') ?? null).toBeNull();

    live.advance(live.hook.PRESENTATION_SCROLL_IDLE_MS + 1);
    live.hook.renderStreams();
    expect(overwriteStream(section)?.querySelector('.clf-when') ?? null).not.toBeNull();
  });

  it('preserves a visible user-turn viewport anchor when idle Overwrite changes history height', async () => {
    live = await harness(undefined, { activity });
    renderingOn();
    const historical = assistantTurn(live.document, turnId, []);
    const visibleUser = userTurn(live.document, 'viewport-anchor', 'Keep this question under my eyes');
    await bindFiberRequest(historical, 'wfr-app-stream');
    const thread = live.document.querySelector('#thread') as HTMLElement;
    thread.style.overflowY = 'auto';
    Object.defineProperty(thread, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(thread, 'clientHeight', { configurable: true, value: 600 });
    thread.scrollTop = 500;

    // jsdom does not lay elements out, so model the exact browser geometry that reproduced
    // the bug: replacing the historical assistant above this user turn makes its viewport top
    // jump upward by 120px. ChatGPT uses a nested transcript scroller in current builds, so
    // compensation belongs to that scroll root rather than assuming window.scrollY owns it.
    Object.defineProperty(visibleUser, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        top: historical.hasAttribute('data-clf-turn-replaced') ? 100 : 220,
        bottom: historical.hasAttribute('data-clf-turn-replaced') ? 140 : 260,
        left: 0,
        right: 600,
        width: 600,
        height: 40,
        x: 0,
        y: historical.hasAttribute('data-clf-turn-replaced') ? 100 : 220,
        toJSON: () => ({})
      })
    });
    live.hook.renderStreams();

    expect(historical.getAttribute('data-clf-turn-replaced')).toBe('1');
    expect(thread.scrollTop).toBe(380);
  });
});

describe('where the page stream puts an event that was recorded late', () => {
  /** The same shape `src/shared/chronology.ts` is pinned against, run through content.js. */
  const row = (seq: number, time: number, kind: string, turnId: string | null) => ({ seq, time, kind, turnId });

  it('reads a turn in the order it happened, not the order it was appended', async () => {
    live = await harness();
    const read = live.hook
      .chronological([
        row(1, 100, 'turn_start', 't1'),
        row(2, 110, 'progress', 't1'),
        row(3, 150, 'progress', 't1'),
        row(4, 120, 'tool_call', 't1'),
        row(5, 160, 'assistant_message', 't1'),
        row(6, 170, 'turn_end', 't1')
      ])
      .map((entry) => entry.seq);
    expect(read).toEqual([1, 2, 4, 3, 5, 6]);
  });

  it('agrees with the desktop transcript exactly', async () => {
    // Two copies of one contract. If they ever drift, the app and the page disagree about
    // what the user's own session says, and there is no way to tell which one is lying.
    live = await harness();
    const window = [
      row(1, 100, 'turn_start', 't1'),
      row(2, 110, 'progress', 't1'),
      row(3, 150, 'progress', 't1'),
      row(4, 120, 'tool_call', 't1'),
      row(5, 160, 'assistant_message', 't1'),
      row(6, 170, 'turn_end', 't1'),
      row(7, 200, 'user_message', null),
      row(8, 210, 'turn_start', 't2'),
      row(9, 130, 'tool_call', 't1'),
      row(10, 90, 'assistant_message', 'page-turn-old')
    ];
    expect(live.hook.chronological(window).map((entry) => entry.seq)).toEqual(
      chronological(window).map((entry) => entry.seq)
    );
  });

  it('keeps the desktop chronology boundary when a turn start shares a mutable origin position', async () => {
    live = await harness();
    const window = [
      { ...row(10, 100, 'turn_start', 't1'), origin: 5 },
      { ...row(11, 80, 'progress', null), origin: 5 },
      { ...row(12, 90, 'progress', null), origin: 6 },
      { ...row(13, 120, 'turn_end', 't1'), origin: 7 }
    ];
    // The start becomes the inferred open turn only after its canonical position advances.
    // Activating it for the same-origin row would change ordering and diverge from desktop.
    expect(live.hook.chronological(window).map((entry) => entry.seq)).toEqual(
      chronological(window).map((entry) => entry.seq)
    );
  });

  it('gives a delayed call back to the turn that made it after the next turn has opened', async () => {
    live = await harness();
    const groups = live.hook.streamTurnGroups(
      live.hook.chronological([
        row(1, 100, 'turn_start', 'g-one'),
        row(2, 160, 'assistant_message', 'g-one'),
        row(3, 170, 'turn_end', 'g-one'),
        row(4, 210, 'turn_start', 'g-two'),
        row(5, 120, 'tool_call', 'g-one'),
        row(6, 260, 'assistant_message', 'g-two')
      ])
    );

    expect(groups.map((group) => group.id)).toEqual(['g-one', 'g-two']);
    expect(groups[0]!.entries.map((entry) => entry.seq)).toEqual([1, 5, 2, 3]);
    expect(groups[1]!.entries.map((entry) => entry.seq)).toEqual([4, 6]);
  });

  it('refuses a historical answer replayed under a page id into the open turn', async () => {
    // Reload backfill re-reports what the page can see, under ChatGPT's own recycled request
    // ids. Placed by position it lands mid-turn in the live generation; it belongs to no
    // local turn, so it belongs to no group.
    live = await harness();
    const groups = live.hook.streamTurnGroups(
      live.hook.chronological([
        row(1, 100, 'turn_start', 'g-new'),
        row(2, 110, 'progress', 'g-new'),
        row(3, 115, 'assistant_message', 'request-old'),
        row(4, 120, 'tool_call', null),
        row(5, 160, 'assistant_message', 'g-new'),
        row(6, 170, 'turn_end', 'g-new')
      ])
    );

    expect(groups).toHaveLength(1);
    // The unowned tool has no request id, so the renderer no longer guesses a turn for it
    // from time/position alone. Only the locally owned rows remain in the durable group.
    expect(groups[0]!.entries.map((entry) => entry.seq)).toEqual([1, 2, 5, 6]);
  });

  it('moves a late arrival into its slot instead of appending it to the feed', async () => {
    // The incremental case end to end: the cursor delivers the call alone, long after its
    // turn_start, and the page rebuilds the whole window it holds rather than trusting the
    // order the response arrived in.
    const turnId = 'g-late';
    // Flipped explicitly rather than counted: the harness pulls once on boot, so a counter
    // would deliver the late row before the test had asked for it.
    let late = false;
    const activity = () => ({
        ok: true,
        data: {
          entries: [],
          stream: !late
              ? [
                  { seq: 1, time: 100, kind: 'turn_start', turnId, agent: null },
                  { seq: 2, time: 110, kind: 'progress', turnId, agent: null, text: 'Checking the repository' },
                  { seq: 3, time: 150, kind: 'progress', turnId, agent: null, text: 'Writing it up' },
                  { seq: 4, time: 170, kind: 'assistant_message', turnId, agent: null, messageId: 'site-late-anchor', text: 'Final answer', final: true }
                ]
              : [
                  {
                    seq: 500,
                    time: 120,
                    kind: 'tool_call',
                    turnId,
                    agent: null,
                    tool: 'read_file',
                    callId: 'call-late',
                    outcome: 'ok',
                    durationMs: 3,
                    summary: { kind: 'read', tone: 'neutral', title: 'Read second.ts' }
                  }
                ],
          job: null
        }
      });

    live = await harness(undefined, { activity });
    renderingOn();
    const section = assistantTurn(live.document, turnId, []);
    await bindFiberTurns([{ section, turn: {
      turnId,
      messages: [{ messageId: 'site-late-anchor', stable: true, rawText: 'Final answer', renderedHtml: '' }]
    } }]);

    await live.hook.pullActivity();
    live.hook.renderStreams();
    const before = overwriteRows(section, '.clf-stream-row .clf-stream-text').map((node) =>
      (node.textContent || '').trim()
    );
    expect(before).toEqual(['Turn started', 'Checking the repository', 'Writing it up', 'Final answer']);

    late = true;
    await live.hook.pullActivity();
    live.hook.renderStreams();
    const after = overwriteRows(section, '.clf-stream-row .clf-stream-text').map((node) =>
      (node.textContent || '').trim()
    );
    expect(after).toEqual(['Turn started', 'Checking the repository', 'Read second.ts', 'Writing it up', 'Final answer']);
  });

});

describe('navigating from one chat to another', () => {
  const CHAT_B = 'https://chatgpt.com/c/bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

  it('does not file the old chat’s still-rendered messages into the new conversation', async () => {
    live = await harness();
    userTurn(live.document, 'turn-a1', 'the first chat’s question');
    assistantTurn(live.document, 'turn-a2', []);
    live.hook.observe();
    await settle();

    const before = emitted(live.sent, 'user_message');
    expect(before.map((entry) => entry.event.text)).toEqual(['the first chat’s question']);
    expect(before[0]!.conversationId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    // The URL moves first and React has not replaced anything yet: chat A's transcript is
    // still the DOM. This is the ordering that used to re-emit every visible message under
    // B's id, because resetConversation() had just cleared the seen-message set.
    live.dom.reconfigure({ url: CHAT_B });
    live.hook.observe();
    await settle();

    expect(emitted(live.sent, 'user_message')).toHaveLength(1);
    expect(live.sent.filter((message) => message.type === 'closed')).toHaveLength(1);
  });

  it('records the new chat’s own messages once its DOM actually arrives', async () => {
    live = await harness();
    userTurn(live.document, 'turn-a1', 'the first chat’s question');
    live.hook.observe();
    await settle();

    live.dom.reconfigure({ url: CHAT_B });
    live.hook.observe();
    await settle();

    // React catches up: A's section goes, B's arrives.
    live.document.querySelector('[data-turn-id="turn-a1"]')!.remove();
    userTurn(live.document, 'turn-b1', 'the second chat’s question');
    live.hook.observe();
    await settle();

    const messages = emitted(live.sent, 'user_message');
    expect(messages.map((entry) => entry.event.text)).toEqual([
      'the first chat’s question',
      'the second chat’s question'
    ]);
    expect(messages[1]!.conversationId).toBe('bbbbbbbb-cccc-dddd-eeee-ffffffffffff');
  });

  /**
   * The opposite ordering must not regress. If React replaces the transcript before the
   * URL changes, none of the visible sections were ever watched under the old chat, so
   * there is nothing to retire — and the new chat's opening message, which is the one
   * thing this pipeline exists to keep, is recorded normally.
   */
  it('keeps the new chat’s opening message when the DOM is replaced before the URL changes', async () => {
    live = await harness();
    userTurn(live.document, 'turn-a1', 'the first chat’s question');
    live.hook.observe();
    await settle();

    live.document.querySelector('[data-turn-id="turn-a1"]')!.remove();
    userTurn(live.document, 'turn-b1', 'the second chat’s question');
    live.dom.reconfigure({ url: CHAT_B });
    live.hook.observe();
    await settle();

    const messages = emitted(live.sent, 'user_message');
    expect(messages.map((entry) => entry.event.text)).toEqual([
      'the first chat’s question',
      'the second chat’s question'
    ]);
    expect(messages[1]!.conversationId).toBe('bbbbbbbb-cccc-dddd-eeee-ffffffffffff');
  });

  /**
   * `resetConversation()` clears state, but a request already in flight is not state. The
   * reply lands afterwards and used to be applied to whatever chat was current by then.
   */
  it('throws away an activity reply that was requested for the chat it has left', async () => {
    let release: (() => void) | null = null;
    live = await harness('https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', {
      activity: (message) => {
        if (message.conversationId !== 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee') {
          return { ok: true, data: { entries: [], job: null } };
        }
        // Chat A's reply, held open until the tab has already moved to chat B.
        return new Promise((resolve) => {
          release = () =>
            resolve({
              ok: true,
              data: {
                entries: [call({ turnId: 'turn-a1', seq: 1, summary: { kind: 'read', tone: 'neutral', title: 'Read from chat A' } })],
                job: { busy: true, stage: 'opening', error: null },
                bootstrap: 'resume'
              }
            });
        });
      }
    });
    const section = assistantTurn(live.document, 'turn-a1', ['Called tool!']);

    const pull = live.hook.pullActivity();
    await settle();
    expect(release).not.toBeNull();

    // The tab moves while chat A's reply is still outstanding.
    live.dom.reconfigure({ url: CHAT_B });
    live.hook.observe();
    await settle();

    release!();
    await pull;
    await settle();

    // Nothing from chat A may reach chat B: not its labels on the rows still on screen,
    // not its resume job, not its compaction state, not its bootstrap fold.
    expect(labels(section)).toEqual(['Called tool']);
    expect(
      live.hook.controlState({
        job: null,
        connected: true,
        conversationId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
        pressedAt: 0,
        error: '',
        now: Date.now()
      }).label
    ).toBe('Compact');
  });
});

/**
 * What a turn's outcome is allowed to rest on.
 *
 * `turn_end` is not decoration: compaction and the resume handoff read it to decide
 * whether the last turn's work still needs doing. A turn recorded as `completed` when it
 * produced nothing is worse than no record at all, because it is believed.
 */
describe('generation identity while ChatGPT mounts and reorders assistant sections', () => {
  it('waits for the new section instead of reusing the previous turn when STOP appears first', async () => {
    live = await harness();
    const old = assistantTurn(live.document, 'turn-old', []);
    live.hook.observe();
    await settle();

    // Global generation state changes first. The only assistant section is still history.
    //
    // The turn is announced straight away, and it is announced under an id this script
    // minted. Both halves are deliberate. Waiting for a ChatGPT turn id meant a generation
    // whose section had not mounted yet was never announced at all — and the app places a
    // tool call by asking which conversation is mid-turn, so the turns that call tools
    // fastest were exactly the ones it could not place. Minting the id locally is what
    // makes it mean one generation: the page reuses `data-turn-id` turn after turn.
    startGenerating(live.document);
    live.hook.observe();
    await settle();
    const starts = emitted(live.sent, 'turn_start');
    expect(starts).toHaveLength(1);
    const generation = starts[0]!.event.turnId as string;
    expect(generation).toMatch(/^g-[a-z0-9]+-\d+-\d+$/);

    // What is still withheld is the *binding*: no section has been claimed for this
    // generation yet, so no canonical Fiber message/activity has been filed as its work.
    expect(emitted(live.sent, 'assistant_message')).toHaveLength(0);
    expect(emitted(live.sent, 'page_tool')).toHaveLength(0);

    // React catches up with the actual new assistant section. The DOM change proves which
    // section is live; the durable content itself comes only from the canonical Fiber model.
    const fresh = assistantTurn(live.document, 'turn-new', []);
    const authored = live.document.createElement('div');
    authored.setAttribute('data-interrupted', 'false');
    authored.textContent = 'new turn progress';
    fresh.append(authored);
    live.hook.observe();
    await settle();
    const descriptor = {
      turnId: 'turn-new',
      calls: [],
      messages: [{
        messageId: 'site-new-turn',
        stable: true,
        rawText: 'new turn progress',
        renderedHtml: '<p>new turn progress</p>'
      }],
      activities: [{ messageId: 'thought-new-turn', label: 'Inspecting the new turn' }]
    };
    await bindFiberTurns([{ section: fresh, turn: descriptor }]);
    await live.hook.flush();
    await settle();

    expect(emitted(live.sent, 'turn_start').map((entry) => entry.event.turnId)).toEqual([generation]);
    expect(emitted(live.sent, 'assistant_message').at(-1)!.event).toMatchObject({
      turnId: generation,
      messageId: 'site-new-turn',
      text: 'new turn progress'
    });
    expect(emitted(live.sent, 'page_tool').at(-1)!.event).toMatchObject({
      turnId: generation,
      messageId: 'thought-new-turn',
      text: 'Inspecting the new turn'
    });

    // The old section becomes last in DOM order later. Canonical updates must stay pinned to
    // the generation we already opened rather than following "whatever assistant is last".
    const misleading = live.document.createElement('div');
    misleading.setAttribute('data-interrupted', 'false');
    misleading.textContent = 'old misleading progress';
    old.append(misleading);
    live.document.querySelector('#thread')!.append(old);
    authored.textContent = 'new turn progress updated';
    live.hook.observe();
    await settle();
    await bindFiberTurns([{ section: fresh, turn: {
      ...descriptor,
      messages: [{
        messageId: 'site-new-turn',
        stable: true,
        rawText: 'new turn progress updated',
        renderedHtml: '<p>new turn progress updated</p>'
      }],
      activities: [{ messageId: 'thought-new-turn', label: 'Inspected the new turn' }]
    } }]);
    await live.hook.flush();
    await settle();

    expect(emitted(live.sent, 'assistant_message').at(-1)!.event).toMatchObject({
      turnId: generation,
      messageId: 'site-new-turn',
      text: 'new turn progress updated'
    });
    expect(emitted(live.sent, 'page_tool').at(-1)!.event).toMatchObject({
      turnId: generation,
      messageId: 'thought-new-turn',
      text: 'Inspected the new turn'
    });
    expect(emitted(live.sent, 'assistant_message').every((entry) => entry.event.turnId === generation)).toBe(true);
    expect(emitted(live.sent, 'page_tool').every((entry) => entry.event.turnId === generation)).toBe(true);
  });

  /**
   * ChatGPT writes the new turn's commentary into a section that was already on screen.
   *
   * Binding is by evidence: a section that was there before the generation began only
   * becomes this generation's if the page has written into it since. What counts as
   * "written into" is the whole question. The signature used to be the final `.markdown`
   * prose plus a count of tool rows, and visible commentary is neither — it lives in the
   * outermost `[data-interrupted]` roots. So a turn that opened with commentary and had
   * not yet produced prose or called anything changed nothing the signature could see, the
   * generation stayed unbound, and every caption the user watched was lost.
   */
  it('binds a generation to a section it has only written commentary into', async () => {
    live = await harness();
    const section = assistantTurn(live.document, 'turn-existing', []);
    const settled = live.document.createElement('div');
    settled.className = 'markdown';
    settled.textContent = 'the answer this section already held';
    section.append(settled);

    // The baseline: at the end of this tick the section is history.
    live.hook.observe();
    await settle();

    startGenerating(live.document);
    const commentary = live.document.createElement('div');
    commentary.setAttribute('data-interrupted', 'false');
    commentary.textContent = 'Looking through the log';
    section.append(commentary);
    live.hook.observe();
    await settle();

    const starts = emitted(live.sent, 'turn_start');
    expect(starts).toHaveLength(1);
    const generation = starts[0]!.event.turnId as string;
    // The DOM headline only identifies which section changed. Its stable durable identity and
    // label come from Fiber's thought object, which is the current recorder contract.
    await bindFiberTurns([{ section, turn: {
      turnId: 'turn-existing',
      activities: [{ messageId: 'thought-commentary-only', label: 'Looking through the log' }]
    } }]);
    await live.hook.flush();
    await settle();
    expect(emitted(live.sent, 'page_tool').at(-1)!.event).toMatchObject({
      turnId: generation,
      messageId: 'thought-commentary-only',
      text: 'Looking through the log'
    });
  });

  /**
   * The other half of the same rule, and the reason it cannot simply read `textContent`.
   *
   * This extension rewrites the visible label of a tool row itself. If that rewrite counted
   * as the page having written into the section, our own relabel would be the evidence that
   * binds a stale section to the new generation — and every row already in it would then be
   * reported as this turn's activity. The signature is taken from page-authored content
   * only: our surfaces are stripped and the tool rows are removed before the text is read,
   * so what a row is *called* cannot move a generation.
   */
  it('does not bind a generation to a section merely because this app renamed a row in it', async () => {
    live = await harness();
    const section = assistantTurn(live.document, 'turn-relabelled', ['Searched the web']);
    const settled = live.document.createElement('div');
    settled.className = 'markdown';
    settled.textContent = 'the answer this section already held';
    section.append(settled);

    live.hook.observe();
    await settle();

    startGenerating(live.document);
    // Exactly what paint() does to a row it can name: the label text is replaced in place.
    const label = section.querySelector('.text-start') as HTMLElement;
    label.textContent = 'read_file';
    label.classList.add('clf-tool-title');
    live.hook.observe();
    await settle();

    // The generation opened — that is unconditional and deliberate — but it claimed no
    // section, so nothing already in this one was filed as its work.
    expect(emitted(live.sent, 'turn_start')).toHaveLength(1);
    expect(emitted(live.sent, 'page_tool')).toHaveLength(0);
    expect(emitted(live.sent, 'progress')).toHaveLength(0);
  });

  it('never records the extension-owned stream back as new canonical ChatGPT activity', async () => {
    live = await harness();
    startGenerating(live.document);
    const turn = assistantTurn(live.document, 'turn-loop', []);
    const reasoning = live.document.createElement('div');
    reasoning.setAttribute('data-interrupted', 'false');
    reasoning.textContent = 'Native progress';
    turn.append(reasoning);

    live.hook.observe();
    await settle();
    await bindFiberTurns([{ section: turn, turn: {
      turnId: 'turn-loop',
      activities: [{ messageId: 'thought-loop', label: 'Native progress' }]
    } }]);
    await live.hook.flush();
    await settle();
    expect(emitted(live.sent, 'page_tool').map((entry) => entry.event.text)).toEqual(['Native progress']);

    const synthetic = live.document.createElement('div');
    synthetic.className = 'clf-stream';
    synthetic.textContent = 'Native progress Synthetic copy Synthetic copy';
    reasoning.append(synthetic);
    live.hook.observe();
    await settle();

    // Adding our own renderer must not look like the page emitted another canonical object.
    expect(emitted(live.sent, 'page_tool').map((entry) => entry.event.text)).toEqual(['Native progress']);
    expect(emitted(live.sent, 'assistant_message')).toHaveLength(0);
  });

  /**
   * The live corruption this whole redesign was reported for, byte for byte.
   *
   * Recorded as `seq15` of a real session: the streaming buffer and the rendered copy of
   * the same sentence, run together on **one line with no newline between them**. Every
   * deduper that compares whole lines — the one this replaced, and the recorder's union
   * check — sees a single unfamiliar string and stores it as authored commentary. The
   * user then reads their own assistant saying half a sentence twice.
   *
   * What is kept is the *second* copy, because the buffer is always the shorter, earlier
   * half, and it is kept as the page wrote it rather than rebuilt.
   */
  /**
   * The same artefact, but the page got several passes in rather than two.
   *
   * Recorded live as `seq25`-`seq29` of session `2026-08-17-da2de453`: the container held the
   * paragraph it was replacing alongside the replacement on every tick, so one interim message
   * arrived as a chain of ever-longer prefixes of itself, run together on one line. Only an
   * exact `A + A` was recognised before, and no link of that chain is one, so the whole thing
   * was stored — and the user read their assistant restarting the same sentence four times.
   */
  /**
   * And the invariant that keeps the collapse above from eating real prose.
   *
   * A repeated opening is only a double-write if it is long. Commentary legitimately
   * restates a short phrase — "Reading the log. Reading the log for the second failure" is
   * a sentence, not a rendering artefact — and a collapse that swallowed it would delete
   * text the user actually saw, which is worse than the duplication it is fixing.
   */
});

/**
 * The stop button is not a continuous signal.
 *
 * Every case here is taken from session `2026-08-17-d1354db2`, where the observer read a
 * missing stop button as a finished turn and split single assistant runs into two and three
 * generations: `turn_start` at seq 342 and `turn_end` 432 ms later with `outcome: "unknown"`,
 * the run reopening at 347; the same shape at 357/358/360 across a 2.7 s gap; again at
 * 249/251. `unknown` is what nothing-actually-ended looks like — no answer, no error, no
 * stall. The damage lands in the app: `turn_end` clears the live turn and its pending
 * evidence, so 54 of that session's own connector calls graded `inferred` and went to
 * "Unattributed activity", the first of them 194 ms after the premature end.
 */
describe('a stop button that goes missing while the turn is still running', () => {
  const dropout = async (ticks: number): Promise<void> => {
    stopGenerating(live!.document);
    for (let tick = 0; tick < ticks; tick++) {
      live!.hook.observe();
      await settle();
    }
    startGenerating(live!.document);
    live!.hook.observe();
    await settle();
  };

  it('does not end the turn when the button vanishes for a single observation', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-flicker', []);
    live.hook.observe();
    await settle();

    await dropout(1);

    expect(emitted(live.sent, 'turn_start')).toHaveLength(1);
    expect(emitted(live.sent, 'turn_end')).toHaveLength(0);
  });

  /**
   * The mutation-driven case, which is the one a counter of observations cannot catch.
   * watchTranscript() runs observe() from a MutationObserver microtask, and the rerender
   * that unmounts the stop button is itself a burst of transcript mutations — so the quiet
   * observations arrive back to back within the same millisecond. Only a clock can tell
   * that apart from four seconds of silence.
   */
  it('does not end the turn when many observations land inside the dropout', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-rerender', []);
    live.hook.observe();
    await settle();

    await dropout(12);

    expect(emitted(live.sent, 'turn_start')).toHaveLength(1);
    expect(emitted(live.sent, 'turn_end')).toHaveLength(0);
  });

  it('does not call interim assistant prose completed during a long stop-control dropout', async () => {
    live = await harness();
    startGenerating(live.document);
    const section = assistantTurn(live.document, 'turn-interim-prose-dropout', []);
    const interim = live.document.createElement('div');
    interim.className = 'markdown';
    interim.textContent = 'I found the first issue; checking the rest now.';
    section.append(interim);
    live.hook.observe();
    await settle();
    const opened = emitted(live.sent, 'turn_start')[0]!.event.turnId;

    // The actual live bug requires stronger evidence than the DOM alone: ChatGPT's page
    // model is present and explicitly has public assistant prose without a terminal
    // end_turn message. Once Fiber exists, that nonterminal state must outrank the Stop
    // control disappearing for longer than the settle window.
    await replyFiber([], [{
      turnId: 'turn-interim-prose-dropout',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      endMessageId: null,
      calls: [],
      messages: [{
        messageId: 'site-interim-prose-dropout',
        stable: true,
        rawText: 'I found the first issue; checking the rest now.',
        renderedHtml: '<p>I found the first issue; checking the rest now.</p>'
      }],
      activities: []
    }]);
    await settle();

    stopGenerating(live.document);
    live.hook.observe();
    await settle();
    live.advance(live.hook.TURN_SETTLE_MS * 2);
    live.hook.observe();
    await settle();

    expect(emitted(live.sent, 'turn_end')).toHaveLength(0);

    section.append(toolBlock(live.document, 'Called tool!'));
    startGenerating(live.document);
    live.hook.observe();
    await settle();
    expect(emitted(live.sent, 'turn_start').map((entry) => entry.event.turnId)).toEqual([opened]);
    expect(emitted(live.sent, 'turn_end')).toHaveLength(0);
  });

  it('does not turn an unexplained stop-control dropout into an unknown turn end', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-tool-phase', []);
    live.hook.observe();
    await settle();
    const opened = emitted(live.sent, 'turn_start')[0]!.event.turnId as string;

    stopGenerating(live.document);
    live.hook.observe();
    await settle();
    live.advance(live.hook.TURN_SETTLE_MS * 3);
    live.hook.observe();
    await settle();

    expect(emitted(live.sent, 'turn_end')).toHaveLength(0);
    // Stop is only presentation. Bringing it back with no terminal Fiber object must resume
    // the exact same local generation, not silently close an `unknown` one and mint another.
    startGenerating(live.document);
    live.hook.observe();
    await settle();
    expect(emitted(live.sent, 'turn_start').map((entry) => entry.event.turnId)).toEqual([opened]);
    expect(emitted(live.sent, 'turn_end')).toHaveLength(0);
  });

  it('ends an unexplained quiet generation when a new user message proves the next turn began', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-before-followup', []);
    live.hook.observe();
    await settle();

    stopGenerating(live.document);
    live.hook.observe();
    await settle();
    userTurn(live.document, 'followup-user', 'one more thing');
    live.hook.observe();
    await settle();

    const ends = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.outcome).toBe('unknown');
  });

  it('splits two user turns even when the old stop disappears and the new stop appears between observations', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-before-fast-followup', []);
    live.hook.observe();
    await settle();
    const firstGeneration = emitted(live.sent, 'turn_start')[0]!.event.turnId;

    // No observer sees a quiet page: the previous run finishes, the follow-up is submitted,
    // and ChatGPT mounts the next stop control before the next tick. Stop-button-only state
    // therefore still says "generating" on both sides of the boundary.
    stopGenerating(live.document);
    userTurn(live.document, 'followup-between-ticks', 'also check this');
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-after-fast-followup', []);
    live.hook.observe();
    await settle();

    const starts = emitted(live.sent, 'turn_start').map((entry) => entry.event.turnId);
    const ends = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    expect(starts).toHaveLength(2);
    expect(starts[0]).toBe(firstGeneration);
    expect(starts[1]).not.toBe(firstGeneration);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.turnId).toBe(firstGeneration);
    expect(ends[0]!.outcome).toBe('unknown');
  });

  it('keeps the same generation for work that arrives after the button comes back', async () => {
    live = await harness();
    startGenerating(live.document);
    const section = assistantTurn(live.document, 'turn-continues', []);
    live.hook.observe();
    await settle();
    const opened = emitted(live.sent, 'turn_start')[0]!.event.turnId as string;

    await dropout(3);

    // Page-authored content proves this is still the same section; stable call/message
    // identity comes from Fiber, never from the generic connector row or DOM text.
    const authored = live.document.createElement('div');
    authored.className = 'markdown';
    authored.textContent = 'Done — the recorder path is fixed.';
    section.append(authored);
    live.hook.observe();
    await settle();
    const active = {
      turnId: 'turn-continues',
      endMessageId: null,
      calls: [{
        messageId: 'fiber-after-dropout-call',
        tool: 'read_file',
        order: 0,
        answered: true,
        requestId: 'wfr-after-dropout'
      }],
      messages: [{
        messageId: 'site-after-dropout',
        stable: true,
        rawText: 'Done — the recorder path is fixed.',
        renderedHtml: '<p>Done — the recorder path is fixed.</p>'
      }],
      activities: [{ messageId: 'thought-after-dropout', label: 'Checked the recorder path' }]
    };
    await bindFiberTurns([{ section, turn: active }]);
    await live.hook.flush();
    await settle();

    expect(emitted(live.sent, 'turn_start').map((entry) => entry.event.turnId)).toEqual([opened]);
    expect(emitted(live.sent, 'tool_evidence').at(-1)!.event.turnId).toBe(opened);
    expect(emitted(live.sent, 'assistant_message').at(-1)!.event.turnId).toBe(opened);
    expect(emitted(live.sent, 'page_tool').at(-1)!.event.turnId).toBe(opened);

    // The same stable website message becomes terminal. Fiber can close it even if the Stop
    // control is still mounted, and it must close the generation that survived the dropout.
    await bindFiberTurns([{ section, turn: { ...active, endMessageId: 'site-after-dropout' } }]);
    await live.hook.flush();
    await settle();
    const ends = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.turnId).toBe(opened);
    expect(ends[0]!.outcome).toBe('completed');
    expect(emitted(live.sent, 'turn_start').map((entry) => entry.event.turnId)).toEqual([opened]);
  });

  it('keeps the turn open when connector UI appears while the stop control is absent', async () => {
    live = await harness();
    startGenerating(live.document);
    const section = assistantTurn(live.document, 'turn-tool-dropout', []);
    live.hook.observe();
    await settle();

    stopGenerating(live.document);
    section.append(toolBlock(live.document, 'Called tool!'));
    live.hook.observe();
    await settle();

    expect(emitted(live.sent, 'turn_end')).toHaveLength(0);
  });

  it('does not treat a transient interrupted marker during a stop dropout as a terminal turn', async () => {
    live = await harness();
    startGenerating(live.document);
    const section = assistantTurn(live.document, 'turn-interrupted-tool-phase', []);
    const progress = live.document.createElement('div');
    progress.setAttribute('data-interrupted', 'true');
    progress.textContent = 'Inspecting the repository';
    section.append(progress);
    live.hook.observe();
    await settle();
    const opened = emitted(live.sent, 'turn_start')[0]!.event.turnId as string;

    // This is the live 2026-08-19 failure shape: Stop vanishes and the reasoning container
    // says interrupted even though the same model turn is about to keep talking and calling
    // tools. Surviving the ordinary settle window must not publish a turn_end.
    stopGenerating(live.document);
    live.hook.observe();
    await settle();
    live.advance(live.hook.TURN_SETTLE_MS * 2);
    live.hook.observe();
    await settle();
    expect(emitted(live.sent, 'turn_end')).toHaveLength(0);

    await replyFiber([], [{
      turnId: 'turn-interrupted-tool-phase',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calls: [{
        messageId: 'fiber-after-interrupted-marker',
        tool: 'read_file',
        order: 0,
        answered: false,
        requestId: 'wfr-after-interrupted-marker'
      }],
      messages: [{
        messageId: 'site-after-interrupted-marker',
        stable: true,
        rawText: 'Still working after the interrupted marker.',
        renderedHtml: '<p>Still working after the interrupted marker.</p>'
      }],
      activities: []
    }]);
    await live.hook.flush();
    await settle();

    expect(emitted(live.sent, 'assistant_message').at(-1)!.event.turnId).toBe(opened);
    expect(emitted(live.sent, 'tool_evidence').at(-1)!.event.turnId).toBe(opened);

    // The marker still carries the correct outcome once a separate, concrete terminal
    // boundary exists. A follow-up user message proves the previous turn has ended.
    userTurn(live.document, 'followup-after-interrupted', 'continue from there');
    live.hook.observe();
    await settle();
    const ends = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.turnId).toBe(opened);
    expect(ends[0]!.outcome).toBe('interrupted');
  });

  it('lets a separate completed-message proof close a turn whose transient interrupted outcome was latched', async () => {
    live = await harness();
    startGenerating(live.document);
    const section = assistantTurn(live.document, 'turn-interrupted-then-proven-final', []);
    section.setAttribute('data-clf-fiber-turn', '0');
    const progress = live.document.createElement('div');
    progress.setAttribute('data-interrupted', 'true');
    progress.textContent = 'Finishing the audit';
    section.append(progress);
    const answer = live.document.createElement('div');
    answer.setAttribute('data-message-id', 'a-interrupted-then-final');
    answer.setAttribute('data-message-author-role', 'assistant');
    const answerBody = live.document.createElement('div');
    answerBody.className = 'markdown';
    answerBody.textContent = 'The final visible answer.';
    answer.append(answerBody);
    section.append(answer);
    live.hook.observe();
    await settle();
    const opened = emitted(live.sent, 'turn_start')[0]!.event.turnId as string;

    // Healthy exact Fiber ownership, all calls settled, but the live page omitted end_turn.
    // This alone is not a boundary while the transient interrupted marker is present.
    await replyFiber([], [{
      turnId: 'turn-interrupted-then-proven-final',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      endMessageId: null,
      calls: [],
      messages: [{
        messageId: 'site-interrupted-then-final',
        rawMessageId: 'a-interrupted-then-final',
        stable: true,
        rawText: 'The final visible answer.',
        renderedHtml: '<p>The final visible answer.</p>'
      }],
      activities: []
    }]);
    stopGenerating(live.document);
    live.hook.observe();
    await settle();
    live.advance(live.hook.TURN_SETTLE_MS * 2);
    live.hook.observe();
    await settle();
    expect(emitted(live.sent, 'turn_end')).toHaveLength(0);

    // The interrupted marker disappears, and ChatGPT independently mounts the action that
    // belongs to a completed assistant message. That is a terminal BOUNDARY. The earlier marker
    // may remain the recorded outcome, but it must no longer be allowed to hold the turn open
    // until the user types another message.
    progress.remove();
    const copy = live.document.createElement('button');
    copy.setAttribute('aria-label', 'Copy message');
    section.append(copy);
    live.hook.observe();
    await settle();

    const ends = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ turnId: opened, outcome: 'interrupted' });
  });

  /**
   * The outcome is read when the button first goes, not when the turn finally closes.
   * A banner ChatGPT clears during the settle window would otherwise turn a failed turn
   * into an `unknown` one — the settle window must delay the verdict, never change it.
   */
  it('still records the failure a turn ended with, dismissed during the settle window', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-failed', []);
    live.hook.observe();
    await settle();

    const banner = alertBanner(live.document, 'Message delivery timed out. Please try again.');
    stopGenerating(live.document);
    live.hook.observe();
    await settle();
    banner.remove();
    live.advance(live.hook.TURN_SETTLE_MS);
    live.hook.observe();
    await settle();

    const ends = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.outcome).toBe('failed');
    expect(ends[0]!.detail).toBe('Message delivery timed out. Please try again.');
  });

  it('ends a genuinely finished turn exactly once', async () => {
    live = await harness();
    startGenerating(live.document);
    const section = assistantTurn(live.document, 'turn-done', []);
    const answer = live.document.createElement('div');
    answer.className = 'markdown';
    answer.textContent = 'All done.';
    section.append(answer);
    live.hook.observe();
    await settle();

    await settleTurn(live);
    // And the quiet page keeps being observed, as it is on a live tab.
    for (let tick = 0; tick < 5; tick++) {
      live.advance(live.hook.TURN_SETTLE_MS);
      live.hook.observe();
      await settle();
    }

    const ends = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.outcome).toBe('completed');
  });

  it('closes from Fiber end_turn once even when ChatGPT leaves the Stop button stuck', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-fiber-ended', []);
    live.hook.observe();
    await settle();

    await replyFiber([], [{
      turnId: 'turn-fiber-ended',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      endMessageId: 'site-final-ended',
      calls: [],
      messages: [{
        messageId: 'site-final-ended',
        stable: true,
        rawText: 'Finished from the page model.',
        renderedHtml: '<p>Finished from the page model.</p>'
      }],
      activities: []
    }]);
    await settle();
    await live.hook.flush();
    await settle();

    // Stop is intentionally still mounted. Repeated observations must not reopen the same
    // terminal website turn as fresh local generations.
    for (let tick = 0; tick < 4; tick++) {
      live.hook.observe();
      await settle();
    }
    expect(emitted(live.sent, 'turn_start')).toHaveLength(1);
    const ended = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    expect(ended).toHaveLength(1);
    expect(ended[0]!.outcome).toBe('completed');

    // A real new user message is concrete next-turn evidence and releases the terminal latch
    // even if the stale Stop control has still not disappeared.
    userTurn(live.document, 'after-fiber-ended', 'next question');
    assistantTurn(live.document, 'turn-after-fiber-ended', []);
    live.hook.observe();
    await settle();
    expect(emitted(live.sent, 'turn_start')).toHaveLength(2);
  });

  it('releases the stale-Stop terminal latch when Fiber shows a newer retry attempt', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-fiber-retry', []);
    live.hook.observe();
    await settle();

    await replyFiber([], [{
      turnId: 'turn-fiber-retry',
      endMessageId: 'site-old-final',
      calls: [],
      messages: [{ messageId: 'site-old-final', stable: true, rawText: 'Old final.', renderedHtml: '' }],
      activities: []
    }]);
    await settle();
    await live.hook.flush();
    expect(emitted(live.sent, 'turn_start')).toHaveLength(1);
    expect(emitted(live.sent, 'turn_end')).toHaveLength(1);

    // Stop is still mounted, but the current website turn now has a newer active public
    // message and therefore no endMessageId. The terminal probe must release the old latch.
    await replyFiber([], [{
      turnId: 'turn-fiber-retry',
      endMessageId: null,
      calls: [],
      messages: [{ messageId: 'site-retry-active', stable: true, rawText: 'Trying again.', renderedHtml: '' }],
      activities: []
    }], { pageTurnId: 'turn-fiber-retry', terminalProbe: 'site-old-final' });
    live.hook.observe();
    await settle();

    expect(emitted(live.sent, 'turn_start')).toHaveLength(2);
  });

  it('treats fresh app activity for the exact local turn as liveness evidence', async () => {
    let stream: any[] = [];
    live = await harness(undefined, {
      activity: () => ({ ok: true, data: { entries: [], stream, nextSince: 0, pendingTools: 0 } })
    });
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-live-tooling', []);
    live.hook.observe();
    await settle();
    const local = emitted(live.sent, 'turn_start')[0]!.event.turnId;

    live.advance(live.hook.STALL_MS + 1);
    stream = [{ seq: 100, time: Date.now(), kind: 'tool_call', turnId: local, callId: 'live-call', tool: 'read', outcome: 'ok' }];
    await live.hook.pullActivity();
    live.hook.observe();
    await settle();
    expect(emitted(live.sent, 'chat_error').map((entry) => entry.event.text)).not.toContain(
      'No visible progress for ten minutes. The turn is still marked as generating.'
    );
  });

  it('does not let historical activity keep an unrelated live turn from stalling', async () => {
    let stream: any[] = [];
    live = await harness(undefined, {
      activity: () => ({ ok: true, data: { entries: [], stream, nextSince: 0, pendingTools: 0 } })
    });
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-live-no-progress', []);
    live.hook.observe();
    await settle();

    live.advance(live.hook.STALL_MS + 1);
    stream = [{ seq: 101, time: Date.now(), kind: 'tool_call', turnId: 'some-old-turn', callId: 'old-call', tool: 'read', outcome: 'ok' }];
    await live.hook.pullActivity();
    live.hook.observe();
    await settle();
    expect(emitted(live.sent, 'chat_error').map((entry) => entry.event.text)).toContain(
      'No visible progress for ten minutes. The turn is still marked as generating.'
    );
  });

  /**
   * The user pressing stop is not a signal that needs corroborating, and a composer that
   * stays disabled for four more seconds because the app is being careful is its own bug.
   */
  it('closes at once when the user stopped the turn', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-stopped', ['partial answer before stop']);
    live.hook.observe();
    await settle();

    const stop = live.document.querySelector('[data-testid="stop-button"]')!;
    stop.dispatchEvent(new live.window.MouseEvent('click', { bubbles: true }));
    stopGenerating(live.document);
    live.hook.observe();
    await settle();

    const ends = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.outcome).toBe('stopped');
    // Visible partial prose is not a completed answer. If this were final:true and the
    // explicit turn_end got lost on reload, recorder recovery would upgrade the stopped
    // turn to completed.
    expect(emitted(live.sent, 'assistant_message').filter((entry) => entry.event.final === true)).toHaveLength(0);
  });

  /**
   * The tool phase is the dropout: ChatGPT unmounts the stop button while it waits on a
   * connector result, and the result cannot come back after the turn that asked for it
   * ended. A call still in flight therefore holds the window open past its own length.
   */
  it('holds the turn open while a local tool call is still running', async () => {
    live = await harness('https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', {
      activity: () => ({ ok: true, data: { entries: [], stream: [], nextSince: 0, pendingTools: 1 } })
    });
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-tooling', []);
    live.hook.observe();
    await settle();
    await live.hook.pullActivity();
    await settle();

    stopGenerating(live.document);
    live.hook.observe();
    await settle();
    live.advance(live.hook.TURN_SETTLE_MS * 2);
    live.hook.observe();
    await settle();
    expect(emitted(live.sent, 'turn_end')).toHaveLength(0);

    // The call comes back, but that fact alone is not proof the assistant turn ended. A
    // connector phase can finish while ChatGPT is still preparing the next step, so the
    // unknown quiet turn stays open until final/error/stop/new-user evidence appears.
    live.reply.set('activity', () => ({
      ok: true,
      data: { entries: [], stream: [], nextSince: 0, pendingTools: 0 }
    }));
    await live.hook.pullActivity();
    await settle();
    live.hook.observe();
    await settle();
    expect(emitted(live.sent, 'turn_end')).toHaveLength(0);
  });

  it('does not let process-global pendingTools hold a browser turn that has actually completed', async () => {
    live = await harness('https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', {
      activity: () => ({ ok: true, data: { entries: [], stream: [], nextSince: 0, pendingTools: 1 } })
    });
    startGenerating(live.document);
    const section = assistantTurn(live.document, 'turn-complete-with-foreign-pending', []);
    const answer = live.document.createElement('div');
    answer.className = 'markdown';
    answer.textContent = 'This turn is done.';
    section.append(answer);
    live.hook.observe();
    await settle();
    await live.hook.pullActivity();
    await settle();

    // `pendingTools` is app-wide and may belong to another chat. It remains useful to the
    // compaction stop-and-settle path, but ordinary turn lifecycle must use this page's own
    // evidence and close normally.
    await settleTurn(live);
    const ends = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.outcome).toBe('completed');
  });
});

/**
 * Reloading a ChatGPT page in the middle of an assistant turn.
 *
 * The content script dies with the document, `RUN_ID` included — and `RUN_ID` is what makes
 * a generation id unique, so the new document cannot reconstruct the id the old one was
 * using. Session `2026-08-17-d1354db2` shows the result at seq 367/368: the app records
 * "the ChatGPT page detached while generating", and the reloaded page immediately opens
 * `g-1cbg9tk1s87kta-2-3` for a run that was already in flight. One assistant run, two
 * generations, and the app's live-turn evidence reset underneath the calls still running.
 *
 * The app holds the durable half of that identity, so the page asks for it before it
 * observes anything.
 */
describe('a content script reloaded into a turn already in flight', () => {
  const activity = (data: Record<string, unknown>) => ({
    ok: true,
    data: { entries: [], stream: [], nextSince: 0, pendingTools: 0, ...data }
  });

  /** A page that already shows a finished exchange and a turn still being written. */
  const midTurn = (document: Document): void => {
    userTurn(document, 'turn-old-user', 'fix the recorder');
    const settled = assistantTurn(document, 'turn-old', []);
    const answered = document.createElement('div');
    answered.className = 'markdown';
    answered.textContent = 'The recorder is fixed.';
    settled.append(answered);
    userTurn(document, 'turn-live-user', 'and now the reload split');
    assistantTurn(document, 'turn-live', ['Reading content.js']);
    startGenerating(document);
  };

  it('adopts the open turn instead of opening a second one', async () => {
    live = await harness(
      'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      { activity: () => activity({ activeTurnId: 'g-old-run-0-4' }) },
      midTurn
    );

    // The boot handshake has already run by here; this is the first ordinary tick after it.
    live.hook.observe();
    await settle();

    expect(emitted(live.sent, 'turn_start')).toHaveLength(0);
    // Bound before the first observation, so nothing this page load emits is journalled
    // without a conversation to file it under.
    const order = live.sent.map((message) => message.type);
    expect(order.indexOf('bind')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('bind')).toBeLessThan(order.indexOf('events'));
  });

  it('waits for durable turn identity when the first reload activity request misses the app', async () => {
    let attempts = 0;
    live = await harness(
      'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      {
        activity: () => {
          attempts += 1;
          if (attempts === 1) return { ok: false, error: 'app_not_found' };
          return activity({ activeTurnId: 'g-old-run-0-4' });
        }
      },
      midTurn
    );

    // The first boot pull failed. Stop is visible, but that is not permission to mint a new
    // local generation while the app's durable identity question is still unanswered.
    live.hook.observe();
    await settle();
    expect(emitted(live.sent, 'turn_start')).toHaveLength(0);

    // The ordinary activity poll later reaches the app and adopts the exact durable id.
    await live.hook.pullActivity();
    await settle();
    live.hook.observe();
    await settle();

    expect(attempts).toBe(2);
    expect(emitted(live.sent, 'turn_start')).toHaveLength(0);
  });

  it('files everything after the reload under the turn it resumed', async () => {
    live = await harness(
      'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      { activity: () => activity({ activeTurnId: 'g-old-run-0-4' }) },
      midTurn
    );
    live.hook.observe();
    await settle();

    // Modern capture is canonical page-model capture. Feed the same v8 turn descriptor the
    // live Fiber helper would expose after the reload rather than relying on legacy DOM prose
    // / row scraping, which was deliberately removed from the recorder path.
    const base = {
      turnId: 'turn-live',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calls: []
    };
    const interim = {
      messageId: 'reload-interim',
      rawMessageId: 'reload-interim',
      stable: true,
      order: 2,
      rawText: 'Now looking at the turn lifecycle.',
      renderedHtml: '<p>Now looking at the turn lifecycle.</p>'
    };
    await replyFiber([], [{
      ...base,
      messages: [interim],
      activities: [{ messageId: 'reload-activity', label: 'Reading content.js', order: 1 }]
    }]);
    await live.hook.flush();
    await settle();

    await replyFiber([], [{
      ...base,
      endMessageId: 'reload-final',
      messages: [
        interim,
        {
          messageId: 'reload-final',
          rawMessageId: 'reload-final',
          stable: true,
          order: 3,
          rawText: 'Split fixed.',
          renderedHtml: '<p>Split fixed.</p>'
        }
      ],
      activities: [{ messageId: 'reload-activity', label: 'Reading content.js', order: 1 }]
    }]);
    await live.hook.flush();
    await settle();

    for (const kind of ['page_tool', 'assistant_message', 'turn_end']) {
      const turns = new Set(emitted(live.sent, kind).map((entry) => entry.event.turnId));
      expect([kind, [...turns]]).toEqual([kind, ['g-old-run-0-4']]);
    }
    expect(emitted(live.sent, 'assistant_message').map((entry) => entry.event.text)).toEqual([
      'Now looking at the turn lifecycle.',
      'Split fixed.'
    ]);
    // Exactly one end, for the turn the app already had open — not a second one.
    expect(emitted(live.sent, 'turn_end')).toHaveLength(1);
    expect(emitted(live.sent, 'turn_start')).toHaveLength(0);
  });

  it('does not replay the settled part of the transcript as this turn’s output', async () => {
    live = await harness(
      'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      { activity: () => activity({ activeTurnId: 'g-old-run-0-4' }) },
      midTurn
    );
    live.hook.observe();
    await settle();

    // The finished answer above is reported as history, with no local live-turn ownership.
    // The live turn descriptor is intentionally empty here: the regression is specifically
    // that a reload must not re-label already-settled history as output of the adopted turn.
    const turns = [
      {
        turnId: 'turn-old',
        conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        calls: [],
        messages: [{
          messageId: 'reload-history-answer',
          rawMessageId: 'reload-history-answer',
          stable: true,
          order: 1,
          rawText: 'The recorder is fixed.',
          renderedHtml: '<p>The recorder is fixed.</p>'
        }],
        activities: []
      },
      {
        turnId: 'turn-live',
        conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        calls: [],
        messages: [],
        activities: []
      }
    ];
    await replyFiber([], turns);
    await live.hook.flush();
    await settle();
    const answers = emitted(live.sent, 'assistant_message').map((entry) => entry.event);
    expect(answers.map((event) => event.text)).toEqual(['The recorder is fixed.']);
    expect(answers[0]!.turnId).not.toBe('g-old-run-0-4');
    // And it is not re-reported on every later tick either.
    await replyFiber([], turns);
    await live.hook.flush();
    await settle();
    expect(emitted(live.sent, 'assistant_message')).toHaveLength(1);
  });

  it('opens a new turn when the app has none to resume', async () => {
    live = await harness(
      'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      { activity: () => activity({ activeTurnId: null }) },
      midTurn
    );
    live.hook.observe();
    await settle();

    // The case that must not regress: a genuinely new turn with nothing on the app side
    // still has to be announced, or the first turn of every chat goes unrecorded.
    const starts = emitted(live.sent, 'turn_start').map((entry) => entry.event.turnId as string);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatch(/^g-/);
  });

  /**
   * The turn finished during the reload gap.
   *
   * The page comes back with the answer already on screen and no stop button. The app is
   * still holding `g-old` open and would hold it forever if nothing named the answer:
   * recorder.ts recovers a missing `turn_end` only from a final carrying the id of a turn it
   * has open, and a fresh document has no `settledGenerations` entry to supply one.
   *
   * So the turn is resumed anyway and then closed by the ordinary settle window — which is
   * what makes it safe to resume on a page that looks finished, since the next case is
   * indistinguishable from this one at boot.
   */
  const finishedDuringReload = (document: Document): void => {
    const earlier = assistantTurn(document, 'turn-earlier', []);
    const first = document.createElement('div');
    first.className = 'markdown';
    first.textContent = 'An answer from three turns ago.';
    earlier.append(first);
    const settled = assistantTurn(document, 'turn-old', []);
    const answered = document.createElement('div');
    answered.className = 'markdown';
    answered.textContent = 'The recorder is fixed.';
    settled.append(answered);
  };

  it('closes an open turn that finished while the page was reloading, once', async () => {
    live = await harness(
      'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      { activity: () => activity({ activeTurnId: 'g-old-run-0-4' }) },
      finishedDuringReload
    );

    // One quiet DOM sample proves nothing. The durable app turn is adopted first and remains
    // open until the canonical page model identifies the exact public message that ended it.
    live.hook.observe();
    await settle();
    expect(emitted(live.sent, 'turn_end')).toHaveLength(0);
    expect(emitted(live.sent, 'turn_start')).toHaveLength(0);

    const earlier = live.document.querySelector('[data-turn-id="turn-earlier"]') as HTMLElement;
    const settled = live.document.querySelector('[data-turn-id="turn-old"]') as HTMLElement;
    await bindFiberTurns([
      {
        section: earlier,
        turn: {
          turnId: 'turn-earlier',
          messages: [{
            messageId: 'reload-earlier-final', rawMessageId: 'reload-earlier-final', stable: true, order: 1,
            rawText: 'An answer from three turns ago.', renderedHtml: '<p>An answer from three turns ago.</p>'
          }]
        }
      },
      {
        section: settled,
        turn: {
          turnId: 'turn-old',
          endMessageId: 'reload-gap-final',
          messages: [{
            messageId: 'reload-gap-final', rawMessageId: 'reload-gap-final', stable: true, order: 1,
            rawText: 'The recorder is fixed.', renderedHtml: '<p>The recorder is fixed.</p>'
          }]
        }
      }
    ]);
    await live.hook.flush();
    await settle();

    // No turn was invented for history, and the exact terminal website object closes the one
    // durable turn the app already had open. Historical prose never inherits that local id.
    expect(emitted(live.sent, 'turn_start')).toHaveLength(0);
    const ends = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.turnId).toBe('g-old-run-0-4');
    expect(ends[0]!.outcome).toBe('completed');
    const answers = emitted(live.sent, 'assistant_message').map((entry) => entry.event);
    expect(answers.map((entry) => entry.text)).toEqual(['An answer from three turns ago.', 'The recorder is fixed.']);
    expect(answers[0]!.turnId).not.toBe('g-old-run-0-4');
    expect(answers[1]!.turnId).toBe('g-old-run-0-4');

    // And the next real turn is this document's own, not the app's leftover.
    startGenerating(live.document);
    const next = assistantTurn(live.document, 'turn-next', []);
    // A terminal Fiber object deliberately latches until the page model proves a newer
    // response exists. DOM Stop alone is not enough, because ChatGPT can leave it stale.
    next.setAttribute('data-clf-fiber-turn', '0');
    await replyFiber(
      [],
      [{
        turnId: 'turn-next',
        conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        calls: [],
        messages: [{
          messageId: 'reload-next-live', rawMessageId: 'reload-next-live', stable: true, order: 1,
          rawText: 'Next response starting.', renderedHtml: '<p>Next response starting.</p>'
        }],
        activities: []
      }],
      { pageTurnId: 'turn-next', terminalProbe: 'reload-gap-final' }
    );
    live.hook.observe();
    await settle();
    const starts = emitted(live.sent, 'turn_start').map((entry) => entry.event.turnId as string);
    expect(starts).toHaveLength(1);
    expect(starts[0]).not.toBe('g-old-run-0-4');
  });

  /**
   * The same page at boot, and a completely different situation: the stop button was simply
   * missing for a moment while the reloaded page rendered. Resuming on the strength of one
   * sample and publishing the visible prose as the answer would close `g-old` from a turn
   * that is still writing — the reload flavour of the dropout bug, and the reason boot goes
   * through the settle window rather than around it.
   */
  it('does not close a resumed turn whose stop button was only missing while the page rendered', async () => {
    live = await harness(
      'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      { activity: () => activity({ activeTurnId: 'g-old-run-0-4' }) },
      finishedDuringReload
    );

    live.hook.observe();
    await settle();
    const earlier = live.document.querySelector('[data-turn-id="turn-earlier"]') as HTMLElement;
    const active = live.document.querySelector('[data-turn-id="turn-old"]') as HTMLElement;
    const streamingTurns = [
      {
        section: earlier,
        turn: {
          turnId: 'turn-earlier',
          messages: [{
            messageId: 'reload-earlier-final', rawMessageId: 'reload-earlier-final', stable: true, order: 1,
            rawText: 'An answer from three turns ago.', renderedHtml: '<p>An answer from three turns ago.</p>'
          }]
        }
      },
      {
        section: active,
        turn: {
          turnId: 'turn-old',
          messages: [{
            messageId: 'reload-gap-live', rawMessageId: 'reload-gap-live', stable: true, order: 1,
            rawText: 'The recorder is fixed.', renderedHtml: '<p>The recorder is fixed.</p>'
          }]
        }
      }
    ];
    await bindFiberTurns(streamingTurns);
    await live.hook.flush();
    await settle();
    // React finishes mounting and the stop button is there after all.
    startGenerating(live.document);
    live.hook.observe();
    await settle();
    live.advance(live.hook.TURN_SETTLE_MS * 3);
    live.hook.observe();
    await settle();

    expect(emitted(live.sent, 'turn_start')).toHaveLength(0);
    expect(emitted(live.sent, 'turn_end')).toHaveLength(0);
    // The live prose may be journalled as a partial, but it must not be promoted to a final
    // answer merely because Stop was missing during the reload render.
    const beforeFinal = emitted(live.sent, 'assistant_message').map((entry) => entry.event);
    expect(beforeFinal.map((entry) => entry.text)).toEqual(['An answer from three turns ago.', 'The recorder is fixed.']);
    expect(beforeFinal[1]!.turnId).toBe('g-old-run-0-4');
    expect(beforeFinal[1]!.final).toBe(false);

    // It finishes properly once the page model marks that same website message terminal,
    // still under the adopted id and still only once.
    stopGenerating(live.document);
    live.hook.observe();
    await settle();
    await bindFiberTurns([
      streamingTurns[0]!,
      {
        section: active,
        turn: {
          turnId: 'turn-old',
          endMessageId: 'reload-gap-live',
          messages: [{
            messageId: 'reload-gap-live', rawMessageId: 'reload-gap-live', stable: true, order: 1,
            rawText: 'The recorder is fixed.', renderedHtml: '<p>The recorder is fixed.</p>'
          }]
        }
      }
    ]);
    await live.hook.flush();
    await settle();
    const ends = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.turnId).toBe('g-old-run-0-4');
    const afterFinal = emitted(live.sent, 'assistant_message').map((entry) => entry.event);
    expect(afterFinal.at(-1)).toMatchObject({ text: 'The recorder is fixed.', turnId: 'g-old-run-0-4', final: true });
  });
});

describe('how a turn is recorded as having ended', () => {
  const endTurn = async (): Promise<void> => {
    await settleTurn(live!);
  };

  /**
   * Live duplicate, session `2026-08-17-7365eb08` events 20 and 21: one answer, stored
   * twice, 19 ms apart, identical text and identical digest — once under ChatGPT's own
   * reused turn id and once under the local generation. The settling tick reports the
   * messages on both sides of the moment the generation mapping is seeded, and the id is
   * derived from that mapping, so the second pass did not recognise its own first pass.
   */
  it('does not close a silent turn because an earlier turn answered', async () => {
    live = await harness();

    // A first turn that really did answer.
    startGenerating(live.document);
    const first = assistantTurn(live.document, 'turn-1', []);
    const answer = live.document.createElement('div');
    answer.className = 'markdown';
    answer.textContent = 'the answer to the first question';
    first.append(answer);
    live.hook.observe();
    await settle();
    await endTurn();

    // A second turn that produces nothing at all.
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-2', []);
    live.hook.observe();
    await settle();
    await endTurn();

    const ends = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    // Two starts, under two different locally minted ids. The second one has no evidence of
    // completion, so it deliberately remains open rather than manufacturing an `unknown`
    // turn_end from an absent stop control.
    const starts = emitted(live.sent, 'turn_start').map((entry) => entry.event.turnId as string);
    expect(starts).toHaveLength(2);
    expect(new Set(starts).size).toBe(2);
    expect(ends.map((event) => event.turnId)).toEqual([starts[0]]);
    expect(ends[0]!.outcome).toBe('completed');
  });

  it('records a repeated identical error as a second failure rather than suppressing it', async () => {
    live = await harness();
    const TEXT = 'Message delivery timed out. Please try again. Retry';

    startGenerating(live.document);
    assistantTurn(live.document, 'turn-1', []);
    live.hook.observe();
    await settle();
    const firstBanner = alertBanner(live.document, TEXT);
    await endTurn();

    // The banner is dismissed and the user tries again; the same failure happens again.
    firstBanner.remove();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-2', []);
    live.hook.observe();
    await settle();
    alertBanner(live.document, TEXT);
    await endTurn();

    // Two failures happened, so two are recorded — keyed on the occurrence, not the words.
    expect(emitted(live.sent, 'chat_error').map((entry) => entry.event.text)).toEqual([TEXT, TEXT]);
    const ends = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    expect(ends.map((event) => event.outcome)).toEqual(['failed', 'failed']);
  });

  it('ignores the screen-reader live regions ChatGPT announces ordinary UI state through', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-1', []);
    live.hook.observe();
    await settle();

    // All three are `role="alert"`. Only the last one is a failure the user could see; the
    // first two are the announcer, which one recorded run filled with sixty "errors" that
    // never happened.
    const announcer = alertBanner(live.document, 'Reasoning details opened');
    announcer.className = 'sr-only';
    const dictation = alertBanner(live.document, 'Dictation is active and in use');
    dictation.className = 'visually-hidden';
    alertBanner(live.document, 'Something went wrong.');

    live.hook.observe();
    await settle();

    expect(emitted(live.sent, 'chat_error').map((entry) => entry.event.text)).toEqual(['Something went wrong.']);
  });

  it('still reports one rendered occurrence only once, however often it is observed', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-1', []);
    live.hook.observe();
    await settle();
    alertBanner(live.document, 'Something went wrong.');

    for (let pass = 0; pass < 3; pass++) {
      live.hook.observe();
      await settle();
    }

    expect(emitted(live.sent, 'chat_error')).toHaveLength(1);
  });

  it('does not republish a banner ChatGPT simply leaves on screen', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-1', []);
    live.hook.observe();
    await settle();
    // Never dismissed: the same node is still there three turns later.
    alertBanner(live.document, 'Something went wrong.');
    await endTurn();

    for (const id of ['turn-2', 'turn-3']) {
      startGenerating(live.document);
      assistantTurn(live.document, id, []);
      live.hook.observe();
      await settle();
      await endTurn();
    }

    expect(emitted(live.sent, 'chat_error')).toHaveLength(1);
  });

  it('does not blame a turn for an error banner that was already on screen when it began', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-1', []);
    live.hook.observe();
    await settle();
    // The failure belongs to turn-1, and its banner is never dismissed.
    alertBanner(live.document, 'Something went wrong.');
    await endTurn();

    startGenerating(live.document);
    const second = assistantTurn(live.document, 'turn-2', []);
    const answer = live.document.createElement('div');
    answer.className = 'markdown';
    answer.textContent = 'the second turn answered perfectly well';
    second.append(answer);
    live.hook.observe();
    await settle();
    await endTurn();

    const ends = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    expect(ends.map((event) => event.outcome)).toEqual(['failed', 'completed']);
  });
});

/**
 * `pagehide` fires for two very different things: the page going away, and the page being
 * frozen into the back/forward cache to come back shortly. Treating the second as a close
 * ended the session, and the next observation from the same tab reopened it — which is
 * where the Activity log's flood of "session … reopened" came from, ten lines in seventy
 * seconds with five tabs open and nothing actually happening.
 */
describe('a page leaving the screen', () => {
  const pagehide = async (persisted: boolean): Promise<void> => {
    const event = live!.window.document.createEvent('Event');
    event.initEvent('pagehide', false, false);
    Object.defineProperty(event, 'persisted', { value: persisted });
    live!.window.dispatchEvent(event);
    await settle();
  };

  it('does not confuse document unload with a conversation close', async () => {
    live = await harness();
    await pagehide(false);
    // Reload, renderer replacement and an actual tab close all produce pagehide. The
    // service worker owns tab lifetime now, so this document may only flush observations.
    expect(live.sent.filter((message) => message.type === 'closed')).toHaveLength(0);
  });

  it('says nothing when the page is only going into the back/forward cache', async () => {
    live = await harness();
    await pagehide(true);
    expect(live.sent.filter((message) => message.type === 'closed')).toHaveLength(0);
  });
});

/**
 * The bridge to the MAIN-world helper.
 *
 * The helper runs in ChatGPT's own JavaScript context, which means the page can post
 * exactly the messages it posts. So the receiving side is written as a validator, not as
 * a parser of something it trusts, and these tests are mostly about what it refuses.
 */
describe('evidence from the page context', () => {
  const GOOD = {
    v: 10,
    index: 0,
    tool: 'agent_status',
    path: '/TobisComputer/mcp/agent_status',
    app: 'TobisComputer',
    resource: 'resource://tools/agent_status',
    messageId: 'msg-1',
    turnId: 'turn-1',
    conversationId: 'conv-1',
    createTime: 1_700_000_000,
    hidden: 4,
    localCount: 5,
    answered: true
  };

  const reply = replyFiber;

  it('reads a well-formed descriptor', async () => {
    live = await harness();
    expect(live.hook.readDescriptor(GOOD)).toMatchObject({
      index: 0,
      tool: 'agent_status',
      app: 'TobisComputer',
      hidden: 4,
      localCount: 5,
      answered: true
    });
  });

  it('refuses anything that is not the shape it knows', async () => {
    live = await harness();
    const bad: unknown[] = [
      null,
      'not an object',
      // A tab still running the previous helper answers with descriptors built the old
      // way — named after the connector bridge when a payload was truncated, paired with
      // whatever result came back next. Refused outright rather than half-understood.
      { ...GOOD, v: 1 },
      { ...GOOD, v: 2 },
      { ...GOOD, v: undefined },
      { ...GOOD, index: -1 },
      { ...GOOD, index: 1.5 },
      { ...GOOD, index: 999 },
      { ...GOOD, index: '0' },
      // A tool name is put on screen and used as an identity; it may not be arbitrary text.
      { ...GOOD, tool: 'agent status; rm -rf' },
      { ...GOOD, tool: 'x'.repeat(65) }
    ];
    for (const raw of bad) expect(live.hook.readDescriptor(raw), JSON.stringify(raw)).toBeNull();
  });

  it('caps long strings and normalises a nonsense fold count', async () => {
    live = await harness();
    const read = live.hook.readDescriptor({
      ...GOOD,
      path: 'p'.repeat(9000),
      hidden: -5
    })!;
    expect(read.path!.length).toBe(200);
    expect(read.hidden).toBe(0);
  });

  /**
   * Argument values are the user's own text and this app's own secrets — `agent_key` has
   * been observed in the raw request JSON. There is no key-level allowlist that
   * generalises across tools, so none of it crosses at all.
   */
  it('has no field that could carry a tool argument or a secret', async () => {
    live = await harness();
    const read = live.hook.readDescriptor({ ...GOOD, args: { agent_key: 'secret' }, agent_key: 'secret' })!;
    expect(JSON.stringify(read)).not.toContain('secret');
    expect(Object.keys(read).sort()).toEqual(
      [
        'answered',
        'app',
        'conversationId',
        'createTime',
        'hidden',
        'index',
        'localCount',
        'messageId',
        'path',
        'resource',
        'tool',
        'turnId'
      ].sort()
    );
  });

  it('matches a descriptor to the row the helper stamped', async () => {
    live = await harness();
    const section = assistantTurn(live.document, 'turn-1', ['Called tool!']);
    const block = section.querySelector('[aria-label="Open tool call list"]')!;
    block.setAttribute('data-clf-fiber', '0');
    await reply([GOOD]);
    expect(live.hook.fiberFor(block)).toMatchObject({ tool: 'agent_status', hidden: 4 });
  });

  it('never resolves a stale row stamp against a later descriptor frame', async () => {
    live = await harness();
    const section = assistantTurn(live.document, 'turn-stale-scan', ['Called tool!']);
    const block = section.querySelector('[aria-label="Open tool call list"]')!;

    // This row survived React churn from an earlier successful scan. The new frame also uses
    // index 0, which is exactly why a bare numeric stamp used to relabel it as the new call.
    block.setAttribute('data-clf-fiber', 'older-scan:0');
    await replyFiber([{ ...GOOD, tool: 'run_command' }], [], null, false);
    expect(live.hook.fiberFor(block)).toBeNull();

    // Numeric v9-era stamps are equally unusable against a v10 frame. They have no evidence
    // of which scan produced them, so compatibility here would reintroduce the same bug.
    block.setAttribute('data-clf-fiber', '0');
    expect(live.hook.fiberFor(block)).toBeNull();
  });

  it('maps Fiber call evidence onto the local generation id, never ChatGPT’s reused page turn id', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'reused-page-turn', []);
    live.hook.observe();
    await settle();
    const local = emitted(live.sent, 'turn_start')[0]!.event.turnId as string;
    expect(local).toMatch(/^g-/);

    // Two Fiber turns expose the same page turn id, which is exactly the live renderer
    // failure mode. The older occurrence still proves its conversation issued a connector
    // request, but only the newest occurrence matching the currently bound assistant turn is
    // allowed to inherit the local durable generation id.
    await reply([], [
      {
        turnId: 'reused-page-turn',
        calls: [{ messageId: 'old-call', tool: 'read', order: 0, answered: true }]
      },
      {
        turnId: 'reused-page-turn',
        calls: [{ messageId: 'live-call', tool: 'agents', order: 0, answered: false }]
      }
    ]);
    // refreshFiber queues the evidence; the normal observer tick is what journals the queue.
    live.hook.observe();
    await settle();

    const evidence = emitted(live.sent, 'tool_evidence').map((entry) => entry.event);
    expect(evidence).toHaveLength(2);
    expect(evidence[0]!.turnId).toBeUndefined();
    expect(evidence[1]!.turnId).toBe(local);
    expect(evidence.some((entry) => entry.turnId === 'reused-page-turn')).toBe(false);
  });

  it('keeps exact current-chat request evidence when stale Fiber objects from another chat remain mounted', async () => {
    live = await harness();
    const currentConversation = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const staleConversation = '11111111-2222-3333-4444-555555555555';

    await replyFiber(
      [
        { ...GOOD, index: 7, messageId: 'stale-row', conversationId: staleConversation },
        { ...GOOD, index: 8, messageId: 'current-row', conversationId: currentConversation }
      ],
      [
        {
          turnId: 'stale-turn',
          conversationId: staleConversation,
          calls: [
            {
              messageId: 'stale-request-message',
              tool: 'read',
              order: 0,
              answered: true,
              requestId: 'wfr_stale_other_chat',
              createTime: 1_700_000_000
            }
          ],
          messages: []
        },
        {
          turnId: 'current-turn',
          conversationId: currentConversation,
          calls: [
            {
              messageId: 'current-request-message',
              tool: 'exec_command',
              order: 0,
              answered: false,
              requestId: 'wfr_current_exact',
              createTime: 1_700_000_001
            }
          ],
          messages: []
        }
      ]
    );
    await live.hook.flush();

    const evidence = emitted(live.sent, 'tool_evidence').map((entry) => entry.event);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toEqual(
      expect.objectContaining({
        fiberConversationId: currentConversation,
        calls: [
          expect.objectContaining({
            messageId: 'current-request-message',
            requestId: 'wfr_current_exact'
          })
        ]
      })
    );
    expect(evidence.some((entry) => entry.fiberConversationId === staleConversation)).toBe(false);
  });
  it('explicitly confirms a live request against the real chat id while a fresh client thread is still provisional', async () => {
    live = await harness();
    const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const provisionalThread = '11111111-2222-3333-4444-555555555555';
    const requestId = '77186fb4-bdda-4849-8cd7-879bb08a1617';
    live.reply.set('correlate', (_message) => ({
      ok: true,
      status: 200,
      data: {
        ok: true,
        conversationId,
        sessionId: '2026-08-21-test',
        requestIds: [requestId],
        confirmed: [requestId],
        complete: true
      }
    }));

    startGenerating(live.document);
    assistantTurn(live.document, 'fresh-live-turn', []);
    live.hook.observe();
    await settle();

    await replyFiber([], [
      {
        turnId: 'fresh-live-turn',
        // This is the live first-turn race: the route is already /c/<real id>, while the
        // React turn still carries the provisional client thread id.
        conversationId: provisionalThread,
        calls: [
          {
            messageId: 'fresh-request-message',
            tool: 'exec_command',
            order: 0,
            answered: false,
            requestId,
            createTime: 1_700_000_001
          }
        ],
        messages: []
      }
    ]);
    await settle();
    await live.hook.flush();

    const handshakes = live.sent.filter((message) => message.type === 'correlate');
    expect(handshakes).toHaveLength(1);
    expect(handshakes[0]).toMatchObject({
      conversationId,
      calls: [expect.objectContaining({ requestId, messageId: 'fresh-request-message' })]
    });
    const evidence = emitted(live.sent, 'tool_evidence').map((entry) => entry.event);
    const requestEvidence = evidence.find((entry) =>
      Array.isArray(entry.calls) && entry.calls.some((call: any) => call.requestId === requestId)
    );
    expect(requestEvidence).toBeTruthy();
    // Do not send the known-provisional Fiber id as a contradiction. The separate ACKed
    // handshake is what owns this live request; historical turns remain strictly cross-checked.
    expect(requestEvidence).not.toHaveProperty('fiberConversationId');

    // The same Fiber object is reread constantly while streaming. An ACKed request id is a
    // durable fact, so the second scan must not create another ownership request.
    await replyFiber([], [
      {
        turnId: 'fresh-live-turn',
        conversationId: provisionalThread,
        calls: [
          {
            messageId: 'fresh-request-message',
            tool: 'exec_command',
            order: 0,
            answered: false,
            requestId,
            createTime: 1_700_000_001
          }
        ],
        messages: []
      }
    ]);
    await settle();
    expect(live.sent.filter((message) => message.type === 'correlate')).toHaveLength(1);
  });

  it('does not let a stale owned Fiber turn bypass a rejected live ownership handshake', async () => {
    live = await harness();
    const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const staleConversation = '11111111-2222-3333-4444-555555555555';
    const requestId = 'wfr_already_owned_by_stale_chat';
    live.reply.set('correlate', () => ({
      ok: true,
      status: 200,
      data: {
        ok: true,
        conversationId,
        requestIds: [requestId],
        confirmed: [],
        conflicts: [requestId],
        complete: false
      }
    }));

    // This is the dangerous ambiguity behind the live restart repro. The DOM section is the
    // generation this document owns, so the provisional-first-turn exception keeps its Fiber
    // descriptor even though that branch names another concrete conversation. The explicit
    // /correlations handshake can distinguish a harmless provisional client thread from stale
    // history: here it says the request id already belongs elsewhere. Ordinary tool_evidence
    // must not get a second chance to assert the URL conversation after that rejection.
    startGenerating(live.document);
    assistantTurn(live.document, 'stale-owned-turn', []);
    live.hook.observe();
    await settle();

    await replyFiber([], [{
      turnId: 'stale-owned-turn',
      conversationId: staleConversation,
      calls: [{
        messageId: 'stale-owned-request',
        tool: 'exec_command',
        order: 0,
        answered: true,
        requestId,
        createTime: 1_700_000_001
      }],
      messages: []
    }]);
    await settle();
    await live.hook.flush();

    expect(live.sent.filter((message) => message.type === 'correlate')).toEqual([
      expect.objectContaining({
        conversationId,
        calls: [expect.objectContaining({ requestId, messageId: 'stale-owned-request' })]
      })
    ]);
    expect(
      emitted(live.sent, 'tool_evidence').filter((entry) =>
        (entry.event.calls || []).some((call: any) => call.requestId === requestId)
      )
    ).toHaveLength(0);
  });

  it('confirms a live request when the virtualized renderer published no data-turn-id', async () => {
    live = await harness();
    const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const provisionalThread = '11111111-2222-3333-4444-555555555555';
    const requestId = 'wfr_virtualized_turn/0';
    live.reply.set('correlate', () => ({
      ok: true,
      data: { conversationId, sessionId: '2026-08-21-virtualized', confirmed: [requestId], complete: true }
    }));

    startGenerating(live.document);
    // The live 2026-08-21 failure. ChatGPT's virtualized renderer omits `data-turn-id` from a
    // perfectly readable assistant section, and every ownership decision used to be keyed on
    // it: no page turn id meant no owned turn, no owned turn meant this handshake never ran,
    // and the whole conversation's exact request ids were filed under Unattributed activity.
    // fiber.js stamps the sections it scanned, and that stamp is the anchor that survives.
    const section = assistantTurn(live.document, 'virtualized-live-turn', []);
    section.removeAttribute('data-turn-id');
    section.setAttribute('data-clf-fiber-turn', '0');
    live.hook.observe();
    await settle();

    await replyFiber([], [{
      turnId: null,
      conversationId: provisionalThread,
      calls: [{
        messageId: 'virtualized-call',
        tool: 'exec_command',
        order: 0,
        answered: false,
        requestId,
        createTime: 1_700_000_001
      }],
      messages: []
    }]);
    await settle();
    await live.hook.flush();

    expect(live.sent.filter((message) => message.type === 'correlate')).toEqual([
      expect.objectContaining({
        conversationId,
        calls: [expect.objectContaining({ requestId, messageId: 'virtualized-call' })]
      })
    ]);
    const evidence = emitted(live.sent, 'tool_evidence').map((entry) => entry.event);
    const requestEvidence = evidence.find((entry) =>
      Array.isArray(entry.calls) && entry.calls.some((call: any) => call.requestId === requestId)
    );
    expect(requestEvidence).toBeTruthy();
    // The owned turn's provisional client thread is never sent as a contradiction, whether or
    // not the page published an id for it.
    expect(requestEvidence).not.toHaveProperty('fiberConversationId');
  });

  it('confirms a request id ChatGPT published before any tool row existed', async () => {
    const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const requestId = 'wfr_safety_held';
    live = await harness();
    live.reply.set('correlate', () => ({
      ok: true,
      data: { conversationId, confirmed: [requestId], complete: true }
    }));

    // The live 2026-08-21 shape. ChatGPT stamps the request id on the plain public message
    // as soon as the turn issues a connector request and holds the `api_tool` message
    // behind its safety check for tens of seconds — the app gives up after fifteen and
    // files the call under Unattributed activity. The tool name is no part of the
    // request-id -> conversation join, so waiting for one only threw the window away.
    await replyFiber([], [{
      turnId: 'safety-held-turn',
      conversationId,
      calls: [],
      requests: [{ requestId, messageId: 'm-pending', createTime: 1_700_000_001 }],
      messages: []
    }]);
    await settle();

    expect(live.sent.filter((message) => message.type === 'correlate')).toEqual([
      expect.objectContaining({
        conversationId,
        calls: [expect.objectContaining({ requestId, messageId: 'm-pending' })]
      })
    ]);
  });

  it('sends one request id once when it arrives both as a labelled row and as a bare sighting', async () => {
    const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const requestId = 'wfr_both_views';
    live = await harness();
    live.reply.set('correlate', () => ({
      ok: true,
      data: { conversationId, confirmed: [requestId], complete: true }
    }));

    await replyFiber([], [{
      turnId: 'both-views-turn',
      conversationId,
      calls: [{ messageId: 'row-call', tool: 'agents', order: 0, answered: true, requestId, createTime: 1_700_000_001 }],
      requests: [{ requestId, messageId: 'm-pending', createTime: 1_700_000_000 }],
      messages: []
    }]);
    await settle();

    const handshakes = live.sent.filter((message) => message.type === 'correlate');
    expect(handshakes).toHaveLength(1);
    // The labelled row wins, so the app still learns which tool the id belonged to.
    expect(handshakes[0]!.calls).toEqual([expect.objectContaining({ requestId, tool: 'agents' })]);
  });

  it('confirms request ids Fiber attributes to this chat with no live local turn at all', async () => {
    const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const requestId = 'wfr_no_local_turn/2';
    live = await harness();
    live.reply.set('correlate', () => ({
      ok: true,
      data: { conversationId, confirmed: [requestId], complete: true }
    }));

    // Nothing is generating and no turn has settled, so there is no local turn binding to
    // hang ownership on. The descriptor still names exactly the conversation this document
    // is pinned to, which is the whole of what the handshake asserts.
    await replyFiber([], [{
      turnId: 'settled-turn',
      conversationId,
      calls: [{
        messageId: 'settled-call',
        tool: 'agents',
        order: 0,
        answered: true,
        requestId,
        createTime: 1_700_000_001
      }],
      messages: []
    }]);
    await settle();

    expect(live.sent.filter((message) => message.type === 'correlate')).toEqual([
      expect.objectContaining({ conversationId, calls: [expect.objectContaining({ requestId })] })
    ]);
  });

  it('keeps a per-id confirmation the app could not call complete', async () => {
    const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const confirmedId = 'wfr_partial_ok/0';
    const pendingId = 'wfr_partial_pending/0';
    live = await harness();
    live.reply.set('correlate', () => ({
      ok: true,
      // The app placed one id and has not ingested the other yet, so the batch as a whole is
      // not complete. That batch verdict used to discard the confirmation of the id it *did*
      // place, which put both back in the retry queue for as long as the tab stayed open.
      data: { conversationId, confirmed: [confirmedId], complete: false }
    }));
    const scan = () => [{
      turnId: 'partial-turn',
      conversationId,
      calls: [
        {
          messageId: 'partial-call-a',
          tool: 'agents',
          order: 0,
          answered: true,
          requestId: confirmedId,
          createTime: 1_700_000_001
        },
        {
          messageId: 'partial-call-b',
          tool: 'agents',
          order: 1,
          answered: false,
          requestId: pendingId,
          createTime: 1_700_000_002
        }
      ],
      messages: []
    }];

    await replyFiber([], scan());
    await settle();
    expect(live.sent.filter((message) => message.type === 'correlate')).toHaveLength(1);

    // Past the retry backoff: only the id the app never confirmed is asked about again.
    live.advance(5000);
    await replyFiber([], scan());
    await settle();
    const handshakes = live.sent.filter((message) => message.type === 'correlate');
    expect(handshakes).toHaveLength(2);
    expect(handshakes[1]!.calls.map((call: any) => call.requestId)).toEqual([pendingId]);
  });

  it('confirms a fresh-chat request after the turn ended when the real route id arrives late', async () => {
    const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const provisionalThread = '11111111-2222-3333-4444-555555555555';
    const requestId = 'wfr_post_terminal_fresh_chat';
    live = await harness('https://chatgpt.com/');
    live.reply.set('correlate', () => ({
      ok: true,
      data: {
        conversationId,
        sessionId: '2026-08-21-post-terminal',
        confirmed: [requestId],
        complete: true
      }
    }));

    startGenerating(live.document);
    assistantTurn(live.document, 'fresh-post-terminal', []);
    live.hook.observe();
    await settle();
    const localTurnId = emitted(live.sent, 'turn_start').at(-1)!.event.turnId as string;

    await replyFiber([], [{
      turnId: 'fresh-post-terminal',
      conversationId: provisionalThread,
      endMessageId: 'fresh-post-terminal-answer',
      calls: [{
        messageId: 'fresh-post-terminal-call',
        tool: 'agents',
        order: 0,
        answered: true,
        requestId,
        createTime: 1_700_000_001
      }],
      messages: [{
        messageId: 'fresh-post-terminal-answer',
        rawMessageId: 'fresh-post-terminal-answer',
        role: 'assistant',
        stable: true,
        rawText: 'Done.',
        renderedHtml: '<p>Done.</p>'
      }]
    }]);
    await settle();
    expect(live.sent.filter((message) => message.type === 'correlate')).toHaveLength(0);

    live.window.history.pushState({}, '', `/c/${conversationId}`);
    live.hook.observe();
    await settle();

    await replyFiber([], [{
      turnId: 'fresh-post-terminal',
      conversationId: provisionalThread,
      endMessageId: 'fresh-post-terminal-answer',
      calls: [{
        messageId: 'fresh-post-terminal-call',
        tool: 'agents',
        order: 0,
        answered: true,
        requestId,
        createTime: 1_700_000_001
      }],
      messages: []
    }], { pageTurnId: 'fresh-post-terminal', localTurnId });
    await settle();

    expect(live.sent.filter((message) => message.type === 'correlate')).toContainEqual(
      expect.objectContaining({
        conversationId,
        calls: [expect.objectContaining({ requestId, messageId: 'fresh-post-terminal-call' })]
      })
    );
  });

  it('drops a Fiber turn whose own branch carries contradictory conversation identities', async () => {
    live = await harness();
    await replyFiber([], [{
      turnId: 'stale-conflicted-turn',
      conversationId: null,
      conversationConflict: true,
      calls: [{
        messageId: 'stale-conflicted-call',
        tool: 'read',
        order: 0,
        answered: true,
        requestId: 'wfr_stale_conflicted'
      }],
      messages: [{
        messageId: 'stale-conflicted-answer',
        rawMessageId: 'stale-conflicted-answer',
        role: 'assistant',
        stable: true,
        rawText: 'This belongs to another mounted chat.',
        renderedHtml: '<p>This belongs to another mounted chat.</p>'
      }]
    }]);
    await live.hook.flush();
    await settle();

    expect(emitted(live.sent, 'tool_evidence')).toHaveLength(0);
    expect(emitted(live.sent, 'assistant_message')).toHaveLength(0);
  });

  it('refreshes request-id evidence during a live turn even when ChatGPT renders no connector row', async () => {
    live = await harness();
    assistantTurn(live.document, 'rowless-live-turn', []);
    await settle();
    startGenerating(live.document);

    const window = live.window as any;
    const instant = window.setTimeout;
    window.setTimeout = (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms);
    let answered!: () => void;
    const responseSeen = new Promise<void>((resolve) => {
      answered = resolve;
    });
    const onAsk = (event: any) => {
      if (!event.data || event.data.source !== 'clf-fiber-ask') return;
      window.dispatchEvent(
        new window.MessageEvent('message', {
          data: {
            source: 'clf-fiber-reply',
            nonce: event.data.nonce,
            scanToken: event.data.nonce,
            v: 10,
            scanOk: true,
            rows: [],
            turns: [
              {
                index: 0,
                turnId: 'rowless-live-turn',
                conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
                calls: [
                  {
                    messageId: 'rowless-request-message',
                    tool: 'read',
                    order: 0,
                    answered: false,
                    requestId: 'wfr_rowless_live',
                    createTime: 1_700_000_000
                  }
                ],
                messages: []
              }
            ]
          },
          source: window
        })
      );
      answered();
    };
    window.addEventListener('message', onAsk);
    try {
      // This is the 1.7.9 regression: no tool row is inserted or mutated. The ordinary live
      // observer itself must still scan ChatGPT's message model for metadata.request_id.
      live.hook.observe();
      await responseSeen;
      await settle();
      await live.hook.flush();
    } finally {
      window.removeEventListener('message', onAsk);
      window.setTimeout = instant;
    }

    const evidence = emitted(live.sent, 'tool_evidence').map((entry) => entry.event);
    expect(evidence).toContainEqual(
      expect.objectContaining({
        kind: 'tool_evidence',
        fiberConversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        calls: [expect.objectContaining({ messageId: 'rowless-request-message', requestId: 'wfr_rowless_live' })]
      })
    );
  });

  it('says nothing about a row the helper did not stamp', async () => {
    live = await harness();
    const section = assistantTurn(live.document, 'turn-1', ['Called tool!']);
    await reply([GOOD]);
    expect(live.hook.fiberFor(section.querySelector('[aria-label="Open tool call list"]')!)).toBeNull();
  });

  /** Two descriptors claiming one row is a contradiction; believing either is a guess. */
  it('drops both when two descriptors claim the same row', async () => {
    live = await harness();
    const section = assistantTurn(live.document, 'turn-1', ['Called tool!']);
    const block = section.querySelector('[aria-label="Open tool call list"]')!;
    block.setAttribute('data-clf-fiber', '0');
    await reply([GOOD, { ...GOOD, tool: 'run_command' }]);
    expect(live.hook.fiberFor(block)).toBeNull();
  });

  /**
   * A browser where the MAIN-world script never ran, or a page that never answers, must
   * behave exactly as this extension did before the helper existed: no fold counts, and
   * every row treated as one call.
   */
  it('stays silent when nothing answers', async () => {
    live = await harness();
    const section = assistantTurn(live.document, 'turn-1', ['Called tool!']);
    const block = section.querySelector('[aria-label="Open tool call list"]')!;
    block.setAttribute('data-clf-fiber', '0');
    await live.hook.refreshFiber();
    expect(live.hook.fiberFor(block)).toBeNull();
  });

  it('downgrades stale Fiber health, asks for one repair, and accepts the repaired helper', async () => {
    live = await harness();
    const section = assistantTurn(live.document, 'turn-repair', ['Called tool!']);
    const block = section.querySelector('[aria-label="Open tool call list"]')!;
    block.setAttribute('data-clf-fiber', '0');
    await replyFiber([GOOD]);
    expect(live.hook.fiberFor(block)).toMatchObject({ tool: 'agent_status' });

    let repaired = false;
    live.reply.set('repair_fiber', () => {
      repaired = true;
      return { ok: true };
    });
    const window = live.window as any;
    const instant = window.setTimeout;
    window.setTimeout = (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms);
    const onAsk = (event: any) => {
      if (!repaired || !event.data || event.data.source !== 'clf-fiber-ask') return;
      block.setAttribute('data-clf-fiber', `${event.data.nonce}:0`);
      window.dispatchEvent(
        new window.MessageEvent('message', {
          data: {
            source: 'clf-fiber-reply',
            nonce: event.data.nonce,
            scanToken: event.data.nonce,
            v: 10,
            scanOk: true,
            rows: [{ ...GOOD, tool: 'read' }],
            turns: []
          },
          source: window
        })
      );
    };
    window.addEventListener('message', onAsk);
    try {
      await live.hook.refreshFiber();
    } finally {
      window.removeEventListener('message', onAsk);
      window.setTimeout = instant;
    }

    expect(live.sent.filter((message) => message.type === 'repair_fiber')).toHaveLength(1);
    expect(live.hook.fiberFor(block)).toMatchObject({ tool: 'read' });
  });

  /**
   * The case that made relabelling look broken everywhere but one chat. Verified on disk:
   * the failing conversation's session holds 10 recorded calls, all from a single turn on
   * one day, while the chat's connector rows go back several. The recorder only ever holds
   * the slice it observed live, so for most of a long-running chat there is nothing to
   * match against and no matching rule could ever have fixed it.
   */
  it('names a row the app has no record of, from the page’s own record', async () => {
    live = await harness();
    renderingOn();
    const section = assistantTurn(live.document, 'turn-1', ['Called tool!']);
    const row = section.querySelector('[aria-label="Open tool call list"]')!;
    row.setAttribute('data-clf-fiber', '0');
    live.reply.set('activity', () => ({
      ok: true,
      data: {
        entries: [],
        job: null
      }
    }));
    await reply([GOOD]);
    await live.hook.pullActivity();
    await settle();

    expect(labels(section)).toEqual(['agent_status']);
    const block = section.querySelector('[data-clf-page]')!;
    expect(block.getAttribute('data-clf-page')).toBe('agent_status');
    // Named, not claimed: no call bound, so a recorded call can still take the row later.
    expect(block.getAttribute('data-clf-call')).toBeNull();
    expect(block.classList.contains('clf-page')).toBe(true);
  });

  it('lets a recorded call take over a row the page had only named', async () => {
    live = await harness();
    renderingOn();
    const section = assistantTurn(live.document, 'turn-1', ['Called tool!']);
    section.querySelector('[aria-label="Open tool call list"]')!.setAttribute('data-clf-fiber', '0');
    const recorded = call({
      turnId: 'turn-1',
      seq: 1,
      // The same tool the descriptor names: the recorder and the page agreeing about what
      // ran is what earns the recorder the row.
      tool: 'agent_status',
      summary: { kind: 'agent', tone: 'neutral', title: 'Checked the swarm' }
    });
    let recordedYet = false;
    live.reply.set('activity', () => ({
      ok: true,
      data: {
        entries: recordedYet ? [recorded] : [],
        job: null
      }
    }));

    // An ordinary row standing for one call, which is the case where a recorded entry can
    // legitimately replace the page's name for it.
    await reply([{ ...GOOD, hidden: 0 }]);
    await live.hook.pullActivity();
    await settle();
    expect(labels(section)).toEqual(['agent_status']);

    recordedYet = true;
    await live.hook.pullActivity();
    await settle();
    // The recorder ran the call and knows what it did; the page only knew its name.
    expect(labels(section)).toEqual(['Checked the swarm']);
    expect(section.querySelectorAll('.clf-tool-icon svg')).toHaveLength(1);
  });

  /**
   * The other direction: the app knows about one call, but the page says this row stands
   * for five. Putting the one label it has on that row would name it after the wrong call.
   */
  it('leaves a folded row alone rather than naming it after the wrong call', async () => {
    live = await harness();
    renderingOn();
    const section = assistantTurn(live.document, 'turn-1', ['Called tool!']);
    section.querySelector('[aria-label="Open tool call list"]')!.setAttribute('data-clf-fiber', '0');
    const recorded = call({ turnId: 'turn-1', seq: 1, summary: { kind: 'agent', tone: 'neutral', title: 'Step one' } });
    live.reply.set('activity', () => ({
      ok: true,
      data: {
        entries: [recorded],
        job: null
      }
    }));

    await reply([GOOD]);
    await live.hook.pullActivity();
    await settle();
    // Named from the page, which is honest about what it is, and not bound to the call.
    expect(labels(section)).toEqual(['agent_status']);
    expect(section.querySelector('[data-clf-call]')).toBeNull();
  });

  /**
   * The whole point of the descriptor arriving late: a row can already be wearing the
   * wrong call by the time the page names it. Leaving that standing is the one outcome
   * worse than "Called tool" — another call's name, in this app's styling, with a
   * duration and an outcome, over work it did not describe.
   */
  it('takes a wrong label back off when the page names the row later', async () => {
    live = await harness();
    renderingOn();
    const section = assistantTurn(live.document, 'turn-1', ['Called tool!']);
    section.querySelector('[aria-label="Open tool call list"]')!.setAttribute('data-clf-fiber', '0');
    const recorded = call({
      turnId: 'turn-1',
      seq: 1,
      tool: 'list_windows',
      summary: { kind: 'agent', tone: 'neutral', title: 'Listed open windows', metric: '6 windows' }
    });
    live.reply.set('activity', () => ({
      ok: true,
      data: {
        entries: [recorded],
        job: null
      }
    }));

    // The payload was truncated and the call had not been answered yet, so the page could
    // not name the row. One row, one call, the counts fit: the label goes on.
    await reply([{ ...GOOD, tool: null, hidden: 0 }]);
    await live.hook.pullActivity();
    await settle();
    expect(labels(section)).toEqual(['Listed open windows6 windows']);
    expect(section.querySelectorAll('.clf-tool-icon svg')).toHaveLength(1);

    // Then the result comes back and the page names the row a different tool.
    await reply([{ ...GOOD, tool: 'screenshot', hidden: 0 }]);
    await live.hook.pullActivity();
    await settle();
    // Back to ChatGPT's row, renamed from the page's own record, with nothing of the
    // recorded call left on it — not the binding, not the metric, not the styling.
    expect(labels(section)).toEqual(['screenshot']);
    expect(section.querySelector('[data-clf-call]')).toBeNull();
    expect(section.querySelector('.clf-metric')).toBeNull();
    const block = section.querySelector('[data-clf-page]')!;
    expect(block.getAttribute('data-clf-page')).toBe('screenshot');
    expect(block.classList.contains('clf-tool')).toBe(true);
  });
});

describe('the activity feed', () => {
  it('keeps page ownership when the service worker could not make the batch durable', async () => {
    let attempts = 0;
    live = await harness(undefined, {
      events: () => {
        attempts += 1;
        return attempts === 1
          ? { ok: true, pending: 1, durable: false }
          : { ok: true, pending: 0, durable: false };
      }
    });
    attempts = 0;

    live.hook.emit({ kind: 'chat_error', text: 'must survive a service-worker restart' });
    await live.hook.flush();
    await live.hook.flush();

    // The first handled-but-volatile answer keeps the page copy. The second answer proves
    // the app accepted the retained batch, so the page may finally release it.
    expect(attempts).toBe(2);
  });

  it('bounds one UTF-8 observation before it can wedge the bridge on an unhalvable 413', async () => {
    const delivered: Array<Record<string, any>> = [];
    live = await harness(undefined, {
      events: (message) => {
        delivered.push(...message.entries);
        return { ok: true, pending: 0, durable: true };
      }
    });
    delivered.length = 0;

    live.hook.emit({
      kind: 'assistant_message',
      messageId: 'huge-utf8',
      text: '🧠'.repeat(140_000),
      renderedHtml: `<p>${'界'.repeat(140_000)}</p>`,
      final: true
    });
    await live.hook.flush();

    expect(delivered).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(delivered[0]!.event), 'utf8')).toBeLessThan(450 * 1024);
    expect(delivered[0]!.event.text).toContain('browser observation truncated');
  });

  it('records an explicit gap instead of silently dropping the oldest page-local observation', async () => {
    const delivered: Array<Record<string, any>> = [];
    live = await harness(undefined, {
      events: (message) => {
        delivered.push(...message.entries);
        return { ok: true, pending: 0, durable: true };
      }
    });
    delivered.length = 0;

    for (let index = 0; index < 401; index++) {
      live.hook.emit({ kind: 'progress', text: `queued-${index}` });
    }
    await live.hook.flush();
    await live.hook.flush();
    await live.hook.flush();

    expect(delivered).toHaveLength(400);
    const gaps = delivered.filter(
      (entry) => entry.event?.kind === 'chat_error' && /page-local queue/.test(String(entry.event?.text ?? ''))
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.event.text).toContain('2 observation(s) (2 progress)');
    const progress = delivered.filter((entry) => entry.event?.kind === 'progress').map((entry) => entry.event.text);
    expect(progress).toHaveLength(399);
    expect(progress).not.toContain('queued-0');
    expect(progress).not.toContain('queued-1');
    expect(progress[0]).toBe('queued-2');
    expect(progress.at(-1)).toBe('queued-400');
  });

  it('does not erase new overflow losses added while an older gap marker is in flight', async () => {
    const delivered: Array<Record<string, any>> = [];
    let blocked = false;
    let release: (() => void) | null = null;
    live = await harness(undefined, {
      events: async (message) => {
        delivered.push(...structuredClone(message.entries));
        if (blocked) {
          blocked = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return { ok: true, pending: 0, durable: true };
      }
    });
    delivered.length = 0;

    for (let index = 0; index < 401; index++) {
      live.hook.emit({ kind: 'progress', text: `before-send-${index}` });
    }
    blocked = true;
    const firstFlush = live.hook.flush();
    await settle();
    expect(release).not.toBeNull();

    // The old gap is already part of the structured-cloned first message. Pressure during
    // that await must start a second marker rather than mutating and later deleting the old.
    for (let index = 0; index < 401; index++) {
      live.hook.emit({ kind: 'progress', text: `during-send-${index}` });
    }
    release!();
    await firstFlush;
    await live.hook.flush();
    await live.hook.flush();
    await live.hook.flush();

    const gaps = delivered.filter(
      (entry) => entry.event?.kind === 'chat_error' && /page-local queue/.test(String(entry.event?.text ?? ''))
    );
    expect(gaps.length).toBeGreaterThanOrEqual(2);
    expect(gaps.some((entry) => /observation\(s\)/.test(entry.event.text))).toBe(true);
  });

  it('keeps the recorder alive across a transient missing service-worker receiver', async () => {
    let attempts = 0;
    live = await harness(undefined, {
      events: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Could not establish connection. Receiving end does not exist.');
        return { ok: true, pending: 0, durable: true };
      }
    });

    live.hook.emit({ kind: 'chat_error', text: 'one durable observation' });
    await live.hook.flush();
    await live.hook.flush();

    expect(attempts).toBe(2);
  });

  it('asks for what comes after the last entry, not for the last entry again', async () => {
    live = await harness();
    renderingOn();
    const section = assistantTurn(live.document, 'turn-1', ['Called tool', 'Called tool']);
    const first = call({ turnId: 'turn-1', seq: 4, summary: { kind: 'read', tone: 'neutral', title: 'Read a.ts' } });
    const second = call({
      turnId: 'turn-1',
      seq: 5,
      outcome: 'error',
      summary: { kind: 'run', tone: 'bad', title: 'Command failed  npm test', metric: '✕ exit 1' }
    });

    const asked: number[] = [];
    live.reply.set('activity', (message) => {
      asked.push(message.since);
      return {
        ok: true,
        data: {
          entries: [first, second].filter((entry) => entry.seq >= message.since),
          job: null
        }
      };
    });

    await live.hook.pullActivity();
    await settle();
    await live.hook.pullActivity();
    await settle();

    // The off-by-one that made every poll re-deliver the newest call — and so made the
    // turn look like it had more calls than blocks, which suppressed every label.
    expect(asked).toEqual([0, 6]);
    expect(labels(section)).toEqual(['Read a.ts', 'Command failed npm test✕ exit 1']);
    expect(section.querySelectorAll('.clf-tool-icon svg')).toHaveLength(2);
  });

  it('marks a failed call as failed on the block itself, not only in its colour', async () => {
    live = await harness();
    renderingOn();
    const section = assistantTurn(live.document, 'turn-2', ['Called tool']);
    live.reply.set('activity', () => ({
      ok: true,
      data: {
        entries: [
          call({
            turnId: 'turn-2',
            outcome: 'error',
            summary: { kind: 'run', tone: 'bad', title: 'Could not run git push', metric: '✕ failed' }
          })
        ],
        job: null
      }
    }));

    await live.hook.pullActivity();
    await settle();

    const block = section.querySelector('.pointer-events-none.contents') as HTMLElement;
    expect(block.dataset.clfOutcome).toBe('error');
    expect(block.classList.contains('clf-bad')).toBe(true);
    expect(block.textContent).toContain('Could not run git push');
  });

  it('survives the same entry being delivered twice', async () => {
    live = await harness();
    renderingOn();
    const section = assistantTurn(live.document, 'turn-3', ['Called tool', 'Called tool']);
    const one = call({ turnId: 'turn-3', seq: 10, summary: { kind: 'read', tone: 'neutral', title: 'Read one.ts' } });
    const two = call({ turnId: 'turn-3', seq: 11, summary: { kind: 'read', tone: 'neutral', title: 'Read two.ts' } });
    live.reply.set('activity', () => ({
      ok: true,
      // A feed that repeats itself, which is what the old `since` produced.
      data: {
        entries: [one, two, two],
        job: null
      }
    }));

    await live.hook.pullActivity();
    await settle();
    await live.hook.pullActivity();
    await settle();

    expect(labels(section)).toEqual(['Read one.ts', 'Read two.ts']);
    expect(section.querySelectorAll('.clf-tool-icon svg')).toHaveLength(2);
  });
});

describe('the Compact & resume control', () => {
  /**
   * It used to remove itself here, and that was right while compaction was all it did: a
   * disabled "send a message first" button is not worth half a composer. A goal changed that.
   * A goal written into a New Chat is what writes that chat's first message, so the sheet has
   * to be reachable before there is a chat — and the one thing that still needs a chat says so.
   */
  it('exists on a brand-new chat, with compaction unavailable and a reason', async () => {
    live = await harness('https://chatgpt.com/');
    live.hook.injectControl();

    const control = live.document.querySelector('.clf-composer') as HTMLElement;
    expect(control).not.toBeNull();
    expect(control.dataset.clfMode).toBe('off');
    expect(live.hook.controlState({ connected: true, conversationId: null, now: Date.now() })).toMatchObject({
      action: 'none',
      hint: 'Nothing to compact yet — send a message, or set a goal and it writes one.'
    });
  });

  it('sits in the composer, before the send button once the chat exists', async () => {
    live = await harness();
    live.hook.injectControl();

    const control = live.document.querySelector('.clf-composer') as HTMLElement;
    expect(control, 'no Compact & resume control was injected').not.toBeNull();
    const row = live.document.querySelector('[data-testid="composer-trailing-actions"]')!;
    expect(control.parentElement).toBe(row);
    const order = [...row.children].map((node) => node.getAttribute('data-testid') || node.className);
    expect(order).toEqual([
      'composer-speech-button',
      'clf-composer',
      'send-button'
    ]);
    // `data-clf-tip`, not `title`: the hover text is drawn by this extension in ChatGPT's
    // own style rather than by the operating system. See `.clf-tip`.
    //
    // The button is a gear now, so the hover answers the question a gear raises — what are
    // the settings — rather than naming one action it no longer performs on its own.
    expect(control.querySelector('.clf-compact-btn')!.getAttribute('data-clf-tip')).toBe(
      'Auto-compaction off\nGoal off'
    );
  });

  /**
   * The gear opens a sheet; it does not compact.
   *
   * It used to be one button for one action, and then it grew a second setting and a third,
   * and a button whose icon promises one thing and delivers a menu is worse than either. The
   * old action is the last row of the sheet, so nothing that used to be reachable stopped
   * being reachable.
   */
  it('opens a settings sheet with both switches and the compaction action', async () => {
    live = await harness();
    live.hook.injectControl();
    live.hook.toggleMenu();

    const menu = live.document.querySelector('.clf-menu') as HTMLElement;
    expect(menu, 'the gear opened nothing').not.toBeNull();
    expect(menu.hidden).toBe(false);
    expect([...menu.querySelectorAll('.clf-menu-row')].map((row) => (row as HTMLElement).dataset.clfRow)).toEqual([
      'autoCompact',
      'goal'
    ]);
    expect(menu.querySelector('.clf-menu-action')!.textContent).toBe('Compact & resume now');

    live.hook.closeMenu();
    expect((live.document.querySelector('.clf-menu') as HTMLElement).hidden).toBe(true);
  });

  it('locks every compaction affordance in a worker chat and emits no settings write when clicked', async () => {
    live = await harness(undefined, {
      activity: () => ({
        ok: true,
        data: {
          entries: [],
          stream: [],
          nextSince: 0,
          pendingTools: 0,
          job: null,
          tokens: 410_000,
          autoCompactReady: false,
          context: { auto: false, threshold: 400_000, warn: 400_000, limit: 533_333 },
          goal: {
            enabled: false,
            hasKey: true,
            model: 'deepseek/deepseek-v4-flash',
            objective: '',
            blocked: 'worker',
            draft: null
          }
        }
      })
    });
    await live.hook.pullActivity();
    live.hook.injectControl();
    live.hook.toggleMenu();

    const auto = live.document.querySelector('[data-clf-row="autoCompact"]') as HTMLButtonElement;
    expect(auto.disabled).toBe(true);
    expect(auto.getAttribute('aria-checked')).toBe('false');
    expect(auto.querySelector('.clf-menu-note')?.textContent).toMatch(/worker chats never auto-compact/i);
    auto.click();
    await settle();
    expect(live.sent.filter((message) => message.type === 'settings_set')).toEqual([]);

    const action = live.document.querySelector('.clf-menu-action') as HTMLButtonElement;
    expect(action.disabled).toBe(true);
    expect(action.textContent).toBe('Compact & resume unavailable');
    expect(action.getAttribute('data-clf-tip')).toMatch(/never manually compacted or resumed/i);
    action.click();
    await settle();
    expect(live.sent.filter((message) => message.type === 'compact')).toEqual([]);
  });

  it('does not stop a reloaded worker turn when Compact is clicked before its first activity policy arrives', async () => {
    let stopClicks = 0;
    let compactCalls = 0;
    const workerGoal = {
      enabled: false,
      hasKey: true,
      model: 'test-model',
      objective: '',
      blocked: 'worker',
      draft: null
    };
    live = await harness(
      undefined,
      {
        // This is the first role-bearing answer a reloaded worker gets. Before it, checkStatus()
        // may already have rendered the gear while goalConfig/bootstrap are still null.
        activity: () => ({
          ok: true,
          data: {
            sessionId: 'worker-session',
            entries: [],
            stream: [],
            userAnchors: [],
            nextSince: 0,
            job: null,
            pendingTools: 0,
            tokens: 410_000,
            autoCompactReady: false,
            context: { auto: false, threshold: 400_000, warn: 400_000, limit: 533_333 },
            bootstrap: 'worker',
            goal: workerGoal
          }
        }),
        compact: () => {
          compactCalls++;
          return { ok: false, data: { error: 'worker_compaction_disabled' } };
        }
      },
      (document) => {
        startGenerating(document);
        document.querySelector('[data-testid="stop-button"]')?.addEventListener('click', () => {
          stopClicks++;
          stopGenerating(document);
        });
      }
    );

    // Deliberately do not pull activity first: this is the 1-2s reload race before worker policy
    // reaches the page. startCompact must refresh authority before doing anything irreversible.
    await live.hook.startCompact();

    expect(stopClicks).toBe(0);
    expect(compactCalls).toBe(0);
    expect(live.sent.filter((message) => message.type === 'compact')).toEqual([]);
    const workerSettings = live.hook.settingsView({
      context: { auto: false, threshold: 400_000, warn: 400_000, limit: 533_333 },
      goal: workerGoal,
      compact: { action: 'start', hint: '' },
      editing: false
    });
    expect(workerSettings.action.action).toBe('none');
  });

  it('does not interrupt an unknown chat when compaction authority cannot be refreshed', async () => {
    let stopClicks = 0;
    live = await harness(
      undefined,
      { activity: () => ({ ok: false, error: 'app_not_found' }) },
      (document) => {
        startGenerating(document);
        document.querySelector('[data-testid="stop-button"]')?.addEventListener('click', () => {
          stopClicks++;
          stopGenerating(document);
        });
      }
    );

    await live.hook.startCompact();

    expect(stopClicks).toBe(0);
    expect(live.sent.filter((message) => message.type === 'compact')).toEqual([]);
  });

  /**
   * Both switches are the app's, not the page's. The click asks and the answer moves the
   * switch, because the app's own settings window can change these too — a control that
   * flips optimistically and then flips back is one nobody trusts twice.
   */
  it('writes a switch to the app and paints what the app answered', async () => {
    live = await harness();
    live.reply.set('settings_set', () => ({
      ok: true,
      data: {
        context: { auto: true, threshold: 300_000, warn: 300_000, limit: 400_000 },
        goal: { enabled: false, hasKey: false, model: 'deepseek/deepseek-v4-flash' }
      }
    }));
    live.hook.injectControl();
    live.hook.toggleMenu();

    const row = live.document.querySelector('[data-clf-row="autoCompact"]') as HTMLButtonElement;
    expect(row.getAttribute('aria-checked')).toBe('false');
    row.click();
    await settle();

    const writes = live.sent.filter((message) => message.type === 'settings_set');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ autoCompact: true });
    const after = live.document.querySelector('[data-clf-row="autoCompact"]') as HTMLButtonElement;
    expect(after.getAttribute('aria-checked')).toBe('true');
    expect((after.querySelector('.clf-switch') as HTMLElement).dataset.clfOn).toBe('1');
  });

  /** The missing credential is said where the switch is, in the words the app uses. */
  it('says an OpenRouter key is needed before the goal switch can do anything', async () => {
    live = await harness(undefined, {
      activity: () => ({
        ok: true,
        data: {
          entries: [],
          stream: [],
          nextSince: 0,
          pendingTools: 0,
          job: null,
          goal: { enabled: true, hasKey: false, model: 'deepseek/deepseek-v4-flash', draft: null }
        }
      })
    });
    await live.hook.pullActivity();
    live.hook.injectControl();
    live.hook.toggleMenu();

    const goal = live.document.querySelector('[data-clf-row="goal"]')!;
    expect(goal.querySelector('.clf-menu-note')!.textContent).toBe(
      'OpenRouter API key essential for goal feature'
    );
    expect((goal.querySelector('.clf-menu-note') as HTMLElement).dataset.clfWarn).toBe('1');
    // The hover line says the same thing in one breath.
    expect(live.document.querySelector('.clf-compact-btn')!.getAttribute('data-clf-tip')).toContain(
      'Goal on — no API key'
    );
  });

  /**
   * ChatGPT's appearance setting is its own, and can be the opposite of the operating
   * system's. The colours our menu and hover bubble copy have no page variable to read, so
   * one of two written-out sets is chosen — and it has to be chosen from what the page is
   * actually painted, or someone running ChatGPT in Light on a dark Windows gets a black
   * popup on a white conversation.
   */
  it('takes its light or dark surface from the page, not from the operating system', async () => {
    live = await harness();
    const root = live.document.documentElement;
    const form = live.document.querySelector('#composer-form') as HTMLElement;

    form.style.backgroundColor = 'rgb(255, 255, 255)';
    live.hook.syncTheme();
    expect(root.getAttribute('data-clf-theme')).toBe('light');

    // Changed while the tab is open, which is how the setting is actually used.
    form.style.backgroundColor = 'rgb(33, 33, 33)';
    live.hook.syncTheme();
    expect(root.getAttribute('data-clf-theme')).toBe('dark');
  });

  /**
   * The reason the previous control lived in the + menu: ChatGPT replaces the composer's
   * subtree whenever it feels like it. Hiding from that made the control impossible to
   * find, so it has to survive it instead.
   */
  it('comes back after ChatGPT replaces the whole composer', async () => {
    live = await harness();
    live.hook.injectControl();
    expect(live.document.querySelector('.clf-compact-btn')).not.toBeNull();

    const form = live.document.querySelector('#composer-form')!;
    form.innerHTML = `
      <div id="prompt-textarea" contenteditable="true"></div>
      <div data-testid="composer-trailing-actions">
        <button data-testid="composer-speech-button"></button>
        <button data-testid="send-button"></button>
      </div>`;
    expect(live.document.querySelector('.clf-compact-btn')).toBeNull();

    live.hook.injectControl();
    expect(live.document.querySelector('.clf-compact-btn')).not.toBeNull();
    expect(live.document.querySelectorAll('.clf-compact-btn')).toHaveLength(1);
  });

  it('says what the job is doing at every stage', async () => {
    live = await harness();
    const state = (over: Record<string, unknown>) =>
      live!.hook.controlState({
        job: null,
        connected: true,
        conversationId: 'c1',
        pressedAt: 0,
        error: '',
        now: 1000,
        ...over
      });

    expect(state({})).toMatchObject({ mode: 'idle', label: 'Compact', action: 'start' });
    expect(state({ disconnected: true })).toMatchObject({
      mode: 'off',
      hint: 'Browser connection is disconnected in Chat On Steroids.',
      action: 'none'
    });
    expect(state({ pressedAt: 900 })).toMatchObject({ mode: 'busy', label: 'Starting…', action: 'none' });

    // The local phases, which no app-side state can describe: the app only knows it has
    // asked and is waiting, so `handoff-pending` plus the phase is the whole report.
    const pending = { sessionId: 's1', stage: 'handoff-pending', busy: true, error: null, handoffId: null };
    expect(state({ job: pending, phase: 'interrupting' })).toMatchObject({
      mode: 'busy',
      label: 'Stopping…',
      action: 'cancel'
    });
    expect(state({ job: pending, phase: 'settling' })).toMatchObject({ mode: 'busy', label: 'Settling…' });
    expect(state({ job: pending, phase: 'waiting' })).toMatchObject({ mode: 'busy', label: 'Writing…' });
    // An unknown phase — a tab that reloaded mid-run and lost its local state — still says
    // something true rather than nothing.
    expect(state({ job: pending, phase: '' })).toMatchObject({ mode: 'busy', label: 'Asking…' });

    expect(state({ job: { stage: 'opening', busy: true, error: null, handoffId: 'h1' } })).toMatchObject({
      mode: 'busy',
      label: 'Opening…',
      action: 'cancel'
    });
    expect(
      state({ job: { stage: 'waiting-for-browser', busy: true, error: 'could not open your browser', handoffId: 'h1' } })
    ).toMatchObject({ mode: 'waiting', label: 'Waiting…', action: 'cancel' });
    expect(state({ job: { stage: 'done', busy: false, error: null, handoffId: 'h1' } })).toMatchObject({
      mode: 'done',
      label: 'Opened'
    });
    expect(
      state({ job: { stage: 'failed', busy: false, error: 'ChatGPT never wrote the brief', handoffId: null } })
    ).toMatchObject({
      mode: 'error',
      label: 'Failed',
      hint: 'ChatGPT never wrote the brief',
      action: 'start'
    });
    expect(state({ job: { stage: 'failed', busy: false, error: 'cancelled', handoffId: null } })).toMatchObject({
      mode: 'idle',
      hint: 'Resume cancelled',
      action: 'start'
    });
    expect(state({ connected: false })).toMatchObject({ mode: 'off', action: 'none' });
    expect(state({ conversationId: null })).toMatchObject({
      mode: 'off',
      hint: 'Nothing to compact yet — send a message, or set a goal and it writes one.'
    });
  });

  /**
   * The 1.7.1 reversal.
   *
   * Until now the control removed itself the instant ChatGPT started generating, because
   * the only provider behind it read the local recording and so could not run against a
   * turn still being written. The default path interrupts that turn deliberately, and the
   * moment the user reaches for this is precisely a turn they no longer want to wait out —
   * so hiding then is hiding it whenever it is wanted.
   */
  it('stays available while ChatGPT is generating', async () => {
    live = await harness();
    const state = (over: Record<string, unknown>) =>
      live!.hook.controlState({
        job: null,
        connected: true,
        conversationId: 'c1',
        pressedAt: 0,
        error: '',
        now: 1000,
        ...over
      });

    // `generating` is no longer an input the control reads at all, so a caller that still
    // passes it cannot suppress the button by accident.
    expect(state({ generating: true })).toMatchObject({
      mode: 'idle',
      label: 'Compact',
      action: 'start'
    });
    expect(state({ generating: true, job: { stage: 'handoff-pending', busy: true, error: null, handoffId: null } })).toMatchObject({
      mode: 'busy',
      action: 'cancel'
    });
  });

  it('interrupts the live turn, waits for local tools, then prompts this same chat', async () => {
    const prompt = 'Write a handoff brief … your reply to this message must be the brief itself';
    // One local call is still running, and finishes on the third time it is asked about.
    let asked = 0;
    const typedWhileBusy: string[] = [];
    live = await harness(undefined, {
      compact: () => ({
        ok: true,
        data: {
          started: true,
          token: 'tok-nc-1',
          prompt,
          job: { sessionId: 's1', stage: 'handoff-pending', busy: true, handoffId: null, error: null }
        }
      }),
      activity: () => {
        asked++;
        const pendingTools = asked < 3 ? 1 : 0;
        // Nothing may be typed while a local call is still in flight: a brief written over
        // a half-finished edit describes a machine that no longer exists.
        if (pendingTools > 0) typedWhileBusy.push(composerText(live!.document));
        return { ok: true, data: { entries: [], stream: [], nextSince: 0, pendingTools, job: null } };
      }
    });
    live.hook.injectControl();

    startGenerating(live.document);
    const sends = watchSend(live.document);
    const stop = live.document.querySelector('[data-testid="stop-button"]') as HTMLButtonElement;
    let stopped = false;
    stop.addEventListener('click', () => {
      stopped = true;
      stopGenerating(live!.document);
    });

    await live.hook.startCompact();

    expect(stopped).toBe(true);
    expect(asked).toBeGreaterThanOrEqual(3);
    expect(typedWhileBusy.length).toBeGreaterThan(0);
    expect(typedWhileBusy.filter(Boolean)).toEqual([]);
    expect(composerText(live.document)).toContain('the brief itself');
    expect(sends()).toBe(1);
    const compacts = startedCompactions(live);
    expect(compacts).toHaveLength(1);
    expect(compacts[0]).toMatchObject({ resume: true });
    // The old chat is still the only place the work exists: nothing has been cancelled and
    // nothing has navigated. Opening the fresh chat is the app's job, and only once the
    // generation this send started has handed its brief back.
    expect(live.sent.some((message) => message.type === 'compact' && message.cancel === true)).toBe(false);
  });

  it('abandons a compaction instead of retargeting it when the tab navigates while tools settle', async () => {
    const a = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const b = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    live = await harness(`https://chatgpt.com/c/${a}`);
    live.hook.injectControl();
    const sends = watchSend(live.document);

    let releaseActivity!: (value: unknown) => void;
    const heldActivity = new Promise<unknown>((resolve) => {
      releaseActivity = resolve;
    });
    live.reply.set('activity', () => heldActivity);
    live.reply.set('compact', () => ({
      ok: true,
      data: {
        started: true,
        token: 'must-not-cross-chats',
        prompt: 'Write a handoff brief for chat A.',
        job: { sessionId: 's-a', stage: 'handoff-pending', busy: true, handoffId: null, error: null }
      }
    }));

    const compacting = live.hook.startCompact();
    await settle(5);
    expect(live.sent.some((message) => message.type === 'activity' && message.conversationId === a)).toBe(true);

    // The pending activity request belongs to A. Move the same document to B before that
    // answer lands, exactly like an SPA click while the settle barrier is waiting.
    live.window.history.pushState({}, '', `/c/${b}`);
    live.hook.observe();
    releaseActivity({ ok: true, data: { entries: [], stream: [], nextSince: 0, pendingTools: 0, job: null } });
    await compacting;

    expect(startedCompactions(live)).toEqual([]);
    expect(composerText(live.document)).toBe('');
    expect(sends()).toBe(0);
    expect(live.sent.some((message) => message.type === 'closed' && message.conversationId === a)).toBe(true);
  });

  it('refuses to compact when a local tool is still running at the settle deadline', async () => {
    let activityChecks = 0;
    live = await harness(undefined, {
      activity: () => {
        activityChecks++;
        return { ok: true, data: { entries: [], stream: [], nextSince: 0, pendingTools: 1, job: null } };
      },
      compact: () => ({ ok: true, data: { started: true, prompt: 'must never be requested' } })
    });
    live.hook.injectControl();
    const sends = watchSend(live.document);

    await live.hook.startCompact();

    expect(activityChecks).toBeGreaterThan(1);
    expect(startedCompactions(live)).toEqual([]);
    expect(sends()).toBe(0);
    expect(composerText(live.document)).toBe('');
    expect(live.document.querySelector('.clf-pill-text')!.textContent).toContain('still running');
  });

  it('outlives the recorder attribution grace before declaring a finished call stuck', async () => {
    // An unattributed call can be finished from ChatGPT's point of view while the app keeps
    // it pending for up to 15 seconds so late request-id evidence can still attach its durable
    // record to the right conversation. The compaction deadline used to be only 20 seconds,
    // leaving almost no write/scheduling headroom and turning that normal recorder tail into
    // a false refusal. Keep it busy for >20s, then clear it before the 30s deadline: this must
    // still reach the actual compact request.
    let polls = 0;
    live = await harness(undefined, {
      activity: () => ({
        ok: true,
        data: {
          entries: [],
          stream: [],
          nextSince: 0,
          pendingTools: ++polls <= 90 ? 1 : 0,
          job: null
        }
      }),
      compact: () => ({
        ok: true,
        data: {
          started: true,
          token: 'tok-recorder-tail',
          prompt: 'Write the handoff brief.',
          job: { sessionId: 's1', stage: 'handoff-pending', busy: true, handoffId: null, error: null }
        }
      })
    });
    live.hook.injectControl();
    watchSend(live.document);

    await live.hook.startCompact();

    expect(polls).toBeGreaterThan(80);
    expect(startedCompactions(live)).toHaveLength(1);
    expect((live.document.querySelector('.clf-composer') as HTMLElement).dataset.clfMode).toBe('busy');
  });

  it('refuses to compact when the app cannot verify pending local tools', async () => {
    let activityChecks = 0;
    live = await harness(undefined, {
      activity: () => {
        activityChecks++;
        // The first read is the new pre-destructive role proof: this ordinary chat is allowed
        // to enter the settle barrier. The subsequent silence is the original regression this
        // test owns — local-tool state cannot be verified, so compaction must still fail closed.
        // Harness startup can consume one activity read before the explicit press, so keep the
        // first two authoritative. The settle loop itself then owns the deliberately missing
        // replies this regression is about.
        if (activityChecks <= 2) {
          return { ok: true, data: { entries: [], stream: [], nextSince: 0, pendingTools: 0, job: null } };
        }
        return null;
      },
      compact: () => ({ ok: true, data: { started: true, prompt: 'must never be requested' } })
    });
    live.hook.injectControl();
    const sends = watchSend(live.document);

    await live.hook.startCompact();

    expect(activityChecks).toBeGreaterThanOrEqual(3);
    expect(startedCompactions(live)).toEqual([]);
    expect(sends()).toBe(0);
    expect(composerText(live.document)).toBe('');
    expect(live.document.querySelector('.clf-pill-text')!.textContent).toContain('Could not verify');
  });

  it('leaves the old chat alone and never opens a request at all when the turn will not stop', async () => {
    live = await harness(undefined, {
      // Positively prove this is an ordinary chat first; the test is about ChatGPT refusing the
      // later Stop, not about the separate unknown-role authority fence.
      activity: () => ({ ok: true, data: { entries: [], stream: [], nextSince: 0, pendingTools: 0, job: null } }),
      compact: (message) => ({
        ok: true,
        data: message.cancel
          ? { cancelled: true }
          : {
              started: true,
              prompt: 'write the brief and call save_handoff',
              job: { sessionId: 's1', stage: 'handoff-pending', busy: true, handoffId: null, error: null }
            }
      })
    });
    live.hook.injectControl();
    startGenerating(live.document); // and nothing ever clears it
    const sends = watchSend(live.document);

    await live.hook.startCompact();

    // Never typed, never sent — and no app-side request to withdraw, because stopping the
    // turn now happens *before* asking. The request is what makes the app take its copy of
    // the recording, so a conversation that will not hold still never gets that far, and
    // there is no window in which a late save_handoff could save a brief and open a chat
    // for a run that gave up.
    expect(composerText(live.document)).toBe('');
    expect(sends()).toBe(0);
    expect(live.sent.filter((message) => message.type === 'compact')).toEqual([]);
    expect(live.document.querySelector('.clf-pill-text')!.textContent).toContain('would not stop');
  });

  it('never overwrites a draft the user is writing', async () => {
    live = await harness(undefined, {
      activity: () => ({ ok: true, data: { entries: [], stream: [], nextSince: 0, pendingTools: 0, job: null } }),
      compact: (message) => ({
        ok: true,
        data: message.cancel
          ? { cancelled: true }
          : {
              started: true,
              prompt: 'write the brief and call save_handoff',
              job: { sessionId: 's1', stage: 'handoff-pending', busy: true, handoffId: null, error: null }
            }
      })
    });
    live.hook.injectControl();
    const sends = watchSend(live.document);
    live.document.querySelector('#prompt-textarea')!.textContent = 'half a question I was still typing';

    await live.hook.startCompact();

    expect(composerText(live.document)).toBe('half a question I was still typing');
    expect(sends()).toBe(0);
    const compacts = live.sent.filter((message) => message.type === 'compact');
    expect(compacts[compacts.length - 1]).toMatchObject({ cancel: true });
  });

  it('does not submit a compaction prompt after the composer changes during its pre-send wait', async () => {
    const prompt = 'write the exact handoff brief for this session';
    live = await harness(undefined, {
      activity: () => ({ ok: true, data: { entries: [], stream: [], nextSince: 0, pendingTools: 0, job: null } }),
      compact: (message) => ({
        ok: true,
        data: message.cancel
          ? { cancelled: true }
          : {
              started: true,
              token: 'tok-composer-race',
              prompt,
              job: { sessionId: 's1', stage: 'handoff-pending', busy: true, handoffId: null, error: null }
            }
      })
    });
    live.hook.injectControl();
    const sends = watchSend(live.document);
    const document = live.document as Document & { execCommand: (...args: any[]) => boolean };
    const originalExec = document.execCommand.bind(document);
    document.execCommand = (...args: any[]) => {
      const accepted = originalExec(...args);
      if (args[0] === 'insertText') {
        // insertPrompt() has already won its initial empty-composer check. Model the user (or
        // React) changing that same editing host while runNativeCompaction is in its 400 ms
        // pre-send settle. The app may preserve this draft, but it must never click Send on it.
        void Promise.resolve().then(() => {
          const paragraph = document.createElement('p');
          paragraph.textContent = 'my unrelated draft';
          document.querySelector('#prompt-textarea')!.append(paragraph);
        });
      }
      return accepted;
    };

    await live.hook.startCompact();

    expect(sends()).toBe(0);
    expect(composerText(live.document)).toContain('my unrelated draft');
    const compacts = live.sent.filter((message) => message.type === 'compact');
    expect(compacts.at(-1)).toMatchObject({ cancel: true });
  });

  it('starts one job on a press and refuses a second press while it runs', async () => {
    let started = false;
    const pendingJob = { sessionId: 's1', stage: 'handoff-pending', busy: true, handoffId: null, error: null };
    live = await harness(undefined, {
      activity: () => ({
        ok: true,
        data: { entries: [], stream: [], nextSince: 0, pendingTools: 0, job: started ? pendingJob : null }
      })
    });
    live.reply.set('compact', (message) => {
      if (message.cancel) {
        started = false;
        return {
          ok: true,
          data: {
            cancelled: true,
            job: { sessionId: 's1', stage: 'failed', busy: false, handoffId: null, error: 'cancelled' }
          }
        };
      }
      started = true;
      return {
        ok: true,
        data: {
          started: true,
          token: 'tok-double-press',
          prompt: 'Write the one handoff brief for this test.',
          job: pendingJob
        }
      };
    });
    live.hook.injectControl();

    // The gear opens the sheet; the sheet's action row is the press. One path still — the
    // sheet has exactly one action on it.
    (live.document.querySelector('.clf-compact-btn') as HTMLButtonElement).click();
    (live.document.querySelector('.clf-menu-action') as HTMLButtonElement).click();
    await settle();

    expect(live.sent.filter((message) => message.type === 'compact')).toHaveLength(1);
    expect((live.document.querySelector('.clf-composer') as HTMLElement).dataset.clfMode).toBe('busy');

    // The impatient second press. The sheet's action row is now a cancel, so it must not
    // start another compaction — this is the click that used to fan out into several tabs.
    (live.document.querySelector('.clf-compact-btn') as HTMLButtonElement).click();
    expect(live.document.querySelector('.clf-menu-action')!.textContent).toBe('Cancel compaction');
    (live.document.querySelector('.clf-menu-action') as HTMLButtonElement).click();
    await settle();
    const compacts = live.sent.filter((message) => message.type === 'compact');
    expect(compacts).toHaveLength(2);
    expect(compacts[1]).toMatchObject({ cancel: true });
    expect(live.window.sessionStorage.getItem('clf-compact-capture')).toBeNull();
  });

  it('shows why it could not start rather than silently doing nothing', async () => {
    live = await harness(undefined, {
      activity: () => ({ ok: true, data: { entries: [], stream: [], nextSince: 0, pendingTools: 0, job: null } })
    });
    live.reply.set('compact', () => ({
      ok: false,
      status: 409,
      data: { error: 'session_not_recorded', message: 'This chat has no recorded local session to compact.' }
    }));
    live.hook.injectControl();

    (live.document.querySelector('.clf-compact-btn') as HTMLButtonElement).click();
    (live.document.querySelector('.clf-menu-action') as HTMLButtonElement).click();
    await settle();

    expect((live.document.querySelector('.clf-composer') as HTMLElement).dataset.clfMode).toBe('error');
    // The pill is one word everywhere except a failure, where the detail is the message.
    expect(live.document.querySelector('.clf-pill-text')!.textContent).toBe(
      'This chat has no recorded local session to compact.'
    );
  });
});

/**
 * The field stacked above the composer.
 *
 * Compact & resume used to say what it was doing in a pill the width of a button, and put
 * its actual output through the composer — the one part of the page that belongs to the
 * user. The work now happens in a second field behind the input, and the input stays empty.
 */
describe('the field above the composer', () => {
  const view = (over: Record<string, unknown>) => live!.hook.stageView({ job: null, ...over });

  it('is not there when nothing is happening', async () => {
    live = await harness();
    expect(view({})).toBeNull();
    live.hook.injectStage();
    expect(live.document.querySelector('.clf-stage')).toBeNull();
  });

  /**
   * Only ever this chat's own work. The job is reported per conversation, so a tab sitting
   * beside a chat that is compacting shows nothing of it.
   */
  it('says nothing about a job that is over', async () => {
    live = await harness();
    expect(view({ job: { stage: 'done', busy: false } })).toBeNull();
  });

  it('names the stage the transaction is in', async () => {
    live = await harness();
    expect(view({ job: { stage: 'handoff-pending', busy: true } })).toMatchObject({
      stage: 'ChatGPT is writing the handoff'
    });
    expect(view({ job: { stage: 'opening', busy: true } })).toMatchObject({ stage: 'Opening a fresh chat' });
    expect(view({ job: { stage: 'waiting-for-browser', busy: true } })).toMatchObject({ stage: 'Waiting for Chrome' });
  });

  it('stacks above the composer rather than inside it, and leaves when it is done', async () => {
    live = await harness();
    live.reply.set('activity', () => ({
      ok: true,
      data: {
        entries: [],
        job: { sessionId: 's1', stage: 'opening', busy: true, handoffId: 'h1', error: null }
      }
    }));
    await live.hook.pullActivity();
    await settle();

    const panel = live.document.querySelector('.clf-stage') as HTMLElement;
    const form = live.document.querySelector('#composer-form')!;
    expect(panel.parentElement).toBe(form.parentElement);
    expect(panel.nextElementSibling).toBe(form);
    // The user's own field is untouched, which was the whole complaint.
    expect(live.document.querySelector('#prompt-textarea')!.textContent).toBe('');
    expect(panel.querySelector('.clf-stage-title')!.textContent).toBe('Opening a fresh chat');

    live.reply.set('activity', () => ({
      ok: true,
      data: { entries: [], job: null }
    }));
    await live.hook.pullActivity();
    await settle();
    expect(live.document.querySelector('.clf-stage')).toBeNull();
  });

  it('puts back exactly one panel when ChatGPT replaces the composer', async () => {
    live = await harness();
    live.reply.set('activity', () => ({
      ok: true,
      data: {
        entries: [],
        job: { sessionId: 's1', stage: 'opening', busy: true, handoffId: 'h1', error: null }
      }
    }));
    await live.hook.pullActivity();
    await settle();
    expect(live.document.querySelectorAll('.clf-stage')).toHaveLength(1);

    live.document.querySelector('.clf-stage')!.remove();
    live.hook.injectStage();
    live.hook.injectStage();
    expect(live.document.querySelectorAll('.clf-stage')).toHaveLength(1);
  });
});

/**
 * The instruction the app typed to open the chat.
 *
 * A resumed chat opens with the whole handoff brief and a worker chat with "You are worker
 * agent worker-n …", and both arrive as an ordinary user message. It has to be sent —
 * ChatGPT needs it — but it does not have to be the first thing anybody reads.
 */
describe('folding away the chat’s opening instruction', () => {
  const BRIEF = 'TASK — ship v1.6\nREQUIREMENTS — no install, no reload\nDONE — the store fix';

  async function opened(kind: string | null, text = BRIEF): Promise<HTMLElement> {
    const section = userTurn(live!.document, 'u1', text);
    live!.reply.set('activity', () => ({
      ok: true,
      data: {
        entries: [],
        bootstrap: kind,
        job: null
      }
    }));
    await live!.hook.pullActivity();
    await settle();
    return section;
  }

  it('leaves a chat the user started alone', async () => {
    live = await harness();
    const section = await opened(null, 'rename the thing');
    expect(section.querySelector('.clf-boot')).toBeNull();
    expect(section.textContent).toContain('rename the thing');
  });

  it('folds it away without losing a word of it', async () => {
    live = await harness();
    const section = await opened('resume');
    const fold = section.querySelector('.clf-boot') as HTMLElement;
    expect(fold).not.toBeNull();
    expect(fold.querySelector('summary')!.textContent).toContain('not something you typed');
    // Moved, not copied: one copy of a several-thousand-character brief, not two.
    expect(section.querySelectorAll('.whitespace-pre-wrap')).toHaveLength(1);
    expect(fold.textContent).toContain('REQUIREMENTS — no install, no reload');
    expect((section.querySelector('[data-message-id]') as HTMLElement).dataset.clfBootstrap).toBe('resume');
  });

  it('says which kind of machinery it was', async () => {
    live = await harness();
    const section = await opened('worker', 'You are worker agent worker-1. Your task is …');
    expect(section.querySelector('.clf-boot summary')!.textContent).toContain('gave the worker');
  });

  it('folds only the first message, not everything the user went on to say', async () => {
    live = await harness();
    const first = await opened('resume');
    const later = userTurn(live.document, 'u2', 'now do the next bit');
    live.hook.foldBootstrap();
    expect(first.querySelector('.clf-boot')).not.toBeNull();
    expect(later.querySelector('.clf-boot')).toBeNull();
  });

  /**
   * Asks the DOM rather than remembering. React re-rendering the message would take the
   * fold with it, and a remembered "already done" would leave the wall of text on screen.
   */
  it('folds it again when ChatGPT rebuilds the message', async () => {
    live = await harness();
    const section = await opened('resume');
    const message = section.querySelector('[data-message-id]') as HTMLElement;
    message.replaceChildren(live.document.createElement('div'));
    message.firstElementChild!.textContent = BRIEF;

    live.hook.foldBootstrap();
    expect(section.querySelector('.clf-boot')!.textContent).toContain('TASK — ship v1.6');
    expect(section.querySelectorAll('.clf-boot')).toHaveLength(1);
  });

  it('is not fooled by a chat whose first message is the assistant’s', async () => {
    live = await harness();
    assistantTurn(live.document, 'turn-0', []);
    const first = live.document.createElement('div');
    first.setAttribute('data-message-id', 'a1');
    first.setAttribute('data-message-author-role', 'assistant');
    live.document.querySelector('[data-turn="assistant"]')!.append(first);
    const section = userTurn(live.document, 'u1', BRIEF);

    live.reply.set('activity', () => ({
      ok: true,
      data: {
        entries: [],
        bootstrap: 'resume',
        job: null
      }
    }));
    await live.hook.pullActivity();
    await settle();
    expect(section.querySelector('.clf-boot')).toBeNull();
  });
});

describe('the fresh chat the app opened', () => {
  it('delivers the bootstrap before unrelated status restoration can stall startup', async () => {
    let releaseStatus: () => void = () => undefined;
    const statusHeld = new Promise((resolve) => {
      releaseStatus = () => resolve({ connected: true, paired: true, port: 8765, pending: 0 });
    });
    live = await harness(
      'https://chatgpt.com/?clf=cmd-fast-resume',
      {
        // This deliberately never resolves during the assertion. Before the fix,
        // runCommand() sat behind checkStatus(), so the fresh chat stayed blank here.
        status: () => statusHeld,
        redeem: () => ({
          ok: true,
          command: { id: 'cmd-fast-resume', type: 'resume', text: 'the long carried handoff', agent: null }
        }),
        ack: () => ({ ok: true })
      },
      (document, dom) => {
        document.querySelector('[data-testid="send-button"]')!.addEventListener('click', () => {
          dom.reconfigure({ url: 'https://chatgpt.com/c/12121212-3434-5656-7878-909090909090' });
        });
      }
    );

    await settle(200);
    expect(live.sent[0]?.type).toBe('register_document');
    expect(live.sent[1]?.type).toBe('redeem');
    expect(live.sent.findIndex((message) => message.type === 'redeem')).toBeLessThan(
      live.sent.findIndex((message) => message.type === 'status')
    );
    expect(live.document.querySelector('#prompt-textarea')!.textContent).toContain('the long carried handoff');
    expect(live.sent.some((message) => message.type === 'ack' && message.status === 'sent')).toBe(true);

    releaseStatus();
    await settle();
  });

  it('does not journal replacement-chat observations until the resume ACK has committed the session move', async () => {
    let releaseAck: () => void = () => undefined;
    const ackHeld = new Promise<{ ok: boolean }>((resolve) => {
      releaseAck = () => resolve({ ok: true });
    });
    live = await harness(
      'https://chatgpt.com/?clf=cmd-gated',
      {
        redeem: () => ({
          ok: true,
          command: { id: 'cmd-gated', type: 'resume', text: 'the carried handoff', agent: null }
        }),
        ack: () => ackHeld
      },
      (document, dom) => {
        document.querySelector('[data-testid="send-button"]')!.addEventListener('click', () => {
          dom.reconfigure({ url: 'https://chatgpt.com/c/99999999-8888-7777-6666-555555555555' });
        });
      }
    );

    // Let the bootstrap send and the fresh chat acquire its id. The ACK is deliberately
    // still blocked, which is the exact window that used to create the three-event shadow.
    await settle(350);
    live.hook.observe();
    live.hook.emit({ kind: 'user_message', text: 'the carried handoff', messageId: 'boot-msg' });
    await live.hook.flush();
    expect(live.sent.filter((message) => message.type === 'events')).toHaveLength(0);

    releaseAck();
    await settle(100);
    const events = live.sent.filter((message) => message.type === 'events');
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((message) => JSON.stringify(message).includes('the carried handoff'))).toBe(true);
  });

  it('redeems the one command its URL names, and reports the conversation it became', async () => {
    live = await harness(
      'https://chatgpt.com/?clf=cmd-7#clf=cmd-7',
      {
        redeem: () => ({
          ok: true,
          command: {
            id: 'cmd-7',
            type: 'resume',
            text: 'Continue the previous ChatGPT session. Handoff: h-1',
            agent: null
          }
        }),
        ack: () => ({ ok: true })
      },
      (document, dom) => {
        // ChatGPT accepting the message is what gives the chat its id.
        document.querySelector('[data-testid="send-button"]')!.addEventListener('click', () => {
          dom.reconfigure({ url: 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555' });
        });
      }
    );

    // No manual call: delivering the command is the first thing the script does on a
    // page the app opened, and that is the path under test.
    await settle(400);

    // The page says which page it is. A command belongs to one of them: a second tab on
    // the same marker is a different claimant, and the app refuses it rather than letting
    // two fresh chats both believe they are the replacement.
    const redeems = live.sent.filter((message) => message.type === 'redeem');
    expect(redeems).toHaveLength(1);
    expect(redeems[0]).toMatchObject({ type: 'redeem', id: 'cmd-7' });
    expect(typeof redeems[0]!.client).toBe('string');
    expect(redeems[0]!.client).not.toBe('');
    expect(live.document.querySelector('#prompt-textarea')!.textContent).toContain('Handoff: h-1');
    expect(live.sent.filter((message) => message.type === 'ack')).toEqual([
      {
        type: 'ack',
        id: 'cmd-7',
        status: 'sent',
        conversationId: '11111111-2222-3333-4444-555555555555',
        agent: null,
        client: redeems[0]!.client,
        navigationEpoch: expect.any(Number)
      }
    ]);
  });

  it('abandons a redeemed bootstrap if SPA navigation retargets the tab before insertion', async () => {
    let page: JSDOM | null = null;
    let sends = 0;
    live = await harness(
      'https://chatgpt.com/?clf=cmd-navigation-race#clf=cmd-navigation-race',
      {
        redeem: () => {
          // The command was redeemed for the marked fresh page, but before the await in
          // deliverCommand resumes the user navigates this same SPA document to an existing
          // conversation. The composer is still empty, so text-content checks alone cannot
          // distinguish it from the command's original target.
          page!.reconfigure({ url: 'https://chatgpt.com/c/abababab-cdcd-efef-1212-343434343434' });
          return {
            ok: true,
            command: {
              id: 'cmd-navigation-race',
              type: 'worker',
              text: 'This bootstrap belongs only in the marked fresh chat.',
              agent: 'worker-1'
            }
          };
        },
        ack: () => ({ ok: true })
      },
      (document, dom) => {
        page = dom;
        document.querySelector('[data-testid="send-button"]')!.addEventListener('click', () => {
          sends++;
        });
      }
    );

    await settle(400);

    expect(sends).toBe(0);
    expect(composerText(live.document)).toBe('');
    expect(live.sent.filter((message) => message.type === 'ack')).toEqual([
      expect.objectContaining({
        id: 'cmd-navigation-race',
        status: 'failed',
        error: expect.stringMatching(/page changed|fresh chat|navigation/i)
      })
    ]);
  });

  it('abandons a redeemed bootstrap when recorder takeover supersedes its document owner', async () => {
    let redeemCalls = 0;
    let releaseFirst!: (value: unknown) => void;
    const firstRedeem = new Promise<unknown>((resolve) => {
      releaseFirst = resolve;
    });
    let sends = 0;
    live = await harness(
      'https://chatgpt.com/?clf=cmd-recorder-takeover#clf=cmd-recorder-takeover',
      {
        redeem: () => {
          redeemCalls++;
          // The predecessor owns the first request. Recovery injects a successor while that
          // request is unresolved; its own marker attempt is refused so only the stale
          // predecessor can accidentally type the bootstrap in this repro.
          return redeemCalls === 1 ? firstRedeem : { ok: false, error: 'command_taken' };
        },
        ack: () => ({ ok: true })
      },
      (document) => {
        document.querySelector('[data-testid="send-button"]')!.addEventListener('click', () => {
          sends++;
        });
      }
    );
    expect(redeemCalls).toBe(1);

    const window = live.window as any;
    window.chrome.runtime.id = 'clf-extension-id';
    window.__CLF_CONTENT_RECORDER__.healthy = () => false;
    window.CLF_TEST_HOOK = () => undefined;
    window.eval(contentSource);
    await settle();
    expect(redeemCalls).toBe(2);

    releaseFirst({
      ok: true,
      command: {
        id: 'cmd-recorder-takeover',
        type: 'worker',
        text: 'Only the authoritative recorder may send this.',
        agent: 'worker-1'
      }
    });
    await settle(400);

    expect(sends).toBe(0);
    expect(composerText(live.document)).toBe('');
  });

  it('removes predecessor body UI and delegated DOM handlers during recorder takeover', async () => {
    live = await harness();
    expect(live.listenerCounts()).toEqual({ runtime: 1, storage: 1 });
    live.hook.injectControl();
    live.hook.toggleMenu();
    await settle();

    const oldMenu = live.document.querySelector('.clf-menu') as HTMLElement;
    expect(oldMenu).not.toBeNull();
    expect(oldMenu.hidden).toBe(false);

    // Tips are delegated from the document, so use an ordinary body node to prove the old
    // recorder owns a live document-level listener rather than a handler attached to its menu.
    const tipAnchor = live.document.createElement('button');
    tipAnchor.setAttribute('data-clf-tip', 'predecessor tip');
    live.document.body.append(tipAnchor);
    tipAnchor.focus();
    await settle();
    const oldTip = live.document.querySelector('.clf-tip') as HTMLElement;
    expect(oldTip).not.toBeNull();
    expect(oldTip.hidden).toBe(false);

    const window = live.window as any;
    window.chrome.runtime.id = 'clf-extension-id';
    window.__CLF_CONTENT_RECORDER__.healthy = () => false;
    let successor: Hook | null = null;
    window.CLF_TEST_HOOK = (api: Hook) => {
      successor = api;
    };
    window.eval(contentSource);
    await settle(120);

    expect(oldMenu.isConnected).toBe(false);
    expect(oldTip.isConnected).toBe(false);
    expect(live.document.querySelectorAll('.clf-menu')).toHaveLength(0);
    expect(live.document.querySelectorAll('.clf-tip')).toHaveLength(0);
    expect(successor).not.toBeNull();
    // Browser-extension listeners live outside the DOM cleanup above. Leaving the predecessor's
    // runtime/storage subscriptions behind lets it answer health/revival messages or repaint the
    // page after ownership was revoked, racing the successor in the same isolated world.
    expect(live.listenerCounts()).toEqual({ runtime: 1, storage: 1 });

    // The replacement owns exactly one delegated tooltip listener/surface. If the predecessor's
    // listener survived, this focus would create both its stale bubble and the successor's.
    tipAnchor.blur();
    tipAnchor.focus();
    await settle();
    expect(live.document.querySelectorAll('.clf-tip')).toHaveLength(1);
  });

  it('never submits a worker bootstrap mixed with text typed after the tab took focus', async () => {
    let sends = 0;
    live = await harness(
      'https://chatgpt.com/?clf=cmd-focus-race',
      {
        redeem: () => ({
          ok: true,
          command: { id: 'cmd-focus-race', type: 'worker', text: 'Audit the worker identity path.', agent: 'worker-1' }
        }),
        ack: () => ({ ok: true })
      },
      (document, dom) => {
        document.querySelector('[data-testid="send-button"]')!.addEventListener('click', () => {
          sends++;
          dom.reconfigure({ url: 'https://chatgpt.com/c/99999999-aaaa-bbbb-cccc-dddddddddddd' });
        });
        const composer = document.querySelector('#prompt-textarea')!;
        let changed = false;
        new dom.window.MutationObserver(() => {
          if (changed || !(composer.textContent || '').includes('Audit the worker identity path.')) return;
          changed = true;
          const user = document.createElement('p');
          user.textContent = 'my unsent draft';
          composer.append(user);
        }).observe(composer, { childList: true, subtree: true });
      }
    );

    await settle(400);

    expect(sends).toBe(0);
    expect(live.document.querySelector('#prompt-textarea')!.textContent).toContain('my unsent draft');
    expect(live.sent.filter((message) => message.type === 'ack')).toEqual([
      expect.objectContaining({
        id: 'cmd-focus-race',
        status: 'failed',
        error: expect.stringMatching(/composer changed|draft was preserved|replaced the composer/)
      })
    ]);
  });

  it('sends a worker bootstrap whose task is shorter than the text it verifies', async () => {
    // The bootstrap is the task, a blank line, and the wrapper explaining how to report.
    // The composer turns that blank line into a paragraph break and gives the text back
    // with no newline in it at all, so verifying the insert by looking for the first 80
    // characters verbatim failed for every task short enough to leave the break inside
    // them — reported to the app as ChatGPT having replaced the composer, which retired
    // the worker slot before the chat had said a word. Live, both workers of a two-worker
    // run died this way.
    const task = 'Read /project/chat-on-steroids/package.json and report the version field.';
    live = await harness(
      'https://chatgpt.com/?clf=cmd-10',
      {
        redeem: () => ({
          ok: true,
          command: {
            id: 'cmd-10',
            type: 'worker',
            text: `${task}

(You are a worker agent in a Chat On Steroids multi-agent run.)`,
            agent: 'worker-1'
          }
        }),
        ack: () => ({ ok: true })
      },
      (document, dom) => {
        document.querySelector('[data-testid="send-button"]')!.addEventListener('click', () => {
          dom.reconfigure({ url: 'https://chatgpt.com/c/22222222-3333-4444-5555-666666666666' });
        });
      }
    );

    await settle(400);

    expect(live.document.querySelector('#prompt-textarea')!.textContent).toContain(task);
    expect(live.sent.filter((message) => message.type === 'ack')).toEqual([
      {
        type: 'ack',
        id: 'cmd-10',
        status: 'sent',
        conversationId: '22222222-3333-4444-5555-666666666666',
        agent: 'worker-1',
        client: expect.any(String),
        navigationEpoch: expect.any(Number)
      }
    ]);
  });

  it('acks a same-chat revival immediately after ChatGPT accepts the send, before any timer can be throttled', async () => {
    const chat = '22222222-3333-4444-5555-777777777777';
    let freezeTimers = false;
    let originalTimeout: typeof globalThis.setTimeout | null = null;
    live = await harness(
      `https://chatgpt.com/c/${chat}`,
      {
        redeem: () => ({
          ok: true,
          command: {
            id: 'cmd-revive-fast-ack',
            type: 'worker',
            text: 'Continue the parser audit from where you left off.',
            agent: 'worker-1',
            conversationId: chat
          }
        }),
        ack: () => ({ ok: true })
      },
      (document, dom) => {
        originalTimeout = dom.window.setTimeout.bind(dom.window) as unknown as typeof globalThis.setTimeout;
        const send = document.querySelector('[data-testid="send-button"]')!;
        send.addEventListener('click', () => {
          const composer = document.querySelector('#prompt-textarea')!;
          composer.textContent = '';
          freezeTimers = true;
          // Model Chrome throttling/suspending the background tab immediately after ChatGPT
          // accepted the user message. Any post-send sleep now never fires.
          dom.window.setTimeout = ((fn: () => void, ms?: number) => {
            if (freezeTimers) return 777;
            return (originalTimeout as any)(fn, ms);
          }) as unknown as typeof dom.window.setTimeout;
        });
      }
    );

    const response = await live.runtimeMessage({
      type: 'clf-run-command',
      id: 'cmd-revive-fast-ack',
      conversationId: chat
    });
    // Background may close the app-opened fallback only after this existing document proves it
    // acquired the bridge's durable lease. "I started an async function" is not ownership.
    expect(response).toEqual({ ok: true, claimed: true });
    await settle(300);

    expect(live.sent.filter((message) => message.type === 'ack')).toContainEqual(
      expect.objectContaining({
        id: 'cmd-revive-fast-ack',
        status: 'sent',
        conversationId: chat,
        agent: 'worker-1'
      })
    );
    freezeTimers = false;
  });

  it('submits a same-chat revival while the exact worker tab is hidden without waiting for a foreground timer', async () => {
    const chat = '22222222-3333-4444-5555-787878787878';
    let sends = 0;
    live = await harness(
      `https://chatgpt.com/c/${chat}`,
      {
        redeem: () => ({
          ok: true,
          command: {
            id: 'cmd-hidden-revive-no-timer',
            type: 'worker',
            text: 'Continue the hidden-tab audit without user interaction.',
            agent: 'worker-1',
            conversationId: chat
          }
        }),
        ack: () => ({ ok: true })
      },
      (document) => {
        document.querySelector('[data-testid="send-button"]')!.addEventListener('click', () => {
          sends++;
          document.querySelector('#prompt-textarea')!.textContent = '';
        });
      }
    );

    Object.defineProperty(live.document, 'visibilityState', { configurable: true, value: 'hidden' });
    // Model Chrome's long-background-tab timer throttling at the exact boundary the live wake hit:
    // the runtime handoff itself is delivered, but wall-clock callbacks in the page do not run
    // until somebody foregrounds it. Revival delivery must not need such a callback after it has
    // proved the exact chat is idle and before it clicks Send.
    live.window.setTimeout = (() => 991) as unknown as typeof live.window.setTimeout;

    void live.runtimeMessage({
      type: 'clf-run-command',
      id: 'cmd-hidden-revive-no-timer',
      conversationId: chat
    });
    await settle(400);

    expect(live.document.visibilityState).toBe('hidden');
    expect(sends).toBe(1);
    expect(composerText(live.document)).toBe('');
    expect(live.sent.filter((message) => message.type === 'redeem')).toHaveLength(1);
    expect(live.sent.filter((message) => message.type === 'ack')).toEqual([
      expect.objectContaining({
        id: 'cmd-hidden-revive-no-timer',
        status: 'sent',
        conversationId: chat,
        agent: 'worker-1'
      })
    ]);
  });

  it('defers finish -> revive until the worker final answer is genuinely settled, then sends and ACKs exactly once', async () => {
    const chat = '23232323-3434-4545-8686-797979797979';
    let redeemCalls = 0;
    let sends = 0;
    let assistant: HTMLElement | null = null;
    live = await harness(
      `https://chatgpt.com/c/${chat}`,
      {
        redeem: () => {
          redeemCalls++;
          return {
            ok: true,
            command: {
              id: 'cmd-revive-after-finish',
              type: 'worker',
              text: 'Continue only after your final answer is finished.',
              agent: 'worker-1',
              conversationId: chat
            }
          };
        },
        ack: () => ({ ok: true })
      },
      (document) => {
        assistant = assistantTurn(document, 'turn-finishing-worker', []);
        const partial = document.createElement('div');
        partial.className = 'markdown';
        partial.textContent = 'Final handoff is still streaming';
        assistant.append(partial);
        startGenerating(document);
        document.querySelector('[data-testid="send-button"]')!.addEventListener('click', () => {
          sends++;
          document.querySelector('#prompt-textarea')!.textContent = '';
        });
      }
    );

    // Broker terminality has already happened in the scenario. The browser is a separate state:
    // while this exact assistant turn still owns Stop/generation, no document lease is redeemed
    // and no revival text is parked in the user's composer.
    const handedOff = live.runtimeMessage({
      type: 'clf-run-command',
      id: 'cmd-revive-after-finish',
      conversationId: chat
    });
    await settle(100);
    expect(redeemCalls).toBe(0);
    expect(sends).toBe(0);
    expect(composerText(live.document)).toBe('');
    expect(live.sent.filter((message) => message.type === 'ack')).toHaveLength(0);

    // Stop disappearing is deliberately still not enough. The recorder's existing settle window
    // protects against the same tool-phase/rerender dropout that used to split live generations.
    stopGenerating(live.document);
    live.hook.observe();
    await settle();
    expect(redeemCalls).toBe(0);
    expect(composerText(live.document)).toBe('');

    live.advance(live.hook.TURN_SETTLE_MS);
    // Give the settled assistant turn the exact completed-message evidence the live page mounts.
    const copy = live.document.createElement('button');
    copy.setAttribute('aria-label', 'Copy message');
    assistant!.append(copy);
    live.hook.observe();
    await settle(300);

    expect(await handedOff).toEqual({ ok: true, claimed: true });
    expect(redeemCalls).toBe(1);
    expect(sends).toBe(1);
    expect(live.sent.filter((message) => message.type === 'redeem')).toHaveLength(1);
    expect(live.sent.filter((message) => message.type === 'ack')).toEqual([
      expect.objectContaining({
        id: 'cmd-revive-after-finish',
        status: 'sent',
        conversationId: chat,
        agent: 'worker-1'
      })
    ]);
  });

  it('does not redeem until deferred-revival custody survives a transient persistence failure', async () => {
    const chat = '24242424-3535-4646-8787-808080808080';
    let custodyCalls = 0;
    let redeemCalls = 0;
    let sends = 0;
    live = await harness(
      `https://chatgpt.com/c/${chat}`,
      {
        defer_revival: () => {
          custodyCalls++;
          return custodyCalls === 1 ? { ok: false, error: 'QUOTA_BYTES exceeded' } : { ok: true, deferred: true };
        },
        redeem: () => {
          redeemCalls++;
          return {
            ok: true,
            command: {
              id: 'cmd-revive-custody-retry',
              type: 'worker',
              text: 'Send only after browser custody is durable.',
              agent: 'worker-1',
              conversationId: chat
            }
          };
        },
        ack: () => ({ ok: true })
      },
      (document) => {
        document.querySelector('[data-testid="send-button"]')!.addEventListener('click', () => {
          sends++;
          document.querySelector('#prompt-textarea')!.textContent = '';
        });
      }
    );

    const result = await live.runtimeMessage({
      type: 'clf-run-command',
      id: 'cmd-revive-custody-retry',
      conversationId: chat
    });
    await settle(300);

    expect(result).toEqual({ ok: true, claimed: true });
    expect(custodyCalls).toBe(2);
    expect(redeemCalls).toBe(1);
    expect(sends).toBe(1);
    const custodyIndex = live.sent.findIndex((message) => message.type === 'defer_revival' && message.id === 'cmd-revive-custody-retry');
    const redeemIndex = live.sent.findIndex((message) => message.type === 'redeem' && message.id === 'cmd-revive-custody-retry');
    expect(custodyIndex).toBeGreaterThanOrEqual(0);
    expect(redeemIndex).toBeGreaterThan(custodyIndex);
  });

  it('lets a newer worker wake supersede an older deferred recovery waiter without touching the user draft', async () => {
    const chat = '26262626-3737-4848-9090-828282828282';
    const oldId = 'cmd-stale-recovered-wake';
    const currentId = 'cmd-current-worker-wake';
    const redeemed: string[] = [];
    let sends = 0;
    live = await harness(
      `https://chatgpt.com/c/${chat}`,
      {
        redeem: (message) => {
          redeemed.push(String(message.id || ''));
          return message.id === currentId
            ? {
                ok: true,
                command: {
                  id: currentId,
                  type: 'worker',
                  text: 'Use the newer queued wake.',
                  agent: 'worker-1',
                  conversationId: chat
                }
              }
            : { ok: true, command: null };
        },
        ack: () => ({ ok: true })
      },
      (document) => {
        // This is the live safety constraint: an old recovery attempt is allowed to sit before
        // redeem while the user has a draft. The extension must never erase that draft merely to
        // make a wake progress.
        document.querySelector('#prompt-textarea')!.textContent = 'my unsent draft';
        document.querySelector('[data-testid="send-button"]')!.addEventListener('click', () => {
          sends++;
          document.querySelector('#prompt-textarea')!.textContent = '';
        });
      }
    );

    const oldRecovery = live.runtimeMessage({
      type: 'clf-run-command',
      id: oldId,
      conversationId: chat,
      deferredRecovery: true
    });
    await settle(100);
    expect(redeemed).toEqual([]);
    expect(composerText(live.document)).toBe('my unsent draft');

    // The app has now opened a newer revival for the same worker/chat. Before this regression,
    // commandInFlight made this handoff answer `busy` forever while the fallback stayed fenced to
    // this exact tab. The new wake may replace only the old pre-redeem recovery waiter.
    const currentWake = live.runtimeMessage({
      type: 'clf-run-command',
      id: currentId,
      conversationId: chat
    });
    await settle(100);
    expect(await oldRecovery).toEqual({ ok: true, claimed: false });
    expect(redeemed).toEqual([]);
    expect(sends).toBe(0);
    expect(composerText(live.document)).toBe('my unsent draft');

    // Simulate the user deliberately clearing their own draft. The exact existing worker tab then
    // redeems only the current wake and submits it once; the stale recovered id never crosses the
    // bridge ownership boundary.
    live.document.querySelector('#prompt-textarea')!.textContent = '';
    live.hook.observe();
    await settle(300);

    expect(await currentWake).toEqual({ ok: true, claimed: true });
    expect(redeemed).toEqual([currentId]);
    expect(sends).toBe(1);
    expect(live.sent.filter((message) => message.type === 'redeem').map((message) => message.id)).toEqual([currentId]);
    expect(live.sent.filter((message) => message.type === 'ack')).toEqual([
      expect.objectContaining({ id: currentId, status: 'sent', conversationId: chat, agent: 'worker-1' })
    ]);
  });

  it('keeps terminal turn observations in page custody until durable flush before redeeming the revival', async () => {
    const chat = '25252525-3636-4747-8989-818181818181';
    let terminalFlushes = 0;
    let redeemCalls = 0;
    let sends = 0;
    let assistant: HTMLElement | null = null;
    let releaseDurableTerminal!: () => void;
    const durableTerminalHeld = new Promise<{ ok: boolean; pending: number; durable: boolean }>((resolve) => {
      releaseDurableTerminal = () => resolve({ ok: true, pending: 0, durable: true });
    });
    live = await harness(
      `https://chatgpt.com/c/${chat}`,
      {
        events: (message) => {
          const terminal = (message.entries || []).some((entry: any) => entry?.event?.kind === 'turn_end');
          if (!terminal) return { ok: true, pending: 0, durable: true };
          terminalFlushes++;
          return terminalFlushes === 1
            ? { ok: true, pending: 1, durable: false }
            : durableTerminalHeld;
        },
        redeem: () => {
          redeemCalls++;
          return {
            ok: true,
            command: {
              id: 'cmd-revive-after-durable-end',
              type: 'worker',
              text: 'This must follow the durable terminal turn.',
              agent: 'worker-1',
              conversationId: chat
            }
          };
        },
        ack: () => ({ ok: true })
      },
      (document) => {
        assistant = assistantTurn(document, 'turn-durable-revival-boundary', []);
        const partial = document.createElement('div');
        partial.className = 'markdown';
        partial.textContent = 'Finishing before the revived message';
        assistant.append(partial);
        startGenerating(document);
        document.querySelector('[data-testid="send-button"]')!.addEventListener('click', () => {
          sends++;
          document.querySelector('#prompt-textarea')!.textContent = '';
        });
      }
    );

    const handedOff = live.runtimeMessage({
      type: 'clf-run-command',
      id: 'cmd-revive-after-durable-end',
      conversationId: chat
    });
    await settle(100);
    expect(redeemCalls).toBe(0);

    stopGenerating(live.document);
    live.hook.observe();
    await settle();
    live.advance(live.hook.TURN_SETTLE_MS);
    const copy = live.document.createElement('button');
    copy.setAttribute('aria-label', 'Copy message');
    assistant!.append(copy);
    live.hook.observe();
    await settle(200);

    // The recorder is free to retry from another real lifecycle signal. Even if that second
    // attempt is already in flight, it has not been acknowledged durable yet, so the revival
    // still may not redeem or touch the composer.
    if (terminalFlushes === 1) {
      live.hook.observe();
      await settle(100);
    }
    expect(terminalFlushes).toBe(2);
    expect(redeemCalls).toBe(0);
    expect(sends).toBe(0);
    expect(live.sent.some((message) => message.type === 'redeem' && message.id === 'cmd-revive-after-durable-end')).toBe(false);

    // The exact second attempt now becomes durable. Only this release may let the command cross
    // the redeem/send boundary.
    releaseDurableTerminal();
    await settle(300);

    expect(terminalFlushes).toBe(2);
    expect(await handedOff).toEqual({ ok: true, claimed: true });
    expect(redeemCalls).toBe(1);
    expect(sends).toBe(1);
    const terminalEventIndexes = live.sent
      .map((message, index) =>
        message.type === 'events' && (message.entries || []).some((entry: any) => entry?.event?.kind === 'turn_end')
          ? index
          : -1
      )
      .filter((index) => index >= 0);
    const redeemIndex = live.sent.findIndex((message) => message.type === 'redeem' && message.id === 'cmd-revive-after-durable-end');
    expect(terminalEventIndexes).toHaveLength(2);
    expect(redeemIndex).toBeGreaterThan(terminalEventIndexes[1]!);
  });

  it('does not call a synthetic Enter key an accepted bootstrap send', async () => {
    let keydowns = 0;
    live = await harness(
      'https://chatgpt.com/?clf=cmd-enter-noop',
      {
        redeem: () => ({
          ok: true,
          command: {
            id: 'cmd-enter-noop',
            type: 'worker',
            text: 'Verify that the browser observed an accepted send.',
            agent: 'worker-1'
          }
        }),
        ack: () => ({ ok: true })
      },
      (document) => {
        const button = document.querySelector('[data-testid="send-button"]') as HTMLButtonElement;
        button.disabled = true;
        document.querySelector('#prompt-textarea')!.addEventListener('keydown', (event) => {
          if ((event as KeyboardEvent).key === 'Enter') keydowns++;
          // Deliberately do nothing. dispatchEvent succeeding is not ChatGPT accepting text.
        });
      }
    );

    await settle(400);

    expect(keydowns).toBe(1);
    expect(live.sent.filter((message) => message.type === 'ack')).toEqual([
      expect.objectContaining({
        id: 'cmd-enter-noop',
        status: 'failed',
        error: 'ChatGPT did not accept the bootstrap send'
      })
    ]);
    expect(live.sent.some((message) => message.type === 'ack' && message.status === 'sent')).toBe(false);
  });

  it('types nothing when the marker is stale', async () => {
    live = await harness('https://chatgpt.com/?clf=cmd-old', {
      redeem: () => ({ ok: true, command: null, gone: true })
    });

    await live.hook.runCommand();
    await settle();

    expect(live.sent.filter((message) => message.type === 'redeem')).toHaveLength(1);
    expect(live.sent.filter((message) => message.type === 'ack')).toHaveLength(0);
    expect(live.document.querySelector('#prompt-textarea')!.textContent).toBe('');
  });

  it('types nothing into a chat that already exists, whatever the marker says', async () => {
    // Every command the app queues opens a *fresh* chat; there is no longer any kind that
    // types into a conversation that already exists. So a marker carried into one — a
    // reloaded tab that has since got an id, a URL out of history, a duplicated tab — is
    // refused on sight, without a keystroke and without an acknowledgement that would
    // retire a command still owed a chat of its own.
    live = await harness('https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?clf=cmd-8', {
      redeem: () => ({
        ok: true,
        command: { id: 'cmd-8', type: 'worker', text: 'You are worker agent "worker-1".', agent: 'worker-1' }
      }),
      ack: () => ({ ok: true })
    });

    await live.hook.runCommand();
    await settle();

    expect(live.sent.filter((message) => message.type === 'ack')).toHaveLength(0);
    expect(live.document.querySelector('#prompt-textarea')!.textContent).toBe('');
  });

  it('tells the app it failed, once, and does not try again', async () => {
    live = await harness(
      'https://chatgpt.com/?clf=cmd-9',
      {
        redeem: () => ({
          ok: true,
          command: { id: 'cmd-9', type: 'worker', text: 'You are worker agent "worker-1".', agent: 'worker-1' }
        }),
        ack: () => ({ ok: true })
      },
      // ChatGPT refuses the insertion: the composer already holds a draft.
      (document) => {
        document.querySelector('#prompt-textarea')!.textContent = 'a draft the user was writing';
      }
    );
    await settle(200);

    for (let attempt = 0; attempt < 3; attempt++) {
      await live.hook.runCommand();
      await settle(200);
    }

    // One attempt, one answer. The retry loop and the `working` acks that renewed a lease
    // between attempts are gone: the page is opened for exactly one command, and what it
    // reports is final. Calling `runCommand` again — a second startup tick, a re-render — is
    // a no-op rather than a second redeem, because a repeat here would have been a second
    // bootstrap typed into the same chat.
    const acks = live.sent.filter((message) => message.type === 'ack');
    expect(acks.map((ack) => ack.status)).toEqual(['failed']);
    expect(acks[0]!.error).toBe('the composer already holds something the user was writing');
    expect(live.sent.filter((message) => message.type === 'redeem')).toHaveLength(1);
  });
});

/**
 * The context meter, and compaction that starts itself.
 *
 * Both read the same two numbers out of `/activity` — what the recording holds, and the
 * lines it is measured against. That is the point of sending them together: a bar that
 * filled against a figure of its own would show a full bar and do nothing, or compact a
 * conversation that still looked half empty.
 */
describe('the context meter and automatic compaction', () => {
  let live: Harness | null = null;

  afterEach(() => {
    live?.close();
    live = null;
  });

  /** An `/activity` answer carrying a token count and the settings it is measured against. */
  const withContext = (
    tokens: number,
    context: Record<string, unknown> | null,
    over: Record<string, unknown> = {}
  ) => ({
    ok: true,
    data: {
      entries: [],
      stream: [],
      nextSince: 0,
      pendingTools: 0,
      job: null,
      tokens,
      context,
      ...over
    }
  });

  const settings = (over: Record<string, unknown> = {}) => ({
    auto: false,
    threshold: 300_000,
    warn: 300_000,
    limit: 400_000,
    ...over
  });

  it('fills towards the limit the app already warns about while nothing acts on the count', async () => {
    live = await harness(undefined, { activity: () => withContext(200_000, settings()) });
    live.hook.injectControl();
    await live.hook.pullActivity();

    const meter = live.hook.meterView()!;
    expect(meter.filled).toBeCloseTo(0.5, 5);
    expect(meter.level).toBe('ok');
    expect(meter.tip).toContain('400k');
    // Approximate on purpose: this counts what the recording holds, which is what a brief
    // would be written from — not ChatGPT's own accounting, which the page cannot see.
    // Below the short status line, which now leads the tooltip.
    expect(meter.tip).toBe(meter.status);
  });

  it('warns amber at the advisory line and red at the limit', async () => {
    live = await harness(undefined, { activity: () => withContext(320_000, settings()) });
    live.hook.injectControl();
    await live.hook.pullActivity();
    expect(live.hook.meterView()!.level).toBe('near');

    live.reply.set('activity', () => withContext(410_000, settings()));
    await live.hook.pullActivity();
    const full = live.hook.meterView()!;
    expect(full.level).toBe('full');
    expect(full.filled).toBe(1);
  });

  /**
   * With automatic compaction on, the threshold is the number that matters, because it is
   * where something will actually happen. A bar filling towards a limit while the chat was
   * being compacted at half of it would be measuring the wrong thing.
   */
  it('fills towards the threshold instead once automatic compaction is on', async () => {
    live = await harness(undefined, {
      activity: () => withContext(100_000, settings({ auto: true, threshold: 200_000 }))
    });
    live.hook.injectControl();
    await live.hook.pullActivity();

    const meter = live.hook.meterView()!;
    expect(meter.filled).toBeCloseTo(0.5, 5);
    expect(meter.tip).toBe('100k/200k · autocompact on');
  });

  /**
   * The count, the ceiling and the switch on one line.
   *
   * The tooltip already said all three in prose, and prose is what nobody reads while they
   * are working. `283k/400k · autocompact on` is the same three facts in the shape the user
   * asked for: whether the thing is armed is as much part of the reading as the number is,
   * because 283k out of 400k means something quite different depending on the answer.
   */
  it('says the count, the ceiling and whether it is armed on one line', async () => {
    live = await harness(undefined, { activity: () => withContext(283_000, settings({ auto: true, threshold: 400_000 })) });
    live.hook.injectControl();
    await live.hook.pullActivity();

    const meter = live.hook.meterView()!;
    expect(meter.status).toBe('283k/400k · autocompact on');
    // And the line leads the tooltip, so hovering says the short thing before the long one.
    expect(meter.tip.startsWith(meter.status)).toBe(true);
  });

  it('says so on the same line when automatic compaction is off', async () => {
    live = await harness(undefined, { activity: () => withContext(283_000, settings({ auto: false })) });
    live.hook.injectControl();
    await live.hook.pullActivity();
    expect(live.hook.meterView()!.status).toBe('283k/400k · autocompact off');
  });

  it('counts towards the threshold in the status line too, once one is set', async () => {
    live = await harness(undefined, {
      activity: () => withContext(100_000, settings({ auto: true, threshold: 200_000 }))
    });
    live.hook.injectControl();
    await live.hook.pullActivity();
    expect(live.hook.meterView()!.status).toBe('100k/200k · autocompact on');
  });

  it('draws nothing when the app has sent no numbers to draw', async () => {
    live = await harness(undefined, { activity: () => withContext(0, null) });
    live.hook.injectControl();
    await live.hook.pullActivity();
    expect(live.hook.meterView()).toBeNull();
    expect((live.document.querySelector('.clf-meter') as HTMLElement).hidden).toBe(true);
  });

  it('stays off the button while a compaction is running', async () => {
    live = await harness(undefined, {
      activity: () =>
        withContext(390_000, settings(), {
          job: { sessionId: 's1', stage: 'compacting', busy: true, handoffId: null, error: null }
        })
    });
    live.hook.injectControl();
    await live.hook.pullActivity();
    // The count is still knowable; it is just no longer the question the control answers.
    expect(live.hook.meterView()).not.toBeNull();
    expect((live.document.querySelector('.clf-meter') as HTMLElement).hidden).toBe(true);
  });

  it('does not compact by itself while the switch is off', async () => {
    live = await harness(undefined, { activity: () => withContext(999_000, settings({ auto: false })) });
    live.hook.injectControl();
    await live.hook.pullActivity();
    await settle();
    expect(live.sent.filter((message) => message.type === 'compact')).toEqual([]);
  });

  it('never emits an automatic compaction claim from a worker chat, even if stale global state says ready', async () => {
    const workerGoal = {
      enabled: false,
      hasKey: true,
      model: 'test-model',
      objective: '',
      blocked: 'worker',
      draft: null
    };
    live = await harness(
      undefined,
      {
        activity: () =>
          withContext(450_000, settings({ auto: true, threshold: 200_000 }), {
            autoCompactReady: true,
            goal: workerGoal
          }),
        auto_compact_claim: () => ({ ok: true, data: { claimed: true } }),
        compact: () => ({ ok: true, data: { started: true, job: null } })
      },
      (document) => startGenerating(document)
    );
    live.hook.injectControl();
    await live.hook.pullActivity();
    await settle();

    expect(live.sent.filter((message) => message.type === 'auto_compact_claim')).toEqual([]);
    expect(startedCompactions(live)).toEqual([]);
    const workerSettings = live.hook.settingsView({
      context: settings({ auto: true, threshold: 200_000 }),
      goal: workerGoal,
      compact: { action: 'start', hint: '' },
      editing: false
    });
    expect(workerSettings.tip).toContain('Auto-compaction off');
    expect(workerSettings.rows.find((row) => row.key === 'autoCompact')?.on).toBe(false);
  });

  /**
   * The whole of the stale-chat protection, on the page's side of it.
   *
   * The trigger is a level now — "this chat is over the line and still has its one
   * compaction" — so an old 500k conversation answers yes to that for the rest of its life.
   * What stops it from compacting the moment it is opened is that nothing is running in it.
   * The app applies the same rule from the other side; this is the half a reader of
   * content.js can check.
   */
  it('leaves an idle chat alone however far over the line it is', async () => {
    live = await harness(undefined, {
      activity: () => withContext(999_000, settings({ auto: true, threshold: 200_000 }), { autoCompactReady: true }),
      auto_compact_claim: () => ({ ok: true, data: { claimed: true } }),
      compact: () => ({ ok: true, data: { started: true, job: null } })
    });
    live.hook.injectControl();
    for (let poll = 0; poll < 5; poll++) await live.hook.pullActivity();
    await settle();

    expect(startedCompactions(live)).toEqual([]);
    expect(live.sent.filter((message) => message.type === 'auto_compact_claim')).toEqual([]);
  });

  /**
   * And the rule that made all of this worth rewriting: a finished answer is the one moment
   * where compacting is pointless. The work it would carry into the fresh chat has already
   * been done and answered, so the handoff would summarise a job that is over.
   */
  it('does not compact once the answer has landed, even if the app still says yes', async () => {
    // Off while the turn runs, so this test is about the moment after it: the app goes on
    // reporting the level (the chat is still over the line) and the page still refuses.
    let ready = false;
    live = await harness(undefined, {
      activity: () => withContext(205_000, settings({ auto: true, threshold: 200_000 }), { autoCompactReady: ready }),
      auto_compact_claim: () => ({ ok: true, data: { claimed: true } }),
      compact: () => ({ ok: true, data: { started: true, job: null } })
    }, (document) => startGenerating(document));
    live.hook.injectControl();
    await settleTurn(live);
    ready = true;

    for (let poll = 0; poll < 3; poll++) await live.hook.pullActivity();
    await settle();
    expect(startedCompactions(live)).toEqual([]);
    expect(live.sent.filter((message) => message.type === 'auto_compact_claim')).toEqual([]);
  });

  it('interrupts the turn it is standing in and compacts exactly once', async () => {
    let ready = true;
    live = await harness(undefined, {
      activity: () => withContext(205_000, settings({ auto: true, threshold: 200_000 }), { autoCompactReady: ready }),
      auto_compact_claim: () => {
        ready = false;
        return { ok: true, data: { claimed: true } };
      },
      compact: () => ({
        ok: true,
        data: {
          started: true,
          token: 'tok-auto-1',
          prompt: 'write the brief and call save_handoff',
          job: { sessionId: 's1', stage: 'handoff-pending', busy: true, handoffId: null, error: null }
        }
      })
    });
    live.hook.injectControl();
    startGenerating(live.document);
    const stop = live.document.querySelector('[data-testid="stop-button"]') as HTMLButtonElement;
    let stopped = false;
    stop.addEventListener('click', () => {
      stopped = true;
      stopGenerating(live!.document);
    });

    await live.hook.pullActivity();
    await settle();

    expect(stopped).toBe(true);
    expect(live.sent.filter((message) => message.type === 'auto_compact_claim')).toHaveLength(1);
    expect(startedCompactions(live)).toHaveLength(1);

    // And not again: the app has withdrawn the bit, and this tab is busy with the run it
    // just started either way.
    for (let poll = 0; poll < 4; poll++) await live.hook.pullActivity();
    await settle();
    expect(startedCompactions(live)).toHaveLength(1);
  });

  /**
   * Mid-tool-call is mid-turn, and is explicitly allowed. Local calls are not raced: the
   * same settle barrier a manual press goes through waits for them before anything is typed.
   */
  it('compacts while a local tool call is still running', async () => {
    let ready = true;
    let asked = 0;
    live = await harness(undefined, {
      activity: () => {
        asked++;
        return withContext(205_000, settings({ auto: true, threshold: 200_000 }), {
          autoCompactReady: ready,
          pendingTools: asked < 3 ? 1 : 0
        });
      },
      auto_compact_claim: () => {
        ready = false;
        return { ok: true, data: { claimed: true } };
      },
      compact: () => ({
        ok: true,
        data: {
          started: true,
          token: 'tok-auto-2',
          prompt: 'write the brief and call save_handoff',
          job: { sessionId: 's1', stage: 'handoff-pending', busy: true, handoffId: null, error: null }
        }
      })
    });
    live.hook.injectControl();
    startGenerating(live.document);
    const stop = live.document.querySelector('[data-testid="stop-button"]') as HTMLButtonElement;
    stop.addEventListener('click', () => stopGenerating(live!.document));

    await live.hook.pullActivity();
    await settle();

    expect(live.sent.filter((message) => message.type === 'auto_compact_claim')).toHaveLength(1);
    expect(startedCompactions(live)).toHaveLength(1);
    // It waited for the call to finish before typing anything into the composer.
    expect(asked).toBeGreaterThanOrEqual(3);
  });

  it('does not claim when the app says this chat has no trigger left', async () => {
    live = await harness(undefined, {
      activity: () => withContext(250_000, settings({ auto: true, threshold: 200_000 }), { autoCompactReady: false }),
      auto_compact_claim: () => ({ ok: true, data: { claimed: false } }),
      compact: () => ({ ok: true, data: { started: true, job: null } })
    }, (document) => startGenerating(document));
    live.hook.injectControl();
    for (let poll = 0; poll < 5; poll++) await live.hook.pullActivity();
    await settle();

    expect(startedCompactions(live)).toEqual([]);
    expect(live.sent.filter((message) => message.type === 'auto_compact_claim')).toEqual([]);
  });
});

/**
 * Which answer becomes the brief.
 *
 * This is the load-bearing guarantee of Compact & Resume, and it is a guarantee about
 * identity rather than about text: the brief is the output of the one generation this tab
 * started by submitting the handoff instruction, and of no other. Not "the last assistant
 * message", not "the next thing that appears", not "the longest block on screen" — a chat
 * being compacted has been talked to for hours, and every one of those rules can be
 * satisfied by something the model wrote about something else entirely.
 *
 * So the tab binds the app's one-time token to a local generation id at the moment it
 * sends, and only that generation may hand a brief back. Every case below is a way that
 * binding could be lost or fooled, and the assertion is always one of two things: the
 * right text is delivered exactly once, or nothing is delivered at all and the transaction
 * is withdrawn — leaving the session in the chat it is already in, which is a failure the
 * user can see and press the button about.
 */
describe('binding the brief to the generation that wrote it', () => {
  const TOKEN = 'tok-capture';
  const CHAT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  /** An app that opens a compaction transaction and records what comes back. */
  const compactionReplies = (): Record<string, (message: Record<string, any>) => unknown> => ({
    compact: (message) => ({
      ok: true,
      data: message.cancel
        ? { cancelled: true }
        : { started: true, token: TOKEN, prompt: 'Write the brief …', job: null }
    }),
    // A reachable app with nothing running. Required, not decoration: settling the brief
    // asks this every second, and an app that does not answer is treated as one still
    // holding a call open rather than as one with nothing to report.
    activity: () => ({
      ok: true,
      data: { entries: [], stream: [], nextSince: 0, pendingTools: 0, job: null }
    })
  });

  /** The briefs this page handed the app, in order. */
  const delivered = (harnessed: Harness): Array<Record<string, any>> =>
    harnessed.sent.filter((message) => message.type === 'compact' && typeof message.summary === 'string');

  /** The withdrawals it sent instead. */
  const withdrawn = (harnessed: Harness): Array<Record<string, any>> =>
    harnessed.sent.filter((message) => message.type === 'compact' && message.cancel === true);

  /** One assistant message inside a turn, of the kind the page gives a message id. */
  function assistantProse(document: Document, section: HTMLElement, id: string, text: string): void {
    const message = document.createElement('div');
    message.setAttribute('data-message-id', id);
    message.setAttribute('data-message-author-role', 'assistant');
    const body = document.createElement('div');
    body.className = 'markdown';
    body.textContent = text;
    message.append(body);
    section.append(message);
  }

  /**
   * Presses the button and lets the compaction turn open, the way the page sees it.
   *
   * The send is what starts the generation, so the generating state goes up inside the
   * click handler — that is the race the arming exists to survive.
   */
  async function press(harnessed: Harness): Promise<void> {
    harnessed.document.querySelector('[data-testid="send-button"]')!.addEventListener('click', () => {
      startGenerating(harnessed.document);
    });
    await harnessed.hook.startCompact();
    harnessed.hook.observe();
    await settle();
  }

  it('delivers the settled final answer of the compaction turn, not its first words', async () => {
    live = await harness(`https://chatgpt.com/c/${CHAT}`, compactionReplies());
    live.hook.injectControl();
    await press(live);

    // What a real compaction turn looks like: the model thinks out loud, calls something,
    // and only then writes the document. Everything but the last of those is commentary.
    const turn = assistantTurn(live.document, 'turn-brief', ['Reading the session!']);
    assistantProse(live.document, turn, 'a-1', 'Let me look at what this session did.');
    assistantProse(live.document, turn, 'a-2', 'One moment while I put this together.');
    assistantProse(live.document, turn, 'a-3', 'TASK — finish the rewrite.\nNEXT — run the tests.');
    live.hook.observe();
    await settle();
    await settleTurn(live);

    const briefs = delivered(live);
    expect(briefs).toHaveLength(1);
    expect(briefs[0]!.token).toBe(TOKEN);
    expect(briefs[0]!.summary).toContain('TASK — finish the rewrite.');
    expect(briefs[0]!.summary).not.toContain('One moment while I put this together.');
    expect(withdrawn(live)).toEqual([]);
  });

  /**
   * The failure of 2026-08-23, reproduced.
   *
   * `turn_end` fired 28 characters into the brief because the stop control had been gone for
   * four seconds between two phases of an agentic turn. What followed was seven minutes of
   * tool calls and then the rest of the document — but the page, for long stretches of it,
   * looked exactly like a finished turn: no stop control, no new prose, and one tool block
   * rendering the same characters while the connector held the call open.
   *
   * So this asserts the negative first and for a long time. Thirty seconds of a page that
   * looks finished, twice over the settle window, and nothing may be handed to the app —
   * because the app was saying all along that it still had a call running.
   */
  it('will not call a turn finished while the app still has a call running', async () => {
    // The pre-compaction barrier itself must be clear. The pending call below belongs to the
    // compaction turn after it has started, which is the later generation-settle gate this
    // regression is about.
    let pending = 0;
    live = await harness(`https://chatgpt.com/c/${CHAT}`, {
      ...compactionReplies(),
      activity: () => ({
        ok: true,
        data: { entries: [], stream: [], nextSince: 0, pendingTools: pending, job: null }
      })
    });
    live.hook.injectControl();
    await press(live);
    pending = 1;

    // Twenty-eight characters and a tool call, exactly as it happened.
    const turn = assistantTurn(live.document, 'turn-brief', ['Reading the session!']);
    assistantProse(live.document, turn, 'a-1', 'TASK\nContinue implementing `');
    await settleTurn(live);

    // Nothing moves on screen for many times the settle window. The stop control is gone,
    // the prose is frozen, the tool block renders the same text throughout — and every poll
    // of the watch pushes the clock another second forward.
    expect(delivered(live)).toEqual([]);
    expect(withdrawn(live)).toEqual([]);

    // The call lands, and the model writes the document it was actually asked for.
    pending = 0;
    assistantProse(live.document, turn, 'a-2', 'TASK — finish the rewrite.\nNEXT — run the tests.');
    await settle(800);

    const briefs = delivered(live);
    expect(briefs).toHaveLength(1);
    expect(briefs[0]!.summary).toContain('NEXT — run the tests.');
  });

  it('treats an app that cannot be asked as busy rather than as idle', async () => {
    // Null is not zero. Reading "I could not ask" as "nothing is running" is the inference
    // that shipped 28 characters as a whole handoff.
    live = await harness(`https://chatgpt.com/c/${CHAT}`, {
      ...compactionReplies(),
      activity: () => undefined
    });
    live.hook.injectControl();
    await press(live);

    const turn = assistantTurn(live.document, 'turn-brief', []);
    assistantProse(live.document, turn, 'a-1', 'TASK — finish the rewrite.');
    await settleTurn(live);
    expect(delivered(live)).toEqual([]);
  });

  it('keeps waiting while the tool rail is still moving', async () => {
    // The other half of the same turn. Between two calls the app legitimately reports zero,
    // and the only thing still saying the turn is going is the page filling in. Every poll
    // of the watch advances the clock a second here, so counting polls is counting seconds:
    // a block every fifth one is a call every five seconds, well inside the settle window.
    let polls = 0;
    let rail: (() => void) | null = null;
    live = await harness(`https://chatgpt.com/c/${CHAT}`, {
      ...compactionReplies(),
      activity: () => {
        if (++polls % 5 === 0) rail?.();
        return { ok: true, data: { entries: [], stream: [], nextSince: 0, pendingTools: 0, job: null } };
      }
    });
    live.hook.injectControl();
    await press(live);

    const turn = assistantTurn(live.document, 'turn-brief', ['Reading the session!']);
    assistantProse(live.document, turn, 'a-1', 'TASK\nContinue implementing `');
    let blocks = 0;
    let railing = true;
    rail = () => {
      if (railing) turn.append(toolBlock(live!.document, `Ran a command ${blocks++}`));
    };
    await settleTurn(live);

    // A turn that never once looked finished for long enough, for as long as it kept going.
    expect(blocks).toBeGreaterThan(5);
    expect(delivered(live)).toEqual([]);

    // The rail stops, the document arrives, and only now does the watch settle.
    railing = false;
    assistantProse(live.document, turn, 'a-2', 'TASK — finish the rewrite.\nNEXT — run the tests.');
    await settle(800);
    const briefs = delivered(live);
    expect(briefs).toHaveLength(1);
    expect(briefs[0]!.summary).toContain('NEXT — run the tests.');
  });

  it('hands the brief over once, however many times the turn is observed', async () => {
    live = await harness(`https://chatgpt.com/c/${CHAT}`, compactionReplies());
    live.hook.injectControl();
    await press(live);

    const turn = assistantTurn(live.document, 'turn-brief', []);
    assistantProse(live.document, turn, 'a-1', 'TASK — finish the rewrite.');
    await settleTurn(live);

    // Everything after the first settle is a repeat: another observation, another settle
    // window, the same finished turn on screen. The first delivery was acknowledged, so its
    // binding has been retired and there is nothing left for any of them to deliver.
    for (let again = 0; again < 3; again++) {
      live.advance(live.hook.TURN_SETTLE_MS);
      live.hook.observe();
      await settle();
    }
    expect(delivered(live)).toHaveLength(1);
  });

  it('keeps a settled brief until a transient delivery failure can be retried', async () => {
    let captureAttempts = 0;
    live = await harness(`https://chatgpt.com/c/${CHAT}`, {
      ...compactionReplies(),
      compact: (message) => {
        if (typeof message.summary === 'string') {
          captureAttempts += 1;
          return captureAttempts === 1
            ? { ok: false, error: 'stale_document' }
            : { ok: true, data: { stored: true, job: null } };
        }
        return {
          ok: true,
          data: message.cancel
            ? { cancelled: true }
            : { started: true, token: TOKEN, prompt: 'Write the brief …', job: null }
        };
      }
    });
    live.hook.injectControl();
    await press(live);

    const turn = assistantTurn(live.document, 'turn-brief', []);
    assistantProse(live.document, turn, 'a-1', 'TASK — finish the rewrite.\nNEXT — run the tests.');
    await settleTurn(live);

    expect(delivered(live)).toHaveLength(1);
    expect(live.window.sessionStorage.getItem('clf-compact-capture')).not.toBeNull();

    // A healthy activity round trip is the recovery signal. The capture endpoint is
    // idempotent by token, so retrying the exact brief is safe whether the first request
    // never reached the app or merely lost its response after the durable write.
    await live.hook.pullActivity();
    await settle();

    expect(delivered(live)).toHaveLength(2);
    expect(delivered(live)[1]).toMatchObject({ token: TOKEN, summary: delivered(live)[0]!.summary });
    expect(live.window.sessionStorage.getItem('clf-compact-capture')).toBeNull();
  });

  it('retries an already-settled brief after a reload without guessing from the transcript again', async () => {
    const brief = 'TASK — finish the rewrite.\nNEXT — run the tests.';
    live = await harness(
      `https://chatgpt.com/c/${CHAT}`,
      {
        ...compactionReplies(),
        compact: (message) =>
          typeof message.summary === 'string'
            ? { ok: true, data: { stored: true, job: null } }
            : { ok: false, error: 'unexpected_compact_shape' }
      },
      (_document, dom) => {
        dom.window.sessionStorage.setItem(
          'clf-compact-capture',
          JSON.stringify({
            token: TOKEN,
            conversationId: CHAT,
            generation: 'g-finished-before-reload',
            priorGeneration: null,
            armedAt: 1_700_000_000_000,
            summary: brief
          })
        );
      }
    );
    await settle();

    expect(delivered(live)).toHaveLength(1);
    expect(delivered(live)[0]).toMatchObject({ token: TOKEN, summary: brief });
    expect(live.window.sessionStorage.getItem('clf-compact-capture')).toBeNull();
    expect(withdrawn(live)).toEqual([]);
  });

  it('never lets a later answer about something else become a second brief', async () => {
    live = await harness(`https://chatgpt.com/c/${CHAT}`, compactionReplies());
    live.hook.injectControl();
    await press(live);

    const turn = assistantTurn(live.document, 'turn-brief', []);
    assistantProse(live.document, turn, 'a-1', 'TASK — finish the rewrite.');
    live.hook.observe();
    await settle();
    await settleTurn(live);
    expect(delivered(live)).toHaveLength(1);

    // The user carries on in this chat afterwards. Nothing written later can hand the app
    // another brief for this transaction — including an answer that looks exactly like one,
    // because looking like one was never the test.
    startGenerating(live.document);
    live.hook.observe();
    await settle();
    const later = assistantTurn(live.document, 'turn-later', []);
    assistantProse(live.document, later, 'a-2', 'TASK — something else entirely.\nNEXT — do that instead.');
    live.hook.observe();
    await settle();
    await settleTurn(live);

    const briefs = delivered(live);
    expect(briefs).toHaveLength(1);
    expect(briefs[0]!.summary).toContain('finish the rewrite');
  });

  /**
   * The window between submitting the instruction and seeing the turn open is the only
   * place the binding is made, and a reload inside it lands in a new document that cannot
   * reconstruct the id the old one would have used. It does not have to: the app holds the
   * open turn for this conversation, and the arming happened before the send, so an open
   * turn that is *not* the one that was stopped to make room is the one the prompt started.
   */
  it('binds a reload that landed before the turn was ever seen', async () => {
    live = await harness(
      `https://chatgpt.com/c/${CHAT}`,
      {
        ...compactionReplies(),
        // The app's answer is what tells the new document which turn is still open.
        activity: () => ({
          ok: true,
          data: { entries: [], stream: [], nextSince: 0, pendingTools: 0, job: null, activeTurnId: 'g-open' }
        })
      },
      (document, dom) => {
        startGenerating(document);
        dom.window.sessionStorage.setItem(
          'clf-compact-capture',
          JSON.stringify({
            token: TOKEN,
            conversationId: CHAT,
            generation: null,
            priorGeneration: 'g-before',
            armedAt: 1_700_000_000_000
          })
        );
      }
    );

    const turn = assistantTurn(live.document, 'turn-brief', []);
    assistantProse(live.document, turn, 'a-1', 'TASK — finish the rewrite.');
    await settleTurn(live);

    const briefs = delivered(live);
    expect(briefs).toHaveLength(1);
    expect(briefs[0]!.token).toBe(TOKEN);
    expect(withdrawn(live)).toEqual([]);
  });

  it('gives up rather than guess when the reload landed after the turn had finished', async () => {
    live = await harness(
      `https://chatgpt.com/c/${CHAT}`,
      {
        ...compactionReplies(),
        // Nothing open: the compaction turn ended while this tab was not there to see it.
        activity: () => ({
          ok: true,
          data: { entries: [], stream: [], nextSince: 0, pendingTools: 0, job: null, activeTurnId: null }
        })
      },
      (document, dom) => {
        // The answer is on screen, next to a dozen others, and nothing distinguishes it
        // but a guess — which is exactly what must not happen.
        const turn = assistantTurn(document, 'turn-brief', []);
        const message = document.createElement('div');
        message.setAttribute('data-message-id', 'a-1');
        message.setAttribute('data-message-author-role', 'assistant');
        const body = document.createElement('div');
        body.className = 'markdown';
        body.textContent = 'TASK — finish the rewrite.';
        message.append(body);
        turn.append(message);
        dom.window.sessionStorage.setItem(
          'clf-compact-capture',
          JSON.stringify({
            token: TOKEN,
            conversationId: CHAT,
            generation: null,
            priorGeneration: null,
            armedAt: 1_700_000_000_000
          })
        );
      }
    );
    await settle();

    expect(delivered(live)).toEqual([]);
    expect(withdrawn(live)).toHaveLength(1);
  });

  it('gives up when the reload interrupted a turn it had already bound', async () => {
    live = await harness(
      `https://chatgpt.com/c/${CHAT}`,
      {
        ...compactionReplies(),
        activity: () => ({
          ok: true,
          data: { entries: [], stream: [], nextSince: 0, pendingTools: 0, job: null, activeTurnId: 'g-other' }
        })
      },
      (document, dom) => {
        startGenerating(document);
        // The binding names a generation, and the turn still open is not it.
        dom.window.sessionStorage.setItem(
          'clf-compact-capture',
          JSON.stringify({
            token: TOKEN,
            conversationId: CHAT,
            generation: 'g-gone',
            priorGeneration: null,
            armedAt: 1_700_000_000_000
          })
        );
      }
    );
    await settle();

    expect(delivered(live)).toEqual([]);
    expect(withdrawn(live)).toHaveLength(1);
  });

  it('ignores a binding left behind by a different conversation', async () => {
    live = await harness(`https://chatgpt.com/c/${CHAT}`, compactionReplies(), (document, dom) => {
      startGenerating(document);
      dom.window.sessionStorage.setItem(
        'clf-compact-capture',
        JSON.stringify({
          token: TOKEN,
          conversationId: '99999999-8888-7777-6666-555555555555',
          generation: null,
          priorGeneration: null,
          armedAt: 1_700_000_000_000
        })
      );
    });

    const turn = assistantTurn(live.document, 'turn-brief', []);
    assistantProse(live.document, turn, 'a-1', 'TASK — something in a different chat.');
    await settleTurn(live);

    // Not even a withdrawal: this tab has no business touching another chat's transaction.
    expect(delivered(live)).toEqual([]);
    expect(withdrawn(live)).toEqual([]);
  });
});

/**
 * One live recorder per document — and the ability to replace a dead one.
 *
 * Chrome keys the isolated world by extension id and leaves that JS context standing when the
 * extension reloads; what it invalidates is `chrome.runtime`. The orphan therefore keeps its
 * globals, and a guard that bailed out on a global marker made the recovery injection from
 * runtime.onInstalled a no-op — leaving the document with a recorder that can never send.
 */
describe('one live isolated-world recorder per document', () => {
  it('reports the recorder protocol version rather than the unrelated Fiber protocol version', async () => {
    live = await harness();

    await expect(live.runtimeMessage({ type: 'clf-recorder-ping' })).resolves.toEqual({
      ok: true,
      recorderVersion: 10
    });
  });

  it('leaves a healthy incumbent recorder alone', async () => {
    live = await harness();
    const window = live.window as any;
    window.chrome.runtime.id = 'clf-extension-id';
    let successor: any = null;
    window.CLF_TEST_HOOK = (api: any) => {
      successor = api;
    };

    window.eval(contentSource);
    await settle();

    expect(successor).toBeNull();
  });

  it('supersedes a recorder orphaned by an extension reload', async () => {
    live = await harness();
    const window = live.window as any;
    window.chrome.runtime.id = 'clf-extension-id';
    // The extension reloads. The old script keeps running, and keeps its globals.
    delete window.chrome.runtime.id;
    let successor: any = null;
    window.CLF_TEST_HOOK = (api: any) => {
      successor = api;
    };

    window.eval(contentSource);
    await settle();

    expect(successor).toBeTruthy();
    expect(successor).not.toBe(live.hook);
    // And the replacement is the one that observes from here on.
    const before = live.sent.length;
    successor.observe();
    await settle();
    expect(live.sent.length).toBeGreaterThanOrEqual(before);
  });

  it('silences the superseded recorder before later connector mutations can trigger Fiber scans', async () => {
    live = await harness();
    const window = live.window as any;
    window.chrome.runtime.id = 'clf-extension-id';
    // Model recovery deciding this incumbent is no longer authoritative while keeping a live
    // runtime for the replacement. The predecessor's stop() must make its DOM observers inert;
    // otherwise every extension reload leaves another observer that performs a MAIN-world Fiber
    // round-trip for each connector mutation, multiplying work in long-running ChatGPT tabs.
    window.__CLF_CONTENT_RECORDER__.healthy = () => false;
    let successor: any = null;
    window.CLF_TEST_HOOK = (api: any) => {
      successor = api;
    };
    window.eval(contentSource);
    await settle(400);
    expect(successor).toBeTruthy();

    const originalPost = window.postMessage.bind(window);
    let fiberAsks = 0;
    window.postMessage = (message: any, targetOrigin: string) => {
      if (message && message.source === 'clf-fiber-ask') fiberAsks++;
      return originalPost(message, targetOrigin);
    };

    const section = assistantTurn(live.document, 'turn-after-recorder-takeover', []);
    section.append(toolBlock(live.document, 'Called tool!'));
    await settle(50);

    // Exactly the replacement is allowed to react. Before the fix the stopped predecessor's
    // watchToolRows observer also called refreshFiber(), producing a second page-context scan.
    expect(fiberAsks).toBe(1);
  });
});

/**
 * One local turn owns one page turn.
 *
 * `settledTurnOwner` claims a settled page turn for the local turn that recorded its
 * request id, which is exact only while a request id names one request. ChatGPT reuses a
 * single `request_id` across the retries inside a turn — live 2026-08-21, session
 * `2026-08-21-204027d1` carried one id on three calls and a second on two — so after a
 * Retry several distinct page turns resolved to the same local turn and the app painted
 * one answer two, three and four times over.
 */
describe('a request id ChatGPT reused across retries', () => {
  const requestId = 'wfr_reused_across_retries';
  const activity = () => ({
    ok: true,
    data: {
      entries: [],
      stream: [
        {
          seq: 1,
          time: 100,
          kind: 'tool_call',
          turnId: 'g-retried-8-11',
          agent: 'prime',
          tool: 'agents',
          callId: 'call-retried',
          requestId,
          outcome: 'ok',
          durationMs: 3,
          summary: { kind: 'read', tone: 'neutral', title: 'Launched agent' }
        }
      ],
      job: null
    }
  });

  const settledTurn = (turnId: string, messageId: string, text: string) => ({
    turnId,
    conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    endMessageId: messageId,
    calls: [{ messageId: `${messageId}-call`, tool: 'agents', order: 0, answered: true, requestId }],
    messages: [
      {
        messageId,
        rawMessageId: messageId,
        role: 'assistant',
        stable: true,
        order: 0,
        rawText: text,
        renderedHtml: `<p>${text}</p>`
      }
    ]
  });

  it('gives its turn id to neither page turn when two of them claim it', async () => {
    live = await harness(undefined, { activity });
    await live.hook.pullActivity();
    await settle();

    await replyFiber([], [
      settledTurn('page-turn-first', 'msg-first', 'First attempt.'),
      settledTurn('page-turn-second', 'msg-second', 'Second attempt.')
    ]);
    await live.hook.flush();
    await settle();

    const answers = emitted(live.sent, 'assistant_message').map((entry) => entry.event);
    // Both answers still reach the transcript — losing them is not the fix. What they must
    // not do is arrive owned, because that ownership is what made the app file two separate
    // ChatGPT responses under one local turn and render the same answer twice.
    expect(answers.map((event) => event.messageId)).toEqual(['msg-first', 'msg-second']);
    expect(answers.map((event) => event.turnId)).toEqual([undefined, undefined]);
  });

  it('still gives its turn id to the one page turn that claims it', async () => {
    live = await harness(undefined, { activity });
    await live.hook.pullActivity();
    await settle();

    await replyFiber([], [settledTurn('page-turn-only', 'msg-only', 'The answer.')]);
    await live.hook.flush();
    await settle();

    const answers = emitted(live.sent, 'assistant_message').map((entry) => entry.event);
    expect(answers.map((event) => [event.messageId, event.turnId])).toEqual([['msg-only', 'g-retried-8-11']]);
  });
});

/**
 * The goal loop, from the page's side.
 *
 * The app owns the request and the credential; the page owns the one judgement only a
 * browser can make — that the turn is *really* over — and the one act only a browser can
 * perform, typing into somebody's composer. That is what is tested here, because that is
 * the whole of what the page contributes, and getting the first wrong types "what about the
 * tests" into a chat that is still in the middle of writing them.
 */
describe('the goal loop', () => {
  const CHAT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const MODEL = 'deepseek/deepseek-v4-flash';

  /** The activity feed of a chat where the loop is on, with whatever draft a case needs. */
  function feed(draft: unknown = null, pendingTools: unknown = 0) {
    return () => ({
      ok: true,
      data: {
        entries: [],
        stream: [],
        nextSince: 0,
        pendingTools,
        job: null,
        goal: { enabled: true, hasKey: true, model: MODEL, draft }
      }
    });
  }

  /**
   * A feed that forgets an acknowledged draft, which is what the app does.
   *
   * The page's first activity pull happens while the script is still starting up, so a draft
   * that sat on a static reply forever would be handed over twice: once to that pull and
   * once to the test's own. `goal_ack` is the app being told the draft is spent, and this
   * spends it here too.
   */
  function liveFeed(initial: unknown = null) {
    let draft = initial;
    return {
      set: (next: unknown) => {
        draft = next;
      },
      replies: {
        ...goalReplies(),
        activity: () => feed(draft)(),
        goal_ack: () => {
          draft = null;
          return { ok: true, data: { acknowledged: true } };
        }
      }
    };
  }

  /** The worker answers a running loop needs: the feed, the draft request, the receipt. */
  function goalReplies(draft: unknown = null, pendingTools: unknown = 0) {
    return {
      activity: feed(draft, pendingTools),
      goal_draft: () => ({
        ok: true,
        data: {
          goal: {
            token: 'g-token',
            conversationId: CHAT,
            turnId: 't-1',
            stage: 'sending',
            model: MODEL,
            text: '',
            reply: '',
            error: null
          }
        }
      }),
      goal_ack: () => ({ ok: true, data: { acknowledged: true } })
    };
  }

  const readyDraft = (reply: string, stage = 'ready') => ({
    token: 'g-token',
    conversationId: CHAT,
    turnId: 't-1',
    stage,
    model: MODEL,
    text: reply,
    reply,
    error: null
  });

  /** One assistant message inside a turn, of the kind the page gives a message id. */
  function prose(document: Document, section: HTMLElement, id: string, text: string): void {
    const message = document.createElement('div');
    message.setAttribute('data-message-id', id);
    message.setAttribute('data-message-author-role', 'assistant');
    const body = document.createElement('div');
    body.className = 'markdown';
    body.textContent = text;
    message.append(body);
    section.append(message);
  }

  /** A turn that opens, writes an answer, and ends — the way the observer sees all three. */
  async function answerATurn(harnessed: Harness, text = 'done, the tests pass'): Promise<void> {
    startGenerating(harnessed.document);
    const section = assistantTurn(harnessed.document, `turn-${text.length}`, []);
    harnessed.hook.observe();
    await settle();
    prose(harnessed.document, section, `a-${text.length}`, text);
    await settleTurn(harnessed);
  }

  const drafts = (harnessed: Harness): Array<Record<string, any>> =>
    harnessed.sent.filter((message) => message.type === 'goal_draft');
  const acks = (harnessed: Harness): Array<Record<string, any>> =>
    harnessed.sent.filter((message) => message.type === 'goal_ack');
  const peeks = (harnessed: Harness): number =>
    harnessed.sent.filter((message) => message.type === 'activity').length;

  it('restores a saved chat goal without replaying a historical finished answer as fresh work', async () => {
    let requested = 0;
    live = await harness(`https://chatgpt.com/c/${CHAT}`, {
      ...goalReplies(),
      activity: () => ({
        ok: true,
        data: {
          entries: [],
          stream: [],
          nextSince: 0,
          pendingTools: 0,
          job: null,
          // The global switch may be off. A saved specific objective is still visible/usable,
          // but merely reopening an old chat must not synthesize a new Goal turn from history.
          goal: {
            enabled: true,
            hasKey: true,
            model: MODEL,
            objective: 'finish the overnight release',
            draft: null
          }
        }
      }),
      goal_draft: () => {
        requested += 1;
        return goalReplies().goal_draft();
      }
    });
    await live.hook.pullActivity();

    const historical = assistantTurn(live.document, 'turn-from-yesterday', []);
    prose(live.document, historical, 'answer-from-yesterday', 'The old run stopped here.');
    live.hook.observe();
    await settle();

    expect(requested).toBe(0);
    expect(drafts(live)).toHaveLength(0);
  });

  it('continues the first resumed answer that finished while the replacement tab was hidden', async () => {
    const commandId = 'cmd-hidden-goal-resume';
    const objective = 'finish the overnight release';
    let requested = 0;
    live = await harness(
      `https://chatgpt.com/?clf=${commandId}`,
      {
        redeem: () => ({
          ok: true,
          command: { id: commandId, type: 'resume', text: 'the carried handoff', agent: null }
        }),
        ack: () => ({ ok: true }),
        activity: () => ({
          ok: true,
          data: {
            entries: [],
            stream: [],
            nextSince: 0,
            pendingTools: 0,
            job: null,
            bootstrap: 'resume',
            goal: { enabled: true, hasKey: true, model: MODEL, objective, draft: null }
          }
        }),
        goal_draft: () => {
          requested += 1;
          return goalReplies().goal_draft();
        },
        goal_ack: () => ({ ok: true, data: { acknowledged: true } })
      },
      (document, dom) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.querySelector('[data-testid="send-button"]')!.addEventListener('click', () => {
          // Model the browser scheduling gap from the report: the resume submit starts and the
          // whole first answer reaches its terminal DOM before this hidden content script gets
          // another lifecycle observation. MutationObserver therefore wakes to the *settled*
          // tree, never a frame in which Stop/generation was live.
          dom.reconfigure({ url: `https://chatgpt.com/c/${CHAT}` });
          userTurn(document, 'resume-user', 'the carried handoff');
          startGenerating(document);
          const section = assistantTurn(document, 'resume-first-answer', []);
          prose(document, section, 'resume-first-final', 'The release audit is still unfinished.');
          const copy = document.createElement('button');
          copy.setAttribute('aria-label', 'Copy message');
          section.append(copy);
          stopGenerating(document);
        });
      }
    );

    await settle(400);

    // Recovery is allowed to start while the tab is still hidden. Returning to it is also a
    // deterministic wake-up: visibilitychange forces an immediate activity pull. Either way B
    // already has the moved objective, so its bootstrap-caused first answer must enter Goal
    // exactly once instead of being mistaken for old transcript history.
    Object.defineProperty(live.document, 'visibilityState', { configurable: true, value: 'visible' });
    live.document.dispatchEvent(new live.window.Event('visibilitychange'));
    await settle(1200);

    expect(requested).toBe(1);
    expect(drafts(live)).toHaveLength(1);
    expect(drafts(live)[0]).toMatchObject({ conversationId: CHAT, turnId: expect.any(String) });

    live.document.dispatchEvent(new live.window.Event('visibilitychange'));
    await settle(400);
    expect(requested).toBe(1);
  });

  it('recovers the exact observed resumed generation when it finishes before Goal config arrives', async () => {
    const commandId = 'cmd-resume-goal-config-race';
    const objective = 'finish the overnight release';
    let goalReady = false;
    let requested = 0;
    live = await harness(
      `https://chatgpt.com/?clf=${commandId}`,
      {
        redeem: () => ({
          ok: true,
          command: { id: commandId, type: 'resume', text: 'the carried handoff', agent: null }
        }),
        ack: () => ({ ok: true }),
        activity: () =>
          goalReady
            ? {
                ok: true,
                data: {
                  entries: [],
                  stream: [],
                  nextSince: 0,
                  pendingTools: 0,
                  job: null,
                  bootstrap: 'resume',
                  goal: { enabled: true, hasKey: true, model: MODEL, objective, draft: null }
                }
              }
            : {
                ok: true,
                data: {
                  entries: [],
                  stream: [],
                  nextSince: 0,
                  pendingTools: 0,
                  job: null,
                  bootstrap: 'resume'
                }
              },
        goal_draft: () => {
          requested += 1;
          return goalReplies().goal_draft();
        }
      },
      (document, dom) => {
        document.querySelector('[data-testid="send-button"]')!.addEventListener('click', () => {
          dom.reconfigure({ url: `https://chatgpt.com/c/${CHAT}` });
          userTurn(document, 'resume-user-config-race', 'the carried handoff');
        });
      }
    );

    // The resume ACK has armed provenance, but B still cannot read its moved Goal policy.
    // Unlike the hidden-tab race above, this first generation is fully observed and bound to a
    // local id before it finishes. Its ordinary noteGoalTurn() therefore runs while goalConfig
    // is null and skips, which used to lose this exact finished turn forever.
    await settle(300);
    startGenerating(live.document);
    const section = assistantTurn(live.document, 'resume-observed-config-race', []);
    live.hook.observe();
    await settle();
    const observedTurnId = emitted(live.sent, 'turn_start').at(-1)!.event.turnId as string;

    prose(live.document, section, 'resume-observed-config-final', 'The release audit is still unfinished.');
    await settleTurn(live);
    expect(requested).toBe(0);
    expect(emitted(live.sent, 'turn_end')).toContainEqual(
      expect.objectContaining({ event: expect.objectContaining({ turnId: observedTurnId, outcome: 'completed' }) })
    );

    // B's authoritative post-commit Goal config/objective arrives later. Resume provenance must
    // recover the *same* locally observed generation id once, not synthesize another turn and not
    // require a new assistant/user mutation to wake the loop.
    goalReady = true;
    await live.hook.pullActivity();
    await settle(1200);

    expect(requested).toBe(1);
    expect(drafts(live)).toHaveLength(1);
    expect(drafts(live)[0]).toMatchObject({ conversationId: CHAT, turnId: observedTurnId });

    await live.hook.pullActivity();
    Object.defineProperty(live.document, 'visibilityState', { configurable: true, value: 'visible' });
    live.document.dispatchEvent(new live.window.Event('visibilitychange'));
    await settle(600);
    expect(requested).toBe(1);
    expect(drafts(live).filter((message) => message.turnId === observedTurnId)).toHaveLength(1);
  });

  it('does not recover the resumed first answer after the user has already continued manually', async () => {
    const commandId = 'cmd-hidden-goal-user-moved-on';
    let goalReady = false;
    let requested = 0;
    live = await harness(
      `https://chatgpt.com/?clf=${commandId}`,
      {
        redeem: () => ({
          ok: true,
          command: { id: commandId, type: 'resume', text: 'the carried handoff', agent: null }
        }),
        ack: () => ({ ok: true }),
        activity: () =>
          goalReady
            ? {
                ok: true,
                data: {
                  entries: [],
                  stream: [],
                  nextSince: 0,
                  pendingTools: 0,
                  job: null,
                  bootstrap: 'resume',
                  goal: {
                    enabled: true,
                    hasKey: true,
                    model: MODEL,
                    objective: 'finish the overnight release',
                    draft: null
                  }
                }
              }
            : { ok: false, error: 'disconnected' },
        goal_draft: () => {
          requested += 1;
          return goalReplies().goal_draft();
        }
      },
      (document, dom) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.querySelector('[data-testid="send-button"]')!.addEventListener('click', () => {
          dom.reconfigure({ url: `https://chatgpt.com/c/${CHAT}` });
          userTurn(document, 'resume-user-stale', 'the carried handoff');
          const section = assistantTurn(document, 'resume-first-stale', []);
          prose(document, section, 'resume-first-stale-final', 'The release audit is still unfinished.');
        });
      }
    );

    await settle(300);
    expect(requested).toBe(0);

    // The user owns the conversation again before the post-commit Goal config can be read.
    // Recovery must consume its one-shot marker instead of writing a delayed answer behind this.
    userTurn(live.document, 'manual-after-resume', 'I am taking over from here.');
    live.hook.observe();
    await settle();
    goalReady = true;
    await live.hook.pullActivity();
    await settle(600);

    expect(requested).toBe(0);
    Object.defineProperty(live.document, 'visibilityState', { configurable: true, value: 'visible' });
    live.document.dispatchEvent(new live.window.Event('visibilitychange'));
    await settle(400);
    expect(requested).toBe(0);
    expect(live.sent.filter((message) => message.type === 'goal_focus')).toHaveLength(0);
  });

  /**
   * The judgement the page exists to make.
   *
   * A finished answer holds still on every signal at once — the stop control, the prose, the
   * tool rail, and the app's own count of local calls still running — and holds it for the
   * settle window. Only then is there something worth replying to.
   */
  it('asks for a draft once the finished turn has held still', async () => {
    live = await harness(`https://chatgpt.com/c/${CHAT}`, goalReplies());
    await live.hook.pullActivity();
    await answerATurn(live);

    expect(drafts(live)).toHaveLength(1);
    expect(drafts(live)[0]).toMatchObject({ conversationId: CHAT, turnId: expect.any(String) });
  });

  /**
   * The failure this is written against is the one the compaction settle window exists for:
   * a turn that *looks* finished for four seconds between two phases of one agentic answer.
   * The app is still saying it has a local call running, so nothing has finished — and the
   * loop keeps watching rather than deciding early either way.
   */
  it('will not draft while the app still says a call is running', async () => {
    live = await harness(`https://chatgpt.com/c/${CHAT}`, goalReplies(null, 1));
    await live.hook.pullActivity();
    const before = peeks(live);
    await answerATurn(live);

    expect(drafts(live)).toEqual([]);
    // It is still watching, not quietly gone: the settle window is eight polls long and this
    // has taken far more than eight without concluding anything.
    expect(peeks(live) - before).toBeGreaterThan(8);
  });

  /** Null is not zero: an app that cannot be asked is busy, exactly as it is for a brief. */
  it('treats an app that cannot be asked as busy', async () => {
    live = await harness(`https://chatgpt.com/c/${CHAT}`, goalReplies(null, 'not a number'));
    await live.hook.pullActivity();
    await answerATurn(live);
    expect(drafts(live)).toEqual([]);
  });

  /**
   * A stopped, interrupted or failed turn is exactly the turn a user is about to say
   * something about themselves. Only a completed answer is one to continue from.
   */
  it('says nothing about a turn that did not finish', async () => {
    live = await harness(`https://chatgpt.com/c/${CHAT}`, goalReplies());
    await live.hook.pullActivity();
    // ChatGPT's own transport-failure wording, which is how a broken turn ends.
    await answerATurn(live, 'Something went wrong while generating the response.');
    expect(drafts(live)).toEqual([]);
  });

  /** An answer with nothing in it gives the model nothing to continue from. */
  it('says nothing about a turn that produced no answer', async () => {
    live = await harness(`https://chatgpt.com/c/${CHAT}`, goalReplies());
    await live.hook.pullActivity();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-empty', []);
    live.hook.observe();
    await settle();
    await settleTurn(live);
    expect(drafts(live)).toEqual([]);
  });

  /** The switch is the app's, and the page reads it on every poll rather than remembering. */
  it('does nothing at all while the loop is off or has no key', async () => {
    for (const goal of [
      { enabled: false, hasKey: true, model: MODEL, draft: null },
      { enabled: true, hasKey: false, model: MODEL, draft: null }
    ]) {
      const page = await harness(`https://chatgpt.com/c/${CHAT}`, {
        activity: () => ({
          ok: true,
          data: { entries: [], stream: [], nextSince: 0, pendingTools: 0, job: null, goal }
        })
      });
      try {
        await page.hook.pullActivity();
        await answerATurn(page);
        expect(drafts(page), JSON.stringify(goal)).toEqual([]);
      } finally {
        page.close();
      }
    }
  });

  it('does not send a ready draft when Goal Mode was switched off while it was being written', async () => {
    let enabled = true;
    let draft: unknown = null;
    let acked = 0;
    live = await harness(`https://chatgpt.com/c/${CHAT}`, {
      ...goalReplies(),
      activity: () => ({
        ok: true,
        data: {
          entries: [],
          stream: [],
          nextSince: 0,
          pendingTools: 0,
          job: null,
          goal: { enabled, hasKey: true, model: MODEL, draft }
        }
      }),
      goal_ack: () => {
        acked += 1;
        draft = null;
        return { ok: true, data: { acknowledged: true } };
      }
    });
    const sends = watchSend(live.document);
    await live.hook.pullActivity();

    draft = readyDraft('what about the tests');
    enabled = false;
    await live.hook.pullActivity();
    await settle();

    expect(sends()).toBe(0);
    expect(composerText(live.document)).toBe('');
    expect(acked).toBe(1);
  });

  /**
   * The composer belongs to the user, and this is the moment the loop borrows it. It types
   * the message, sends it, and acknowledges the draft — the acknowledgement being what stops
   * the same message ever being typed twice.
   */
  it('types the message, sends it, and acknowledges the draft once', async () => {
    const source = liveFeed();
    live = await harness(`https://chatgpt.com/c/${CHAT}`, source.replies);
    const sends = watchSend(live.document);

    source.set(readyDraft('what about the tests'));
    await live.hook.pullActivity();
    await settle();

    expect(composerText(live.document)).toBe('what about the tests');
    expect(sends()).toBe(1);
    expect(acks(live)).toHaveLength(1);
    expect(acks(live)[0]).toMatchObject({ conversationId: CHAT, token: 'g-token' });

    // The app stops offering an acknowledged draft, and the page must not re-send from its
    // own memory of one either.
    await live.hook.pullActivity();
    await settle();
    expect(sends()).toBe(1);
    expect(acks(live)).toHaveLength(1);
  });

  it('never sends the same ready draft twice when the acknowledgement is lost', async () => {
    let ackAttempts = 0;
    let draft: unknown = null;
    let sends = () => 0;
    live = await harness(
      `https://chatgpt.com/c/${CHAT}`,
      {
        ...goalReplies(),
        activity: () => feed(draft)(),
        goal_ack: () => {
          ackAttempts += 1;
          return ackAttempts === 1
            ? { ok: false, error: 'app_not_found' }
            : { ok: true, data: { acknowledged: true } };
        }
      },
      (document) => {
        sends = watchSend(document);
        // Model a real accepted submit: ChatGPT clears the composer synchronously enough for
        // CLF_DOM.send()'s page-owned acceptance check to observe it.
        document.querySelector('[data-testid="send-button"]')!.addEventListener('click', () => {
          document.querySelector('#prompt-textarea')!.replaceChildren();
        });
      }
    );

    draft = readyDraft('what about the tests');
    await live.hook.pullActivity();
    await settle();
    expect(sends()).toBe(1);
    expect(ackAttempts).toBe(1);
    const spent = live.window.sessionStorage.getItem('clf-goal-spent-v1');
    expect(spent).toContain('g-token');

    // The app still offers the identical token because its first ACK did not arrive. The page
    // remembers that the send crossed its irreversible boundary. The receipt is in
    // sessionStorage specifically so a content-script reload cannot reopen this window.
    live.close();
    let sendsAfterReload = () => 0;
    live = await harness(
      `https://chatgpt.com/c/${CHAT}`,
      {
        ...goalReplies(),
        activity: feed(readyDraft('what about the tests')),
        goal_ack: () => {
          ackAttempts += 1;
          return { ok: true, data: { acknowledged: true } };
        }
      },
      (document) => {
        document.defaultView!.sessionStorage.setItem('clf-goal-spent-v1', spent!);
        sendsAfterReload = watchSend(document);
      }
    );
    await live.hook.pullActivity();
    await settle();
    expect(sendsAfterReload()).toBe(0);
    expect(ackAttempts).toBeGreaterThanOrEqual(2);
  });

  /**
   * The loop's success condition. Nothing is typed, and the panel says so — a run that ends
   * because the work is done must not look like a run that failed.
   */
  it('sends nothing when the model says the goal is met', async () => {
    let sends = () => 0;
    live = await harness(
      `https://chatgpt.com/c/${CHAT}`,
      liveFeed(readyDraft('', 'no-reply')).replies,
      // Before the script starts, because the draft is already on the feed the script's own
      // first pull reads: a counter attached afterwards would miss the thing it counts.
      (document) => {
        sends = watchSend(document);
      }
    );
    await live.hook.pullActivity();
    await settle();

    expect(sends()).toBe(0);
    expect(composerText(live.document)).toBe('');
    expect(acks(live)).toHaveLength(1);
    expect(live.hook.goalStageView({ phase: 'done', error: '', model: MODEL, draft: null })).toMatchObject({
      stage: 'Goal reached',
      kind: 'goal-done'
    });

    const panel = live.document.querySelector('.clf-stage') as HTMLElement;
    const close = panel.querySelector('.clf-stage-close') as HTMLButtonElement;
    expect(close.hidden).toBe(false);
    expect(close.getAttribute('aria-label')).toBe('Dismiss Goal status');
    close.click();
    expect(live.document.querySelector('.clf-stage')).toBeNull();

    // Activity polling keeps repainting this terminal state. Dismissal belongs to the Goal
    // turn rather than just its current node, so the same card must stay gone.
    live.hook.injectStage();
    expect(live.document.querySelector('.clf-stage')).toBeNull();
  });

  it('removes a terminal Goal card when the user continues the same chat manually', async () => {
    live = await harness(
      `https://chatgpt.com/c/${CHAT}`,
      liveFeed(readyDraft('', 'no-reply')).replies
    );
    await live.hook.pullActivity();
    await settle();
    expect(live.document.querySelector('.clf-stage')).not.toBeNull();

    userTurn(live.document, 'manual-follow-up', 'I will continue from here');
    live.hook.observe();
    await settle();

    expect(live.document.querySelector('.clf-stage')).toBeNull();
    // The app can keep reporting the preceding terminal phase until the next Goal run.
    // That repaint must not put history back above the active composer.
    live.hook.injectStage();
    expect(live.document.querySelector('.clf-stage')).toBeNull();
  });

  it('removes the old chat terminal Goal card on New Chat and a concrete chat switch', async () => {
    live = await harness(
      `https://chatgpt.com/c/${CHAT}`,
      liveFeed(readyDraft('', 'no-reply')).replies
    );
    await live.hook.pullActivity();
    await settle();
    expect(live.document.querySelector('.clf-stage')).not.toBeNull();

    // New Chat has no conversation id until its first message. Recorder identity is held
    // through that ambiguous router gap, but conversation-scoped UI must leave immediately.
    live.dom.reconfigure({ url: 'https://chatgpt.com/' });
    live.hook.observe();
    expect(live.document.querySelector('.clf-stage')).toBeNull();
    live.hook.injectStage();
    expect(live.document.querySelector('.clf-stage')).toBeNull();

    // Recreate the old terminal card, then prove the concrete A -> B reset also removes it.
    live.dom.reconfigure({ url: `https://chatgpt.com/c/${CHAT}` });
    live.hook.injectStage();
    expect(live.document.querySelector('.clf-stage')).not.toBeNull();
    live.dom.reconfigure({ url: 'https://chatgpt.com/c/bbbbbbbb-cccc-dddd-eeee-ffffffffffff' });
    live.hook.observe();
    expect(live.document.querySelector('.clf-stage')).toBeNull();
  });

  /**
   * A half-written message is somebody's.
   *
   * `insertPrompt` refuses a composer that already holds text, so nothing is ever typed over.
   * The draft waits — and the waiting is bounded, because a message written about a turn two
   * minutes ago is about a conversation the user has since taken back.
   */
  it('waits for a composer somebody is using, then gives up rather than typing over them', async () => {
    let sends = () => 0;
    live = await harness(
      `https://chatgpt.com/c/${CHAT}`,
      liveFeed(readyDraft('what about the tests')).replies,
      (document) => {
        sends = watchSend(document);
        const mine = document.createElement('p');
        mine.textContent = 'hang on, I was typing';
        document.querySelector('#prompt-textarea')!.append(mine);
      }
    );

    await live.hook.pullActivity();
    await settle();
    expect(sends()).toBe(0);
    expect(composerText(live.document)).toBe('hang on, I was typing');
    // Kept, not spent: the next pull tries again.
    expect(acks(live)).toEqual([]);

    // Two minutes of somebody else's sentence is long enough. The draft is dropped, and
    // dropped honestly — the panel says why rather than going quiet.
    live.advance(3 * 60_000);
    await live.hook.pullActivity();
    await settle();
    expect(sends()).toBe(0);
    expect(composerText(live.document)).toBe('hang on, I was typing');
    expect(acks(live)).toHaveLength(1);
  });

  /** A conversation that moved on by itself is its own answer: the draft is about the past. */
  it('drops a ready draft when ChatGPT has started talking again', async () => {
    let sends = () => 0;
    live = await harness(
      `https://chatgpt.com/c/${CHAT}`,
      liveFeed(readyDraft('what about the tests')).replies,
      (document) => {
        sends = watchSend(document);
        startGenerating(document);
      }
    );

    await live.hook.pullActivity();
    await settle();

    expect(sends()).toBe(0);
    expect(composerText(live.document)).toBe('');
    expect(acks(live)).toHaveLength(1);
  });

  /** What the panel above the composer says while all of this happens. */
  it('says what it is doing above the composer', async () => {
    live = await harness(`https://chatgpt.com/c/${CHAT}`, goalReplies());
    const hook = live.hook;
    const view = (goal: Record<string, unknown>) => hook.stageView({ job: null, goal });

    expect(view({ phase: 'settling', error: '', model: MODEL, draft: null })).toMatchObject({
      stage: 'Checking the answer is finished'
    });
    expect(view({ phase: 'requesting', error: '', model: MODEL, draft: null })).toMatchObject({
      stage: 'Sending the answer to OpenRouter',
      // The short name, because `deepseek/deepseek-v4-flash` is the id the API wants and not
      // what anybody calls it.
      detail: 'deepseek-v4-flash'
    });
    expect(
      view({ phase: 'drafting', error: '', model: MODEL, draft: { stage: 'answering', text: 'what about th' } })
    ).toMatchObject({ stage: 'deepseek-v4-flash is answering', body: 'what about th' });
    expect(
      view({ phase: 'drafting', error: '', model: MODEL, draft: { stage: 'ready', reply: 'what about the tests' } })
    ).toMatchObject({ stage: 'deepseek-v4-flash wrote the next message', body: 'what about the tests' });
    expect(
      view({ phase: 'sending', error: '', model: MODEL, draft: { stage: 'ready', reply: 'what about the tests' } })
    ).toMatchObject({ stage: 'Sending it to ChatGPT', body: 'what about the tests' });
    expect(view({ phase: 'done', error: '', model: MODEL, draft: null })).toMatchObject({
      stage: 'Goal reached',
      detail: 'nothing was sent',
      kind: 'goal-done'
    });
    // The failure code is the detail, because "it failed" on its own sends the reader hunting
    // through an app they cannot see from here.
    expect(view({ phase: 'failed', error: 'out_of_credit: add credits', model: MODEL, draft: null })).toMatchObject({
      stage: 'The goal loop stopped',
      detail: 'out_of_credit: add credits',
      kind: 'goal-error'
    });
    // Idle says nothing at all rather than an empty panel.
    expect(view({ phase: '', error: '', model: MODEL, draft: null })).toBeNull();
    // A running job owns the panel: a compaction is the bigger event, and the loop refuses to
    // act during one anyway.
    expect(hook.stageView({ job: { stage: 'opening', busy: true }, goal: { phase: 'settling', model: MODEL, draft: null } })).toMatchObject({
      stage: 'Opening a fresh chat'
    });
  });

  /**
   * The same panel, asked "how far" instead of "what now".
   *
   * A caption alone could not answer that, and the difference matters most in the two cases
   * the caption is worst at: a run that is simply slow, and a run that has stopped. Both
   * showed one sentence above the composer and nothing else, so the second was only
   * distinguishable from the first by waiting to see whether the sentence ever changed.
   *
   * Where a stopped run is drawn is the point. The failing paths keep the phase they failed
   * in, so "the message box was in use" lights the segment that was typing rather than the
   * one that was reading.
   */
  it('names the stages of a run and marks how far it got', async () => {
    live = await harness(`https://chatgpt.com/c/${CHAT}`, goalReplies());
    const hook = live.hook;
    const view = (goal: Record<string, unknown>) => hook.stageView({ job: null, goal: { model: MODEL, error: '', ...goal } });

    expect(view({ phase: 'settling', draft: null })!.steps).toEqual([
      'Answer settling',
      'Reading the chat',
      'Writing the reply',
      'Sending'
    ]);

    expect(view({ phase: 'settling', draft: null })).toMatchObject({ at: 0, done: false });
    expect(view({ phase: 'requesting', draft: null })).toMatchObject({ at: 1, done: false });
    expect(view({ phase: 'drafting', draft: { stage: 'answering', text: 'what abo' } })).toMatchObject({ at: 2, done: false });
    // Written but not yet typed: the third segment is full and the fourth has not begun.
    expect(view({ phase: 'drafting', draft: { stage: 'ready', reply: 'what about the tests' } })).toMatchObject({ at: 2, done: true });
    expect(view({ phase: 'sending', draft: { stage: 'ready', reply: 'what about the tests' } })).toMatchObject({ at: 3, done: false });
    // The loop's success condition sent nothing, so the last segment is never filled in.
    expect(view({ phase: 'done', draft: null })).toMatchObject({ at: 2, done: true, kind: 'goal-done' });

    // Three stops, three different places.
    expect(view({ phase: 'requesting', error: 'the app did not answer', draft: null })).toMatchObject({
      stage: 'The goal loop stopped',
      kind: 'goal-error',
      at: 1
    });
    expect(view({ phase: 'drafting', draft: { stage: 'failed', error: 'out_of_credit: add credits' } })).toMatchObject({
      kind: 'goal-error',
      detail: 'out_of_credit: add credits',
      at: 2
    });
    expect(view({ phase: 'sending', error: 'the message box was in use, so nothing was sent', draft: null })).toMatchObject({
      kind: 'goal-error',
      at: 3
    });
    // And the one that used to leave nothing behind at all: the loop watched a turn, gave up
    // on it, and the panel simply vanished — which is what "auto goal didn't fire" looks like
    // from the outside whether or not it ever ran.
    expect(view({ phase: 'settling', error: 'that answer had no text to continue from', draft: null })).toMatchObject({
      stage: 'The goal loop stopped',
      detail: 'that answer had no text to continue from',
      kind: 'goal-error',
      at: 0
    });

    // A compaction is one long wait with no named parts, so it draws no bar rather than an
    // empty track implying stages nobody is being shown.
    expect(hook.stageView({ job: { stage: 'opening', busy: true }, goal: null })).toMatchObject({ steps: [] });
  });

  it('draws the bar above the composer, lit up to the stage it is on', async () => {
    live = await harness(
      `https://chatgpt.com/c/${CHAT}`,
      liveFeed({
        token: 'g-token',
        conversationId: CHAT,
        turnId: 't-1',
        stage: 'answering',
        model: MODEL,
        text: 'what abo',
        reply: '',
        error: null
      }).replies
    );
    await live.hook.pullActivity();
    live.hook.injectStage();

    const panel = live.document.querySelector('.clf-stage')!;
    const steps = [...panel.querySelectorAll('.clf-stage-step')] as HTMLElement[];
    expect(steps.map((step) => step.querySelector('.clf-stage-name')!.textContent)).toEqual([
      'Answer settling',
      'Reading the chat',
      'Writing the reply',
      'Sending'
    ]);
    expect(steps.map((step) => step.dataset.clfStep)).toEqual(['done', 'done', 'now', 'next']);
    expect(panel.querySelector('.clf-stage-body')!.textContent).toBe('what abo');
    expect((panel.querySelector('.clf-stage-close') as HTMLButtonElement).hidden).toBe(true);
  });

  /**
   * The turn the loop exists for, and the one it used to throw away.
   *
   * `interrupted` is not the user stopping anything — endOutcome() reaches it only when
   * `userStopped` is false — it is ChatGPT closing its own turn early. Session
   * The retained live repro is the case in full: four consecutive prime turns ended
   * `interrupted`, every answer said in as many words that work was unfinished, and the loop
   * declined all four without drawing a thing, so from outside it looked like a feature that
   * had never run.
   */
  it('continues a turn ChatGPT cut short by itself', async () => {
    live = await harness(`https://chatgpt.com/c/${CHAT}`, goalReplies());
    await live.hook.pullActivity();
    startGenerating(live.document);
    const section = assistantTurn(live.document, 'turn-interrupted', []);
    live.hook.observe();
    await settle();
    prose(live.document, section, 'a-interrupted', 'that is as far as I got — the migration is still unfinished');
    // ChatGPT's own marker, which is what separates this from the user pressing stop.
    const marker = live.document.createElement('div');
    marker.setAttribute('data-interrupted', 'true');
    marker.textContent = 'Stopped';
    section.append(marker);
    stopGenerating(live.document);
    live.hook.observe();
    await settle();

    // The marker alone never closes a turn — one has gone on emitting for two minutes after
    // it. The boundary here is the page's own end_turn, exactly as it was in that session.
    await replyFiber([], [{
      turnId: 'turn-interrupted',
      conversationId: CHAT,
      endMessageId: 'site-final-interrupted',
      calls: [],
      messages: [{
        messageId: 'site-final-interrupted',
        stable: true,
        rawText: 'that is as far as I got — the migration is still unfinished',
        renderedHtml: '<p>that is as far as I got — the migration is still unfinished</p>'
      }],
      activities: []
    }]);
    await settle();
    await live.hook.flush();
    // replyFiber runs on real timers so jsdom can deliver the scan request, which means the
    // goal watch it starts queued its first poll on one too. This is the only wait in the
    // suite that has to be a real one; every poll after it is instant again.
    await new Promise((resolve) => globalThis.setTimeout(resolve, 1_100));
    await settle(800);

    expect(emitted(live.sent, 'turn_end').map((entry) => entry.event.outcome)).toEqual(['interrupted']);
    expect(drafts(live)).toHaveLength(1);
    expect(drafts(live)[0]).toMatchObject({ conversationId: CHAT, turnId: expect.any(String) });
  });

  it('starts Goal from a hidden-tab final mutation without waiting for a throttled timer', async () => {
    live = await harness(`https://chatgpt.com/c/${CHAT}`, goalReplies());
    await live.hook.pullActivity();
    startGenerating(live.document);
    const section = assistantTurn(live.document, 'turn-hidden-goal', []);
    section.setAttribute('data-clf-fiber-turn', '0');
    live.hook.observe();
    await settle();
    const opened = emitted(live.sent, 'turn_start')[0]!.event.turnId as string;

    // Chrome may heavily throttle content-script timers in a background tab. The final React
    // mutation still arrives through MutationObserver, so completion must not depend on the
    // observer's 250 ms setTimeout ever firing. This is the live failure where a complete answer
    // sat for minutes until the user manually typed "continue", at which point Goal finally had
    // a turn boundary to work from.
    const instantTimeout = live.window.setTimeout;
    Object.defineProperty(live.document, 'visibilityState', { configurable: true, value: 'hidden' });
    live.window.setTimeout = (() => 777) as unknown as typeof live.window.setTimeout;

    let scans = 0;
    const onAsk = (event: any) => {
      if (!event.data || event.data.source !== 'clf-fiber-ask') return;
      scans++;
      const scanToken = event.data.nonce;
      section.setAttribute('data-clf-fiber-turn', `${scanToken}:0`);
      // Once the exact end_turn reply is in flight, restore normal harness timers so the Goal
      // settle loop itself can run instantly. Only the MutationObserver debounce is under test.
      live!.window.setTimeout = instantTimeout;
      live!.window.dispatchEvent(
        new live!.window.MessageEvent('message', {
          data: {
            source: 'clf-fiber-reply',
            nonce: event.data.nonce,
            scanToken,
            v: 10,
            scanOk: true,
            rows: [],
            turns: [{
              index: 0,
              turnId: 'turn-hidden-goal',
              conversationId: CHAT,
              endMessageId: 'site-hidden-final',
              calls: [],
              messages: [{
                messageId: 'site-hidden-final',
                stable: true,
                rawText: 'The audit is still unfinished.',
                renderedHtml: '<p>The audit is still unfinished.</p>'
              }],
              activities: []
            }]
          },
          source: live!.window as unknown as Window
        })
      );
    };
    live.window.addEventListener('message', onAsk);
    try {
      stopGenerating(live.document);
      prose(live.document, section, 'a-hidden-final', 'The audit is still unfinished.');
      // jsdom delivers MutationObserver callbacks at the host event-loop checkpoint; the
      // browser-side timer is intentionally frozen above, so use Node's real timer only to let
      // that checkpoint happen without accidentally unthrottling the content script.
      await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
      await settle(1200);
    } finally {
      live.window.removeEventListener('message', onAsk);
      live.window.setTimeout = instantTimeout;
    }

    expect(scans).toBeGreaterThan(0);
    expect(emitted(live.sent, 'turn_end')).toContainEqual(
      expect.objectContaining({ event: expect.objectContaining({ turnId: opened, outcome: 'completed' }) })
    );
    expect(drafts(live)).toHaveLength(1);
    expect(live.document.visibilityState).toBe('hidden');
    expect(live.sent.filter((message) => message.type === 'goal_focus')).toEqual([
      expect.objectContaining({ type: 'goal_focus', conversationId: CHAT, turnId: opened })
    ]);
  });

  it('starts Goal when the only hidden-tab terminal mutation is the Stop control outside the transcript', async () => {
    live = await harness(`https://chatgpt.com/c/${CHAT}`, goalReplies());
    await live.hook.pullActivity();
    startGenerating(live.document);
    const section = assistantTurn(live.document, 'turn-hidden-stop-only', []);
    live.hook.observe();
    await settle();
    const opened = emitted(live.sent, 'turn_start')[0]!.event.turnId as string;

    // The final prose lands while Stop still exists. watchTranscript() sees that transcript
    // mutation, but Chrome can freeze its 250 ms debounce before it ever runs. The next and
    // only mutation is Stop being removed under the composer, outside TURN_SECTION. The old
    // observer filtered that mutation out before checking generating -> quiet and Goal then
    // sat on CHATGPT (PARTIAL) until the user typed another message.
    const instantTimeout = live.window.setTimeout;
    Object.defineProperty(live.document, 'visibilityState', { configurable: true, value: 'hidden' });
    live.window.setTimeout = (() => 778) as unknown as typeof live.window.setTimeout;
    prose(live.document, section, 'a-hidden-stop-only', 'The final answer was already visible.');
    await new Promise((resolve) => globalThis.setTimeout(resolve, 10));

    let scans = 0;
    const onAsk = (event: any) => {
      if (!event.data || event.data.source !== 'clf-fiber-ask') return;
      scans++;
      const scanToken = event.data.nonce;
      section.setAttribute('data-clf-fiber-turn', `${scanToken}:0`);
      // Goal's own settle loop is not what this regression freezes. Once the terminal Fiber
      // reply was actually requested, restore normal harness timers so the downstream draft can
      // run. Old code never requests it because the Stop mutation is outside the transcript.
      live!.window.setTimeout = instantTimeout;
      live!.window.dispatchEvent(
        new live!.window.MessageEvent('message', {
          data: {
            source: 'clf-fiber-reply',
            nonce: event.data.nonce,
            scanToken,
            v: 10,
            scanOk: true,
            rows: [],
            turns: [{
              index: 0,
              turnId: 'turn-hidden-stop-only',
              conversationId: CHAT,
              endMessageId: 'site-hidden-stop-only',
              calls: [],
              messages: [{
                messageId: 'site-hidden-stop-only',
                rawMessageId: 'a-hidden-stop-only',
                stable: true,
                rawText: 'The final answer was already visible.',
                renderedHtml: '<p>The final answer was already visible.</p>'
              }],
              activities: []
            }]
          },
          source: live!.window as unknown as Window
        })
      );
    };
    live.window.addEventListener('message', onAsk);
    try {
      stopGenerating(live.document);
      await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
      await settle(1200);
    } finally {
      live.window.removeEventListener('message', onAsk);
      live.window.setTimeout = instantTimeout;
    }

    expect(scans).toBeGreaterThan(0);
    expect(emitted(live.sent, 'turn_end')).toContainEqual(
      expect.objectContaining({ event: expect.objectContaining({ turnId: opened, outcome: 'completed' }) })
    );
    expect(drafts(live)).toHaveLength(1);
  });

  it('finishes a hidden visible final with fresh final-action evidence when Fiber omits end_turn', async () => {
    live = await harness(`https://chatgpt.com/c/${CHAT}`, goalReplies());
    await live.hook.pullActivity();
    startGenerating(live.document);
    const section = assistantTurn(live.document, 'turn-hidden-missing-end-turn', []);
    live.hook.observe();
    await settle();
    const opened = emitted(live.sent, 'turn_start')[0]!.event.turnId as string;
    prose(live.document, section, 'a-hidden-missing-end-turn', 'Visible final answer with no end_turn bit.');

    // Fiber is healthy and owns the exact live section, but reproduces the live gap: the public
    // answer exists and every connector call is settled while the descriptor has no endMessageId.
    // Mere prose must stay insufficient; the additional terminal fact arrives below from the
    // final turn-action row ChatGPT mounts for a completed answer.
    await bindFiberTurns([{ section, turn: {
      turnId: 'turn-hidden-missing-end-turn',
      conversationId: CHAT,
      endMessageId: null,
      calls: [],
      messages: [{
        messageId: 'site-hidden-missing-end-turn',
        rawMessageId: 'a-hidden-missing-end-turn',
        stable: true,
        rawText: 'Visible final answer with no end_turn bit.',
        renderedHtml: '<p>Visible final answer with no end_turn bit.</p>'
      }],
      activities: []
    } }]);
    await settle();

    const instantTimeout = live.window.setTimeout;
    Object.defineProperty(live.document, 'visibilityState', { configurable: true, value: 'hidden' });
    live.window.setTimeout = (() => 779) as unknown as typeof live.window.setTimeout;
    try {
      stopGenerating(live.document);
      await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
      expect(emitted(live.sent, 'turn_end')).toHaveLength(0);

      // No timer is allowed to create the terminal boundary. Once the real settle window has
      // elapsed, ChatGPT mounts the action row belonging to the finished response. That new
      // page-owned node, on this exact Fiber-bound turn, is the corroboration missing from prose.
      live.advance(live.hook.TURN_SETTLE_MS * 2);
      // Terminal detection is still mutation-driven. Restore the harness timer only before the
      // terminal mutation so the Goal watch that starts *after* turn_end can run normally; a
      // promise scheduled while the fake background timer was frozen cannot be resurrected.
      live.window.setTimeout = instantTimeout;
      const copy = live.document.createElement('button');
      copy.setAttribute('aria-label', 'Copy message');
      section.append(copy);
      await new Promise((resolve) => globalThis.setTimeout(resolve, 10));

      expect(emitted(live.sent, 'turn_end')).toContainEqual(
        expect.objectContaining({ event: expect.objectContaining({ turnId: opened, outcome: 'completed' }) })
      );
    } finally {
      live.window.setTimeout = instantTimeout;
    }
    await settle(1200);
    expect(drafts(live)).toHaveLength(1);
  });

  it('finishes a foreground split response when the final action lands on a later exact Fiber sibling', async () => {
    live = await harness(`https://chatgpt.com/c/${CHAT}`, goalReplies());
    await live.hook.pullActivity();
    startGenerating(live.document);
    const first = assistantTurn(live.document, 'turn-foreground-split-final', []);
    first.setAttribute('data-clf-fiber-turn', '0');
    prose(live.document, first, 'a-foreground-interim', 'I am still working through the audit.');
    live.hook.observe();
    await settle();
    const opened = emitted(live.sent, 'turn_start')[0]!.event.turnId as string;

    // First healthy Fiber scan binds the local generation to S1. This long response later gets
    // another sibling section, which is a normal ChatGPT render shape for one assistant turn.
    await replyFiber([], [{
      turnId: 'turn-foreground-split-final',
      conversationId: CHAT,
      endMessageId: null,
      calls: [],
      messages: [{
        messageId: 'site-foreground-interim',
        rawMessageId: 'a-foreground-interim',
        stable: true,
        rawText: 'I am still working through the audit.',
        renderedHtml: '<p>I am still working through the audit.</p>'
      }],
      activities: []
    }]);
    await settle();

    // Stop disappears before S2 exists. quietTurn therefore freezes the then-current nodes=[S1].
    // The live 2026-08-25 foreground failure sat in exactly this state until the next user post.
    stopGenerating(live.document);
    live.hook.observe();
    await settle();
    expect(emitted(live.sent, 'turn_end')).toHaveLength(0);

    const second = assistantTurn(live.document, 'turn-foreground-split-final', []);
    second.setAttribute('data-clf-fiber-turn', '0');
    prose(live.document, second, 'a-foreground-final', 'The final answer is visible now.');
    const copy = live.document.createElement('button');
    copy.setAttribute('aria-label', 'Copy message');
    second.append(copy);

    // Both sibling sections are stamped to the SAME descriptor in this fresh scan. That exact
    // Fiber grouping, not the reused data-turn-id, is what makes S2 safe to consult for terminal
    // evidence. end_turn is deliberately absent to exercise the quiet-action fallback.
    await replyFiber([], [{
      turnId: 'turn-foreground-split-final',
      conversationId: CHAT,
      endMessageId: null,
      calls: [],
      messages: [
        {
          messageId: 'site-foreground-interim',
          rawMessageId: 'a-foreground-interim',
          stable: true,
          rawText: 'I am still working through the audit.',
          renderedHtml: '<p>I am still working through the audit.</p>'
        },
        {
          messageId: 'site-foreground-final',
          rawMessageId: 'a-foreground-final',
          stable: true,
          rawText: 'The final answer is visible now.',
          renderedHtml: '<p>The final answer is visible now.</p>'
        }
      ],
      activities: []
    }]);
    live.advance(live.hook.TURN_SETTLE_MS * 2);
    live.hook.observe();
    await settle(1200);

    expect(emitted(live.sent, 'turn_end')).toContainEqual(
      expect.objectContaining({ event: expect.objectContaining({ turnId: opened, outcome: 'completed' }) })
    );
    expect(drafts(live)).toHaveLength(1);
  });

  it('rejects a completion action owned by an earlier sibling of the newest Fiber prose', async () => {
    live = await harness(`https://chatgpt.com/c/${CHAT}`, goalReplies());
    await live.hook.pullActivity();
    startGenerating(live.document);
    const first = assistantTurn(live.document, 'turn-split-stale-copy', []);
    first.setAttribute('data-clf-fiber-turn', '0');
    prose(live.document, first, 'a-split-old', 'Earlier completed-looking prose.');
    const oldCopy = live.document.createElement('button');
    oldCopy.setAttribute('aria-label', 'Copy message');
    first.append(oldCopy);
    live.hook.observe();
    await settle();

    // A later sibling becomes the newest authored message of this same exact Fiber descriptor,
    // but it has no completed-message action yet. The old S1 action must not certify S2 merely
    // because both sections share one model turn.
    const second = assistantTurn(live.document, 'turn-split-stale-copy', []);
    second.setAttribute('data-clf-fiber-turn', '0');
    prose(live.document, second, 'a-split-new', 'Newer prose is still not terminal.');
    await replyFiber([], [{
      turnId: 'turn-split-stale-copy',
      conversationId: CHAT,
      endMessageId: null,
      calls: [],
      messages: [
        {
          messageId: 'site-split-old',
          rawMessageId: 'a-split-old',
          stable: true,
          rawText: 'Earlier completed-looking prose.',
          renderedHtml: '<p>Earlier completed-looking prose.</p>'
        },
        {
          messageId: 'site-split-new',
          rawMessageId: 'a-split-new',
          stable: true,
          rawText: 'Newer prose is still not terminal.',
          renderedHtml: '<p>Newer prose is still not terminal.</p>'
        }
      ],
      activities: []
    }]);
    stopGenerating(live.document);
    live.advance(live.hook.TURN_SETTLE_MS * 2);
    live.hook.observe();
    await settle();

    expect(emitted(live.sent, 'turn_end')).toHaveLength(0);
    expect(drafts(live)).toHaveLength(0);
  });

  it('does not revive a pre-generation Copy action on a non-adjacent reused page turn id', async () => {
    live = await harness(`https://chatgpt.com/c/${CHAT}`, goalReplies());
    await live.hook.pullActivity();

    const oldFirst = assistantTurn(live.document, 'turn-reused-copy', []);
    prose(live.document, oldFirst, 'a-reused-old-first', 'An older attempt.');
    userTurn(live.document, 'user-between-retries', 'Retry that please.');
    const reused = assistantTurn(live.document, 'turn-reused-copy', []);
    prose(live.document, reused, 'a-reused-old-second', 'The previous retry answer.');
    const oldCopy = live.document.createElement('button');
    oldCopy.setAttribute('aria-label', 'Copy message');
    reused.append(oldCopy);

    // Idle observation is the baseline. CLF_DOM.turns() globally folds the two assistant
    // sections with the reused page id even though a user turn sits between them; the old buggy
    // baseline paired the Copy from `reused` with `.node === oldFirst` and therefore lost its
    // ownership. The per-section previous-observation baseline must remember `reused` itself.
    live.hook.observe();
    await settle();

    startGenerating(live.document);
    live.hook.observe();
    await settle();
    reused.setAttribute('data-clf-fiber-turn', '0');
    prose(live.document, reused, 'a-reused-current', 'Current retry prose with no new Copy action.');
    await replyFiber([], [{
      turnId: 'turn-reused-copy',
      conversationId: CHAT,
      endMessageId: null,
      calls: [],
      messages: [{
        messageId: 'site-reused-current',
        rawMessageId: 'a-reused-current',
        stable: true,
        rawText: 'Current retry prose with no new Copy action.',
        renderedHtml: '<p>Current retry prose with no new Copy action.</p>'
      }],
      activities: []
    }]);
    stopGenerating(live.document);
    live.advance(live.hook.TURN_SETTLE_MS * 2);
    live.hook.observe();
    await settle();

    expect(emitted(live.sent, 'turn_end')).toHaveLength(0);
    expect(drafts(live)).toHaveLength(0);
  });

  /** The user's own hand on the stop button still means they are about to type themselves. */
  it('still says nothing when the user pressed stop', async () => {
    live = await harness(`https://chatgpt.com/c/${CHAT}`, goalReplies());
    await live.hook.pullActivity();
    startGenerating(live.document);
    const section = assistantTurn(live.document, 'turn-stopped', []);
    live.hook.observe();
    await settle();
    prose(live.document, section, 'a-stopped', 'half an answer, and then');

    live.document
      .querySelector('[data-testid="stop-button"]')!
      .dispatchEvent(new live.window.MouseEvent('click', { bubbles: true }));
    stopGenerating(live.document);
    live.hook.observe();
    await settle(800);

    expect(emitted(live.sent, 'turn_end').map((entry) => entry.event.outcome)).toEqual(['stopped']);
    expect(drafts(live)).toEqual([]);
  });

  /**
   * The whole feature in one gesture, in the chat that does not exist yet.
   *
   * A New Chat has no conversation id, no activity feed and — until now — no control in its
   * composer at all. It is also the most obvious place to write a goal down: nothing has been
   * said yet, so the goal is the entire request. Sending the message this produces is what
   * makes ChatGPT issue the id the goal is finally saved against.
   */
  it('does not attach an unsent New Chat goal to an existing chat opened while generation is in flight', async () => {
    let releaseGoal!: (value: unknown) => void;
    const heldGoal = new Promise<unknown>((resolve) => {
      releaseGoal = resolve;
    });
    live = await harness('https://chatgpt.com/', {
      settings_get: () => ({
        ok: true,
        data: {
          context: { auto: false, threshold: 400_000, warn: 400_000, limit: 533_000 },
          goal: { enabled: false, hasKey: true, model: MODEL, objective: '', blocked: '' }
        }
      }),
      goal_open: () => heldGoal
    });
    await live.hook.pullActivity();
    live.hook.injectControl();
    live.hook.toggleMenu();
    (live.document.querySelector('.clf-menu-goal-link') as HTMLButtonElement).click();
    const box = live.document.querySelector('[data-clf-goal-input]') as HTMLTextAreaElement;
    box.value = 'finish the parser migration';
    box.dispatchEvent(new live.window.Event('input', { bubbles: true }));
    (live.document.querySelector('.clf-menu-goal-save') as HTMLButtonElement).click();
    await settle();
    expect(live.sent.filter((message) => message.type === 'goal_open')).toHaveLength(1);

    const existingChat = 'ffffffff-1111-2222-3333-444444444444';
    live.window.history.replaceState({}, '', `/c/${existingChat}`);
    live.hook.observe();
    await settle();
    expect(live.sent.filter((message) => message.type === 'goal_objective' && message.conversationId === existingChat)).toEqual([]);

    releaseGoal({ ok: true, data: { reply: 'this opening must not be sent', model: MODEL } });
    await settle(800);
    expect(live.sent.filter((message) => message.type === 'goal_objective' && message.conversationId === existingChat)).toEqual([]);
    expect(composerText(live.document)).toBe('');
  });

  it('opens a New Chat on a goal, and writes its first message', async () => {
    live = await harness('https://chatgpt.com/', {
      settings_get: () => ({
        ok: true,
        data: {
          context: { auto: false, threshold: 400_000, warn: 400_000, limit: 533_000 },
          goal: { enabled: false, hasKey: true, model: MODEL, objective: '', blocked: '' }
        }
      }),
      goal_open: () => ({ ok: true, data: { reply: 'rewrite the parser in rust', model: MODEL } })
    });
    // The feed this page normally reads its settings off refuses a chat with no id, so the
    // sheet asks for them directly. Without that the row would claim there was no API key.
    await live.hook.pullActivity();
    expect(live.sent.filter((message) => message.type === 'settings_get').length).toBeGreaterThan(0);
    expect(live.sent.filter((message) => message.type === 'activity')).toEqual([]);

    const sends = watchSend(live.document);
    // A real accepted submit gives send() page-owned evidence immediately. Keep the composer
    // mounted so this test can still assert what was typed, but model ChatGPT starting generation
    // by swapping in its Stop control when the send button is clicked.
    live.document.querySelector('[data-testid="send-button"]')!.addEventListener('click', () => {
      startGenerating(live!.document);
    });
    live.hook.injectControl();
    live.hook.toggleMenu();

    const link = live.document.querySelector('.clf-menu-goal-link') as HTMLButtonElement;
    expect(link, 'the sheet offered no way to add a goal').not.toBeNull();
    link.click();
    const box = live.document.querySelector('[data-clf-goal-input]') as HTMLTextAreaElement;
    box.value = 'rewrite the parser in rust';
    box.dispatchEvent(new live.window.Event('input', { bubbles: true }));
    (live.document.querySelector('.clf-menu-goal-save') as HTMLButtonElement).click();
    await settle(800);

    const asked = live.sent.filter((message) => message.type === 'goal_open');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ text: 'rewrite the parser in rust' });
    expect(composerText(live.document)).toBe('rewrite the parser in rust');
    expect(sends()).toBe(1);

    // And the goal is bound to the chat the moment ChatGPT names it, so the ordinary loop
    // picks it up from the next turn onwards.
    live.window.history.replaceState({}, '', `/c/${CHAT}`);
    live.hook.observe();
    await settle();
    const bound = live.sent.filter((message) => message.type === 'goal_objective');
    expect(bound).toHaveLength(1);
    expect(bound[0]).toMatchObject({ conversationId: CHAT, text: 'rewrite the parser in rust' });
  });

  /**
   * A goal is a sentence somebody writes, and this sheet repaints itself on the activity
   * poll's cadence — every repaint is a full rebuild. Both halves of that were broken: Save
   * was built disabled and never heard the typing, and a repaint mid-sentence put the caret
   * back at the end of it.
   */
  it('keeps a half-written goal, its caret and its Save button through a repaint', async () => {
    live = await harness(`https://chatgpt.com/c/${CHAT}`, goalReplies());
    await live.hook.pullActivity();
    live.hook.injectControl();
    live.hook.toggleMenu();
    (live.document.querySelector('.clf-menu-goal-link') as HTMLButtonElement).click();

    const box = live.document.querySelector('[data-clf-goal-input]') as HTMLTextAreaElement;
    box.focus();
    box.value = 'port the module';
    box.dispatchEvent(new live.window.Event('input', { bubbles: true }));
    box.setSelectionRange(4, 4);
    expect((live.document.querySelector('.clf-menu-goal-save') as HTMLButtonElement).disabled).toBe(false);

    // What an activity poll does to this sheet, which is rebuild it from scratch.
    live.hook.renderControl();

    const after = live.document.querySelector('[data-clf-goal-input]') as HTMLTextAreaElement;
    expect(after.value).toBe('port the module');
    expect(live.document.activeElement).toBe(after);
    expect(after.selectionStart).toBe(4);
    expect((live.document.querySelector('.clf-menu-goal-save') as HTMLButtonElement).disabled).toBe(false);
  });

  /**
   * The settings sheet, which is where a chat is given its goal and where the reason a
   * chat cannot have one has to be legible.
   */
  describe('the settings sheet', () => {
    const sheet = (goal: Record<string, unknown>) =>
      live!.hook.settingsView({
        context: { auto: true, threshold: 400_000 },
        goal,
        compact: { action: 'start', hint: '' }
      });

    /** The sheet is pure, so one live script is enough to read every shape out of it. */
    async function open(): Promise<void> {
      live = await harness(`https://chatgpt.com/c/${CHAT}`, goalReplies());
    }

    it('offers a specific goal under the switch, and shows the one a chat already has', async () => {
      await open();
      const empty = sheet({ enabled: false, hasKey: true, model: MODEL, objective: '', blocked: '' });
      expect(empty.objective).toMatchObject({ label: 'add specific goal', summary: '', available: true });

      const set = sheet({
        enabled: false,
        hasKey: true,
        model: MODEL,
        objective: 'port the module and make the suite green',
        blocked: ''
      });
      expect(set.objective).toMatchObject({
        label: 'change the goal',
        summary: 'port the module and make the suite green',
        available: true
      });
      // A goal is enough on its own: nobody who has just written down where a chat has to
      // get to should have to find and flip a second switch before it does anything.
      expect(set.tip).toContain('Goal on');
      expect(set.rows[1]!.note).toContain('on for this chat’s own goal');
    });

    /**
     * The reason a switch is drawn off when the user did not turn it off. Without a word for
     * it, a rule working exactly as designed reads as a setting that failed to save — which
     * is precisely how it was reported.
     */
    it('says why a worker chat cannot be given a goal', async () => {
      await open();
      const view = sheet({ enabled: true, hasKey: true, model: MODEL, objective: '', blocked: 'worker' });
      expect(view.rows[1]!.note).toBe('off here: the prime agent writes this worker’s messages');
      expect(view.rows[1]!.warn).toBe(true);
      expect(view.tip).toContain('the prime writes this chat');
      expect(view.objective).toMatchObject({
        available: false,
        unavailable: 'A worker chat is already driven by its prime.'
      });
    });

    it('keeps pointing at the missing credential the whole feature runs on', async () => {
      await open();
      const view = sheet({ enabled: true, hasKey: false, model: MODEL, objective: '', blocked: '' });
      expect(view.rows[1]!.note).toBe('OpenRouter API key essential for goal feature');
      expect(view.objective).toMatchObject({
        available: false,
        unavailable: 'Add an OpenRouter API key in the app first.'
      });
    });

    /** A goal can be a paragraph; the row it is summarised in is one line of a small menu. */
    it('cuts a long goal to a line without breaking a word', async () => {
      await open();
      const long = `${'finish the migration '.repeat(20)}and ship`;
      const view = sheet({ enabled: false, hasKey: true, model: MODEL, objective: long, blocked: '' });
      expect(view.objective.summary.length).toBeLessThanOrEqual(121);
      expect(view.objective.summary.endsWith('…')).toBe(true);
      expect(view.objective.summary).not.toMatch(/\s…$/);
    });
  });
});
