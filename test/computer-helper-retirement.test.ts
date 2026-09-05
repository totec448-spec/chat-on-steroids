import { afterEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  // The desktop helper process is fully mocked in this unit test. On a real macOS
  // runner the production locator still requires an existing executable before it
  // reaches mocked spawn(), so point the explicit test override at Node itself.
  // Production behavior is unchanged: packaged/dev helpers must still exist.
  process.env.COS_MACOS_DESKTOP_HELPER = process.execPath;
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

  const children: any[] = [];
  const retirementReleases: Array<() => void> = [];

  const spawn = vi.fn(() => {
    const index = children.length;
    const child = new Emitter() as any;
    child.pid = 9000 + index;
    child.exitCode = null;
    child.stdout = new Emitter();
    child.stderr = new Emitter();
    child.stdin = {
      write(_line: string, _encoding: string, callback: (error?: Error | null) => void) {
        child.writeCount = (child.writeCount ?? 0) + 1;
        callback(null);
        // The first helper deliberately hangs. A replacement helper answers normally.
        if (index > 0) {
          queueMicrotask(() => {
            child.stdout.emit(
              'data',
              Buffer.from(
                `${JSON.stringify({ ok: true, windows: [], screen: { x: 0, y: 0, width: 100, height: 100 } })}\n`
              )
            );
            child.exitCode = 0;
            child.emit('close');
          });
        }
        return true;
      },
      end() {}
    };
    children.push(child);
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });

  const terminateProcessTree = vi.fn(async (pid: number) => {
    const child = children.find((candidate) => candidate.pid === pid);
    if (pid === 9000) await new Promise<void>((resolve) => retirementReleases.push(resolve));
    if (child) {
      child.exitCode = 0;
      child.emit('close');
    }
  });

  return {
    children,
    spawn,
    terminateProcessTree,
    releaseFirstRetirement: () => retirementReleases.shift()?.(),
    reset: () => {
      for (const release of retirementReleases.splice(0)) release();
      children.splice(0);
      spawn.mockClear();
      terminateProcessTree.mockClear();
    }
  };
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
  terminateProcessTree: fake.terminateProcessTree
}));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));

// The child process is mocked, but Darwin still resolves the native host before spawn.
vi.stubEnv('COS_MACOS_DESKTOP_HELPER', process.execPath);

import { listWindows } from '../src/main/computer/index.js';

afterEach(() => {
  vi.useRealTimers();
  fake.reset();
});

describe('desktop helper retirement ordering', () => {
  it('does not reject a post-start process error until the broken helper is retired', async () => {
    let firstSettled = false;
    const first = listWindows();
    const observed = first.then(
      () => {
        firstSettled = true;
      },
      () => {
        firstSettled = true;
      }
    );
    await vi.waitFor(() => expect(fake.children[0]?.writeCount).toBe(1));
    fake.children[0]!.emit('error', new Error('pipe broke'));
    await vi.waitFor(() => expect(fake.terminateProcessTree).toHaveBeenCalledWith(9000));

    expect(firstSettled).toBe(false);
    const second = listWindows();
    await Promise.resolve();
    expect(fake.spawn).toHaveBeenCalledTimes(1);

    fake.releaseFirstRetirement();
    await expect(first).rejects.toThrow(/process error.*pipe broke/i);
    await observed;
    await expect(second).resolves.toEqual({ windows: [], screen: { x: 0, y: 0, width: 100, height: 100 } });
    expect(fake.spawn).toHaveBeenCalledTimes(2);
  });

  it('does not release the queue or spawn a replacement until a timed-out helper is dead', async () => {
    vi.useFakeTimers();

    let firstSettled = false;
    let firstError: unknown = null;
    const first = listWindows();
    const observedFirst = first.then(
      () => {
        firstSettled = true;
      },
      (error) => {
        firstSettled = true;
        firstError = error;
      }
    );
    // Window metadata has its own short deadline; the 30s watchdog remains only the
    // final boundary for unknown operations.
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.resolve();
    expect(fake.terminateProcessTree).toHaveBeenCalledWith(9000);

    expect(firstSettled).toBe(false);
    const second = listWindows();
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.spawn).toHaveBeenCalledTimes(1);

    fake.releaseFirstRetirement();
    await observedFirst;
    expect(firstError).toEqual(expect.objectContaining({ message: 'The desktop helper did not answer in time.' }));

    await expect(second).resolves.toEqual({ windows: [], screen: { x: 0, y: 0, width: 100, height: 100 } });
    expect(fake.spawn).toHaveBeenCalledTimes(2);
  });
});
