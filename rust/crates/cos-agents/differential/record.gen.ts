/**
 * Runs the broker ops in `COS_AGENTS_OPS` against the real TypeScript broker (`main/agents.ts`)
 * and leaves `state/swarm.json`, `state/retired-workers.json` and the answers in
 * `COS_AGENTS_OUT`. `run.mjs` runs the same ops against the Rust broker and compares the folders.
 *
 * Each answer carries `swarmState()`, the snapshot `/v1/agents` projects. An op names its caller
 * by conversation; `prime` names the family a browser observation belongs to by its prime chat.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

const out = process.env.COS_AGENTS_OUT;
const opsFile = process.env.COS_AGENTS_OPS;

it.runIf(out && opsFile)('runs the broker ops', async () => {
  const { defaultConfig, initConfigPath, saveConfig } = await import('../../../../src/main/config.js');
  const { initDurableStore } = await import('../../../../src/main/durable.js');
  const { initSessionStore } = await import('../../../../src/main/session/store.js');
  const agents = await import('../../../../src/main/agents.js');
  const ops = JSON.parse(readFileSync(opsFile!, 'utf8')) as Array<Record<string, any>>;
  initConfigPath(out!); initDurableStore(out!); initSessionStore(out!);
  const base = defaultConfig();
  await saveConfig({ ...base, multiAgent: { ...base.multiAgent, enabled: true, maxWorkers: 3, allowUnattributedCalls: false } });
  agents.onSwarmPersistNow(async () => undefined);
  const runOf = (prime?: string) => (prime ? agents.currentRunId(prime) ?? undefined : undefined);
  const answers: unknown[] = [];
  for (const op of ops) {
    let answer: unknown = null;
    try {
      switch (op.op) {
        case 'spawn': {
          const staged = agents.stageSpawn({ workers: op.workers, context: op.context ?? null, caller: op.caller });
          staged.commit();
          answer = { runId: staged.runId, becamePrime: staged.becamePrime, created: staged.created.map((info) => [info.id, info.state]) };
          break;
        }
        case 'bind':
          answer = agents.bindConversation(op.id, op.conversationId, runOf(op.prime));
          break;
        case 'message': {
          const staged = agents.stageMessages(op.caller, op.items);
          staged.commit();
          answer = { runId: staged.runId, to: staged.messages.map((message) => message.to), waking: staged.waking };
          break;
        }
        case 'offer':
          answer = agents.offerMessagesForCaller(op.caller)?.messages.map((message) => [message.from, message.text, message.offers]) ?? null;
          break;
        case 'ack':
          answer = agents.acknowledgeOffersForCaller(op.caller)?.messages.map((message) => message.id) ?? null;
          break;
        case 'finish': {
          const staged = agents.stageFinishAgent(op.caller, op.result);
          staged.commit();
          answer = { state: staged.info.state, repeat: staged.repeat, report: staged.report?.text ?? null };
          break;
        }
        case 'status': {
          const status = agents.statusForCaller(op.caller);
          answer = { self: status.self?.id ?? null, runId: status.runId, free: status.freeWorkerSlots, agents: status.state.agents.map((info) => [info.id, info.state]) };
          break;
        }
        case 'context':
          agents.noteAgentContextTokens(op.conversationId, op.tokens);
          break;
        case 'release':
          answer = agents.releaseQuiescentRun();
          break;
        case 'revived': {
          const runId = runOf(op.prime);
          const revival = agents.pendingWorkerRevivals().find((entry) => entry.id === op.id && entry.runId === runId);
          answer = revival ? [revival.text, agents.noteWorkerRevived(op.id, revival.conversationId, revival.messageIds, null, runId)] : null;
          break;
        }
        case 'failRevival':
          answer = agents.failWorkerRevival(op.id, op.why, runOf(op.prime))?.text ?? null;
          break;
        case 'sleep':
          answer = agents.sleepWorker(op.id, op.reason, runOf(op.prime))?.report?.text ?? null;
          break;
        case 'fail':
          answer = agents.failAgent(op.id, op.reason, undefined, {}, runOf(op.prime))?.report?.text ?? null;
          break;
        case 'clear':
          answer = agents.clearAgent(op.id, runOf(op.prime)).cleared;
          break;
        case 'disable':
          answer = agents.pauseSwarmForDisable();
          break;
        case 'restart': {
          const swarm = JSON.parse(JSON.stringify(agents.snapshotSwarm()));
          const retired = JSON.parse(JSON.stringify(agents.snapshotRetiredWorkers()));
          agents.resetAgentsForTests();
          agents.onSwarmPersistNow(async () => undefined);
          agents.restoreRetiredWorkers(retired);
          agents.restoreSwarm(swarm);
          break;
        }
        default:
          throw new Error(`unknown op ${op.op}`);
      }
    } catch (error) {
      answer = { error: error instanceof Error ? error.message : String(error) };
    }
    answers.push({ op: op.op, answer, swarm: agents.swarmState() });
  }
  mkdirSync(path.join(out!, 'state'), { recursive: true });
  const swarm = agents.snapshotSwarm();
  if (swarm) writeFileSync(path.join(out!, 'state', 'swarm.json'), JSON.stringify(swarm, null, 2));
  writeFileSync(path.join(out!, 'state', 'retired-workers.json'), JSON.stringify(agents.snapshotRetiredWorkers(), null, 2));
  writeFileSync(path.join(out!, 'answers.json'), JSON.stringify(answers, null, 2));
  expect(answers.length).toBe(ops.length);
}, 120_000);
