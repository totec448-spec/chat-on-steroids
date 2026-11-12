import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';

// #2144: accepting a Goal reply could corrupt the shared reply ledger.
const hooks = vi.hoisted(() => ({ getSession: null as null | ((id: string) => Promise<unknown>), getSecret: null as null | (() => Promise<string | null>) }));
vi.mock('../src/main/secrets.js', async original => {
  const real = await original<typeof import('../src/main/secrets.js')>();
  return { ...real, getSecret: (...args: Parameters<typeof real.getSecret>) => hooks.getSecret ? hooks.getSecret() : real.getSecret(...args) };
});
vi.mock('../src/main/session/store.js', async original => {
  const real = await original<typeof import('../src/main/session/store.js')>();
  return { ...real, getSession: (id: string, ...rest: unknown[]) => hooks.getSession ? hooks.getSession(id) : (real.getSession as (...args: unknown[]) => unknown)(id, ...rest) };
});
vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0' },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString(), shouldReEncrypt: false })
  }
}));
const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath } = await import('../src/main/secrets.js');
const { initDurableStore, resetDurableForTests, flushDurable, readDurable } = await import('../src/main/durable.js');
const { initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const goal = await import('../src/main/goal.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let directory: string;
beforeAll(async () => {
  directory = await makeTempDir('clf-goal-reply-races-');
  initConfigPath(directory); initSecretsPath(directory); initSessionStore(directory); initDurableStore(directory);
});
beforeEach(async () => {
  goal.resetGoalStateForTests();
  await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true } });
});
afterEach(() => { hooks.getSession = null; hooks.getSecret = null; vi.restoreAllMocks(); });
afterAll(async () => {
  goal.resetGoalStateForTests(); resetSessionStoreForTests(); resetDurableForTests();
  await removeTempDir(directory);
});

const accept = (conversationId: string, eventSeq: number, replyId = `reply-${conversationId}-${eventSeq}`) =>
  goal.acceptGoalReplyNow({ conversationId, sessionId: `session-${conversationId}`, replyId, turnId: `turn-${conversationId}`, eventSeq, blocked: true });
const ledger = () => new Map(goal.snapshotGoalReplies().replies.map(row => [row.conversationId, row]));

describe('Goal reply acceptance', () => {
  it('keeps another chat\'s accepted reply when this chat\'s save is refused', async () => {
    let refuse!: (error: Error) => void;
    const started = new Promise<void>(resolve => {
      const real = fs.rename.bind(fs);
      let first = true;
      vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (first && String(to).includes('goal-replies')) { first = false; resolve(); await new Promise<void>((_ok, fail) => { refuse = fail; }); }
        return real(from, to);
      });
    });
    const a = accept('conv-a', 1).catch(error => error as Error);
    await started;
    // B is accepted while A's save is paused just before its rename; B's save queues behind A's.
    const b = accept('conv-b', 1);
    await vi.waitFor(() => expect(ledger().has('conv-b')).toBe(true), { timeout: 10_000 });
    refuse(new Error('disk busy'));
    expect(await a).toMatchObject({ message: 'disk busy' });
    await b;
    await flushDurable();
    expect(ledger().has('conv-a')).toBe(false);
    expect(ledger().get('conv-b')?.eventSeq).toBe(1);
    const stored = await readDurable<{ replies: Array<{ conversationId: string }> }>(goal.GOAL_REPLIES_STATE);
    expect(stored?.replies.map(row => row.conversationId)).toEqual(['conv-b']);
  });

  it('does not bring back a silence reply that was withdrawn while this chat\'s save was waiting', async () => {
    await accept('conv-s', 1, 'silence:fabricated');
    await flushDurable();
    let release!: () => void;
    let started!: () => void;
    const reached = new Promise<void>(resolve => { started = resolve; });
    const real = fs.rename.bind(fs);
    let saves = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).includes('goal-replies')) {
        saves += 1;
        // First save: the withdrawal's own, paused just before its rename. Second: the acceptance, refused.
        if (saves === 1) { started(); await new Promise<void>(resolve => { release = resolve; }); }
        else if (saves === 2) throw new Error('disk busy');
      }
      return real(from, to);
    });
    const withdrawn = goal.withdrawSilenceGoalReplyNow('conv-s', 'silence:fabricated');
    await reached;
    // Accepted while the withdrawal's save is in flight: the ledger it captured still holds the fabricated row.
    const a = accept('conv-a', 1).catch(error => error as Error);
    await vi.waitFor(() => expect(ledger().has('conv-a')).toBe(true), { timeout: 10_000 });
    release();
    expect(await a).toMatchObject({ message: 'disk busy' });
    await withdrawn;
    await flushDurable();
    expect(ledger().has('conv-a')).toBe(false);
    expect(ledger().has('conv-s')).toBe(false);
    const stored = await readDurable<{ replies: Array<{ conversationId: string }> }>(goal.GOAL_REPLIES_STATE);
    expect(stored?.replies.map(row => row.conversationId) ?? []).not.toContain('conv-s');
  });

  it('does not let an older acceptance replace a newer one after its eligibility check', async () => {
    // Active acceptance reads the provider key (an asynchronous eligibility check) after the first look at the ledger.
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, backend: 'api' } });
    await goal.setGoalSwitchNow('conv-c', 'goal', true);
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    let first = true;
    hooks.getSecret = async () => { if (first) { first = false; entered(); await paused; } return 'synthetic-key'; };
    const accepting = (eventSeq: number, replyId: string) => goal.acceptGoalReplyNow({
      conversationId: 'conv-c', sessionId: 'session-conv-c', replyId, turnId: 'turn-conv-c', eventSeq, blocked: false });
    const older = accepting(1, 'reply-old');
    await reached;
    await accepting(2, 'reply-new');
    expect(ledger().get('conv-c')?.eventSeq).toBe(2);
    release();
    await older;
    await flushDurable();
    expect(ledger().get('conv-c')).toMatchObject({ eventSeq: 2, replyId: 'reply-new' });
    const stored = await readDurable<{ replies: Array<{ conversationId: string; eventSeq: number }> }>(goal.GOAL_REPLIES_STATE);
    expect(stored?.replies.find(row => row.conversationId === 'conv-c')?.eventSeq).toBe(2);
  });
});
