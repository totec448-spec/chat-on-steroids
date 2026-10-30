import http from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { attachBrowserWake, wakeBrowserWork } from '../src/main/browser-wake.js';
import * as logger from '../src/main/logger.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function setup(auth: (token: string) => Promise<boolean> = async token => token === 'paired', changed: () => void = () => undefined,
  options: { quietReconnectMs?: number; summaryMs?: number } = {}) {
  const server = http.createServer();
  const bridge = attachBrowserWake(server, req => req.headers.origin === 'chrome-extension://test', auth, changed, options);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as import('node:net').AddressInfo).port;
  cleanup.push(async () => { bridge.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); });
  function client(origin = 'chrome-extension://test', host?: string) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/wake${host ? `?host=${host}` : ''}`, { origin });
    socket.on('error', () => {});
    return socket;
  }
  return { bridge, client };
}
describe('authenticated wake-only browser transport', () => {
  it('signals current and newly published work without carrying input text', async () => {
    const h = await setup(); const client = h.client(); await once(client, 'open');
    expect(h.bridge.connected()).toBe(false); // an unauthenticated socket is not delivery reachability
    const first = once(client, 'message'); client.send('paired');
    expect(String((await first)[0])).toBe('wake');
    expect(h.bridge.connected()).toBe(true);
    const next = once(client, 'message'); wakeBrowserWork();
    expect(String((await next)[0])).toBe('wake');
    const closed = once(client, 'close'); h.bridge.revoke(); await closed;
    expect(h.bridge.connected()).toBe(false);
  });
  it('tells the bridge when an authenticated browser comes and goes, so its presence can follow', async () => {
    const seen: boolean[] = [];
    const h = await setup(undefined, () => seen.push(h.bridge.connected()));
    const client = h.client(); await once(client, 'open');
    expect(seen).toEqual([]); // an open socket alone is nobody
    const ready = once(client, 'message'); client.send('paired'); await ready;
    expect(seen).toEqual([true]);
    const closed = once(client, 'close'); client.close(); await closed;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(seen).toEqual([true, false]);
  });
  // 2026-10-21: a fresh-turn continue went untaken while one extension worker had stopped
  // answering; the log said only "disconnected", for either copy of the extension and any cause.
  it('logs which copy of the extension came or went, and why it went', async () => {
    const logged = vi.spyOn(logger, 'logInfo').mockImplementation(() => undefined);
    try {
      const h = await setup();
      const cos = h.client(undefined, 'cos'); await once(cos, 'open');
      const ready = once(cos, 'message'); cos.send('paired'); await ready;
      const closed = once(cos, 'close'); cos.close(); await closed;
      await new Promise(resolve => setTimeout(resolve, 20));
      const older = h.client(); await once(older, 'open');
      const olderReady = once(older, 'message'); older.send('paired'); await olderReady;
      const olderClosed = once(older, 'close'); older.close(); await olderClosed;
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(logged.mock.calls.map(([line]) => line)).toEqual([
        'bridge: browser wake channel (cos) authenticated',
        'bridge: browser wake channel (cos) disconnected: closed by the browser',
        'bridge: browser wake channel (host not named) authenticated',
        'bridge: browser wake channel (host not named) disconnected: closed by the browser'
      ]);
    } finally { logged.mockRestore(); }
  });
  // 2026-10-30: Firefox suspends an idle add-on's background page, which closes its wake channel; it
  // reconnects about every 32 s. That was 2,592 log lines a day pushing everything else out of the log.
  async function churnSetup(options: { quietReconnectMs?: number; summaryMs?: number }) {
    const logged = vi.spyOn(logger, 'logInfo').mockImplementation(() => undefined);
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let changes = 0;
    const h = await setup(undefined, () => { changes += 1; }, options);
    // Each open and close is counted by the server itself, so a step waits for the server, not a sleep.
    const settled = async (before: number) => vi.waitFor(() => expect(changes).toBeGreaterThan(before), { timeout: 2_000 });
    const open = async () => {
      const before = changes;
      const socket = h.client(undefined, 'browser'); await once(socket, 'open');
      const ready = once(socket, 'message'); socket.send('paired'); await ready;
      await settled(before);
      return socket;
    };
    const close = async (socket: WebSocket) => { const before = changes; socket.close(); await settled(before); };
    const lines = () => logged.mock.calls.map(([line]) => String(line)).filter(line => line.includes('wake channel (browser)'));
    return { open, close, lines, advance: (ms: number) => { now += ms; }, restore: () => { clock.mockRestore(); logged.mockRestore(); } };
  }

  it('logs a browser that keeps closing and reopening its channel once, then once an hour, and still logs a real drop', async () => {
    const c = await churnSetup({ quietReconnectMs: 200 });
    try {
      let socket = await c.open();
      for (let i = 0; i < 4; i++) {
        c.advance(30_000); await c.close(socket);
        c.advance(100); socket = await c.open();
      }
      // The first quick cycle reads as before; the next three are only counted.
      expect(c.lines()).toEqual([
        'bridge: browser wake channel (browser) authenticated',
        'bridge: browser wake channel (browser) disconnected: closed by the browser',
        'bridge: browser wake channel (browser) authenticated'
      ]);
      // An hour on, the count is said once.
      c.advance(60 * 60_000); await c.close(socket); c.advance(100); socket = await c.open();
      expect(c.lines().at(-1)).toBe('bridge: browser wake channel (browser) was closed by the browser and reopened at once 4 more times since the last line like this; ' +
        'an extension whose background sleeps when idle does this');
      // A close that is not followed by a reconnect is a real drop, and is logged after all.
      c.advance(30_000); await c.close(socket);
      await vi.waitFor(() => expect(c.lines().at(-1)).toBe('bridge: browser wake channel (browser) disconnected: closed by the browser (it did not come back)'), { timeout: 2_000 });
    } finally { c.restore(); }
  });

  it('logs each of two counted closes that do not come back, and a close whose grace ran out before a slow reconnect (CodeRabbit)', async () => {
    const c = await churnSetup({ quietReconnectMs: 200 });
    try {
      let first = await c.open();
      c.advance(30_000); await c.close(first); c.advance(100); first = await c.open();
      const second = await c.open();
      // Both close in the quiet pattern; neither comes back.
      c.advance(30_000); await c.close(first); await c.close(second);
      await vi.waitFor(() => expect(c.lines().filter(line => line.endsWith('(it did not come back)'))).toHaveLength(2), { timeout: 2_000 });
      // A new quiet pattern, then a reconnect that arrives after the grace though before its timer fired.
      let socket = await c.open();
      c.advance(30_000); await c.close(socket); c.advance(100); socket = await c.open();
      c.advance(30_000); await c.close(socket);
      c.advance(500);
      socket = await c.open();
      expect(c.lines().slice(-2)).toEqual([
        'bridge: browser wake channel (browser) disconnected: closed by the browser (it did not come back)',
        'bridge: browser wake channel (browser) authenticated'
      ]);
    } finally { c.restore(); }
  });

  it('says the hourly count even when the browser then stays connected (CodeRabbit)', async () => {
    const c = await churnSetup({ quietReconnectMs: 200, summaryMs: 300 });
    try {
      let socket = await c.open();
      for (let i = 0; i < 3; i++) { c.advance(50); await c.close(socket); c.advance(50); socket = await c.open(); }
      await vi.waitFor(() => expect(c.lines().at(-1)).toBe('bridge: browser wake channel (browser) was closed by the browser and reopened at once 2 more times ' +
        'since the last line like this; an extension whose background sleeps when idle does this'), { timeout: 2_000 });
    } finally { c.restore(); }
  });

  it('says when it dropped a browser that stopped answering its heartbeat', async () => {
    const logged = vi.spyOn(logger, 'logInfo').mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] });
    try {
      const h = await setup();
      const silent = h.client(undefined, 'browser'); await once(silent, 'open');
      const ready = once(silent, 'message'); silent.send('paired'); await ready;
      const closed = once(silent, 'close');
      vi.advanceTimersByTime(60_000);
      await closed;
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(logged.mock.calls.map(([line]) => line)).toContain('bridge: browser wake channel (browser) disconnected: no answer for 60 s');
      expect(h.bridge.connected()).toBe(false);
    } finally { vi.useRealTimers(); logged.mockRestore(); }
  });
  it('rejects ordinary web origins before authentication', async () => {
    const h = await setup(); const client = h.client('https://chatgpt.com');
    await new Promise<void>(resolve => client.once('close', () => resolve()));
    expect(client.readyState).toBe(WebSocket.CLOSED);
  });
  it('rejects wrong credentials and non-protocol frames', async () => {
    const h = await setup(); const bad = h.client(); await once(bad, 'open');
    const denied = once(bad, 'close'); bad.send('wrong'); await denied;
    const good = h.client(); await once(good, 'open');
    const ready = once(good, 'message'); good.send('paired'); await ready;
    const closed = once(good, 'close'); good.send('send this user message'); await closed;
  });
  it('does not authorize a connection whose credential check finished after revocation', async () => {
    let resolve!: (ok: boolean) => void;
    let entered!: () => void;
    const checking = new Promise<void>(done => { entered = done; });
    const h = await setup(() => { entered(); return new Promise(done => { resolve = done; }); });
    const client = h.client(); await once(client, 'open');
    client.send('paired'); await checking;
    const closed = once(client, 'close'); h.bridge.revoke(); resolve(true); await closed;
    expect(client.readyState).toBe(WebSocket.CLOSED);
  });
});
