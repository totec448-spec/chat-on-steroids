import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { bindBrowserInputProject, claimBrowserInput, enqueueInput, listInputs, pendingBrowserInputs, resetInputForTests } from '../src/main/session/input.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { createSession, getSession, initSessionStore, rebindSession, resetSessionStoreForTests, setSessionOrigin } from '../src/main/session/store.js';
import { addProject, armProjectCreate, assignSessionProject, claimProjectCreate, completeProjectCreate, failProjectCreate, getProject, getSessionProject, inheritSessionProject, listProjects, markProjectGone, pendingProjectCreates, PROJECT_CREATE_ARMED_MS, PROJECT_CREATE_CLAIM_MS, projectWorkspace, removeProject, retryProjectCreate, setProjectColor } from '../src/main/projects.js';
import { validateNewRoot } from '../src/main/sandbox.js';

let directory: string, approved: string;
beforeEach(async () => {
  resetInputForTests();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-projects-'));
  approved = path.join(directory, 'approved');
  await fs.mkdir(path.join(approved, 'first'), { recursive: true });
  await fs.mkdir(path.join(approved, 'second'));
  // Match IPC root approval: macOS temp paths can use /var while their canonical
  // authority is /private/var. Stored root identity must already be canonical.
  approved = await validateNewRoot(approved, []);
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: approved }] });
});
afterEach(async () => { resetSessionStoreForTests(); resetDurableForTests(); await fs.rm(directory, { recursive: true, force: true }); });

it('persists one project per canonical directory and validates approved directories', async () => {
  const [one, again] = await Promise.all([addProject(path.join(approved, 'first')), addProject(path.join(approved, 'first'))]);
  expect(again.id).toBe(one.id);
  expect(await listProjects()).toEqual([one]);
  await fs.writeFile(path.join(approved, 'file.txt'), 'x');
  await expect(addProject(path.join(approved, 'file.txt'))).rejects.toThrow(/folder/);
  await expect(addProject(directory)).rejects.toThrow();
  await expect(addProject('first')).rejects.toThrow(/absolute/);
  resetDurableForTests(); initDurableStore(directory);
  expect(await listProjects()).toEqual([one]);
});

it('persists only predefined presentation colors without changing project workspace authority', async () => {
  const project = await addProject(path.join(approved, 'first'));
  const colored = await setProjectColor(project.id, 'purple');
  expect(colored).toEqual({ ...project, color: 'purple' });
  expect(await projectWorkspace(project.id)).toMatchObject({ real: project.path, virtual: '/work/first' });
  resetDurableForTests(); initDurableStore(directory);
  expect(await listProjects()).toEqual([colored]);
  await expect(setProjectColor(project.id, 'chartreuse' as any)).rejects.toThrow();
  expect(await setProjectColor(project.id, null)).toEqual(project);
});

