import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { isReasoningEffort, type ReasoningEffort } from '../shared/session.js';
import {
  ensureExternalWorker,
  inspectExternalDelivery,
  inspectExternalWorker,
  persistCriticalExternalControllerNow,
  publishExternalController,
  sendExternalWorkerMessage
} from './external-controller.js';
import { logInfo, logWarn } from './logger.js';

const CAPABILITY_FILE = 'external-controller.json';
const MAX_BODY_BYTES = 64 * 1024;

export interface ExternalControllerServer {
  port: number;
  token: string;
  capabilityPath: string;
  close: () => Promise<void>;
}

class ControllerUnavailableError extends Error {}

function safeEqual(a: string, b: string): boolean {
  const one = Buffer.from(a, 'utf8');
  const two = Buffer.from(b, 'utf8');
  return one.length === two.length && timingSafeEqual(one, two);
}

function reply(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(payload);
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk) => {
      const data = Buffer.from(chunk);
      size += data.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(data);
    });
    req.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON body must be an object');
        resolve(parsed as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value;
}

function nullableStringField(body: Record<string, unknown>, key: string): string | null | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`${key} must be a string or null`);
  return value;
}

function reasoningEffortField(body: Record<string, unknown>): ReasoningEffort | null | undefined {
  const value = nullableStringField(body, 'reasoningEffort');
  if (value === undefined || value === null) return value;
  if (!isReasoningEffort(value)) throw new Error('reasoningEffort is not a supported reasoning level');
  return value;
}

function isAuthorised(req: http.IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') && safeEqual(header.slice(7), token);
}

async function publishDurably(): Promise<void> {
  if (!await persistCriticalExternalControllerNow()) {
    throw new ControllerUnavailableError('external controller could not durably accept the operation');
  }
  publishExternalController();
}

async function writeCapabilityFile(userDataDir: string, port: number, token: string): Promise<string> {
  const capabilityPath = path.join(userDataDir, CAPABILITY_FILE);
  const temp = `${capabilityPath}.tmp`;
  const payload = JSON.stringify({ version: 1, url: `http://127.0.0.1:${port}`, token }, null, 2) + '\n';
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.writeFile(temp, payload, { mode: 0o600 });
  await fs.rename(temp, capabilityPath);
  if (process.platform !== 'win32') await fs.chmod(capabilityPath, 0o600);
  return capabilityPath;
}

export async function startExternalControllerServer(userDataDir: string): Promise<ExternalControllerServer> {
  const token = randomBytes(32).toString('base64url');
  const server = http.createServer(async (req, res) => {
    if (req.headers.origin !== undefined) {
      reply(res, 403, { error: 'browser_origins_forbidden' });
      return;
    }
    if (!isAuthorised(req, token)) {
      reply(res, 401, { error: 'unauthorized' });
      return;
    }
    if (req.method !== 'POST') {
      reply(res, 405, { error: 'method_not_allowed' });
      return;
    }

    try {
      const body = await readJson(req);
      switch (req.url) {
        case '/v1/workers/ensure': {
          const status = ensureExternalWorker({
            controllerId: stringField(body, 'controllerId'),
            workerKey: stringField(body, 'workerKey'),
            operationId: stringField(body, 'operationId'),
            task: stringField(body, 'task'),
            model: nullableStringField(body, 'model'),
            reasoningEffort: reasoningEffortField(body)
          });
          await publishDurably();
          reply(res, 200, status);
          return;
        }
        case '/v1/workers/inspect': {
          const status = inspectExternalWorker({
            controllerId: stringField(body, 'controllerId'),
            workerKey: stringField(body, 'workerKey')
          });
          reply(res, status ? 200 : 404, status ?? { error: 'worker_not_found' });
          return;
        }
        case '/v1/workers/send': {
          const delivery = sendExternalWorkerMessage({
            controllerId: stringField(body, 'controllerId'),
            workerKey: stringField(body, 'workerKey'),
            operationId: stringField(body, 'operationId'),
            text: stringField(body, 'text')
          });
          await publishDurably();
          reply(res, 200, delivery);
          return;
        }
        case '/v1/deliveries/inspect': {
          const delivery = inspectExternalDelivery({
            controllerId: stringField(body, 'controllerId'),
            operationId: stringField(body, 'operationId')
          });
          reply(res, delivery ? 200 : 404, delivery ?? { error: 'delivery_not_found' });
          return;
        }
        default:
          reply(res, 404, { error: 'not_found' });
      }
    } catch (error) {
      const unavailable = error instanceof ControllerUnavailableError;
      reply(res, unavailable ? 503 : 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('external controller failed to bind a loopback TCP port');
  }
  const capabilityPath = await writeCapabilityFile(userDataDir, address.port, token);
  logInfo(`external controller listening on 127.0.0.1:${address.port}`);

  let closed = false;
  return {
    port: address.port,
    token,
    capabilityPath,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        const saved = JSON.parse(await fs.readFile(capabilityPath, 'utf8')) as { token?: unknown };
        if (saved.token === token) await fs.rm(capabilityPath, { force: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') logWarn(`external controller capability cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
}
