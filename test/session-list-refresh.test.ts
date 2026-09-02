import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendEvent,
  createSession,
  endSession,
  initSessionStore,
  listSessionPage,
  reopenSession,
  resetSessionStoreForTests
} from '../src/main/session/store.js';
import type { SessionEvent, SessionSummary } from '../src/shared/session.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir = '';
let dom: JSDOM | null = null;

beforeEach(async () => {
  dir = await makeTempDir('clf-session-list-');
  initSessionStore(dir);
});

afterEach(async () => {
  dom?.window.close();
  dom = null;
  resetSessionStoreForTests();
  vi.restoreAllMocks();
  vi.resetModules();
  await removeTempDir(dir);
});

describe('session summary pages', () => {
  it('reads retained metadata once, then serves hot list refreshes from the summary index', async () => {
    for (let index = 0; index < 8; index++) {
      const session = await createSession({ title: `cached-${index}`, conversationId: null });
      await endSession(session.id);
    }
    // Simulate a process restart: the first UI list must discover disk state, but later live
    // refreshes must not reread every meta.json again.
    resetSessionStoreForTests();

    const readFile = vi.spyOn(fs, 'readFile');
    const first = await listSessionPage({ limit: 4 });
    const firstMetaReads = readFile.mock.calls.filter(([target]) => String(target).endsWith(`${path.sep}meta.json`)).length;
    expect(first.sessions).toHaveLength(4);
    expect(firstMetaReads).toBeGreaterThanOrEqual(8);

    const second = await listSessionPage({ limit: 4 });
    const secondMetaReads = readFile.mock.calls.filter(([target]) => String(target).endsWith(`${path.sep}meta.json`)).length;
    expect(second.sessions.map((entry) => entry.id)).toEqual(first.sessions.map((entry) => entry.id));
    expect(secondMetaReads).toBe(firstMetaReads);

    // A live mutation must appear through the overlay without throwing the cache away, and its
    // final closed row must remain current after that overlay is retired.
    const oldest = first.sessions.at(-1)!;
    await reopenSession(oldest.id);
    await appendEvent(oldest.id, {
      time: Date.now() + 10_000,
      source: 'app',
      kind: 'note',
      message: { text: 'hot update', truncated: false, chars: 10 }
    });
    const readsBeforeHotList = readFile.mock.calls.filter(([target]) => String(target).endsWith(`${path.sep}meta.json`)).length;
    const hot = await listSessionPage({ limit: 4 });
    expect(hot.sessions[0]).toMatchObject({ id: oldest.id, events: oldest.events + 1 });
    expect(readFile.mock.calls.filter(([target]) => String(target).endsWith(`${path.sep}meta.json`)).length).toBe(readsBeforeHotList);
    await endSession(oldest.id);
    const readsBeforeClosedList = readFile.mock.calls.filter(([target]) => String(target).endsWith(`${path.sep}meta.json`)).length;
    const closed = await listSessionPage({ limit: 4 });
    expect(closed.sessions[0]).toMatchObject({ id: oldest.id, events: oldest.events + 1 });
    expect(closed.sessions[0]!.endedAt).not.toBeNull();
    expect(readFile.mock.calls.filter(([target]) => String(target).endsWith(`${path.sep}meta.json`)).length).toBe(readsBeforeClosedList);
  });

  it('pages past the first 60 while reporting the full retained total', async () => {
    for (let index = 0; index < 65; index++) {
      const session = await createSession({ title: `history-${index}`, conversationId: null });
      await endSession(session.id);
    }
    resetSessionStoreForTests();

    const first = await listSessionPage({ limit: 60 });
    expect(first.sessions).toHaveLength(60);
    expect(first.total).toBe(65);
    expect(first.nextCursor).not.toBeNull();

    const second = await listSessionPage({ limit: 60, cursor: first.nextCursor ?? undefined });
    expect(second.sessions).toHaveLength(5);
    expect(second.total).toBe(65);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.sessions, ...second.sessions].map((entry) => entry.id)).size).toBe(65);
  });
});

function summary(id: string, updatedAt: number, events: number): SessionSummary {
  return {
    id,
    title: id,
    conversationId: `conversation-${id}`,
    chatIds: [`conversation-${id}`],
    startedAt: updatedAt - 1_000,
    updatedAt,
    endedAt: null,
    events,
    userMessages: 0,
    toolCalls: 0,
    lastToolCallAt: null,
    processExitNonzero: 0,
    toolRejected: 0,
    toolInternalErrors: 0,
    errors: 0,
    estimatedTokens: 0,
    contextTokens: 0,
    lastHandoffId: null,
    lastHandoffAt: null,
    lastTurnOutcome: null,
    activeTurnId: null,
    agents: [],
    origin: null
  };
}

