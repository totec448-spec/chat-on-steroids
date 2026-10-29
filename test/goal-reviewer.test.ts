import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/main/logger.js', () => ({ logInfo: (line: string) => logs.push(line), logWarn: (line: string) => logs.push(line) }));
const logs: string[] = [];
import { REVIEW_MAX_MS } from '../src/main/agents.js';
import { awaitStepReview, cancelStepReview, reviewAnswer, resetStepReviewsForTests, reviewForDraft, reviewNote, reviewWaitUntil, startStepReview, stepFacts, type StepReviewDeps } from '../src/main/goal-reviewer.js';
import type { AgentInfo, SessionEvent, ToolCallRecord } from '../src/shared/session.js';

/**
 * #1832: when a Goal step that edited files ends, the Goal chat's reviewer worker is asked to read
 * the step's changes: woken with the new brief when it sleeps, spawned when there is none. It
 * waits for a free worker slot at most REVIEW_MAX_MS. The next step's message carries its answer,
 * or says it did not answer in time; "No problems found" adds nothing.
 */
let clock = 1_000_000;
let reviewer: AgentInfo | null = null;
const calls: string[] = [];
let spawnError: Error | null = null;
const facts = { files: [{ path: 'src/a.ts', state: 'edited' as const, added: 2, removed: 1, approximate: false, edits: 1, diff: '@@ -1 +1 @@\n-a\n+b' }], more: 0,
  step: 'Add the button.', firstRequest: 'Ship the export', chatModel: 'gpt-6-thinking' };
let stepFiles = facts.files as typeof facts.files;

function deps(over: Partial<StepReviewDeps> = {}): StepReviewDeps {
  return {
    settings: () => ({ reviewerModel: 'same', workersOn: true, profileId: 'default' }),
    mode: () => 'goal',
    objective: () => '',
    facts: async () => ({ ...facts, files: stepFiles }),
    offered: () => [{ id: 'gpt-6-thinking', label: 'GPT-6', efforts: ['high'] }],
    reviewer: () => reviewer,
    spawn: async (_caller, brief, model) => {
      calls.push(`spawn ${model} ${brief.includes('src/a.ts')}`);
      if (spawnError) { const error = spawnError; spawnError = null; throw error; }
      reviewer = { id: 'worker-3', state: 'invited', result: null, sleptAt: null, finishedAt: null, revivable: true, model } as unknown as AgentInfo;
      return 'worker-3';
    },
    wake: async (_caller, id) => { calls.push(`wake ${id}`); reviewer = { ...reviewer!, state: 'waking', result: null }; },
    cancel: async () => undefined,
    now: () => clock,
    wait: async (ms) => { clock += ms; },
    ...over
  };
}
const step = { conversationId: 'c-goal', sessionId: 'session-goal-1', turnId: 't-1' };

beforeEach(() => { clock = 1_000_000; reviewer = null; calls.length = 0; logs.length = 0; spawnError = null; stepFiles = facts.files; resetStepReviewsForTests(); });

it('spawns a reviewer on the chat\'s model for a Goal step that edited files, once per step', async () => {
  expect(await startStepReview(step, deps())).toBe('asked');
  expect(calls).toEqual(['spawn gpt-6-thinking true']);
  expect(await startStepReview(step, deps())).toBe('repeat');
  expect(calls).toHaveLength(1);
  expect(logs).toContain('goal review: asked worker-3 to review step t-1 in c-goal (1 file)');
});

it('wakes the sleeping reviewer with the next step\'s brief instead of starting another', async () => {
  reviewer = { id: 'worker-2', state: 'sleeping', result: 'No problems found.', revivable: true, model: 'gpt-6-thinking' } as unknown as AgentInfo;
  expect(await startStepReview(step, deps())).toBe('asked');
  expect(calls).toEqual(['wake worker-2']);
});

it('starts a new reviewer when the old one cannot be woken or runs another model now', async () => {
  reviewer = { id: 'worker-2', state: 'finished', result: 'done', revivable: false, model: 'gpt-6-thinking' } as unknown as AgentInfo;
  expect(await startStepReview(step, deps())).toBe('asked');
  reviewer = { id: 'worker-4', state: 'sleeping', result: 'x', revivable: true, model: 'gpt-5-6' } as unknown as AgentInfo;
  expect(await startStepReview({ ...step, turnId: 't-2' }, deps())).toBe('asked');
  expect(calls).toEqual(['spawn gpt-6-thinking true', 'spawn gpt-6-thinking true']);
});

