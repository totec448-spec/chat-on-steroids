/**
 * Runs the ops in `COS_INPUT_OPS` against the real TypeScript bridge (`startBridge`, port 0) and
 * outbox, and leaves `sessions/`, `state/` and the answers in `COS_INPUT_OUT`. `run.mjs` runs the
 * same ops against the Rust outbox and compares the two folders.
 *
 * An op is a bridge exchange `{ route, request }`, `{ enqueue: args }` (`enqueueInput`, what the
 * composer and the control API call), `{ pending: true }` (`pendingBrowserInputs`, what `/status`
 * offers), `{ seed: name, value }` (a state file the next restart finds), or
 * `{ restart: true }` (a new process on the same profile). `<SESSION:conversation>` in an op is
 * that chat's session id, and `<NOW-n>` the clock minus n milliseconds.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

process.env.CLF_BRIDGE_PORTS = '0';

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

const out = process.env.COS_INPUT_OUT;
const opsFile = process.env.COS_INPUT_OPS;

it.runIf(out && opsFile)('runs the outbox ops', async () => {
  const { APP_VERSION, BRIDGE_PROTOCOL } = await import('../../../../src/main/version.js');
  const { defaultConfig, initConfigPath, saveConfig } = await import('../../../../src/main/config.js');
  const { initSecretsPath } = await import('../../../../src/main/secrets.js');
  const { flushDurable, initDurableStore } = await import('../../../../src/main/durable.js');
  const { findSessionByConversation, flushSessions, initSessionStore, resetSessionStoreForTests } = await import('../../../../src/main/session/store.js');
  const { restoreRequestCorrelations } = await import('../../../../src/main/session/correlation.js');
  const { resetRecorderForTests } = await import('../../../../src/main/session/recorder.js');
  const { bridgePort, resetBridgeForTests, startBridge, stopBridge } = await import('../../../../src/main/bridge.js');
  const { configureInputDelivery, enqueueInput, pendingBrowserInputs, resetInputForTests } = await import('../../../../src/main/session/input.js');
  const { recordDeliveredInput } = await import('../../../../src/main/session/input-history.js');
  const ops = JSON.parse(readFileSync(opsFile!, 'utf8')) as Array<Record<string, unknown>>;
  initConfigPath(out!); initSecretsPath(out!); initDurableStore(out!); initSessionStore(out!);
  await saveConfig(defaultConfig());
  // What ipc.ts installs for an existing chat with no Skill, Goal or automation in play.
  configureInputDelivery({ applyAutomation: async () => undefined, changed: () => undefined,
    recordDelivered: (entry, anchorCommitted) => recordDeliveredInput(entry, anchorCommitted) });
  await restoreRequestCorrelations();
  await startBridge();
  let bearer = '';
  const post = async (route: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${bridgePort()}${route}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-extension-version': APP_VERSION, 'x-extension-protocol': String(BRIDGE_PROTOCOL),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
      },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  const resolve = async (value: unknown): Promise<unknown> => {
    if (Array.isArray(value)) return Promise.all(value.map(resolve));
    if (value && typeof value === 'object') {
      return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await resolve(item)])));
    }
    if (typeof value !== 'string') return value;
    const session = /^<SESSION:(.+)>$/.exec(value);
    if (session) return (await findSessionByConversation(session[1]!))?.id ?? value;
    const clock = /^<NOW-(\d+)>$/.exec(value);
    if (clock) return Date.now() - Number(clock[1]);
    return value;
  };
  bearer = (await post('/pair', {})).body.token;
  const answers = [];
  const seeds: Array<[string, unknown]> = [];
  for (const raw of ops) {
    const op = await resolve(raw) as Record<string, unknown>;
    if (typeof op.route === 'string') answers.push({ route: op.route, ...(await post(op.route, op.request)) });
    else if (op.enqueue) {
      try { answers.push({ enqueue: await enqueueInput(op.enqueue as never) }); }
      catch (error) { answers.push({ enqueue: { error: (error as Error).message } }); }
    } else if (op.pending) answers.push({ pending: await pendingBrowserInputs() });
    else if (typeof op.seed === 'string') {
      seeds.push([op.seed, op.value]);
      answers.push({ seed: op.seed });
    } else if (op.restart) {
      await stopBridge();
      await flushSessions();
      await flushDurable();
      // Written while nothing runs, as a file left by an earlier process would be.
      for (const [name, value] of seeds.splice(0)) {
        mkdirSync(path.join(out!, 'state'), { recursive: true });
        writeFileSync(path.join(out!, 'state', `${name}.json`), JSON.stringify(value));
      }
      // A new process keeps nothing in memory: the session store, the recorder and its request
      // ledger start again from the files, as the Rust side's new store and recorder do.
      resetBridgeForTests();
      resetInputForTests();
      resetRecorderForTests();
      resetSessionStoreForTests();
      initSessionStore(out!);
      await restoreRequestCorrelations();
      await startBridge();
      answers.push({ restart: true });
    }
  }
  await stopBridge();
  await flushSessions();
  await flushDurable();
  writeFileSync(path.join(out!, 'answers.json'), JSON.stringify(answers, null, 2));
  expect(answers.length).toBe(ops.length);
}, 120_000);
