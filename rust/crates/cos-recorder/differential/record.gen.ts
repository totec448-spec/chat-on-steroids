/**
 * Sends the exchanges in `COS_RECORDER_OPS` to the real TypeScript bridge (`startBridge`, port 0)
 * and leaves its `sessions/`, `state/` and the answers in `COS_RECORDER_OUT`. `run.mjs` sends the
 * same exchanges to the Rust recorder and compares the two folders.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

process.env.CLF_BRIDGE_PORTS = '0';
// A call whose request id is not proven yet is filed at once, as the Rust kernel files it.
process.env.CLF_EVIDENCE_MS = '0';

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

const out = process.env.COS_RECORDER_OUT;
const opsFile = process.env.COS_RECORDER_OPS;

it.runIf(out && opsFile)('records the bridge exchanges', async () => {
  const { APP_VERSION, BRIDGE_PROTOCOL } = await import('../../../../src/main/version.js');
  const { defaultConfig, initConfigPath, saveConfig } = await import('../../../../src/main/config.js');
  const { initSecretsPath } = await import('../../../../src/main/secrets.js');
  const { flushDurable, initDurableStore } = await import('../../../../src/main/durable.js');
  const { flushSessions, initSessionStore } = await import('../../../../src/main/session/store.js');
  const { restoreRequestCorrelations } = await import('../../../../src/main/session/correlation.js');
  const { flushRecorder, recordToolCall } = await import('../../../../src/main/session/recorder.js');
  const { updateRequestPlan } = await import('../../../../src/main/session/request-plans.js');
  const { bridgePort, startBridge, stopBridge } = await import('../../../../src/main/bridge.js');
  const ops = JSON.parse(readFileSync(opsFile!, 'utf8')) as Array<{ route: string; request: any }>;
  initConfigPath(out!); initSecretsPath(out!); initDurableStore(out!); initSessionStore(out!);
  await saveConfig(defaultConfig());
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
  bearer = (await post('/pair', {})).body.token;
  const answers = [];
  const local = async (route: string, request: any) => {
    if (route === 'tool_call') {
      await recordToolCall({
        tool: 'read', args: { paths: [request.path] }, content: [{ type: 'text', text: request.text }],
        outcome: 'ok', durationMs: 0, startedAt: request.startedAt, requestId: request.requestId
      });
    } else if (route === 'request_plan') {
      await updateRequestPlan(request.requestId, request.update, request.startedAt);
    } else {
      await flushRecorder();
    }
    return { status: 200, body: { ok: true } };
  };
  for (const op of ops) {
    const answer = op.route.startsWith('/') ? await post(op.route, op.request) : await local(op.route, op.request);
    answers.push({ route: op.route, ...answer });
  }
  await flushRecorder();
  await stopBridge();
  await flushSessions();
  await flushDurable();
  writeFileSync(path.join(out!, 'answers.json'), JSON.stringify(answers, null, 2));
  expect(answers.length).toBe(ops.length);
}, 120_000);
