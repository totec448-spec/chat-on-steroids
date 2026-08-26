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
      this.listeners.set(event, (this.listeners.get(event) ?? []).filter((entry) => !entry.once));
      for (const entry of list) entry.fn(...args);
    }
  }

  const spawn = vi.fn(() => {
    const child = new Emitter() as any;
    child.pid = 9300;
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
              `${JSON.stringify({
                ok: false,
                error_code: 'SENDINPUT_FAILED',
                message: 'second action failed',
                completed_count: 1,
                failed_index: 1
              })}\n`
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
  return { spawn };
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
  terminateProcessTree: vi.fn(async () => undefined)
}));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));

import { act } from '../src/main/computer/index.js';

describe('desktop partial batch result', () => {
  it('reports exactly what ran before a helper action failed', async () => {
    await expect(
      act([
        { type: 'type', text: 'first' },
        { type: 'type', text: 'second' }
      ])
    ).rejects.toMatchObject({
      completedCount: 1,
      failedIndex: 1,
      message: expect.stringMatching(/completed_count=1 failed_index=1/)
    });
  });
});
