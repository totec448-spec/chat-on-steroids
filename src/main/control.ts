/** Authenticated loopback ingress for external controllers.
 *
 * The controller owns no ChatGPT lifecycle. It only publishes one existing desktop input and
 * reads the exact recorded reply joined to that input's durable UUID.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { Socket } from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import { REASONING_EFFORTS, type SessionEvent, type SessionSummary, type StoredText } from '../shared/session.js';
import { getConfig } from './config.js';
import { cancelDesktopInput, sendDesktopInput } from './session/start-input.js';
import { listInputs, type InputArgs, type InputEntry } from './session/input.js';
import { getSession, readEvents, readOverflowText } from './session/store.js';
import { APP_VERSION } from './version.js';

export const CONTROL_PROTOCOL_VERSION = 1;
export const CONTROL_VERSION_HEADER = 'x-cos-control-version';
const MAX_BODY_BYTES = 64 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const submitSchema = z.object({
  requestId: z.string().uuid(),
  sessionId: z.string().min(8).max(64).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  text: z.string().trim().min(1).max(16_000),
  model: z.string().min(1).max(80).nullable().optional(),
  reasoningEffort: z.enum(REASONING_EFFORTS).nullable().optional()
}).strict();

export type ControlRequestState = 'queued' | 'delivering' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface ControlRequestView {
  requestId: string;
  sessionId: string | null;
  state: ControlRequestState;
  createdAt: number;
  deliveredAt: number | null;
  requestedSelection: { model: string | null; reasoningEffort: InputArgs['reasoningEffort'] };
  observedSelection: { model: string; reasoningEffort: InputArgs['reasoningEffort'] } | null;
  error?: string;
  result?: { text: string; chars: number; truncated: boolean };
}

export interface ControlDependencies {
  send(input: InputArgs): Promise<InputEntry>;
  cancel(id: string): Promise<boolean>;
  inputs(): Promise<InputEntry[]>;
  session(id: string): Promise<SessionSummary | null>;
  events(id: string): Promise<SessionEvent[]>;
  overflow(id: string, assetId: string): Promise<string | null>;
  recording(): boolean;
}

const productionDependencies: ControlDependencies = {
  send: sendDesktopInput,
  cancel: cancelDesktopInput,
  inputs: listInputs,
  session: getSession,
  events: id => readEvents(id, { kinds: ['user_message', 'assistant_message', 'turn_start', 'turn_end'] }),
  overflow: readOverflowText,
  recording: () => getConfig().sessions.record
};

function inputIdentity(input: Pick<InputArgs, 'sessionId' | 'projectId' | 'text' | 'mode' | 'model' | 'reasoningEffort'> &
  Partial<Pick<InputArgs, 'automation' | 'objective' | 'stages' | 'images' | 'attachments' | 'afterTurn'>>): string {
  return JSON.stringify({
    sessionId: input.sessionId,
    projectId: input.projectId ?? null,
    text: input.text,
    mode: input.mode,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    automation: input.automation ?? null,
    objective: input.objective ?? null,
    stages: input.stages ?? null,
    images: input.images ?? null,
    attachments: input.attachments ?? null,
    afterTurn: input.afterTurn ?? null
  });
}

function targetSessionId(entry: InputEntry): string | null {
  return entry.sessionId ?? entry.deliveredSessionId ?? null;
}

async function resultText(deps: ControlDependencies, sessionId: string, stored: StoredText): Promise<ControlRequestView['result']> {
  if (!stored.truncated || !stored.assetId) return { text: stored.text, chars: stored.chars, truncated: stored.truncated };
  const full = await deps.overflow(sessionId, stored.assetId);
  if (full === null) return { text: stored.text, chars: stored.chars, truncated: true };
  const text = full.slice(0, 1_000_000);
  return { text, chars: stored.chars, truncated: text.length !== stored.chars };
}

export async function controlRequestView(deps: ControlDependencies, entry: InputEntry): Promise<ControlRequestView> {
  const sessionId = targetSessionId(entry);
  const base: ControlRequestView = {
    requestId: entry.id,
    sessionId,
    state: entry.state === 'queued' ? 'queued' : ['browser', 'tool'].includes(entry.state) ? 'delivering' :
      entry.state === 'failed' ? 'failed' : entry.state === 'cancelled' ? 'cancelled' : 'running',
    createdAt: entry.createdAt,
    deliveredAt: entry.deliveredAt ?? null,
    requestedSelection: { model: entry.model, reasoningEffort: entry.reasoningEffort },
    observedSelection: null,
    ...(entry.error ? { error: entry.error } : {})
  };
  if (entry.state !== 'sent' || !sessionId) return base;

  // Request/result ownership follows the recorder's durable sequence, never provider clocks.
  // A freshly opened ChatGPT page can report its final DOM snapshot with an earlier provider
  // timestamp than the delivery acknowledgement even though the recorder assigned it the next
  // sequence. Presentation chronology is useful in the UI, but would strand that exact answer
  // before its owning user message here.
  const events = (await deps.events(sessionId)).sort((left, right) => left.seq - right.seq);
  const authored = events.findIndex(event => event.kind === 'user_message' && event.inputId === entry.id &&
    event.inputDelivery === 'confirmed');
  if (authored < 0) return base;
  const user = events[authored]!;
  const observedSelection = user.model
    ? { model: user.model, reasoningEffort: user.reasoningEffort ?? null }
    : null;
  const nextUser = events.findIndex((event, index) => index > authored && event.kind === 'user_message');
  const span = events.slice(authored + 1, nextUser < 0 ? undefined : nextUser);
  const generations = new Set(span.flatMap(event => event.kind === 'turn_start' && event.turnId ? [event.turnId] : []));
  const belongs = (event: SessionEvent): boolean => generations.size === 0 || !event.turnId || generations.has(event.turnId);
  const final = span.findLast(event => event.kind === 'assistant_message' && belongs(event) &&
    (event.final === true || event.state === 'final'));
  if (final?.kind === 'assistant_message') {
    return { ...base, state: 'completed', observedSelection, result: await resultText(deps, sessionId, final.message) };
  }
  const ended = span.findLast(event => event.kind === 'turn_end' && belongs(event));
  if (ended?.kind === 'turn_end' && ended.outcome === 'stopped') return { ...base, state: 'cancelled', observedSelection };
  if (ended?.kind === 'turn_end' && ended.outcome !== 'completed') {
    return { ...base, state: 'failed', observedSelection, error: ended.detail || `ChatGPT turn ended ${ended.outcome}` };
  }
  const summary = await deps.session(sessionId);
  if (summary?.endedAt !== null && summary?.endedAt !== undefined) {
    return { ...base, state: 'failed', observedSelection, error: 'ChatGPT session ended without an exact recorded final answer' };
  }
  return { ...base, observedSelection };
}

class ControlError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length,
    'cache-control': 'no-store'
  });
  res.end(bytes);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += part.length;
    if (bytes > MAX_BODY_BYTES) throw new ControlError(413, 'body_too_large', 'The request body is too large');
    chunks.push(part);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ControlError(400, 'invalid_json', 'The request body is not valid JSON'); }
}

function authenticated(req: http.IncomingMessage, token: string): boolean {
  const authorization = req.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function createControlHandler(deps: ControlDependencies, token: string): http.RequestListener {
  const submitting = new Map<string, { identity: string; work: Promise<InputEntry> }>();
  return (req, res) => {
    void (async () => {
      if (!authenticated(req, token)) throw new ControlError(401, 'unauthorized', 'A valid control bearer token is required');
      if (req.headers[CONTROL_VERSION_HEADER] !== String(CONTROL_PROTOCOL_VERSION)) {
        throw new ControlError(426, 'incompatible_version', `Control protocol ${CONTROL_PROTOCOL_VERSION} is required`);
      }
      if (req.headers.origin) throw new ControlError(403, 'browser_origin_forbidden', 'Browser-origin control requests are forbidden');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (req.method === 'GET' && url.pathname === '/v1/capabilities') {
        return json(res, 200, {
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          appVersion: APP_VERSION,
          recording: deps.recording(),
          operations: ['submit', 'status', 'result', 'cancel']
        });
      }
      if (req.method === 'POST' && url.pathname === '/v1/requests') {
        if (!deps.recording()) throw new ControlError(409, 'recording_required', 'Session recording must be enabled for exact result attribution');
        const submitted = submitSchema.parse(await readBody(req));
        const input: InputArgs = {
          id: submitted.requestId,
          sessionId: submitted.sessionId ?? null,
          ...(submitted.projectId !== undefined ? { projectId: submitted.projectId } : {}),
          text: submitted.text,
          mode: 'auto',
          dueAt: Date.now(),
          model: submitted.model ?? null,
          reasoningEffort: submitted.reasoningEffort ?? null
        };
        const identity = inputIdentity(input);
        const prior = (await deps.inputs()).find(entry => entry.id === input.id);
        if (prior) {
          const original = { ...prior, mode: prior.requestedMode ?? prior.mode };
          if (inputIdentity(original) !== identity) throw new ControlError(409, 'request_id_conflict', 'The request id already belongs to different input');
          return json(res, 200, { idempotent: true, request: await controlRequestView(deps, prior) });
        }
        const active = submitting.get(input.id);
        if (active && active.identity !== identity) throw new ControlError(409, 'request_id_conflict', 'The request id already belongs to different input');
        if (!active) {
          const operation = { identity, work: deps.send(input) };
          submitting.set(input.id, operation);
          operation.work.finally(() => {
            if (submitting.get(input.id) === operation) submitting.delete(input.id);
          }).catch(() => undefined);
        }
        const entry = await submitting.get(input.id)!.work;
        return json(res, 202, { idempotent: active !== undefined, request: await controlRequestView(deps, entry) });
      }

      const match = url.pathname.match(/^\/v1\/requests\/([0-9a-f-]{36})(?:\/(cancel))?$/i);
      if (match && req.method === 'GET' && !match[2]) {
        const entry = (await deps.inputs()).find(row => row.id === match[1]);
        if (!entry) throw new ControlError(404, 'unknown_request', 'The control request does not exist');
        return json(res, 200, { request: await controlRequestView(deps, entry) });
      }
      if (match && req.method === 'POST' && match[2] === 'cancel') {
        const entry = (await deps.inputs()).find(row => row.id === match[1]);
        if (!entry) throw new ControlError(404, 'unknown_request', 'The control request does not exist');
        const accepted = await deps.cancel(entry.id);
        const current = (await deps.inputs()).find(row => row.id === entry.id) ?? entry;
        return json(res, 200, { cancelAccepted: accepted, request: await controlRequestView(deps, current) });
      }
      throw new ControlError(404, 'not_found', 'The control route does not exist');
    })().catch(error => {
      if (res.headersSent) return res.destroy();
      if (error instanceof ControlError) return json(res, error.status, { error: { code: error.code, message: error.message } });
      if (error instanceof z.ZodError) return json(res, 400, { error: { code: 'invalid_request', message: 'The request fields are invalid' } });
      return json(res, 500, { error: { code: 'internal_error', message: error instanceof Error ? error.message : 'Control request failed' } });
    });
  };
}

async function tokenAt(file: string): Promise<string> {
  try {
    const token = (await fs.readFile(file, 'utf8')).trim();
    if (!TOKEN_PATTERN.test(token)) throw new Error('The control token file is invalid');
    await fs.chmod(file, 0o600);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const token = randomBytes(32).toString('base64url');
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(`${token}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  return token;
}

export interface ControlServer {
  port: number;
  tokenFile: string;
  discoveryFile: string;
  close(): Promise<void>;
}

export async function startControlServer(userDataDir: string, deps: ControlDependencies = productionDependencies): Promise<ControlServer> {
  await fs.mkdir(userDataDir, { recursive: true });
  const tokenFile = path.join(userDataDir, 'control-token');
  const discoveryFile = path.join(userDataDir, 'control.json');
  const token = await tokenAt(tokenFile);
  const server = http.createServer(createControlHandler(deps, token));
  const sockets = new Set<Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The control server did not bind a TCP port');
  const temporary = `${discoveryFile}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({ port: address.port, protocolVersion: CONTROL_PROTOCOL_VERSION })}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, discoveryFile);
  await fs.chmod(discoveryFile, 0o600);
  let closed = false;
  return {
    port: address.port,
    tokenFile,
    discoveryFile,
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeIdleConnections?.();
      const stopped = new Promise<void>(resolve => server.close(() => resolve()));
      const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 5_000);
      timer.unref?.();
      await stopped;
      clearTimeout(timer);
      try {
        const descriptor = JSON.parse(await fs.readFile(discoveryFile, 'utf8')) as { port?: unknown };
        if (descriptor.port === address.port) await fs.unlink(discoveryFile);
      } catch { /* Missing or replaced discovery already describes another lifecycle. */ }
    }
  };
}

let external: ControlServer | null = null;
export async function startExternalControl(userDataDir: string): Promise<ControlServer> {
  external ??= await startControlServer(userDataDir);
  return external;
}
export async function shutdownExternalControl(): Promise<void> {
  const current = external;
  external = null;
  await current?.close();
}
