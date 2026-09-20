import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const caps = {
    browse: true,
    search: true,
    read: true,
    metadata: true,
    create: false,
    edit: false,
    move: false,
    deleteFile: false,
    command: false,
    screen: false,
    control: false,
    clipboardRead: false,
    clipboardWrite: false
  };
  const config = {
    roots: [{ name: 'workspace', path: 'C:\\workspace' }],
    readOnly: true,
    capabilities: caps,
    tunnel: { kind: 'cloudflared', tunnelId: '', desktopTunnelId: '', pluginsTunnelId: '', binaryPath: '' },
    ui: { privacyScreenshots: false },
    sessions: { record: false },
    multiAgent: { enabled: false }
  };
  return {
    caps,
    config,
    report: null as null | ((report: Record<string, unknown>) => void),
    starts: 0,
    prewarm: vi.fn(async () => undefined),
    endpointStop: vi.fn(async (_options?: { forceAfterMs?: number }): Promise<void> => undefined),
    publication: vi.fn((surface: string, observe: (name: string, version: string, instructions: string, tools: unknown[]) => void) => observe(`Chat On Steroids ${surface}`, '1', 'instructions', [])),
    endpointStartGate: null as Promise<void> | null,
    endpointStartReached: vi.fn(),
    tunnelStartGate: null as Promise<void> | null,
    tunnelStartReached: vi.fn(),
    optionalStartGate: null as Promise<void> | null,
    optionalStartReached: vi.fn(),
    tunnelStop: vi.fn(async (): Promise<void> => undefined),
    secretGate: null as Promise<void> | null,
    secretReached: vi.fn()
  };
});

vi.mock('../src/main/computer/index.js', () => ({ prewarmComputerHelper: mocks.prewarm }));

vi.mock('../src/main/config.js', () => ({
  getConfig: () => mocks.config,
  effectiveCapabilities: () => mocks.caps
}));

vi.mock('../src/main/logger.js', () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn() }));

vi.mock('../src/main/mcp/server.js', () => ({
  lastRequestAt: () => null,
  tunnelProbeHeaders: () => ({}),
  startMcpServer: vi.fn(async () => {
    mocks.endpointStartReached();
    if (mocks.endpointStartGate) await mocks.endpointStartGate;
    return {
      port: 45678,
      publication: mocks.publication,
      url: 'http://127.0.0.1:45678/mcp/core/core-token',
      urls: {
        core: 'http://127.0.0.1:45678/mcp/core/core-token',
        desktop: 'http://127.0.0.1:45678/mcp/desktop/desktop-token',
        plugins: 'http://127.0.0.1:45678/mcp/plugins/plugins-token'
      },
      stop: mocks.endpointStop
    };
  })
}));

vi.mock('../src/main/mcp/tools.js', () => ({ lastToolCallAt: () => null }));
vi.mock('../src/main/secrets.js', () => ({
  getSecret: vi.fn(async () => {
    mocks.secretReached();
    if (mocks.secretGate) await mocks.secretGate;
    return null;
  })
}));
vi.mock('../src/main/tunnel/index.js', () => ({
  startTunnel: vi.fn(async (options: { label?: string; report: (report: Record<string, unknown>) => void }) => {
    mocks.starts += 1;
    mocks.report = options.report;
    mocks.tunnelStartReached();
    if (mocks.tunnelStartGate) await mocks.tunnelStartGate;
    if (options.label === 'plugins') {
      mocks.optionalStartReached();
      if (mocks.optionalStartGate) await mocks.optionalStartGate;
    }
    options.report({
      state: 'connected',
      detail: 'Connected.',
      publicUrl: 'https://example.trycloudflare.com/mcp/core/core-token'
    });
    return { stop: mocks.tunnelStop };
  })
}));

