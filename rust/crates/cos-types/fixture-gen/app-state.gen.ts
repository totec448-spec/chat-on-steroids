/**
 * AppState as the real `state:get` IPC handler builds it, with Electron replaced by the same
 * inert stand-ins the app's own IPC tests use. Recorded straight into the harvest folder,
 * because AppState crosses IPC rather than a file or an HTTP response.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel)
  },
  BrowserWindow: class {},
  clipboard: { readText: () => '', writeText: () => undefined },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })), showSaveDialog: vi.fn(async () => ({ canceled: true })), showMessageBox: vi.fn(async () => ({ response: 0 })) },
  shell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() },
  nativeTheme: { themeSource: 'system' },
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  },
  app: { on: vi.fn(), once: vi.fn(), getPath: (_name: string) => '', getLocale: () => 'en-US', getVersion: vi.fn(() => '0.0.0'), getAppPath: () => process.cwd(), isPackaged: false }
}));
vi.mock('../../../../src/main/extension-path.js', () => ({ extensionDir: () => process.cwd(), shippedExtensionBuild: () => null, extensionUpdateOffer: () => null, prepareExtensionUpdate: () => null }));
vi.mock('../../../../src/main/browser.js', () => ({ openInPreferredBrowser: vi.fn(async () => 'chrome.exe') }));

const { defaultConfig, initConfigPath, saveConfig } = await import('../../../../src/main/config.js');
const { initSecretsPath } = await import('../../../../src/main/secrets.js');
const { initSessionStore, resetSessionStoreForTests } = await import('../../../../src/main/session/store.js');
const { flushDurable, initDurableStore } = await import('../../../../src/main/durable.js');
const { stopBridge } = await import('../../../../src/main/bridge.js');
const { registerIpc } = await import('../../../../src/main/ipc.js');
const { safeStorage } = await import('electron');
const { makeTempDir, removeTempDir } = await import('../../../../test/helpers.js');

let dir: string;
beforeAll(async () => {
  dir = await makeTempDir('cos-types-state-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  await saveConfig(defaultConfig('win32'));
  registerIpc(() => null, () => undefined);
});
afterAll(async () => {
  await stopBridge();
  await flushDurable();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

async function harvest(name: string): Promise<void> {
  const reply = await handlers.get('state:get')!(null, undefined) as { ok: boolean; data: unknown };
  expect(reply.ok).toBe(true);
  const out = process.env.COS_FIXTURE_HARVEST;
  if (!out) return;
  const text = JSON.stringify(reply.data);
  const folder = path.join(out, 'raw', 'app-state');
  await fs.mkdir(folder, { recursive: true });
  const digest = createHash('sha1').update(text).digest('hex');
  await fs.writeFile(path.join(folder, `${digest}.json`), JSON.stringify({ kind: 'app-state', source: name, text }));
}

it('records the state of a fresh install', async () => { await harvest('fresh'); });

it('records the state when secure storage is unavailable', async () => {
  vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(false);
  await harvest('no-secure-storage');
});
