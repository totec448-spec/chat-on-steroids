import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const transport = source.slice(source.indexOf('async function call('), source.indexOf('function provision('));
const wake = source.slice(source.indexOf('let wakeSocket = null;'), source.indexOf('async function applyRequestedBrowserPreferences('));

function harness(status = 200, unavailableSocket = false) {
  const sockets: any[] = [];
  const maintain = vi.fn(async () => {});
  class Socket {
    readyState = 0;
    send = vi.fn();
    close = vi.fn(() => { this.readyState = 3; });
    constructor(public url: string) { if (unavailableSocket) throw new Error('WebSocket unavailable'); sockets.push(this); }
  }
  const context = vm.createContext({ WebSocket: Socket, token: 'paired-secret', disconnected: false, port: 8765,
    discover: async () => ({ port: 8765, compatible: true }), load: async () => {},
    fetchBounded: async () => ({ ok: status === 200, status, json: async () => ({}) }),
    REQUEST_TIMEOUT_MS: 15000, TIMED_OUT: 'timed_out', versionHeaders: () => ({}), maintain,
    persist: async () => {}, latchAppDisconnect: async () => {} });
  vm.runInContext(`${wake}\n${transport}\nglobalThis.callBridge = call;`, context);
  return { sockets, maintain, call: context.callBridge as (path: string) => Promise<unknown> };
}

it('reattaches wake transport on the first authenticated HTTP success before an alarm/status pass', async () => {
  const h = harness();
  await h.call('/events');
  expect(h.sockets).toHaveLength(1);
  const socket = h.sockets[0];
  expect(socket.url).toBe('ws://127.0.0.1:8765/wake');
  socket.onopen(); expect(socket.send).toHaveBeenCalledWith('paired-secret');
  socket.onmessage({ data: 'wake' }); expect(h.maintain).toHaveBeenCalledWith(true);
  await h.call('/events'); expect(h.sockets).toHaveLength(1);
  socket.onclose(); await h.call('/events'); expect(h.sockets).toHaveLength(2);
});

it('does not treat failed HTTP as proof of a restored wake channel', async () => {
  const h = harness(503);
  await h.call('/events'); expect(h.sockets).toHaveLength(0);
});
it('preserves an HTTP delivery receipt if WebSocket construction fails', async () => {
  expect(await harness(200, true).call('/events')).toMatchObject({ ok: true, status: 200 });
});
