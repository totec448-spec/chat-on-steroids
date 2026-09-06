import { beforeEach, afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { bindBrowserInputProject, claimBrowserInput, enqueueInput, listInputs, resetInputForTests } from '../src/main/session/input.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { createSession, getSession, initSessionStore, rebindSession, resetSessionStoreForTests, setSessionOrigin } from '../src/main/session/store.js';
import { addProject, assignSessionProject, getSessionProject, inheritSessionProject, listProjects } from '../src/main/projects.js';
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

it('binds a claimed fresh input before evidence without acknowledging delivery or accepting another document', async () => {
  const project = await addProject(path.join(approved, 'first'));
  const entry = await enqueueInput({ id: randomUUID(), projectId: project.id, sessionId: null, text: 'Work here', dueAt: 0, mode: 'auto', model: null, reasoningEffort: null });
  expect(await bindBrowserInputProject(entry.id, 'document', 'conversation-one')).toBe(false);
  expect(await claimBrowserInput(entry.id, 'document', null)).toMatchObject({ projectId: project.id });
  expect(await bindBrowserInputProject(entry.id, 'wrong-document', 'conversation-one')).toBe(false);
  expect(await bindBrowserInputProject(entry.id, 'document', 'conversation-one')).toBe(true);
  const bound = (await listInputs()).find(row => row.id === entry.id)!;
  expect(bound.state).toBe('browser');
  expect((await getSession(bound.deliveredSessionId!))?.projectId).toBe(project.id);
  resetInputForTests();
  expect(await bindBrowserInputProject(entry.id, 'document', 'conversation-one')).toBe(true);
  expect(await bindBrowserInputProject(entry.id, 'document', 'conversation-two')).toBe(false);
  expect(await rebindSession(bound.deliveredSessionId!, 'conversation-one', 'conversation-replacement')).toBe(true);
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
