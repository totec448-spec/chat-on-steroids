/**
 * #1832: where the Goal step reviewer meets Goal itself. A step that ends owing a Goal reply asks
 * for its review; the next step's message carries the reviewer's answer after what the helper
 * wrote (and the helper is told it is there), or says the reviewer did not answer in time; a
 * blocking finding pauses Goal and tells the person instead of typing anything.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0' },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  }
}));
const review = vi.hoisted(() => ({ started: [] as Array<{ conversationId: string; sessionId: string; turnId: string }>, current: null as unknown, cancelled: [] as string[] }));
vi.mock('../src/main/goal-reviewer.js', async (original) => ({
  ...await original<typeof import('../src/main/goal-reviewer.js')>(),
  startStepReview: async (input: { conversationId: string; sessionId: string; turnId: string }) => { review.started.push(input); return 'asked'; },
  reviewForDraft: () => review.current,
  awaitStepReview: async (_conversationId: string, _turnId: string, wanted: () => boolean) => {
    while (review.current && typeof review.current === 'object' && 'pending' in review.current && wanted()) await new Promise(resolve => setTimeout(resolve, 5));
    return review.current;
  },
  cancelStepReview: async (conversationId: string) => { review.cancelled.push(conversationId); return true; }
}));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath, setSecret } = await import('../src/main/secrets.js');
const { initDurableStore } = await import('../src/main/durable.js');
const { appendEvent, createSession, initSessionStore, resetSessionStoreForTests, readRecentEvents } = await import('../src/main/session/store.js');
const goal = await import('../src/main/goal.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;
const realFetch = globalThis.fetch;
const bodies: string[] = [];
function decision(action: 'stop' | 'continue', reply = ''): Response {
  return Response.json({ choices: [{ message: { content: JSON.stringify({ action, reply }) } }] });
}
async function settled(conversationId: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const view = goal.goalViewFor(conversationId);
    if (view && view.stage !== 'sending' && view.stage !== 'answering') return view;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('the draft never settled');
}
const seed = async (conversationId: string): Promise<string> => {
  const session = await createSession({ title: 'goal', conversationId });
  await appendEvent(session.id, { time: 1_000, source: 'extension', kind: 'user_message', message: { text: 'ship it', truncated: false, chars: 7 } });
  return session.id;
};
async function draftWith(conversationId: string, current: unknown, answer: Response) {
  const sessionId = await seed(conversationId);
  await goal.setGoalSwitchNow(conversationId, 'goal', true);
  await goal.acceptGoalReplyNow({ conversationId, sessionId, replyId: `assistant-${conversationId}`, turnId: 'g-1', eventSeq: 3, blocked: false });
  review.current = current;
  globalThis.fetch = (async (_url: string, init: { body: string }) => { bodies.push(init.body); return answer; }) as never;
  goal.startGoalDraft({ sessionId, conversationId, turnId: 'g-1' });
  return { sessionId, view: await settled(conversationId) };
}

beforeAll(async () => {
  dir = await makeTempDir('clf-goal-review-');
  initConfigPath(dir); initSecretsPath(dir); initSessionStore(dir); initDurableStore(dir);
});
afterAll(async () => { resetSessionStoreForTests(); await removeTempDir(dir); globalThis.fetch = realFetch; });
beforeEach(async () => {
  goal.resetGoalStateForTests();
  review.started.length = 0; review.current = null; review.cancelled.length = 0; bodies.length = 0;
  await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, backend: 'api', loopBackend: 'api', enabled: true, model: 'deepseek/deepseek-v4-flash', reasoning: 'default' } });
  await setSecret('openRouterApiKey', 'sk-or-test');
});
afterEach(() => { globalThis.fetch = realFetch; });

it('asks for a review when a step ends owing a Goal reply, and not for a blocked one', async () => {
  const sessionId = await seed('c-start');
  await goal.acceptGoalReplyNow({ conversationId: 'c-start', sessionId, replyId: 'assistant-start', turnId: 'g-start', eventSeq: 3, blocked: false });
  await vi.waitFor(() => expect(review.started).toEqual([{ conversationId: 'c-start', sessionId, turnId: 'g-start' }]), { timeout: 5_000 });
  const blocked = await seed('c-blocked');
  await goal.acceptGoalReplyNow({ conversationId: 'c-blocked', sessionId: blocked, replyId: 'assistant-blocked', turnId: 'g-b', eventSeq: 3, blocked: true });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(review.started.map(row => row.conversationId)).toEqual(['c-start']);
});

// CodeRabbit on #1879: a final answer recorded without its turn files its Goal reply under
// "reply:<message id>". The review must use the exact turn, which scopes the step's edits.
it('reviews the exact turn behind a reply alias, and says so when the turn is not known yet', async () => {
  const sessionId = await seed('c-alias');
  await appendEvent(sessionId, { time: 2_000, source: 'extension', kind: 'assistant_message', messageId: 'assistant-alias', turnId: 'g-real', final: true,
    message: { text: 'Done with the step.', truncated: false, chars: 19 } });
  await goal.acceptGoalReplyNow({ conversationId: 'c-alias', sessionId, replyId: 'assistant-alias', turnId: 'reply:assistant-alias', eventSeq: 3, blocked: false });
  await vi.waitFor(() => expect(review.started).toEqual([{ conversationId: 'c-alias', sessionId, turnId: 'g-real' }]), { timeout: 5_000 });
  const unknown = await seed('c-unknown');
  await goal.acceptGoalReplyNow({ conversationId: 'c-unknown', sessionId: unknown, replyId: 'assistant-unknown', turnId: 'reply:assistant-unknown', eventSeq: 3, blocked: false });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(review.started.map(row => row.conversationId)).toEqual(['c-alias']);
});

it('puts the reviewer\'s findings after the helper\'s message, and tells the helper they are there', async () => {
  const { view } = await draftWith('c-findings', { text: 'src/a.ts:12 the new branch never runs.' }, decision('continue', 'Now add the CSV export test.'));
  expect(view.stage).toBe('ready');
  expect(view.reply.endsWith('\n\nReviewer: src/a.ts:12 the new branch never runs.')).toBe(true);
  expect(bodies.at(-1)).toContain('src/a.ts:12 the new branch never runs.');
});

it('says when the reviewer did not answer in time, and adds nothing for no problems', async () => {
  expect((await draftWith('c-late', { timedOut: true }, decision('continue', 'Go on.'))).view.reply.endsWith('\n\nReviewer did not answer in time.')).toBe(true);
  const clean = (await draftWith('c-clean', { text: 'No problems found.' }, decision('continue', 'Go on.'))).view.reply;
  expect(clean).not.toContain('Reviewer');
});

it('pauses Goal on a blocking finding instead of typing anything, and says why', async () => {
  const { sessionId, view } = await draftWith('c-blocking', { text: 'BLOCKING: the migration drops the users table.' }, decision('continue', 'Go on.'));
  expect(view.stage).toBe('no-reply');
  expect(bodies).toHaveLength(0);
  expect(goal.goalSwitchFor('c-blocking').enabled).toBe(false);
  const notes = (await readRecentEvents(sessionId, 20)).filter(event => event.kind === 'note');
  expect(JSON.stringify(notes)).toContain('the migration drops the users table');
});

it('cancels the review in progress when Goal is switched off for the chat, or turned to Loop', async () => {
  await goal.setGoalSwitchNow('c-stop', 'goal', true);
  expect(review.cancelled).toEqual([]);
  await goal.setGoalSwitchNow('c-stop', 'goal', false);
  await vi.waitFor(() => expect(review.cancelled).toEqual(['c-stop']), { timeout: 5_000 });
  await goal.setGoalSwitchNow('c-loop', 'goal', true);
  await goal.setGoalSwitchNow('c-loop', 'loop', true);
  await vi.waitFor(() => expect(review.cancelled).toEqual(['c-stop', 'c-loop']), { timeout: 5_000 });
});

it('waits for a review still in progress before the helper decides the next step, then carries its findings', async () => {
  const sessionId = await seed('c-wait');
  await goal.setGoalSwitchNow('c-wait', 'goal', true);
  await goal.acceptGoalReplyNow({ conversationId: 'c-wait', sessionId, replyId: 'assistant-c-wait', turnId: 'g-1', eventSeq: 3, blocked: false });
  review.current = { pending: true };
  globalThis.fetch = (async (_url: string, init: { body: string }) => { bodies.push(init.body); return decision('continue', 'Go on.'); }) as never;
  goal.startGoalDraft({ sessionId, conversationId: 'c-wait', turnId: 'g-1' });
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(bodies).toHaveLength(0);
  review.current = { text: 'src/sum.js:1 sum subtracts.' };
  const view = await settled('c-wait');
  expect(view.reply.endsWith('\n\nReviewer: src/sum.js:1 sum subtracts.')).toBe(true);
  expect(bodies.at(-1)).toContain('src/sum.js:1 sum subtracts.');
});

// VM 141 live test, 2026-10-27: the helper ended the Goal and the reviewer's findings went only to the log.
it('shows the reviewer\'s last findings in the chat when the Goal ends without another step, and nothing for no problems', async () => {
  const met = await draftWith('c-met', { text: 'src/sum.js:1 sum subtracts.' }, decision('stop'));
  expect(met.view.stage).toBe('no-reply');
  const notes = (await readRecentEvents(met.sessionId, 20)).filter(event => event.kind === 'note');
  expect(JSON.stringify(notes)).toContain('src/sum.js:1 sum subtracts.');
  const clean = await draftWith('c-met-clean', { text: 'No problems found.' }, decision('stop'));
  expect((await readRecentEvents(clean.sessionId, 20)).filter(event => event.kind === 'note')).toEqual([]);
});

