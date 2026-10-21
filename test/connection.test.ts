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
    multiAgent: { enabled: false },
    mcp: { instructions: '', persistentUrls: false }
  };
  return {
    caps,
    config,
    report: null as null | ((report: Record<string, unknown>) => void),
    reports: new Map<string, (report: Record<string, unknown>) => void>(),
    initialTunnelState: 'connected',
    starts: 0,
    prewarm: vi.fn(async () => undefined),
    endpointStop: vi.fn(async (_options?: { forceAfterMs?: number }): Promise<void> => undefined),
    publication: vi.fn((surface: string, observe: (name: string, version: string, instructions: string, tools: unknown[]) => void) => observe(`Chat On Steroids ${surface}`, '1', 'instructions', [])),
    endpointStartGate: null as Promise<void> | null,
    endpointStartReached: vi.fn(),
    endpointContexts: [] as Array<() => unknown>,
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
  startMcpServer: vi.fn(async (getContext: () => unknown) => {
    mocks.endpointContexts.push(getContext);
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
const paths = vi.hoisted(() => ({ kept: {} as Record<string, string>, port: null as number | null, remembered: [] as unknown[] }));
vi.mock('../src/main/mcp/persistent-paths.js', () => ({
  loadSurfaceTokens: vi.fn(async () => paths.kept),
  loadKeptPort: vi.fn(async () => paths.port),
  rememberSurfaceTokens: vi.fn(async (urls: unknown) => { paths.remembered.push(urls); return true; }),
  forgetSurfaceTokens: vi.fn(async () => undefined)
}));
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
    mocks.reports.set(options.label ?? 'core', options.report);
    mocks.tunnelStartReached();
    if (mocks.tunnelStartGate) await mocks.tunnelStartGate;
    if (options.label === 'plugins') {
      mocks.optionalStartReached();
      if (mocks.optionalStartGate) await mocks.optionalStartGate;
    }
    options.report({
      state: mocks.initialTunnelState,
      detail: 'Connected.',
      publicUrl: 'https://example.trycloudflare.com/mcp/core/core-token'
    });
    return { stop: mocks.tunnelStop };
  })
}));

