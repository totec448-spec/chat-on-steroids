import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import {
  CONTROL_API_ACTION_ROUTES,
  CONTROL_API_PROTOCOL,
  CONTROL_API_ROUTES,
  type ControlApiEndpoint,
  type ControlApiHealth,
  type ControlApiStatus
} from '../shared/control-api.js';
import type { PluginSnapshot } from '../shared/plugins.js';
import type { BridgeStatus, ConnectionStatus, UpdateStatus } from '../shared/types.js';
import { bridgeStatus } from './bridge.js';
import { actionsAllowed, isActionPath, serveAction } from './control-actions.js';
import { RequestError, serveRead } from './control-reads.js';
import { getStatus } from './connection.js';
import { logInfo, logWarn, redact } from './logger.js';
import { inFlightMcpRequests, inFlightToolCalls, runningToolCalls, settlingToolCalls } from './mcp/call-context.js';
import { pluginManager } from './plugins/manager.js';
import { updateStatus } from './update.js';
import { APP_VERSION } from './version.js';

/**
 * The local control API: an opt-in loopback listener for a trusted local caller. It reads by
 * default; a second switch lets it send and cancel messages through the outbox.
 *
 * Its caller is typically an MCP server an agent launched to watch this app from outside its
 * process. It is deliberately not a fourth MCP surface: those are published through tunnels and
 * go through ChatGPT caller attribution, none of which applies here.
 *
 * What keeps it safe:
 *   · off unless the user turns it on (`controlApi.enabled`), and 127.0.0.1 only
 *   · its own random token per launch, written to `userData/control-api/token`. Unlike the
 *     bridge's `/pair`, the token is never handed out over HTTP: a caller has to be able to read
 *     this user's userData, which it could already read in full
 *   · any request carrying an Origin is refused, so no web page or extension can reach it, and
 *     the Host must be this listener's own loopback address (no DNS rebinding)
 *   · reads are GET only with no request body, under a rate cap charged after authentication
 *   · actions (POST) need a second switch, `controlApi.allowActions`. Without it every action
 *     route answers the same refusal before any body is read. With it, a small JSON body is
 *     read under a byte cap and a timeout, and actions run one at a time under a lower rate cap
 *
 * It owns no fact. Every response is a projection of an existing owner, built with an allowlist
 * so secret-bearing fields (MCP path tokens in local/public URLs, tunnel ids, plugin sources
 * and config) can never leak by a new field appearing on the owner's type.
 */

const DIRECTORY = 'control-api';
const TOKEN_FILE = 'token';
const ENDPOINT_FILE = 'endpoint.json';
/** Requests per rolling minute. A watcher polls every few seconds at most. */
const RATE_LIMIT = 600;
/** Actions per rolling minute: a person or an agent sends a handful, never a stream. */
const ACTION_RATE_LIMIT = 30;
/** A message is at most 64,000 characters, which is 384,000 bytes when every one is escaped as \u00XX. */
const MAX_BODY_BYTES = 512 * 1024;
/** Actions waiting for their turn, counting the one running. Beyond that, a caller is told to wait. */
const MAX_PENDING_ACTIONS = 4;
/** How long a caller gets to deliver the body it announced, and how long an action may take. */
let bodyTimeoutMs = 5_000;
/** An action that has not settled by then is answered as unknown; the outbox row is the truth. */
let actionDeadlineMs = 20_000;

export function setActionLimitsForTests(limits: { bodyTimeoutMs?: number; deadlineMs?: number }): void {
  bodyTimeoutMs = limits.bodyTimeoutMs ?? 5_000;
  actionDeadlineMs = limits.deadlineMs ?? 20_000;
}
/** How long in-flight requests get to finish once the listener stops. */
const DRAIN_MS = 2_000;
/** How long a read waits for the owner it asked before the caller is told it is stuck. */
const READ_DEADLINE_MS = 15_000;
let readDeadlineMs = READ_DEADLINE_MS;
/** Reads that have started and not finished, answered or not. A watcher polls a handful at a time. */
const MAX_UNFINISHED_READS = 8;
let unfinishedReads = 0;

