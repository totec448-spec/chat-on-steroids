import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendEvent,
  flushSessions,
  getSession,
  setSessionOrigin,
  createSession,
  endSession,
  initSessionStore,
  listSessionPage,
  listUsageSessions,
  reopenSession,
  resetSessionStoreForTests,
  upsertMessageEvent,
} from '../src/main/session/store.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir = '';

beforeEach(async () => {
  dir = await makeTempDir('clf-session-list-');
  initSessionStore(dir);
});

afterEach(async () => {
  resetSessionStoreForTests();
  vi.restoreAllMocks();
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

    const oldest = first.sessions.at(-1)!;
    await reopenSession(oldest.id);
    await appendEvent(oldest.id, { time: Date.now() + 10_000, source: 'app', kind: 'note', message: { text: 'hot update', truncated: false, chars: 10 } });
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
