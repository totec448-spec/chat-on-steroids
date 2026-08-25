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
    tunnel: { kind: 'cloudflared', tunnelId: '', desktopTunnelId: '', binaryPath: '' },
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
    endpointStop: vi.fn(async (_options?: { forceAfterMs?: number }) => undefined)
  };
});

vi.mock('../src/main/computer/index.js', () => ({ prewarmComputerHelper: mocks.prewarm }));

vi.mock('../src/main/config.js', () => ({
  getConfig: () => mocks.config,
  effectiveCapabilities: () => mocks.caps
}));

vi.mock('../src/main/logger.js', () => ({ logError: vi.fn(), logInfo: vi.fn() }));

vi.mock('../src/main/mcp/server.js', () => ({
  lastRequestAt: () => null,
  tunnelProbeHeaders: () => ({}),
  startMcpServer: vi.fn(async () => ({
    port: 45678,
    url: 'http://127.0.0.1:45678/mcp/core/core-token',
    urls: {
      core: 'http://127.0.0.1:45678/mcp/core/core-token',
      desktop: 'http://127.0.0.1:45678/mcp/desktop/desktop-token'
    },
    stop: mocks.endpointStop
  }))
}));

vi.mock('../src/main/mcp/tools.js', () => ({ lastToolCallAt: () => null }));
vi.mock('../src/main/secrets.js', () => ({ getSecret: vi.fn(async () => null) }));
vi.mock('../src/main/tunnel/index.js', () => ({
  startTunnel: vi.fn(async (options: { report: (report: Record<string, unknown>) => void }) => {
    mocks.starts += 1;
    mocks.report = options.report;
    options.report({
      state: 'connected',
      detail: 'Connected.',
      publicUrl: 'https://example.trycloudflare.com/mcp/core/core-token'
    });
    return { stop: vi.fn(async () => undefined) };
  })
}));

describe('connection surface state', () => {
  beforeEach(() => {
    mocks.report = null;
    mocks.starts = 0;
    mocks.prewarm.mockClear();
    mocks.endpointStop.mockClear();
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
    mocks.config.tunnel.binaryPath = '';
    vi.resetModules();
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
    expect(mocks.prewarm).toHaveBeenCalledTimes(1);
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
