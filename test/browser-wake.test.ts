import http from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { attachBrowserWake, wakeBrowserWork } from '../src/main/browser-wake.js';
import * as logger from '../src/main/logger.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function setup(auth: (token: string) => Promise<boolean> = async token => token === 'paired', changed: () => void = () => undefined) {
  const server = http.createServer();
  const bridge = attachBrowserWake(server, req => req.headers.origin === 'chrome-extension://test', auth, changed);
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
