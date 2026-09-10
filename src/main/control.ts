/** Authenticated loopback control for headless, user-authored ChatGPT work. */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { Socket } from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import { REASONING_EFFORTS, type SessionEvent, type SessionSummary, type StoredText } from '../shared/session.js';
import type { ConnectionStatus } from '../shared/types.js';
import type { ChatModelCatalog } from '../shared/chat-models.js';
import type { LocalProject } from '../shared/projects.js';
import { getChatModels, startChatModelDiscovery } from './chat-models.js';
import { connect, getStatus } from './connection.js';
import { getConfig } from './config.js';
import { listProjects } from './projects.js';
import { cancelDesktopInput, sendDesktopInput } from './session/start-input.js';
import { controlInputFingerprint, listInputs, type InputArgs, type InputEntry } from './session/input.js';
import { getSession, listSessionPage, readOverflowText, readRecentEvents, type SessionListCursor } from './session/store.js';
import { stopSessionTurn } from './bridge.js';
import { APP_VERSION } from './version.js';

export const CONTROL_PROTOCOL_VERSION = 1;
export const CONTROL_VERSION_HEADER = 'x-cos-control-version';
const MAX_BODY_BYTES = 64 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_ID = z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i);
const REQUEST_ID = z.string().uuid();
const submitSchema = z.object({
  requestId: REQUEST_ID,
  submittedAt: z.number().int().nonnegative(),
  sessionId: SESSION_ID.nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  text: z.string().trim().min(1).max(16_000),
  model: z.string().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/),
  reasoningEffort: z.enum(REASONING_EFFORTS)
}).strict();

export type ControlRequestState = 'queued' | 'delivering' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface ControlRequestView {
  requestId: string;
  sessionId: string | null;
  state: ControlRequestState;
  requestedSelection: { model: string; reasoningEffort: InputArgs['reasoningEffort'] };
  verifiedSelection: { model: string; reasoningEffort: InputArgs['reasoningEffort']; observedAt: number } | null;
  createdAt: number;
  deliveredAt: number | null;
  error?: string;
  result?: { text: string; chars: number; truncated: boolean };
}

export interface ControlDependencies {
  send(input: InputArgs): Promise<InputEntry>;
  cancel(id: string): Promise<boolean>;
  inputs(): Promise<InputEntry[]>;
  models(): ChatModelCatalog;
  refreshModels(): Promise<ChatModelCatalog>;
  projects(): Promise<LocalProject[]>;
  session(id: string): Promise<SessionSummary | null>;
  sessions(options: { limit?: number; cursor?: SessionListCursor }): Promise<{ sessions: SessionSummary[]; total: number; nextCursor: SessionListCursor | null }>;
  events(id: string): Promise<SessionEvent[]>;
  overflow(id: string, assetId: string): Promise<string | null>;
  stop(id: string, turnId: string): Promise<unknown>;
  recording(): boolean;
  roots(): Array<{ name: string; path: string }>;
  connection(): ConnectionStatus;
  connect(): Promise<void>;
}

const productionDependencies: ControlDependencies = {
  send: input => sendDesktopInput(input, { backgroundDelivery: true }),
  cancel: cancelDesktopInput,
  inputs: listInputs,
  models: getChatModels,
  // An explicit refresh may need the companion to start. The discovery wake
  // uses the app's background startup path and never submits a conversation.
  refreshModels: () => startChatModelDiscovery(true, true),
  projects: listProjects,
  session: getSession,
  sessions: listSessionPage,
  events: id => readRecentEvents(id, 512, { kinds: ['user_message', 'assistant_message', 'turn_start', 'turn_end', 'chat_error'] }),
  overflow: readOverflowText,
  stop: stopSessionTurn,
  recording: () => getConfig().sessions.record,
  roots: () => getConfig().roots.map(root => ({ name: root.name, path: root.path })),
  connection: getStatus,
  connect
};

function sameInput(entry: InputEntry, input: InputArgs): boolean {
  return entry.backgroundDelivery === true && entry.controlFingerprint === controlInputFingerprint(input);
}

function targetSessionId(entry: InputEntry): string | null {
  return entry.sessionId ?? entry.deliveredSessionId ?? null;
}

