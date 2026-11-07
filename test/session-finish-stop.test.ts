import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

// #2082 (VM, 2026-11-07): a turn whose finish record does not name it (it was started outside the
// app's own send, or a rebuilt summary kept the active turn but not its finish record) could not be
// stopped from the app: releasing the finish hold threw "This turn’s finish authority could not be
// recovered", and every Stop was refused. A Stop has nothing to release for such a turn.
const hooks = vi.hoisted(() => ({ dropFinish: false }));
vi.mock('../src/main/session/store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/session/store.js')>();
  return {
    ...real,
    getSession: async (...args: Parameters<typeof real.getSession>) => {
      const session = await real.getSession(...args);
      return session && hooks.dropFinish ? { ...session, finishTurn: null } : session;
    }
  };
});
const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSessionStore, createSession, appendEvent, readRecentEvents, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { releaseSessionFinish, sessionFinishHeld } = await import('../src/main/session/finish.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let directory: string;
beforeAll(async () => {
  directory = await makeTempDir('clf-finish-stop-');
  initConfigPath(directory); initSessionStore(directory);
  await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, finishTool: true } });
});
afterAll(async () => { resetSessionStoreForTests(); await removeTempDir(directory); });

it('lets a Stop through for a turn without a finish record, and records no release for it', async () => {
  const session = await createSession({ conversationId: randomUUID(), title: 'Stop without finish record' });
  await appendEvent(session.id, { source: 'extension', kind: 'turn_start', turnId: 'turn-two', time: 1000 });
  hooks.dropFinish = true;
  try {
    // The Stop path reads the chat's controls first: a turn without a finish record holds nothing
    // (CodeRabbit on #2086), so that read must not throw either.
    await expect(sessionFinishHeld(session.id, 'turn-two', session.conversationId)).resolves.toBe(false);
    await expect(releaseSessionFinish(session.id, 'turn-two', 'stop')).resolves.toBeUndefined();
    const progress = await readRecentEvents(session.id, 20, { kinds: ['progress'] });
    expect(progress.some(event => event.kind === 'progress' && event.progressId === 'finish-release:turn-two')).toBe(false);
    // Ending the turn (not a Stop) still needs its finish authority.
    await expect(releaseSessionFinish(session.id, 'turn-two', 'end')).rejects.toThrow(/finish authority could not be recovered/);
  } finally { hooks.dropFinish = false; }
});