/** Test seam: the deadline is long enough that a test could not wait for it. */
export function setReadDeadlineForTests(ms?: number): void {
  readDeadlineMs = ms ?? READ_DEADLINE_MS;
}

let directory: string | null = null;
let server: http.Server | null = null;
let shutdownRequested = false;
let lifecycle: Promise<void> = Promise.resolve();
const recentRequests: number[] = [];
const recentActions: number[] = [];
/** Actions change the outbox one at a time, in the order they arrived. */
let actionChain: Promise<unknown> = Promise.resolve();
let pendingActions = 0;

export function initControlApiPath(userDataDir: string): void {
  directory = path.join(userDataDir, DIRECTORY);
}

/** Start and stop run one at a time, in the order they were asked for. */
function enqueue(step: () => Promise<void>): Promise<void> {
  const next = lifecycle.then(step, step);
  lifecycle = next.catch(() => undefined);
  return next;
}

export function startControlApi(): Promise<void> {
  return enqueue(startOnce);
}

export function stopControlApi(): Promise<void> {
  return enqueue(stopOnce);
}

/** Terminal: after the app starts quitting, a late settings save must not reopen the listener. */
export function shutdownControlApi(): Promise<void> {
  shutdownRequested = true;
  return enqueue(stopOnce);
}

export function controlApiPort(): number | null {
  const address = server?.address();
  return address && typeof address === 'object' ? address.port : null;
}

async function writePrivate(name: string, content: string): Promise<void> {
  const target = path.join(directory!, name);
  const temp = `${target}.${process.pid}.tmp`;
  await fs.mkdir(directory!, { recursive: true });
  // The mode is advisory on Windows, where userData is already private to the user.
  await fs.writeFile(temp, content, { mode: 0o600 });
  await fs.rename(temp, target);
}

async function removeFiles(): Promise<void> {
  if (!directory) return;
  // The endpoint goes first: a caller that can no longer discover the port stops trying.
  await fs.rm(path.join(directory, ENDPOINT_FILE), { force: true });
  await fs.rm(path.join(directory, TOKEN_FILE), { force: true });
}

async function startOnce(): Promise<void> {
  if (shutdownRequested || server) return;
  if (!directory) throw new Error('The control API path was not initialised.');
  const token = randomBytes(32).toString('base64url');
  const onRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    handle(req, res, token, instance).catch((error: Error) => {
      logWarn(`control API request failed: ${redact(error.message)}`);
      if (!res.headersSent) reply(res, 500, { error: 'internal_error' });
      else res.destroy();
    });
  };
  const instance = http.createServer(onRequest);
  // Without a listener Node answers `Expect: 100-continue` before any check runs. With one, the
  // handler decides, and only an action that passed every check before its body is invited to send it.
  instance.on('checkContinue', onRequest);
  instance.headersTimeout = 15_000;
  instance.requestTimeout = 30_000;
  await new Promise<void>((resolve, reject) => {
    instance.once('error', reject);
    instance.listen(0, '127.0.0.1', () => {
      instance.off('error', reject);
      resolve();
    });
  });
  const port = (instance.address() as AddressInfo).port;
  const endpoint: ControlApiEndpoint = {
    protocol: CONTROL_API_PROTOCOL,
    port,
    pid: process.pid,
    appVersion: APP_VERSION,
    startedAt: new Date().toISOString()
  };
  try {
    // Token before endpoint: a caller that finds the endpoint can always read a matching token.
    await writePrivate(TOKEN_FILE, `${token}\n`);
    await writePrivate(ENDPOINT_FILE, `${JSON.stringify(endpoint, null, 2)}\n`);
  } catch (error) {
    await drain(instance);
    await removeFiles().catch(() => undefined);
    throw error;
  }
  server = instance;
  logInfo(`control API listening on 127.0.0.1:${port}`);
}

async function stopOnce(): Promise<void> {
  const instance = server;
  server = null;
  recentRequests.length = 0;
  recentActions.length = 0;
  await removeFiles();
  if (!instance) return;
  await drain(instance);
  logInfo('control API stopped');
}

