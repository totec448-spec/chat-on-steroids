import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initConfigPath, defaultConfig, saveConfig } from '../src/main/config.js';
import { initDurableStore, readDurable, writeDurableNow, flushDurable, resetDurableForTests } from '../src/main/durable.js';
import { initSessionStore, getSession, createSession, findSessionByConversation, listSessions, resetSessionStoreForTests } from '../src/main/session/store.js';
import { enqueueInput, listInputs, pendingBrowserInputs, claimBrowserInput, authorizeBrowserInput, acknowledgeBrowserInput, bindBrowserInputProject,
  cancelInput, failBrowserInput, resetInputForTests, configureInputDelivery, setInputAutomation, type InputArgs, type InputEntry } from '../src/main/session/input.js';
import { addProject } from '../src/main/projects.js';
import { validateNewRoot } from '../src/main/sandbox.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;
const args = (over: Partial<InputArgs> = {}): InputArgs => ({ id: randomUUID(), sessionId: null, text: 'Independent task', mode: 'auto',
  dueAt: Date.now(), model: 'gpt-5-6-thinking', reasoningEffort: 'high', automation: 'off', ...over });
const legacy = (over: Partial<InputEntry> = {}): InputEntry => ({ ...args(), state: 'queued', owner: null,
  createdAt: Date.now(), conversationId: null, ...over });
beforeEach(async () => {
  directory = await makeTempDir('clf-openings-');
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory); resetInputForTests();
  await saveConfig(defaultConfig());
  configureInputDelivery({ applyAutomation: async () => {}, changed: () => {} });
});
afterEach(async () => {
  vi.restoreAllMocks(); await flushDurable(); resetInputForTests(); resetSessionStoreForTests(); resetDurableForTests(); await removeTempDir(directory);
});

it('admits twenty independent durable sessions before any native ACK and preserves exact retry identity', async () => {
  const requests = Array.from({ length: 20 }, (_, n) => args({ text: `Independent task ${n}` }));
  const accepted = await Promise.all(requests.map(request => enqueueInput(request)));
  expect(new Set(accepted.map(row => row.sessionId)).size).toBe(20);
  for (const [n, row] of accepted.entries()) {
    expect(row).toMatchObject({ opening: true, state: 'queued', conversationId: null, text: requests[n]!.text, model: 'gpt-5-6-thinking', reasoningEffort: 'high' });
    expect(row.deliveredAt).toBeUndefined();
    expect(await getSession(row.sessionId!)).toMatchObject({ id: row.sessionId, conversationId: null, origin: { kind: 'desktop' } });
    expect((await enqueueInput(requests[n]!)).sessionId).toBe(row.sessionId);
  }
  expect(await pendingBrowserInputs()).toHaveLength(20);
  resetInputForTests(); resetSessionStoreForTests(); initSessionStore(directory);
  expect((await listInputs()).map(row => row.sessionId).sort()).toEqual(accepted.map(row => row.sessionId).sort());
  await expect(enqueueInput({ ...requests[0]!, text: 'Different work' })).rejects.toThrow('different input');
  await expect(enqueueInput(args({ sessionId: accepted[0]!.sessionId }))).rejects.toThrow('no ChatGPT conversation');
});

it('materializes an accepted opening WAL after a crash before session creation without a second owner', async () => {
  const request = args();
  const row: InputEntry = { ...request, sessionId: request.id, opening: true, state: 'queued', owner: null, createdAt: Date.now(), conversationId: null };
  await writeDurableNow('session-input', [row]);
  resetInputForTests();
  expect(await getSession(request.id)).toBeNull();
  expect((await listInputs())[0]?.sessionId).toBe(request.id);
  expect(await getSession(request.id)).toMatchObject({ id: request.id, origin: { kind: 'desktop' } });
  expect((await enqueueInput(request)).sessionId).toBe(request.id);
  expect(await readDurable<InputEntry[]>('session-input')).toHaveLength(1);
});

