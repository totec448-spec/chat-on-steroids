/**
 * Bridge routes no harvested app test reaches over HTTP, driven against the real bridge
 * (`startBridge`) with the bodies `extension/background.js` and `extension/content.js` send.
 * The harvest setup records each exchange as the server answers it.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { on: vi.fn(), once: vi.fn(), getPath: () => '', getVersion: () => '0.0.0', getAppPath: () => process.cwd(), isPackaged: false },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'unknown',
    encryptStringAsync: async (text: string) => Buffer.from(text),
    decryptStringAsync: async (data: Buffer) => ({ result: data.toString(), shouldReEncrypt: false })
  },
  clipboard: {},
  shell: {}
}));
vi.mock('../../../../src/main/browser-startup.js', () => ({ wakeBrowserUrl: async () => undefined }));

const { APP_VERSION, BRIDGE_PROTOCOL } = await import('../../../../src/main/version.js');
const { defaultConfig, initConfigPath, saveConfig } = await import('../../../../src/main/config.js');
const { initSecretsPath } = await import('../../../../src/main/secrets.js');
const { flushDurable, initDurableStore } = await import('../../../../src/main/durable.js');
const { initSessionStore, resetSessionStoreForTests } = await import('../../../../src/main/session/store.js');
const { bridgePort, startBridge, stopBridge } = await import('../../../../src/main/bridge.js');
const { pendingBrowserPreferenceRequest, requestBrowserPreferences } = await import('../../../../src/main/browser-preferences.js');
const { exportImage, pendingImageExports } = await import('../../../../src/main/image-export.js');
const { makeTempDir, removeTempDir } = await import('../../../../test/helpers.js');

let dir: string;
let bearer = '';
const CHAT = '68f1c2d4-4444-4bbb-8ccc-0123456789ab';

async function post(route: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${bridgePort()}${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-extension-version': APP_VERSION, 'x-extension-protocol': String(BRIDGE_PROTOCOL),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  dir = await makeTempDir('cos-types-bridge-');
  initConfigPath(dir); initSecretsPath(dir); initDurableStore(dir); initSessionStore(dir);
  await saveConfig(defaultConfig());
  await startBridge();
  bearer = (await post('/pair', {})).body.token;
});

afterAll(async () => {
  await stopBridge();
  await flushDurable();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

it('confirms the extension preferences the app asked for', async () => {
  const asked = requestBrowserPreferences({ overwrite: false });
  const request = pendingBrowserPreferenceRequest()!;
  // The pending request rides on the next maintenance pass.
  await post('/status', { openConversations: [CHAT], stalledConversations: [], canReveal: true, canExportImages: true, chatGptSignedIn: true });
  expect((await post('/browser/preferences', { nonce: request.nonce, values: { overwrite: false, durations: true } })).body).toEqual({ ok: true });
  await expect(asked).resolves.toEqual({ overwrite: false, durations: true });
  expect((await post('/browser/preferences', { nonce: randomUUID(), values: null, error: 'storage unavailable' })).status).toBe(409);
});

it('answers an extension update check with no update to prepare', async () => {
  expect((await post('/extension/update')).body).toEqual({ ready: false });
});

it('takes a page refusal and a late delivery of an image export', async () => {
  const image = { conversationId: CHAT, messageId: '68f1c2d4-5555-4bbb-8ccc-0123456789ab', assetId: 'file_00000000aaaabbbbccccdddd' };
  const refused = exportImage(image, { real: `${dir}/never.png`, virtual: '/root/never.png' }).then(() => null, (error: Error) => error);
  const [pending] = pendingImageExports();
  await post('/status', { openConversations: [CHAT], canExportImages: true, chatGptSignedIn: null });
  expect((await post('/image-export', { nonce: pending!.nonce, error: 'not_rendered' })).body).toEqual({ ok: true });
  expect(await refused).toBeInstanceOf(Error);
  expect((await post('/image-export', { nonce: pending!.nonce, data: 'iVBORw0KGgo=' })).body).toEqual({ ok: false });
});

it('records the account limits the page read', async () => {
  const rows = [
    { model: 'gpt-6', scope: 'model', remaining: 12, remainingPercent: 40, resetAt: Date.now() + 3_600_000, windowSeconds: 10_800 },
    { model: 'deep-research', scope: 'feature', remaining: null, remainingPercent: null, resetAt: null, windowSeconds: null }
  ];
  expect((await post('/usage', { rows, observedAt: Date.now() })).body).toEqual({ ok: true });
});

it('refuses progress for a message this page does not hold', async () => {
  expect((await post('/input/progress', { id: randomUUID(), owner: '7:tab:1', conversationId: CHAT, partial: 'Thinking about it' })).body)
    .toEqual({ ok: false });
});
