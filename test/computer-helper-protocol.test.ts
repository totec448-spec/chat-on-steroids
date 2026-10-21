import { describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  type Listener = { fn: (...args: any[]) => void; once: boolean };
  class Emitter {
    private readonly listeners = new Map<string, Listener[]>();
    on(event: string, fn: (...args: any[]) => void) {
      const list = this.listeners.get(event) ?? [];
      list.push({ fn, once: false });
      this.listeners.set(event, list);
      return this;
    }
    once(event: string, fn: (...args: any[]) => void) {
      const list = this.listeners.get(event) ?? [];
      list.push({ fn, once: true });
      this.listeners.set(event, list);
      return this;
    }
    emit(event: string, ...args: any[]) {
      const list = [...(this.listeners.get(event) ?? [])];
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((entry) => !entry.once)
      );
      for (const entry of list) entry.fn(...args);
    }
  }

  let child: any;
  const state = { reply: { ok: 'not-a-boolean', windows: [], screen: { x: 0, y: 0, width: 100, height: 100 } } as Record<string, unknown> };
  const spawn = vi.fn(() => {
    child = new Emitter() as any;
    child.pid = 9100;
    child.exitCode = null;
    child.stdout = new Emitter();
    child.stderr = new Emitter();
    child.stdin = {
      write(_line: string, _encoding: string, callback: (error?: Error | null) => void) {
        callback(null);
        queueMicrotask(() =>
          child.stdout.emit(
            'data',
            Buffer.from(
              `${JSON.stringify(state.reply)}\n`
            )
          )
        );
        return true;
      },
      end() {}
    };
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  const terminateProcessTree = vi.fn(async () => {
    child.exitCode = 0;
    child.emit('close');
  });
  return { spawn, terminateProcessTree, state };
});

vi.mock('node:child_process', () => ({ spawn: fake.spawn }));
vi.mock('../src/main/env.js', () => ({
  ensureUsablePath: vi.fn(),
  normalizeEnvironment: (env: NodeJS.ProcessEnv) => ({ ...env }),
  setEnvValue: (env: NodeJS.ProcessEnv, key: string, value: string) => {
    env[key] = value;
  }
}));
vi.mock('../src/main/exec.js', () => ({
  findWindowsPowerShell: () => 'powershell.exe',
  terminateProcessTree: fake.terminateProcessTree,
  // Windows ends the helper alone; the same fake counts either way.
  terminateProcess: fake.terminateProcessTree
}));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));

// The child process is mocked, but Darwin still resolves the native host before spawn.
// Point that resolver at a real executable so this test remains about protocol handling.
vi.stubEnv('COS_MACOS_DESKTOP_HELPER', process.execPath);

import { helperTimeoutMs, listWindows } from '../src/main/computer/index.js';
import { logInfo } from '../src/main/logger.js';

describe('desktop helper protocol validation', () => {
  it('budgets a macOS act request for cumulative focus polling', () => {
    const actions = Array.from({ length: 20 }, (_, index) => ({ type: 'focus', window: index + 1 }));
    expect(helperTimeoutMs({ op: 'act', actions }, 'darwin')).toBe(57_000);
    expect(helperTimeoutMs({ op: 'act', actions }, 'win32')).toBe(15_000);
  });

  it('rejects syntactically valid JSON that is not a protocol response', async () => {
    await expect(listWindows()).rejects.toThrow(/malformed protocol response/i);
    expect(fake.terminateProcessTree).toHaveBeenCalledTimes(1);
  });

  it('logs what the helper reports about a focus retry, bounded and only as text', async () => {
    fake.state.reply = { ok: true, windows: [], screen: { x: 0, y: 0, width: 100, height: 100 },
      focusNotes: ['window 5 came forward only after an input nudge', 42, 'x'.repeat(500)] };
    await expect(listWindows()).resolves.toMatchObject({ windows: [] });
    const lines = vi.mocked(logInfo).mock.calls.map(([line]) => String(line)).filter(line => line.startsWith('desktop focus:'));
    expect(lines[0]).toBe('desktop focus: window 5 came forward only after an input nudge');
    expect(lines).toHaveLength(2);
    expect(lines[1]!.length).toBeLessThanOrEqual(215);
  });
});
