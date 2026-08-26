/**
 * Secret storage backed by the OS.
 *
 * Electron safeStorage delegates to the host OS: DPAPI on Windows, Keychain on macOS,
 * and a desktop secret store such as libsecret/KWallet on Linux. The plaintext key exists
 * only inside the main process: it is never sent over IPC, never written to config.json,
 * and never logged. Linux's `basic_text` fallback is deliberately rejected below because
 * presenting obfuscation as credential encryption would weaken the app on the new port.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import type { SecureStorageInfo } from '../shared/types.js';
import { logError, logWarn } from './logger.js';

const FILE_NAME = 'secrets.bin';
const LINUX_BASIC_TEXT_PREFIX = Buffer.from('v10', 'ascii');
const LINUX_STORAGE_PROBE = 'chat-on-steroids-safe-storage-probe';

let secretsPath = '';
let cache: Record<string, string> | null = null;
/** A successful decrypt asked us to reseal the blob with the current async key. */
let rotationPending = false;
/** Invalidates a decrypt that started before an explicit store reset/delete boundary. */
let loadGeneration = 0;
/**
 * Coalesces concurrent cache misses into one disk/keyring read.
 *
 * Async safeStorage makes a load genuinely long-lived: without a single-flight promise, a
 * read-only getSecret() and a queued setSecret() can both decrypt the old blob, the mutation
 * can commit a new blob, and then the slower read can publish its old snapshot back into cache.
 * The next mutation would then compose from stale credentials and could erase the just-written
 * value. One authoritative load shared by all callers closes that race at its source.
 */
let loadInFlight: Promise<Record<string, string>> | null = null;
/**
 * Every mutation is a read-modify-write of one small encrypted blob. Saving the OpenAI key
 * while the bridge token is being minted would otherwise have both calls clone the same
 * snapshot, and the later write would erase the other's key — as well as racing on
 * secrets.bin.tmp. Same shape as config.ts's queue, for the same reason.
 */
let mutationQueue: Promise<void> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(operation);
  mutationQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * `bridgeToken` is not a user credential: it is the bearer token the paired browser
 * extension presents. It lives here anyway so it is encrypted at rest and stays out of
 * config.json, the log and the renderer.
 */
/**
 * `bridgeToken` is not a user credential either way; `openRouterApiKey` is one, and is the
 * only credential in here that a *model* can cause to be spent, so it lives under the same
 * OS-backed encrypted blob as the rest and never leaves the main process.
 */
export type SecretKey = 'openaiApiKey' | 'bridgeToken' | 'openRouterApiKey';

export function initSecretsPath(userDataDir: string): void {
  secretsPath = path.join(userDataDir, FILE_NAME);
}

/**
 * Electron 43's Linux async safeStorage stack always includes Chromium's PosixKeyProvider as
 * its last-resort provider. That provider is deliberately sync-compatible `v10` encryption and
 * uses Chromium's public hard-coded "peanuts" key. `getSelectedStorageBackend()` describes the
 * legacy/selected desktop backend, not which async provider actually supplied a key, so a GNOME
 * session whose Secret Service is down can still report `gnome_libsecret` while async encryption
 * silently falls back to `v10`. The bytes are the authority.
 */
export function secureStorageCiphertextIsProtected(
  encrypted: Buffer,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform !== 'linux' || !encrypted.subarray(0, LINUX_BASIC_TEXT_PREFIX.length).equals(LINUX_BASIC_TEXT_PREFIX);
}

export async function secureStorageStatus(platform: NodeJS.Platform = process.platform): Promise<SecureStorageInfo> {
  try {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      return {
        available: false,
        detail:
          platform === 'linux'
            ? 'Secure credential storage is unavailable. Start or unlock a Linux desktop keyring/Secret Service (for example GNOME Keyring or KWallet), then try again.'
            : platform === 'darwin'
              ? 'macOS Keychain credential storage is unavailable. Unlock the login keychain, then try again.'
              : 'Secure operating-system credential storage is unavailable on this machine.'
      };
    }
    if (platform === 'linux') {
      // Probe the provider Electron actually chose, not only the desktop/backend label above.
      // The probe contains no credential and is never persisted.
      const probe = await safeStorage.encryptStringAsync(LINUX_STORAGE_PROBE);
      if (!secureStorageCiphertextIsProtected(probe, platform)) {
        return {
          available: false,
          detail:
            'Linux secure storage fell back to Electron’s insecure hard-coded-key provider. Start or unlock a desktop keyring/Secret Service (for example GNOME Keyring or KWallet), then restart Chat On Steroids.'
        };
      }
    }
    return { available: true, detail: null };
  } catch {
    return { available: false, detail: 'Secure operating-system credential storage could not be initialized.' };
  }
}

