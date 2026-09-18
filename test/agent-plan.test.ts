import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createSession, flushSessions, initSessionStore, readSessionPlan, rebindSession, resetSessionStoreForTests, sessionsRoot, updateSessionPlan } from '../src/main/session/store.js';
import { agentPlanUpdateSchema, MAX_AGENT_PLAN_BYTES } from '../src/shared/agent-plan.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import { prepareHandoff, resumeBootstrapMatches, resumeBootstrapText } from '../src/main/session/handoff.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { attachRequestPlan, reconcileRequestPlans, resetRequestPlansForTests, updateRequestPlan } from '../src/main/session/request-plans.js';

let dir: string;
const update = { plan: [{ step: 'Fix the ownership boundary', status: 'in_progress' as const, details: 'Keep one durable session across replacement chats.' }] };
beforeAll(async () => { dir = await makeTempDir('clf-agent-plan-'); initDurableStore(dir); initSessionStore(dir); });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await flushSessions(); await flushDurable(); resetRequestPlansForTests();
  resetSessionStoreForTests(); resetDurableForTests(); await removeTempDir(dir);
});

it('adds a retrievable plan notice to the durable handoff only when a nonempty plan exists', async () => {
  const session = await createSession({ conversationId: 'plan-handoff' });
  const text = 'Continue the existing work and preserve the verified results. '.repeat(6);
  expect((await prepareHandoff({ sessionId: session.id, text })).text).toBe(text.trim());
  await updateSessionPlan(session.id, 'plan-handoff', update, 100);
  const handoff = await prepareHandoff({ sessionId: session.id, text });
  expect(handoff.text).toContain(`session_id="${session.id}"`);
  expect(handoff.text).toContain('latest update_plan');
  expect(handoff.text).not.toContain(update.plan[0]!.details);
  expect(resumeBootstrapMatches(resumeBootstrapText(handoff.text), handoff.text)).toBe(true);
  await updateSessionPlan(session.id, 'plan-handoff', { plan: [] }, 200);
  expect((await prepareHandoff({ sessionId: session.id, text })).text).toBe(text.trim());
});

it('persists a plan across restart and replacement, fencing old chats and older calls', async () => {
  const session = await createSession({ conversationId: 'plan-source' });
  const other = await createSession({ conversationId: 'plan-other' });
  expect(await updateSessionPlan(session.id, 'plan-source', update, 200)).toBe(true);
  expect(await readSessionPlan(other.id)).toBeNull();
  await flushSessions();
  resetSessionStoreForTests();
  initSessionStore(dir);
  expect(await readSessionPlan(session.id)).toEqual({ ...update, updatedAt: 200 });
  expect(await rebindSession(session.id, 'plan-source', 'plan-destination')).toBe(true);
  expect(await updateSessionPlan(session.id, 'plan-source', { plan: [] }, 300)).toBe(false);
  expect(await updateSessionPlan(session.id, 'plan-destination', { plan: [] }, 100)).toBe(false);
  expect(await readSessionPlan(session.id)).toEqual({ ...update, updatedAt: 200 });
  expect(await updateSessionPlan(session.id, 'plan-destination', { plan: [] }, 400)).toBe(true);
  expect((await readSessionPlan(session.id))?.plan).toEqual([]);
});

it('serializes a concurrent rebind before a delayed source update', async () => {
  const session = await createSession({ conversationId: 'plan-race-a' });
  await updateSessionPlan(session.id, 'plan-race-a', update, 100);
  const moved = rebindSession(session.id, 'plan-race-a', 'plan-race-b');
  const late = updateSessionPlan(session.id, 'plan-race-a', { plan: [] }, 200);
  expect(await moved).toBe(true);
  expect(await late).toBe(false);
  expect((await readSessionPlan(session.id))?.plan).toEqual(update.plan);
});

it('keeps the prior document on a failed atomic replacement and permits retry', async () => {
  const session = await createSession({ conversationId: 'plan-write' });
  await updateSessionPlan(session.id, 'plan-write', update, 100);
  const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk unavailable'));
  await expect(updateSessionPlan(session.id, 'plan-write', { plan: [] }, 200)).rejects.toThrow('disk unavailable');
  rename.mockRestore();
  expect((await readSessionPlan(session.id))?.plan).toEqual(update.plan);
  expect((await fs.readdir(path.join(sessionsRoot(), session.id))).filter(name => name.endsWith('.tmp'))).toEqual([]);
  expect(await updateSessionPlan(session.id, 'plan-write', { plan: [] }, 200)).toBe(true);
});

