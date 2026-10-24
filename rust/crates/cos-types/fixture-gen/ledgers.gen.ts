/**
 * Durable ledgers no harvested app test writes, produced by their real owners.
 *
 * `main-texts`, `retired-workers` and `window-bounds` are persisted by wiring in `main/index.ts`,
 * which cannot load outside Electron; each test here repeats that one wiring line around the
 * owner's own snapshot function. Everything else goes through the owner unchanged.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import path from 'node:path';

vi.mock('electron', () => ({
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }) },
  app: { getPath: () => '', getVersion: () => '0.0.0', isPackaged: false, on: vi.fn(), once: vi.fn() }
}));

const { flushDurable, initDurableStore, writeDurableNow } = await import('../../../../src/main/durable.js');
const { configureChatModelDiscovery, observeChatModels, pendingChatModelRequest, resetChatModelsForTests, startChatModelDiscovery } =
  await import('../../../../src/main/chat-models.js');
const { mainTextTranslations, setMainTextTranslations } = await import('../../../../src/main/main-texts.js');
const { restoreRetiredWorkers, snapshotRetiredWorkers } = await import('../../../../src/main/agents.js');
const { trackNormalWindowBounds } = await import('../../../../src/main/window-lifecycle.js');
const { initPetLibrary, setPetFavorite, BUILTIN_PET_ID } = await import('../../../../src/main/pet-library.js');
const { makeTempDir, removeTempDir } = await import('../../../../test/helpers.js');

let dir: string;
beforeAll(async () => {
  dir = await makeTempDir('cos-types-ledgers-');
  initDurableStore(dir);
});
afterAll(async () => {
  await flushDurable();
  await removeTempDir(dir);
});

it('writes the chat model catalog the browser observed', async () => {
  resetChatModelsForTests();
  configureChatModelDiscovery({ changed: () => undefined, wake: async () => undefined });
  await startChatModelDiscovery(true);
  const nonce = pendingChatModelRequest()!.nonce;
  expect(observeChatModels({
    nonce,
    models: [
      { id: 'gpt-6', label: 'GPT-6', efforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'gpt-6-pro', label: 'GPT-6 Pro', efforts: ['pro'], aliases: ['gpt-6-pro-latest'] }
    ]
  })).toBe(true);
  await flushDurable();
  resetChatModelsForTests();
});

it('writes the translated main-process texts', async () => {
  setMainTextTranslations({ 'Open Chat On Steroids': 'Chat On Steroids öffnen', Quit: 'Beenden' });
  await writeDurableNow('main-texts', mainTextTranslations());
});

it('writes the retired worker leases', async () => {
  restoreRetiredWorkers({
    version: 1,
    savedAt: Date.now(),
    workers: [{ id: 'worker-2', conversationId: '68f1c2d4-2222-4bbb-8ccc-0123456789ab', reason: 'cleared by the user', retiredAt: Date.now() }]
  });
  await writeDurableNow('retired-workers', snapshotRetiredWorkers());
  restoreRetiredWorkers(null);
});

it.each([false, true])('writes the window placement (maximized: %s)', async (maximized) => {
  const listeners = new Map<string, () => void>();
  const saved: unknown[] = [];
  trackNormalWindowBounds({
    on: (event, listener) => listeners.set(event, listener),
    isDestroyed: () => false,
    isMaximized: () => maximized,
    isMinimized: () => false,
    isFullScreen: () => false,
    getNormalBounds: () => ({ x: 120.4, y: 80, width: 1280, height: 860.6 })
  }, (placement) => saved.push(placement));
  listeners.get(maximized ? 'maximize' : 'resize')!();
  expect(saved).toHaveLength(1);
  await writeDurableNow('window-bounds', saved[0]);
});

it('writes the usage cache for a recorded chat', async () => {
  const { appendEvent, createSession, initSessionStore, resetSessionStoreForTests } = await import('../../../../src/main/session/store.js');
  const { usageOverview } = await import('../../../../src/main/session/usage.js');
  initSessionStore(dir);
  const session = await createSession({ title: 'Usage', conversationId: '68f1c2d4-3333-4bbb-8ccc-0123456789ab' });
  const time = Date.now();
  await appendEvent(session.id, { time, source: 'extension', kind: 'user_message', model: 'gpt-6', messageId: 'usage-question',
    message: { text: 'How big is the repo?', truncated: false, chars: 20 } });
  await appendEvent(session.id, { time: time + 1, source: 'extension', kind: 'assistant_message', model: 'gpt-6', messageId: 'usage-answer',
    resolvedModel: 'gpt-6', final: true, state: 'final', message: { text: 'About forty thousand lines.', truncated: false, chars: 27 } });
  await usageOverview();
  await flushDurable();
  resetSessionStoreForTests();
});

it('writes the pet library preferences', async () => {
  await initPetLibrary(path.join(dir, 'pets-user-data'));
  setPetFavorite(BUILTIN_PET_ID, true);
  await flushDurable();
});