/** Return the live generation only when it follows this exact controller input and no later user input. */
async function exactActiveRequestTurn(
  deps: ControlDependencies,
  entry: InputEntry,
  summary: SessionSummary
): Promise<string | null> {
  if (entry.deliveredAt === undefined || !summary.activeTurnId) return null;
  const events = await deps.events(summary.id);
  const authored = events.findIndex(event => event.kind === 'user_message' && event.inputId === entry.id);
  if (authored < 0) return null;
  const nextUser = events.findIndex((event, index) => index > authored && event.kind === 'user_message');
  const span = events.slice(authored + 1, nextUser < 0 ? undefined : nextUser);
  return span.some(event => event.kind === 'turn_start' && event.turnId === summary.activeTurnId)
    ? summary.activeTurnId : null;
}

async function exactText(deps: ControlDependencies, sessionId: string, stored: StoredText): Promise<{ text: string; chars: number; truncated: boolean }> {
  if (!stored.truncated || !stored.assetId) return { text: stored.text, chars: stored.chars, truncated: stored.truncated };
  const full = await deps.overflow(sessionId, stored.assetId);
  if (full === null) return { text: stored.text, chars: stored.chars, truncated: true };
  const text = full.length <= 1_000_000 ? full : full.slice(0, 1_000_000);
  return { text, chars: stored.chars, truncated: text.length !== stored.chars };
}

export async function controlRequestView(deps: ControlDependencies, entry: InputEntry): Promise<ControlRequestView> {
  const sessionId = targetSessionId(entry);
  // SessionSummary.selectedModel is only the newest picker observation for the
  // conversation. A later follow-up must not rewrite an older request's proof.
  const events = sessionId && entry.deliveredAt !== undefined ? await deps.events(sessionId) : [];
  const authored = events.findIndex(event => event.kind === 'user_message' && event.inputId === entry.id);
  const authoredEvent = authored >= 0 ? events[authored] : undefined;
  // recordDeliveredInput adds these fields only after the native composer ACK. The
  // canonical user-message merge preserves them across later sparse page echoes.
  const verifiedSelection = authoredEvent?.kind === 'user_message' && authoredEvent.inputDelivery === 'confirmed' &&
    authoredEvent.model === entry.model && (authoredEvent.reasoningEffort ?? null) === entry.reasoningEffort
    ? { model: authoredEvent.model, reasoningEffort: authoredEvent.reasoningEffort ?? null, observedAt: entry.deliveredAt! } : null;
  const base: ControlRequestView = {
    requestId: entry.id,
    sessionId,
    state: entry.state === 'queued' ? 'queued' : entry.state === 'browser' ? 'delivering' : entry.state === 'failed' ? 'failed' : entry.state === 'cancelled' ? 'cancelled' : 'running',
    requestedSelection: { model: entry.model!, reasoningEffort: entry.reasoningEffort },
    verifiedSelection,
    createdAt: entry.createdAt,
    deliveredAt: entry.deliveredAt ?? null,
    ...(entry.error ? { error: entry.error } : {})
  };
  if (entry.state !== 'sent' || !sessionId) return base;
  if (authored < 0) return base;
  const nextUser = events.findIndex((event, index) => index > authored && event.kind === 'user_message');
  const span = events.slice(authored + 1, nextUser < 0 ? undefined : nextUser);
  // The exact outbox row is the request boundary; when the recorder also captured the
  // generation start, use that stronger identity to reject terminal evidence from a stale
  // or overlapping turn in the same browser observation window. User-message ids and
  // generation ids are different provider identities, so the start after the user row is
  // the join rather than the user row's own turnId.
  const generationIds = new Set(span.flatMap(event => event.kind === 'turn_start' && event.turnId ? [event.turnId] : []));
  const belongsToGeneration = (event: SessionEvent): boolean =>
    generationIds.size === 0 || !event.turnId || generationIds.has(event.turnId);
  const final = span.find(event => event.kind === 'assistant_message' && belongsToGeneration(event) &&
    (event.final === true || event.state === 'final'));
  if (final?.kind === 'assistant_message' && verifiedSelection) {
    return { ...base, state: 'completed', result: await exactText(deps, sessionId, final.message) };
  }
  const ended = span.findLast(event => event.kind === 'turn_end' && belongsToGeneration(event));
  if (ended?.kind === 'turn_end' && ended.outcome !== 'completed') {
    return { ...base, state: 'failed', error: ended.detail || `ChatGPT turn ended ${ended.outcome}` };
  }
  return base;
}

