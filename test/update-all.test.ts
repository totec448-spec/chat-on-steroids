import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SurfaceStatus, UpdateStatus } from '../src/shared/types.js';
import { APP_VERSION } from '../src/main/version.js';
import * as configOwner from '../src/main/config.js';
import { faultGate } from './helpers.js';
const newerVersion = APP_VERSION.replace(/\d+$/, value => String(Number(value) + 1));

const owners = vi.hoisted(() => ({ check: vi.fn(), status: vi.fn(), mark: vi.fn(),
  request: vi.fn(), resume: vi.fn(), requested: vi.fn(), bridge: vi.fn(), connect: vi.fn(), wake: vi.fn(), surfaces: vi.fn() }));
vi.mock('../src/main/update.js', () => ({ checkForUpdates: owners.check, updateStatus: owners.status,
  markInstallOnQuit: owners.mark, manualDownloadUrl: (version: string) => `https://example.test/${version}` }));
vi.mock('../src/main/plugin-refresh.js', () => ({ requestPluginRefreshes: owners.request,
  hasRequestedPluginRefresh: owners.requested, consumeRequestedPluginRefreshStartup: owners.resume }));
vi.mock('../src/main/bridge.js', () => ({ startBridge: owners.bridge }));
vi.mock('../src/main/connection.js', () => ({ connect: owners.connect, getStatus: () => ({ surfaces: owners.surfaces() }) }));
vi.mock('../src/main/browser-wake.js', () => ({ wakeBrowserWork: owners.wake }));
const { updateAll, resumeUpdateRefresh } = await import('../src/main/update-all.js');
const quit = vi.fn(), manual = vi.fn(), confirmRestart = vi.fn();
let status: UpdateStatus;
beforeEach(() => {
  vi.clearAllMocks();
  status = { current: APP_VERSION, latest: null, stage: 'idle', checkedAt: 1, error: null };
  owners.status.mockImplementation(() => ({ ...status }));
  owners.check.mockResolvedValue(undefined); owners.request.mockResolvedValue(undefined);
  owners.bridge.mockResolvedValue(true); owners.connect.mockResolvedValue(undefined);
  owners.mark.mockReturnValue(true); owners.resume.mockResolvedValue(false);
  owners.requested.mockResolvedValue(true);
  owners.surfaces.mockReturnValue([]);
  manual.mockResolvedValue(undefined);
  confirmRestart.mockResolvedValue(true);
});
afterEach(() => { vi.restoreAllMocks(); });
it('joins double clicks and persists connector intent before the normal installer shutdown', async () => {
  status.latest = newerVersion; status.stage = 'ready';
  let release!: () => void;
  owners.check.mockReturnValueOnce(new Promise<void>(resolve => { release = resolve; }));
  const first = updateAll(quit, manual, confirmRestart), second = updateAll(quit, manual, confirmRestart);
  expect(first).toBe(second); expect(quit).not.toHaveBeenCalled();
  release(); expect(await first).toBe('restarting');
  expect(owners.check).toHaveBeenCalledTimes(1);
  expect(owners.request).toHaveBeenCalledExactlyOnceWith(newerVersion, ['core']);
  expect(owners.request.mock.invocationCallOrder[0]).toBeLessThan(owners.mark.mock.invocationCallOrder[0]!);
  expect(quit).toHaveBeenCalledTimes(1); expect(manual).not.toHaveBeenCalled();
});
it('refreshes connected components even when the app is already current', async () => {
  expect(await updateAll(quit, manual, confirmRestart)).toBe('checking-connectors');
  expect(owners.bridge).toHaveBeenCalledTimes(1); expect(owners.connect).toHaveBeenCalledTimes(1);
  expect(owners.request).toHaveBeenCalledExactlyOnceWith(APP_VERSION, ['core']);
  expect(owners.wake).toHaveBeenCalled(); expect(quit).not.toHaveBeenCalled();
});
it('applies a staged app update without requiring a working connector connection', async () => {
  status.latest = newerVersion; status.stage = 'ready';
  owners.connect.mockRejectedValue(new Error('Tunnel authentication unavailable'));
  expect(await updateAll(quit, manual, confirmRestart)).toBe('restarting');
  expect(owners.bridge).not.toHaveBeenCalled(); expect(owners.connect).not.toHaveBeenCalled();
  expect(owners.request).toHaveBeenCalledExactlyOnceWith(newerVersion, ['core']);
  expect(quit).toHaveBeenCalledTimes(1);
});
it('opens the supported manual app download without pretending to install it', async () => {
  status.latest = newerVersion;
  expect(await updateAll(quit, manual, confirmRestart)).toBe('manual');
  expect(manual).toHaveBeenCalledExactlyOnceWith(`https://example.test/${newerVersion}`);
  expect(owners.request).toHaveBeenCalledExactlyOnceWith(newerVersion, ['core']);
  expect(quit).not.toHaveBeenCalled(); expect(owners.mark).not.toHaveBeenCalled();
});
it('opens a manual app update even when the old bridge and tunnel cannot start', async () => {
  status.latest = newerVersion;
  owners.bridge.mockRejectedValue(new Error('Bridge unavailable'));
  owners.connect.mockRejectedValue(new Error('Tunnel unavailable'));
  expect(await updateAll(quit, manual, confirmRestart)).toBe('manual');
  expect(manual).toHaveBeenCalledExactlyOnceWith(`https://example.test/${newerVersion}`);
  expect(owners.bridge).not.toHaveBeenCalled(); expect(owners.connect).not.toHaveBeenCalled();
  expect(quit).not.toHaveBeenCalled();
});
it.each([null, newerVersion])('checks the running connectors while retaining a failed release check (last known release=%s)', async latest => {
  status.stage = 'failed'; status.error = 'Network unavailable'; status.latest = latest;
  await expect(updateAll(quit, manual, confirmRestart)).rejects.toThrow('Network unavailable');
  expect(owners.bridge).toHaveBeenCalledTimes(1); expect(owners.connect).toHaveBeenCalledTimes(1);
  expect(owners.request).toHaveBeenCalledExactlyOnceWith(APP_VERSION, ['core']);
  expect(owners.wake).toHaveBeenCalled(); expect(quit).not.toHaveBeenCalled();
  expect(manual).not.toHaveBeenCalled(); expect(owners.mark).not.toHaveBeenCalled(); expect(confirmRestart).not.toHaveBeenCalled();
  expect(status).toMatchObject({ stage: 'failed', error: 'Network unavailable' });
  status.stage = 'idle';
  status.latest = null;
  await expect(updateAll(quit, manual, confirmRestart)).resolves.toBe('checking-connectors');
});
it('asks the app for restart approval after downloading, joins concurrent presses and changes nothing until approved', async () => {
  owners.check.mockImplementationOnce(async () => { status.latest = newerVersion; status.stage = 'ready'; });
  const approval = faultGate();
  confirmRestart.mockImplementationOnce(async () => { await approval.hold(); return false; });
  const first = updateAll(quit, manual, confirmRestart);
  await approval.entered;
  expect(updateAll(quit, manual, confirmRestart)).toBe(first);
  expect(confirmRestart).toHaveBeenCalledExactlyOnceWith(newerVersion);
  expect(owners.request).not.toHaveBeenCalled(); expect(owners.mark).not.toHaveBeenCalled(); expect(quit).not.toHaveBeenCalled();
  // Not approved yet: the app asks the person in its own dialog and calls again with that version.
  approval.release(); expect(await first).toBe('confirm');
  expect(owners.request).not.toHaveBeenCalled(); expect(owners.mark).not.toHaveBeenCalled(); expect(quit).not.toHaveBeenCalled();
  expect(await updateAll(quit, manual, confirmRestart)).toBe('restarting');
  expect(confirmRestart).toHaveBeenCalledTimes(2); expect(quit).toHaveBeenCalledTimes(1);
});
it('does not quit when durable authorization cannot be committed or no installer remains', async () => {
  status.latest = newerVersion; status.stage = 'ready';
  owners.request.mockRejectedValueOnce(new Error('Disk full'));
  await expect(updateAll(quit, manual, confirmRestart)).rejects.toThrow('Disk full');
  expect(owners.mark).not.toHaveBeenCalled(); expect(quit).not.toHaveBeenCalled();
  owners.mark.mockReturnValue(false);
  await expect(updateAll(quit, manual, confirmRestart)).rejects.toThrow(/downloaded update/i);
  expect(quit).not.toHaveBeenCalled();
});
it('commits authorization before opening a manual download and permits retry after an open failure', async () => {
  status.latest = newerVersion;
  owners.request.mockRejectedValueOnce(new Error('Disk full'));
  await expect(updateAll(quit, manual, confirmRestart)).rejects.toThrow('Disk full');
  expect(manual).not.toHaveBeenCalled();
  manual.mockRejectedValueOnce(new Error('Browser unavailable'));
  await expect(updateAll(quit, manual, confirmRestart)).rejects.toThrow('Browser unavailable');
  expect(owners.request.mock.invocationCallOrder[1]).toBeLessThan(manual.mock.invocationCallOrder[0]!);
  await expect(updateAll(quit, manual, confirmRestart)).resolves.toBe('manual');
  expect(manual).toHaveBeenCalledTimes(2);
  expect(quit).not.toHaveBeenCalled(); expect(owners.mark).not.toHaveBeenCalled();
});
it.each([
  { kind: 'openai', desktopTunnelId: 'tunnel_desktop', pluginsTunnelId: 'tunnel_plugins', expected: ['core', 'desktop', 'plugins'] },
  { kind: 'openai', desktopTunnelId: '', pluginsTunnelId: '', expected: ['core'] },
  { kind: 'manual', desktopTunnelId: '', pluginsTunnelId: '', expected: ['core', 'desktop', 'plugins'] }
] as const)('retains only configured useful connector targets for a $kind app update', async ({ kind, desktopTunnelId, pluginsTunnelId, expected }) => {
  status.latest = newerVersion;
  const original = configOwner.getConfig();
  vi.spyOn(configOwner, 'getConfig').mockReturnValue({ ...original, tunnel: { ...original.tunnel, kind, desktopTunnelId, pluginsTunnelId } });
  const surface = (id: SurfaceStatus['id'], available = true, tools = ['tool']): Pick<SurfaceStatus, 'id' | 'available' | 'tools'> => ({ id, available, tools });
  owners.surfaces.mockReturnValue([surface('core'), surface('desktop'), surface('plugins')]);
  await updateAll(quit, manual, confirmRestart);
  expect(owners.request).toHaveBeenLastCalledWith(newerVersion, expected);
  owners.surfaces.mockReturnValue([surface('core'), surface('desktop', false), surface('plugins', true, [])]);
  await updateAll(quit, manual, confirmRestart);
  expect(owners.request).toHaveBeenLastCalledWith(newerVersion, ['core']);
});
it('resumes only accepted refresh work after restart, without installing or changing settings', async () => {
  await resumeUpdateRefresh(); expect(owners.connect).not.toHaveBeenCalled();
  owners.resume.mockResolvedValue(true);
  await resumeUpdateRefresh();
  expect(owners.bridge).toHaveBeenCalledTimes(1); expect(owners.connect).toHaveBeenCalledTimes(1);
  expect(owners.check).not.toHaveBeenCalled(); expect(owners.mark).not.toHaveBeenCalled();
});
it('commits the one startup attempt before starting bridge or connection work', async () => {
  let release!: (accepted: boolean) => void;
  owners.resume.mockReturnValueOnce(new Promise<boolean>(resolve => { release = resolve; }));
  const startup = resumeUpdateRefresh();
  expect(owners.resume).toHaveBeenCalledTimes(1);
  expect(owners.bridge).not.toHaveBeenCalled(); expect(owners.connect).not.toHaveBeenCalled();
  release(true); await startup;
  expect(owners.bridge).toHaveBeenCalledTimes(1); expect(owners.connect).toHaveBeenCalledTimes(1);
  expect(owners.requested).not.toHaveBeenCalled();
});
it('does not connect or wake after an uncommitted startup reservation', async () => {
  owners.resume.mockRejectedValueOnce(new Error('Could not save refresh state'));
  await expect(resumeUpdateRefresh()).rejects.toThrow('Could not save refresh state');
  expect(owners.bridge).not.toHaveBeenCalled(); expect(owners.connect).not.toHaveBeenCalled(); expect(owners.wake).not.toHaveBeenCalled();
});
it('does not connect again on the next startup after an accepted attempt fails', async () => {
  owners.resume.mockResolvedValueOnce(true);
  owners.connect.mockRejectedValueOnce(new Error('Tunnel authentication unavailable'));
  await expect(resumeUpdateRefresh()).rejects.toThrow('Tunnel authentication unavailable');
  await resumeUpdateRefresh();
  expect(owners.bridge).toHaveBeenCalledTimes(1); expect(owners.connect).toHaveBeenCalledTimes(1);
  expect(owners.wake).not.toHaveBeenCalled();
});
it.each([
  { boundary: 'reservation', revisit: false }, { boundary: 'bridge', revisit: false },
  { boundary: 'reservation', revisit: true }, { boundary: 'bridge', revisit: true }
])('does not lend a startup reservation to another tunnel while awaiting $boundary (A-B-A=$revisit)', async ({ boundary, revisit }) => {
  const base = configOwner.getConfig();
  let config = { ...base, tunnel: { ...base.tunnel, tunnelId: 'tunnel_scope_a', profileEpoch: 1 } };
  vi.spyOn(configOwner, 'getConfig').mockImplementation(() => config);
  let release!: () => void, reached!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  if (boundary === 'reservation') owners.resume.mockImplementationOnce(async () => { reached(); await gate; return true; });
  else {
    owners.resume.mockResolvedValueOnce(true);
    owners.bridge.mockImplementationOnce(async () => { reached(); await gate; });
  }
  const startup = resumeUpdateRefresh(); await started;
  config = { ...config, tunnel: { ...config.tunnel, tunnelId: 'tunnel_scope_b', profileEpoch: 2 } };
  if (revisit) config = { ...config, tunnel: { ...config.tunnel, tunnelId: 'tunnel_scope_a', profileEpoch: 1 } };
  release(); await startup;
  expect(owners.connect).not.toHaveBeenCalled(); expect(owners.wake).not.toHaveBeenCalled();
  if (boundary === 'reservation') expect(owners.bridge).not.toHaveBeenCalled();
});
