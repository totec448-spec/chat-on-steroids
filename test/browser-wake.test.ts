import http from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { attachBrowserWake, wakeBrowserWork } from '../src/main/browser-wake.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function setup(auth: (token: string) => Promise<boolean> = async token => token === 'paired') {
  const server = http.createServer();
  const bridge = attachBrowserWake(server, req => req.headers.origin === 'chrome-extension://test', auth);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as import('node:net').AddressInfo).port;
  cleanup.push(async () => { bridge.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); });
  function client(origin = 'chrome-extension://test') {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/wake`, { origin });
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