it('bounds untrusted disk content and validates plan structure before writing', async () => {
  const session = await createSession({ conversationId: 'plan-corrupt' });
  const file = path.join(sessionsRoot(), session.id, 'plan.json');
  for (const bytes of ['{torn', 'x'.repeat(MAX_AGENT_PLAN_BYTES + 1), '{"plan":[],"updatedAt":-1}']) {
    await fs.writeFile(file, bytes);
    expect(await readSessionPlan(session.id)).toBeNull();
  }
  expect(agentPlanUpdateSchema.safeParse({ plan: [update.plan[0], update.plan[0]] }).success).toBe(false);
  expect(agentPlanUpdateSchema.safeParse({ ...update, session_id: session.id }).success).toBe(false);
  expect(agentPlanUpdateSchema.safeParse({ plan: [{ step: ' ', status: 'pending' }] }).success).toBe(false);
  expect(await updateSessionPlan(session.id, 'plan-corrupt', update, 300)).toBe(true);
});

it('persists a request-scoped plan across restart and attaches it when exact chat proof arrives', async () => {
  const conversationId = 'plan-request-owner';
  const session = await createSession({ conversationId });
  const requestId = 'wfr_plan_request_owner';
  expect(await updateRequestPlan(requestId, update, 500)).toBe(true);

  // Simulate an app restart after the tool succeeded but before Fiber proved the chat.
  resetRequestPlansForTests();
  await reconcileRequestPlans(id => id === requestId ? {
    requestId, conversationId, sessionId: session.id, messageId: 'msg-plan-request',
    tool: 'update_plan', observedAt: 600
  } : null);
  expect(await readSessionPlan(session.id)).toEqual({ ...update, updatedAt: 500 });

  expect(await updateRequestPlan('wfr_plan_request_stale', { plan: [] }, 400)).toBe(true);
  expect(await attachRequestPlan({ requestId: 'wfr_plan_request_stale', conversationId, sessionId: session.id }))
    .toBe('stale');
  expect(await readSessionPlan(session.id)).toEqual({ ...update, updatedAt: 500 });
});

it('recovers an accepted request plan after two handoffs without admitting post-handoff source work', async () => {
  const session = await createSession({ conversationId: 'pending-plan-a' });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
  try {
    await updateRequestPlan('wfr_plan_before_handoff', update, 9_900);
    clock.mockReturnValue(20_000);
    expect(await rebindSession(session.id, 'pending-plan-a', 'pending-plan-b')).toBe(true);
    clock.mockReturnValue(21_000);
    await updateRequestPlan('wfr_plan_rogue_source', { plan: [] }, 20_900);
    clock.mockReturnValue(30_000);
    expect(await rebindSession(session.id, 'pending-plan-b', 'pending-plan-c')).toBe(true);
    await flushSessions();
    resetSessionStoreForTests();
    initSessionStore(dir);
    expect(await attachRequestPlan({ requestId: 'wfr_plan_before_handoff', conversationId: 'pending-plan-a', sessionId: session.id })).toBe('attached');
    expect(await readSessionPlan(session.id)).toEqual({ ...update, updatedAt: 9_900 });
    expect(await attachRequestPlan({ requestId: 'wfr_plan_rogue_source', conversationId: 'pending-plan-a', sessionId: session.id })).toBe('stale');
    expect(await readSessionPlan(session.id)).toEqual({ ...update, updatedAt: 9_900 });
  } finally { clock.mockRestore(); }
});

it('never replaces the successor plan with an older recovered request plan', async () => {
  const session = await createSession({ conversationId: 'newer-plan-a' });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
  try {
    await updateRequestPlan('wfr_old_recovered_plan', update, 9_900);
    clock.mockReturnValue(20_000);
    expect(await rebindSession(session.id, 'newer-plan-a', 'newer-plan-b')).toBe(true);
    expect(await updateSessionPlan(session.id, 'newer-plan-b', { plan: [] }, 20_100)).toBe(true);
    expect(await attachRequestPlan({ requestId: 'wfr_old_recovered_plan', conversationId: 'newer-plan-a', sessionId: session.id })).toBe('stale');
    expect(await readSessionPlan(session.id)).toEqual({ plan: [], updatedAt: 20_100 });
  } finally { clock.mockRestore(); }
});
