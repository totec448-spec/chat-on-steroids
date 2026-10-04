import { afterEach, expect, it, vi } from 'vitest';
import { API_CHANNEL, EVENT_CHANNEL, ExtensionWorkerLink, PENDING_EVENT_LIMIT, type WorkerLike, type WorkerRegistry } from '../src/main/cos-browser/extension-worker.js';

const SCOPE = 'chrome-extension://companion/';

function worker(scope = SCOPE) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const sent: Array<[string, unknown[]]> = [];
  const tasks: Array<{ ended: boolean }> = [];
  const value: WorkerLike & { destroyed: boolean } = {
    scope,
    destroyed: false,
    isDestroyed() { return value.destroyed; },
    send(channel, name, args) { expect(channel).toBe(EVENT_CHANNEL); sent.push([name as string, args as unknown[]]); },
    startTask() { const task = { ended: false }; tasks.push(task); return { end: () => { task.ended = true; } }; },
    ipc: {
      handle(channel, listener) { if (handlers.has(channel)) throw new Error('Attempted to register a second handler'); handlers.set(channel, listener); },
      removeHandler(channel) { handlers.delete(channel); }
    }
  };
  return { value, handlers, sent, tasks };
}

function registry(workers: Record<number, ReturnType<typeof worker>>, running: number[] = []) {
  const starts: string[] = [];
  const value: WorkerRegistry = {
    getWorkerFromVersionID: id => workers[id]?.value,
    getAllRunning: () => Object.fromEntries(running.map(id => [id, {}])),
    startWorkerForScope: async scope => { starts.push(scope); return {}; }
  };
  return { value, starts };
}

function link(reg: WorkerRegistry, answer = vi.fn(async (name: string) => ({ ok: true, value: name }))) {
  const warn = vi.fn();
  return { link: new ExtensionWorkerLink(reg, SCOPE, answer, warn), answer, warn };
}

it('holds events until the worker has run its script, then delivers them in order', () => {
  const w = worker();
  const reg = registry({ 7: w });
  const { link: channel } = link(reg.value);
  channel.send('runtime.onStartup', []);
  expect(reg.starts).toEqual([SCOPE]);
  channel.statusChanged(7, 'starting');
  channel.send('tabs.onCreated', [{ id: 1 }]);
  expect(w.sent).toEqual([]);
  channel.statusChanged(7, 'running');
  channel.send('tabs.onRemoved', [1, {}]);
  expect(w.sent.map(([name]) => name)).toEqual(['runtime.onStartup', 'tabs.onCreated', 'tabs.onRemoved']);
});

it('answers calls from the moment the worker starts, before it runs', async () => {
  const w = worker();
  const { link: channel, answer } = link(registry({ 3: w }).value);
  channel.statusChanged(3, 'starting');
  await expect(w.handlers.get(API_CHANNEL)!({}, 'tabs.query', [{}])).resolves.toEqual({ ok: true, value: 'tabs.query' });
  expect(answer).toHaveBeenCalledWith('tabs.query', [{}]);
});

it('keeps a running worker alive, as Chrome does while its WebSocket is open, and releases it on close', () => {
  const w = worker();
  const { link: channel } = link(registry({ 4: w }, [4]).value);
  channel.statusChanged(4, 'running');
  expect(w.tasks).toHaveLength(1);
  channel.close();
  expect(w.tasks[0]!.ended).toBe(true);
});

it('starts a stopped worker again while the browser runs, but not after it closed', () => {
  const w = worker();
  const reg = registry({ 5: w }, [5]);
  const { link: channel } = link(reg.value);
  channel.statusChanged(5, 'stopping');
  channel.statusChanged(5, 'stopped');
  expect(reg.starts).toEqual([SCOPE]);
  channel.close();
  channel.statusChanged(5, 'running');
  channel.send('tabs.onCreated', []);
  expect(reg.starts).toEqual([SCOPE]);
  expect(w.sent).toEqual([]);
});

it('never links a worker of another scope, such as chatgpt.com\'s own', () => {
  const page = worker('https://chatgpt.com/');
  const { link: channel } = link(registry({ 9: page }).value);
  channel.statusChanged(9, 'running');
  channel.send('tabs.onCreated', []);
  expect(page.handlers.size).toBe(0);
  expect(page.sent).toEqual([]);
  expect(page.tasks).toEqual([]);
});

it('replaces the handler a worker kept from an earlier link', () => {
  const w = worker();
  const reg = registry({ 2: w }, [2]);
  link(reg.value).link.close();
  expect(() => link(reg.value)).not.toThrow();
  expect(w.handlers.has(API_CHANNEL)).toBe(true);
});

it('bounds the queue for a worker that does not come back and says so once', () => {
  const w = worker();
  const { link: channel, warn } = link(registry({ 1: w }).value);
  for (let i = 0; i < PENDING_EVENT_LIMIT + 5; i++) channel.send('tabs.onUpdated', [i]);
  expect(warn).toHaveBeenCalledTimes(1);
  channel.statusChanged(1, 'running');
  expect(w.sent).toHaveLength(PENDING_EVENT_LIMIT);
  expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('5 event(s) were dropped'));
});

afterEach(() => vi.useRealTimers());

it("does not report a start that raced Electron's own, and reports one that keeps failing", async () => {
  vi.useFakeTimers();
  const w = worker();
  const starts: string[] = [];
  const reg: WorkerRegistry = {
    getWorkerFromVersionID: id => (id === 8 ? w.value : undefined),
    getAllRunning: () => ({}),
    startWorkerForScope: async scope => { starts.push(scope); throw new Error('Failed to start service worker.'); }
  };
  const raced = link(reg);
  raced.link.send('runtime.onStartup', []);
  raced.link.statusChanged(8, 'starting');
  await vi.advanceTimersByTimeAsync(2000);
  expect(raced.warn).not.toHaveBeenCalled();
  expect(starts).toHaveLength(1);

  const failing = link({ ...reg, getWorkerFromVersionID: () => undefined });
  failing.link.send('runtime.onStartup', []);
  await vi.advanceTimersByTimeAsync(2000);
  expect(failing.warn).toHaveBeenCalledWith(expect.stringContaining('could not start the extension worker'));
});
