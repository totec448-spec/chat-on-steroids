import { beforeEach, expect, it, vi } from 'vitest';
import type { InputArgs, InputEntry } from '../src/main/session/input.js';
const ports = vi.hoisted(() => ({ backgroundChats: false, running: false as boolean | null, connect: vi.fn(), status: { state: 'connected', detail: '' },
  browser: { connected: false, present: false, lastSeenAt: null as number | null }, open: vi.fn(), bridge: vi.fn(), enqueue: vi.fn(), cancel: vi.fn(), note: vi.fn(), rows: [] as InputEntry[], listeners: new Set<() => void>() }));
vi.mock('../src/main/connection.js', () => ({ connect: ports.connect, getStatus: () => ports.status, onStatusChange: (fn: () => void) => { ports.listeners.add(fn); return () => ports.listeners.delete(fn); } }));
vi.mock('../src/main/bridge.js', () => ({ bridgeStatus: async () => ports.browser, browserWakeConnected: () => ports.browser.connected, startBridge: ports.bridge }));
vi.mock('../src/main/browser.js', () => ({ openInPreferredBrowser: ports.open, isPreferredBrowserRunning: async () => ports.running }));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({ ui: { backgroundChats: ports.backgroundChats } }) }));
vi.mock('../src/main/session/input.js', () => ({ enqueueInput: ports.enqueue, cancelInput: ports.cancel, noteInputStartupError: ports.note, listInputs: async () => ports.rows }));
import { sendDesktopInput, cancelDesktopInput, retryQueuedInputBrowser, resetInputStartupForTests } from '../src/main/session/start-input.js';
const request: InputArgs = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', sessionId: null, text: 'Please start', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null };
beforeEach(() => {
  vi.resetAllMocks(); resetInputStartupForTests();
  ports.rows = []; ports.listeners.clear(); ports.backgroundChats = false; ports.running = false;
  ports.status = { state: 'connected', detail: '' }; ports.browser = { connected: false, present: false, lastSeenAt: null };
  ports.bridge.mockResolvedValue(8765); ports.open.mockResolvedValue('chrome.exe');
  ports.enqueue.mockImplementation(async (input: InputArgs): Promise<InputEntry> => {
    const row: InputEntry = { ...input, state: 'queued', owner: null, createdAt: 1, conversationId: input.sessionId ? 'exact-conversation' : null };
    ports.rows.push(row); return row;
  });
  ports.note.mockImplementation(async (id, error) => { const row = ports.rows.find(entry => entry.id === id); if (row) row.error = error ?? undefined; return row; });
});
it('waits for the existing connector readiness event before publishing input', async () => {
  ports.status = { state: 'connecting-tunnel', detail: 'Starting tunnel' };
  const pending = sendDesktopInput(request);
  await vi.waitFor(() => expect(ports.listeners.size).toBe(1));
  expect(ports.enqueue).not.toHaveBeenCalled(); expect(ports.open).not.toHaveBeenCalled();
  ports.status = { state: 'connected', detail: '' };
  for (const listener of ports.listeners) listener();
  await pending;
  expect(ports.enqueue).toHaveBeenCalledTimes(1); expect(ports.listeners.size).toBe(0);
});
it('retries only the failed browser wake for the same queued UUID', async () => {
  ports.open.mockRejectedValueOnce(new Error('startup refused'));
  await sendDesktopInput(request);
  expect(ports.rows[0]?.error).toContain('Browser startup failed');
  await Promise.all([retryQueuedInputBrowser(request.id), retryQueuedInputBrowser(request.id)]);
  expect(ports.open).toHaveBeenCalledTimes(2);
  expect(ports.enqueue).toHaveBeenCalledTimes(1);
  expect(ports.rows).toHaveLength(1);
  expect(ports.rows[0]).toMatchObject({ id: request.id, state: 'queued', error: undefined });
  expect(await retryQueuedInputBrowser(request.id)).toBeNull();
  ports.rows[0]!.state = 'browser'; ports.rows[0]!.error = 'Message queued. Browser startup failed: old';
  expect(await retryQueuedInputBrowser(request.id)).toBeNull();
});
it('connects before publication and opens exactly one marked bootstrap while Chrome starts', async () => {
  let release!: () => void;
  ports.open.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve('chrome.exe'); }));
  const first = sendDesktopInput(request);
  await vi.waitFor(() => expect(ports.open).toHaveBeenCalledTimes(1));
  const second = sendDesktopInput({ ...request, id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' });
  await vi.waitFor(() => expect(ports.enqueue).toHaveBeenCalledTimes(2));
  expect(ports.open).toHaveBeenCalledTimes(1); release(); await Promise.all([first, second]);
  const url = new URL(ports.open.mock.calls[0]![0]);
  expect(url.searchParams.get('cos-input')).toBe(request.id);
  expect(ports.connect.mock.invocationCallOrder[0]).toBeLessThan(ports.enqueue.mock.invocationCallOrder[0]!);
});
it('preserves setup failures without queueing or opening a browser', async () => {
  ports.status = { state: 'disconnected', detail: 'Add a folder before connecting.' };
  await expect(sendDesktopInput(request)).rejects.toThrow('Add a folder');
  expect(ports.enqueue).not.toHaveBeenCalled(); expect(ports.open).not.toHaveBeenCalled();
});
it('keeps a failed browser launch queued and opens existing targets by exact identity', async () => {
  ports.open.mockRejectedValueOnce(new Error('Chrome refused startup'));
  expect(await sendDesktopInput({ ...request, sessionId: 'session-existing' })).toMatchObject({ state: 'queued' });
  expect(ports.open).toHaveBeenCalledWith('https://chatgpt.com/c/exact-conversation');
  expect(ports.note).toHaveBeenCalledWith(request.id, expect.stringContaining('Message queued. Browser startup failed'));
  ports.browser = { connected: true, present: true, lastSeenAt: 10 };
  await sendDesktopInput(request); expect(ports.open).toHaveBeenCalledTimes(1);
  ports.browser = { connected: false, present: false, lastSeenAt: 10 };
  await sendDesktopInput(request); expect(ports.open).toHaveBeenCalledTimes(2);
});

