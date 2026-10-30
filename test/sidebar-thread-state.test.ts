import { describe, expect, it } from 'vitest';
import { createSidebarThreadState } from '../src/renderer/sidebar-thread-state.js';

function memoryStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: (_key: string) => value,
    setItem: (_key: string, next: string) => { value = next; },
    read: () => value
  };
}

describe('local sidebar thread shelves', () => {
  it('persists pin, settle, and wake without mutating sessions', () => {
    const storage = memoryStorage();
    const state = createSidebarThreadState(storage, () => 1_000);
    expect(state.get('thread')).toBe('active');
    state.set('thread', 'pinned');
    expect(createSidebarThreadState(storage, () => 1_000).get('thread')).toBe('pinned');
    state.set('thread', 'settled');
    expect(state.get('thread')).toBe('settled');
    state.set('thread', 'active');
    expect(createSidebarThreadState(storage, () => 1_000).get('thread')).toBe('active');
  });

  it('automatically wakes snoozed threads at their deadline', () => {
    let now = 1000;
    const storage = memoryStorage();
    const state = createSidebarThreadState(storage, () => now);
    state.set('a', 'snoozed', 2000);
    state.set('b', 'snoozed', 3000);
    expect(state.snapshot('a')).toEqual({ shelf: 'snoozed', until: 2000 });
    expect(state.get('a')).toBe('snoozed');
    expect(state.nextWake()).toBe(2000);
    now = 2000;
    expect(state.get('a')).toBe('active');
    expect(state.nextWake()).toBe(3000);
    expect(createSidebarThreadState(storage, () => now).get('b')).toBe('snoozed');
    now = 3000;
    expect(state.get('b')).toBe('active');
    expect(state.nextWake()).toBeNull();
  });

  it('rejects invalid storage, invalid deadlines, and unbounded growth', () => {
    const bad = createSidebarThreadState(memoryStorage('{broken'), () => 1000);
    expect(bad.get('x')).toBe('active');
    bad.set('x', 'snoozed', NaN);
    expect(bad.get('x')).toBe('active');
    const storage = memoryStorage();
    const state = createSidebarThreadState(storage, () => 1000);
    for (let i = 0; i < 1510; i++) state.set(`t${i}`, 'pinned');
    expect(Object.keys(JSON.parse(storage.read()!))).toHaveLength(1500);
    expect(state.get('t0')).toBe('active');
    expect(state.get('t1509')).toBe('pinned');
  });

  it('prunes expired snoozes even when their sessions were not loaded into the sidebar', () => {
    let now = 1000;
    const storage = memoryStorage();
    const state = createSidebarThreadState(storage, () => now);
    state.set('unloaded-session', 'snoozed', 2500);
    now = 5000;
    expect(state.nextWake()).toBeNull();
    expect(Object.keys(JSON.parse(storage.read()!))).toEqual([]);
  });

  it('wakes for new messages, errors, and failed turns but not stored question identities', () => {
    let now = 1000;
    const baseline = { userMessages: 2, errors: 1, lastTurnEndAt: 900, lastTurnOutcome: 'failed' };
    const state = createSidebarThreadState(memoryStorage(), () => now);
    for (const id of ['question', 'message', 'error', 'failure', 'ordinary']) state.set(id, 'snoozed', 99999, baseline);
    expect(state.get('ordinary', baseline)).toBe('snoozed'); // Historic error must not wake new snooze.
    now = 1010;
    expect(state.get('question', baseline)).toBe('snoozed');
    expect(state.get('message', { ...baseline, userMessages: 3 })).toBe('active');
    expect(state.get('error', { ...baseline, errors: 2 })).toBe('active');
    expect(state.get('failure', { ...baseline, lastTurnEndAt: 1010, lastTurnOutcome: 'failed' })).toBe('active');
    expect(state.get('ordinary', { ...baseline, lastTurnEndAt: 1010, lastTurnOutcome: 'completed' })).toBe('snoozed');
  });
});
