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
      const window = { id: 77, title: 'Example', process: 'Example', ...rect, state: 'foreground' };
      if (request.file) {
        process.getBuiltinModule('node:fs').writeFileSync(request.file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      }
      const reply = {
        ok: true, window: request.op === 'find_ui' ? 77 : window, windows: [window], screen: rect,
        region: rect, image: { width: 100, height: 100 }, windowGeometry: rect,
        displays: [rect], captureMode: 'window', focused: true,
        snapshotId: 41,
        elements: [{ runtimeKey: 'button', name: 'Example', role: 'Button', enabled: true,
          offscreen: false, bounds: { x: 10, y: 10, width: 20, height: 20 } }],
        cursor: { x: 20, y: 20 },
        routes: (request.actions ?? []).map(() => 'uia')
      };
      queueMicrotask(() => addon
        ? this.emit('message', { type: 'reply', reply })
        : this.stdout.emit('data', Buffer.from(`${JSON.stringify(reply)}\n`)));
    }
  }
  return { requests, children, Transport, spawn: () => new Transport(false) };
});

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
    const first = await computer.screenshot({ window: 77 });
    await computer.screenshot({ window: 77 });
    const ui = await computer.findUi({ window: 77 });
    expect(ui.elements[0]?.imageCenter).toEqual({ x: 20, y: 20 });
    await expect(computer.act([{ type: 'move', x: 10, y: 10 }], { frameId: first.frameId })).resolves.toBeTruthy();
    await expect(computer.act([{ type: 'click_ref', ref: ui.elements[0]!.ref }])).resolves.toBeTruthy();
    expect(fake.children).toHaveLength(1);
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
    // `targetWindow` is this branch's addition, not upstream's. Physical pointer and application
    // text mutations require a proven destination here — INPUT_TARGET_REQUIRED — so a bare `type`
    // is refused before it reaches the code this test is about. The subject is the pointer
    // report's frame binding, and the action is only a way to get a cursor back, so naming the
    // window the screenshot above already used keeps the subject intact rather than weakening a
    // fence to suit a test.
    expect((await computer.act([{ type: 'type', text: 'example' }], { targetWindow: 77 })).cursor)
      .toMatchObject({ image: null, frameId: null });
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
