import { beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// The window's read-only views of agent commands (#1920): only this chat's own running command opens.
const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<any>>();
vi.mock('electron', () => ({ app: { on: vi.fn() }, ipcMain: { handle: (name: string, handler: any) => handlers.set(name, handler) } }));
const running = vi.hoisted(() => ({ rows: [] as Array<{ processId: number; incarnation: number }> }));
vi.mock('../src/main/codex/ownership.js', () => ({ runningExecProcesses: () => running.rows }));
const watched = vi.hoisted(() => ({ calls: 0, unsubscribed: 0, chunk: null as null | ((b: Buffer) => void), exit: null as null | ((c: any) => void) }));
vi.mock('../src/main/codex/manager.js', () => ({ unifiedExecManager: { watchOutput: (_id: number, _inc: number, chunk: any, exit: any) => {
  watched.calls++; watched.chunk = chunk; watched.exit = exit;
  return { history: Buffer.from('so far\n'), startedAt: 0, unsubscribe: () => { watched.unsubscribed++; } };
} } }));
const shieldRead = vi.hoisted(() => ({ wait: null as null | Promise<void> }));
vi.mock('../src/main/projects.js', () => ({ sessionSecretsShieldOff: async () => { await shieldRead.wait; return false; } }));
const { getLog } = await import('../src/main/logger.js');
const { registerAgentOutputIpc } = await import('../src/main/agent-output-ipc.js');

const sent: unknown[] = [];
const webContents = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: (_channel: string, value: unknown) => sent.push(value), mainFrame: {} });
const window = { isDestroyed: () => false, webContents };
registerAgentOutputIpc(() => window as never);
const call = (payload: unknown) => handlers.get('agentOutput:request')!({ sender: webContents, senderFrame: webContents.mainFrame }, payload);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const open = (n: number, processId = 4001) => call({ action: 'open', id: id(n), sessionId: 'session-one', processId, incarnation: 1 });

beforeEach(async () => {
  for (let n = 0; n < 20; n++) await call({ action: 'close', id: id(n) });
  sent.length = 0; watched.calls = 0; watched.unsubscribed = 0; running.rows = [{ processId: 4001, incarnation: 1 }];
});

it("opens only a command this chat's session is running, and shows its output so far", async () => {
  expect(await call({ action: 'open', id: id(1), sessionId: 'session-one', processId: 4001, incarnation: 2 }))
    .toEqual({ ok: false, error: 'This command is no longer running' });
  expect(await open(1, 4002)).toEqual({ ok: false, error: 'This command is no longer running' });
  expect(watched.calls).toBe(0);
  expect(await open(1)).toEqual({ ok: true, data: true });
  expect(sent).toEqual([{ id: id(1), data: 'so far\n' }]);
  // Opening the same view again watches nothing twice.
  expect(await open(1)).toEqual({ ok: true, data: true });
  expect(watched.calls).toBe(1);
});

it('says how the command ended, and closing the tab stops watching without touching the command', async () => {
  await open(2);
  watched.chunk!(Buffer.from('last line'));
  watched.exit!({ exitCode: 1, durationMs: 61_000 });
  expect(sent.slice(1)).toEqual([{ id: id(2), data: 'last line' }, { id: id(2), exit: { exitCode: 1, seconds: 61 } }]);
  await call({ action: 'close', id: id(2) });
  expect(watched.unsubscribed).toBe(1);
});

it('keeps at most eight views open, and a reload of the window closes them all', async () => {
  for (let n = 0; n < 8; n++) expect((await open(n)).ok).toBe(true);
  expect(await open(9)).toEqual({ ok: false, error: 'Close an agent output tab first' });
  webContents.emit('did-start-loading');
  expect(watched.unsubscribed).toBe(8);
});

// CodeRabbit on #2052: a tab closed while its open request still waits leaves nothing behind.
it('watches nothing for a tab closed while its open request was still waiting', async () => {
  let release!: () => void;
  shieldRead.wait = new Promise(resolve => { release = resolve; });
  const opening = open(3);
  await call({ action: 'close', id: id(3) });
  release();
  expect((await opening).ok).toBe(true);
  shieldRead.wait = null;
  expect(watched.calls).toBe(0);
  // Its slot is free again: eight other views still open.
  for (let n = 10; n < 18; n++) expect((await open(n)).ok).toBe(true);
});

it('says in the log why it refused, without the request itself', async () => {
  const refusals = () => getLog().filter(entry => entry.message.startsWith('agent output: refused')).map(entry => entry.message);
  const before = refusals().length;
  expect((await call({ action: 'open', id: 'not-a-uuid', sessionId: 'secret-session-name', processId: 4001, incarnation: 1 })).ok).toBe(false);
  expect((await open(4, 4002)).ok).toBe(false);
  const lines = refusals().slice(before);
  expect(lines).toEqual(['agent output: refused a request: it was not a valid request', 'agent output: refused to open a view: the command is no longer running']);
  expect(lines.join('\n')).not.toContain('secret-session-name');
});
