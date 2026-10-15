import type http from 'node:http';
import type { ControlApiEvent } from '../shared/control-api.js';
import { eventStreamQuery, RequestError, STREAM_PAGE, streamEvents } from './control-reads.js';
import { onSessionChange } from './session/recorder.js';

/**
 * `GET /v1/sessions/{id}/events/stream`: a chat's events as Server-Sent Events (#1349).
 *
 * It is the paged read, repeated. Every frame is a row `GET …/events?from=` would return, read
 * through the same owner under the same limits, so a stream can show nothing the read does not.
 * The recorder's change notice says when to read again; a slow tick covers a notice that never
 * came. A frame's `id` is the event's `seq`, so `Last-Event-ID` resumes after the last one seen.
 *
 * A stream is a held connection, so there are few of them, each ends after a fixed life with an
 * `end` frame that says why, and a client that does not read is closed rather than buffered for.
 */

/** Held connections cost a socket and a listener each; an agent needs one per chat it follows. */
export const MAX_EVENT_STREAMS = 4;
/** What may wait in the socket for a client that reads slowly. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

const DEFAULT_TIMING = { heartbeatMs: 15_000, pollMs: 5_000, maxLifeMs: 30 * 60_000 };
let timing = { ...DEFAULT_TIMING };
export function setStreamTimingForTests(over: Partial<typeof DEFAULT_TIMING>): void {
  timing = { ...DEFAULT_TIMING, ...over };
}

const STREAM_ROUTE = /^\/v1\/sessions\/([0-9a-z-]{8,64})\/events\/stream$/;
/** The session a stream route names, or null for any other route. */
export const eventStreamSession = (route: string): string | null => STREAM_ROUTE.exec(route)?.[1] ?? null;

const streams = new Set<{ end: (reason: string) => void }>();

/** Ends every open stream, each with an `end` frame: the API stopped, or the app is quitting. */
export function closeEventStreams(reason: string): void {
  for (const stream of [...streams]) stream.end(reason);
}

const frame = (event: ControlApiEvent): string => `id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;

/**
 * Answers a stream request. Everything that can refuse it does so before the first byte, as JSON
 * like any other read; `firstRead` lets the listener put its read deadline around the first read.
 */
export async function serveEventStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionId: string,
  params: URLSearchParams,
  firstRead: <T>(start: () => Promise<T>) => Promise<T> = (start) => start()
): Promise<void> {
  const query = eventStreamQuery(params, req.headers['last-event-id']);
  if (streams.size >= MAX_EVENT_STREAMS) throw new RequestError(503, 'busy', 'too many event streams are open; close one or retry shortly');

  let from = query.from;
  let ended = false;
  let reading = false;
  let readAgain = false;
  const timers: NodeJS.Timeout[] = [];
  let unsubscribe: (() => void) | null = null;

  const end = (reason: string): void => {
    if (ended) return;
    ended = true;
    for (const timer of timers) clearTimeout(timer);
    unsubscribe?.();
    streams.delete(stream);
    if (res.destroyed || res.writableEnded) return;
    // Refused or stopped before the stream began: there is no stream to end politely.
    if (!res.headersSent) return void res.destroy();
    res.end(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`);
  };
  // The place is taken before the first read, so opens that arrive together cannot exceed the cap.
  const stream = { end };
  streams.add(stream);

  const send = (events: ControlApiEvent[], nextFrom: number): void => {
    // A client can stop between frames. Sequence order makes Last-Event-ID safe even when
    // presentation chronology placed a revised message ahead of an earlier-sequence row.
    for (const event of events.toSorted((left, right) => left.seq - right.seq)) res.write(frame(event));
    from = Math.max(from, nextFrom);
    if (res.writableLength > MAX_BUFFERED_BYTES) end('slow_consumer');
  };

  /** Reads until the stream has caught up. A notice that arrives meanwhile asks for one more pass. */
  const catchUp = async (): Promise<void> => {
    if (ended) return;
    if (reading) { readAgain = true; return; }
    reading = true;
    try {
      do {
        readAgain = false;
        for (;;) {
          const before = from;
          const page = await streamEvents(sessionId, from, query.kinds);
          if (ended) return;
          send(page.events, page.nextFrom);
          if (ended || page.events.length < STREAM_PAGE || from === before) break;
        }
      } while (readAgain && !ended);
    } catch (error) {
      // Too many reads at once is the app being busy: the next notice or tick reads again.
      if (error instanceof RequestError && error.code === 'busy') return;
      end(error instanceof RequestError && error.code === 'session_not_found' ? 'session_gone' : 'error');
    } finally {
      reading = false;
    }
  };

  let first;
  try {
    first = await firstRead(() => streamEvents(sessionId, from, query.kinds));
  } catch (error) {
    ended = true;
    streams.delete(stream);
    throw error;
  }
  // Stopped while the first read ran: `end` already closed the connection.
  if (ended) return;

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    // Not reused after its `end` frame, so a stopping listener does not wait on it.
    connection: 'close'
  });
  res.on('close', () => end('client'));
  // Sent at once: headers alone are not flushed, and a quiet chat would look like a dead connection
  // until the first heartbeat.
  res.write(': stream open\n\n');
  send(first.events, first.nextFrom);
  if (ended) return;

  const every = (ms: number, run: () => void): void => { const timer = setInterval(run, ms); timer.unref(); timers.push(timer); };
  every(timing.heartbeatMs, () => { if (!ended) res.write(': keep-alive\n\n'); });
  every(timing.pollMs, () => void catchUp());
  const life = setTimeout(() => end('max_duration'), timing.maxLifeMs);
  life.unref();
  timers.push(life);
  unsubscribe = onSessionChange((change) => {
    if (change.allTranscripts || change.sessionIds?.includes(sessionId)) void catchUp();
  });
  if (first.events.length >= STREAM_PAGE) void catchUp();
}