export async function isEncryptionAvailable(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  return (await secureStorageStatus(platform)).available;
}

/**
 * A decrypt succeeding proves only that the host key was usable, not that the plaintext is a
 * secret-store snapshot this version can safely rewrite. Treat malformed shapes/values like any
 * other non-authoritative read: callers may degrade to "no credential", but a later mutation
 * must not compose from `{}` and destroy ciphertext whose contents we did not understand.
 *
 * Unknown string-valued fields are deliberately preserved for forward compatibility. The store
 * is a tiny string map, so a future release can add a key without an older build deleting it.
 */
function parseSecretStore(json: string): Record<string, string> {
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Stored credential payload is not an object');
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') throw new Error(`Stored credential field ${key} is not a string`);
  }
  return parsed as Record<string, string>;
}

async function loadAll(): Promise<Record<string, string>> {
  const generation = loadGeneration;
  // Keychain / Secret Service availability can be transient on macOS/Linux (for example while
  // the login keychain is locked or no desktop keyring has been unlocked yet). Do not attempt
  // decryption in that state and, crucially, do not cache an empty object: once secure storage
  // becomes available later in the same process, the next read must retry the real encrypted
  // file. Caching `{}` here would make a later setSecret() overwrite the existing blob and erase
  // credentials that were merely temporarily inaccessible.
  if (!(await isEncryptionAvailable())) return {};
  try {
    const blob = await fs.readFile(secretsPath);
    if (!secureStorageCiphertextIsProtected(blob)) {
      // Do not turn a historical/insecure Linux v10 blob into authoritative plaintext merely
      // because a secure keyring became available later. Linux support first ships in 2.0.2, so
      // there is no supported secure Linux v10 format to migrate here.
      logWarn('Stored Linux credentials use Electron’s insecure hard-coded-key fallback; the file was left untouched');
      rotationPending = false;
      return {};
    }
    const decrypted = await safeStorage.decryptStringAsync(blob);
    const parsed = parseSecretStore(decrypted.result);
    // `deleteAllSecrets()` is allowed to race a Keychain decrypt without waiting for a prompt or
    // unavailable provider. Once deletion starts, plaintext from the older generation must never
    // republish credentials that have just been removed from disk.
    if (generation !== loadGeneration) return cache ?? {};
    cache = parsed;
    rotationPending = decrypted.shouldReEncrypt;
  } catch (err) {
    if (generation !== loadGeneration) return cache ?? {};
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      cache = {};
      rotationPending = false;
    } else {
      // Electron's async API can reject while a key provider is temporarily unavailable, but
      // Electron 43.4's TypeScript result shape does not expose the `isTemporarilyUnavailable`
      // marker mentioned by the docs. A copied/corrupt blob is indistinguishable here from a
      // transient key-provider failure. Treat *neither* as an empty authoritative store: leave
      // the ciphertext untouched, leave cache unresolved, and make every mutation fail closed.
      // Reads still degrade to "no credential" so startup/bridge/UI remain usable and a later
      // call can retry after Keychain/Secret Service becomes available again.
      const available = await isEncryptionAvailable();
      logWarn(
        available
          ? 'Stored credentials could not be decrypted; the encrypted file was left untouched'
          : 'Stored credentials are temporarily unavailable because secure storage could not decrypt them'
      );
      rotationPending = false;
      return {};
    }
  }
  return cache;
}

async function readAll(): Promise<Record<string, string>> {
  if (cache) return cache;
  if (loadInFlight) return loadInFlight;
  const load = loadAll();
  loadInFlight = load;
  try {
    return await load;
  } finally {
    if (loadInFlight === load) loadInFlight = null;
  }
}

