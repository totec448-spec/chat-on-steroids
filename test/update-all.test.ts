import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SurfaceStatus, UpdateStatus } from '../src/shared/types.js';
import { APP_VERSION } from '../src/main/version.js';
import * as configOwner from '../src/main/config.js';
const newerVersion = APP_VERSION.replace(/\d+$/, value => String(Number(value) + 1));

const owners = vi.hoisted(() => ({ check: vi.fn(), status: vi.fn(), mark: vi.fn(),
  request: vi.fn(), resume: vi.fn(), bridge: vi.fn(), connect: vi.fn(), wake: vi.fn(), surfaces: vi.fn() }));
vi.mock('../src/main/update.js', () => ({ checkForUpdates: owners.check, updateStatus: owners.status,
  markInstallOnQuit: owners.mark, manualDownloadUrl: (version: string) => `https://example.test/${version}` }));
vi.mock('../src/main/plugin-refresh.js', () => ({ requestPluginRefreshes: owners.request, hasRequestedPluginRefresh: owners.resume }));
vi.mock('../src/main/bridge.js', () => ({ startBridge: owners.bridge }));
vi.mock('../src/main/connection.js', () => ({ connect: owners.connect, getStatus: () => ({ surfaces: owners.surfaces() }) }));
vi.mock('../src/main/browser-wake.js', () => ({ wakeBrowserWork: owners.wake }));
const { updateAll, resumeUpdateRefresh } = await import('../src/main/update-all.js');
const quit = vi.fn(), manual = vi.fn();
let status: UpdateStatus;
beforeEach(() => {
  vi.clearAllMocks();
  status = { current: APP_VERSION, latest: null, stage: 'idle', checkedAt: 1, error: null };
  owners.status.mockImplementation(() => ({ ...status }));
  owners.check.mockResolvedValue(undefined); owners.request.mockResolvedValue(undefined);
  owners.bridge.mockResolvedValue(true); owners.connect.mockResolvedValue(undefined);
  owners.mark.mockReturnValue(true); owners.resume.mockResolvedValue(false);
  owners.surfaces.mockReturnValue([]);
  manual.mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); });