function drain(instance: http.Server): Promise<void> {
  return new Promise((resolve) => {
    const force = setTimeout(() => instance.closeAllConnections(), DRAIN_MS);
    force.unref();
    instance.close(() => {
      clearTimeout(force);
      resolve();
    });
    instance.closeIdleConnections();
  });
}

function reply(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
    ...headers
  });
  res.end(text);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function rateLimited(now = Date.now()): boolean {
  while (recentRequests.length && now - recentRequests[0]! >= 60_000) recentRequests.shift();
  if (recentRequests.length >= RATE_LIMIT) return true;
  recentRequests.push(now);
  return false;
}

function actionRateLimited(now = Date.now()): boolean {
  while (recentActions.length && now - recentActions[0]! >= 60_000) recentActions.shift();
  if (recentActions.length >= ACTION_RATE_LIMIT) return true;
  recentActions.push(now);
  return false;
}

/** One answer for every action route, id and body, so a refusal reveals nothing about any of them. */
function refuseActions(res: http.ServerResponse): void {
  reply(res, 403, { error: 'actions_disabled' }, { connection: 'close' });
}

/** The declared body, or null when the caller went away. Refuses what it will not read. */
function readBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<Buffer | null> {
  const declared = req.headers['content-length'];
  if (req.headers['transfer-encoding'] !== undefined || req.headers['content-encoding'] !== undefined) {
    reply(res, 400, { error: 'invalid_framing' }, { connection: 'close' });
    return Promise.resolve(null);
  }
  if (declared !== undefined && !/^\d{1,9}$/.test(declared)) {
    reply(res, 400, { error: 'invalid_framing' }, { connection: 'close' });
    return Promise.resolve(null);
  }
  const length = declared === undefined ? 0 : Number(declared);
  // Refused from the declared length, before a byte is read. A client that keeps uploading a
  // large body without reading the answer can see its connection reset instead of this status.
  if (length > MAX_BODY_BYTES) {
    reply(res, 413, { error: 'body_too_large' }, { connection: 'close' });
    return Promise.resolve(null);
  }
  if (length > 0 && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) {
    reply(res, 415, { error: 'unsupported_media_type' }, { connection: 'close' });
    return Promise.resolve(null);
  }
  if (length === 0) return Promise.resolve(Buffer.alloc(0));
  // The same test Node uses to decide that a request is waiting for a 100 Continue.
  if (/(?:^|\W)100-continue(?:$|\W)/i.test(req.headers.expect ?? '')) res.writeContinue();
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const finish = (value: Buffer | null): void => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onGone);
      req.off('aborted', onGone);
      resolve(value);
    };
    const timer = setTimeout(() => {
      reply(res, 408, { error: 'body_timeout' }, { connection: 'close' });
      finish(null);
    }, bodyTimeoutMs);
    // Node delivers no more than the length it accepted above, so the total is already bounded.
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
    };
    const onEnd = (): void => finish(Buffer.concat(chunks));
    const onGone = (): void => finish(null);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onGone);
    req.on('aborted', onGone);
  });
}

/**
 * Run one action after the ones ahead of it, and answer if it has not settled by the deadline.
 *
 * A caller answered 504 before its turn came is not run later: it was told nothing happened, and
 * a stale message must not be admitted after the caller has moved on. One answered 504 while it
 * was running may still finish, which is why the answer says to check the outbox first.
 */
function runAction<T>(work: () => Promise<T>): Promise<T> {
  if (pendingActions >= MAX_PENDING_ACTIONS) throw new RequestError(503, 'busy', 'too many actions are waiting; retry shortly');
  pendingActions += 1;
  let expired = false;
  let started = false;
  const turn = async (): Promise<T> => {
    if (expired) throw new RequestError(504, 'timeout', 'expired before it started');
    started = true;
    return work();
  };
  const run = actionChain.then(turn, turn);
  actionChain = run.then(() => undefined, () => undefined).finally(() => { pendingActions -= 1; });
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new RequestError(504, 'timeout', started
        ? 'the action may still complete; check GET /v1/inputs before repeating it'
        : 'the action did not start and will not run; it is safe to send again'));
    }, actionDeadlineMs);
  });
  // A failure that arrives after the caller was answered has nobody to tell but the log.
  run.catch((error: Error) => { if (expired && started) logWarn('control API: an action that timed out then failed: ' + redact(error.message)); });
  return Promise.race([run, deadline]).finally(() => clearTimeout(timer));
}

