import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  type Listener = { fn: (...args: any[]) => void; once: boolean };
  class Emitter {
    private listeners = new Map<string, Listener[]>();
    on(event: string, fn: (...args: any[]) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), { fn, once: false }]);
      return this;
    }
    once(event: string, fn: (...args: any[]) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), { fn, once: true }]);
      return this;
    }
    emit(event: string, ...args: any[]) {
      const listeners = this.listeners.get(event) ?? [];
      this.listeners.set(event, listeners.filter((entry) => !entry.once));
      for (const listener of listeners) listener.fn(...args);
    }
  }
  const requests: Array<Record<string, any>> = [];
  const children: Array<Transport> = [];
  const clipboard = { writeText: vi.fn(), readText: vi.fn(() => '') };
  const overrides: { focusFailure: boolean; geometry: boolean } = { focusFailure: false, geometry: false };
  class Transport extends Emitter {
    readonly pid = 9000 + children.length;
    exitCode: number | null = null;
    readonly stdout = new Emitter();
    readonly stderr = new Emitter();
    readonly stdin = {
      write: (line: string, _encoding: string, callback: (error: null) => void) => {
        callback(null);
        this.answer(JSON.parse(line), false);
        return true;
      },
      end: () => this.close()
    };
    constructor(readonly addon = true) {
      super();
      children.push(this);
      queueMicrotask(() => addon ? this.emit('message', { type: 'ready' }) : this.emit('spawn'));
    }
    postMessage({ request }: { request: Record<string, any> }) {
      this.answer(request, true);
    }
    close() {
      this.exitCode = 0;
      this.emit(this.addon ? 'exit' : 'close', 0);
    }
    async terminate() { this.close(); return 0; }
    private answer(request: Record<string, any>, addon: boolean) {
      requests.push(request);
      const rect = { x: 0, y: 0, width: 100, height: 100 };
      const window = { id: 77, title: 'Example ä😀', process: 'Example', ...rect, state: 'foreground' };
      if (request.file) {
        process.getBuiltinModule('node:fs').writeFileSync(request.file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      }
      const reply = {
        ok: true, window: request.op === 'find_ui' ? 77 : window, windows: [window], screen: rect,
        region: rect, image: { width: 100, height: 100 }, windowGeometry: rect,
        displays: [rect], captureMode: 'window', focused: true,
        snapshotId: 41, truncated: request.maxResults === 1,
        elements: [{ runtimeKey: 'button', name: 'Example', role: 'Button', enabled: true,
          offscreen: false, bounds: { x: 10, y: 10, width: 20, height: 20 } }],
        cursor: { x: 20, y: 20 },
        routes: (request.actions ?? []).map(() => 'uia')
      };
      if (overrides.focusFailure && request.actions?.some((action: any) => action.type === 'focus')) {
        Object.assign(reply, { ok: false, error_code: 'FOCUS_FAILED', message: 'requested target is not foreground', completed_count: 0, failed_index: 0, routes: [] });
      }
      if (overrides.geometry) Object.assign(reply, {
        region: { x: 0, y: 0, width: 1280, height: 720 }, image: { width: 640, height: 360 },
        elements: [{ runtimeKey: 'edge', name: 'Edge', role: 'Button', enabled: true, offscreen: false,
          bounds: { x: 1, y: 1, width: 1279, height: 719 } }]
      });
      queueMicrotask(() => {
        if (addon) this.emit('message', { type: 'reply', reply });
        else {
          const bytes = Buffer.from(`${JSON.stringify(reply)}\n`);
          const split = bytes.indexOf(Buffer.from('ä')) + 1;
          this.stdout.emit('data', bytes.subarray(0, split));
          this.stdout.emit('data', bytes.subarray(split));
        }
      });
    }
  }
  return { requests, children, clipboard, overrides, Transport, spawn: () => new Transport(false) };
});

vi.mock('electron', () => ({ clipboard: fake.clipboard }));

