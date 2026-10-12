import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';

type Handler = (event: { sender: EventEmitter }, payload?: unknown) => Promise<unknown>;
const mock = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  appOnce: vi.fn(),
  spawn: vi.fn()
}));

vi.mock('electron', () => ({
  app: { once: mock.appOnce },
  ipcMain: { handle: (channel: string, handler: Handler) => mock.handlers.set(channel, handler) }
}));
vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: mock.spawn
}));

const { registerDictationIpc } = await import('../src/main/dictation.js');
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

function startTestSession() {
  const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() });
  const window = { isDestroyed: () => false, webContents: sender };
  const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const stderr = { resume: vi.fn() };
  const child = Object.assign(new EventEmitter(), { stdout, stderr, kill: vi.fn(() => true) });
  mock.spawn.mockReturnValue(child);
  registerDictationIpc(() => window as never);
  const quit = mock.appOnce.mock.calls.find(([name]) => name === 'before-quit')?.[1];
  expect(quit).toBeTypeOf('function');
  return { sender, child, quit: quit as () => void };
}

beforeEach(() => {
  mock.handlers.clear();
  mock.appOnce.mockReset();
  mock.spawn.mockReset();
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', platformDescriptor);
});

describe('Windows dictation child lifetime', () => {
  it('kills an active recognizer synchronously on before-quit', async () => {
    const { sender, child, quit } = startTestSession();
    expect(await mock.handlers.get('dictation:start')!({ sender })).toMatchObject({ ok: true });
    expect(child.kill).not.toHaveBeenCalled();

    quit();
    // Nothing waits for an unref'ed timeout: the kill was issued in the quit callback.
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('cancels a user Stop grace timer and kills immediately if quit follows it', async () => {
    vi.useFakeTimers();
    const { sender, child, quit } = startTestSession();
    await mock.handlers.get('dictation:start')!({ sender });
    expect(await mock.handlers.get('dictation:stop')!({ sender })).toMatchObject({ ok: true });
    expect(child.kill).not.toHaveBeenCalled();
    quit();
    expect(child.kill).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(700);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('passes the actual app PID to PowerShell and monitors it during recognition', async () => {
    const { sender } = startTestSession();
    await mock.handlers.get('dictation:start')!({ sender });
    const [command, args] = mock.spawn.mock.calls[0] as [string, string[]];
    expect(command).toBe('powershell.exe');
    const encoded = args[args.indexOf('-EncodedCommand') + 1];
    expect(encoded).toBeTypeOf('string');
    const script = Buffer.from(encoded!, 'base64').toString('utf16le');
    expect(script).toContain('$cosParentPid = ' + process.pid);
    expect(script).not.toContain('__COS_PARENT_PID__');
    expect(script).toMatch(/while\(\$true\) \{\s*\$item = Wait-Event -Timeout 1\s*if\(-not \(Get-Process -Id \$cosParentPid -ErrorAction SilentlyContinue\)\) \{ break \}/);
  });

  it.runIf(process.platform === 'win32')('PowerShell exits when its watched parent disappears (no microphone)', () => {
    execFileSync(process.execPath, ['scripts/fixtures/smoke-dictation-parent-windows.cjs'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 15_000
    });
  }, 20_000);
});