it('resolves a native picker alias to the approved identity without granting outside aliases', async () => {
  const alias = path.join(directory, 'picker-alias');
  await fs.symlink(approved, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const project = await addProject(path.join(alias, 'first'));
  expect(project.path).toBe(path.join(approved, 'first'));
  expect((await addProject(path.join(approved, 'first'))).id).toBe(project.id);
  const outside = path.join(directory, 'outside');
  await fs.mkdir(outside);
  const outsideAlias = path.join(approved, 'outside-alias');
  await fs.symlink(outside, outsideAlias, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(addProject(outsideAlias)).rejects.toThrow(/escapes|not inside/);
});

it('removes a grouping durably while preserving files, conversations and pending browser claims', async () => {
  const project = await addProject(path.join(approved, 'first'));
  const other = await addProject(path.join(approved, 'second'));
  const session = await createSession({ title: 'Keep this chat', conversationId: 'retained-conversation' });
  await assignSessionProject(session.id, project.id);
  const file = path.join(project.path, 'keep.txt');
  await fs.writeFile(file, 'keep');
  const input = await enqueueInput({ id: randomUUID(), projectId: project.id, sessionId: null, text: 'Queued work', dueAt: 0, mode: 'auto', model: null, reasoningEffort: null });
  await Promise.all([removeProject(project.id), removeProject(project.id)]);
  resetDurableForTests(); initDurableStore(directory); resetInputForTests(); resetSessionStoreForTests();
  expect(await listProjects()).toEqual([{ ...project, ungrouped: true }, other]);
  expect((await getSession(session.id))?.title).toBe('Keep this chat');
  expect(await getSessionProject(session.id)).toMatchObject({ virtual: '/work/first' });
  expect(await fs.readFile(file, 'utf8')).toBe('keep');
  expect(await claimBrowserInput(input.id, 'document', null)).toMatchObject({ id: input.id });
  expect(await bindBrowserInputProject(input.id, 'document', 'queued-conversation')).toBe(true);
  await expect(removeProject(randomUUID())).rejects.toThrow('Project not found');
  expect(await addProject(project.path)).toEqual(project);
  expect(await listProjects()).toEqual([project, other]);
});

it('binds a claimed fresh input before evidence without acknowledging delivery or accepting another document', async () => {
  const project = await addProject(path.join(approved, 'first'));
  const entry = await enqueueInput({ id: randomUUID(), projectId: project.id, sessionId: null, text: 'Work here', dueAt: 0, mode: 'auto', model: null, reasoningEffort: null });
  expect(await bindBrowserInputProject(entry.id, 'document', 'conversation-one')).toBe(false);
  expect(await claimBrowserInput(entry.id, 'document', null)).toMatchObject({ projectId: project.id });
  expect(await bindBrowserInputProject(entry.id, 'wrong-document', 'conversation-one')).toBe(false);
  expect(await bindBrowserInputProject(entry.id, 'document', 'conversation-one')).toBe(true);
  const bound = (await listInputs()).find(row => row.id === entry.id)!;
  expect(bound.state).toBe('browser');
  expect(bound.deliveredSessionId).toBeUndefined();
  expect((await getSession(bound.sessionId!))?.projectId).toBe(project.id);
  resetInputForTests();
  expect(await bindBrowserInputProject(entry.id, 'document', 'conversation-one')).toBe(true);
  expect(await bindBrowserInputProject(entry.id, 'document', 'conversation-two')).toBe(false);
  expect(await rebindSession(bound.sessionId!, 'conversation-one', 'conversation-replacement')).toBe(true);
  expect(await bindBrowserInputProject(entry.id, 'document', 'conversation-one')).toBe(false);
});

it('retains project ownership through restart, resume and exact worker origins', async () => {
  const project = await addProject(path.join(approved, 'first'));
  const otherProject = await addProject(path.join(approved, 'second'));
  const prime = await createSession({ title: 'Prime', conversationId: 'prime-original' });
  await assignSessionProject(prime.id, project.id);
  await expect(assignSessionProject(prime.id, otherProject.id)).rejects.toThrow(/another project/);
  const origin = { kind: 'worker' as const, fromSessionId: prime.id, agentId: 'worker-1', task: 'Inspect' };
  const worker = await createSession({ title: 'Worker', origin, conversationId: 'worker-original' });
  expect(worker.projectId).toBe(project.id);
  const late = await createSession({ title: 'Late origin' });
  await setSessionOrigin(late.id, origin, 'Worker');
  expect((await getSession(late.id))?.projectId).toBe(project.id);
  const exact = await createSession({ title: 'Exact inheritance' });
  await inheritSessionProject(exact.id, 'prime-original');
  expect((await getSession(exact.id))?.projectId).toBe(project.id);
  await rebindSession(prime.id, 'prime-original', 'prime-replacement');
  resetSessionStoreForTests();
  expect((await getSession(prime.id))?.projectId).toBe(project.id);
  expect(await getSessionProject(prime.id)).toMatchObject({ virtual: '/work/first' });
  const stale = await createSession({ title: 'Stale source' });
  await inheritSessionProject(stale.id, 'prime-original');
  expect((await getSession(stale.id))?.projectId).toBeUndefined();
});

it('fails closed when explicit project permission is removed and follows approved root renames', async () => {
  const project = await addProject(path.join(approved, 'first'));
  const session = await createSession({ title: 'Bound' });
  await assignSessionProject(session.id, project.id);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'renamed', path: approved }] });
  expect(await getSessionProject(session.id)).toMatchObject({ virtual: '/renamed/first' });
  await saveConfig({ ...defaultConfig(), roots: [] });
  await expect(getSessionProject(session.id)).rejects.toThrow();
  expect((await getSession(session.id))?.projectId).toBe(project.id);
});

