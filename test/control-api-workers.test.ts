import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
import { faultGate } from './helpers.js';
import type { ToolResult } from '../src/main/mcp/kernel.js';

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: () => '', getVersion: () => '0.0.0', getAppPath: () => process.cwd(), isPackaged: false },
  safeStorage: { isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value),
    decryptStringAsync: async (value: Buffer) => ({ result: value.toString(), shouldReEncrypt: false }) },
  BrowserWindow: class {}, clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined, openPath: async () => '' }, nativeTheme: { themeSource: 'system' }
}));

const config = await import('../src/main/config.js');
const api = await import('../src/main/control-api.js');
const broker = await import('../src/main/agents.js');
const durable = await import('../src/main/durable.js');
const { addProject } = await import('../src/main/projects.js');
const { resetWorkspaces } = await import('../src/main/workspace.js');
const { createRegistrar } = await import('../src/main/mcp/kernel.js');
const { registerCoreTools } = await import('../src/main/mcp/tools-core.js');
const { emptyEvidence, runInCallContext } = await import('../src/main/mcp/call-context.js');
const { appendEvent, createSession, initSessionStore, resetSessionStoreForTests, upsertMessageEvent } = await import('../src/main/session/store.js');
const { initSecretsPath } = await import('../src/main/secrets.js');
const ownerId = '11111111-1111-4111-8111-111111111111';
let directory: string;

beforeAll(async () => {
  directory = await makeTempDir('cos-local-workers-');
  config.initConfigPath(directory);
  initSecretsPath(directory);
  durable.initDurableStore(directory);
  initSessionStore(directory);
  api.initControlApiPath(directory);
});

beforeEach(async () => {
  await api.stopControlApi();
  broker.resetAgentsForTests();
  resetWorkspaces();
  const current = config.getConfig();
  await config.saveConfig({ ...current, controlApi: { enabled: true, allowActions: true },
    multiAgent: { ...current.multiAgent, enabled: true, allowUnattributedCalls: false, autoWorktrees: false } });
  broker.onSwarmPersistNow(snapshot => durable.writeDurableNow('swarm', snapshot));
  await api.startControlApi();
});

afterAll(async () => {
  await api.shutdownControlApi();
  broker.resetAgentsForTests();
  await durable.flushDurable();
  durable.resetDurableForTests();
  resetSessionStoreForTests();
  await removeTempDir(directory);
});

async function request(route: string, body?: unknown) {
  const endpoint = JSON.parse(await fs.readFile(path.join(directory, 'control-api', 'endpoint.json'), 'utf8'));
  const token = (await fs.readFile(path.join(directory, 'control-api', 'token'), 'utf8')).trim();
  const response = await fetch('http://127.0.0.1:' + endpoint.port + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() as any };
}

function worker(action: 'spawn' | 'status' | 'reports' | 'message' | 'ack', data: any) {
  const { ownerId, ...body } = data;
  const route = '/v1/workers/' + ownerId + (action === 'status' ? '' : '/' + action);
  return action === 'status' || action === 'reports'
    ? request(route + (body.runId ? '?runId=' + body.runId : ''))
    : request(route, body);
}

async function streamEvents(sessionId: string, from: number, count: number) {
  const endpoint = JSON.parse(await fs.readFile(path.join(directory, 'control-api', 'endpoint.json'), 'utf8'));
  const token = (await fs.readFile(path.join(directory, 'control-api', 'token'), 'utf8')).trim();
  return new Promise<any[]>((resolve, reject) => {
    const events: any[] = [];
    let buffer = '';
    const req = http.get({ hostname: '127.0.0.1', port: endpoint.port,
      path: '/v1/sessions/' + sessionId + '/events/stream?from=' + from,
      headers: { authorization: 'Bearer ' + token } }, res => {
      if (res.statusCode !== 200) { req.destroy(); reject(new Error('Unexpected HTTP ' + res.statusCode)); return; }
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buffer += chunk;
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame.split('\n').find(line => line.startsWith('data: '));
          if (!data || frame.includes('event: end')) continue;
          events.push(JSON.parse(data.slice(6)));
          if (events.length === count) { req.destroy(); resolve(events); return; }
        }
      });
    });
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('Event stream did not advance')); });
    req.on('error', reject);
  });
}

async function workerRead(runId: string, conversationId: string) {
  const registrar = createRegistrar(null, { roots: config.getConfig().roots, caps: config.effectiveCapabilities(config.getConfig()),
    readOnly: false, agentTools: false, sessionTools: false, exposedFinishTool: false }, 'core');
  let read: ((args: { paths: string[] }) => Promise<ToolResult>) | undefined;
  registrar.register = ((name, _config, callback) => { if (name === 'read') read = callback as typeof read; }) as typeof registrar.register;
  registerCoreTools(registrar);
  if (!read) throw new Error('Read tool is missing');
  return runInCallContext({ startedAt: Date.now(), transportKey: null, agent: 'worker-1', outcome: null, evidence: emptyEvidence(),
    caller: { transportKey: null, requestId: null, conversationId, sessionId: null, runId } }, () => read!({ paths: ['result.txt'] }));
}