describe('connection surface state', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.report = null;
    mocks.reports.clear();
    mocks.initialTunnelState = 'connected';
    mocks.starts = 0;
    mocks.prewarm.mockClear();
    mocks.endpointStop.mockClear();
    mocks.publication.mockClear();
    mocks.endpointStartReached.mockClear();
    mocks.endpointContexts.length = 0;
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
    mocks.config.tunnel.desktopTunnelId = '';
    mocks.config.tunnel.pluginsTunnelId = '';
    mocks.config.tunnel.binaryPath = '';
    vi.resetModules();
  });

  it.each(['offline', 'auth-failed', 'tunnel-unavailable'])('notifies once when an established tunnel reports %s, and re-arms only on connected', async state => {
    vi.useFakeTimers();
    const connection = await import('../src/main/connection.js');
    const notify = vi.fn();
    connection.setConnectionLossNotifier(notify);
    await connection.connect();
    const report = mocks.reports.get('core')!;

    report({ state, detail: 'Unexpected drop' });
    report({ state, detail: 'Repeated health sample' });
    report({ state: 'connecting-tunnel', detail: 'Still retrying' });
    report({ state: 'offline', detail: 'Still offline' });
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(notify.mock.calls).toEqual([['core']]);

    report({ state: 'connected', detail: 'Recovered' });
    report({ state: 'offline', detail: 'Another outage' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(notify.mock.calls).toEqual([['core'], ['core']]);
    await connection.disconnect();
  });

  it('cancels a brief outage and keeps the notice budget armed', async () => {
    vi.useFakeTimers();
    const connection = await import('../src/main/connection.js');
    const notify = vi.fn();
    connection.setConnectionLossNotifier(notify);
    await connection.connect();
    const report = mocks.reports.get('core')!;

    report({ state: 'offline', detail: 'Short network blip' });
    await vi.advanceTimersByTimeAsync(29_000);
    report({ state: 'connected', detail: 'Recovered quickly' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(notify).not.toHaveBeenCalled();

    report({ state: 'offline', detail: 'Persistent outage' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(notify).toHaveBeenCalledExactlyOnceWith('core');
    await connection.disconnect();
  });

  it('does not count suspend time and gives an outage a fresh grace window after resume', async () => {
    vi.useFakeTimers();
    const connection = await import('../src/main/connection.js');
    const notify = vi.fn();
    connection.setConnectionLossNotifier(notify);
    await connection.connect();
    const report = mocks.reports.get('core')!;

    report({ state: 'offline', detail: 'Network lost before sleep' });
    await vi.advanceTimersByTimeAsync(10_000);
    connection.suspendConnectionLossNotices();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(notify).not.toHaveBeenCalled();

    connection.resumeConnectionLossNotices();
    await vi.advanceTimersByTimeAsync(29_000);
    report({ state: 'connected', detail: 'Recovered after wake' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(notify).not.toHaveBeenCalled();
    await connection.disconnect();
  });

  it('remembers an established connection through temporary unknown health before a confirmed outage', async () => {
    vi.useFakeTimers();
    const connection = await import('../src/main/connection.js');
    const notify = vi.fn();
    connection.setConnectionLossNotifier(notify);
    await connection.connect();
    const report = mocks.reports.get('core')!;
    report({ state: 'connecting-tunnel', detail: 'Metrics temporarily unavailable' });
    expect(notify).not.toHaveBeenCalled();
    report({ state: 'offline', detail: 'Confirmed network outage' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(notify).toHaveBeenCalledExactlyOnceWith('core');
    await connection.disconnect();
  });

  it('stays silent for initial failure and a failed new connection after deliberate disconnect', async () => {
    mocks.initialTunnelState = 'offline';
    const connection = await import('../src/main/connection.js');
    const notify = vi.fn();
    connection.setConnectionLossNotifier(notify);
    await connection.connect();
    const report = mocks.reports.get('core')!;
    report({ state: 'auth-failed', detail: 'Never connected' });
    expect(notify).not.toHaveBeenCalled();
    report({ state: 'connected', detail: 'First connection' });
    await connection.disconnect();
    await connection.connect();
    expect(notify).not.toHaveBeenCalled();
    await connection.disconnect();
  });

  it.each(['disconnect', 'shutdownConnection'] as const)('stays silent from the instant %s is requested, including stop reports', async action => {
    vi.useFakeTimers();
    const connection = await import('../src/main/connection.js');
    const notify = vi.fn();
    connection.setConnectionLossNotifier(notify);
    await connection.connect();
    const report = mocks.reports.get('core')!;
    mocks.tunnelStop.mockImplementationOnce(async () => { report({ state: 'tunnel-unavailable', detail: 'Stopped' }); });
    const stopped = connection[action]();
    report({ state: 'offline', detail: 'Late report before queued teardown' });
    await stopped;
    report({ state: 'connected', detail: 'Retired recovery' });
    report({ state: 'offline', detail: 'Retired outage' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(notify).not.toHaveBeenCalled();
  });

  it('keeps settings reconnect silent and cannot re-arm from the retired generation', async () => {
    vi.useFakeTimers();
    const connection = await import('../src/main/connection.js');
    const notify = vi.fn();
    connection.setConnectionLossNotifier(notify);
    await connection.connect();
    const retired = mocks.reports.get('core')!;
    mocks.tunnelStop.mockImplementationOnce(async () => { retired({ state: 'tunnel-unavailable', detail: 'Settings stop' }); });
    mocks.config.tunnel.kind = 'manual';
    mocks.initialTunnelState = 'offline';
    await connection.applySettings();
    retired({ state: 'connected', detail: 'Retired recovery' });
    mocks.reports.get('core')!({ state: 'offline', detail: 'New tunnel never connected' });
    expect(notify).not.toHaveBeenCalled();
    mocks.reports.get('core')!({ state: 'connected', detail: 'New connection' });
    mocks.reports.get('core')!({ state: 'offline', detail: 'New outage' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(notify).toHaveBeenCalledExactlyOnceWith('core');
    await connection.disconnect();
  });

  it('tracks Core, Desktop and Plugins outages independently', async () => {
    vi.useFakeTimers();
    mocks.config.tunnel.kind = 'openai';
    mocks.config.tunnel.desktopTunnelId = 'desktop-test';
    mocks.config.tunnel.pluginsTunnelId = 'plugins-test';
    mocks.caps.screen = true;
    const connection = await import('../src/main/connection.js');
    const notify = vi.fn();
    connection.setConnectionLossNotifier(notify);
    await connection.connect();
    for (const surface of ['core', 'desktop', 'plugins']) {
      const report = mocks.reports.get(surface)!;
      report({ state: 'offline', detail: 'Lost' });
      report({ state: 'offline', detail: 'Repeated' });
    }
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(notify.mock.calls).toEqual([['core'], ['desktop'], ['plugins']]);
    mocks.reports.get('plugins')!({ state: 'connected', detail: 'Plugins recovered' });
    mocks.reports.get('plugins')!({ state: 'offline', detail: 'Plugins lost again' });
    mocks.reports.get('core')!({ state: 'offline', detail: 'Core still down' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(notify.mock.calls).toEqual([['core'], ['desktop'], ['plugins'], ['plugins']]);
    await connection.disconnect();
  });

  it('keeps optional settings replacement and removal silent without disturbing Core eligibility', async () => {
    vi.useFakeTimers();
    mocks.config.tunnel.kind = 'openai';
    mocks.config.tunnel.pluginsTunnelId = 'plugins-before';
    const connection = await import('../src/main/connection.js');
    const notify = vi.fn();
    connection.setConnectionLossNotifier(notify);
    await connection.connect();
    const retired = mocks.reports.get('plugins')!;
    mocks.tunnelStop.mockImplementationOnce(async () => { retired({ state: 'tunnel-unavailable', detail: 'Settings stop' }); });
    mocks.config.tunnel.pluginsTunnelId = 'plugins-after';
    mocks.initialTunnelState = 'offline';
    await connection.applySettings();
    retired({ state: 'connected', detail: 'Retired recovery' });
    retired({ state: 'offline', detail: 'Retired outage' });
    const replacement = mocks.reports.get('plugins')!;
    replacement({ state: 'offline', detail: 'Replacement has not connected' });
    expect(notify).not.toHaveBeenCalled();
    replacement({ state: 'connected', detail: 'Replacement connected' });
    mocks.config.tunnel.pluginsTunnelId = '';
    await connection.applySettings();
    replacement({ state: 'offline', detail: 'Removed tunnel report' });
    expect(notify).not.toHaveBeenCalled();
    mocks.reports.get('core')!({ state: 'offline', detail: 'Unrelated Core outage' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(notify).toHaveBeenCalledExactlyOnceWith('core');
    await connection.disconnect();
  });

  it('does not notify if a status listener requests Disconnect during the failing report', async () => {
    const connection = await import('../src/main/connection.js');
    const notify = vi.fn();
    connection.setConnectionLossNotifier(notify);
    await connection.connect();
    let stopped: Promise<void> | undefined;
    const unsubscribe = connection.onStatusChange(status => {
      if (status.state === 'offline') stopped = connection.disconnect();
    });
    mocks.reports.get('core')!({ state: 'offline', detail: 'Lost' });
    expect(stopped).toBeDefined();
    await stopped;
    unsubscribe();
    expect(notify).not.toHaveBeenCalled();
  });

  it('notifies once for a shared-origin tunnel even when optional surfaces are published', async () => {
    vi.useFakeTimers();
    mocks.caps.screen = true;
    const connection = await import('../src/main/connection.js');
    const notify = vi.fn();
    connection.setConnectionLossNotifier(notify);
    await connection.connect();
    expect(connection.getStatus().surfaces.filter(surface => surface.state === 'live').map(surface => surface.id))
      .toEqual(['core', 'desktop', 'plugins']);
    mocks.reports.get('core')!({ state: 'tunnel-unavailable', detail: 'Process exited' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(notify).toHaveBeenCalledExactlyOnceWith('core');
    await connection.disconnect();
  });

  it.each(['declined', 'throws'])('consumes an outage when the notifier %s without changing connection behavior', async outcome => {
    vi.useFakeTimers();
    const connection = await import('../src/main/connection.js');
    const notify = vi.fn(() => { if (outcome === 'throws') throw new Error('Notification unavailable'); return false; });
    connection.setConnectionLossNotifier(notify);
    await connection.connect();
    const report = mocks.reports.get('core')!;
    expect(() => report({ state: 'offline', detail: 'Lost' })).not.toThrow();
    expect(connection.getStatus().state).toBe('offline');
    await vi.advanceTimersByTimeAsync(30_000);
    report({ state: 'connecting-tunnel', detail: 'Retry' });
    report({ state: 'offline', detail: 'Still down' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(notify).toHaveBeenCalledTimes(1);
    await connection.disconnect();
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

  it('keeps each MCP endpoint generation pinned to the Setup profile that created it', async () => {
    mocks.config.tunnel.kind = 'openai';
    mocks.config.tunnel.tunnelId = 'same-core';
    Object.assign(mocks.config.tunnel, { profileId: 'default', profileEpoch: 0 });
    const connection = await import('../src/main/connection.js');
    try {
      await connection.connect();
      const first = mocks.endpointContexts[0]!;
      expect(first()).toMatchObject({ setupProfileId: 'default' });

      // Config switches first; the old listener can still be draining accepted calls. Its
      // provenance must remain Default until teardown completes instead of reading the new config.
      Object.assign(mocks.config.tunnel, { profileId: 'second', profileEpoch: 1 });
      expect(first()).toMatchObject({ setupProfileId: 'default' });
      await connection.applySettings();

      expect(mocks.endpointContexts).toHaveLength(2);
      expect(first()).toMatchObject({ setupProfileId: 'default' });
      expect(mocks.endpointContexts[1]!()).toMatchObject({ setupProfileId: 'second' });
    } finally {
      await connection.disconnect();
      delete (mocks.config.tunnel as any).profileId;
      delete (mocks.config.tunnel as any).profileEpoch;
    }
  });

  /**
   * Two connectors on one Secure Tunnel ID, said out loud.
   *
   * OpenAI's tunnel dispatches round-robin across every client registered on an ID, so two
   * surfaces sharing one means every other call reaches the wrong connector — which answers
   * `UNKNOWN_TOOL: This tool name is not in the current Plugins catalog` about a tool that exists
   * and is published on the surface next door.
   *
   * Measured in #352: twenty consecutive Core `exec_command` calls with byte-identical payloads,
   * ten succeeded and ten failed, alternating exactly, with the log alternating `POST mcp/core`
   * and `POST mcp/plugins` in step. Nothing about the failure named its cause — restarting the app,
   * refreshing the connectors and opening fresh chats all left it in place — so three people
   * reached it the long way before anyone suspected the configuration.
   *
   * A warning and not a refusal: the IDs are the user's to choose. And no ID is ever logged.
   */
  it('warns when two connectors share one Secure Tunnel ID, and names both', async () => {
    mocks.config.tunnel.kind = 'openai';
    Object.assign(mocks.config.tunnel, { tunnelId: 'shared-id', pluginsTunnelId: 'shared-id', desktopTunnelId: '' });
    const connection = await import('../src/main/connection.js');
    const { logWarn } = await import('../src/main/logger.js');
    try {
      await connection.connect();
      const said = (logWarn as unknown as { mock: { calls: string[][] } }).mock.calls
        .map(call => String(call[0])).filter(line => line.includes('same Secure Tunnel ID'));
      expect(said, 'a shared tunnel ID was not reported').toHaveLength(1);
      expect(said[0]).toContain('core and plugins');
      expect(said[0]).toContain('UNKNOWN_TOOL');
      expect(said[0], 'the tunnel ID itself was logged').not.toContain('shared-id');
    } finally {
      await connection.disconnect();
      Object.assign(mocks.config.tunnel, { tunnelId: '', pluginsTunnelId: '', desktopTunnelId: '' });
    }
  });

  /** The control: distinct IDs are the ordinary case and must stay silent. */
  it('says nothing when each connector has its own tunnel ID', async () => {
    mocks.config.tunnel.kind = 'openai';
    Object.assign(mocks.config.tunnel, { tunnelId: 'core-id', pluginsTunnelId: 'plugins-id', desktopTunnelId: 'desktop-id' });
    const connection = await import('../src/main/connection.js');
    const { logWarn } = await import('../src/main/logger.js');
    try {
      await connection.connect();
      expect((logWarn as unknown as { mock: { calls: string[][] } }).mock.calls
        .map(call => String(call[0])).filter(line => line.includes('same Secure Tunnel ID')),
        'distinct IDs were reported as shared').toEqual([]);
    } finally {
      await connection.disconnect();
      Object.assign(mocks.config.tunnel, { tunnelId: '', pluginsTunnelId: '', desktopTunnelId: '' });
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

  it('describes configured optional connectors before connecting and follows capability changes while offline', async () => {
    mocks.config.tunnel.kind = 'openai';
    mocks.config.tunnel.tunnelId = 'tunnel_core';
    mocks.config.tunnel.desktopTunnelId = 'tunnel_desktop';
    mocks.config.tunnel.pluginsTunnelId = 'tunnel_plugins';
    mocks.caps.screen = true;
    const { PluginManager } = await import('../src/main/plugins/manager.js');
    const catalog = vi.spyOn(PluginManager.prototype, 'tools').mockReturnValue([
      { name: 'offline_catalog_tool', description: 'Retained test catalog', inputSchema: { type: 'object' } }
    ]);
    try {
      const connection = await import('../src/main/connection.js');
      const before = connection.getStatus();
      expect(before.state).toBe('disconnected');
      expect(before.surfaces.map(surface => surface.id)).toEqual(['core', 'desktop', 'plugins']);
      expect(before.surfaces.find(surface => surface.id === 'desktop')).toMatchObject({ available: true, state: 'off', localUrl: null });
      expect(before.surfaces.find(surface => surface.id === 'desktop')!.tools.length).toBeGreaterThan(0);
      expect(before.surfaces.find(surface => surface.id === 'plugins')).toMatchObject({ available: true, state: 'off', tools: ['offline_catalog_tool'] });
      mocks.caps.screen = false;
      catalog.mockReturnValue([]);
      const after = connection.getStatus();
      expect(after.surfaces.find(surface => surface.id === 'desktop')).toMatchObject({ available: false, tools: [] });
      expect(after.surfaces.find(surface => surface.id === 'plugins')!.tools).toEqual([]);
      expect(mocks.starts).toBe(0);
      expect(mocks.endpointStartReached).not.toHaveBeenCalled();
    } finally { catalog.mockRestore(); }
  });

  it('refuses revoked connection authority when its lifecycle queue begins', async () => {
    const connection = await import('../src/main/connection.js');
    let current = true;
    const pending = connection.connect(() => current);
    current = false; await pending;
    expect(mocks.endpointStartReached).not.toHaveBeenCalled(); expect(mocks.starts).toBe(0);
    expect(connection.getStatus().state).toBe('disconnected');
  });

  it.each(['endpoint', 'secret'])('retires startup resources when connection authority changes during %s startup', async boundary => {
    const connection = await import('../src/main/connection.js');
    let current = true, release!: () => void, reached!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    if (boundary === 'endpoint') { mocks.endpointStartGate = gate; mocks.endpointStartReached.mockImplementationOnce(reached); }
    else { mocks.secretGate = gate; mocks.secretReached.mockImplementationOnce(reached); }
    const pending = connection.connect(() => current); await started;
    current = false; release(); await pending;
    expect(mocks.starts).toBe(0); expect(mocks.endpointStop).toHaveBeenCalledTimes(1);
    expect(connection.getStatus()).toMatchObject({ state: 'disconnected', localUrl: null, publicUrl: null });
  });

  it('keeps connected health reports owned by the connection after startup authority ends', async () => {
    const connection = await import('../src/main/connection.js');
    let current = true;
    await connection.connect(() => current);
    current = false;
    mocks.report?.({ state: 'offline', detail: 'A later connection health report' });
    expect(connection.getStatus().state).toBe('offline');
    await connection.disconnect();
  });

  it('does not start another connection when authority is revoked during the previous drain', async () => {
    const connection = await import('../src/main/connection.js');
    await connection.connect();
    mocks.report?.({ state: 'auth-failed', detail: 'Retry needs a new connection' });
    let current = true, release!: () => void, reached!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    mocks.endpointStop.mockImplementationOnce(async () => { reached(); await gate; });
    const pending = connection.connect(() => current); await started;
    current = false; release(); await pending;
    expect(mocks.endpointStartReached).toHaveBeenCalledTimes(1); expect(mocks.starts).toBe(1);
    expect(connection.getStatus().state).toBe('disconnected');
  });

  it('stops a late tunnel handle and refuses its report after startup authority is revoked', async () => {
    const connection = await import('../src/main/connection.js');
    let current = true, release!: () => void, reached!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    mocks.tunnelStartGate = new Promise<void>(resolve => { release = resolve; });
    mocks.tunnelStartReached.mockImplementationOnce(reached);
    const pending = connection.connect(() => current); await started;
    current = false; release(); await pending;
    expect(mocks.tunnelStop).toHaveBeenCalledTimes(1);
    expect(connection.getStatus().state).toBe('disconnected');
  });

  it('refuses a late optional tunnel report and retires both handles after startup authority changes', async () => {
    mocks.config.tunnel.kind = 'openai';
    mocks.config.tunnel.tunnelId = 'tunnel_core';
    mocks.config.tunnel.pluginsTunnelId = 'tunnel_plugins';
    const connection = await import('../src/main/connection.js');
    let current = true, release!: () => void, reached!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    mocks.optionalStartGate = new Promise<void>(resolve => { release = resolve; });
    mocks.optionalStartReached.mockImplementationOnce(reached);
    const lateReports: string[] = [];
    const unsubscribe = connection.onStatusChange(status => {
      if (!current && status.surfaces.find(surface => surface.id === 'plugins')?.state === 'live') lateReports.push('live');
    });
    try {
      const pending = connection.connect(() => current); await started;
      current = false; release(); await pending;
      expect(lateReports).toEqual([]);
      expect(mocks.tunnelStop).toHaveBeenCalledTimes(2);
      expect(connection.getStatus().state).toBe('disconnected');
    } finally { unsubscribe(); }
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

// #924 / #1401: with the option on, a restart serves the same connector URLs.
describe('persistent connector URLs', () => {
  it('starts on the kept tokens and remembers the running ones only when the option is on', async () => {
    // A fresh connection module: earlier tests in this file end in a final shutdown.
    vi.resetModules();
    const connection = await import('../src/main/connection.js');
    const { startMcpServer } = await import('../src/main/mcp/server.js');
    const start = vi.mocked(startMcpServer);
    paths.kept = { core: 'k'.repeat(43) }; paths.port = 50123; paths.remembered.length = 0;
    mocks.config.mcp.persistentUrls = true;
    await connection.connect();
    expect(start.mock.calls.at(-1)![1]).toEqual({ core: 'k'.repeat(43) });
    // The kept local port too (#1550): a tunnel of the user's own points at it.
    expect(start.mock.calls.at(-1)![2]).toEqual({ port: 50123 });
    expect(paths.remembered.at(-1)).toMatchObject({ core: 'http://127.0.0.1:45678/mcp/core/core-token' });
    await connection.disconnect();
    mocks.config.mcp.persistentUrls = false; paths.remembered.length = 0;
    await connection.connect();
    expect(start.mock.calls.at(-1)![1]).toEqual({});
    expect(start.mock.calls.at(-1)![2]).toEqual({});
    expect(paths.remembered).toEqual([]);
    await connection.disconnect();
  });

  // #1733 edge: the kept port can be taken by another program; the endpoint then listens on
  // another one, and a tunnel of the user's own still points at the old one until they change it.
  it('says when the kept port was taken and the endpoint moved, and clears that on disconnect', async () => {
    vi.resetModules();
    const connection = await import('../src/main/connection.js');
    paths.kept = { core: 'k'.repeat(43) }; paths.port = 50123;
    mocks.config.mcp.persistentUrls = true;
    try {
      await connection.connect();
      expect(connection.getStatus().keptPortMoved).toEqual({ from: 50123, to: 45678 });
      await connection.disconnect();
      expect(connection.getStatus().keptPortMoved).toBeNull();
      paths.port = 45678;
      await connection.connect();
      expect(connection.getStatus().keptPortMoved).toBeNull();
      await connection.disconnect();
    } finally { mocks.config.mcp.persistentUrls = false; }
  });
});

