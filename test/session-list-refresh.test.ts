vi.mock('../src/renderer/workspace-terminal.js', () => ({ createWorkspaceTerminal: () => ({
  update: vi.fn(), show: vi.fn(), hide: vi.fn(), newTab: vi.fn(() => null),
  tabs: vi.fn(() => []), selectTab: vi.fn(), closeTab: vi.fn()
}) }));
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendEvent,
  bindSessionProject,
  flushSessions,
  getSession,
  setSessionOrigin,
  createSession,
  endSession,
  initSessionStore,
  listSessionPage,
  listUsageSessions,
  reopenSession,
  resetSessionStoreForTests
} from '../src/main/session/store.js';
import { upsertMessageEvent } from '../src/main/session/store.js';
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
  it('finishes legacy canonical migration once even when no duplicate aliases need repair', async () => {
    const session = await createSession({ title: 'legacy clean checkpoint' });
    await upsertMessageEvent(session.id, { time: 1, source: 'extension', kind: 'assistant_message',
      messageId: 'one', providerMessageId: 'provider-one', final: true,
      message: { text: 'Preserved answer', chars: 16, truncated: false } });
    await endSession(session.id);
    const folder = path.join(dir, 'sessions', session.id);
    const metaFile = path.join(folder, 'meta.json');
    const legacy = JSON.parse(await fs.readFile(metaFile, 'utf8'));
    delete legacy.__canonicalProjection;
    await fs.writeFile(metaFile, JSON.stringify(legacy));
    resetSessionStoreForTests();

    const first = await listSessionPage({ limit: 1 });
    expect(first.sessions[0]).toMatchObject({ id: session.id, events: legacy.events, estimatedTokens: legacy.estimatedTokens });
    expect(JSON.parse(await fs.readFile(metaFile, 'utf8')).__canonicalProjection).toBe(1);
    // A later cold launch must use the completed migration without rereading the transcript.
    await fs.utimes(metaFile, new Date(), new Date(Date.now() + 1000));
    resetSessionStoreForTests();
    const readFile = vi.spyOn(fs, 'readFile');
    expect((await listSessionPage({ limit: 1 })).sessions[0]).toMatchObject({ id: session.id, events: legacy.events });
    expect(readFile.mock.calls.some(([target]) => /[\\/]messages(?:[\\/]|\.json$)|events\.jsonl$/.test(String(target)))).toBe(false);
  });

  it('does not read clean retained transcripts to paint the cold first page', async () => {
    const session = await createSession({ title: 'retained history', conversationId: 'retained-chat' });
    await appendEvent(session.id, { time: Date.now(), source: 'app', kind: 'note', message: { text: 'recorded history', chars: 16, truncated: false } });
    await endSession(session.id);
    // Make the durable write ordering explicit even on filesystems with coarse clocks.
    const folder = path.join(dir, 'sessions', session.id);
    await fs.utimes(path.join(folder, 'meta.json'), new Date(), new Date(Date.now() + 1000));
    resetSessionStoreForTests();
    const readFile = vi.spyOn(fs, 'readFile'); const readdir = vi.spyOn(fs, 'readdir');
    const first = await listSessionPage({ limit: 1 });
    expect(first.sessions[0]).toMatchObject({ id: session.id, events: 1 });
    expect(readFile.mock.calls.some(([target]) => /[\\/]messages(?:[\\/]|\.json$)|events\.jsonl$/.test(String(target)))).toBe(false);
    expect(readdir.mock.calls.some(([target]) => String(target).endsWith(`${path.sep}messages`))).toBe(false);
  });

  it('reconciles a crashed canonical revision when metadata and history clocks are equal', async () => {
    const session = await createSession({ title: 'same timestamp crash' });
    await upsertMessageEvent(session.id, { time: 1, source: 'extension', kind: 'user_message', messageId: 'one', message: { text: 'short', chars: 5, truncated: false } });
    await flushSessions();
    await upsertMessageEvent(session.id, { time: 2, source: 'extension', kind: 'user_message', messageId: 'one', message: { text: 'long '.repeat(1000), chars: 5000, truncated: false } });
    const folder = path.join(dir, 'sessions', session.id); const sameTime = new Date();
    await fs.utimes(path.join(folder, 'messages'), sameTime, sameTime);
    await fs.utimes(path.join(folder, 'meta.json'), sameTime, sameTime);
    resetSessionStoreForTests();
    const first = await listSessionPage({ limit: 1 });
    expect(first.sessions[0]!.estimatedTokens).toBeGreaterThan(500);
    expect(first.sessions[0]!.userMessages).toBe(1);
  });

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
    // The behavior under test is the cold on-disk catalog and cursor paging, not session creation.
    // Seed valid version-current summary files from one real session instead of performing 130
    // durable create/end writes; that setup exceeded Vitest's 30 s limit on Windows x64.
    const template = await createSession({ title: 'history-0', conversationId: null });
    await endSession(template.id);
    const templateMeta = JSON.parse(await fs.readFile(path.join(dir, 'sessions', template.id, 'meta.json'), 'utf8')) as Record<string, unknown>;
    const ids = [template.id];
    const now = Date.now();
    await Promise.all(Array.from({ length: 64 }, async (_, index) => {
      const id = randomUUID();
      const updatedAt = now + index + 1;
      const meta = { ...templateMeta, id, title: `history-${index + 1}`, startedAt: updatedAt,
        updatedAt, endedAt: updatedAt + 1, conversationId: null, chatIds: [] };
      const folder = path.join(dir, 'sessions', id);
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, 'meta.json'), JSON.stringify(meta));
      ids.push(id);
    }));
    expect(ids).toHaveLength(65);
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

  // #1190: a project's chats older than the newest global page could only be reached by paging
  // the whole history. A project's own pages cost what the project holds.
  it("pages one project's chats by themselves, however much other history lies between them", async () => {
    const project = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', other = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    const mine: string[] = [];
    for (let index = 0; index < 70; index++) {
      const session = await createSession({ title: `history-${index}`, conversationId: null });
      if (index % 20 === 0) { await bindSessionProject(session.id, project); mine.push(session.id); }
      if (index === 5) await bindSessionProject(session.id, other);
      await endSession(session.id);
    }
    resetSessionStoreForTests();

    const first = await listSessionPage({ limit: 3, projectId: project });
    expect(first.sessions.every(entry => entry.projectId === project)).toBe(true);
    expect(first.sessions).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
    // The total stays the whole retained history: it is what the sidebar's own paging counts.
    expect(first.total).toBe(70);
    const second = await listSessionPage({ limit: 3, projectId: project, cursor: first.nextCursor ?? undefined });
    expect(second.sessions).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect([...first.sessions, ...second.sessions].map(entry => entry.id).sort()).toEqual([...mine].sort());

    // A session still open (not yet written out) belongs to its project's page too.
    const live = await createSession({ title: 'live', conversationId: null });
    await bindSessionProject(live.id, project);
    expect((await listSessionPage({ limit: 60, projectId: project })).sessions.map(entry => entry.id)).toContain(live.id);
    expect((await listSessionPage({ limit: 60, projectId: 'cccccccc-dddd-4eee-8fff-000000000000' })).sessions).toEqual([]);
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
  it.each([false, true])('uses the detail cursor without starving slow refreshes under continuous events (%s)', async streaming => {
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
    let changed: (change?: unknown) => void = () => undefined;
    const detailCalls: Array<{ id: string; options: any }> = [];
    let detailRound = 0;
    let listDelay = 0;
    const ok = (data: any) => Promise.resolve({ ok: true as const, data });
    const api: any = new Proxy(
      {
        listSessions: async () => {
          if (listDelay) await new Promise(resolve => setTimeout(resolve, listDelay));
          return ok({
            sessions: [selected],
            activeId: selected.id,
            pressure: [],
            total: 1,
            nextCursor: null
          });
        },
        turnTraces: () => ok({}),
      getSession: (id: string, options?: any) => {
          detailCalls.push({ id, options });
          detailRound += 1;
          return detailRound === 1
            ? ok({ summary: selected, events: [note(100, 'initial')], total: 1, nextFrom: 101 })
            : ok({ summary: { ...selected, events: 2 }, events: [note(101, 'delta')], total: 2, nextFrom: 102 });
        },
        getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
        onSessionChanged: (listener: (change?: unknown) => void) => {
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
      save: async () => true,
      state: () => ({ config: { sessions: { record: true, limitTokens: 533000 }, compaction: { auto: true, autoTokens: 400000 }, ui: { developerMode: true } } }) as any
    });
    chatVisible(true);
    await vi.waitFor(() => expect(w.document.querySelector('#sessionList [data-id]')).not.toBeNull());
    expect(detailCalls).toHaveLength(0); // Startup stays in New Chat; reading history is deliberate.
    (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click();
    await vi.waitFor(() => expect(detailCalls).toHaveLength(1));
    expect(detailCalls[0]).toEqual({ id: selected.id, options: { limit: 30 } });

    listDelay = streaming ? 600 : 0;
    // The selected session owns these writes; unrelated pushes are covered separately below.
    const own = () => changed({ sessionIds: [selected.id] });
    const stream = streaming ? setInterval(own, 100) : undefined;
    try {
      own();
      await vi.waitFor(() => expect(detailCalls).toHaveLength(2), { timeout: 1600 });
    } finally { clearInterval(stream); }
    expect(detailCalls[1]).toEqual({ id: selected.id, options: { from: 101, limit: 30 } });
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
        turnTraces: () => ok({}),
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
    initChat({ save: async () => true, state: () => ({ config: { sessions: { record: true, limitTokens: 533000 }, compaction: { auto: true, autoTokens: 400000 }, ui: { developerMode: true } } }) as any });
    chatVisible(true);
    await vi.waitFor(() => expect(listCalls).toHaveLength(1));
    await vi.waitFor(() =>
      expect(w.document.querySelectorAll('#sessionList .sess')).toHaveLength(60)
    );

    const pane = w.document.getElementById('sessionList')!.closest('.scroll') as HTMLElement;
    Object.defineProperty(pane, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(pane, 'scrollHeight', { value: 1_000, configurable: true });
    pane.scrollTop = 800;
    pane.dispatchEvent(new w.Event('scroll'));
    await vi.waitFor(() => expect(listCalls).toHaveLength(2));
    expect(listCalls[1]).toEqual({ cursor, limit: 60 });
    await vi.waitFor(() => expect(w.document.querySelectorAll('#sessionList .sess')).toHaveLength(65));
  });
});

describe('selected catalog fallback', () => {
  it('survives overlapping paginated refreshes and is dropped only after confirmed deletion', async () => {
    const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
    dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
    const w = dom.window;
    Object.assign(globalThis, {
      window: w, document: w.document, HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node,
      DocumentFragment: w.DocumentFragment, HTMLInputElement: w.HTMLInputElement, HTMLSelectElement: w.HTMLSelectElement,
      HTMLTextAreaElement: w.HTMLTextAreaElement, HTMLButtonElement: w.HTMLButtonElement
    });
    if (!(w.HTMLElement.prototype as any).scrollIntoView) (w.HTMLElement.prototype as any).scrollIntoView = () => {};

    const firstPage = Array.from({ length: 60 }, (_, index) =>
      summary(`2026-08-25-${index.toString(16).padStart(8, '0')}`, 100_000 - index, 0)
    );
    const olderPage = Array.from({ length: 5 }, (_, index) =>
      summary(`2026-08-26-${index.toString(16).padStart(8, '0')}`, 99_940 - index, 0)
    );
    // This fetched summary sorts inside the first page's covered range, despite being absent
    // from the stale page response. The old pagination filter therefore discarded it.
    const fallback = summary('2026-08-25-ffffffff', 99_970, 0);
    expect(fallback.updatedAt).toBeLessThan(firstPage[0]!.updatedAt);
    expect(fallback.updatedAt).toBeGreaterThan(firstPage.at(-1)!.updatedAt);
    const cursor = { updatedAt: firstPage.at(-1)!.updatedAt, id: firstPage.at(-1)!.id };
    const pageOne = { sessions: firstPage, activeId: null, pressure: [], blocked: [], approval: [], recoveryStopped: [], trusted: [], total: 65, nextCursor: cursor };
    const pageTwo = { sessions: olderPage, activeId: null, pressure: [], blocked: [], approval: [], recoveryStopped: [], trusted: [], total: 65, nextCursor: null };
    const ok = (data: any) => Promise.resolve({ ok: true as const, data });
    const deferred = <T,>() => {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>(done => { resolve = done; });
      return { promise, resolve };
    };
    const initial = deferred<any>();
    const staleRefresh = deferred<any>();
    const currentRefresh = deferred<any>();
    let firstPageReads = 0;
    let olderPageReads = 0;
    let opened = false;
    let verificationReply: any = null;
    const getSession = vi.fn(async (id: string, options?: any) => {
      if (opened && id === fallback.id && options?.limit === 1 && verificationReply) return verificationReply;
      return ok({ summary: fallback, events: [note(1, 'Fallback transcript')], total: 1, nextFrom: 2 });
    });
    const api: any = new Proxy({
      listSessions: (options: any = {}) => {
        if (options.cursor) { olderPageReads += 1; return ok(pageTwo); }
        firstPageReads += 1;
        if (firstPageReads === 1) return initial.promise;
        if (firstPageReads === 2) return staleRefresh.promise;
        if (firstPageReads === 3) return currentRefresh.promise;
        return ok(pageOne);
      },
      listProjects: () => ok([]),
      getSession,
      getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
      onSessionChanged: () => () => undefined,
      onSwarmChanged: () => () => undefined
    }, { get(target, prop) { return prop in target ? (target as any)[prop] : (..._args: any[]) => ok(null); } });
    Object.defineProperty(w, 'api', { value: api, configurable: true });

    const { chatVisible, initChat, openScheduledChat } = await import('../src/renderer/chat.js');
    initChat({ save: async () => true,
      state: () => ({ config: { sessions: { record: true, limitTokens: 533000 }, compaction: { auto: true, autoTokens: 400000 }, ui: { developerMode: true } } }) as any });
    chatVisible(true);
    await vi.waitFor(() => expect(firstPageReads).toBe(1));
    const opening = openScheduledChat(fallback.id);
    initial.resolve(ok(pageOne));
    await opening;
    opened = true;
    const row = () => w.document.querySelector<HTMLElement>(`#sessionList [data-id="${fallback.id}"]`);
    const selected = () => row()?.querySelector('.sess-top[aria-current="true"]') ?? null;
    await vi.waitFor(() => expect(selected()).not.toBeNull());

    const pane = w.document.getElementById('sessionList')!.closest('.scroll') as HTMLElement;
    Object.defineProperty(pane, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(pane, 'scrollHeight', { value: 1_000, configurable: true });
    pane.scrollTop = 800;
    pane.dispatchEvent(new w.Event('scroll'));
    await vi.waitFor(() => expect(olderPageReads).toBe(1));
    await vi.waitFor(() => expect(w.document.querySelectorAll('#sessionList .sess')).toHaveLength(66));

    // Two whole-catalog refreshes overlap. The newer response arrives first and omits the
    // selected fallback; exact-id verification must keep it. The older response then arrives late.
    chatVisible(false); chatVisible(true);
    await vi.waitFor(() => expect(firstPageReads).toBe(2));
    chatVisible(false); chatVisible(true);
    await vi.waitFor(() => expect(firstPageReads).toBe(3));
    currentRefresh.resolve(ok(pageOne));
    await vi.waitFor(() => expect(getSession.mock.calls.filter(([id, options]) => id === fallback.id && options?.limit === 1).length).toBeGreaterThan(1));
    await vi.waitFor(() => expect(selected()).not.toBeNull());
    staleRefresh.resolve(ok(pageOne));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(selected()).not.toBeNull();
    expect(w.document.getElementById('timeline')?.textContent).toContain('Fallback transcript');

    // A transient verification error is not deletion either.
    verificationReply = { ok: false as const, error: 'Temporary IPC failure' };
    chatVisible(false); chatVisible(true);
    await vi.waitFor(() => expect(firstPageReads).toBe(4));
    await vi.waitFor(() => expect(getSession.mock.calls.filter(([id, options]) => id === fallback.id && options?.limit === 1).length).toBeGreaterThan(2));
    expect(selected()).not.toBeNull();

    // The main-process read returns this error only after a positive missing-directory check.
    verificationReply = { ok: false as const, error: 'Session not found' };
    chatVisible(false); chatVisible(true);
    await vi.waitFor(() => expect(firstPageReads).toBe(5));
    await vi.waitFor(() => expect(row()).toBeNull());
    expect(w.document.getElementById('timeline')?.textContent).not.toContain('Fallback transcript');
  });
});

describe('selected catalog fallback and pushed changes', () => {
  // CodeRabbit on #2063: a push consumed by a read that the exact-id check then superseded was lost.
  it('keeps a pushed transcript change for the newer read when the exact-id check was superseded', async () => {
    const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
    dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
    const w = dom.window;
    Object.assign(globalThis, {
      window: w, document: w.document, HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node,
      DocumentFragment: w.DocumentFragment, HTMLInputElement: w.HTMLInputElement, HTMLSelectElement: w.HTMLSelectElement,
      HTMLTextAreaElement: w.HTMLTextAreaElement, HTMLButtonElement: w.HTMLButtonElement
    });
    if (!(w.HTMLElement.prototype as any).scrollIntoView) (w.HTMLElement.prototype as any).scrollIntoView = () => {};
    const firstPage = Array.from({ length: 60 }, (_, index) => summary(`2026-08-25-${index.toString(16).padStart(8, '0')}`, 100_000 - index, 0));
    // Selected from another surface and absent from the bounded newest page.
    const fallback = summary('2026-08-25-ffffffff', 99_970, 0);
    const pageOne = { sessions: firstPage, activeId: null, pressure: [], blocked: [], approval: [], recoveryStopped: [], trusted: [], total: 61, nextCursor: null };
    const ok = (data: any) => Promise.resolve({ ok: true as const, data });
    let release!: (value: any) => void;
    let gate: Promise<any> | null = null;
    let gated = 0, detailReads = 0, opened = false, pushed!: (change?: unknown) => void;
    const getSession = vi.fn((id: string, options?: any) => {
      if (opened && id === fallback.id && options?.limit === 1 && gate) { gated += 1; const held = gate; gate = null; return held; }
      if (id === fallback.id && options?.limit !== 1) detailReads += 1;
      return ok({ summary: fallback, events: [note(1, `Fallback transcript ${detailReads}`)], total: 1, nextFrom: 2 });
    });
    const api: any = new Proxy({
      listSessions: () => ok(pageOne),
      listProjects: () => ok([]),
      getSession,
      getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
      onSessionChanged: (listener: (change?: unknown) => void) => { pushed = listener; return () => undefined; },
      onSwarmChanged: () => () => undefined
    }, { get(target, prop) { return prop in target ? (target as any)[prop] : (..._args: any[]) => ok(null); } });
    Object.defineProperty(w, 'api', { value: api, configurable: true });
    const { chatVisible, initChat, openScheduledChat } = await import('../src/renderer/chat.js');
    initChat({ save: async () => true,
      state: () => ({ config: { sessions: { record: true, limitTokens: 533000 }, compaction: { auto: true, autoTokens: 400000 }, ui: { developerMode: true } } }) as any });
    chatVisible(true);
    await openScheduledChat(fallback.id);
    opened = true;
    const row = () => w.document.querySelector<HTMLElement>(`#sessionList [data-id="${fallback.id}"]`)!;
    await vi.waitFor(() => expect(row().querySelector('.sess-top[aria-current="true"]')).not.toBeNull(), { timeout: 3000 });
    await vi.waitFor(() => expect(w.document.getElementById('timeline')?.textContent).toContain('Fallback transcript'), { timeout: 3000 });
    await new Promise(resolve => setTimeout(resolve, 50));
    const before = detailReads;

    // A push reaches the coalesced refresh. Its read takes the invalidation, then waits on the exact-id check.
    gate = new Promise(resolve => { release = resolve; });
    pushed({ allTranscripts: true });
    await vi.waitFor(() => expect(gated).toBe(1), { timeout: 3000 });
    // Meanwhile a rename starts a newer 'changed' read, which supersedes the waiting one.
    row().querySelector<HTMLElement>('.sess-top b')!.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
    const field = await vi.waitFor(() => { const f = row().querySelector<HTMLInputElement>('.sess-rename'); expect(f).not.toBeNull(); return f!; }, { timeout: 3000 });
    field.value = 'Renamed while refreshing';
    field.dispatchEvent(new w.Event('input', { bubbles: true }));
    field.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 100));
    release(ok({ summary: fallback, events: [note(1, 'old')], total: 1, nextFrom: 2 }));
    await new Promise(resolve => setTimeout(resolve, 150));
    // The pushed change was not lost with the superseded read: the transcript was read again.
    expect(detailReads).toBeGreaterThan(before);
  });
});

describe('scoped session change refresh', () => {
  /** Opens A in the production Chat renderer while B is another live row in the catalog. */
  async function openSelected() {
    const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
    dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
    const w = dom.window;
    Object.assign(globalThis, {
      window: w, document: w.document, HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node,
      DocumentFragment: w.DocumentFragment, HTMLInputElement: w.HTMLInputElement, HTMLSelectElement: w.HTMLSelectElement,
      HTMLTextAreaElement: w.HTMLTextAreaElement, HTMLButtonElement: w.HTMLButtonElement
    });
    if (!(w.HTMLElement.prototype as any).scrollIntoView) (w.HTMLElement.prototype as any).scrollIntoView = () => {};
    const state = {
      a: summary('2026-09-30-aaaaaaaa', 30_000, 1),
      b: summary('2026-09-30-bbbbbbbb', 20_000, 1),
      listed: true,
      lists: 0,
      detailCalls: [] as Array<{ id: string; options: any }>,
      changed: (_change?: unknown) => undefined as void
    };
    const ok = (data: any) => Promise.resolve({ ok: true as const, data });
    const api: any = new Proxy({
      listSessions: () => {
        state.lists += 1;
        const sessions = state.listed ? [state.a, state.b] : [state.b];
        return ok({ sessions, activeId: null, pressure: [], total: sessions.length, nextCursor: null, blocked: [] });
      },
      turnTraces: () => ok({}),
      getSession: (id: string, options?: any) => {
        state.detailCalls.push({ id, options });
        const seq = 100 + state.detailCalls.length - 1;
        return ok({ summary: state.a, events: [note(seq, `A row ${state.detailCalls.length}`)], total: state.detailCalls.length, nextFrom: seq + 1 });
      },
      getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
      onSessionChanged: (listener: (change?: unknown) => void) => { state.changed = listener; return () => undefined; },
      onSwarmChanged: () => () => undefined
    }, { get(target, prop) { return prop in target ? (target as any)[prop] : (..._args: any[]) => ok(null); } });
    Object.defineProperty(w, 'api', { value: api, configurable: true });
    const { chatVisible, initChat } = await import('../src/renderer/chat.js');
    initChat({ save: async () => true,
      state: () => ({ config: { sessions: { record: true, limitTokens: 533000 }, compaction: { auto: true, autoTokens: 400000 }, ui: { developerMode: true } } }) as any });
    chatVisible(true);
    await vi.waitFor(() => expect(w.document.querySelector(`#sessionList [data-id="${state.a.id}"]`)).not.toBeNull());
    (w.document.querySelector(`#sessionList [data-id="${state.a.id}"]`) as HTMLElement).click();
    await vi.waitFor(() => expect(state.detailCalls).toHaveLength(1));
    await vi.waitFor(() => expect(w.document.getElementById('timeline')?.textContent).toContain('A row 1'));
    /** Publishes one change and waits until the coalesced catalog refresh has completed. */
    const publish = async (change?: unknown) => {
      const before = state.lists;
      state.changed(change);
      await vi.waitFor(() => expect(state.lists).toBe(before + 1), { timeout: 1600 });
      await new Promise(resolve => setTimeout(resolve, 50));
    };
    return { w, state, publish };
  }

  it('keeps the catalog fresh without rereading A for unrelated or payload-less changes', async () => {
    const { w, state, publish } = await openSelected();
    await publish({ sessionIds: [state.b.id] });
    state.b = { ...state.b, updatedAt: 40_000, events: 2 };
    await publish({ sessionIds: [state.b.id] });
    await publish();
    expect(state.detailCalls.map(call => call.id)).toEqual([state.a.id]);
    expect(w.document.getElementById('timeline')?.textContent).toContain('A row 1');
  });

  it('rereads A for its exact owner, a stale refreshed summary, or an explicit global invalidation', async () => {
    const { w, state, publish } = await openSelected();
    await publish({ sessionIds: [state.b.id, state.a.id] });
    expect(state.detailCalls[1]).toEqual({ id: state.a.id, options: { from: 101, limit: 30 } });
    state.a = { ...state.a, updatedAt: 31_000, events: 3 };
    await publish({ sessionIds: [state.b.id] });
    expect(state.detailCalls).toHaveLength(3);
    await publish({ allTranscripts: true });
    expect(state.detailCalls).toHaveLength(4);
    expect(state.detailCalls.every(call => call.id === state.a.id)).toBe(true);
    expect(w.document.getElementById('timeline')?.textContent).toContain('A row 4');
  });

  it('clears the selected transcript when its session disappears from the catalog', async () => {
    const { w, state, publish } = await openSelected();
    state.listed = false;
    await publish();
    expect(w.document.getElementById('timeline')?.textContent).not.toContain('A row 1');
    expect(w.document.querySelector(`#sessionList [data-id="${state.a.id}"]`)).toBeNull();
    expect(state.detailCalls).toHaveLength(1);
  });
});

it('serves repeated Usage metadata from the shared index without disk rereads', async () => {
  const session = await createSession({ title: 'Usage cache', conversationId: null });
  await endSession(session.id);
  resetSessionStoreForTests();
  await listUsageSessions();
  const reads = vi.spyOn(fs, 'readFile');
  const directories = vi.spyOn(fs, 'readdir');
  expect((await listUsageSessions()).some(row => row.id === session.id)).toBe(true);
  expect((await listUsageSessions()).some(row => row.id === session.id)).toBe(true);
  expect(reads).not.toHaveBeenCalled(); expect(directories).not.toHaveBeenCalled();
});


it('omits exact helper origins before pagination while retaining ordinary lookalike chats and helper recordings after restart', async () => {
  const ordinary = await createSession({ title: 'You are a task planner not the user', conversationId: 'ordinary-chat' });
  const helper = await createSession({ title: 'Any title', conversationId: 'owned-helper' });
  await setSessionOrigin(helper.id, { kind: 'helper', fromSessionId: null, agentId: null, task: '' }, 'Task helper');
  for (const restart of [false, true]) {
    if (restart) { await endSession(helper.id); await endSession(ordinary.id); resetSessionStoreForTests(); }
    const page = await listSessionPage({ limit: 1 });
    expect(page.sessions.map(row => row.id)).toEqual([ordinary.id]);
    expect(page.total).toBe(1); expect(page.nextCursor).toBeNull();
    expect(await getSession(helper.id)).toMatchObject({ conversationId: 'owned-helper', origin: { kind: 'helper' } });
    expect((await listUsageSessions()).map(row => row.id)).toContain(helper.id);
  }
});