async function writeAll(values: Record<string, string>): Promise<void> {
  if (!(await isEncryptionAvailable())) {
    throw new Error('Secure OS credential storage is unavailable, so the key was not saved');
  }
  const blob = await safeStorage.encryptStringAsync(JSON.stringify(values));
  if (!secureStorageCiphertextIsProtected(blob)) {
    throw new Error('Secure OS credential storage is unavailable, so the key was not saved');
  }
  const tmp = `${secretsPath}.tmp`;
  await fs.mkdir(path.dirname(secretsPath), { recursive: true });
  await fs.writeFile(tmp, blob, { mode: 0o600 });
  await fs.rename(tmp, secretsPath);
  // Published only once the rename succeeded. A failed disk write must leave the
  // process believing the old state, not a credential it never actually saved.
  cache = values;
  rotationPending = false;
}

/**
 * Reseals a successfully decrypted blob when Electron reports key rotation.
 *
 * Decryption has already proved the plaintext and JSON are valid. Re-encryption is still
 * best-effort for reads: if the new key is temporarily unavailable, keep both the in-memory
 * plaintext and the old ciphertext intact and try again after the next process restart/read.
 * The mutation queue prevents a rotation rewrite from racing a user/API-key update through
 * the shared `secrets.bin.tmp` path.
 */
async function rotateIfNeeded(): Promise<void> {
  if (!rotationPending || cache === null) return;
  await enqueue(async () => {
    if (!rotationPending || cache === null) return;
    try {
      // Chromium sets `should_reencrypt` when this plaintext was successfully decrypted by a
      // provider other than the one now selected for encryption. Electron forwards that flag and
      // plaintext verbatim, so migration is encrypting the returned plaintext with the current
      // provider. Calling decrypt on the old ciphertext again cannot change which provider sealed
      // those bytes and would never perform the requested rotation.
      await writeAll({ ...cache });
    } catch (err) {
      logWarn(`Stored credentials could not be re-encrypted with the current secure-storage key: ${(err as Error).message}`);
    }
  });
}

export async function getSecret(key: SecretKey): Promise<string | null> {
  const all = await readAll();
  const value = all[key];
  await rotateIfNeeded();
  return value && value.length > 0 ? value : null;
}

export async function hasSecret(key: SecretKey): Promise<boolean> {
  return (await getSecret(key)) !== null;
}

export function setSecret(key: SecretKey, value: string): Promise<void> {
  return enqueue(async () => {
    if (!(await isEncryptionAvailable())) {
      throw new Error('Secure OS credential storage is unavailable, so the key was not saved');
    }
    // Read inside the queue, so this composes from the latest committed state rather
    // than from a snapshot taken before the call ahead of it finished.
    const current = await readAll();
    // `readAll()` deliberately degrades to an empty *view* for startup/status callers while
    // Keychain/Secret Service is unavailable. A mutation must never compose from that view:
    // if the read did not establish an authoritative cache, writing it would replace real
    // encrypted credentials with a partial/empty blob after a transient unlock race.
    if (cache === null) {
      throw new Error('Secure OS credential storage is unavailable, so the key was not saved');
    }
    const all = { ...current };
    const trimmed = value.trim();
    if (trimmed === '') {
      delete all[key];
    } else {
      all[key] = trimmed;
    }
    await writeAll(all);
  });
}

export function clearSecret(key: SecretKey): Promise<void> {
  return setSecret(key, '');
}

export function deleteAllSecrets(): Promise<void> {
  return enqueue(async () => {
    // Invalidate first, before touching disk. A decrypt may already hold the old ciphertext in
    // memory and can complete after rm(); its generation check above then returns the new empty
    // view instead of resurrecting the deleted credentials into cache.
    loadGeneration += 1;
    rotationPending = false;
    cache = null;
    try {
      await fs.rm(secretsPath, { force: true });
      cache = {};
    } catch (err) {
      logError(`Could not remove stored credentials: ${(err as Error).message}`);
      throw err;
    }
  });
}

/** Test seam: forgets the decrypted blob so the next read comes from disk. */
export function resetSecretsCacheForTests(): void {
  loadGeneration += 1;
  cache = null;
  rotationPending = false;
  loadInFlight = null;
}
