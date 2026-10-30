import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as durable from '../src/main/durable.js';
import { MAX_SIDEBAR_SHELVES, SidebarThreadStore } from '../src/main/sidebar-thread-store.js';

let directory: string;
let now = 1_000;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-sidebar-shelves-'));
  durable.initDurableStore(directory);
  now = 1_000;
});

afterEach(async () => {
  vi.restoreAllMocks();
  durable.resetDurableForTests();
  await fs.rm(directory, { force: true, recursive: true });
});

describe('app-local persisted sidebar shelves', () => {
  it('commits a multi-row action and exact batch Undo/redo as one revision and one broadcast each', async () => {
    const store = new SidebarThreadStore(() => now);
    const batches: Array<{ revision: number; ids: string[] }> = [];
    const singles: string[] = [];
    store.onBatch(batch => batches.push({ revision: batch.revision, ids: batch.changes.map(change => change.id) }));
    store.onChange(change => singles.push(change.id));
    const initial = await store.setMany([
      { id: 'a', shelf: 'pinned' }, { id: 'b', shelf: 'settled' },
      { id: 'c', shelf: 'snoozed', until: 9_000, attention: { userMessages: 3, errors: 1 } }
    ], 0);
    expect(initial.revision).toBe(1);
    expect(initial.changes).toHaveLength(3);
    expect(batches).toEqual([{ revision: 1, ids: ['a', 'b', 'c'] }]);
    expect(singles).toEqual([]);
    const restart = new SidebarThreadStore(() => now);
    expect(Object.keys((await restart.list()).records)).toHaveLength(3);
    const updated = await store.setMany([
      { id: 'a', shelf: 'settled' }, { id: 'b', shelf: 'pinned' }, { id: 'c', shelf: 'active' }
    ], initial.revision);
    const undo = await store.restoreMany(updated.changes.map(row => ({ id: row.id, snapshot: row.before })), updated.revision);
    expect(undo.revision).toBe(3);
    expect(await store.get('c')).toEqual(initial.changes[2]!.current);
    const redo = await store.restoreMany(undo.changes.map(row => ({ id: row.id, snapshot: row.before })), undo.revision);
    expect(redo.revision).toBe(4);
    expect(await store.get('a')).toEqual({ shelf: 'settled' });
    expect(await store.get('c')).toEqual({ shelf: 'active' });
    expect(batches.map(batch => batch.ids.length)).toEqual([3, 3, 3, 3]);
    expect((await new SidebarThreadStore(() => now).list()).revision).toBe(4);
  });

  it('rejects duplicate IDs, bad snapshots and stale concurrent batches without partial application', async () => {
    const store = new SidebarThreadStore(() => now);
    await expect(store.setMany([{ id: 'a', shelf: 'pinned' }, { id: 'a', shelf: 'settled' }], 0)).rejects.toThrow(/Invalid sidebar batch/);
    await expect(store.restoreMany([{ id: 'a', snapshot: { shelf: 'snoozed', until: 0, snoozedAt: -1 } }], 0))
      .rejects.toThrow(/Invalid sidebar batch undo/);
    const first = store.setMany([{ id: 'a', shelf: 'pinned' }, { id: 'b', shelf: 'settled' }], 0);
    const stale = store.setMany([{ id: 'c', shelf: 'pinned' }, { id: 'd', shelf: 'settled' }], 0);
    await expect(first).resolves.toMatchObject({ revision: 1 });
    await expect(stale).rejects.toThrow(/another window/);
    expect((await store.list()).records).toEqual({ a: { shelf: 'pinned' }, b: { shelf: 'settled' } });
    await expect(store.restoreMany([{ id: 'a', snapshot: { shelf: 'active' } }], 0)).rejects.toThrow(/another window/);
    await expect(store.setMany([{ id: 'a', shelf: 'settled' }, { id: 'b', shelf: 'snoozed', until: now - 1 }], 1))
      .rejects.toThrow(/snooze deadline expired/);
    expect((await store.list()).records).toEqual({ a: { shelf: 'pinned' }, b: { shelf: 'settled' } });
    const noop = await store.setMany([{ id: 'a', shelf: 'pinned' }], 1);
    expect(noop).toEqual({ changes: [], revision: 1 });
  });

  it('does not expose partial batch changes after a failed durable commit or an oversized transaction', async () => {
    const store = new SidebarThreadStore(() => now);
    await store.setMany([{ id: 'safe', shelf: 'pinned' }], 0);
    const notifications: unknown[] = [];
    store.onBatch(change => notifications.push(change));
    const realWrite = durable.writeDurableNow;
    const fail = vi.spyOn(durable, 'writeDurableNow').mockImplementationOnce(async () => { throw new Error('disk full'); })
      .mockImplementation(realWrite);
    await expect(store.setMany([{ id: 'safe', shelf: 'settled' }, { id: 'other', shelf: 'pinned' }], 1))
      .rejects.toThrow('disk full');
    expect(fail).toHaveBeenCalled();
    expect(notifications).toEqual([]);
    expect((await store.list()).records).toEqual({ safe: { shelf: 'pinned' } });
    expect((await new SidebarThreadStore(() => now).list()).records).toEqual({ safe: { shelf: 'pinned' } });
    await expect(store.setMany(Array.from({ length: MAX_SIDEBAR_SHELVES + 1 }, (_, n) => ({ id: `x-${n}`, shelf: 'pinned' })), 1))
      .rejects.toThrow(/Invalid sidebar batch/);
  });

  it('survives restart, publishes across observers and preserves the exact undo snapshot', async () => {
    const store = new SidebarThreadStore(() => now);
    const observed: string[] = [];
    store.onChange(change => observed.push(`${change.id}:${change.current.shelf}`));

    await store.set('2026-10-29-aaaa1111', 'pinned');
    await store.set('2026-10-29-bbbb2222', 'settled');
    const snoozed = await store.set('2026-10-29-cccc3333', 'snoozed', 9_000, { userMessages: 3, errors: 2 });
    expect(snoozed.current).toEqual({ shelf: 'snoozed', until: 9000, snoozedAt: 1000, userMessages: 3, errors: 2 });

    const next = await store.set('2026-10-29-cccc3333', 'pinned');
    expect(next.before).toEqual(snoozed.current);
    await store.restore(next.id, next.before, next.revision);
    expect((await new SidebarThreadStore(() => now).list()).records).toEqual({
      '2026-10-29-aaaa1111': { shelf: 'pinned' },
      '2026-10-29-bbbb2222': { shelf: 'settled' },
      '2026-10-29-cccc3333': snoozed.current
    });
    expect(observed).toEqual([
      '2026-10-29-aaaa1111:pinned', '2026-10-29-bbbb2222:settled',
      '2026-10-29-cccc3333:snoozed', '2026-10-29-cccc3333:pinned', '2026-10-29-cccc3333:snoozed'
    ]);
  });

  it('serializes concurrent changes and rejects a stale undo without affecting newer choices', async () => {
    const store = new SidebarThreadStore(() => now);
    const first = store.set('2026-10-29-abcd1234', 'pinned');
    const second = store.set('2026-10-29-abcd1234', 'settled');
    const [a, b] = await Promise.all([first, second]);
    expect(a.revision).toBe(1);
    expect(b.revision).toBe(2);
    await expect(store.restore(b.id, a.before, a.revision)).rejects.toThrow(/another window/);
    expect(await store.get(b.id)).toEqual({ shelf: 'settled' });
    expect(await new SidebarThreadStore(() => now).get(b.id)).toEqual({ shelf: 'settled' });
  });

  it('wakes for deadlines and fresh activity without treating stored native questions as pending', async () => {
    const baseline = { userMessages: 1, errors: 2, lastTurnEndAt: 800, lastTurnOutcome: 'failed' };
    const store = new SidebarThreadStore(() => now);
    const ids = ['deadline', 'message', 'failure', 'question', 'history'];
    await Promise.all(ids.map(id => store.set(id, 'snoozed', id === 'deadline' ? 2000 : 9000, baseline)));
    expect(await store.get('history', baseline)).toEqual(expect.objectContaining({ shelf: 'snoozed' }));
    now = 2000;
    expect(await store.get('deadline')).toEqual({ shelf: 'active' });
    expect(await store.get('message', { ...baseline, userMessages: 2 })).toEqual({ shelf: 'active' });
    expect(await store.get('question', baseline)).toMatchObject({ shelf: 'snoozed' });
    expect(await store.get('failure', { ...baseline, lastTurnEndAt: 2000, lastTurnOutcome: 'stalled' })).toEqual({ shelf: 'active' });
    expect((await store.list()).nextWake).toBe(9000);
    now = 10_000;
    expect(await store.list()).toMatchObject({ records: {}, nextWake: null });
    expect((await new SidebarThreadStore(() => now).list()).records).toEqual({});
  });

  it('rejects unsafe IDs, bad deadlines and full capacity without evicting pins', async () => {
    const store = new SidebarThreadStore(() => now);
    await expect(store.set('../outside', 'pinned')).rejects.toThrow(/Invalid local/);
    await expect(store.set('__proto__', 'pinned')).rejects.toThrow(/Invalid local/);
    await expect(store.set('safe-id', 'snoozed', NaN)).rejects.toThrow(/deadline/);
    await expect(store.set('safe-id', 'snoozed', Infinity)).rejects.toThrow(/deadline/);

    const rows = Object.fromEntries(Array.from({ length: MAX_SIDEBAR_SHELVES }, (_, i) => [`row-${i}`, { shelf: 'pinned' }]));
    await durable.writeDurableNow('sidebar-thread-shelves', {
      version: 1, revision: 4, migratedLegacy: false, records: rows
    });
    const full = new SidebarThreadStore(() => now);
    await expect(full.set('next-row', 'settled')).rejects.toThrow(/limit/);
    expect((await full.list()).records['row-0']).toEqual({ shelf: 'pinned' });
    expect(Object.keys((await new SidebarThreadStore(() => now).list()).records)).toHaveLength(MAX_SIDEBAR_SHELVES);
  });

  it('imports old renderer preferences once, ignores malformed disk entries, and does not reimport stale choices', async () => {
    await durable.writeDurableNow('sidebar-thread-shelves', {
      version: 1, revision: 3, migratedLegacy: false,
      records: { 'valid-row': { shelf: 'pinned' }, 'invalid-row': { shelf: 'snoozed', until: 'tomorrow' } }
    });
    const store = new SidebarThreadStore(() => now);
    await store.migrateLegacy({ 'legacy-row': { shelf: 'snoozed', until: 5000, snoozedAt: 400, userMessages: 2 },
      'valid-row': { shelf: 'settled' } });
    expect((await store.list()).records).toEqual({
      'valid-row': { shelf: 'pinned' },
      'legacy-row': { shelf: 'snoozed', until: 5000, snoozedAt: 400, userMessages: 2 }
    });
    await store.set('legacy-row', 'active');
    const restart = new SidebarThreadStore(() => now);
    await restart.migrateLegacy({ 'legacy-row': { shelf: 'pinned' } });
    expect(await restart.get('legacy-row')).toEqual({ shelf: 'active' });
  });

  it('leaves acknowledged state intact when a disk commit fails', async () => {
    const store = new SidebarThreadStore(() => now);
    await store.set('persisted', 'pinned');
    const realWrite = durable.writeDurableNow;
    const failing = vi.spyOn(durable, 'writeDurableNow').mockImplementationOnce(async () => {
      throw new Error('disk full');
    }).mockImplementation(realWrite);
    await expect(store.set('persisted', 'settled')).rejects.toThrow('disk full');
    expect(await store.get('persisted')).toEqual({ shelf: 'pinned' });
    expect(await new SidebarThreadStore(() => now).get('persisted')).toEqual({ shelf: 'pinned' });
    expect(failing).toHaveBeenCalled();
  });
});
