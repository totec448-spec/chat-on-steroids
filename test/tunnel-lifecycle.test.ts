import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  type Listener = (...args: any[]) => void;
  const children: any[] = [];

  const emitter = () => {
    const listeners = new Map<string, Listener[]>();
    return {
      on(name: string, listener: Listener) {
        listeners.set(name, [...(listeners.get(name) ?? []), listener]);
        return this;
      },
      once(name: string, listener: Listener) {
        const wrapped: Listener = (...args) => {
          listeners.set(name, (listeners.get(name) ?? []).filter((entry) => entry !== wrapped));
          listener(...args);
        };
        listeners.set(name, [...(listeners.get(name) ?? []), wrapped]);
        return this;
      },
      emit(name: string, ...args: any[]) {
        for (const listener of [...(listeners.get(name) ?? [])]) listener(...args);
      }
    };
  };

  const spawn = vi.fn(() => {
    const events = emitter();
    const child: any = {
      ...events,
      pid: 10_000 + children.length,
      exitCode: null,
      signalCode: null,
      stdout: emitter(),
      stderr: emitter(),
      kill: vi.fn()
    };
    children.push(child);
    return child;
  });

  const health: { url: string | null } = { url: null };
  const termination: { held: boolean; release: (() => void) | null } = { held: false, release: null };
  const terminate = vi.fn(async (pid: number) => {
    if (termination.held) {
      await new Promise<void>((resolve) => {
        termination.release = resolve;
      });
    }
    const child = children.find((entry) => entry.pid === pid);
    if (!child || child.exitCode !== null) return;
    child.exitCode = 0;
    child.emit('exit', 0);
    child.emit('close', 0);
  });

  return { children, spawn, health, termination, terminate };
});

vi.mock('node:child_process', () => ({ spawn: fixture.spawn }));
vi.mock('../src/main/exec.js', () => ({
  childEnv: () => ({}),
  terminateProcessTree: fixture.terminate
}));
vi.mock('../src/main/tunnel/locate.js', () => ({ locateBinary: () => 'tunnel-client-test' }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    promises: {
      ...actual.promises,
      mkdtemp: async (prefix: string) => `${prefix}fixture`,
      rm: async (_path: string, options?: { recursive?: boolean }) => {
        if (!options?.recursive) fixture.health.url = null;
      },
      readFile: async () => {
        if (fixture.health.url) return fixture.health.url;
        throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      }
    }
  };
});

const { startTunnel } = await import('../src/main/tunnel/index.js');

const settings = {
  kind: 'openai' as const,
  tunnelId: `tunnel_${'a'.repeat(32)}`,
  desktopTunnelId: '',
  binaryPath: ''
};