async function handleAction(req: http.IncomingMessage, res: http.ServerResponse, route: string, url: URL): Promise<void> {
  if (actionRateLimited()) return reply(res, 429, { error: 'rate_limited' }, { 'retry-after': '60' });
  if (url.search !== '') return reply(res, 400, { error: 'invalid_query', detail: 'actions take no query string' });
  const raw = await readBody(req, res);
  if (raw === null) return;
  let body: unknown;
  if (raw.length > 0) {
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    } catch {
      return reply(res, 400, { error: 'invalid_json' });
    }
  }
  try {
    const answer = await runAction(async () => {
      // The switch can flip while a body is arriving or an earlier action runs.
      if (!actionsAllowed()) return null;
      return serveAction(req.method ?? '', route, body);
    });
    if (answer === null) return refuseActions(res);
    if (answer === undefined) return reply(res, 404, { error: 'not_found' });
    return reply(res, answer.status, answer.body);
  } catch (error) {
    if (error instanceof RequestError) return reply(res, error.status, { error: error.code, ...(error.detail ? { detail: error.detail } : {}) });
    throw error;
  }
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, token: string, instance: http.Server): Promise<void> {
  // Never answer a browser, not even with an error body it could learn from.
  if (req.headers.origin !== undefined) return reply(res, 403, { error: 'origin_forbidden' });
  const port = (instance.address() as AddressInfo | null)?.port;
  const host = req.headers.host;
  if (!port || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) {
    return reply(res, 403, { error: 'host_forbidden' });
  }
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ') || !safeEqual(header.slice(7), token)) {
    return reply(res, 401, { error: 'unauthorized' });
  }
  // A target that is not plain origin-form is refused before it is parsed, so that no spelling of a
  // path (a backslash, a leading `//`) can reach a route the checks below would treat differently.
  const target = req.url ?? '/';
  let url: URL;
  try {
    if (!/^\/[^\\]*$/.test(target) || target.startsWith('//')) throw new Error('target');
    url = new URL(target, 'http://127.0.0.1');
  } catch {
    return reply(res, 400, { error: 'invalid_target' });
  }
  const route = url.pathname;
  // An action is told apart by method and path alone, before any body is read or any id looked
  // up, so that with the switch off every one of them gets the same answer and nothing changes.
  if (req.method === 'POST' && isActionPath(route)) {
    if (!actionsAllowed()) return refuseActions(res);
    return handleAction(req, res, route, url);
  }
  // Charged only after authentication, so another local process cannot spend the budget.
  if (rateLimited()) return reply(res, 429, { error: 'rate_limited' });
  if (req.method !== 'GET') {
    const allow = route === '/v1/inputs' ? 'GET, POST' : isActionPath(route) ? 'POST' : 'GET';
    return reply(res, 405, { error: 'method_not_allowed' }, { allow });
  }
  if (Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined) {
    req.resume();
    return reply(res, 413, { error: 'body_not_allowed' });
  }
  // A cancel path answers to POST only; a GET there is a wrong method, not a missing page.
  if (isActionPath(route) && route !== '/v1/inputs') return reply(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });

  if (route === '/v1/health') {
    const uptime = process.uptime();
    const body: ControlApiHealth = {
      ok: true,
      protocol: CONTROL_API_PROTOCOL,
      routes: [...CONTROL_API_ROUTES],
      actions: { enabled: actionsAllowed(), routes: [...CONTROL_API_ACTION_ROUTES] },
      pid: process.pid,
      appVersion: APP_VERSION,
      startedAt: new Date(Date.now() - uptime * 1000).toISOString(),
      uptimeSeconds: Math.round(uptime)
    };
    return reply(res, 200, body);
  }
  try {
    const body = await withReadDeadline(() => read(route, url.searchParams));
    if (body !== undefined) return reply(res, 200, body);
  } catch (error) {
    if (error instanceof RequestError) return reply(res, error.status, { error: error.code, ...(error.detail ? { detail: error.detail } : {}) });
    throw error;
  }
  return reply(res, 404, { error: 'not_found' });
}