function publicSession(summary: SessionSummary): Pick<SessionSummary, 'id' | 'title' | 'projectId' | 'conversationId' | 'selectedModel' | 'activeTurnId' | 'lastTurnOutcome' | 'startedAt' | 'updatedAt' | 'endedAt'> {
  return {
    id: summary.id, title: summary.title, projectId: summary.projectId,
    conversationId: summary.conversationId, selectedModel: summary.selectedModel,
    activeTurnId: summary.activeTurnId, lastTurnOutcome: summary.lastTurnOutcome,
    startedAt: summary.startedAt, updatedAt: summary.updatedAt, endedAt: summary.endedAt
  };
}

function encodeCursor(cursor: SessionListCursor | null): string | null {
  return cursor ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null;
}
function decodeCursor(value: string | null): SessionListCursor | undefined {
  if (!value) return undefined;
  try {
    return z.object({ updatedAt: z.number().int().nonnegative(), id: SESSION_ID }).strict().parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    throw new ControlError(400, 'invalid_cursor', 'The session cursor is invalid');
  }
}

class ControlError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length, 'cache-control': 'no-store' });
  res.end(bytes);
}

async function body(req: http.IncomingMessage): Promise<unknown> {
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

function authenticate(req: http.IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function createControlHandler(deps: ControlDependencies, token: string): http.RequestListener {
  const submitting = new Map<string, { fingerprint: string; work: Promise<InputEntry> }>();
  return (req, res) => {
    void (async () => {
      if (!authenticate(req, token)) throw new ControlError(401, 'unauthorized', 'A valid control bearer token is required');
      if (req.headers[CONTROL_VERSION_HEADER] !== String(CONTROL_PROTOCOL_VERSION)) {
        throw new ControlError(426, 'incompatible_version', `Control protocol ${CONTROL_PROTOCOL_VERSION} is required`);
      }
      if (req.headers.origin) throw new ControlError(403, 'browser_origin_forbidden', 'Browser-origin control requests are forbidden');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/v1/capabilities') {
        return json(res, 200, { protocolVersion: CONTROL_PROTOCOL_VERSION, appVersion: APP_VERSION, recording: deps.recording(), roots: deps.roots(),
          backgroundDelivery: 'required', exactModelSelection: 'required', statuses: ['queued', 'delivering', 'running', 'completed', 'failed', 'cancelled'],
          operations: ['connection', 'connect', 'models', 'model-refresh', 'projects', 'sessions', 'submit', 'status', 'result', 'cancel'] });
      }
      if (req.method === 'GET' && url.pathname === '/v1/connection') return json(res, 200, { connection: deps.connection() });
      if (req.method === 'POST' && url.pathname === '/v1/connection/connect') {
        await deps.connect();
        return json(res, 200, { connection: deps.connection() });
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') return json(res, 200, deps.models());
      if (req.method === 'POST' && url.pathname === '/v1/models/refresh') {
        const models = await deps.refreshModels();
        return json(res, models.state === 'pending' ? 202 : 200, models);
      }
      if (req.method === 'GET' && url.pathname === '/v1/projects') {
        const projects = await deps.projects();
        return json(res, 200, { projects });
      }
      if (req.method === 'GET' && url.pathname === '/v1/sessions') {
        const limit = z.coerce.number().int().min(1).max(60).default(60).parse(url.searchParams.get('limit') ?? undefined);
        const page = await deps.sessions({ limit, cursor: decodeCursor(url.searchParams.get('cursor')) });
        return json(res, 200, { sessions: page.sessions.map(publicSession), total: page.total, nextCursor: encodeCursor(page.nextCursor) });
      }
      const sessionMatch = url.pathname.match(/^\/v1\/sessions\/([0-9a-z-]{8,64})$/i);
      if (req.method === 'GET' && sessionMatch) {
        const summary = await deps.session(sessionMatch[1]!);
        if (!summary) throw new ControlError(404, 'unknown_session', 'The session does not exist');
        return json(res, 200, { session: publicSession(summary) });
      }
      if (req.method === 'POST' && url.pathname === '/v1/requests') {
        if (!deps.recording()) throw new ControlError(409, 'recording_required', 'Session recording must be enabled for result attribution');
        const submitted = submitSchema.parse(await body(req));
        const input: InputArgs = { id: submitted.requestId, sessionId: submitted.sessionId ?? null,
          ...(submitted.projectId !== undefined ? { projectId: submitted.projectId } : {}), text: submitted.text,
          mode: 'auto', dueAt: submitted.submittedAt, model: submitted.model, reasoningEffort: submitted.reasoningEffort };
        const prior = (await deps.inputs()).find(entry => entry.id === submitted.requestId);
        if (prior) {
          if (!sameInput(prior, input)) throw new ControlError(409, 'request_id_conflict', 'The request id already belongs to different input');
          return json(res, 200, { idempotent: true, request: await controlRequestView(deps, prior) });
        }
        const now = Date.now();
        if (submitted.submittedAt < now - 24 * 60 * 60_000 || submitted.submittedAt > now + 1_000) {
          throw new ControlError(410, 'request_expired', 'submittedAt must be within the current 24-hour idempotency window');
        }
        const fingerprint = JSON.stringify(input);
        const active = submitting.get(submitted.requestId);
        if (active && active.fingerprint !== fingerprint) throw new ControlError(409, 'request_id_conflict', 'The request id already belongs to different input');
        if (!active) {
          const catalog = deps.models();
          if (catalog.state !== 'ready') throw new ControlError(409, 'models_not_ready', 'Refresh models and wait for a ready catalog before submitting');
          const model = catalog.models.find(candidate => candidate.id === submitted.model);
          if (!model || !model.efforts.includes(submitted.reasoningEffort)) {
            throw new ControlError(422, 'unsupported_model_selection', 'The exact model and reasoning effort are not available');
          }
          const operation = { fingerprint, work: deps.send(input) };
          submitting.set(submitted.requestId, operation);
          operation.work.finally(() => { if (submitting.get(submitted.requestId) === operation) submitting.delete(submitted.requestId); }).catch(() => undefined);
        }
        const entry = await submitting.get(submitted.requestId)!.work;
        return json(res, 202, { idempotent: active !== undefined, request: await controlRequestView(deps, entry) });
      }
      const requestMatch = url.pathname.match(/^\/v1\/requests\/([0-9a-f-]{36})(?:\/(cancel))?$/i);
      if (requestMatch && req.method === 'GET' && !requestMatch[2]) {
        const entry = (await deps.inputs()).find(row => row.id === requestMatch[1]);
        if (!entry || entry.backgroundDelivery !== true) throw new ControlError(404, 'unknown_request', 'The control request does not exist');
        return json(res, 200, { request: await controlRequestView(deps, entry) });
      }
      if (requestMatch && req.method === 'POST' && requestMatch[2] === 'cancel') {
        const entry = (await deps.inputs()).find(row => row.id === requestMatch[1]);
        if (!entry || entry.backgroundDelivery !== true) throw new ControlError(404, 'unknown_request', 'The control request does not exist');
        let accepted = await deps.cancel(entry.id);
        if (!accepted && entry.state === 'sent') {
          const sessionId = targetSessionId(entry);
          const summary = sessionId ? await deps.session(sessionId) : null;
          const turnId = sessionId && summary ? await exactActiveRequestTurn(deps, entry, summary) : null;
          if (sessionId && turnId) { await deps.stop(sessionId, turnId); accepted = true; }
        }
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
  try { await handle.writeFile(token + '\n', 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await fs.chmod(file, 0o600);
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
  const descriptor = { port: address.port, protocolVersion: CONTROL_PROTOCOL_VERSION };
  const temporary = `${discoveryFile}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(descriptor) + '\n', { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, discoveryFile);
  await fs.chmod(discoveryFile, 0o600);
  let closed = false;
  return {
    port: address.port, tokenFile, discoveryFile,
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
        const current = JSON.parse(await fs.readFile(discoveryFile, 'utf8')) as { port?: unknown };
        if (current.port === address.port) await fs.unlink(discoveryFile);
      } catch { /* stale/missing discovery is already closed */ }
    }
  };
}

let external: ControlServer | null = null;
export async function startExternalControl(userDataDir: string): Promise<ControlServer> {
  if (!external) external = await startControlServer(userDataDir);
  return external;
}
export async function shutdownExternalControl(): Promise<void> {
  const current = external;
  external = null;
  await current?.close();
}