beforeEach(() => {
  fixture.children.length = 0;
  fixture.spawn.mockClear();
  fixture.terminate.mockClear();
  fixture.health.url = null;
  fixture.termination.held = false;
  fixture.termination.release = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('OpenAI tunnel process ownership', () => {
  it('classifies structured control-plane context together with its network error', async () => {
    vi.useFakeTimers();
    const reports: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/readyz') return new Response('ok');
      if (url.pathname === '/metrics') return new Response('commands_poll_last_successful_timestamp_seconds 0\ncommands_poll_errors_total 1\n');
      if (url.pathname === '/api/status') return Response.json({ uptime_seconds: 50, channels: [] });
      return new Response('missing', { status: 404 });
    }));
    const handle = await startTunnel({ localUrl: 'http://127.0.0.1:1234/secret', settings, apiKey: 'test', report: r => reports.push(r) });
    await vi.advanceTimersByTimeAsync(10);
    fixture.health.url = 'http://127.0.0.1:34567';
    await vi.advanceTimersByTimeAsync(1_000);
    const child = fixture.children[0];
    child.stderr.emit('data', Buffer.from(JSON.stringify({ level: 'WARN', msg: 'MCP probe failed', error: 'dial tcp: i/o timeout' }) + '\n'));
    await vi.advanceTimersByTimeAsync(45_000);
    expect(reports.some(r => r.state === 'offline')).toBe(false);
    child.stderr.emit('data', Buffer.from(JSON.stringify({ level: 'WARN', msg: 'poll failed; backing off', error: 'dial tcp: i/o timeout' }) + '\n'));
    await vi.advanceTimersByTimeAsync(45_000);
    expect(reports.at(-1).state).toBe('offline');
    expect(fixture.children).toHaveLength(1);
    await handle.stop();
  });

  it('claims one restart and waits for the old process tree before launching its replacement', async () => {
    vi.useFakeTimers();
    const reports: any[] = [];
    const handle = await startTunnel({
      localUrl: 'http://127.0.0.1:1234/secret',
      settings,
      apiKey: 'sk-tunnel-test',
      report: (report) => reports.push(report)
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(fixture.children).toHaveLength(1);
    fixture.termination.held = true;

    // No health URL is published, so the startup deadline retires this exact run. Killing it
    // emits exit too; that callback must lose the already-claimed compare-and-retire.
    await vi.advanceTimersByTimeAsync(61_000);
    const reconnects = reports.filter((report) => String(report.detail).includes('Reconnecting in'));
    expect(reconnects).toHaveLength(1);
    expect(reconnects[0].detail).toContain('did not become ready');

    // The two-second delay is shorter than this artificial stop. It must begin after the stop
    // barrier, not beside it.
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fixture.children).toHaveLength(1);

    fixture.termination.held = false;
    fixture.termination.release?.();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fixture.children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.children).toHaveLength(2);

    await handle.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fixture.children).toHaveLength(2);
  });

  /**
   * Terminating the client kills every request travelling through it.
   *
   * /readyz is asked once per pass, with a three-second timeout and no retry, and a single
   * `false` used to replace the process outright. A probe can miss without the client being
   * broken — mid-transfer, a briefly loaded machine, a slow downstream readiness check — and
   * every tool call in flight died with it. The model then waited for an answer that could no
   * longer arrive, which ChatGPT ends with "Message delivery timed out. Please try again."
   *
   * The same rule the offline caption already follows (see UNREACHABLE_CONFIRM_MS): one failed
   * poll is not a verdict. A genuinely dead client still gets replaced one pass later.
   */
  it('replaces the client only after a readiness failure survives a second pass', async () => {
    vi.useFakeTimers();
    let ready = true;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/readyz') return ready ? new Response('ok') : new Response('mcp probe failed', { status: 503 });
      if (url.pathname === '/metrics') return new Response('commands_poll_last_successful_timestamp_seconds 1\ncommands_poll_errors_total 0\n');
      if (url.pathname === '/api/status') return Response.json({ uptime_seconds: 50, channels: [] });
      return new Response('missing', { status: 404 });
    }));
    const handle = await startTunnel({
      localUrl: 'http://127.0.0.1:1234/secret',
      settings,
      apiKey: 'sk-tunnel-test',
      report: () => undefined
    });
    await vi.advanceTimersByTimeAsync(10);
    fixture.health.url = 'http://127.0.0.1:34567';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fixture.children).toHaveLength(1);

    // One missed probe, then the client answers again: the run it was carrying is untouched.
    ready = false;
    await vi.advanceTimersByTimeAsync(16_000);
    expect(fixture.children, 'a single missed probe must not replace the client').toHaveLength(1);
    expect(fixture.terminate).not.toHaveBeenCalled();
    ready = true;
    await vi.advanceTimersByTimeAsync(32_000);
    expect(fixture.children, 'a recovered client must not be replaced later either').toHaveLength(1);

    // Genuinely unready: it keeps failing, and the next pass replaces it.
    ready = false;
    await vi.advanceTimersByTimeAsync(16_000);
    expect(fixture.children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fixture.children, 'a client that stays unready is still replaced').toHaveLength(2);

    await handle.stop();
  });

  it('does not wait on a client that already died by signal before starting its replacement', async () => {
    vi.useFakeTimers();
    const reports: any[] = [];
    const handle = await startTunnel({
      localUrl: 'http://127.0.0.1:1234/secret',
      settings,
      apiKey: 'sk-tunnel-test',
      report: (report) => reports.push(report)
    });
    await vi.advanceTimersByTimeAsync(100);
    const first = fixture.children[0];

    // Killed by a signal: exitCode stays null and signalCode says why. There is nothing left
    // to stop, so the stop barrier must not be entered — with the old exitCode-only check it
    // was, and a held termination kept the replacement from ever being launched.
    first.signalCode = 'SIGKILL';
    fixture.termination.held = true;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(reports.some((report) => String(report.detail).includes('Reconnecting in'))).toBe(true);
    expect(fixture.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixture.children).toHaveLength(2);

    fixture.termination.held = false;
    await handle.stop();
  });

  it.each(['unavailable', 'missing timestamp'])('starts a replacement with no inherited health and %s metrics', async missing => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const reports: any[] = [];
    let metricsAvailable = true;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/readyz') return new Response('ok');
      if (url.pathname === '/metrics') {
        if (!metricsAvailable) {
          if (missing === 'missing timestamp') return new Response('commands_poll_errors_total 0\n');
          throw new Error('metrics unavailable');
        }
        return new Response(
          `commands_poll_last_successful_timestamp_seconds ${Date.now() / 1000}\ncommands_poll_errors_total 0\n`
        );
      }
      if (url.pathname === '/api/status') {
        return Response.json({ uptime_seconds: 5, version: 'test', channels: [] });
      }
      return new Response('missing', { status: 404 });
    }));

    const handle = await startTunnel({
      localUrl: 'http://127.0.0.1:1234/secret',
      settings,
      apiKey: 'sk-tunnel-test',
      report: (report) => reports.push(report)
    });

    await vi.advanceTimersByTimeAsync(10);
    const first = fixture.children[0];
    fixture.health.url = 'http://127.0.0.1:34567';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reports.at(-1)).toMatchObject({ state: 'connected', handshakeAt: expect.any(Number) });
    expect(handle.healthBase?.()).toBe('http://127.0.0.1:34567');

    first.exitCode = 1;
    first.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixture.children).toHaveLength(2);
    expect(handle.healthBase?.()).toBeNull();

    metricsAvailable = false;
    fixture.health.url = 'http://127.0.0.1:45678';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(handle.healthBase?.()).toBe('http://127.0.0.1:45678');
    expect(reports.at(-1)).toMatchObject({ state: 'connecting-tunnel', handshakeAt: null });
    expect(reports.at(-1).detail).toContain('metrics are temporarily unavailable');

    // Output arriving late from the exited process has no authority over the replacement.
    first.stderr.emit('data', Buffer.from(`${JSON.stringify({ level: 'WARN', msg: 'poll timed out' })}\n`));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(reports.some((report) => report.state === 'offline')).toBe(false);

    await handle.stop();
  });
});
