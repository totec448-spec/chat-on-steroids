/**
 * Sends the exchanges in `COS_COMPANION_OPS` to the real TypeScript bridge (`startBridge`, port
 * 0) on a fresh profile and leaves the answers, the starting config and the profile's
 * `config.json` and `state/` in `COS_COMPANION_OUT`. `run.mjs` sends the same exchanges to
 * `cos-headless` and compares the two folders.
 *
 * An op is a bridge exchange, or `{ send: { id, conversation, text } }`: a message admitted the
 * way the control API admits one (`enqueueInput`), to the chat recorded for `conversation` or,
 * with `null`, to a new chat.
 */
import { readFileSync, writeFileSync } from 'node:fs';
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

const out = process.env.COS_COMPANION_OUT;
const opsFile = process.env.COS_COMPANION_OPS;

type Send = { id: string; conversation: string | null; text: string };
type Op = { method?: 'GET' | 'POST'; route: string; request?: unknown; raw?: string; auth?: boolean;
  config?: Record<string, unknown>; wait?: number;
  headers?: Record<string, string>; send?: Send };

it.runIf(out && opsFile)('answers the bridge exchanges', async () => {
  const { APP_VERSION, BRIDGE_PROTOCOL } = await import('../../../../src/main/version.js');
  const { defaultConfig, initConfigPath, saveConfig } = await import('../../../../src/main/config.js');
  const { initSecretsPath } = await import('../../../../src/main/secrets.js');
  const { flushDurable, initDurableStore } = await import('../../../../src/main/durable.js');
  const { findSessionByConversation, flushSessions, initSessionStore } = await import('../../../../src/main/session/store.js');
  const { configureInputDelivery, enqueueInput } = await import('../../../../src/main/session/input.js');
  const { recordDeliveredInput } = await import('../../../../src/main/session/input-history.js');
  const { bridgePort, startBridge, stopBridge } = await import('../../../../src/main/bridge.js');
  const ops = JSON.parse(readFileSync(opsFile!, 'utf8')) as Op[];
  initConfigPath(out!); initSecretsPath(out!); initDurableStore(out!); initSessionStore(out!);
  // A leading `{ config }` op patches the starting config on both sides; `<STUB>` is the
  // loopback provider run.mjs started.
  const merge = (base: unknown, patch: unknown): unknown => patch && typeof patch === 'object' && !Array.isArray(patch) && base && typeof base === 'object'
    ? Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(patch)])].map(key =>
      [key, key in (patch as object) ? merge((base as Record<string, unknown>)[key], (patch as Record<string, unknown>)[key]) : (base as Record<string, unknown>)[key]]))
    : patch;
  const patch = ops.find(op => op.config)?.config;
  const stub = process.env.COS_COMPANION_STUB ?? '';
  const initial = patch ? merge(defaultConfig(), JSON.parse(JSON.stringify(patch).replaceAll('<STUB>', stub))) as ReturnType<typeof defaultConfig> : defaultConfig();
  await saveConfig(initial);
  writeFileSync(path.join(out!, 'initial-config.json'), JSON.stringify(initial, null, 2));
  // What ipc.ts installs for an existing chat with no Skill, Goal or automation in play.
  configureInputDelivery({ applyAutomation: async () => undefined, changed: () => undefined,
    recordDelivered: (entry, anchorCommitted) => recordDeliveredInput(entry, anchorCommitted) });
  await startBridge();
  let bearer = '';
  const send = async (op: Op) => {
    const response = await fetch(`http://127.0.0.1:${bridgePort()}${op.route}`, {
      method: op.method ?? 'POST',
      headers: {
        'content-type': 'application/json', 'x-extension-version': APP_VERSION, 'x-extension-protocol': String(BRIDGE_PROTOCOL),
        ...(bearer && op.auth !== false ? { authorization: `Bearer ${bearer}` } : {}), ...op.headers
      },
      body: op.method === 'GET' ? undefined : op.raw ?? JSON.stringify(op.request ?? {})
    });
    return { status: response.status, body: await response.json() };
  };
  bearer = (await send({ route: '/pair', request: {} })).body.token;
  const answers = [];
  for (const op of ops) {
    if (op.config) { answers.push({ config: true }); continue; }
    if (op.wait) { await new Promise(resolve => setTimeout(resolve, op.wait)); answers.push({ wait: op.wait }); continue; }
    if (op.send) {
      const session = op.send.conversation ? (await findSessionByConversation(op.send.conversation))?.id ?? null : null;
      const row = await enqueueInput({ id: op.send.id, sessionId: session, text: op.send.text, mode: 'auto', dueAt: Date.now(),
        model: null, reasoningEffort: null, authoredSource: 'text' });
      answers.push({ send: { id: row.id, state: row.state, conversationId: row.conversationId } });
      continue;
    }
    const request = JSON.parse(JSON.stringify(op.request ?? null).replaceAll('"<NOW>"', String(Date.now())));
    answers.push({ route: op.route, ...(await send({ ...op, request })) });
  }
  // `/diagnostics` keeps the extension's preferences after it answers.
  await new Promise(resolve => setTimeout(resolve, 300));
  await stopBridge();
  await flushSessions();
  await flushDurable();
  writeFileSync(path.join(out!, 'answers.json'), JSON.stringify(answers, null, 2));
  expect(answers.length).toBe(ops.length);
}, 120_000);
