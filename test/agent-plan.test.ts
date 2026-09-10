import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createSession, flushSessions, initSessionStore, readSessionPlan, rebindSession, resetSessionStoreForTests, sessionsRoot, updateSessionPlan } from '../src/main/session/store.js';
import { agentPlanUpdateSchema, MAX_AGENT_PLAN_BYTES } from '../src/shared/agent-plan.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import { prepareHandoff, resumeBootstrapMatches, resumeBootstrapText } from '../src/main/session/handoff.js';

let dir: string;
const update = { plan: [{ step: 'Fix the ownership boundary', status: 'in_progress' as const, details: 'Keep one durable session across replacement chats.' }] };
beforeAll(async () => { dir = await makeTempDir('clf-agent-plan-'); initSessionStore(dir); });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await flushSessions(); resetSessionStoreForTests(); await removeTempDir(dir); });

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