describe('connection surface state', () => {
  beforeEach(() => {
    mocks.report = null;
    mocks.starts = 0;
    mocks.prewarm.mockClear();
    mocks.endpointStop.mockClear();
    mocks.publication.mockClear();
    mocks.endpointStartReached.mockClear();
    mocks.endpointStartGate = null;
    mocks.tunnelStartReached.mockClear();
    mocks.tunnelStartGate = null;
    mocks.optionalStartGate = null;
    mocks.optionalStartReached.mockClear();
    mocks.tunnelStop.mockClear();
    mocks.secretReached.mockClear();
    mocks.secretGate = null;
    Object.assign(mocks.caps, {
      browse: true,
      search: true,
      read: true,
      metadata: true,
      create: false,
      edit: false,
      move: false,
      deleteFile: false,
      command: false,
      screen: false,
      control: false,
      clipboardRead: false,
      clipboardWrite: false
    });
    mocks.config.roots = [{ name: 'workspace', path: 'C:\\workspace' }];
    mocks.config.readOnly = true;
    mocks.config.tunnel.kind = 'cloudflared';
    mocks.config.tunnel.tunnelId = '';
    mocks.config.tunnel.pluginsTunnelId = '';
    mocks.config.tunnel.binaryPath = '';
    vi.resetModules();
  });

  it('reconnects with the selected setup key even when both profiles use the same tunnel ID', async () => {
    mocks.config.tunnel.kind = 'openai';
    mocks.config.tunnel.tunnelId = 'same-core';
    Object.assign(mocks.config.tunnel, { profileId: 'default', profileEpoch: 0 });
    const connection = await import('../src/main/connection.js');
    const { getSecret } = await import('../src/main/secrets.js');
    try {
      await connection.connect();
      expect(getSecret).toHaveBeenLastCalledWith('openaiApiKey');
      Object.assign(mocks.config.tunnel, { profileId: 'second', profileEpoch: 1 });
      await connection.applySettings();
      expect(getSecret).toHaveBeenLastCalledWith('setup:second');
      expect(mocks.endpointStop).toHaveBeenCalled();
      expect(mocks.starts).toBe(2);
    } finally {
      await connection.disconnect();
      delete (mocks.config.tunnel as any).profileId; delete (mocks.config.tunnel as any).profileEpoch;
    }
  });

  it('ignores retired Plugins tunnel reports after changing only its tunnel', async () => {
    mocks.config.tunnel.kind = 'openai';
    mocks.config.tunnel.tunnelId = 'core-test';
    mocks.config.tunnel.pluginsTunnelId = 'plugins-before';
    const connection = await import('../src/main/connection.js');
    await connection.connect();
    expect(mocks.starts).toBe(2);
    const oldReport = mocks.report!;
    mocks.config.tunnel.pluginsTunnelId = 'plugins-after';
    await connection.applySettings();
    expect(mocks.starts).toBe(3);
    expect(mocks.endpointStop).not.toHaveBeenCalled();
    oldReport({ state: 'error', detail: 'Retired failure', publicUrl: 'https://old.invalid' });
    expect(connection.getStatus().surfaces.find((s) => s.id === 'plugins')).toMatchObject({ state: 'live', detail: 'Connected.' });
    await connection.disconnect();
  });
  it('publishes refresh declarations only for live surfaces and does not rebuild on unchanged health reports', async () => {
    const connection = await import('../src/main/connection.js');
    const refresh = await import('../src/main/plugin-refresh.js');
    expect(refresh.pluginRefreshPublications()).toEqual([]);
    await connection.connect();
    expect(refresh.pluginRefreshPublications().map(row => row.surface)).toEqual(['core']);
    const first = refresh.pluginRefreshPublications()[0]!.schemaId;
    const calls = mocks.publication.mock.calls.length;
    mocks.report?.({ state: 'connected', detail: 'Still healthy' });
    expect(mocks.publication).toHaveBeenCalledTimes(calls);
    await connection.applySettings();
    expect(refresh.pluginRefreshPublications()[0]!.schemaId).toBe(first);
    await connection.disconnect();
    expect(refresh.pluginRefreshPublications()).toEqual([]);
  });

  it('drops the previous tunnel state and URL from connector cards after disconnect', async () => {
    const connection = await import('../src/main/connection.js');

    await connection.connect();
    expect(connection.getStatus().surfaces.find((surface) => surface.id === 'core')).toMatchObject({
      state: 'live',
      publicUrl: 'https://example.trycloudflare.com/mcp/core/core-token'
    });

    await connection.disconnect();
    const disconnected = connection.getStatus();
    expect(disconnected.state).toBe('disconnected');
    expect(disconnected.surfaces.find((surface) => surface.id === 'core')).toMatchObject({
      state: 'off',
      localUrl: null,
      publicUrl: null,
      detail: ''
    });
  });

  it('keeps ordinary disconnect graceful and reserves forced MCP drain for final shutdown', async () => {
    const connection = await import('../src/main/connection.js');

    await connection.connect();
    await connection.disconnect();
    expect(mocks.endpointStop).toHaveBeenLastCalledWith();

    await connection.connect();
    await connection.shutdownConnection();
    expect(mocks.endpointStop).toHaveBeenLastCalledWith({ forceAfterMs: 30_000 });
  });

  it('publishes Disconnect immediately and coalesces 100 clicks while accepted work drains', async () => {
    const connection = await import('../src/main/connection.js');
    await connection.connect();
    let release!: () => void;
    mocks.endpointStop.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const stopping = connection.disconnect();
    expect(connection.getStatus().state).toBe('disconnecting');
    for (let click = 0; click < 100; click++) expect(connection.disconnect()).toBe(stopping);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    mocks.report?.({ state: 'connected', detail: 'late health report' });
    expect(connection.getStatus().state).toBe('disconnecting');
    expect(mocks.tunnelStop).not.toHaveBeenCalled();
    release();
    await stopping;
    expect(mocks.endpointStop).toHaveBeenCalledTimes(1);
    expect(mocks.tunnelStop).toHaveBeenCalledTimes(1);
    expect(connection.getStatus().state).toBe('disconnected');
    await connection.connect();
    expect(connection.getStatus().state).toBe('connected');
  });

  it('lets final shutdown bound the ordinary drain already ahead of it in the lifecycle queue', async () => {
    const connection = await import('../src/main/connection.js');
    await connection.connect();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    mocks.endpointStop.mockImplementationOnce(() => gate);
    const stopping = connection.disconnect();
    await vi.waitFor(() => expect(mocks.endpointStop).toHaveBeenCalledTimes(1));
    mocks.endpointStop.mockImplementationOnce(async (options) => {
      expect(options).toEqual({ forceAfterMs: 30_000 });
      release();
    });
    await connection.shutdownConnection();
    await stopping;
    expect(connection.getStatus().state).toBe('disconnected');
  });

  it('cancels a queued Connect and permits an explicit Connect after Disconnect', async () => {
    const connection = await import('../src/main/connection.js');
    const connecting = connection.connect();
    const stopping = connection.disconnect();
    await Promise.all([connecting, stopping]);
    expect(mocks.starts).toBe(0);
    const disconnecting = connection.disconnect();
    const reconnecting = connection.connect();
    await Promise.all([disconnecting, reconnecting]);
    expect(connection.getStatus().state).toBe('connected');
  });

  it('bounds Disconnect when final shutdown arrives before its queued drain starts', async () => {
    const connection = await import('../src/main/connection.js');
    await connection.connect();
    const stopping = connection.disconnect();
    const shutdown = connection.shutdownConnection();
    await Promise.all([stopping, shutdown]);
    expect(mocks.endpointStop).toHaveBeenCalledWith({ forceAfterMs: 30_000 });
    expect(connection.getStatus().state).toBe('disconnected');
  });

  it('cancels an MCP endpoint that finishes starting after final shutdown was requested', async () => {
    let releaseEndpoint!: () => void;
    mocks.endpointStartGate = new Promise<void>((resolve) => {
      releaseEndpoint = resolve;
    });
    const connection = await import('../src/main/connection.js');

    const connecting = connection.connect();
    await vi.waitFor(() => expect(mocks.endpointStartReached).toHaveBeenCalledTimes(1));
    const shuttingDown = connection.shutdownConnection();
    await shuttingDown;
    expect(connection.getStatus().state).toBe('disconnected');
    releaseEndpoint();
    await Promise.all([connecting, shuttingDown]);

    expect(mocks.starts).toBe(0);
    expect(mocks.prewarm).not.toHaveBeenCalled();
    expect(mocks.endpointStop).toHaveBeenCalledWith({ forceAfterMs: 30_000 });
    expect(connection.getStatus().state).toBe('disconnected');
  });

  it('does not publish a tunnel that finishes starting after final shutdown was requested', async () => {
    let releaseTunnel!: () => void;
    mocks.tunnelStartGate = new Promise<void>((resolve) => {
      releaseTunnel = resolve;
    });
    const connection = await import('../src/main/connection.js');

    const connecting = connection.connect();
    await vi.waitFor(() => expect(mocks.tunnelStartReached).toHaveBeenCalledTimes(1));
    const shuttingDown = connection.shutdownConnection();
    await shuttingDown;
    expect(mocks.tunnelStop).not.toHaveBeenCalled();
    releaseTunnel();
    await Promise.all([connecting, shuttingDown]);

    expect(mocks.tunnelStop).toHaveBeenCalledTimes(1);
    expect(mocks.endpointStop).toHaveBeenCalledWith({ forceAfterMs: 30_000 });
    expect(connection.getStatus()).toMatchObject({ state: 'disconnected', publicUrl: null, localUrl: null });
  });

  it('finishes final shutdown without waiting for a parked credential lookup', async () => {
    let releaseSecret!: () => void;
    mocks.secretGate = new Promise<void>(resolve => { releaseSecret = resolve; });
    const connection = await import('../src/main/connection.js');
    const connecting = connection.connect();
    await vi.waitFor(() => expect(mocks.secretReached).toHaveBeenCalledTimes(1));
    const shutdown = connection.shutdownConnection();
    let finished = false;
    void shutdown.then(() => { finished = true; });
    try {
      expect(mocks.endpointStop).toHaveBeenCalledWith({ forceAfterMs: 30_000 });
      await vi.waitFor(() => expect(finished).toBe(true));
      expect(connection.getStatus().state).toBe('disconnected');
      expect(mocks.starts).toBe(0);
    } finally {
      releaseSecret();
      await Promise.all([connecting, shutdown]);
    }
    expect(mocks.starts).toBe(0);
    expect(connection.getStatus().state).toBe('disconnected');
  });

  it('joins the entire existing teardown, including tunnel retirement after the response drain', async () => {
    const connection = await import('../src/main/connection.js');
    await connection.connect();
    let releaseDrain!: () => void;
    const drain = new Promise<void>(resolve => { releaseDrain = resolve; });
    let releaseTunnel!: () => void;
    const tunnelStop = new Promise<void>(resolve => { releaseTunnel = resolve; });
    mocks.endpointStop.mockImplementationOnce(() => drain).mockImplementationOnce(() => drain);
    mocks.tunnelStop.mockImplementationOnce(() => tunnelStop);
    const disconnect = connection.disconnect();
    await vi.waitFor(() => expect(mocks.endpointStop).toHaveBeenCalledTimes(1));
    let finished = false;
    const shutdown = connection.shutdownConnection().then(() => { finished = true; });
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(finished).toBe(false);
      expect(mocks.tunnelStop).not.toHaveBeenCalled();
      releaseDrain();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.tunnelStop).toHaveBeenCalledTimes(1);
      expect(finished).toBe(false);
      releaseTunnel();
      await Promise.all([disconnect, shutdown]);
      expect(connection.getStatus().state).toBe('disconnected');
    } finally {
      releaseDrain();
      releaseTunnel();
      await Promise.all([disconnect, shutdown]);
      vi.useRealTimers();
    }
  });

  it('retires a late optional tunnel after shutdown without publishing or leaking it', async () => {
    mocks.config.tunnel.kind = 'openai';
    mocks.config.tunnel.tunnelId = 'core-test';
    mocks.config.tunnel.pluginsTunnelId = 'plugins-test';
    let releaseOptional!: () => void;
    mocks.optionalStartGate = new Promise<void>(resolve => { releaseOptional = resolve; });
    const connection = await import('../src/main/connection.js');
    const connecting = connection.connect();
    await vi.waitFor(() => expect(mocks.optionalStartReached).toHaveBeenCalledTimes(1));
    let finished = false;
    const shutdown = connection.shutdownConnection().then(() => { finished = true; });
    try {
      await vi.waitFor(() => expect(finished).toBe(true));
      expect(mocks.tunnelStop).toHaveBeenCalledTimes(1);
      expect(connection.getStatus().state).toBe('disconnected');
    } finally {
      releaseOptional();
      await Promise.all([connecting, shutdown]);
    }
    expect(mocks.tunnelStop).toHaveBeenCalledTimes(2);
    expect(connection.getStatus().surfaces.every(surface => surface.state === 'off' && surface.publicUrl === null)).toBe(true);
  });

  it.each(['core', 'plugins'] as const)('keeps a late %s transport alive until accepted responses drain', async surface => {
    mocks.config.tunnel.kind = 'openai';
    mocks.config.tunnel.pluginsTunnelId = surface === 'plugins' ? 'plugins-test' : '';
    let releaseStart!: () => void;
    const startup = new Promise<void>(resolve => { releaseStart = resolve; });
    if (surface === 'core') mocks.tunnelStartGate = startup;
    else mocks.optionalStartGate = startup;
    const connection = await import('../src/main/connection.js');
    const connecting = connection.connect();
    await vi.waitFor(() => expect(surface === 'core' ? mocks.tunnelStartReached : mocks.optionalStartReached).toHaveBeenCalled());
    let releaseDrain!: () => void;
    const drain = new Promise<void>(resolve => { releaseDrain = resolve; });
    mocks.endpointStop.mockImplementationOnce(() => drain);
    const shutdown = connection.shutdownConnection();
    vi.useFakeTimers();
    try {
      releaseStart();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.tunnelStop).not.toHaveBeenCalled();
      expect(connection.getStatus().state).toBe('disconnecting');
      releaseDrain();
      await Promise.all([connecting, shutdown]);
      expect(mocks.tunnelStop).toHaveBeenCalledTimes(surface === 'core' ? 1 : 2);
      expect(connection.getStatus().state).toBe('disconnected');
    } finally {
      releaseStart();
      releaseDrain();
      await Promise.all([connecting, shutdown]);
      vi.useRealTimers();
    }
  });

  it('tears down the local endpoint when Keychain lookup resumes after final shutdown', async () => {
    let releaseSecret!: () => void;
    mocks.secretGate = new Promise<void>((resolve) => {
      releaseSecret = resolve;
    });
    const connection = await import('../src/main/connection.js');

    const connecting = connection.connect();
    await vi.waitFor(() => expect(mocks.secretReached).toHaveBeenCalledTimes(1));
    const shuttingDown = connection.shutdownConnection();
    releaseSecret();
    await Promise.all([connecting, shuttingDown]);

    expect(mocks.starts).toBe(0);
    expect(mocks.endpointStop).toHaveBeenCalledWith({ forceAfterMs: 30_000 });
    expect(connection.getStatus().state).toBe('disconnected');
  });

  it('cancels tunnel startup through the same graceful endpoint-before-tunnel drain', async () => {
    let releaseTunnel!: () => void;
    mocks.tunnelStartGate = new Promise<void>(resolve => { releaseTunnel = resolve; });
    const connection = await import('../src/main/connection.js');
    const connecting = connection.connect();
    await vi.waitFor(() => expect(mocks.tunnelStartReached).toHaveBeenCalledTimes(1));
    let releaseDrain!: () => void;
    mocks.endpointStop.mockImplementationOnce(() => new Promise<void>(resolve => { releaseDrain = resolve; }));
    const stopping = connection.disconnect();
    releaseTunnel();
    await vi.waitFor(() => expect(releaseDrain).toBeTypeOf('function'));
    expect(mocks.endpointStop).toHaveBeenLastCalledWith();
    expect(mocks.tunnelStop).not.toHaveBeenCalled();
    expect(connection.getStatus().state).toBe('disconnecting');
    releaseDrain();
    await Promise.all([connecting, stopping]);
    expect(mocks.tunnelStop).toHaveBeenCalledTimes(1);
    expect(connection.getStatus().state).toBe('disconnected');
  });

  it('keeps ordinary disconnect reconnectable while final shutdown remains terminal', async () => {
    const connection = await import('../src/main/connection.js');
    await connection.connect();
    await connection.disconnect();
    await connection.connect();
    expect(mocks.starts).toBe(2);
    expect(connection.getStatus().state).toBe('connected');

    await connection.shutdownConnection();
    await connection.connect();
    expect(mocks.starts).toBe(2);
    expect(connection.getStatus().state).toBe('disconnected');
  });

  it('shows terminal tunnel reports as connector errors instead of an endless starting state', async () => {
    const connection = await import('../src/main/connection.js');
    await connection.connect();

    mocks.report?.({ state: 'tunnel-unavailable', detail: 'cloudflared stopped unexpectedly' });

    const failed = connection.getStatus();
    expect(failed.state).toBe('tunnel-unavailable');
    expect(failed.surfaces.find((surface) => surface.id === 'core')).toMatchObject({
      state: 'error',
      detail: 'cloudflared stopped unexpectedly'
    });
  });

  it('reconnects Core when its transport method changes instead of mixing old and new methods', async () => {
    const connection = await import('../src/main/connection.js');
    await connection.connect();
    expect(mocks.starts).toBe(1);

    mocks.config.tunnel.kind = 'manual';
    await connection.applySettings();

    expect(mocks.starts).toBe(2);
    expect(connection.getStatus().state).toBe('connected');
  });

  it('prewarms the helper only when a native Desktop capability is published', async () => {
    mocks.caps.screen = true;
    const connection = await import('../src/main/connection.js');
    await connection.connect();
    // Windows and macOS have native helpers. Linux masks the same stored preference from the
    // live surface, so it intentionally does not prewarm anything.
    expect(mocks.prewarm).toHaveBeenCalledTimes(process.platform === 'win32' || process.platform === 'darwin' ? 1 : 0);
  });

  it('does not let a Desktop permission hide a missing root required by Core capabilities', async () => {
    mocks.config.roots = [];
    mocks.caps.screen = true;
    const connection = await import('../src/main/connection.js');

    await connection.connect();

    expect(mocks.starts).toBe(0);
    expect(connection.getStatus()).toMatchObject({
      state: 'disconnected',
      detail: 'Add a folder before connecting.'
    });
  });

  it('still requires a root for command even though command execution itself is not root-confined', async () => {
    mocks.config.roots = [];
    mocks.config.readOnly = false;
    Object.assign(mocks.caps, {
      browse: false,
      search: false,
      read: false,
      metadata: false,
      command: true,
      screen: true
    });
    const connection = await import('../src/main/connection.js');

    await connection.connect();

    expect(mocks.starts).toBe(0);
    expect(connection.getStatus().detail).toBe('Add a folder before connecting.');
  });

  it('keeps genuinely rootless Desktop and clipboard setups connectable', async () => {
    mocks.config.roots = [];
    Object.assign(mocks.caps, {
      browse: false,
      search: false,
      read: false,
      metadata: false,
      screen: true
    });
    const desktop = await import('../src/main/connection.js');
    await desktop.connect();
    expect(desktop.getStatus().state).toBe('connected');
    expect(mocks.starts).toBe(1);

    await desktop.disconnect();
    mocks.caps.screen = false;
    mocks.caps.clipboardRead = true;
    await desktop.connect();
    expect(desktop.getStatus().state).toBe('connected');
    expect(mocks.starts).toBe(2);
  });
});