/** Every read that asks an owner something. `/v1/health` asks nobody and is answered before this. */
async function read(route: string, params: URLSearchParams): Promise<unknown> {
  if (route !== '/v1/status') return serveRead(route, params);
  return projectStatus({
    connection: getStatus(),
    bridge: await bridgeStatus(),
    plugins: pluginManager.snapshot(),
    update: updateStatus(),
    toolCalls: {
      running: runningToolCalls(null),
      settling: settlingToolCalls(null),
      inFlight: inFlightToolCalls(null),
      inFlightMcpRequests: inFlightMcpRequests()
    }
  });
}

/**
 * A read that waits on an owner that is stuck would never answer, and a stuck app is the case a
 * watcher most needs an answer from. Past the deadline the caller is told so, and `/v1/health`
 * still answers. The read itself is not cancelled: it is left to finish or fail on its own, and it
 * keeps its place among the few that may be unfinished at once until it does. Answering early
 * therefore cannot let a watcher that keeps polling pile up stuck reads behind the owner: once
 * they fill the places, the next read is refused at once. One timer per request, cleared when
 * the request is answered.
 */
function withReadDeadline<T>(start: () => Promise<T>): Promise<T> {
  if (unfinishedReads >= MAX_UNFINISHED_READS) {
    return Promise.reject(new RequestError(503, 'busy', 'too many reads are waiting on the app; retry shortly'));
  }
  unfinishedReads += 1;
  const work = start();
  const finished = () => { unfinishedReads -= 1; };
  work.then(finished, finished);
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RequestError(504, 'timeout', 'the app did not answer in time; /v1/health may still answer')), readDeadlineMs);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export interface StatusSources {
  connection: ConnectionStatus;
  bridge: BridgeStatus;
  plugins: PluginSnapshot;
  update: UpdateStatus;
  toolCalls: ControlApiStatus['toolCalls'];
}

/** An allowlist projection: a field is published only by being named here. */
export function projectStatus(sources: StatusSources): ControlApiStatus {
  const { connection, bridge, plugins, update } = sources;
  const text = (value: string | null | undefined) => (value ? redact(value) : null);
  return {
    appVersion: APP_VERSION,
    connection: {
      state: connection.state,
      detail: redact(connection.detail),
      handshakeAt: connection.handshakeAt,
      lastRequestAt: connection.lastRequestAt,
      lastToolCallAt: connection.lastToolCallAt,
      tunnel: connection.health
        ? {
            pollErrors: connection.health.pollErrors,
            uptimeSeconds: connection.health.uptimeSeconds,
            route: connection.health.route,
            probe: connection.health.probe,
            clientVersion: connection.health.clientVersion
          }
        : null,
      surfaces: connection.surfaces.map((surface) => ({
        id: surface.id,
        state: surface.state,
        available: surface.available,
        optional: surface.optional,
        detail: redact(surface.detail),
        tools: surface.tools.length,
        lastRequestAt: surface.lastRequestAt,
        lastToolCallAt: surface.lastToolCallAt
      }))
    },
    bridge: {
      running: bridge.running,
      port: bridge.port,
      portOverridden: bridge.portOverridden === true,
      paired: bridge.paired,
      present: bridge.present,
      lastSeenAt: bridge.lastSeenAt,
      extensionVersion: bridge.extensionVersion,
      error: text(bridge.error)
    },
    plugins: plugins.plugins.map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      enabled: plugin.enabled,
      status: plugin.status,
      enabledTools: plugin.tools.filter((tool) => tool.enabled).length,
      error: text(plugin.error)
    })),
    update: {
      current: update.current,
      latest: update.latest,
      stage: update.stage,
      error: text(update.error),
      checkedAt: update.checkedAt
    },
    toolCalls: { ...sources.toolCalls }
  };
}
