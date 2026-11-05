import { expect, it, vi } from 'vitest';
import { inboxChat, listed, mountChat, settle, waitFor } from './renderer-state.harness.js';

vi.mock('../src/renderer/workspace-terminal.js', () => ({ createWorkspaceTerminal: () => ({
  update: vi.fn(), show: vi.fn(), hide: vi.fn(), newTab: vi.fn(() => null),
  tabs: vi.fn(() => []), selectTab: vi.fn(), closeTab: vi.fn()
}) }));
vi.mock('../src/renderer/pet.js', () => ({ initPet: () => Object.assign(() => {}, { toggle: () => {}, isVisible: () => false }) }));

it('opens an off-page scheduled chat after the current catalog read and preserves only that fetched summary', async () => {
  const newestA = inboxChat('newest-a', { updatedAt: 300 });
  const newestB = inboxChat('newest-b', { updatedAt: 400 });
  const newestC = inboxChat('newest-c', { updatedAt: 500 });
  const older = inboxChat('older-scheduled', { updatedAt: 100 });
  const nextCursor = { updatedAt: 250, id: 'cursor-old' };
  const listSessions = vi.fn(async () => listed([newestA], { total: 100, nextCursor }));
  const getSession = vi.fn(async (id: string) => id === older.id
    ? { ok: true as const, data: { summary: older, events: [], total: 0, nextFrom: 0 } }
    : { ok: true as const, data: null });
  const mounted = await mountChat({}, [], { listSessions, getSession });
  const { chatVisible, openScheduledChat } = await import('../src/renderer/chat.js');
  await waitFor(() => expect(listSessions).toHaveBeenCalled());

  let releaseFirst!: (value: ReturnType<typeof listed>) => void;
  let releaseSecond!: (value: ReturnType<typeof listed>) => void;
  listSessions
    .mockImplementationOnce(() => new Promise(resolve => { releaseFirst = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { releaseSecond = resolve; }));
  chatVisible(false); chatVisible(true);
  const opened = openScheduledChat(older.id);
  await Promise.resolve();
  expect(getSession).not.toHaveBeenCalled();
  // A later session-change refresh may supersede the read navigation observed. It must not make
  // opening wait forever; the fetched fallback is what protects the selected off-page summary.
  chatVisible(false); chatVisible(true);
  releaseFirst(listed([newestB], { total: 100, nextCursor }));
  await opened;
  await waitFor(() => expect(getSession).toHaveBeenCalledWith(older.id, { limit: 1 }));
  await settle();
  const doc = mounted.window.document;
  expect(doc.querySelector(`#sessionList [data-id="${older.id}"]`)).not.toBeNull();
  // The superseding read is still pending here; opening did not wait for it.
  expect(doc.querySelector(`#sessionList [data-id="${newestA.id}"]`)).not.toBeNull();
  // The selected old chat can temporarily reach the bounded newest page after activity. Keeping
  // it selected must not depend on it staying there forever.
  releaseSecond(listed([newestB, older], { total: 100, nextCursor }));
  await waitFor(() => expect(doc.querySelector(`#sessionList [data-id="${newestB.id}"]`)).not.toBeNull());
  expect(doc.querySelector(`#sessionList [data-id="${older.id}"]`)).not.toBeNull();

  listSessions.mockResolvedValue(listed([newestC], { total: 100, nextCursor }));
  chatVisible(false); chatVisible(true);
  await waitFor(() => expect(doc.querySelector(`#sessionList [data-id="${newestC.id}"]`)).not.toBeNull());
  expect(doc.querySelector(`#sessionList [data-id="${older.id}"]`)).not.toBeNull();
  expect(doc.querySelector(`#sessionList [data-id="${newestB.id}"]`)).toBeNull();
});

it('coalesces rapid session-changed notifications while Scheduled is visible', async () => {
  const sessionChanged: Array<() => void> = [];
  let release!: (value: { ok: true; data: never[] }) => void;
  const listSchedules = vi.fn()
    .mockImplementationOnce(() => new Promise(resolve => { release = resolve as typeof release; }))
    .mockResolvedValue({ ok: true as const, data: [] });
  const mounted = await mountChat({}, [], {
    listSchedules,
    onSessionChanged: (listener: () => void) => { sessionChanged.push(listener); return () => undefined; }
  });
  mounted.window.document.getElementById('sidebarScheduled')!.click();
  await waitFor(() => expect(listSchedules).toHaveBeenCalledTimes(1));
  for (let i = 0; i < 25; i++) for (const listener of sessionChanged) listener();
  expect(listSchedules).toHaveBeenCalledTimes(1);
  release({ ok: true, data: [] });
  await waitFor(() => expect(listSchedules).toHaveBeenCalledTimes(2));
  await settle();
  expect(listSchedules).toHaveBeenCalledTimes(2);
});

it('does not let a late off-page Scheduled lookup replace a newer ordinary chat selection', async () => {
  const newest = inboxChat('newest-selected', { updatedAt: 500 });
  const older = inboxChat('older-late', { updatedAt: 100 });
  let releaseOlder!: (value: unknown) => void;
  const getSession = vi.fn((id: string) => id === older.id
    ? new Promise(resolve => { releaseOlder = resolve; })
    : Promise.resolve({ ok: true as const, data: { summary: newest, events: [], total: 0, nextFrom: 0 } }));
  const mounted = await mountChat({}, [], {
    listSessions: async () => listed([newest], { total: 100, nextCursor: { updatedAt: 250, id: 'cursor-old' } }),
    getSession
  });
  const { openScheduledChat } = await import('../src/renderer/chat.js');
  const opened = openScheduledChat(older.id);
  await waitFor(() => expect(getSession).toHaveBeenCalledWith(older.id, { limit: 1 }));

  const newestRow = mounted.window.document.querySelector<HTMLElement>(`#sessionList [data-id="${newest.id}"]`)!;
  newestRow.click();
  expect(mounted.window.document.querySelector(`#sessionList [data-id="${newest.id}"]`)?.classList.contains('is-sel')).toBe(true);
  releaseOlder({ ok: true, data: { summary: older, events: [], total: 0, nextFrom: 0 } });
  await opened;
  await settle();

  expect(mounted.window.document.querySelector(`#sessionList [data-id="${newest.id}"]`)?.classList.contains('is-sel')).toBe(true);
  expect(mounted.window.document.querySelector(`#sessionList [data-id="${older.id}"]`)).toBeNull();
});
