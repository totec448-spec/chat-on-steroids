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

  const children: any[] = [];
  const requests: any[] = [];
  const state = {
    identityVersion: 1,
    incarnationVersion: 1,
    captureNextUiFree: false,
    captureCombined: false,
    crashNextAct: false,
    crashNextSnapshot: false,
    changeIdentityOnSnapshotCrash: false
  };
  const spawn = vi.fn(() => {
    const childIndex = children.length;
    const child = new Emitter() as any;
    child.pid = 12_000 + childIndex;
    child.exitCode = null;
    child.stdout = new Emitter();
    child.stderr = new Emitter();
    child.stdin = {
      write(line: string, _encoding: string, callback: (error?: Error | null) => void) {
        callback(null);
        const request = JSON.parse(line) as { op: string; id?: number; includeUi?: boolean; includeScreenshot?: boolean; __cosRequestId?: string };
        const requestId = request.__cosRequestId ?? '';
        if (!requestId) throw new Error('missing transport request nonce');
        requests.push({ childIndex, ...request });

        if (childIndex === 0 && request.op === 'snapshot' && request.id === 66 && request.includeUi === true) {
          const reply = {
            ok: false,
            error_code: 'HELPER_ERROR',
            message: 'System.AccessViolationException: provider reported protected memory without terminating',
            __cosRequestId: requestId
          };
          queueMicrotask(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(reply)}\n`)));
          return true;
        }

        if (request.op === 'snapshot' && request.includeUi === false && request.includeScreenshot === true && state.captureNextUiFree) {
          state.captureNextUiFree = false;
          const reply = { ok: false, error_code: 'CAPTURE_FAILED', message: 'CAPTURE_FAILED: compositor surface unavailable', __cosRequestId: requestId };
          queueMicrotask(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(reply)}\n`)));
          return true;
        }

        if (request.op === 'act' && state.crashNextAct) {
          state.crashNextAct = false;
          queueMicrotask(() => {
            child.stderr.emit(
              'data',
              Buffer.from(
                `UIA_STAGE:${requestId}:uia.action.invoke\n` +
                'System.AccessViolationException: Attempted to read or write protected memory.\n'
              )
            );
            child.exitCode = -1;
            child.emit('close', -1);
          });
          return true;
        }

        if (request.op === 'snapshot' && request.id === 68 && request.includeUi === true) {
          queueMicrotask(() => {
            child.stderr.emit(
              'data',
              Buffer.from(
                'UIA_STAGE:r-stale-previous:uia.find.text\n' +
                'System.AccessViolationException: Attempted to read or write protected memory.\n'
              )
            );
            child.exitCode = -1;
            child.emit('close', -1);
          });
          return true;
        }

        if (request.op === 'snapshot' && request.includeUi === true && state.crashNextSnapshot) {
          state.crashNextSnapshot = false;
          queueMicrotask(() => {
            child.stderr.emit(
              'data',
              Buffer.from(
                `UIA_STAGE:${requestId}:uia.find.traversal\n` +
                'System.AccessViolationException: Attempted to read or write protected memory.\n'
              )
            );
            if (state.changeIdentityOnSnapshotCrash) {
              state.changeIdentityOnSnapshotCrash = false;
              state.identityVersion = 2;
            }
            child.exitCode = -1;
            child.emit('close', -1);
          });
          return true;
        }

        const window = {
          id: 77,
          app: 'C:\\Apps\\fixture.exe',
          processId: state.identityVersion === 1 ? 1001 : 2002,
          processStartTime: (133000000000000000n + BigInt(state.identityVersion * 100 + state.incarnationVersion)).toString(),
          processPath: 'C:\\Apps\\fixture.exe',
          appUserModelId: '',
          title: 'Crash-prone fixture',
          process: 'fixture',
          x: 0,
          y: 0,
          width: 640,
          height: 480,
          state: 'foreground'
        };
        const reply = request.op === 'apps'
          ? {
              ok: true,
              __cosRequestId: requestId,
              apps: [{ id: 'fixture.exe', displayName: 'Fixture', isRunning: true, windows: [window] }],
              truncated: false
            }
          : request.op === 'snapshot' && request.includeUi === true
            ? {
              ok: true,
              __cosRequestId: requestId,
              window,
              snapshotId: 88,
              elements: [{
                runtimeKey: 'new-provider-button',
                name: 'Recovered button',
                role: 'Button',
                automationId: 'recovered',
                enabled: true,
                offscreen: false,
                bounds: { x: 10, y: 10, width: 80, height: 30 }
              }],
              visited: 1,
              truncated: false,
              ...(state.captureCombined && request.includeScreenshot ? { screenshotUnavailable: { code: 'CAPTURE_FAILED', message: 'CAPTURE_FAILED: compositor missing' } } : {})
              }
            : { ok: true, __cosRequestId: requestId, window };
        queueMicrotask(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(reply)}\n`)));
        return true;
      },
      end() {}
    };
    children.push(child);
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  return { children, requests, spawn, state };
});

vi.mock('node:child_process', () => ({ spawn: fake.spawn }));
vi.mock('../src/main/env.js', () => ({
  ensureUsablePath: vi.fn(),
  normalizeEnvironment: (env: NodeJS.ProcessEnv) => ({ ...env }),
  setEnvValue: (env: NodeJS.ProcessEnv, key: string, value: string) => { env[key] = value; }
}));
vi.mock('../src/main/exec.js', () => ({
  findWindowsPowerShell: () => 'powershell.exe',
  terminateProcessTree: vi.fn(async () => undefined)
}));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));

import { act, getWindowState, listDesktopApps } from '../src/main/computer/index.js';

describe.runIf(process.platform === 'win32')('Windows UIA access-violation recovery', () => {
  it('retires the corrupted helper, retries UI-free once, circuit-breaks the exact identity, and re-enables UIA for a replacement process', async () => {
    await expect(getWindowState({ window: 66, includeScreenshot: false, includeUi: true })).rejects.toThrow(
      /HELPER_ERROR: System\.AccessViolationException/
    );
    expect(fake.children).toHaveLength(1);
    expect(fake.requests).toHaveLength(1);

    // list_apps is a normal Window2 window-producing flow. Seed the native app/process identity
    // from that result so a first accessibility crash cannot loop merely because list_windows or
    // get_window was not called first.
    const seeded = await listDesktopApps({ limit: 60 });
    expect(seeded.apps[0]?.windows?.[0]).toMatchObject({ id: 77, processId: 1001 });
    const beforeCrashRequests = fake.requests.length;

    fake.state.crashNextSnapshot = true;
    const first = await getWindowState({ window: 77, includeScreenshot: false, includeUi: true });
    expect(fake.children).toHaveLength(2);
    expect(first).toMatchObject({
      window: { id: 77, processId: 1001 },
      snapshotId: null,
      elements: [],
      uiUnavailable: {
        code: 'UIA_PROCESS_CRASH',
        message: expect.stringContaining('uia.find.traversal')
      }
    });
    expect(fake.requests.slice(beforeCrashRequests).map(({ childIndex, includeUi }) => [childIndex, includeUi])).toEqual([
      [0, true],
      [1, false]
    ]);

    const second = await getWindowState({ window: 77, includeScreenshot: false, includeUi: true });
    expect(second.uiUnavailable?.code).toBe('UIA_PROCESS_CRASH');
    expect(fake.children).toHaveLength(2);
    expect(fake.requests.at(-1)).toMatchObject({ childIndex: 1, op: 'snapshot', includeUi: false });
    expect(fake.requests.filter((request) => request.id === 77 && request.includeUi === true)).toHaveLength(1);

    // HWND reuse alone must not poison a different process. The breaker first proves native
    // identity without UIA, then allows a normal UI snapshot for the replacement owner.
    fake.state.identityVersion = 2;
    const third = await getWindowState({ window: 77, includeScreenshot: false, includeUi: true });
    expect(third).toMatchObject({
      window: { id: 77, processId: 2002 },
      snapshotId: 88,
      uiUnavailable: null,
      elements: [{ name: 'Recovered button' }]
    });
    expect(fake.requests.slice(-2).map(({ includeUi }) => includeUi)).toEqual([false, true]);

    const actRequestsBeforeCrash = fake.requests.filter((request) => request.op === 'act').length;
    fake.state.crashNextAct = true;
    // The helper crashed without acknowledging whether Invoke ran. Never report an exact
    // completed_count=0: a caller could otherwise replay an already completed mutation.
    await expect(act([{ type: 'click_ref', ref: third.elements[0]!.ref }], { window: 77 })).rejects.toMatchObject({
      completedCount: null, failedIndex: null,
      message: expect.stringMatching(/OUTCOME_UNCONFIRMED:.*UIA_PROCESS_CRASH/)
    });
    expect(fake.children).toHaveLength(2);
    expect(fake.requests.filter((request) => request.op === 'act')).toHaveLength(actRequestsBeforeCrash + 1);

    // The failed semantic action is never replayed. Once its helper generation is retired,
    // the same ref must fail locally before another native action can be dispatched.
    await expect(act([{ type: 'click_ref', ref: third.elements[0]!.ref }], { window: 77 })).rejects.toThrow(/STALE_REF/);
    expect(fake.requests.filter((request) => request.op === 'act')).toHaveLength(actRequestsBeforeCrash + 1);

    const requestCountBeforeProtectedObserve = fake.requests.length;
    const afterActionCrash = await getWindowState({ window: 77, includeScreenshot: false, includeUi: true });
    expect(fake.children).toHaveLength(3);
    expect(afterActionCrash.uiUnavailable?.code).toBe('UIA_PROCESS_CRASH');
    expect(fake.requests.slice(requestCountBeforeProtectedObserve)).toEqual([
      expect.objectContaining({ childIndex: 2, op: 'snapshot', includeUi: false })
    ]);

    // Replacing the HWND owner between the crashing UIA request and its immediate UI-free
    // recovery must fail closed instead of attaching the old provider crash to the new process.
    fake.state.identityVersion = 1;
    const reseeded = await getWindowState({ window: 77, includeScreenshot: false, includeUi: true });
    expect(reseeded.window).toMatchObject({ id: 77, processId: 1001 });
    fake.state.crashNextSnapshot = true;
    fake.state.changeIdentityOnSnapshotCrash = true;
    await expect(getWindowState({ window: 77, includeScreenshot: false, includeUi: true })).rejects.toThrow(
      /STALE_WINDOW: window identity changed during UIA crash recovery/
    );

    // A late/stale stage marker from another request cannot relabel an unrelated AV in the
    // current request, even though both strings are present in the same stderr tail.
    await expect(getWindowState({ window: 68, includeScreenshot: false, includeUi: true })).rejects.toThrow(
      /Desktop helper failed:/
    );

    // An unseeded HWND has no proven owner to compare after the crashed helper is
    // retired. Do not observe a possibly reused HWND in a new helper generation.
    fake.state.crashNextSnapshot = true;
    fake.state.changeIdentityOnSnapshotCrash = true;
    const beforeUnseeded = fake.requests.length;
    await expect(getWindowState({ window: 70, includeScreenshot: false, includeUi: true })).rejects.toThrow(
      /UIA_PROCESS_CRASH/
    );
    expect(fake.requests.slice(beforeUnseeded)).toEqual([
      expect.objectContaining({ op: 'snapshot', id: 70, includeUi: true })
    ]);

    // An implicit foreground lookup is even less stable: the new helper could
    // pick an entirely different foreground owner during UI-free recovery.
    fake.state.crashNextSnapshot = true;
    const beforeForeground = fake.requests.length;
    await expect(getWindowState({ includeScreenshot: false, includeUi: true })).rejects.toThrow(
      /UIA_PROCESS_CRASH/
    );
    expect(fake.requests.slice(beforeForeground)).toEqual([
      expect.objectContaining({ op: 'snapshot', includeUi: true })
    ]);
  });
  it('recovers read-only when a newly discovered HWND owner crashes after breaker replacement', async () => {
    // Use real list-apps to pin A, then plant its breaker with a native-helper crash.
    fake.state.identityVersion = 1;
    await listDesktopApps({ limit: 60 });
    await getWindowState({ window: 77, includeScreenshot: false, includeUi: true });
    fake.state.crashNextSnapshot = true;
    const crashedA = await getWindowState({ window: 77, includeScreenshot: false, includeUi: true });
    expect(crashedA).toMatchObject({ window: { processId: 1001 }, uiUnavailable: { code: 'UIA_PROCESS_CRASH' } });

    // Reuse the HWND with B. Its *first* UIA observation also crashes. The successful
    // preflight has proved B's identity; recovering B must not compare against A.
    fake.state.identityVersion = 2;
    fake.state.crashNextSnapshot = true;
    const from = fake.requests.length;
    const recoveredB = await getWindowState({ window: 77, includeScreenshot: false, includeUi: true });
    expect(recoveredB).toMatchObject({
      window: { id: 77, processId: 2002 }, snapshotId: null, elements: [],
      uiUnavailable: { code: 'UIA_PROCESS_CRASH' }
    });
    expect(fake.requests.slice(from).map((r: any) => r.includeUi)).toEqual([false, true, false]);

    // The B breaker must now suppress reentry to B's crashing provider.
    const before = fake.requests.length;
    const blockedB = await getWindowState({ window: 77, includeScreenshot: false, includeUi: true });
    expect(blockedB.uiUnavailable?.code).toBe('UIA_PROCESS_CRASH');
    expect(fake.requests.slice(before).map((r: any) => r.includeUi)).toEqual([false]);
  });
  it('distinguishes process incarnation reuse and retains UIA when replacement pixels fail', async () => {
    fake.state.identityVersion = 1;
    fake.state.incarnationVersion = 1;
    await listDesktopApps({ limit: 60 });
    fake.state.crashNextSnapshot = true;
    const crashA = await getWindowState({ window: 77, includeScreenshot: false, includeUi: true });
    expect(crashA.uiUnavailable?.code).toBe('UIA_PROCESS_CRASH');

    // B reuses A's numeric HWND, PID and executable path, but has another creation FILETIME.
    fake.state.incarnationVersion = 2;
    fake.state.captureNextUiFree = true;
    fake.state.captureCombined = true;
    const from = fake.requests.length;
    const replacement = await getWindowState({ window: 77, includeScreenshot: true, includeUi: true });
    expect(replacement.window.processId).toBe(1001);
    expect(replacement.window.processStartTime).toBe((133000000000000102n).toString());
    expect(replacement.elements[0]?.name).toBe('Recovered button');
    expect(replacement.uiUnavailable).toBeNull();
    expect(replacement.screenshotUnavailable?.code).toBe('CAPTURE_FAILED');
    expect(fake.requests.slice(from).map((x: any) => [x.includeUi, x.includeScreenshot])).toEqual([
      [false, false], [true, true]
    ]);
    fake.state.captureCombined = false;
    fake.state.captureNextUiFree = false;
  });

  it('retains the UIA breaker when screenshot capture also fails during crash recovery', async () => {
    fake.state.identityVersion = 1;
    fake.state.incarnationVersion = 3;
    fake.state.captureNextUiFree = false;
    fake.state.captureCombined = false;
    await listDesktopApps({ limit: 60 });
    fake.state.crashNextSnapshot = true;
    fake.state.captureNextUiFree = true;
    const from = fake.requests.length;
    await expect(getWindowState({ window: 77, includeScreenshot: true, includeUi: true }))
      .rejects.toThrow(/OBSERVATION_FAILED:.*CAPTURE_FAILED.*UIA_PROCESS_CRASH/);
    expect(fake.requests.slice(from).map((x: any) => [x.includeUi, x.includeScreenshot])).toEqual([
      [true, true], [false, true], [false, false]
    ]);
    const next = fake.requests.length;
    const breaker = await getWindowState({ window: 77, includeScreenshot: false, includeUi: true });
    expect(breaker.uiUnavailable?.code).toBe('UIA_PROCESS_CRASH');
    expect(fake.requests.slice(next).map((x: any) => [x.includeUi, x.includeScreenshot])).toEqual([[false, false]]);
  });

});
