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
  authenticate: (token: string) => Promise<boolean>, changed: () => void = () => undefined,
  options: { quietReconnectMs?: number; summaryMs?: number } = {}): {
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
  /*
   * 2026-10-30: Firefox suspends an idle add-on's background page, which closes its channel, and the
   * add-on reconnects about every 32 s: 2,592 lines a day that pushed everything else out of the log.
   * Per host, the first close-and-reopen within `quietReconnectMs` is logged as before; after that the
   * cycles are counted and said once an hour. A counted close with no reopen in time is a real drop and
   * is logged when that time is up.
   */
  const quietReconnectMs = options.quietReconnectMs ?? 10_000;
  const summaryMs = options.summaryMs ?? 60 * 60_000;
  type PendingClose = { at: number; quiet: boolean; timer: NodeJS.Timeout };
  type Churn = { pending: PendingClose[]; quiet: boolean; counted: number; saidAt: number; flush: NodeJS.Timeout | null };
  const churn = new Map<string, Churn>();
  const churnOf = (host: string): Churn => {
    let entry = churn.get(host);
    if (!entry) churn.set(host, entry = { pending: [], quiet: false, counted: 0, saidAt: Date.now(), flush: null });
    return entry;
  };
  const lateDrop = (host: string, entry: Churn, close: PendingClose) => {
    clearTimeout(close.timer);
    entry.pending = entry.pending.filter(other => other !== close);
    if (!close.quiet) return; // Its disconnect was logged when it happened.
    entry.quiet = false;
    logInfo(`bridge: browser wake channel (${host}) disconnected: closed by the browser (it did not come back)`);
  };
  const flushCount = (host: string, entry: Churn) => {
    if (entry.flush) { clearTimeout(entry.flush); entry.flush = null; }
    if (entry.counted > 0) {
      logInfo(`bridge: browser wake channel (${host}) was closed by the browser and reopened at once ${entry.counted} more ` +
        'times since the last line like this; an extension whose background sleeps when idle does this');
    }
    entry.counted = 0;
    entry.saidAt = Date.now();
  };
  /** A browser closed one of its channels: remember it for `quietReconnectMs`, one record per close. */
  const browserClosed = (host: string) => {
    const entry = churnOf(host);
    const close: PendingClose = { at: Date.now(), quiet: entry.quiet, timer: setTimeout(() => lateDrop(host, entry, close), quietReconnectMs) };
    close.timer.unref?.();
    entry.pending.push(close);
    if (!close.quiet) logInfo(`bridge: browser wake channel (${host}) disconnected: closed by the browser`);
  };
  /** A channel of `host` authenticated: was it one of its recent closes coming straight back? */
  const browserOpened = (host: string) => {
    const entry = churnOf(host);
    const now = Date.now();
    // A close whose grace ran out, though its timer has not fired yet on a busy computer, is a drop.
    for (const close of [...entry.pending]) if (now - close.at > quietReconnectMs) lateDrop(host, entry, close);
    const close = entry.pending[0];
    if (close) { clearTimeout(close.timer); entry.pending.shift(); }
    if (close && entry.quiet) {
      entry.counted += 1;
      if (now - entry.saidAt >= summaryMs) flushCount(host, entry);
      else if (!entry.flush) {
        entry.flush = setTimeout(() => flushCount(host, entry), Math.max(0, entry.saidAt + summaryMs - now));
        entry.flush.unref?.();
      }
      return;
    }
    logInfo(`bridge: browser wake channel (${host}) authenticated`);
    // Only a reconnect starts the pattern; a second channel opening alongside leaves it as it is.
    if (close) { entry.quiet = true; entry.saidAt = now; }
  };
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
          const why = dropped.get(client);
          if (why) {
            // The app's own drop always says so, and starts any pattern over.
            churnOf(named(client)).quiet = false;
            logInfo(`bridge: browser wake channel (${named(client)}) disconnected: ${why}`);
          } else browserClosed(named(client));
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
          browserOpened(named(client));
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
    for (const entry of churn.values()) {
      for (const close of entry.pending) clearTimeout(close.timer);
      if (entry.flush) clearTimeout(entry.flush);
    }
  } };
}