it('migrates real legacy ordinary openings to durable owners without changing custody or payload', async () => {
  const requestedRoot = path.join(directory, 'approved');
  await fs.mkdir(requestedRoot, { recursive: true });
  const approved = await validateNewRoot(requestedRoot, []);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'approved', path: approved }] });
  const project = await addProject(approved);
  const stamp = Date.now();
  const queued = legacy({ projectId: project.id, text: 'Queued legacy opening' });
  const browser = legacy({ text: 'Claimed legacy opening', state: 'browser', owner: 'legacy-page', offeredAt: stamp,
    requiresAuthorization: true, sendAuthorizedAt: stamp, deliveryText: 'Frozen prepared opening' });
  const plan = legacy({ text: 'Implement the complete legacy plan', objective: 'Complete every requirement',
    stages: ['Verify the complete result'], state: 'failed', owner: 'legacy-page', offeredAt: stamp,
    requiresAuthorization: true, error: 'Before Send: composer unavailable' });
  const cancelled = legacy({ text: 'Ambiguous cancelled opening', state: 'cancelled', owner: 'legacy-page',
    offeredAt: stamp, requiresAuthorization: true, sendAuthorizedAt: stamp,
    error: 'Stopped waiting for delivery confirmation. The message may already have been sent.' });
  const originals = [queued, browser, plan, cancelled];
  await writeDurableNow('session-input', originals); resetInputForTests();

  const restored = await listInputs();
  expect(restored.map(row => row.id)).toEqual(originals.map(row => row.id));
  for (const original of originals) {
    const row = restored.find(candidate => candidate.id === original.id)!;
    expect(row).toMatchObject({ ...original, opening: true, requestedSessionId: null, sessionId: original.id });
    expect(await getSession(original.id)).toMatchObject({ id: original.id, conversationId: null, origin: { kind: 'desktop' } });
  }
  expect((await getSession(queued.id))?.projectId).toBe(project.id);
  expect((await pendingBrowserInputs()).map(row => row.id)).toEqual([queued.id]);

  const beforeRestart = (await listSessions()).map(row => row.id).sort();
  resetInputForTests(); resetSessionStoreForTests(); initSessionStore(directory);
  expect((await listInputs()).map(row => row.sessionId)).toEqual(originals.map(row => row.id));
  expect((await listSessions()).map(row => row.id).sort()).toEqual(beforeRestart);

  const retry = await enqueueInput(args({ sessionId: plan.id, text: plan.text, objective: plan.objective, stages: plan.stages }));
  expect(retry).toMatchObject({ opening: true, requestedSessionId: plan.id, sessionId: plan.id,
    text: plan.text, objective: plan.objective, stages: plan.stages, state: 'queued' });
  await expect(enqueueInput(args({ sessionId: cancelled.id, text: cancelled.text }))).rejects.toThrow('no ChatGPT conversation');
  expect((await listInputs()).find(row => row.id === browser.id)).toMatchObject({
    state: 'browser', owner: 'legacy-page', offeredAt: stamp, sendAuthorizedAt: stamp, deliveryText: 'Frozen prepared opening'
  });
});

it('reuses a session materialized before the legacy migration commit across repeated restarts', async () => {
  const row = legacy({ text: 'Interrupted migration boundary' });
  await createSession({ reservedId: row.id, title: row.text, origin: { kind: 'desktop', fromSessionId: null, agentId: null, task: '' } });
  await writeDurableNow('session-input', [row]); resetInputForTests(); resetSessionStoreForTests(); initSessionStore(directory);
  expect((await listInputs())[0]).toMatchObject({ id: row.id, opening: true, requestedSessionId: null, sessionId: row.id });
  expect((await listSessions()).map(session => session.id)).toEqual([row.id]);
  resetInputForTests(); resetSessionStoreForTests(); initSessionStore(directory);
  expect((await listInputs())[0]?.sessionId).toBe(row.id);
  expect((await listSessions()).map(session => session.id)).toEqual([row.id]);
});

