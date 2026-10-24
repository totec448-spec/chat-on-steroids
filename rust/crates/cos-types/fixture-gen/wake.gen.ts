/**
 * Every frame of the wake socket, sent by the app's own `browser-wake.ts` to a real client: the
 * `wake` after authentication, a published `wake` and `browser-control`, and the heartbeat
 * `ping` with the extension's `pong`. The harvest setup captures each frame as it is sent.
 */
import http from 'node:http';
import { once } from 'node:events';
import { afterAll, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

const { attachBrowserWake, wakeBrowserWork } = await import('../../../../src/main/browser-wake.js');

const cleanup: Array<() => Promise<void>> = [];
afterAll(async () => { for (const close of cleanup.splice(0)) await close(); vi.useRealTimers(); });

it('sends wake, browser-control and ping, and hears pong', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const server = http.createServer();
  const wake = attachBrowserWake(server, () => true, async (token) => token === 'dummy-token');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(async () => { wake.dispose(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const port = (server.address() as import('node:net').AddressInfo).port;
  const client = new WebSocket(`ws://127.0.0.1:${port}/wake?host=browser`);
  await once(client, 'open');
  const next = async () => String((await once(client, 'message'))[0]);

  const first = next();
  client.send('dummy-token');
  expect(await first).toBe('wake');
  const published = next();
  wakeBrowserWork();
  expect(await published).toBe('wake');
  const control = next();
  wakeBrowserWork('browser-control');
  expect(await control).toBe('browser-control');
  const heartbeat = next();
  vi.advanceTimersByTime(20_000);
  expect(await heartbeat).toBe('ping');
  client.send('pong');
  client.close();
  await once(client, 'close');
});
