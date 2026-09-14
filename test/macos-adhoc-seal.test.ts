import { beforeEach, expect, it, vi } from 'vitest';
const ports = vi.hoisted(() => ({ spawn: vi.fn(), exists: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: ports.spawn }));
vi.mock('node:fs', () => ({ existsSync: ports.exists }));
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import seal from '../scripts/afterpack-macos-adhoc-seal.mjs';
const context = { electronPlatformName: 'darwin', appOutDir: '/package', packager: { appInfo: { productFilename: 'Chat On Steroids' } } };
const mediaKeys = [
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
  'NSAudioCaptureUsageDescription'
];
let presentMediaKeys: Set<string>;

function successfulSpawn(command: string, args: string[]) {
  if (command === 'plutil') {
    if (args[0] === '-lint') return { status: 0, stdout: '', stderr: '' };
    const key = args[1] ?? '';
    if (args[0] === '-extract') {
      return presentMediaKeys.has(key)
        ? { status: 0, stdout: 'unused declaration', stderr: '' }
        : { status: 1, stdout: '', stderr: `No value at that key path or invalid key path: ${key}` };
    }
    if (args[0] === '-remove') {
      presentMediaKeys.delete(key);
      return { status: 0, stdout: '', stderr: '' };
    }
  }
  return { status: 0, stdout: '',
    stderr: args.includes('--display') ? 'Identifier=com.chatonsteroids.app\nSignature=adhoc\nTeamIdentifier=not set\n' : '' };
}

beforeEach(() => {
  vi.resetAllMocks();
  presentMediaKeys = new Set(mediaKeys);
  ports.exists.mockReturnValue(true);
  ports.spawn.mockImplementation(successfulSpawn);
});
it.each(['win32', 'linux'])('does not run macOS signing on %s', async platform => {
  await seal({ ...context, electronPlatformName: platform });
  expect(ports.spawn).not.toHaveBeenCalled();
});
it('removes Electron media privacy declarations before sealing the bundle', async () => {
  await expect(seal(context)).resolves.toBeUndefined();
  expect(presentMediaKeys).toEqual(new Set());
  expect(ports.spawn.mock.calls.filter(call => call[0] === 'plutil' && call[1][0] === '-remove').map(call => call[1][1]))
    .toEqual(mediaKeys);
});
it('accepts successful signature details on stderr after strict verification', async () => {
  await expect(seal(context)).resolves.toBeUndefined();
  expect(ports.spawn.mock.calls.filter(call => call[0] === 'codesign').map(call => call[1].slice(0, 2))).toEqual([
    ['--force', '--deep'], ['--verify', '--deep'], ['--display', '--verbose=4']
  ]);
});
it('fails packaging when verification fails or signing has no resource envelope', async () => {
  ports.spawn.mockImplementation((command: string, args: string[]) => {
    const result = successfulSpawn(command, args);
    return command === 'codesign' && args.includes('--verify')
      ? { status: 1, stdout: '', stderr: 'invalid resource seal' }
      : result;
  });
  await expect(seal(context)).rejects.toThrow('invalid resource seal');
  expect(ports.spawn.mock.calls.filter(call => call[0] === 'codesign')).toHaveLength(2);

  vi.clearAllMocks();
  presentMediaKeys = new Set(mediaKeys);
  ports.exists.mockReturnValueOnce(true).mockReturnValueOnce(false);
  ports.spawn.mockImplementation(successfulSpawn);
  await expect(seal(context)).rejects.toThrow('no bundle CodeResources');
});
it('rejects a TeamIdentifier even if codesign reports adhoc', async () => {
  ports.spawn.mockImplementation((command: string, args: string[]) => {
    const result = successfulSpawn(command, args);
    return command === 'codesign' && args.includes('--display')
      ? { status: 0, stdout: '', stderr: 'Signature=adhoc\nTeamIdentifier=TEAM123\n' }
      : result;
  });
  await expect(seal(context)).rejects.toThrow('trust-bearing');
});