it('retains exact existing owners, exposes conflicts unbound, and never migrates delivered or non-opening roles', async () => {
  const exactConversation = randomUUID(); const exactOwner = await createSession({ conversationId: exactConversation });
  const conflictConversation = randomUUID();
  await createSession({ conversationId: conflictConversation }); await createSession({ conversationId: conflictConversation });
  const deliveredConversation = randomUUID(); const deliveredOwner = await createSession({ conversationId: deliveredConversation });
  const exact = legacy({ text: 'Exact existing owner', conversationId: exactConversation, state: 'failed', error: 'Visible failure' });
  const conflictStamp = Date.now();
  const conflicted = legacy({ text: 'Conflicting provider owners', conversationId: conflictConversation,
    state: 'browser', owner: 'conflict-page', offeredAt: conflictStamp, sendAuthorizedAt: conflictStamp });
  const delivered = legacy({ text: 'Already delivered', conversationId: deliveredConversation, state: 'sent', owner: 'old-page',
    messageId: 'native-delivered', deliveredAt: 12, historyRecorded: true });
  const orphanDelivered = legacy({ text: 'Delivered without a current catalog owner', conversationId: randomUUID(), state: 'sent', owner: 'old-page',
    messageId: 'native-orphan', deliveredAt: 13, historyRecorded: true });
  const helper = legacy({ text: 'Decision helper', purpose: 'decision', state: 'failed', error: 'Helper failed' });
  const checkpoint = legacy({ text: 'Later checkpoint', mode: 'finish' });
  const generated = legacy({ text: 'Generated finish work', finishOwner: { turnId: 'turn-one', periodic: false } });
  const companion = legacy({ text: 'Companion' });
  const root = legacy({ text: 'Combined root', companionInputId: companion.id });
  await writeDurableNow('session-input', [exact, conflicted, delivered, orphanDelivered, helper, checkpoint, generated, root, companion]);
  resetInputForTests();

  const rows = await listInputs();
  expect(rows.find(row => row.id === exact.id)).toMatchObject({ opening: true, requestedSessionId: null, sessionId: exactOwner.id });
  expect(await getSession(exact.id)).toBeNull();
  expect(rows.find(row => row.id === conflicted.id)).toMatchObject({ opening: true, requestedSessionId: null,
    sessionId: conflicted.id, state: 'browser', owner: 'conflict-page', offeredAt: conflictStamp, sendAuthorizedAt: conflictStamp });
  expect(await getSession(conflicted.id)).toMatchObject({ conversationId: null, origin: { kind: 'desktop' } });
  expect(await acknowledgeBrowserInput(conflicted.id, 'conflict-page', conflictConversation, 'late-conflicted-receipt')).toBe(false);
  expect((await getSession(conflicted.id))?.conversationId).toBeNull();
  expect(rows.find(row => row.id === delivered.id)).toMatchObject({ sessionId: null, deliveredSessionId: deliveredOwner.id, state: 'sent' });
  expect(await getSession(delivered.id)).toBeNull();
  expect(rows.find(row => row.id === orphanDelivered.id)).toMatchObject({ sessionId: null, state: 'sent' });
  expect(rows.find(row => row.id === orphanDelivered.id)?.deliveredSessionId).toBeUndefined();
  expect(await getSession(orphanDelivered.id)).toBeNull();
  for (const row of [helper, checkpoint, generated, root, companion]) {
    const retained = rows.find(candidate => candidate.id === row.id)!;
    expect(retained.opening).toBeUndefined(); expect(retained.sessionId).toBeNull();
    expect(await getSession(row.id)).toBeNull();
  }
});

it('binds an exact authorized opening before recording and acknowledges only its reserved session', async () => {
  const row = await enqueueInput(args({ automation: 'loop', objective: 'Complete all constraints' }));
  const conversation = randomUUID();
  expect(await claimBrowserInput(row.id, 'owner', null, true)).toMatchObject({ opening: true, sessionId: row.sessionId });
  expect(await bindBrowserInputProject(row.id, 'owner', conversation)).toBe(false);
  expect(await authorizeBrowserInput(row.id, 'owner', null)).toBe(true);
  expect(await bindBrowserInputProject(row.id, 'other', conversation)).toBe(false);
  expect(await bindBrowserInputProject(row.id, 'owner', conversation)).toBe(true);
  expect((await findSessionByConversation(conversation, { requireUnique: true }))?.id).toBe(row.sessionId);
  expect(await bindBrowserInputProject(row.id, 'owner', randomUUID())).toBe(false);
  expect(await acknowledgeBrowserInput(row.id, 'owner', conversation, 'native-message')).toBe(true);
  expect((await listInputs())[0]).toMatchObject({ sessionId: row.sessionId, deliveredSessionId: row.sessionId, state: 'sent', opening: true });
});