vi.mock('node:child_process', () => ({ spawn: fake.spawn }));
vi.mock('node:worker_threads', () => ({ Worker: fake.Transport }));
vi.mock('node:fs', async (original) => ({
  ...await original<typeof import('node:fs')>(), existsSync: () => true
}));
vi.mock('../src/main/env.js', () => ({
  ensureUsablePath: vi.fn(), normalizeEnvironment: (env: NodeJS.ProcessEnv) => ({ ...env }),
  setEnvValue: (env: NodeJS.ProcessEnv, key: string, value: string) => { env[key] = value; }
}));
vi.mock('../src/main/exec.js', () => ({
  findWindowsPowerShell: () => 'powershell.exe',
  terminateProcessTree: async (pid: number) => { fake.children.find((child) => child.pid === pid)?.close(); }
}));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));

// Both production transports exercise the same lifecycle contract without native input,
// OS permissions or a display server. Only native replies and process/worker exits are mocked.
describe.each(['stdio', 'addon'] as const)('Desktop reply provenance (%s)', (transport) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let computer: typeof import('../src/main/computer/index.js');
  beforeEach(async () => {
    vi.resetModules();
    fake.children.length = 0;
    fake.requests.length = 0;
    fake.clipboard.writeText.mockClear();
    fake.overrides.focusFailure = false;
    fake.overrides.geometry = false;
    Object.defineProperty(process, 'platform', { ...platform, value: transport === 'addon' ? 'darwin' : 'linux' });
    vi.stubEnv('COS_MACOS_DESKTOP_HELPER', '');
    computer = await import('../src/main/computer/index.js');
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (computer) await computer.stopComputerHelper();
    vi.unstubAllEnvs();
    Object.defineProperty(process, 'platform', platform);
  });
  const replace = async () => {
    fake.children.at(-1)!.close();
    await computer.listWindows();
  };

  it('keeps older frames and refs usable while the same helper remains active', async () => {
    expect((await computer.listWindows()).windows[0]!.title).toBe('Example ä😀');
    const first = await computer.screenshot({ window: 77 });
    await computer.screenshot({ window: 77 });
    const ui = await computer.findUi({ window: 77 });
    expect(ui.elements[0]?.imageCenter).toEqual({ x: 20, y: 20 });
    await expect(computer.act([{ type: 'move', x: 10, y: 10 }], { frameId: first.frameId })).resolves.toBeTruthy();
    await expect(computer.act([{ type: 'click_ref', ref: ui.elements[0]!.ref }])).resolves.toBeTruthy();
    expect(fake.children).toHaveLength(1);
  });

  it('keeps fractional scaled control edges inside the actual returned image', async () => {
    fake.overrides.geometry = true;
    const state = await computer.getWindowState({ window: 77 });
    // Independent rounding used to produce x=1,width=640: one pixel past this image.
    expect(state.elements[0]?.imageBounds).toEqual({ x: 1, y: 1, width: 639, height: 359 });
    expect(state.elements[0]?.imageCenter).toEqual({ x: 321, y: 181 });
  });
  it('preserves native accessibility truncation without claiming a text result when text was not requested', async () => {
    expect((await computer.getWindowState({ window: 77, maxElements: 1, includeScreenshot: false })).uiTruncated).toBe(true);
    expect((await computer.getWindowState({ window: 77, maxElements: 2, includeScreenshot: false })).uiTruncated).toBe(false);
    expect((await computer.getWindowState({ window: 77, includeUi: false, includeScreenshot: false })).uiTruncated).toBeUndefined();
  });

  it('retires a frame immediately on helper exit without starting a replacement', async () => {
    const shot = await computer.screenshot({ window: 77 });
    fake.children[0]!.close();
    const sent = fake.requests.length;
    await expect(computer.act([{ type: 'move', x: 10, y: 10 }], { frameId: shot.frameId })).rejects.toThrow(/STALE_FRAME/);
    expect(fake.requests).toHaveLength(sent);
    expect(fake.children).toHaveLength(1);
  });

  it('does not bind new UI bounds or pointer reports to an earlier helper frame', async () => {
    await computer.screenshot({ window: 77 });
    await replace();
    expect((await computer.findUi({ window: 77 })).elements[0]).toMatchObject({ imageBounds: null, imageCenter: null });
    expect((await computer.act([{ type: 'type', text: 'example' }])).cursor).toMatchObject({ image: null, frameId: null });
  });

  it('refuses crops expressed in an earlier helper frame', async () => {
    const shot = await computer.screenshot({ window: 77 });
    await replace();
    const sent = fake.requests.length;
    await expect(computer.screenshot({ crop: { x: 0, y: 0, width: 10, height: 10 } })).rejects.toThrow(/STALE_FRAME/);
    await expect(computer.actAndCapture([], {
      frameId: shot.frameId, capture: { crop: { x: 0, y: 0, width: 10, height: 10 } }
    })).rejects.toThrow(/STALE_FRAME/);
    expect(fake.requests).toHaveLength(sent);
  });

  it.runIf(transport === 'stdio')('binds Windows input and its result capture to the explicitly selected window', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const state = await computer.getWindowState({ window: 77 });
    await computer.actAndCapture([
      { type: 'click', x: 20, y: 20 }, { type: 'wait', ms: 0 }, { type: 'type', text: 'hello' }
    ], { window: 77, frameId: state.screenshot!.frameId, capture: { maxWidth: 320 } });
    const native = fake.requests.filter(request => request.op === 'act');
    expect(native).toHaveLength(2);
    expect(native.every(request => request.targetWindow === 77)).toBe(true);
    expect(fake.requests.at(-1)).toMatchObject({ op: 'capture', id: 77 });
  });

  it.runIf(transport === 'stdio')('rejects mismatched Windows coordinates, refs and focus before any batch effect', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const state = await computer.getWindowState({ window: 77 });
    const sent = fake.requests.length;
    for (const actions of [
      [{ type: 'click' as const, x: 20, y: 20 }],
      [{ type: 'click_ref' as const, ref: state.elements[0]!.ref }],
      [{ type: 'focus' as const, window: 77 }]
    ]) {
      await expect(computer.act([{ type: 'write_clipboard', text: 'must not be written' }, ...actions], {
        window: 88, frameId: state.screenshot!.frameId
      })).rejects.toThrow(/WINDOW_MISMATCH/);
    }
    expect(fake.requests).toHaveLength(sent);
  });

  it.runIf(transport === 'stdio')('retains app and popup ownership with raw wheel units and indexed click options at native dispatch', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const state = await computer.getWindowState({ window: 77 });
    await computer.act([{ type: 'scroll', x: 20, y: 20, scroll_y: 120, scrollUnit: 'wheel' }], {
      window: 77, app: 'fixture.exe', ownerWindow: 99, ownerApp: 'owner.exe', frameId: state.screenshot!.frameId
    });
    expect(fake.requests.filter(request => request.op === 'act').at(-1)).toMatchObject({
      targetWindow: 77, targetApp: 'fixture.exe', ownerWindow: 99, ownerApp: 'owner.exe',
      frame: { window: 77, targetApp: 'fixture.exe', ownerWindow: 99, ownerApp: 'owner.exe' },
      actions: [{ type: 'scroll', scroll_y: 120, rawWheel: true }]
    });
    await computer.act([{ type: 'click_ref', ref: state.elements[0]!.ref, button: 'right', count: 2 }], { window: 77, app: 'fixture.exe' });
    expect(fake.requests.filter(request => request.op === 'act').at(-1)).toMatchObject({
      targetWindow: 77, targetApp: 'fixture.exe', actions: [{ type: 'click_ui', window: 77, button: 'right', count: 2 }]
    });
  });

  it.runIf(transport === 'stdio')('pastes exact multiline text once and refuses later clipboard replacement in that batch', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const text = 'first\nsecond\r\nthird';
    const result = await computer.act([{ type: 'paste', text }], { window: 77 });
    expect(fake.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(text);
    expect(result.completedCount).toBe(1);
    expect(fake.requests.filter(request => request.op === 'act')).toMatchObject([
      { targetWindow: 77, actions: [{ type: 'focus', window: 77 }] },
      { targetWindow: 77, actions: [{ type: 'keypress', keys: ['ctrl', 'v'] }] }
    ]);
    fake.clipboard.writeText.mockClear();
    await expect(computer.act([{ type: 'paste', text }, { type: 'write_clipboard', text: 'later' }], { window: 77 })).rejects.toThrow(/PASTE_SEQUENCE/);
    expect(fake.clipboard.writeText).not.toHaveBeenCalled();
  });

  it.runIf(transport === 'stdio')('does not replace the clipboard when target activation fails before paste', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    fake.overrides.focusFailure = true;
    await expect(computer.act([{ type: 'paste', text: 'must not replace clipboard' }], { window: 77, app: 'fixture.exe' }))
      .rejects.toMatchObject({ completedCount: 0, failedIndex: 0, message: expect.stringMatching(/FOCUS_FAILED/) });
    expect(fake.clipboard.writeText).not.toHaveBeenCalled();
    expect(fake.requests.filter(request => request.op === 'act')).toEqual([
      { op: 'act', targetWindow: 77, targetApp: 'fixture.exe', actions: [{ type: 'focus', window: 77 }] }
    ]);
  });

  it('does not mutate clipboard after a pending ref owner retires during a local wait', async () => {
    const state = await computer.getWindowState({ window: 77 });
    vi.useFakeTimers();
    const work = computer.act([{ type: 'wait', ms: 100 }, { type: 'write_clipboard', text: 'must not replace' }, { type: 'click_ref', ref: state.elements[0]!.ref }]);
    const rejected = expect(work).rejects.toMatchObject({ completedCount: 1, failedIndex: 1, message: expect.stringMatching(/STALE_REF/) });
    void rejected.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await replace();
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(fake.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('retains completed input evidence if the subsequent screenshot fails', async () => {
    vi.spyOn(fs, 'stat').mockRejectedValueOnce(new Error('fixture image unavailable'));
    await expect(computer.actAndCapture([{ type: 'type', text: 'already sent' }], { capture: { window: 77 } }))
      .rejects.toMatchObject({ completedCount: 1, failedIndex: 1, completedRoutes: ['uia'], message: expect.stringMatching(/CAPTURE_AFTER_FAILED.*do not repeat/) });
    expect(fake.requests.filter(request => request.op === 'act')).toHaveLength(1);
  });

  it('keeps an original reply identity across asynchronous image materialization', async () => {
    const stat = fs.stat.bind(fs) as (...args: any[]) => Promise<any>;
    const boundary = vi.spyOn(fs, 'stat').mockImplementationOnce(async (...args: any[]) => {
      await replace();
      return stat(...args);
    });
    const state = await computer.getWindowState({ window: 77 });
    boundary.mockRestore();
    expect(fake.children).toHaveLength(2);
    expect(state.screenshot).not.toBeNull();
    const sent = fake.requests.length;
    await expect(computer.act([{ type: 'click_ref', ref: state.elements[0]!.ref }])).rejects.toThrow(/STALE_REF/);
    await expect(computer.act([{ type: 'move', x: 10, y: 10 }], { frameId: state.screenshot!.frameId })).rejects.toThrow(/STALE_FRAME/);
    expect(fake.requests).toHaveLength(sent);
    const fresh = await computer.getWindowState({ window: 77 });
    expect(fresh.elements[0]!.ref).not.toBe(state.elements[0]!.ref);
    await expect(computer.act([{ type: 'click_ref', ref: fresh.elements[0]!.ref }])).resolves.toBeTruthy();
  });

  it.each(['frame', 'ref'] as const)('rechecks %s provenance at dispatch after local work', async (kind) => {
    const state = await computer.getWindowState({ window: 77 });
    vi.useFakeTimers();
    const work = computer.act([
      { type: 'wait', ms: 100 },
      ...(kind === 'frame'
        ? [{ type: 'move' as const, x: 10, y: 10 }]
        : [{ type: 'click_ref' as const, ref: state.elements[0]!.ref }])
    ], { frameId: state.screenshot!.frameId });
    const rejected = expect(work).rejects.toMatchObject({
      completedCount: 1, failedIndex: 1, completedRoutes: ['local'],
      message: expect.stringMatching(kind === 'frame' ? /STALE_FRAME/ : /STALE_REF/)
    });
    void rejected.catch(() => {}); // A red baseline may settle before the clock is advanced.
    // Advance the controlled scheduler up to (but not through) the local wait.
    await vi.advanceTimersByTimeAsync(0);
    await replace();
    const sent = fake.requests.length;
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(fake.requests).toHaveLength(sent);
  });
});
