import { describe, expect, it, vi } from 'vitest';

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
  const requests: any[] = [];
  const spawn = vi.fn(() => {
    const index = children.length;
    const child = new Emitter() as any;
    child.pid = 9200 + index;
    child.exitCode = null;
    child.stdout = new Emitter();
    child.stderr = new Emitter();
    child.stdin = {
      write(line: string, _encoding: string, callback: (error?: Error | null) => void) {
        callback(null);
        const request = JSON.parse(line) as { op: string; maxResults?: number };
        requests.push(request);
        const reply =
          request.op === 'snapshot'
            ? request.maxResults === 6
              ? {
                  ok: true,
                  window: {
                    id: 77,
                    title: 'Window with controls',
                    process: 'Example',
                    x: 0,
                    y: 0,
                    width: 100,
                    height: 100,
                    state: 'foreground'
                  },
                  snapshotId: 42,
                  elements: [
                    {
                      runtimeKey: 'snapshot-button',
                      name: 'Button',
                      role: 'Button',
                      automationId: 'button',
                      enabled: true,
                      offscreen: false,
                      bounds: { x: 10, y: 10, width: 20, height: 20 }
                    }
                  ],
                  visited: 1,
                  truncated: false
                }
              : {
                ok: true,
                window: {
                  id: 77,
                  title: 'Window without AX consent',
                  process: 'Example',
                  x: 0,
                  y: 0,
                  width: 100,
                  height: 100,
                  state: 'foreground'
                },
                uiUnavailable: {
                  code: 'ACCESSIBILITY_PERMISSION_REQUIRED',
                  message: 'enable Accessibility, then retry'
                }
              }
            : request.op === 'find_ui'
            ? {
                ok: true,
                window: 77,
                snapshotId: 41,
                elements: [
                  {
                    runtimeKey: 'old-helper-runtime-id',
                    name: 'Old button',
                    role: 'Button',
                    automationId: 'old-button',
                    enabled: true,
                    offscreen: false,
                    bounds: { x: 10, y: 10, width: 20, height: 20 }
                  }
                ]
              }
            : request.op === 'act'
              ? { ok: true, cursor: { x: 0, y: 0 }, completed_count: 1, routes: ['uia'] }
              : { ok: true, cursor: { x: 0, y: 0 } };
        queueMicrotask(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(reply)}\n`)));
        return true;
      },
      end() {}
    };
    children.push(child);
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  return { children, requests, spawn };
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

// The child process is mocked, but Darwin still resolves the native host before spawn.
vi.stubEnv('COS_MACOS_DESKTOP_HELPER', process.execPath);

import { act, findUi, getWindowState } from '../src/main/computer/index.js';

describe('semantic desktop ref lifetime', () => {
  it('keeps a screenshot-only window state usable when UI controls are unavailable', async () => {
    const state = await getWindowState({ window: 77, includeScreenshot: false, includeUi: true });
    expect(state.window.id).toBe(77);
    expect(state.snapshotId).toBeNull();
    expect(state.elements).toEqual([]);
    expect(state.uiUnavailable).toEqual({
      code: 'ACCESSIBILITY_PERMISSION_REQUIRED',
      message: 'enable Accessibility, then retry'
    });
  });

  it('invalidates refs as soon as their helper dies, before a replacement starts', async () => {
    const found = await findUi({ window: 77, maxResults: 5 });
    const ref = found.elements[0]!.ref;
    expect(fake.spawn).toHaveBeenCalledTimes(1);

    fake.children[0].exitCode = 0;
    fake.children[0].emit('close');

    await expect(act([{ type: 'click_ref', ref }])).rejects.toThrow(/STALE_REF/);
    expect(fake.spawn).toHaveBeenCalledTimes(1);
  });

  it('binds refs from a snapshot reply to the nested window id, never Number(windowObject)', async () => {
    const state = await getWindowState({ window: 77, includeScreenshot: false, includeUi: true, maxElements: 6 });
    await act([{ type: 'click_ref', ref: state.elements[0]!.ref }]);
    const request = fake.requests.findLast((value) => value.op === 'act');
    expect(request.actions[0]).toMatchObject({ type: 'click_ui', window: 77, snapshotId: 42 });
  });
});
