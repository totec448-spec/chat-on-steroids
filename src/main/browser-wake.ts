/** Wake-only transport. Durable HTTP claims remain the sole delivery authority. */
import type http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { logInfo } from './logger.js';

const subscribers = new Set<() => void>();
export function wakeBrowserWork(): void {
  for (const wake of subscribers) wake();
}

export function attachBrowserWake(server: http.Server, allowed: (request: http.IncomingMessage) => boolean,
  authenticate: (token: string) => Promise<boolean>): { connected(): boolean; revoke(): void; dispose(): void } {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 512, perMessageDeflate: false });
  const authorized = new Map<WebSocket, number>();
  let epoch = 0;
  const upgrade = (request: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    if (request.url !== '/wake' || !allowed(request) || sockets.clients.size >= 8) { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, (client) => {
      const generation = epoch;
      let authenticating = false;
      const deadline = setTimeout(() => client.terminate(), 5000);
      deadline.unref();
      client.on('error', () => client.terminate());
      client.on('close', () => {
        clearTimeout(deadline);
        if (authorized.delete(client)) logInfo('bridge: browser wake channel disconnected');
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
          logInfo('bridge: browser wake channel authenticated');
          // Reconnection always reads current work; no lost notification is durable state.
          client.send('wake');
        }).catch(() => client.terminate());
      });
    });
  };
  server.on('upgrade', upgrade);
  const wake = () => {
    for (const client of authorized.keys()) {
      if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 1024) client.send('wake');
      else client.terminate();
    }
  };
  subscribers.add(wake);
  // Chrome 116+ keeps an extension worker alive with WebSocket activity under 30s.
  // This is a transport heartbeat, not a poll of chats or the outbox.
  const heartbeat = setInterval(() => {
    for (const [client, seen] of authorized) {
      if (Date.now() - seen > 45000 || client.bufferedAmount >= 1024) client.terminate();
      else if (client.readyState === WebSocket.OPEN) client.send('ping');
    }
  }, 20000);
  heartbeat.unref();
  const revoke = () => { epoch++; for (const client of sockets.clients) client.terminate(); authorized.clear(); };
  return { connected: () => [...authorized].some(([client, seen]) => client.readyState === WebSocket.OPEN &&
    client.bufferedAmount < 1024 && Date.now() - seen <= 45000), revoke, dispose() {
    subscribers.delete(wake); clearInterval(heartbeat); server.off('upgrade', upgrade); revoke(); sockets.close();
  } };
}
