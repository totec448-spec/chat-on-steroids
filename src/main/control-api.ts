import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import {
  CONTROL_API_PROTOCOL,
  CONTROL_API_ROUTES,
  type ControlApiEndpoint,
  type ControlApiHealth,
  type ControlApiStatus
} from '../shared/control-api.js';
import type { PluginSnapshot } from '../shared/plugins.js';
import type { BridgeStatus, ConnectionStatus, UpdateStatus } from '../shared/types.js';
import { bridgeStatus } from './bridge.js';
import { RequestError, serveRead } from './control-reads.js';
import { getStatus } from './connection.js';
import { logInfo, logWarn, redact } from './logger.js';
import { inFlightMcpRequests, inFlightToolCalls, runningToolCalls, settlingToolCalls } from './mcp/call-context.js';
import { pluginManager } from './plugins/manager.js';
import { updateStatus } from './update.js';
import { APP_VERSION } from './version.js';

/**
 * The local control API: an opt-in, read-only loopback listener for a trusted local caller.
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
 *   · GET only, no request bodies, a request rate cap charged after authentication
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
/** How long in-flight requests get to finish once the listener stops. */
const DRAIN_MS = 2_000;

let directory: string | null = null;
let server: http.Server | null = null;
let shutdownRequested = false;
let lifecycle: Promise<void> = Promise.resolve();
const recentRequests: number[] = [];

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
  const instance = http.createServer((req, res) => {
    handle(req, res, token, instance).catch((error: Error) => {
      logWarn(`control API request failed: ${redact(error.message)}`);
      if (!res.headersSent) reply(res, 500, { error: 'internal_error' });
      else res.destroy();
    });
  });
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
  // Charged only after authentication, so another local process cannot spend the budget.
  if (rateLimited()) return reply(res, 429, { error: 'rate_limited' });
  if (req.method !== 'GET') return reply(res, 405, { error: 'method_not_allowed' }, { allow: 'GET' });
  if (Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined) {
    req.resume();
    return reply(res, 413, { error: 'body_not_allowed' });
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const route = url.pathname;
  if (route === '/v1/health') {
    const uptime = process.uptime();
    const body: ControlApiHealth = {
      ok: true,
      protocol: CONTROL_API_PROTOCOL,
      routes: [...CONTROL_API_ROUTES],
      pid: process.pid,
      appVersion: APP_VERSION,
      startedAt: new Date(Date.now() - uptime * 1000).toISOString(),
      uptimeSeconds: Math.round(uptime)
    };
    return reply(res, 200, body);
  }
  if (route === '/v1/status') {
    const body = projectStatus({
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
    return reply(res, 200, body);
  }
  try {
    const body = await serveRead(route, url.searchParams);
    if (body !== undefined) return reply(res, 200, body);
  } catch (error) {
    if (error instanceof RequestError) return reply(res, error.status, { error: error.code, ...(error.detail ? { detail: error.detail } : {}) });
    throw error;
  }
  return reply(res, 404, { error: 'not_found' });
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
