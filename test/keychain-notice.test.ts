/**
 * The notice before a new macOS build's first Keychain read (src/main/keychain-notice.ts).
 */

import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'keychain'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  }
}));

const notice = await import('../src/main/keychain-notice.js');
const { getSecret, initSecretsPath, resetSecretsCacheForTests } = await import('../src/main/secrets.js');
const { safeStorage } = await import('electron');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

class FakeContents extends EventEmitter {
  sent: boolean[] = [];
  loading = false;
  isLoading(): boolean { return this.loading; }
  getURL(): string { return 'file:///index.html'; }
  isDestroyed(): boolean { return false; }
  send(channel: string, waiting: boolean): void {
    expect(channel).toBe(notice.KEYCHAIN_NOTICE_CHANNEL);
    this.sent.push(waiting);
  }
}

let dir: string;
let contents: FakeContents | null;
let build: string;

function init(platform: NodeJS.Platform = 'darwin'): void {
  notice.initKeychainNotice(dir, { platform, contents: () => contents as never, fingerprint: async () => build });
}

const settled = async (promise: Promise<unknown>): Promise<boolean> => {
  let done = false;
  void promise.then(() => { done = true; });
  // Long enough for the gate's real file reads; a gate that should wait is still waiting after it.
  await new Promise(resolve => setTimeout(resolve, 50));
  return done;
};

beforeEach(async () => {
  vi.clearAllMocks();
  dir = await makeTempDir('clf-keychain-');
  contents = new FakeContents();
  build = '2.1.27:100:1';
});

afterEach(async () => {
  vi.useRealTimers();
  await removeTempDir(dir);
});

describe('keychain notice', () => {
  it('arms the window before a new build reads the Keychain, then records the build', async () => {
    init();
    const gate = notice.beforeKeychainRead();
    // Two first callers at once share one gate: neither may reach the Keychain before the window.
    const second = notice.beforeKeychainRead();
    expect(await settled(gate)).toBe(false);
    expect(contents!.sent).toEqual([true]);
    notice.keychainNoticeReady();
    await gate;
    await second;
    await notice.afterKeychainRead(true);
    expect(contents!.sent).toEqual([true, false]);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'keychain-build.json'), 'utf8'))).toEqual({ build });

    // The same build next launch: no notice, no wait.
    contents = new FakeContents();
    init();
    await notice.beforeKeychainRead();
    await notice.afterKeychainRead(true);
    expect(contents.sent).toEqual([]);

    // An update: asked again.
    build = '2.1.28:120:2';
    init();
    const updated = notice.beforeKeychainRead();
    expect(await settled(updated)).toBe(false);
    expect(contents.sent).toEqual([true]);
    notice.keychainNoticeReady();
    await updated;
  });

  it('does not record a build the Keychain refused, so the next launch explains it again', async () => {
    init();
    const gate = notice.beforeKeychainRead();
    await vi.waitFor(() => expect(contents!.sent).toEqual([true]));
    notice.keychainNoticeReady();
    await gate;
    await notice.afterKeychainRead(false);
    expect(contents!.sent).toEqual([true, false]);
    await expect(fs.access(path.join(dir, 'keychain-build.json'))).rejects.toThrow();
  });

  it('never holds a read for a window that does not answer, or that is missing', async () => {
    vi.useFakeTimers();
    init();
    const gate = notice.beforeKeychainRead();
    await vi.waitFor(() => expect(contents!.sent).toEqual([true]));
    await vi.advanceTimersByTimeAsync(notice.RENDERER_ACK_WAIT_MS);
    await gate;

    contents = null;
    init();
    await notice.beforeKeychainRead();
    await notice.afterKeychainRead(true);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'keychain-build.json'), 'utf8'))).toEqual({ build });
  });

  it('waits for a window that is still loading, since it could not show the notice yet', async () => {
    contents!.loading = true;
    init();
    const gate = notice.beforeKeychainRead();
    expect(await settled(gate)).toBe(false);
    expect(contents!.sent).toEqual([]);
    contents!.emit('did-finish-load');
    await vi.waitFor(() => expect(contents!.sent).toEqual([true]));
    notice.keychainNoticeReady();
    await gate;
  });

  it('does nothing outside macOS', async () => {
    init('win32');
    await notice.beforeKeychainRead();
    await notice.afterKeychainRead(true);
    expect(contents!.sent).toEqual([]);
    await expect(fs.access(path.join(dir, 'keychain-build.json'))).rejects.toThrow();
  });

  it('holds every safeStorage call, including the availability check, until the window is armed', async () => {
    init();
    initSecretsPath(dir);
    resetSecretsCacheForTests();
    await fs.writeFile(path.join(dir, 'secrets.bin'), JSON.stringify({ openaiApiKey: 'sk-test' }));
    const read = getSecret('openaiApiKey');
    await vi.waitFor(() => expect(contents!.sent).toEqual([true]));
    // The availability check is what sets up Electron's encryptor and reads the Keychain key.
    expect(safeStorage.isAsyncEncryptionAvailable).not.toHaveBeenCalled();
    expect(safeStorage.decryptStringAsync).not.toHaveBeenCalled();
    notice.keychainNoticeReady();
    expect(await read).toBe('sk-test');
    await vi.waitFor(() => expect(contents!.sent).toEqual([true, false]));
  });
});
