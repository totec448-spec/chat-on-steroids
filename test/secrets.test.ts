/**
 * OS-backed secret store semantics that matter for release safety.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  }
}));

const {
  deleteAllSecrets,
  getSecret,
  initSecretsPath,
  resetSecretsCacheForTests,
  secureStorageCiphertextIsProtected,
  secureStorageStatus,
  setSecret
} = await import('../src/main/secrets.js');
const { safeStorage } = await import('electron');
const { formatLogAsJson, getLog, logInfo } = await import('../src/main/logger.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  dir = await makeTempDir('clf-secrets-');
  initSecretsPath(dir);
  resetSecretsCacheForTests();
  vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
  vi.mocked(safeStorage.getSelectedStorageBackend).mockReturnValue('gnome_libsecret');
  vi.mocked(safeStorage.encryptStringAsync).mockImplementation(async (value) => Buffer.from(value, 'utf8'));
  vi.mocked(safeStorage.decryptStringAsync).mockImplementation(async (buffer) => ({
    result: buffer.toString('utf8'),
    shouldReEncrypt: false
  }));
});

afterEach(async () => {
  await removeTempDir(dir);
});

describe('secret store', () => {
  it('refuses Linux v10 hard-coded-key ciphertext instead of trusting the legacy backend label', async () => {
    vi.mocked(safeStorage.getSelectedStorageBackend).mockReturnValue('basic_text');
    vi.mocked(safeStorage.encryptStringAsync).mockResolvedValueOnce(Buffer.from('v10fallback-ciphertext', 'ascii'));
    expect(await secureStorageStatus('linux')).toEqual({
      available: false,
      detail: expect.stringMatching(/hard-coded-key|fallback/i)
    });
    expect(safeStorage.isAsyncEncryptionAvailable).toHaveBeenCalledTimes(1);
  });

  it('accepts a secure async Linux provider even when the legacy backend label is basic_text', async () => {
    vi.mocked(safeStorage.getSelectedStorageBackend).mockReturnValue('basic_text');
    vi.mocked(safeStorage.encryptStringAsync).mockResolvedValueOnce(Buffer.from('v11protected-ciphertext', 'ascii'));

    expect(await secureStorageStatus('linux')).toEqual({ available: true, detail: null });
  });

  it('refuses the async Linux v10 fallback even when the selected backend label looks secure', async () => {
    vi.mocked(safeStorage.getSelectedStorageBackend).mockReturnValue('gnome_libsecret');
    vi.mocked(safeStorage.encryptStringAsync).mockResolvedValueOnce(Buffer.from('v10fallback-ciphertext', 'ascii'));

    expect(await secureStorageStatus('linux')).toEqual({
      available: false,
      detail: expect.stringMatching(/hard-coded-key|fallback/i)
    });
    expect(safeStorage.isAsyncEncryptionAvailable).toHaveBeenCalledTimes(1);
    expect(safeStorage.encryptStringAsync).toHaveBeenCalledWith('chat-on-steroids-safe-storage-probe');
  });

  it('classifies only Linux v10 ciphertext as the insecure hard-coded-key provider', () => {
    const v10 = Buffer.from('v10ciphertext', 'ascii');
    const v11 = Buffer.from('v11ciphertext', 'ascii');
    expect(secureStorageCiphertextIsProtected(v10, 'linux')).toBe(false);
    expect(secureStorageCiphertextIsProtected(v11, 'linux')).toBe(true);
    // v10 is a platform-specific on-disk format distinction; do not reinterpret bytes from
    // DPAPI/Keychain hosts as Linux basic_text merely because their prefix happens to match.
    expect(secureStorageCiphertextIsProtected(v10, 'win32')).toBe(true);
    expect(secureStorageCiphertextIsProtected(v10, 'darwin')).toBe(true);
  });

  it('serializes concurrent writes so one credential cannot erase another', async () => {
    await Promise.all([
      setSecret('bridgeToken', 'bridge-token-456'),
      setSecret('openaiApiKey', 'sk-openai-789')
    ]);

    expect(await getSecret('bridgeToken')).toBe('bridge-token-456');
    expect(await getSecret('openaiApiKey')).toBe('sk-openai-789');

    // Force a disk read, not the in-process cache.
    resetSecretsCacheForTests();
    expect(await getSecret('bridgeToken')).toBe('bridge-token-456');
    expect(await getSecret('openaiApiKey')).toBe('sk-openai-789');
    expect(await fs.stat(path.join(dir, 'secrets.bin'))).toBeTruthy();
  });

  it('single-flights an async cache miss so a late read cannot publish stale credentials after a write', async () => {
    await Promise.all([
      setSecret('bridgeToken', 'bridge-before-load-race'),
      setSecret('openaiApiKey', 'sk-before-load-race')
    ]);
    resetSecretsCacheForTests();

    let releaseDecrypt: () => void = () => {};
    let markDecryptStarted: () => void = () => {};
    const decryptStarted = new Promise<void>((resolve) => {
      markDecryptStarted = resolve;
    });
    const decryptGate = new Promise<void>((resolve) => {
      releaseDecrypt = resolve;
    });
    vi.mocked(safeStorage.decryptStringAsync).mockImplementationOnce(async (buffer) => {
      markDecryptStarted();
      await decryptGate;
      return { result: buffer.toString('utf8'), shouldReEncrypt: false };
    });

    const read = getSecret('bridgeToken');
    await decryptStarted;
    const write = setSecret('openRouterApiKey', 'or-written-during-load');
    // Give the mutation a chance to reach readAll(). It must join the existing load instead of
    // starting a second decrypt of the same old ciphertext.
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseDecrypt();

    expect(await read).toBe('bridge-before-load-race');
    await write;
    expect(safeStorage.decryptStringAsync).toHaveBeenCalledTimes(1);

    // A second mutation is the destructive edge of the old race: if the late read had replaced
    // cache with its stale snapshot, this write would silently drop openRouterApiKey.
    await setSecret('openaiApiKey', 'sk-after-load-race');
    resetSecretsCacheForTests();
    expect(await getSecret('bridgeToken')).toBe('bridge-before-load-race');
    expect(await getSecret('openaiApiKey')).toBe('sk-after-load-race');
    expect(await getSecret('openRouterApiKey')).toBe('or-written-during-load');
  });

  it('does not turn a transient unavailable keyring into an empty authoritative secret store', async () => {
    await Promise.all([
      setSecret('bridgeToken', 'bridge-token-survives-keyring-lock'),
      setSecret('openaiApiKey', 'sk-survives-keyring-lock')
    ]);
    resetSecretsCacheForTests();

    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(false);
    vi.mocked(safeStorage.decryptStringAsync).mockClear();
    expect(await getSecret('bridgeToken')).toBeNull();
    expect(safeStorage.decryptStringAsync).not.toHaveBeenCalled();
    await expect(setSecret('openRouterApiKey', 'must-not-overwrite')).rejects.toThrow(/credential storage is unavailable/i);

    // Unlocking the host store later in the same process must retry disk, not keep the
    // temporary empty view cached and risk overwriting the real encrypted blob on the next save.
    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
    expect(await getSecret('bridgeToken')).toBe('bridge-token-survives-keyring-lock');
    expect(await getSecret('openaiApiKey')).toBe('sk-survives-keyring-lock');
  });

  it('does not let an in-flight decrypt resurrect credentials after the encrypted store is deleted', async () => {
    await Promise.all([
      setSecret('bridgeToken', 'bridge-token-before-delete-race'),
      setSecret('openaiApiKey', 'sk-before-delete-race')
    ]);
    resetSecretsCacheForTests();

    let releaseDecrypt: () => void = () => {};
    let markDecryptStarted: () => void = () => {};
    const decryptStarted = new Promise<void>((resolve) => {
      markDecryptStarted = resolve;
    });
    const decryptGate = new Promise<void>((resolve) => {
      releaseDecrypt = resolve;
    });
    vi.mocked(safeStorage.decryptStringAsync).mockImplementationOnce(async (buffer) => {
      markDecryptStarted();
      await decryptGate;
      return { result: buffer.toString('utf8'), shouldReEncrypt: false };
    });

    const staleRead = getSecret('bridgeToken');
    await decryptStarted;
    await deleteAllSecrets();
    await expect(fs.access(path.join(dir, 'secrets.bin'))).rejects.toBeDefined();

    releaseDecrypt();
    expect(await staleRead).toBeNull();

    // The destructive edge: a later save must compose from the deleted empty store, not from
    // plaintext the old decrypt held before deletion, otherwise it silently recreates old keys.
    await setSecret('openRouterApiKey', 'or-after-delete-race');
    resetSecretsCacheForTests();
    expect(await getSecret('bridgeToken')).toBeNull();
    expect(await getSecret('openaiApiKey')).toBeNull();
    expect(await getSecret('openRouterApiKey')).toBe('or-after-delete-race');
  });

  it('does not overwrite secrets when storage disappears between availability check and decrypt', async () => {
    await Promise.all([
      setSecret('bridgeToken', 'bridge-token-survives-decrypt-race'),
      setSecret('openaiApiKey', 'sk-survives-decrypt-race')
    ]);
    resetSecretsCacheForTests();

    vi.mocked(safeStorage.decryptStringAsync).mockImplementationOnce(async () => {
      // Reproduce the host-only race: safeStorage was available when the read started,
      // then Keychain/Secret Service became unavailable before decryptString completed.
      vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(false);
      throw new Error('credential backend became unavailable');
    });
    await expect(setSecret('openRouterApiKey', 'must-not-replace-existing-blob')).rejects.toThrow(
      /credential storage is unavailable/i
    );

    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
    expect(await getSecret('bridgeToken')).toBe('bridge-token-survives-decrypt-race');
    expect(await getSecret('openaiApiKey')).toBe('sk-survives-decrypt-race');
    expect(await getSecret('openRouterApiKey')).toBeNull();
  });

  it('treats any async decrypt rejection as non-authoritative even if availability still reports true', async () => {
    await Promise.all([
      setSecret('bridgeToken', 'bridge-token-survives-ambiguous-decrypt-error'),
      setSecret('openaiApiKey', 'sk-survives-ambiguous-decrypt-error')
    ]);
    const file = path.join(dir, 'secrets.bin');
    const before = await fs.readFile(file);
    resetSecretsCacheForTests();
    vi.mocked(safeStorage.decryptStringAsync).mockRejectedValue(new Error('provider temporarily unavailable'));

    // Electron 43.4 typings do not expose the docs' temporary-unavailability marker, so a
    // rejected decrypt must never be converted into an empty authoritative store solely because
    // isAsyncEncryptionAvailable() still says that the provider exists.
    expect(await getSecret('bridgeToken')).toBeNull();
    await expect(setSecret('openRouterApiKey', 'must-not-replace-ambiguous-blob')).rejects.toThrow(
      /credential storage is unavailable/i
    );
    expect(await fs.readFile(file)).toEqual(before);

    vi.mocked(safeStorage.decryptStringAsync).mockImplementation(async (buffer) => ({
      result: buffer.toString('utf8'),
      shouldReEncrypt: false
    }));
    expect(await getSecret('bridgeToken')).toBe('bridge-token-survives-ambiguous-decrypt-error');
    expect(await getSecret('openaiApiKey')).toBe('sk-survives-ambiguous-decrypt-error');
  });

  it('preserves ciphertext when decrypt succeeds but the stored secret map is malformed', async () => {
    await Promise.all([
      setSecret('bridgeToken', 'bridge-token-before-malformed-store'),
      setSecret('openaiApiKey', 'sk-before-malformed-store')
    ]);
    const file = path.join(dir, 'secrets.bin');
    // The test safeStorage mock is identity encryption. This reproduces a decryptable payload
    // whose shape cannot be safely treated as a string secret map.
    await fs.writeFile(file, Buffer.from(JSON.stringify({ bridgeToken: 'still-there', openaiApiKey: 123 }), 'utf8'));
    resetSecretsCacheForTests();
    const before = await fs.readFile(file);

    expect(await getSecret('bridgeToken')).toBeNull();
    await expect(setSecret('openRouterApiKey', 'must-not-replace-malformed-blob')).rejects.toThrow(
      /credential storage is unavailable/i
    );
    expect(await fs.readFile(file)).toEqual(before);
  });

  it('re-encrypts a successfully decrypted blob when Electron reports key rotation', async () => {
    await Promise.all([
      setSecret('bridgeToken', 'bridge-token-rotated'),
      setSecret('openaiApiKey', 'sk-rotated')
    ]);
    resetSecretsCacheForTests();
    vi.mocked(safeStorage.encryptStringAsync).mockClear();
    vi.mocked(safeStorage.decryptStringAsync).mockImplementationOnce(async (buffer) => ({
      result: buffer.toString('utf8'),
      shouldReEncrypt: true
    }));

    expect(await getSecret('bridgeToken')).toBe('bridge-token-rotated');
    // Linux proves the selected async provider is not Chromium's hard-coded-key fallback by
    // encrypting a harmless probe before each real write. Count the secret-blob reseal itself,
    // not platform-specific availability probes.
    const reseals = vi.mocked(safeStorage.encryptStringAsync).mock.calls
      .map(([value]) => value)
      .filter((value) => value !== 'chat-on-steroids-safe-storage-probe');
    expect(reseals).toHaveLength(1);
    expect(JSON.parse(reseals[0]!)).toEqual({
      bridgeToken: 'bridge-token-rotated',
      openaiApiKey: 'sk-rotated'
    });

    resetSecretsCacheForTests();
    expect(await getSecret('openaiApiKey')).toBe('sk-rotated');
  });

  it('keeps the old ciphertext and readable cache when key-rotation reseal is temporarily unavailable', async () => {
    await Promise.all([
      setSecret('bridgeToken', 'bridge-token-before-failed-rotation'),
      setSecret('openaiApiKey', 'sk-before-failed-rotation')
    ]);
    const file = path.join(dir, 'secrets.bin');
    const before = await fs.readFile(file);
    resetSecretsCacheForTests();
    vi.mocked(safeStorage.decryptStringAsync).mockImplementationOnce(async (buffer) => ({
      result: buffer.toString('utf8'),
      shouldReEncrypt: true
    }));
    let failNextSecretReseal = true;
    vi.mocked(safeStorage.encryptStringAsync).mockImplementation(async (value) => {
      // Linux performs this non-secret provider probe before the actual reseal. The failure
      // under test is the current key becoming unavailable for the credential blob itself.
      if (value === 'chat-on-steroids-safe-storage-probe') return Buffer.from(value, 'utf8');
      if (failNextSecretReseal) {
        failNextSecretReseal = false;
        throw new Error('new key temporarily unavailable');
      }
      return Buffer.from(value, 'utf8');
    });

    // The read already succeeded, so failed best-effort resealing must not hide the credential.
    expect(await getSecret('bridgeToken')).toBe('bridge-token-before-failed-rotation');
    expect(await fs.readFile(file)).toEqual(before);

    // A later read in the same process retries the pending rotation and keeps all fields.
    expect(await getSecret('openaiApiKey')).toBe('sk-before-failed-rotation');
    resetSecretsCacheForTests();
    expect(await getSecret('bridgeToken')).toBe('bridge-token-before-failed-rotation');
    expect(await getSecret('openaiApiKey')).toBe('sk-before-failed-rotation');
  });

  it('does not leak a credential through the diagnostics renderer/export path', () => {
    // There is no registry of live secrets to consult any more — an agent is the chat it
    // runs in, and nothing is minted for it — so the backstop is shape alone: a long opaque
    // run of token characters is masked wherever it appears.
    const secret = 'bridge-token-abcdefghijklmnopqrstuvwxyz012345';
    logInfo(`tunnel opened with ${secret} while bootstrapping`);

    const latest = getLog().at(-1)!;
    expect(latest.message).not.toContain(secret);
    expect(latest.message).toContain('***');
    expect(formatLogAsJson()).not.toContain(secret);
  });
});