it.each([false, true])('keeps the selected project and a repeated worker assignment when Git isolation is %s', async autoWorktrees => {
  const projectFolder = await fs.mkdtemp(path.join(directory, 'project-'));
  const otherFolder = await fs.mkdtemp(path.join(directory, 'other-'));
  const current = config.getConfig();
  await config.saveConfig({ ...current, roots: [{ name: 'approved', path: directory }],
    multiAgent: { ...current.multiAgent, autoWorktrees } });
  await fs.writeFile(path.join(projectFolder, 'result.txt'), 'Selected project content');
  await fs.writeFile(path.join(otherFolder, 'result.txt'), 'Other project content');
  if (autoWorktrees) {
    for (const args of [['init'], ['add', 'result.txt'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture']]) {
      const result = spawnSync('git', ['-C', projectFolder, ...args], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error('Git fixture failed: ' + result.stderr);
    }
  }
  const project = await addProject(projectFolder);
  const other = await addProject(otherFolder);
  const assignment = { ownerId, projectId: project.id, workers: [{ task: 'Read the selected project.' }] };
  const spawn = await worker('spawn', assignment);
  expect(spawn.status, JSON.stringify(spawn.body)).toBe(202);
  const replay = await worker('spawn', { ...assignment, runId: spawn.body.runId, projectId: other.id });
  expect(replay.status, JSON.stringify(replay.body)).toBe(202);
  expect(replay.body.workers.map((row: any) => row.id)).toEqual(['worker-1']);
  if (autoWorktrees) await fs.writeFile(path.join(projectFolder, 'result.txt'), 'Changed source content');
  broker.bindConversation('worker-1', 'project-worker', spawn.body.runId);
  const result = await workerRead(spawn.body.runId, 'project-worker');
  expect(result.isError).not.toBe(true);
  expect(result.content).toContainEqual({ type: 'text', text: expect.stringContaining('Selected project content') });
});

it('withdraws a project worker if its approved root disappears before admission commits', async () => {
  const projectFolder = await fs.mkdtemp(path.join(directory, 'revoked-project-'));
  const current = config.getConfig();
  await config.saveConfig({ ...current, roots: [{ name: 'approved', path: directory }] });
  const project = await addProject(projectFolder);
  const barrier = faultGate();
  let first = true;
  broker.onSwarmPersistNow(async snapshot => {
    if (first) { first = false; await barrier.hold(); }
    await durable.writeDurableNow('swarm', snapshot);
  });
  const pending = worker('spawn', { ownerId, projectId: project.id, workers: [{ task: 'Do not use a revoked folder.' }] });
  await barrier.entered;
  await config.saveConfig({ ...config.getConfig(), roots: [] });
  barrier.release();
  expect((await pending).status).toBeGreaterThanOrEqual(400);
  expect((await worker('status', { ownerId })).body.workers).toEqual([]);
});

it('lets a local orchestrator spawn real broker workers without a ChatGPT prime or unattributed opt-in', async () => {
  const result = await worker('spawn', { ownerId, context: 'Read-only assignment.', workers: [{ label: 'Audit', task: 'Inspect and report.' }] });
  expect(result.status, JSON.stringify(result.body)).toBe(202);
  expect(result.body.workers).toMatchObject([{ id: 'worker-1', state: 'invited' }]);
  const status = await worker('status', { ownerId, runId: result.body.runId });
  expect(status.body.workers).toMatchObject([{ id: 'worker-1', state: 'invited' }]);
  expect(status.body.freeWorkerSlots).toBe(config.getConfig().multiAgent.maxWorkers - 1);
  expect(broker.primeConversation(result.body.runId)).toBeNull();
});

it('collects exact worker reports across parking, explicitly acknowledges them, and reuses the sleeper', async () => {
  const spawn = (await worker('spawn', { ownerId, workers: [{ task: 'First assignment.' }] })).body;
  broker.bindConversation('worker-1', 'local-worker-chat', spawn.runId);
  broker.finishAgent({ conversationId: 'local-worker-chat' }, 'RESULT: first assignment complete');
  broker.releaseQuiescentRun({ allowPendingReports: true }, spawn.runId);
  const reports = (await worker('reports', { ownerId, runId: spawn.runId })).body;
  expect(reports.messages).toMatchObject([{ from: 'worker-1', text: expect.stringContaining('first assignment complete') }]);
  expect((await worker('reports', { ownerId, runId: spawn.runId })).body.messages.map((row: any) => row.id)).toEqual(reports.messages.map((row: any) => row.id));
  expect((await worker('ack', { ownerId, runId: spawn.runId, messageIds: reports.messages.map((row: any) => row.id) })).body.acknowledged).toEqual(reports.messages.map((row: any) => row.id));
  expect((await worker('reports', { ownerId, runId: spawn.runId })).body.messages).toEqual([]);
  const wake = await worker('message', { ownerId, runId: spawn.runId, messages: [{ to: 'worker-1', text: 'Second assignment.', label: 'Follow-up' }] });
  expect(wake.status, JSON.stringify(wake.body)).toBe(202);
  expect(wake.body.waking).toEqual(['worker-1']);
  expect(wake.body.runId).not.toBe(spawn.runId);
  expect((await worker('status', { ownerId, runId: wake.body.runId })).body.workers).toMatchObject([{ id: 'worker-1', state: 'waking', label: 'Follow-up' }]);
});

it('retains local ownership and unread reports through a broker restart', async () => {
  const spawn = (await worker('spawn', { ownerId, workers: [{ task: 'Complete a task.' }] })).body;
  broker.bindConversation('worker-1', 'restart-worker', spawn.runId);
  broker.finishAgent({ conversationId: 'restart-worker' }, 'RESULT: retained report');
  broker.releaseQuiescentRun({ allowPendingReports: true }, spawn.runId);
  const snapshot = broker.snapshotSwarm();
  broker.resetAgentsForTests();
  broker.restoreSwarm(snapshot);
  broker.onSwarmPersistNow(state => durable.writeDurableNow('swarm', state));
  const status = await worker('status', { ownerId, runId: spawn.runId });
  expect(status.body.workers).toMatchObject([{ id: 'worker-1', state: 'sleeping', revivable: true }]);
  expect((await worker('reports', { ownerId, runId: spawn.runId })).body.messages).toMatchObject([{ from: 'worker-1', text: expect.stringContaining('retained report') }]);
});

it('does not reoffer successfully acknowledged reports after loading the durable broker snapshot', async () => {
  const spawn = (await worker('spawn', { ownerId, workers: [{ task: 'Complete a task.' }] })).body;
  broker.bindConversation('worker-1', 'acked-worker', spawn.runId);
  broker.finishAgent({ conversationId: 'acked-worker' }, 'RESULT: consumed report');
  broker.releaseQuiescentRun({ allowPendingReports: true }, spawn.runId);
  await broker.persistCriticalSwarmNow();
  const reports = (await worker('reports', { ownerId, runId: spawn.runId })).body;
  expect((await worker('ack', { ownerId, runId: spawn.runId, messageIds: reports.messages.map((row: any) => row.id) })).status).toBe(200);
  const snapshot = await durable.readDurable<NonNullable<ReturnType<typeof broker.snapshotSwarm>>>('swarm');
  broker.resetAgentsForTests();
  broker.restoreSwarm(snapshot);
  broker.onSwarmPersistNow(state => durable.writeDurableNow('swarm', state));
  expect((await worker('reports', { ownerId, runId: spawn.runId })).body.messages).toEqual([]);
});

it('cannot use another local owner or a ChatGPT prime family through its run id', async () => {
  const otherOwner = '22222222-2222-4222-8222-222222222222';
  const own = (await worker('spawn', { ownerId, workers: [{ task: 'Owner one.' }] })).body;
  const foreign = (await worker('spawn', { ownerId: otherOwner, workers: [{ task: 'Owner two.' }] })).body;
  expect((await worker('status', { ownerId, runId: foreign.runId })).status).toBe(500);
  expect((await worker('message', { ownerId, runId: foreign.runId, messages: [{ to: 'worker-1', text: 'Wrong owner.' }] })).status).toBe(500);
  const chat = broker.spawn({ caller: { conversationId: 'chatgpt-prime' }, workers: [{ task: 'Existing ChatGPT family.' }] });
  expect((await worker('status', { ownerId, runId: chat.runId })).status).toBe(500);
  expect((await worker('status', { ownerId, runId: own.runId })).body.workers).toMatchObject([{ id: 'worker-1', state: 'invited' }]);
  expect((await worker('status', { ownerId: otherOwner, runId: foreign.runId })).body.workers).toMatchObject([{ id: 'worker-1', state: 'invited' }]);
});

it.each(['actions', 'workers'])('publishes no worker when %s are revoked during its durability barrier', async setting => {
  const barrier = faultGate();
  let first = true;
  broker.onSwarmPersistNow(async snapshot => {
    if (first) { first = false; await barrier.hold(); }
    await durable.writeDurableNow('swarm', snapshot);
  });
  const pending = worker('spawn', { ownerId, workers: [{ task: 'Should be withdrawn.' }] });
  await barrier.entered;
  const current = config.getConfig();
  await config.saveConfig({ ...current,
    controlApi: { enabled: true, allowActions: setting !== 'actions' },
    multiAgent: { ...current.multiAgent, enabled: setting !== 'workers' }
  });
  barrier.release();
  const result = await pending;
  expect(result.status).toBe(403);
  await config.saveConfig({ ...config.getConfig(), controlApi: { enabled: true, allowActions: true },
    multiAgent: { ...current.multiAgent, enabled: true }
  });
  expect((await worker('status', { ownerId })).body.workers).toEqual([]);
});

it('can resume a limited real event stream without skipping a row placed after a revised message', async () => {
  const spawn = (await worker('spawn', { ownerId, workers: [{ task: 'Report progress.' }] })).body;
  broker.bindConversation('worker-1', 'progress-worker', spawn.runId);
  const recorded = await createSession({ title: 'Worker progress', conversationId: 'progress-worker',
    origin: { kind: 'worker', fromSessionId: null, agentId: 'worker-1', task: 'Report progress.' }
  });
  const status = (await worker('status', { ownerId, runId: spawn.runId })).body;
  expect(status.workers[0].sessionId).toBe(recorded.id);
  const turnId = 'cursor-turn';
  const text = (value: string) => ({ text: value, chars: value.length, truncated: false });
  const start = await appendEvent(recorded.id, { kind: 'turn_start', source: 'extension', time: 10, turnId });
  await upsertMessageEvent(recorded.id, { kind: 'assistant_message', source: 'extension', time: 20, turnId, messageId: 'cursor-message', message: text('Working'), final: false, state: 'streaming' });
  const end = await appendEvent(recorded.id, { kind: 'turn_end', source: 'extension', time: 30, turnId, outcome: 'completed' });
  const revision = (await upsertMessageEvent(recorded.id, { kind: 'assistant_message', source: 'extension', time: 40, turnId, messageId: 'cursor-message', message: text('Finished'), final: true, state: 'final' })).event;
  const first = await streamEvents(status.workers[0].sessionId, start.seq, 2);
  expect(first.map(event => event.seq)).toEqual([start.seq, end.seq]);
  const resumed = await streamEvents(recorded.id, first.at(-1).seq + 1, 1);
  expect(resumed.map(event => event.seq)).toEqual([revision.seq]);
});

it.each(['actions', 'workers'])('refuses every worker route when %s are disabled while ordinary reads remain available', async setting => {
  const spawn = (await worker('spawn', { ownerId, workers: [{ task: 'Keep ownership.' }] })).body;
  const current = config.getConfig();
  await config.saveConfig({ ...current,
    controlApi: { enabled: true, allowActions: setting !== 'actions' },
    multiAgent: { ...current.multiAgent, enabled: setting !== 'workers' }
  });
  for (const action of ['status', 'reports', 'spawn', 'message', 'ack'] as const) {
    const response = await worker(action, { ownerId, runId: spawn.runId });
    expect(response.status, action).toBe(403);
    expect(response.body).toEqual({ error: setting === 'actions' ? 'actions_disabled' : 'workers_disabled' });
  }
  expect((await request('/v1/health')).status).toBe(200);
  expect((await request('/v1/sessions')).status).toBe(200);
});

it.each(['actions', 'workers'])('withholds worker status if %s are revoked while the read waits on durable state', async setting => {
  const spawn = (await worker('spawn', { ownerId, workers: [{ task: 'Finish and retain a report.' }] })).body;
  broker.bindConversation('worker-1', 'read-worker', spawn.runId);
  broker.finishAgent({ conversationId: 'read-worker' }, 'RESULT: retained after revocation');
  broker.releaseQuiescentRun({ allowPendingReports: true }, spawn.runId);
  const barrier = faultGate();
  broker.onSwarmPersistNow(async snapshot => {
    await barrier.hold();
    await durable.writeDurableNow('swarm', snapshot);
  });
  const pending = worker('status', { ownerId, runId: spawn.runId });
  await barrier.entered;
  const current = config.getConfig();
  await config.saveConfig({ ...current,
    controlApi: { enabled: true, allowActions: setting !== 'actions' },
    multiAgent: { ...current.multiAgent, enabled: setting !== 'workers' }
  });
  barrier.release();
  expect((await pending).status).toBe(403);
  await config.saveConfig({ ...config.getConfig(), controlApi: { enabled: true, allowActions: true },
    multiAgent: { ...current.multiAgent, enabled: true }
  });
  expect((await worker('reports', { ownerId, runId: spawn.runId })).body.messages)
    .toMatchObject([{ text: expect.stringContaining('retained after revocation') }]);
});