it('asks nothing when it is off, in Loop, with Sub-agents off, or when the step changed no files', async () => {
  expect(await startStepReview(step, deps({ settings: () => ({ reviewerModel: '', workersOn: true, profileId: 'default' }) }))).toBe('off');
  expect(await startStepReview(step, deps({ mode: () => 'loop' }))).toBe('loop');
  expect(await startStepReview(step, deps({ settings: () => ({ reviewerModel: 'same', workersOn: false, profileId: 'default' }) }))).toBe('no-workers');
  stepFiles = [];
  expect(await startStepReview(step, deps())).toBe('no-edits');
  expect(calls).toEqual([]);
  expect(logs).toEqual([
    'goal review: not started for c-goal: Loop is not reviewed',
    'goal review: not started for c-goal: Sub-agents are off',
    'goal review: step t-1 in c-goal changed no files with the edit tools; nothing to review'
  ]);
});

it('uses a chosen model the account offers, and the chat\'s own model when it no longer does', async () => {
  expect(await startStepReview(step, deps({ settings: () => ({ reviewerModel: 'gpt-6-thinking', workersOn: true, profileId: 'default' }) }))).toBe('asked');
  reviewer = null;
  expect(await startStepReview({ ...step, turnId: 't-2' }, deps({ settings: () => ({ reviewerModel: 'retired', workersOn: true, profileId: 'default' }) }))).toBe('asked');
  expect(calls).toEqual(['spawn gpt-6-thinking true', 'spawn gpt-6-thinking true']);
  expect(logs).toContain('goal review: the reviewer model retired is not offered; using the Goal chat\'s model');
});

it('waits for a free worker slot, but no longer than REVIEW_MAX_MS', async () => {
  spawnError = new Error('That would make 3 live workers; the limit set in the app is 2.');
  expect(await startStepReview(step, deps())).toBe('asked');
  expect(calls).toHaveLength(2);
  reviewer = null;
  const always = deps({ spawn: async () => { throw new Error('GLOBAL_WORKER_LIMIT: that would make 9 live workers'); } });
  expect(await startStepReview({ ...step, turnId: 't-2' }, always)).toBe('no-slot');
  expect(clock - 1_000_000).toBeLessThan(REVIEW_MAX_MS + 30_000);
  expect(logs.at(-1)).toBe('goal review: no worker slot came free for step t-2 in c-goal within 10 minutes; not reviewed');
});

it('leaves a still-working earlier review alone', async () => {
  reviewer = { id: 'worker-2', state: 'active', result: null, revivable: true, model: 'gpt-6-thinking' } as unknown as AgentInfo;
  expect(await startStepReview(step, deps())).toBe('busy');
  expect(calls).toEqual([]);
});

it('hands the next step the review of exactly its own step, or says it did not answer in time', async () => {
  const d = deps();
  await startStepReview(step, d);
  expect(reviewForDraft('c-goal', 't-1', d)).toEqual({ pending: true });
  expect(reviewForDraft('c-goal', 't-0', d)).toBeNull();
  reviewer = { ...reviewer!, state: 'sleeping', result: 'src/a.ts:1 the button has no label.', sleptAt: clock + 1 };
  expect(reviewForDraft('c-goal', 't-1', d)).toEqual({ text: 'src/a.ts:1 the button has no label.' });
  reviewer = { ...reviewer!, state: 'active', result: null, sleptAt: null };
  clock += REVIEW_MAX_MS;
  expect(reviewForDraft('c-goal', 't-1', d)).toEqual({ timedOut: true });
});

it('writes the next step\'s line: findings, a timeout, a blocking finding, or nothing', () => {
  expect(reviewNote({ text: 'No problems found.' })).toBe('');
  expect(reviewNote({ text: 'no problems found' })).toBe('');
  expect(reviewNote({ timedOut: true })).toBe('Reviewer did not answer in time.');
  expect(reviewNote({ text: 'src/a.ts:1 missing label.' })).toBe('Reviewer: src/a.ts:1 missing label.');
  expect(reviewNote({ pending: true })).toBe('');
  expect(reviewNote({ unavailable: true })).toBe('Reviewer could not review this step.');
  expect(reviewNote(null)).toBe('');
  expect(reviewNote({ text: 'x'.repeat(10_000) }).length).toBeLessThanOrEqual(4_011);
});

