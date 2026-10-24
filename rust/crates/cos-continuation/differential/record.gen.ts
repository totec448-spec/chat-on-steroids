/**
 * Runs the Compact & Resume ops in `COS_CONTINUATION_OPS` against the real TypeScript
 * transaction (`session/continuation.ts` over the real session store and durable state, no
 * Electron window) and leaves `sessions/`, `state/` and the answers in `COS_CONTINUATION_OUT`.
 * `run.mjs` runs the same ops against `cos-continuation` and compares the two folders.
 *
 * An op is `{ create: chat }`, `{ open: { automatic } }`, `{ step: name }` (one transaction
 * step, see `steps` below), `{ restart: true }` (a new process on the same profile: the WAL is
 * read back from disk), `{ view: true }` (the transaction as a caller sees it) or
 * `{ crash: { to, rebound } }` (a process that died inside the commit: the WAL says
 * `committing` to `to`, and with `rebound` the session move had already landed).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

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

const out = process.env.COS_CONTINUATION_OUT;
const opsFile = process.env.COS_CONTINUATION_OPS;

it.runIf(out && opsFile)('runs the continuation ops', async () => {
  const { defaultConfig, initConfigPath, saveConfig } = await import('../../../../src/main/config.js');
  const { flushDurable, initDurableStore, readDurable, writeDurableNow } = await import('../../../../src/main/durable.js');
  const store = await import('../../../../src/main/session/store.js');
  const continuation = await import('../../../../src/main/session/continuation.js');
  const { resetResumeGate } = await import('../../../../src/main/session/resume-gate.js');
  const { SAMPLE_BRIEF } = await import('../../../../test/helpers.js');
  const ops = JSON.parse(readFileSync(opsFile!, 'utf8')) as Array<Record<string, unknown>>;
  initConfigPath(out!); initDurableStore(out!); store.initSessionStore(out!);
  await saveConfig(defaultConfig());
  let session = '';
  let token = '';
  const view = () => {
    const entry = continuation.continuationByToken(token);
    return entry && {
      state: entry.state, to: entry.to, error: entry.error, automatic: entry.automatic,
      hasHandoff: entry.handoffId !== null,
      sourceSend: entry.sourceSend.state, destinationSend: entry.destinationSend.state
    };
  };
  const steps: Record<string, () => Promise<unknown>> = {
    sourceAttempt: async () => (await continuation.beginContinuationSourceSendNow(token))?.allowed ?? null,
    sourceDispatch: () => continuation.dispatchContinuationSourceSendNow(token, 'before'),
    sourceMessage: () => continuation.bindContinuationSourceMessageNow(token, 'handoff-message'),
    capture: async () => (await continuation.attachSummary(token, SAMPLE_BRIEF)) !== null,
    claim: async () => (await continuation.claimContinuationNow(token, 'command-1')) !== null,
    destinationAttempt: async () => (await continuation.beginContinuationDestinationSendNow(token))?.allowed ?? null,
    destinationDispatch: () => continuation.dispatchContinuationDestinationSendNow(token),
    destinationMessage: () => continuation.bindContinuationDestinationMessageNow(token, 'chat-b', 'resume-message'),
    commit: async () => (await continuation.commitContinuationResult(token, 'chat-b')).status,
    abort: () => continuation.abortContinuationNow(token, 'cancelled')
  };
  const restart = async () => {
    await store.flushSessions();
    await flushDurable();
    store.resetSessionStoreForTests();
    resetResumeGate();
    store.initSessionStore(out!);
    await continuation.restoreContinuations(await readDurable(continuation.CONTINUATIONS_STATE));
  };
  const answers: unknown[] = [];
  for (const op of ops) {
    if (typeof op.create === 'string') {
      // As the recorder creates a chat's session (`sessionForConversation`).
      session = (await store.createSession({ title: 'work', conversationId: op.create, titleSource: 'fallback' })).id;
      answers.push({ created: true });
    } else if (op.open) {
      const opened = await continuation.openContinuationNow(session, 'chat-a', (op.open as { automatic: boolean }).automatic);
      token = opened.token;
      answers.push({ opened: opened.state, automatic: opened.automatic });
    } else if (typeof op.step === 'string') {
      answers.push({ step: op.step, result: await steps[op.step]!() });
    } else if (op.restart) {
      await restart();
      answers.push({ restart: true });
    } else if (op.view) {
      answers.push({ view: view() });
    } else if (op.crash) {
      const { to, rebound } = op.crash as { to: string; rebound: boolean };
      await flushDurable();
      const wal = await readDurable<{ entries: Array<Record<string, unknown>> }>(continuation.CONTINUATIONS_STATE);
      Object.assign(wal!.entries[0]!, { state: 'committing', to });
      await writeDurableNow(continuation.CONTINUATIONS_STATE, wal);
      if (rebound) await store.rebindSession(session, 'chat-a', to);
      await restart();
      answers.push({ crash: true });
    }
  }
  await store.flushSessions();
  await flushDurable();
  writeFileSync(path.join(out!, 'answers.json'), JSON.stringify(answers, null, 2));
  expect(answers.length).toBe(ops.length);
}, 120_000);