it('rejects another recording collision and never binds a cancelled unauthorized opening', async () => {
  const row = await enqueueInput(args());
  await claimBrowserInput(row.id, 'owner', null, true);
  await authorizeBrowserInput(row.id, 'owner', null);
  const conversation = randomUUID(); const other = await createSession({ conversationId: conversation });
  expect(await bindBrowserInputProject(row.id, 'owner', conversation)).toBe(false);
  expect((await findSessionByConversation(conversation))?.id).toBe(other.id);
  const cancelled = await enqueueInput(args());
  await claimBrowserInput(cancelled.id, 'other-owner', null, true); await cancelInput(cancelled.id);
  expect(await acknowledgeBrowserInput(cancelled.id, 'other-owner', randomUUID(), 'never-sent')).toBe(false);
  expect(await getSession(cancelled.sessionId!)).toBeNull();
});

it('keeps an unoffered opening queued past connection startup and edits only its automation', async () => {
  const row = await enqueueInput(args()); const second = await enqueueInput(args());
  expect(await setInputAutomation(row.id, 'loop', true)).toBe(true);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
  expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'queued', automation: 'loop', loopAfterTurn: true });
  expect((await listInputs()).find(entry => entry.id === second.id)).toMatchObject({ state: 'queued', automation: 'off' });
});

it('keeps legacy canonical bytes valid after partial session creation and retry', async () => {
  const request = args(); const sessionDirectory = path.join(directory, 'sessions', request.id);
  await fs.mkdir(sessionDirectory, { recursive: true });
  const canonical = JSON.stringify({ 'existing-message': { id: 'existing-message', text: 'Keep these exact bytes' } });
  await fs.writeFile(path.join(sessionDirectory, 'messages.json'), canonical);
  const rename = fs.rename.bind(fs); let failed = false;
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (!failed && String(to) === path.join(sessionDirectory, 'meta.json')) { failed = true; throw new Error('reserved meta unavailable'); }
    await rename(from, to);
  });
  await expect(enqueueInput(request)).rejects.toThrow('reserved meta unavailable');
  expect((await readDurable<InputEntry[]>('session-input'))![0]).toMatchObject({ id: request.id, sessionId: request.id, error: expect.stringContaining('Local chat setup failed') });
  resetInputForTests(); resetSessionStoreForTests(); initSessionStore(directory);
  expect((await listInputs())[0]).toMatchObject({ id: request.id, state: 'queued', sessionId: request.id });
  expect((await enqueueInput(request)).sessionId).toBe(request.id);
  const bytes = await fs.readFile(path.join(sessionDirectory, 'messages.json'), 'utf8');
  expect(bytes).toBe(canonical); expect(JSON.parse(bytes)).toHaveProperty('existing-message');
});

it('isolates one missing project among twenty accepted opening recoveries', async () => {
  const rows: InputEntry[] = Array.from({ length: 20 }, (_, n) => {
    const request = args({ text: `Recovery ${n}`, ...(n === 7 ? { projectId: randomUUID() } : {}) });
    return { ...request, sessionId: request.id, opening: true, state: 'queued', owner: null, createdAt: Date.now(), conversationId: null };
  });
  await writeDurableNow('session-input', rows); resetInputForTests();
  const restored = await listInputs(); expect(restored).toHaveLength(20);
  expect(restored.filter(row => row.error)).toEqual([expect.objectContaining({ id: rows[7]!.id, error: expect.stringContaining('Local chat setup failed') })]);
  expect(await getSession(rows[7]!.sessionId!)).toMatchObject({ id: rows[7]!.sessionId, conversationId: null });
  const pending = await pendingBrowserInputs(); expect(pending).toHaveLength(19);
  expect(pending.some(row => row.id === rows[7]!.id)).toBe(false);
  expect(await cancelInput(rows[7]!.id)).toBe(true);
});