it('reads a step\'s facts from the recording: its instruction, the request, the chat\'s model and each file\'s net diff', async () => {
  let seq = 0;
  const base = (over: object) => ({ seq: ++seq, time: seq, source: 'page', ...over }) as unknown as SessionEvent;
  const events = [
    base({ kind: 'user_message', message: { text: 'Ship the export', truncated: false, chars: 15 }, model: 'gpt-6-thinking' }),
    base({ kind: 'turn_start', turnId: 't-0' }),
    base({ kind: 'turn_end', turnId: 't-0', outcome: 'completed' }),
    base({ kind: 'user_message', message: { text: 'Add the button.', truncated: false, chars: 15 }, model: 'gpt-6-thinking' }),
    base({ kind: 'turn_start', turnId: 't-1' }),
    base({ kind: 'tool_call', turnId: 't-1', source: 'mcp', call: { callId: '00000000-0000-4000-8000-000000000001', tool: 'apply_patch', outcome: 'ok',
      summary: { title: 'Edited', tone: 'good', kind: 'edit' }, changes: [{ path: 'src/a.ts', added: 1, removed: 1, approximate: false, reviewAssetId: 'asset-1' }] } as unknown as ToolCallRecord })
  ];
  const read = await stepFacts(events, 't-1', async () => ({ before: 'a\n', after: 'b\n' }));
  expect(read).toMatchObject({ step: 'Add the button.', firstRequest: 'Ship the export', chatModel: 'gpt-6-thinking', more: 0 });
  expect(read.files).toEqual([expect.objectContaining({ path: 'src/a.ts', state: 'edited', diff: '@@ -1,1 +1,1 @@\n-a\n+b' })]);
});

it('cancels a review in progress when the Goal stops, and leaves a sleeping reviewer\'s chat alone', async () => {
  const cancelled: string[] = [];
  const d = deps({ cancel: async info => { cancelled.push(info.id); } });
  await startStepReview(step, d);
  expect(await cancelStepReview('c-goal', d)).toBe(true);
  expect(cancelled).toEqual(['worker-3']);
  expect(reviewForDraft('c-goal', 't-1', d)).toBeNull();
  expect(logs.at(-1)).toBe('goal review: Goal stopped in c-goal; the review by worker-3 was cancelled, its chat stays');
  reviewer = { id: 'worker-3', state: 'sleeping', result: 'x', revivable: true, model: null } as unknown as AgentInfo;
  expect(await cancelStepReview('c-goal', d)).toBe(false);
  expect(cancelled).toHaveLength(1);
});

// CodeRabbit on #1879: Goal stopped while the reviewer was still being started. The stop found no
// reviewer to cancel yet; the spawn then went on and left a reviewer working for a stopped Goal.
it('cancels a reviewer that a stopped Goal started while the stop was being handled', async () => {
  const cancelled: string[] = [];
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const spawning = new Promise<void>(resolve => { entered = resolve; });
  const d = deps({
    cancel: async info => { cancelled.push(info.id); },
    spawn: async () => { entered(); await gate; reviewer = { id: 'worker-3', state: 'invited', result: null, revivable: true, model: null } as unknown as AgentInfo; return 'worker-3'; }
  });
  const started = startStepReview(step, d);
  // Goal stops while the spawn is under way, before any reviewer exists to cancel.
  await spawning;
  expect(reviewer).toBeNull();
  expect(await cancelStepReview('c-goal', d)).toBe(false);
  release();
  expect(await started).toBe('failed');
  expect(cancelled).toEqual(['worker-3']);
  expect(reviewForDraft('c-goal', 't-1', d)).toBeNull();
});