it('joins double clicks and persists connector intent before the normal installer shutdown', async () => {
  status.latest = newerVersion; status.stage = 'ready';
  let release!: () => void;
  owners.check.mockReturnValueOnce(new Promise<void>(resolve => { release = resolve; }));
  const first = updateAll(quit, manual), second = updateAll(quit, manual);
  expect(first).toBe(second); expect(quit).not.toHaveBeenCalled();
  release(); expect(await first).toBe('restarting');
  expect(owners.check).toHaveBeenCalledTimes(1);
  expect(owners.request).toHaveBeenCalledExactlyOnceWith(newerVersion, ['core']);
  expect(owners.request.mock.invocationCallOrder[0]).toBeLessThan(owners.mark.mock.invocationCallOrder[0]!);
  expect(quit).toHaveBeenCalledTimes(1); expect(manual).not.toHaveBeenCalled();
});
it('refreshes connected components even when the app is already current', async () => {
  expect(await updateAll(quit, manual)).toBe('checking-connectors');
  expect(owners.bridge).toHaveBeenCalledTimes(1); expect(owners.connect).toHaveBeenCalledTimes(1);
  expect(owners.request).toHaveBeenCalledExactlyOnceWith(APP_VERSION, ['core']);
  expect(owners.wake).toHaveBeenCalled(); expect(quit).not.toHaveBeenCalled();
});
it('applies a staged app update without requiring a working connector connection', async () => {
  status.latest = newerVersion; status.stage = 'ready';
  owners.connect.mockRejectedValue(new Error('Tunnel authentication unavailable'));
  expect(await updateAll(quit, manual)).toBe('restarting');
  expect(owners.bridge).not.toHaveBeenCalled(); expect(owners.connect).not.toHaveBeenCalled();
  expect(owners.request).toHaveBeenCalledExactlyOnceWith(newerVersion, ['core']);
  expect(quit).toHaveBeenCalledTimes(1);
});
it('opens the supported manual app download without pretending to install it', async () => {
  status.latest = newerVersion;
  expect(await updateAll(quit, manual)).toBe('manual');
  expect(manual).toHaveBeenCalledExactlyOnceWith(`https://example.test/${newerVersion}`);
  expect(owners.request).toHaveBeenCalledExactlyOnceWith(newerVersion, ['core']);
  expect(quit).not.toHaveBeenCalled(); expect(owners.mark).not.toHaveBeenCalled();
});
it('opens a manual app update even when the old bridge and tunnel cannot start', async () => {
  status.latest = newerVersion;
  owners.bridge.mockRejectedValue(new Error('Bridge unavailable'));
  owners.connect.mockRejectedValue(new Error('Tunnel unavailable'));
  expect(await updateAll(quit, manual)).toBe('manual');
  expect(manual).toHaveBeenCalledExactlyOnceWith(`https://example.test/${newerVersion}`);
  expect(owners.bridge).not.toHaveBeenCalled(); expect(owners.connect).not.toHaveBeenCalled();
  expect(quit).not.toHaveBeenCalled();
});
it('does not quit or grant browser work after a failed release check', async () => {
  status.stage = 'failed'; status.error = 'Network unavailable';
  await expect(updateAll(quit, manual)).rejects.toThrow('Network unavailable');
  expect(owners.request).not.toHaveBeenCalled(); expect(quit).not.toHaveBeenCalled();
  status.stage = 'idle';
  await expect(updateAll(quit, manual)).resolves.toBe('checking-connectors');
});
it('does not quit when durable authorization cannot be committed or no installer remains', async () => {
  status.latest = newerVersion; status.stage = 'ready';
  owners.request.mockRejectedValueOnce(new Error('Disk full'));
  await expect(updateAll(quit, manual)).rejects.toThrow('Disk full');
  expect(owners.mark).not.toHaveBeenCalled(); expect(quit).not.toHaveBeenCalled();
  owners.mark.mockReturnValue(false);
  await expect(updateAll(quit, manual)).rejects.toThrow(/downloaded update/i);
  expect(quit).not.toHaveBeenCalled();
});
it('commits authorization before opening a manual download and permits retry after an open failure', async () => {
  status.latest = newerVersion;
  owners.request.mockRejectedValueOnce(new Error('Disk full'));
  await expect(updateAll(quit, manual)).rejects.toThrow('Disk full');
  expect(manual).not.toHaveBeenCalled();
  manual.mockRejectedValueOnce(new Error('Browser unavailable'));
  await expect(updateAll(quit, manual)).rejects.toThrow('Browser unavailable');
  expect(owners.request.mock.invocationCallOrder[1]).toBeLessThan(manual.mock.invocationCallOrder[0]!);
  await expect(updateAll(quit, manual)).resolves.toBe('manual');
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
  await updateAll(quit, manual);
  expect(owners.request).toHaveBeenLastCalledWith(newerVersion, expected);
  owners.surfaces.mockReturnValue([surface('core'), surface('desktop', false), surface('plugins', true, [])]);
  await updateAll(quit, manual);
  expect(owners.request).toHaveBeenLastCalledWith(newerVersion, ['core']);
});
it('resumes only accepted refresh work after restart, without installing or changing settings', async () => {
  await resumeUpdateRefresh(); expect(owners.connect).not.toHaveBeenCalled();
  owners.resume.mockResolvedValue(true);
  await resumeUpdateRefresh();
  expect(owners.bridge).toHaveBeenCalledTimes(1); expect(owners.connect).toHaveBeenCalledTimes(1);
  expect(owners.check).not.toHaveBeenCalled(); expect(owners.mark).not.toHaveBeenCalled();
});