const note = (seq: number, text: string): SessionEvent => ({
  seq,
  time: 10_000 + seq,
  source: 'app',
  kind: 'note',
  message: { text, truncated: false, chars: text.length }
});

describe('visible Chat refresh', () => {
  it('uses the detail cursor after the initial bounded tail instead of resending that tail', async () => {
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

    const selected = summary('2026-08-25-aaaaaaaa', 20_000, 2);
    let changed: () => void = () => undefined;
    const detailCalls: Array<{ id: string; options: any }> = [];
    let detailRound = 0;
    const ok = (data: any) => Promise.resolve({ ok: true as const, data });
    const api: any = new Proxy(
      {
        listSessions: () =>
          ok({
            sessions: [selected],
            activeId: selected.id,
            pressure: [],
            total: 1,
            nextCursor: null
          }),
        getSession: (id: string, options?: any) => {
          detailCalls.push({ id, options });
          detailRound += 1;
          return detailRound === 1
            ? ok({ summary: selected, events: [note(100, 'initial')], total: 1, nextFrom: 101 })
            : ok({ summary: { ...selected, events: 2 }, events: [note(101, 'delta')], total: 2, nextFrom: 102 });
        },
        getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
        onSessionChanged: (listener: () => void) => {
          changed = listener;
          return () => undefined;
        },
        onSwarmChanged: () => () => undefined
      },
      {
        get(target, prop) {
          if (prop in target) return (target as any)[prop];
          return (..._args: any[]) => ok(null);
        }
      }
    );
    Object.defineProperty(w, 'api', { value: api, configurable: true });

    const { chatVisible, initChat } = await import('../src/renderer/chat.js');
    initChat({
      save: async () => undefined,
      state: () => ({ config: { sessions: { record: true } } }) as any
    });
    chatVisible(true);
    await vi.waitFor(() => expect(detailCalls).toHaveLength(1));
    expect(detailCalls[0]).toEqual({ id: selected.id, options: { limit: 160 } });

    changed();
    await new Promise((resolve) => setTimeout(resolve, 450));
    await vi.waitFor(() => expect(detailCalls).toHaveLength(2));
    expect(detailCalls[1]).toEqual({ id: selected.id, options: { from: 101, limit: 160 } });
    expect(w.document.getElementById('timeline')?.textContent).toContain('initial');
    expect(w.document.getElementById('timeline')?.textContent).toContain('delta');
  });

  it('loads an older session page on scroll and replaces the misleading visible-count footer', async () => {
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

    const all = Array.from({ length: 65 }, (_, index) =>
      summary(`2026-08-25-${index.toString(16).padStart(8, '0')}`, 100_000 - index, 0)
    );
    const cursor = { updatedAt: all[59]!.updatedAt, id: all[59]!.id };
    const listCalls: any[] = [];
    const ok = (data: any) => Promise.resolve({ ok: true as const, data });
    const api: any = new Proxy(
      {
        listSessions: (options: any) => {
          listCalls.push(options);
          return listCalls.length === 1
            ? ok({ sessions: all.slice(0, 60), activeId: all[0]!.id, pressure: [], total: 65, nextCursor: cursor })
            : ok({ sessions: all.slice(60), activeId: all[0]!.id, pressure: [], total: 65, nextCursor: null });
        },
        getSession: (id: string) => ok({ summary: all.find((entry) => entry.id === id), events: [], total: 0, nextFrom: 0 }),
        getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
        onSessionChanged: () => () => undefined,
        onSwarmChanged: () => () => undefined
      },
      {
        get(target, prop) {
          if (prop in target) return (target as any)[prop];
          return (..._args: any[]) => ok(null);
        }
      }
    );
    Object.defineProperty(w, 'api', { value: api, configurable: true });

    const { chatVisible, initChat } = await import('../src/renderer/chat.js');
    initChat({ save: async () => undefined, state: () => ({ config: { sessions: { record: true } } }) as any });
    chatVisible(true);
    await vi.waitFor(() => expect(listCalls).toHaveLength(1));
    await vi.waitFor(() =>
      expect(w.document.getElementById('sessionsFoot')?.textContent).toContain('60 of 65 retained sessions shown')
    );

    const pane = w.document.getElementById('sessionList')!.closest('.scroll') as HTMLElement;
    Object.defineProperty(pane, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(pane, 'scrollHeight', { value: 1_000, configurable: true });
    pane.scrollTop = 800;
    pane.dispatchEvent(new w.Event('scroll'));
    await vi.waitFor(() => expect(listCalls).toHaveLength(2));
    expect(listCalls[1]).toEqual({ cursor, limit: 60 });
    await vi.waitFor(() => expect(w.document.querySelectorAll('#sessionList .sess')).toHaveLength(65));
    expect(w.document.getElementById('sessionsFoot')?.textContent).toContain('65 retained sessions');
  });
});