// #1176: a new CoS project's native ChatGPT Project, from request to verified identity.
const nativeId = `g-p-${'a'.repeat(32)}`;
it('requests a native ChatGPT Project only for a project created here, not for an existing or restored one', async () => {
  const project = await addProject(path.join(approved, 'first'));
  expect(project.chatgpt).toMatchObject({ state: 'requested' });
  expect(await pendingProjectCreates()).toEqual([{ id: (project.chatgpt as { requestId: string }).requestId, projectId: project.id, name: 'first', state: 'requested' }]);
  // An older catalog row has none, and restoring an ungrouped one does not invent one.
  const { chatgpt: _, ...legacy } = project;
  await removeProject(project.id);
  const raw = (await listProjects()).map(row => ({ ...legacy, ungrouped: row.ungrouped }));
  await (await import('../src/main/durable.js')).writeDurableNow('projects', raw);
  expect((await addProject(path.join(approved, 'first'))).chatgpt).toBeUndefined();
});

it('links only the id the creating page reports after arming, and only from that page', async () => {
  const project = await addProject(path.join(approved, 'first'));
  const id = (project.chatgpt as { requestId: string }).requestId;
  expect(await armProjectCreate(id, 'page-a')).toBe(false); // nothing claimed yet
  expect(await claimProjectCreate(id, 'page-a')).toBe(true);
  expect(await claimProjectCreate(id, 'page-b')).toBe(false);
  expect(await completeProjectCreate(id, 'page-a', nativeId)).toBe(false); // not armed
  expect(await armProjectCreate(id, 'page-a')).toBe(true);
  expect(await completeProjectCreate(id, 'page-b', nativeId)).toBe(false);
  expect(await completeProjectCreate(id, 'page-a', 'g-p-not-an-id')).toBe(false);
  expect(await completeProjectCreate(id, 'page-a', nativeId)).toBe(true);
  expect((await getProject(project.id))?.chatgpt).toMatchObject({ state: 'linked', id: nativeId });
  expect(await pendingProjectCreates()).toEqual([]);
});

it('fails plainly before the click, but leaves an armed creation uncertain and never retries it on its own', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const first = await addProject(path.join(approved, 'first'));
    const second = await addProject(path.join(approved, 'second'));
    const a = (first.chatgpt as { requestId: string }).requestId, b = (second.chatgpt as { requestId: string }).requestId;
    await claimProjectCreate(a, 'page-a');
    expect(await failProjectCreate(a, 'page-a', 'no dialog')).toBe(true);
    expect((await getProject(first.id))?.chatgpt).toMatchObject({ state: 'failed', error: 'no dialog' });
    await claimProjectCreate(b, 'page-b'); await armProjectCreate(b, 'page-b');
    vi.setSystemTime(Date.now() + PROJECT_CREATE_ARMED_MS);
    expect((await pendingProjectCreates()).map(row => row.projectId)).toEqual([]);
    expect((await getProject(second.id))?.chatgpt).toMatchObject({ state: 'uncertain' });
    // Only the person asks again, with a fresh request.
    const retried = await retryProjectCreate(second.id);
    expect(retried?.chatgpt).toMatchObject({ state: 'requested' });
    expect((retried?.chatgpt as { requestId: string }).requestId).not.toBe(b);
  } finally { vi.useRealTimers(); }
});

