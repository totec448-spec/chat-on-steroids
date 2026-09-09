import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';

const { onExternalControllerPersistNow, resetExternalControllerForTests } = await import('../src/main/external-controller.js');
const { startExternalControllerServer } = await import('../src/main/external-controller-server.js');

let dir = '';
let close: (() => Promise<void>) | null = null;

beforeEach(async () => {
  resetExternalControllerForTests();
  onExternalControllerPersistNow(async () => undefined);
  dir = await makeTempDir('clf-external-controller-');
});

afterEach(async () => {
  await close?.();
  close = null;
  await removeTempDir(dir);
});

function request(port: number, token: string | null, pathname: string, body: unknown, origin?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(origin ? { origin } : {})
      }
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

describe('external controller loopback server', () => {
  it('publishes a mode-0600 capability file and requires its independent bearer token', async () => {
    const server = await startExternalControllerServer(dir);
    close = server.close;
    const capabilityPath = path.join(dir, 'external-controller.json');
    const stat = await fs.stat(capabilityPath);
    const capability = JSON.parse(await fs.readFile(capabilityPath, 'utf8'));

    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600);
    expect(capability.url).toBe(`http://127.0.0.1:${server.port}`);
    expect(capability.token).toBe(server.token);

    const denied = await request(server.port, null, '/v1/workers/ensure', {
      controllerId: 'codex', workerKey: 'frontend', operationId: 'ensure-1', task: 'A'
    });
    expect(denied.status).toBe(401);

    const accepted = await request(server.port, server.token, '/v1/workers/ensure', {
      controllerId: 'codex', workerKey: 'frontend', operationId: 'ensure-1', task: 'A'
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.workerKey).toBe('frontend');
  });

  it('rejects browser-origin requests even when they somehow know the token', async () => {
    const server = await startExternalControllerServer(dir);
    close = server.close;
    const response = await request(server.port, server.token, '/v1/workers/ensure', {
      controllerId: 'codex', workerKey: 'frontend', operationId: 'ensure-1', task: 'A'
    }, 'https://chatgpt.com');
    expect(response.status).toBe(403);
  });

  it('supports inspect without making worker identity depend on a conversation id', async () => {
    const server = await startExternalControllerServer(dir);
    close = server.close;
    await request(server.port, server.token, '/v1/workers/ensure', {
      controllerId: 'codex', workerKey: 'frontend', operationId: 'ensure-1', task: 'A'
    });
    const response = await request(server.port, server.token, '/v1/workers/inspect', {
      controllerId: 'codex', workerKey: 'frontend'
    });
    expect(response.status).toBe(200);
    expect(response.body.controllerId).toBe('codex');
    expect(response.body.workerKey).toBe('frontend');
    expect(response.body.providerWorkerId).toBeTruthy();
  });
});