it('cancels a first send while waiting for connection without publishing or opening Chrome', async () => {
  ports.status = { state: 'connecting-tunnel', detail: '' };
  const pending = sendDesktopInput(request);
  const rejected = expect(pending).rejects.toThrow('Input cancelled');
  await vi.waitFor(() => expect(ports.listeners.size).toBe(1));
  expect(await cancelDesktopInput(request.id)).toBe(true);
  await rejected;
  expect(ports.listeners.size).toBe(0);
  expect(ports.enqueue).not.toHaveBeenCalled();
  expect(ports.open).not.toHaveBeenCalled();
});
it('leaves delivery with the existing browser while its wake transport reconnects', async () => {
  ports.running = true;
  ports.browser = { connected: false, present: true, lastSeenAt: Date.now() };
  await sendDesktopInput(request);
  expect(ports.open).not.toHaveBeenCalled();
  expect(ports.rows[0]).toMatchObject({ state: 'queued', error: undefined });
});
it('preserves background placement for a cold authored send and its explicit retry', async () => {
  ports.backgroundChats = true;
  ports.open.mockRejectedValueOnce(new Error('startup refused'));
  await sendDesktopInput(request);
  await retryQueuedInputBrowser(request.id);
  expect(ports.open).toHaveBeenCalledTimes(2);
  for (const call of ports.open.mock.calls) expect(call[1]).toEqual({ backgroundStartup: true });
  expect(ports.enqueue).toHaveBeenCalledTimes(1);
});
it('cancels an enqueue that commits after the user stopped startup', async () => {
  let commit!: () => void;
  ports.enqueue.mockImplementation(() => new Promise(resolve => { commit = () => resolve({ ...request, state: 'queued' }); }));
  const pending = sendDesktopInput(request);
  const rejected = expect(pending).rejects.toThrow('Input cancelled');
  await vi.waitFor(() => expect(ports.enqueue).toHaveBeenCalled());
  expect(await cancelDesktopInput(request.id)).toBe(true);
  commit(); await rejected;
  expect(ports.cancel).toHaveBeenCalledWith(request.id);
  expect(ports.open).not.toHaveBeenCalled();
});

it.each([true, null])('queues authored input without activating a running or unknown browser (%s)', async state => {
  ports.running = state;
  await sendDesktopInput(request);
  expect(ports.open).not.toHaveBeenCalled();
  expect(ports.rows[0]).toMatchObject({ state: 'queued', error: undefined });
});
