import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { createSidebarCompletionState } from '../src/renderer/sidebar-completion.js';

let dom: JSDOM | null = null;
afterEach(() => {
  dom?.window.close();
  dom = null;
  vi.unstubAllGlobals();
});

function fixture(saved?: string, now = 1_000) {
  dom = new JSDOM('', { url: 'https://local.test' });
  vi.stubGlobal('window', dom.window);
  if (saved !== undefined) dom.window.localStorage.setItem('chat-on-steroids.sidebar-completion-seen', saved);
  return { w: dom.window, state: createSidebarCompletionState(() => now) };
}

const completed = (id: string, at: number, outcome = 'completed') => ({ id, activeTurnId: null, lastTurnEndAt: at, lastTurnOutcome: outcome });

it('baselines existing history, marks only newer completed turns unseen and persists the read receipt', () => {
  const first = fixture(undefined, 1_000);
  expect(first.state.isUnseen(completed('old', 900))).toBe(false);
  expect(first.state.isUnseen(completed('background', 1_100))).toBe(true);

  const unseenSaved = first.w.localStorage.getItem('chat-on-steroids.sidebar-completion-seen')!;
  first.w.close(); dom = null;
  const stillUnseen = fixture(unseenSaved, 5_000);
  expect(stillUnseen.state.isUnseen(completed('background', 1_100))).toBe(true);

  stillUnseen.state.markSeen(completed('background', 1_100));
  expect(stillUnseen.state.isUnseen(completed('background', 1_100))).toBe(false);
  const saved = stillUnseen.w.localStorage.getItem('chat-on-steroids.sidebar-completion-seen')!;
  stillUnseen.w.close(); dom = null;

  const reloaded = fixture(saved, 5_000);
  expect(reloaded.state.isUnseen(completed('background', 1_100))).toBe(false);
  expect(reloaded.state.isUnseen(completed('background', 1_200))).toBe(true);
  expect(reloaded.state.isUnseen(completed('another-chat', 1_150))).toBe(true);
});

it.each(['failed', 'stopped', 'interrupted', 'stalled', 'unknown'])(
  'does not turn a %s terminal outcome into a generic unread completion',
  outcome => {
    const { state } = fixture(undefined, 1_000);
    expect(state.isUnseen(completed('chat', 1_100, outcome))).toBe(false);
  }
);

it('does not reuse an older completion while a newer turn is open and accepts either stable final boundary', () => {
  const { state } = fixture(undefined, 1_000);
  expect(state.isUnseen({ ...completed('chat', 1_100), activeTurnId: 'turn-2' })).toBe(false);
  expect(state.isUnseen({ id: 'final-only', activeTurnId: null, lastAssistantFinalAt: 1_101, lastTurnEndAt: null, lastTurnOutcome: 'completed' })).toBe(true);
});

it('recovers from corrupt storage with a fresh baseline instead of blocking the sidebar', () => {
  const { w, state } = fixture('{broken', 2_000);
  expect(state.isUnseen(completed('historical', 1_999))).toBe(false);
  expect(state.isUnseen(completed('fresh', 2_001))).toBe(true);
  expect(() => JSON.parse(w.localStorage.getItem('chat-on-steroids.sidebar-completion-seen')!)).not.toThrow();
});

it('rejects a structurally corrupt receipt list instead of trusting its old baseline', () => {
  const { w, state } = fixture(JSON.stringify({ baselineAt: 1, seen: 'broken' }), 2_000);
  expect(state.isUnseen(completed('historical', 1_999))).toBe(false);
  expect(JSON.parse(w.localStorage.getItem('chat-on-steroids.sidebar-completion-seen')!)).toMatchObject({ baselineAt: 2_000, seen: [] });
});

it('bounds persisted read receipts while keeping the most recently viewed completions', () => {
  const entries: Array<[string, number]> = [];
  let chars = JSON.stringify({ baselineAt: 1, seen: [] }).length;
  for (let index = 0; index < 5_000; index++) {
    const item: [string, number] = [`chat-${index}-${'x'.repeat(140)}`, index + 1];
    const next = JSON.stringify(item).length + (entries.length ? 1 : 0);
    if (chars + next > 599_900) break;
    entries.push(item); chars += next;
  }
  const saved = JSON.stringify({ baselineAt: 1, seen: entries });
  expect(saved.length).toBeGreaterThan(590_000);
  expect(saved.length).toBeLessThan(600_000);
  const { w, state } = fixture(saved, 10_000);
  state.markSeen(completed(`latest-${'y'.repeat(150)}`, 20_000));
  const stored = JSON.parse(w.localStorage.getItem('chat-on-steroids.sidebar-completion-seen')!) as { seen: Array<[string, number]> };
  expect(w.localStorage.getItem('chat-on-steroids.sidebar-completion-seen')!.length).toBeLessThanOrEqual(600_000);
  expect(stored.seen.length).toBeLessThan(entries.length + 1);
  expect(stored.seen.at(-1)).toEqual([`latest-${'y'.repeat(150)}`, 20_000]);
  expect(stored.seen.some(([id]) => id.startsWith('chat-0-'))).toBe(false);
});
