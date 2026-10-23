/** Wake-only transport. Durable HTTP claims remain the sole delivery authority. */
import type http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { logInfo } from './logger.js';

const subscribers = new Set<(topic: 'wake' | 'browser-control') => void>();
/** The CoS browser's own copy of the extension, or the one in the person's browser. */
export type WakeHost = 'cos' | 'browser';
export function wakeBrowserWork(topic: 'wake' | 'browser-control' = 'wake'): void {
  for (const wake of subscribers) wake(topic);
}

/** `changed` hears an authenticated channel open or close: whether the browser is there at all. */
export function attachBrowserWake(server: http.Server, allowed: (request: http.IncomingMessage) => boolean,
  authenticate: (token: string) => Promise<boolean>, changed: () => void = () => undefined): {
    connected(host?: WakeHost): boolean; revoke(): void; dispose(): void;
  } {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 512, perMessageDeflate: false });
  const authorized = new Map<WebSocket, number>();
  /** Which copy of the extension holds each socket, as its URL says; older builds say nothing. */
  const hosts = new Map<WebSocket, WakeHost>();
  /** Why the app itself dropped a socket, for its one log line; a socket missing here was closed by the browser. */
  const dropped = new Map<WebSocket, string>();
  const drop = (client: WebSocket, why: string) => { dropped.set(client, why); client.terminate(); };
  const named = (client: WebSocket) => hosts.get(client) ?? 'host not named';
  let epoch = 0;
  const upgrade = (request: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '', 'http://127.0.0.1');
    if (url.pathname !== '/wake' || !allowed(request) || sockets.clients.size >= 8) { socket.destroy(); return; }
    const host = url.searchParams.get('host');
    sockets.handleUpgrade(request, socket, head, (client) => {
      if (host === 'cos' || host === 'browser') hosts.set(client, host);
      const generation = epoch;
      let authenticating = false;
      const deadline = setTimeout(() => client.terminate(), 5000);
      deadline.unref();
      client.on('error', () => client.terminate());
      client.on('close', () => {
        clearTimeout(deadline);
        if (authorized.delete(client)) {
          logInfo(`bridge: browser wake channel (${named(client)}) disconnected: ${dropped.get(client) ?? 'closed by the browser'}`);
          changed();
        }
        hosts.delete(client);
        dropped.delete(client);
      });
      client.on('message', (bytes, binary) => {
        if (binary) { client.terminate(); return; }
        const message = bytes.toString();
        if (authorized.has(client)) {
          if (message === 'pong') authorized.set(client, Date.now());
          else client.terminate();
          return;
        }
        if (authenticating) { client.terminate(); return; }
        authenticating = true;
        void authenticate(message).then((ok) => {
          if (!ok || epoch !== generation) { client.terminate(); return; }
          if (client.readyState !== WebSocket.OPEN) return;
          clearTimeout(deadline);
          authorized.set(client, Date.now());
          logInfo(`bridge: browser wake channel (${named(client)}) authenticated`);
          changed();
          // Reconnection always reads current work; no lost notification is durable state.
          client.send('wake');
        }).catch(() => client.terminate());
      });
    });
  };
  server.on('upgrade', upgrade);
  const wake = (topic: 'wake' | 'browser-control') => {
    for (const client of authorized.keys()) {
      if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 1024) client.send(topic);
      else drop(client, client.readyState === WebSocket.OPEN ? 'its wake messages backed up' : 'its socket was no longer open');
    }
  };
  subscribers.add(wake);
  // Chrome 116+ keeps an extension worker alive with WebSocket activity under 30s.
  // This is a transport heartbeat, not a poll of chats or the outbox.
  const heartbeat = setInterval(() => {
    for (const [client, seen] of authorized) {
      if (Date.now() - seen > 45000) drop(client, `no answer for ${Math.round((Date.now() - seen) / 1000)} s`);
      else if (client.bufferedAmount >= 1024) drop(client, 'its wake messages backed up');
      else if (client.readyState === WebSocket.OPEN) client.send('ping');
    }
  }, 20000);
  heartbeat.unref();
  const revoke = () => {
    epoch++;
    const had = authorized.size > 0;
    for (const client of sockets.clients) client.terminate();
    authorized.clear();
    if (had) changed();
  };
  return { connected: (host?: WakeHost) => [...authorized].some(([client, seen]) => client.readyState === WebSocket.OPEN &&
    client.bufferedAmount < 1024 && Date.now() - seen <= 45000 && (host === undefined || hosts.get(client) === host)), revoke, dispose() {
    subscribers.delete(wake); clearInterval(heartbeat); server.off('upgrade', upgrade); revoke(); sockets.close();
  } };
}