it('keeps a reviewed pre-send retry in its session but refuses ambiguous Send replay', async () => {
  const row = await enqueueInput(args());
  await claimBrowserInput(row.id, 'failed-owner', null, true);
  await failBrowserInput(row.id, 'failed-owner', 'Before Send: composer unavailable');
  const retryArgs = args({ sessionId: row.sessionId });
  const retry = await enqueueInput(retryArgs);
  expect(retry).toMatchObject({ sessionId: row.sessionId, opening: true, state: 'queued' });
  expect((await enqueueInput(retryArgs)).id).toBe(retry.id);
  await claimBrowserInput(retry.id, 'retry-owner', null, true);
  await authorizeBrowserInput(retry.id, 'retry-owner', null);
  await cancelInput(retry.id);
  await expect(enqueueInput(args({ sessionId: row.sessionId }))).rejects.toThrow('no ChatGPT conversation');
  expect(await acknowledgeBrowserInput(retry.id, 'retry-owner', randomUUID(), 'late-real-receipt')).toBe(true);
  expect((await listInputs()).find(entry => entry.id === retry.id)).toMatchObject({ state: 'cancelled', deliveredSessionId: row.sessionId });
});

it('does not let a generic failed label erase native Send authorization', async () => {
  const row = await enqueueInput(args());
  await claimBrowserInput(row.id, 'authorized-owner', null, true);
  expect(await authorizeBrowserInput(row.id, 'authorized-owner', null)).toBe(true);
  expect(await failBrowserInput(row.id, 'authorized-owner', 'Ambiguous transport error')).toBe(true);
  await expect(enqueueInput(args({ sessionId: row.sessionId }))).rejects.toThrow('no ChatGPT conversation');
  expect((await listInputs()).filter(entry => entry.sessionId === row.sessionId)).toHaveLength(1);
});

it.each([false, true])('removes only the withdrawn empty reservation and keeps its tombstone (claimed=%s)', async claimed => {
  const request = args(); const row = await enqueueInput(request);
  const retained = await enqueueInput(args());
  if (claimed) await claimBrowserInput(row.id, 'withdrawn-page', null, true);
  expect(await cancelInput(row.id)).toBe(true);
  expect(await getSession(row.sessionId!)).toBeNull();
  expect(await getSession(retained.sessionId!)).not.toBeNull();
  expect(await authorizeBrowserInput(row.id, 'withdrawn-page', null)).toBe(false);
  resetInputForTests(); resetSessionStoreForTests(); initSessionStore(directory);
  expect(await enqueueInput(request)).toMatchObject({ state: 'cancelled', cancelledByUser: true });
  expect(await getSession(row.sessionId!)).toBeNull();
});

it('recovers an older explicit pre-Send withdrawal without deleting a timed-out opening', async () => {
  const withdrawn = await enqueueInput(args()), timedOut = await enqueueInput(args());
  await writeDurableNow('session-input', [
    { ...withdrawn, state: 'cancelled', requiresAuthorization: true, offeredAt: Date.now(), error: 'Not sent: this delivery was cancelled before Send was authorized.' },
    { ...timedOut, state: 'cancelled', requiresAuthorization: true, offeredAt: Date.now(), error: 'Not sent: browser preparation timed out. This attempt was cancelled.' }
  ]);
  resetInputForTests(); await listInputs();
  expect(await getSession(withdrawn.sessionId!)).toBeNull();
  expect(await getSession(timedOut.sessionId!)).not.toBeNull();
});

it('refuses to become a third owner when a provider conversation is already duplicated', async () => {
  const conversation = randomUUID();
  const first = await createSession({ conversationId: conversation });
  const second = await createSession({ conversationId: conversation });
  expect(first.id).not.toBe(second.id);
  const row = await enqueueInput(args());
  await claimBrowserInput(row.id, 'exact-opening-owner', null, true);
  await authorizeBrowserInput(row.id, 'exact-opening-owner', null);
  expect(await bindBrowserInputProject(row.id, 'exact-opening-owner', conversation)).toBe(false);
  expect(await acknowledgeBrowserInput(row.id, 'exact-opening-owner', conversation, 'foreign-message')).toBe(false);
  expect((await getSession(row.sessionId!))?.conversationId).toBeNull();
  expect((await listInputs()).find(entry => entry.id === row.id)?.deliveredAt).toBeUndefined();
});