// VM 141 live test, 2026-10-26: the Goal helper decided the next step 8 s before the reviewer answered,
// because the draft took the review as it stood then ("pending" wrote nothing).
it('counts a review that is still finding a worker slot as pending, and a reviewer that stopped without answering as unavailable', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const d = deps({ facts: async () => { await gate; return { ...facts, files: stepFiles }; } });
  const started = startStepReview(step, d);
  expect(reviewForDraft('c-goal', 't-1', d)).toEqual({ pending: true });
  release();
  await started;
  reviewer = { ...reviewer!, state: 'failed', result: null };
  expect(reviewForDraft('c-goal', 't-1', d)).toEqual({ unavailable: true });
  reviewer = null;
  expect(reviewForDraft('c-goal', 't-1', d)).toEqual({ unavailable: true });
});

// CodeRabbit on #1879: the next step's draft waits for the review, but only a reviewer that already
// had a worker slot showed that wait; one still reading the step or finding a slot showed none.
it('says until when the next step waits for a review, from reading the step and finding a slot to the answer', async () => {
  let release!: () => void, waiting!: () => void;
  const slot = new Promise<void>(resolve => { release = resolve; });
  const inWait = new Promise<void>(resolve => { waiting = resolve; });
  spawnError = new Error('NO_FREE_SLOT');
  const d = deps({ wait: async ms => { waiting(); await slot; clock += ms; } });
  expect(reviewWaitUntil('c-goal', d)).toBeNull();
  const started = startStepReview(step, d);
  await inWait;
  expect(reviewWaitUntil('c-goal', d)).toBe(1_000_000 + REVIEW_MAX_MS);
  release();
  expect(await started).toBe('asked');
  // The limit counts from when the reviewer was asked, as the draft's own wait does.
  expect(reviewWaitUntil('c-goal', d)).toBe(clock + REVIEW_MAX_MS);
  reviewer = { ...reviewer!, state: 'sleeping', result: 'No problems found.', sleptAt: clock };
  expect(reviewWaitUntil('c-goal', d)).toBeNull();
});

it('waits for the review of the step before the next step is decided, and stops waiting when the draft is no longer wanted', async () => {
  const d = deps({ wait: async (ms) => {
    clock += ms;
    if (clock - 1_000_000 >= 3_000) reviewer = { ...reviewer!, state: 'sleeping', result: 'src/a.ts:1 off by one.', sleptAt: clock };
  } });
  await startStepReview(step, d);
  expect(await awaitStepReview('c-goal', 't-1', () => true, d)).toEqual({ text: 'src/a.ts:1 off by one.' });
  resetStepReviewsForTests(); reviewer = null; clock = 1_000_000;
  await startStepReview(step, d);
  let wanted = 2;
  expect(await awaitStepReview('c-goal', 't-1', () => wanted-- > 0, deps())).toBeNull();
  expect(await awaitStepReview('c-other', 't-1', () => true, d)).toBeNull();
});

// VM 141 live test, 2026-10-27: workers finish under RESULT / CHANGES / VALIDATION / BLOCKERS, so a clean
// review read "RESULT: No problems found. CHANGES: …" and went into the chat as findings.
it('takes the review from the RESULT section of a worker report, and the whole answer otherwise', async () => {
  expect(reviewAnswer('RESULT: No problems found.\nCHANGES: None (read-only review).\nVALIDATION: Read both files.\nBLOCKERS: None.')).toBe('No problems found.');
  expect(reviewAnswer('RESULT: BLOCKING: the migration drops the users table.\nCHANGES: None\nBLOCKERS: None')).toBe('BLOCKING: the migration drops the users table.');
  expect(reviewAnswer('RESULT:\n- src/a.ts:1 the label is missing.\n- src/b.ts:2 off by one.\n\nCHANGES: None.')).toBe('- src/a.ts:1 the label is missing.\n- src/b.ts:2 off by one.');
  expect(reviewAnswer('**RESULT:** src/a.ts:1 off by one.\n**CHANGES:** none')).toBe('src/a.ts:1 off by one.');
  expect(reviewAnswer('src/a.ts:1 off by one.')).toBe('src/a.ts:1 off by one.');
  const d = deps();
  await startStepReview(step, d);
  reviewer = { ...reviewer!, state: 'sleeping', result: 'RESULT: No problems found.\nCHANGES: None.\nVALIDATION: Read it.\nBLOCKERS: None.', sleptAt: clock + 1 };
  const review = reviewForDraft('c-goal', 't-1', d);
  expect(review).toEqual({ text: 'No problems found.' });
  expect(reviewNote(review)).toBe('');
});