it('offers a claim that lapsed before its click to another page', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const project = await addProject(path.join(approved, 'first'));
    const id = (project.chatgpt as { requestId: string }).requestId;
    await claimProjectCreate(id, 'page-a');
    expect((await pendingProjectCreates())[0]).toMatchObject({ state: 'claimed' });
    vi.setSystemTime(Date.now() + PROJECT_CREATE_CLAIM_MS);
    expect((await pendingProjectCreates())[0]).toMatchObject({ state: 'requested' });
    expect(await armProjectCreate(id, 'page-a')).toBe(false);
    expect(await claimProjectCreate(id, 'page-b')).toBe(true);
  } finally { vi.useRealTimers(); }
});

it("holds a new chat of a project until its native ChatGPT Project exists, then offers it only for that Project", async () => {
  const project = await addProject(path.join(approved, 'first'));
  const id = (project.chatgpt as { requestId: string }).requestId;
  const input = await enqueueInput({ id: randomUUID(), projectId: project.id, sessionId: null, text: 'Start here', dueAt: 0, mode: 'auto', model: null, reasoningEffort: null });
  // Never offered for the root while the Project is being created (or could not be).
  expect((await pendingBrowserInputs()).some(row => row.id === input.id)).toBe(false);
  await claimProjectCreate(id, 'page'); await armProjectCreate(id, 'page');
  expect((await pendingBrowserInputs()).some(row => row.id === input.id)).toBe(false);
  await completeProjectCreate(id, 'page', nativeId);
  expect((await pendingBrowserInputs()).find(row => row.id === input.id)).toMatchObject({ conversationId: null, project: nativeId });
  // A project without one is unchanged: its new chat is offered without a Project.
  const plain = await enqueueInput({ id: randomUUID(), projectId: null, sessionId: null, text: 'Plain', dueAt: 0, mode: 'auto', model: null, reasoningEffort: null });
  expect((await pendingBrowserInputs()).find(row => row.id === plain.id)).not.toHaveProperty('project');
});

it('turns only the exact linked Project ChatGPT no longer opens into a failure that offers Retry', async () => {
  const project = await addProject(path.join(approved, 'first'));
  const id = (project.chatgpt as { requestId: string }).requestId;
  await claimProjectCreate(id, 'page'); await armProjectCreate(id, 'page'); await completeProjectCreate(id, 'page', nativeId);
  expect(await markProjectGone(project.id, `g-p-${'b'.repeat(32)}`)).toBe(false);
  expect(await markProjectGone(project.id, nativeId)).toBe(true);
  expect((await getProject(project.id))?.chatgpt).toMatchObject({ state: 'failed', error: 'ChatGPT no longer opens this Project' });
  expect((await retryProjectCreate(project.id))?.chatgpt).toMatchObject({ state: 'requested' });
});

it("turns an armed creation uncertain on the app's own clock, with no browser asking", async () => {
  const project = await addProject(path.join(approved, 'first'));
  const id = (project.chatgpt as { requestId: string }).requestId;
  await claimProjectCreate(id, 'page');
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  try {
    await armProjectCreate(id, 'page');
    await vi.advanceTimersByTimeAsync(PROJECT_CREATE_ARMED_MS + 100);
  } finally { vi.useRealTimers(); }
  // The sweep's catalog write is real disk I/O.
  for (let i = 0; i < 40 && (await getProject(project.id))?.chatgpt?.state !== 'uncertain'; i++) await new Promise(resolve => setTimeout(resolve, 25));
  expect((await getProject(project.id))?.chatgpt).toMatchObject({ state: 'uncertain' });
});
