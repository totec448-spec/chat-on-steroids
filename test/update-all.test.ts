import { beforeEach, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '../src/shared/types.js';

const owners = vi.hoisted(() => ({ check: vi.fn(), status: vi.fn(), mark: vi.fn(),
  request: vi.fn(), resume: vi.fn(), bridge: vi.fn(), connect: vi.fn(), wake: vi.fn() }));
vi.mock('../src/main/update.js', () => ({ checkForUpdates: owners.check, updateStatus: owners.status,
  markInstallOnQuit: owners.mark, manualDownloadUrl: (version: string) => `https://example.test/${version}` }));
vi.mock('../src/main/plugin-refresh.js', () => ({ requestPluginRefreshes: owners.request, hasRequestedPluginRefresh: owners.resume }));
vi.mock('../src/main/bridge.js', () => ({ startBridge: owners.bridge }));
vi.mock('../src/main/connection.js', () => ({ connect: owners.connect }));
vi.mock('../src/main/browser-wake.js', () => ({ wakeBrowserWork: owners.wake }));
const { updateAll, resumeUpdateRefresh } = await import('../src/main/update-all.js');
const quit = vi.fn(), manual = vi.fn();
let status: UpdateStatus;
beforeEach(() => {
  vi.clearAllMocks();
  status = { current: '2.1.31', latest: null, stage: 'idle', checkedAt: 1, error: null };
  owners.status.mockImplementation(() => ({ ...status }));
  owners.check.mockResolvedValue(undefined); owners.request.mockResolvedValue(undefined);
  owners.bridge.mockResolvedValue(true); owners.connect.mockResolvedValue(undefined);
  owners.mark.mockReturnValue(true); owners.resume.mockResolvedValue(false);
  manual.mockResolvedValue(undefined);
});
it('joins double clicks and persists connector intent before the normal installer shutdown', async () => {
  status.latest = '2.1.32'; status.stage = 'ready';
  let release!: () => void;
  owners.check.mockReturnValueOnce(new Promise<void>(resolve => { release = resolve; }));
  const first = updateAll(quit, manual), second = updateAll(quit, manual);
  expect(first).toBe(second); expect(quit).not.toHaveBeenCalled();
  release(); expect(await first).toBe('restarting');
  expect(owners.check).toHaveBeenCalledTimes(1);
  expect(owners.request).toHaveBeenCalledExactlyOnceWith('2.1.32');
  expect(owners.request.mock.invocationCallOrder[0]).toBeLessThan(owners.mark.mock.invocationCallOrder[0]!);
  expect(quit).toHaveBeenCalledTimes(1); expect(manual).not.toHaveBeenCalled();
});
it('refreshes connected components even when the app is already current', async () => {
  expect(await updateAll(quit, manual)).toBe('checking-connectors');
  expect(owners.bridge).toHaveBeenCalledTimes(1); expect(owners.connect).toHaveBeenCalledTimes(1);
  expect(owners.request).toHaveBeenCalledExactlyOnceWith('2.1.31');
  expect(owners.wake).toHaveBeenCalled(); expect(quit).not.toHaveBeenCalled();
});
it('opens the supported manual app download without pretending to install it', async () => {
  status.latest = '2.1.32';
  expect(await updateAll(quit, manual)).toBe('manual');
  expect(manual).toHaveBeenCalledExactlyOnceWith('https://example.test/2.1.32');
  expect(owners.request).toHaveBeenCalledExactlyOnceWith('2.1.32');
  expect(quit).not.toHaveBeenCalled(); expect(owners.mark).not.toHaveBeenCalled();
});
it('does not quit or grant browser work after a failed release check', async () => {
  status.stage = 'failed'; status.error = 'Network unavailable';
  await expect(updateAll(quit, manual)).rejects.toThrow('Network unavailable');
  expect(owners.request).not.toHaveBeenCalled(); expect(quit).not.toHaveBeenCalled();
  status.stage = 'idle';
  await expect(updateAll(quit, manual)).resolves.toBe('checking-connectors');
});
it('does not quit when durable authorization cannot be committed or no installer remains', async () => {
  status.latest = '2.1.32'; status.stage = 'ready';
  owners.request.mockRejectedValueOnce(new Error('Disk full'));
  await expect(updateAll(quit, manual)).rejects.toThrow('Disk full');
  expect(owners.mark).not.toHaveBeenCalled(); expect(quit).not.toHaveBeenCalled();
  owners.mark.mockReturnValue(false);
  await expect(updateAll(quit, manual)).rejects.toThrow(/downloaded update/i);
  expect(quit).not.toHaveBeenCalled();
});
it('resumes only accepted refresh work after restart, without installing or changing settings', async () => {
  await resumeUpdateRefresh(); expect(owners.connect).not.toHaveBeenCalled();
  owners.resume.mockResolvedValue(true);
  await resumeUpdateRefresh();
  expect(owners.bridge).toHaveBeenCalledTimes(1); expect(owners.connect).toHaveBeenCalledTimes(1);
  expect(owners.check).not.toHaveBeenCalled(); expect(owners.mark).not.toHaveBeenCalled();
});
