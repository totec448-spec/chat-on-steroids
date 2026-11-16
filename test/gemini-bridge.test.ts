import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_VERSION, BRIDGE_PROTOCOL } from '../src/main/version.js';
import type { Config } from '../src/shared/types.js';

const recoveryBrowserWake = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../src/main/browser-startup.js', () => ({ wakeBrowserUrl: recoveryBrowserWake }));

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'unknown'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  },
  clipboard: {},
  shell: {}
}));

const { safeStorage } = await import('electron');
const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath, setSecret } = await import('../src/main/secrets.js');
const { flushDurable, initDurableStore, writeDurableNow, writeDurableSoon } = await import('../src/main/durable.js');
const { findSessionByConversation, initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { resetRecorderForTests } = await import('../src/main/session/recorder.js');
const { resetBlockedChatsForTests, setChatBlocked } = await import('../src/main/session/blocked-chats.js');
const {
  onSwarmPersistNow,
  peekGeminiPrimeReports,
  requestWorkerBootstraps,
  resetSwarm
} = await import('../src/main/agents.js');
const { spawnAgentWorkers } = await import('../src/main/agent-admission.js');
const inputMod = await import('../src/main/session/input.js');
const {
  buildGeminiPrimeReportBatch,
  commandUrl,
  pendingCommands,
  resetBridgeForTests,
  setBrowserOpener,
  startBridge,
  stopBridge
} = await import('../src/main/bridge.js');
const { pickTailscaleFunnelPort, startGeminiBridge, stopManagedTailscaleFunnel } = await import('../src/main/mcp/gemini-bridge.js');
const { isSyntheticMcpRequestId, syntheticMcpRequestId } = await import('../src/main/mcp/tools-core.js');
const { opensInCosBrowser } = await import('../src/shared/cos-browser-sites.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

let dir: string;
let base: string;
let token: string | null = null;
let suiteConfig: Config;
const opened: string[] = [];
let redeemCursor = 0;

interface Reply {
  status: number;
  body: any;
}

function request(
  method: string,
  path: string,
  options: { body?: unknown; auth?: string | null; browser?: string } = {}
): Promise<Reply> {
  const url = new URL(path, base);
  const payload = options.body === undefined ? null : JSON.stringify(options.body);
  const headers: Record<string, string> = {
    'x-extension-version': APP_VERSION,
    'x-extension-protocol': String(BRIDGE_PROTOCOL),
    origin: EXTENSION_ORIGIN
  };
  if (options.browser) headers['x-extension-browser'] = options.browser;
  if (payload !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  const auth = options.auth === undefined ? token : options.auth;
  if (auth) headers['authorization'] = `Bearer ${auth}`;

  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: any = text;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            // Leave raw body if non-JSON.
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      }
    );
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function pair(): Promise<void> {
  const reply = await request('POST', '/pair', { auth: null });
  expect(reply.status).toBe(200);
  token = reply.body.token as string;
}

async function redeemNextOpened(client = 'tab-1'): Promise<any> {
  const index = redeemCursor++;
  await vi.waitFor(() => expect(opened.length).toBeGreaterThan(index), { timeout: 10_000, interval: 20 });
  const id = new URL(opened[index]!).searchParams.get('clf')!;
  const reply = await request('POST', '/commands/redeem', { body: { id, client } });
  expect(reply.status).toBe(200);
  return reply.body.command;
}

beforeAll(async () => {
  dir = await makeTempDir('cos-gemini-bridge-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  onSwarmPersistNow((snapshot) => writeDurableNow('swarm', snapshot));
  const baseConfig = defaultConfig();
  suiteConfig = {
    ...baseConfig,
    sessions: { ...baseConfig.sessions, record: true },
    ui: { ...baseConfig.ui, autoContinue: false },
    multiAgent: { ...baseConfig.multiAgent, enabled: true, recoverAgentTabs: true }
  };
  await saveConfig(suiteConfig);
  const port = await startBridge();
  expect(port).not.toBeNull();
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await stopBridge();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

beforeEach(async () => {
  recoveryBrowserWake.mockClear();
  vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
  await saveConfig(suiteConfig);
  resetSwarm();
  resetBridgeForTests();
  resetBlockedChatsForTests();
  resetRecorderForTests();
  inputMod.resetInputForTests();
  await writeDurableNow('session-input', []);
  opened.length = 0;
  redeemCursor = 0;
  setBrowserOpener(async (url) => {
    opened.push(url);
  });
  writeDurableSoon('bridge-commands', null);
  await flushDurable();
  await setSecret('bridgeToken', '');
  token = null;
});

afterEach(async () => {
  inputMod.resetInputForTests();
  await writeDurableNow('session-input', []);
});

describe('Gemini Web bridge integration', () => {
  it('builds Gemini app command URLs for Gemini workers', () => {
    const url = new URL(commandUrl('cmd-gem-1', null, null, null, null, 'gemini'));
    expect(url.origin).toBe('https://gemini.google.com');
    expect(url.pathname).toBe('/app');
    expect(url.searchParams.get('clf')).toBe('cmd-gem-1');
  });

  it('spawns Gemini workers from POST /gemini/spawn-workers, deduplicates turns, and blocks disallowed chats', async () => {
    await pair();
    const primeId = 'gemini-prime12345678';
    const recorded = await request('POST', '/events', {
      body: {
        conversationId: primeId,
        events: [
          { kind: 'user_message', time: Date.now(), messageId: 'g-u-1', text: 'Coordinate two reviews' }
        ]
      }
    });
    expect(recorded.status).toBe(200);

    const first = await request('POST', '/gemini/spawn-workers', {
      body: {
        conversationId: primeId,
        turnId: 'turn-gem-1',
        context: 'Work inside the current repository.',
        workers: [{ label: 'Reviewer', task: 'Check API error handling' }]
      }
    });
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(first.body.becamePrime).toBe(true);
    expect(first.body.workers).toHaveLength(1);
    expect(first.body.workers[0]).toMatchObject({ id: 'worker-1', label: 'Reviewer', state: 'invited' });

    await vi.waitFor(() => expect(opened).toHaveLength(1), { timeout: 10_000, interval: 20 });
    const workerOpenUrl = new URL(opened[0]!);
    expect(workerOpenUrl.origin).toBe('https://gemini.google.com');
    expect(workerOpenUrl.pathname).toBe('/app');

    const repeated = await request('POST', '/gemini/spawn-workers', {
      body: {
        conversationId: primeId,
        turnId: 'turn-gem-1',
        workers: [{ label: 'Reviewer', task: 'Check API error handling' }]
      }
    });
    expect(repeated.status).toBe(200);
    expect(repeated.body.duplicate).toBe(true);
    expect(repeated.body.runId).toBe(first.body.runId);
    expect(opened).toHaveLength(1);

    const blockedPrimeId = 'gemini-blocked123456';
    setChatBlocked(blockedPrimeId, true);
    const blocked = await request('POST', '/gemini/spawn-workers', {
      body: {
        conversationId: blockedPrimeId,
        turnId: 'turn-blocked',
        workers: [{ task: 'Should be refused' }]
      }
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('blocked_chat');
  });

  it('automatically delivers settled Gemini worker reports into the Gemini prime outbox', async () => {
    await pair();
    const primeId = 'gemini-prime87654321';
    const primeEv = await request('POST', '/events', {
      body: {
        conversationId: primeId,
        events: [
          { kind: 'user_message', time: Date.now(), messageId: 'g-prime-u1', text: 'Run two checks in parallel' },
          { kind: 'turn_start', time: Date.now() + 1, turnId: 'prime-t1', messageId: 'g-prime-u1' },
          { kind: 'assistant_message', time: Date.now() + 2, turnId: 'prime-t1', messageId: 'g-prime-a1', text: 'Spawning workers…', state: 'final', final: true },
          { kind: 'turn_end', time: Date.now() + 3, turnId: 'prime-t1', outcome: 'completed' }
        ]
      }
    });
    expect(primeEv.status).toBe(200);
    const primeSessionId = primeEv.body.sessionId as string;
    expect(primeSessionId).toBeTruthy();

    const spawned = await request('POST', '/gemini/spawn-workers', {
      body: {
        conversationId: primeId,
        turnId: 'prime-t1',
        workers: [
          { label: 'Alpha', task: 'Inspect module A' },
          { label: 'Beta', task: 'Inspect module B' }
        ]
      }
    });
    expect(spawned.status).toBe(200);
    expect(spawned.body.workers).toHaveLength(2);

    const workerChats = [
      { id: 'gemini-wrk11111aaaa', agent: 'worker-1', report: 'Alpha report summary: all clear' },
      { id: 'gemini-wrk22222bbbb', agent: 'worker-2', report: 'Beta report summary: fixed race condition' }
    ];

    for (const item of workerChats) {
      const boot = await redeemNextOpened(`tab-${item.agent}`);
      expect(boot.agent).toBe(item.agent);
      const ack = await request('POST', '/commands/ack', {
        body: { id: boot.id, status: 'sent', conversationId: item.id, agent: item.agent }
      });
      expect(ack.status).toBe(200);

      const now = Date.now();
      const ev = await request('POST', '/events', {
        body: {
          conversationId: item.id,
          events: [
            { kind: 'user_message', time: now, messageId: `${item.agent}-u`, text: boot.text },
            { kind: 'turn_start', time: now + 1, turnId: `${item.agent}-t1`, messageId: `${item.agent}-u` },
            { kind: 'assistant_message', time: now + 2, turnId: `${item.agent}-t1`, messageId: `${item.agent}-a`, text: item.report, state: 'final', final: true },
            { kind: 'turn_end', time: now + 3, turnId: `${item.agent}-t1`, outcome: 'completed' }
          ]
        }
      });
      expect(ev.status).toBe(200);
    }

    await vi.waitFor(async () => {
      const outbox = await inputMod.listInputs();
      const delivered = outbox.find(
        (entry) =>
          entry.sessionId === primeSessionId &&
          entry.text.includes('Alpha report summary: all clear') &&
          entry.text.includes('Beta report summary: fixed race condition')
      );
      expect(delivered).toBeDefined();
      expect(peekGeminiPrimeReports(primeId)).toBeNull();
    }, { timeout: 10_000, interval: 50 });

    const pending = pendingCommands();
    expect(pending.some((cmd) => cmd.what.includes('worker-'))).toBe(false);
  });

  it('advertises provider gemini in pendingBrowserInputs and /status and completes claim + ack for new Gemini chats', async () => {
    await pair();
    const id = randomUUID();
    const queued = await inputMod.enqueueInput({
      id,
      sessionId: null,
      provider: 'gemini',
      text: 'Hello Gemini from CoS',
      mode: 'auto',
      dueAt: Date.now(),
      model: null,
      reasoningEffort: null
    });
    expect(queued.provider).toBe('gemini');
    expect(queued.state).toBe('queued');

    const advertised = await inputMod.pendingBrowserInputs();
    expect(advertised).toContainEqual({ id, conversationId: null, provider: 'gemini' });

    const statusReply = await request('GET', '/status');
    expect(statusReply.status).toBe(200);
    expect(statusReply.body.inputs).toContainEqual({ id, conversationId: null, provider: 'gemini' });

    const owner = '11:doc-gemini:1';
    const claimReply = await request('POST', '/input/claim', {
      body: { id, owner, conversationId: null, requiresAuthorization: true }
    });
    expect(claimReply.status).toBe(200);
    expect(claimReply.body.input).toMatchObject({ id, owner, text: 'Hello Gemini from CoS' });

    const authReply = await request('POST', '/input/claim', {
      body: { id, owner, conversationId: null, authorize: true }
    });
    expect(authReply.status).toBe(200);
    expect(authReply.body.ok).toBe(true);

    const gemConvId = 'gemini-desktopsent1234';
    const ackReply = await request('POST', '/input/ack', {
      body: { id, owner, conversationId: gemConvId, messageId: 'gem-user-msg-1' }
    });
    expect(ackReply.status).toBe(200);
    expect(ackReply.body.ok).toBe(true);
  });

  it('re-adopts CoS Tailscale Funnel ports when Tailscale reports HTTPS TCP markers and still skips raw TCPForward', () => {
    const dnsName = 'inmersion.tail1b6353.ts.net';
    const localTarget = 'http://127.0.0.1:64384';
    const existingCoS = {
      TCP: {
        '443': { HTTPS: true },
        '8443': { HTTPS: true },
        '10000': { HTTPS: true }
      },
      Web: {
        'inmersion.tail1b6353.ts.net:443': { Handlers: { '/': { Proxy: localTarget } } },
        'inmersion.tail1b6353.ts.net:8443': { Handlers: { '/': { Proxy: localTarget } } },
        'inmersion.tail1b6353.ts.net:10000': { Handlers: { '/': { Proxy: localTarget } } }
      },
      AllowFunnel: {
        'inmersion.tail1b6353.ts.net:443': true,
        'inmersion.tail1b6353.ts.net:8443': true,
        'inmersion.tail1b6353.ts.net:10000': true
      }
    };
    expect(pickTailscaleFunnelPort(existingCoS, dnsName, localTarget)).toEqual({ port: 443, alreadyLive: true });
    expect(pickTailscaleFunnelPort(existingCoS, dnsName, localTarget, 10000)).toEqual({ port: 10000, alreadyLive: true });

    const withOtherApps = {
      TCP: {
        '443': { TCPForward: '127.0.0.1:5432' },
        '8443': { HTTPS: true }
      },
      Web: {
        'inmersion.tail1b6353.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } }
      },
      AllowFunnel: {
        'inmersion.tail1b6353.ts.net:8443': true
      }
    };
    expect(pickTailscaleFunnelPort(withOtherApps, dnsName, localTarget)).toEqual({ port: 10000, alreadyLive: false });

    // Our own serve mapping with Funnel switched off is re-enabled on the same port, not reported as taken.
    const funnelOff = {
      TCP: { '443': { HTTPS: true } },
      Web: { 'inmersion.tail1b6353.ts.net:443': { Handlers: { '/': { Proxy: localTarget } } } },
      AllowFunnel: {}
    };
    expect(pickTailscaleFunnelPort(funnelOff, dnsName, localTarget)).toEqual({ port: 443, alreadyLive: false });
  });

  it('publishes geminiModelCatalogRequest and accepts observed Gemini models via POST /models', async () => {
    await pair();
    const {
      getGeminiModels,
      requestGeminiModels,
      resetGeminiModelsForTests
    } = await import('../src/main/chat-models.js');
    resetGeminiModelsForTests();
    const pending = requestGeminiModels(true);
    expect(pending.state).toBe('pending');

    const activity = await request('GET', '/status');
    expect(activity.status).toBe(200);
    expect(activity.body.geminiModelCatalogRequest).toMatchObject({ allowOpen: true });
    const nonce = (activity.body.geminiModelCatalogRequest as { nonce: string }).nonce;

    const report = await request('POST', '/models', {
      body: {
        provider: 'gemini',
        nonce,
        models: [
          { id: 'fast', label: 'Fast', description: 'Quick answers' },
          { id: 'pro', label: '2.5 Pro', description: 'Complex tasks' }
        ]
      }
    });
    expect(report.status).toBe(200);
    expect(report.body.ok).toBe(true);
    expect(getGeminiModels()).toMatchObject({
      state: 'ready',
      models: [
        { id: 'fast', label: 'Fast', description: 'Quick answers' },
        { id: 'pro', label: '2.5 Pro', description: 'Complex tasks' }
      ]
    });

    const gemConvId = 'gemini-modelselect1234';
    const selEv = await request('POST', '/events', {
      body: {
        conversationId: gemConvId,
        events: [
          { kind: 'model_selection', time: Date.now(), model: '2.5 Pro (experimental)' },
          { kind: 'user_message', time: Date.now() + 1, messageId: 'g-ms-u1', text: 'Test model selection' }
        ]
      }
    });
    expect(selEv.status).toBe(200);
    const session = await findSessionByConversation(gemConvId);
    expect(session?.selectedModel?.model).toBe('2.5 Pro (experimental)');

    resetGeminiModelsForTests();
  });

  it('preserves previousManagedFunnel ownership when a same-target Tailscale refresh fails', async () => {
    const execCalls: string[][] = [];
    const previousManagedFunnel = {
      binaryPath: 'tailscale',
      httpsPort: 443 as const,
      localTarget: 'http://127.0.0.1:43123'
    };
    const handle = await startGeminiBridge({
      mode: 'tailscale',
      localUrl: 'http://127.0.0.1:43123',
      tunnelKind: 'openai',
      tunnelPublicUrl: null,
      previousManagedFunnel,
      report: () => {},
      deps: {
        locateTailscale: () => 'tailscale',
        execTailscale: async (_bin, args) => {
          execCalls.push(args);
          if (args[0] === 'status') {
            return { exitCode: 1, stdout: '', stderr: 'timed out reading status', timedOut: false };
          }
          if (args[0] === 'serve') {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                TCP: { '443': { HTTPS: true } },
                Web: { 'demo.tail123.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:43123' } } } },
                AllowFunnel: { 'demo.tail123.ts.net:443': true }
              }),
              stderr: '',
              timedOut: false
            };
          }
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
        }
      }
    });

    expect(handle.status.state).toBe('error');
    expect(handle.managedFunnel).toEqual(previousManagedFunnel);
    await handle.stop();
    expect(execCalls.some((args) => args.join(' ') === 'funnel --https=443 off')).toBe(true);
  });

  it('batches Gemini prime reports without truncation loss and preserves explicit chatgpt worker provider', async () => {
    // 1. Multi-message packing leaves overflow messages uncompleted; oversized single report splits cleanly.
    const packed = buildGeminiPrimeReportBatch(
      [
        { id: 'm1', from: 'worker-1', text: 'First report payload '.repeat(4).trim() },
        { id: 'm2', from: 'worker-2', text: 'Second report payload '.repeat(4).trim() }
      ],
      new Map(),
      140
    );
    expect(packed.completedIds).toEqual(['m1']);
    expect(packed.nextOffset).toBeUndefined();
    expect(packed.text).toContain('First report payload');
    expect(packed.text).not.toContain('Second report payload');

    const longBody = Array.from({ length: 40 }, (_, i) => `[seg-${i}]`).join('');
    const offsets = new Map<string, number>();
    const bodySlices: string[] = [];
    for (let step = 0; step < 10; step += 1) {
      const part = buildGeminiPrimeReportBatch([{ id: 'big-1', from: 'worker-1', text: longBody }], offsets, 150);
      expect(part.text.length).toBeLessThanOrEqual(150);
      const afterHeader = part.text.replace(/^Sub-agent report received:\n\n### From: worker-1(?: \(continued\))?\n/, '');
      const bodyOnly = afterHeader.replace(/\n\n\[continued in next message\]$/, '');
      bodySlices.push(bodyOnly);
      if (part.completedIds.includes('big-1')) {
        offsets.delete('big-1');
        break;
      }
      expect(part.completedIds).toEqual([]);
      expect(part.nextOffset).toBeDefined();
      offsets.set(part.nextOffset!.id, part.nextOffset!.offset);
    }
    expect(offsets.has('big-1')).toBe(false);
    expect(bodySlices.join('')).toBe(longBody);

    // 2. Explicit chatgpt worker spawned under a Gemini prime keeps its ChatGPT open URL.
    await pair();
    const primeId = 'gemini-mixedprime1234';
    await request('POST', '/events', {
      body: {
        conversationId: primeId,
        events: [{ kind: 'user_message', time: Date.now(), messageId: 'gm-u1', text: 'Spawn mixed workers' }]
      }
    });
    const spawned = await spawnAgentWorkers(
      {
        workers: [
          { label: 'GeminiWorker', task: 'Handle Gemini side', provider: 'gemini' },
          { label: 'ChatGPTWorker', task: 'Run ChatGPT task', provider: 'chatgpt' }
        ],
        caller: { conversationId: primeId }
      },
      async () => null,
      () => true
    );
    requestWorkerBootstraps(
      spawned.created.map((worker) => worker.id),
      spawned.runId
    );
    await vi.waitFor(
      () => {
        expect(opened.some((u) => u.startsWith('https://gemini.google.com/'))).toBe(true);
        expect(opened.some((u) => u.startsWith('https://chatgpt.com/'))).toBe(true);
      },
      {
        timeout: 10_000,
        interval: 20
      }
    );
  });

  it('derives injective synthetic MCP request ids and keeps Gemini out of CoS browser routing', () => {
    const idA = syntheticMcpRequestId('gemini', 'session.a');
    const idB = syntheticMcpRequestId('gemini', 'session_a');
    const idLong1 = syntheticMcpRequestId('gemini', `${'x'.repeat(80)}-one`);
    const idLong2 = syntheticMcpRequestId('gemini', `${'x'.repeat(80)}-two`);
    expect(idA).not.toBe(idB);
    expect(idLong1).not.toBe(idLong2);
    expect(idA).toMatch(/^[a-z0-9_-]{1,100}$/i);
    expect(idLong1).toMatch(/^[a-z0-9_-]{1,100}$/i);
    expect(isSyntheticMcpRequestId(idA)).toBe(true);
    expect(isSyntheticMcpRequestId('req-transport-123')).toBe(false);
    expect(isSyntheticMcpRequestId('mcp_gemini_short')).toBe(false);

    expect(opensInCosBrowser('https://gemini.google.com/app')).toBe(false);
    expect(opensInCosBrowser('https://chatgpt.com/')).toBe(true);
  });

  it('guards stopManagedTailscaleFunnel against disabling another app or clearing on status check failure', async () => {
    const managed = { binaryPath: 'tailscale', httpsPort: 443, localTarget: 'http://127.0.0.1:43123' };

    // 1. Live mapping replaced by another app on port 443 -> skip `funnel off`, clear record.
    const replacedCalls: string[][] = [];
    const clearedOnReplace = await stopManagedTailscaleFunnel(managed, async (_bin, args) => {
      replacedCalls.push(args);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          Web: { 'demo.tail123.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } }
        }),
        stderr: '',
        timedOut: false
      };
    });
    expect(clearedOnReplace).toBe(true);
    expect(replacedCalls.some((args) => args[0] === 'funnel')).toBe(false);

    // 2. Serve status check fails -> skip `funnel off`, retain record for pending cleanup.
    const failedCalls: string[][] = [];
    const clearedOnError = await stopManagedTailscaleFunnel(managed, async (_bin, args) => {
      failedCalls.push(args);
      return { exitCode: 1, stdout: '', stderr: 'tailscaled unavailable', timedOut: false };
    });
    expect(clearedOnError).toBe(false);
    expect(failedCalls.some((args) => args[0] === 'funnel')).toBe(false);

    // 3. Port selection exhausted because other apps hold 443/8443/10000 -> carried record cleared and never turns off 443.
    const exhaustedCalls: string[][] = [];
    const exhaustedHandle = await startGeminiBridge({
      mode: 'tailscale',
      localUrl: 'http://127.0.0.1:43123',
      tunnelKind: 'openai',
      tunnelPublicUrl: null,
      previousManagedFunnel: managed,
      report: () => {},
      deps: {
        locateTailscale: () => 'tailscale',
        execTailscale: async (_bin, args) => {
          exhaustedCalls.push(args);
          if (args[0] === 'status') {
            return {
              exitCode: 0,
              stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'demo.tail123.ts.net.' } }),
              stderr: '',
              timedOut: false
            };
          }
          if (args[0] === 'serve') {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                Web: {
                  'demo.tail123.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } },
                  'demo.tail123.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9998' } } },
                  'demo.tail123.ts.net:10000': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9997' } } }
                }
              }),
              stderr: '',
              timedOut: false
            };
          }
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
        }
      }
    });
    expect(exhaustedHandle.status.state).toBe('error');
    expect(exhaustedHandle.managedFunnel).toBeNull();
    await exhaustedHandle.stop();
    expect(exhaustedCalls.some((args) => args[0] === 'funnel')).toBe(false);
  });
});
