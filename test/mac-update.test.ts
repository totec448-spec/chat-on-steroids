import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import path from 'node:path';

const fixture = vi.hoisted(() => ({
  command: vi.fn(), access: vi.fn(), log: vi.fn(), warn: vi.fn(), exit: vi.fn(),
  packaged: true, native: null as any, feed: '', check: vi.fn(), quit: vi.fn()
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  fixture.native = Object.assign(new EventEmitter(), {
    setFeedURL: ({ url }: { url: string }) => { fixture.feed = url; },
    checkForUpdates: fixture.check, quitAndInstall: fixture.quit
  });
  return { app: { get isPackaged() { return fixture.packaged; }, exit: fixture.exit }, autoUpdater: fixture.native };
});
vi.mock('node:child_process', () => ({ execFile: fixture.command }));
vi.mock('node:fs/promises', () => ({ access: fixture.access, constants: { W_OK: 2 } }));
vi.mock('../src/main/logger.js', () => ({ logInfo: fixture.log, logWarn: fixture.warn }));
const platform = process.platform, executable = process.execPath;
let adapter: typeof import('../src/main/mac-update.js');
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.packaged = true;
  fixture.access.mockResolvedValue(undefined);
  fixture.command.mockImplementation((_file, _args, _options, done) => done(null));
  fixture.check.mockImplementation(() => undefined);
  fixture.quit.mockImplementation(() => undefined);
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  Object.defineProperty(process, 'execPath', { value: path.join('/Applications', 'Chat On Steroids.app', 'Contents', 'MacOS', 'Chat On Steroids'), configurable: true });
  adapter = await import('../src/main/mac-update.js');
  fixture.native.removeAllListeners();
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'execPath', { value: executable, configurable: true });
});

it('requires a writable, Developer ID signed, Gatekeeper-assessed packaged app; caches the result', async () => {
  expect(await adapter.canUpdateMac()).toBe(true);
  expect(await adapter.canUpdateMac()).toBe(true);
  expect(fixture.command.mock.calls.map(call => call[0])).toEqual(['/usr/bin/codesign', '/usr/sbin/spctl']);
  expect(fixture.command.mock.calls[0]![1].join(' ')).toContain('certificate leaf[field.1.2.840.113635.100.6.1.13] exists');
  expect(fixture.access).toHaveBeenCalledWith(path.join('/Applications'), 2);
});
it.each(['win32', 'linux'])('does not run Mac probes on %s', async value => {
  Object.defineProperty(process, 'platform', { value, configurable: true });
  expect(await adapter.canUpdateMac()).toBe(false);
  expect(fixture.command).not.toHaveBeenCalled();
});
it('never enables native updates in development or on a read-only mount', async () => {
  fixture.packaged = false;
  expect(await adapter.canUpdateMac()).toBe(false);
  fixture.packaged = true;
  fixture.access.mockRejectedValue(new Error('read-only disk image'));
  expect(await adapter.canUpdateMac()).toBe(false);
  expect(fixture.command).not.toHaveBeenCalled();
});
it.each(['/usr/bin/codesign', '/usr/sbin/spctl'])('keeps the manual path when %s refuses or times out', async file => {
  fixture.command.mockImplementation((command, _args, _options, done) => done(command === file ? new Error('untrusted private path') : null));
  expect(await adapter.canUpdateMac()).toBe(false);
  expect(fixture.log.mock.calls.flat().join(' ')).not.toContain('private path');
});
it('serves only the selected public URL and digest, and closes the loopback feed after native verification', async () => {
  const staging = adapter.stageMacUpdate('99.0.0', 'https://example.com/release.zip', 'a'.repeat(64));
  await vi.waitFor(() => expect(fixture.check).toHaveBeenCalledOnce());
  const feed = fixture.feed;
  expect(new URL(feed).hostname).toBe('127.0.0.1');
  expect(await (await fetch(feed)).json()).toEqual({ name: '99.0.0', url: 'https://example.com/release.zip', sha256: 'a'.repeat(64) });
  expect((await fetch(feed, { method: 'POST' })).status).toBe(404);
  expect((await fetch(`${feed}/other`)).status).toBe(404);
  fixture.native.emit('update-downloaded');
  await staging;
  await expect(fetch(feed)).rejects.toThrow();
  expect(fixture.native.listenerCount('update-downloaded')).toBe(0);
  expect(fixture.native.listenerCount('error')).toBe(1); // protects late native errors
  expect(fixture.quit).not.toHaveBeenCalled();
});
it.each(['error', 'update-not-available', 'sync'])('rejects %s without leaving a feed or completion listener', async event => {
  if (event === 'sync') fixture.check.mockImplementation(() => { throw new Error('native start failed'); });
  const staging = adapter.stageMacUpdate('99.0.0', 'https://example.com/release.zip', 'a'.repeat(64));
  const rejected = expect(staging).rejects.toThrow();
  await vi.waitFor(() => expect(fixture.check).toHaveBeenCalledOnce());
  if (event !== 'sync') fixture.native.emit(event, new Error('native verification failed'));
  await rejected;
  expect(fixture.native.listenerCount('update-downloaded')).toBe(0);
  await expect(fetch(fixture.feed)).rejects.toThrow();
});
it('only requests native relaunch at the final exit boundary, and exits safely on a late error', async () => {
  const staging = adapter.stageMacUpdate('99.0.0', 'https://example.com/release.zip', 'a'.repeat(64));
  await vi.waitFor(() => expect(fixture.check).toHaveBeenCalledOnce());
  fixture.native.emit('update-downloaded');
  await staging;
  adapter.restartForMacUpdate();
  expect(fixture.quit).toHaveBeenCalledOnce();
  fixture.native.emit('error', new Error('relaunch refused'));
  expect(fixture.exit).toHaveBeenCalledWith(0);
});
