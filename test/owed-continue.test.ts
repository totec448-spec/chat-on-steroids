import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  OWED_MAX_ATTEMPTS, OWED_MAX_MS, OWED_QUIET_MS, clearOwedContinue, noteOwedActivity, noteOwedContinue, owedContinueFor,
  resetOwedContinuesForTests, type OwedDeps, type OwedState
} from '../src/main/owed-continue.js';
import * as logger from '../src/main/logger.js';

// #2131: the Continue after the app's rotation Stop is filed once; when the page refused it before Send
// nothing filed it again, and the chat sat idle once the stopped request went quiet.
let clock = 0;
let state: OwedState;
let filed: Array<[string, string]>;
let fileResult: unknown;
let deps: OwedDeps;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  clock = 1_000_000; state = 'open'; filed = []; fileResult = { id: 'row' };
  deps = { now: () => clock, state: async () => state, file: async (session, turn) => { filed.push([session, turn]); return fileResult; } };
});
afterEach(() => { resetOwedContinuesForTests(); vi.useRealTimers(); vi.restoreAllMocks(); });
const quiet = async (ms = OWED_QUIET_MS) => { clock += ms; await vi.advanceTimersByTimeAsync(ms); };

it('files the Continue again once the chat has been quiet, when the first one was not sent', async () => {
  const info = vi.spyOn(logger, 'logInfo');
  noteOwedContinue('conv', 'session', 'turn-1', deps);
  await quiet(OWED_QUIET_MS - 1_000);
  expect(filed).toEqual([]);
  await quiet(1_000);
  expect(filed).toEqual([['session', 'turn-1']]);
  expect(owedContinueFor('conv')).toEqual({ attempts: 2 });
  expect(info.mock.calls.map(args => String(args[0])).some(line => line.includes('filing it again (try 2 of 4)'))).toBe(true);
});

it('waits while the stopped request keeps working: every sign of activity restarts the quiet wait', async () => {
  noteOwedContinue('conv', 'session', 'turn-1', deps);
  for (let i = 0; i < 80; i++) { await quiet(30_000); noteOwedActivity('conv'); }
  expect(filed).toEqual([]);
  await quiet();
  expect(filed).toHaveLength(1);
});

it('waits while a turn is running, and stops once the Continue was sent or the chat moved on', async () => {
  noteOwedContinue('conv', 'session', 'turn-1', deps);
  state = 'busy';
  await quiet(); await quiet();
  expect(filed).toEqual([]);
  state = 'delivered';
  await quiet();
  expect(filed).toEqual([]);
  expect(owedContinueFor('conv')).toBeNull();
  noteOwedContinue('conv', 'session', 'turn-2', deps);
  state = 'moved';
  await quiet();
  expect(filed).toEqual([]);
  expect(owedContinueFor('conv')).toBeNull();
});

it('does not count an attempt when something else was waiting, and gives up after the last try', async () => {
  const warn = vi.spyOn(logger, 'logWarn');
  noteOwedContinue('conv', 'session', 'turn-1', deps);
  fileResult = null;
  await quiet(); await quiet();
  expect(owedContinueFor('conv')).toEqual({ attempts: 1 });
  filed = [];
  fileResult = { id: 'row' };
  for (let i = 0; i < OWED_MAX_ATTEMPTS + 2; i++) await quiet();
  expect(filed).toHaveLength(OWED_MAX_ATTEMPTS - 1);
  expect(owedContinueFor('conv')).toBeNull();
  expect(warn.mock.calls.map(args => String(args[0])).some(line => line.includes('was not sent after 4 tries'))).toBe(true);
});

it('gives up after two hours, and a person\'s Stop ends the obligation at once', async () => {
  const warn = vi.spyOn(logger, 'logWarn');
  noteOwedContinue('conv', 'session', 'turn-1', deps);
  fileResult = null;
  clock += OWED_MAX_MS;
  await quiet();
  expect(owedContinueFor('conv')).toBeNull();
  expect(warn.mock.calls.map(args => String(args[0])).some(line => line.includes('within 2 hours'))).toBe(true);
  noteOwedContinue('conv', 'session', 'turn-3', deps);
  clearOwedContinue('conv');
  await quiet();
  expect(filed).toEqual([]);
});

it('keeps one obligation per chat: a newer stop replaces the older one', async () => {
  noteOwedContinue('conv', 'session', 'turn-1', deps);
  await quiet(OWED_QUIET_MS - 1_000);
  noteOwedContinue('conv', 'session', 'turn-2', deps);
  await quiet(1_000);
  expect(filed).toEqual([]);
  await quiet(OWED_QUIET_MS);
  expect(filed).toEqual([['session', 'turn-2']]);
});

it('survives a failing check and tries again', async () => {
  const warn = vi.spyOn(logger, 'logWarn');
  let calls = 0;
  deps = { ...deps, state: async () => { if (calls++ === 0) throw new Error('disk'); return 'open'; } };
  noteOwedContinue('conv', 'session', 'turn-1', deps);
  await quiet(); await quiet();
  expect(warn.mock.calls.map(args => String(args[0])).some(line => line.includes('could not check the owed Continue'))).toBe(true);
  expect(filed).toHaveLength(1);
});
