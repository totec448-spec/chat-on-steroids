import { beforeEach, afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { bindBrowserInputProject, claimBrowserInput, enqueueInput, listInputs, resetInputForTests } from '../src/main/session/input.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import { createSession, getSession, initSessionStore, rebindSession, resetSessionStoreForTests, setSessionOrigin } from '../src/main/session/store.js';
import { addProject, addProjectFolder, assignSessionProject, getSessionProject, inheritSessionProject, listProjects, projectWorkspace, removeProject, removeProjectFolder, setProjectColor } from '../src/main/projects.js';
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

it('loads legacy single-folder records as primary-only projects without requiring migration', async () => {
  const legacy = { id: randomUUID(), name: 'Legacy', path: path.join(approved, 'first'), createdAt: 1 };
  await writeDurableNow('projects', [legacy]);
  expect(await listProjects()).toEqual([legacy]);
  expect(await projectWorkspace(legacy.id)).toMatchObject({ real: legacy.path, virtual: '/work/first' });
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

it('drops duplicate additional folder identities on read while primary ownership stays authoritative', async () => {
  const first = { id: randomUUID(), name: 'First', path: path.join(approved, 'first'), createdAt: 1 };
  const related = path.join(approved, 'related');
  const duplicateAlias = process.platform === 'win32' ? related.toUpperCase() : related;
  const second = {
    id: randomUUID(), name: 'Second', path: path.join(approved, 'second'),
    additionalPaths: [first.path, related, duplicateAlias, related], createdAt: 2
  };
  await writeDurableNow('projects', [first, second]);
  expect(await listProjects()).toEqual([first, { ...second, additionalPaths: [related] }]);
});

it('still rejects duplicate primary ownership and duplicate project ids in a persisted catalog', async () => {
  const id = randomUUID();
  const first = { id, name: 'First', path: path.join(approved, 'first'), createdAt: 1 };
  const duplicatePrimary = { id: randomUUID(), name: 'Second', path: first.path, createdAt: 2 };
  await writeDurableNow('projects', [first, duplicatePrimary]);
  await expect(listProjects()).rejects.toThrow(/catalog is invalid/);
  await writeDurableNow('projects', [first, { ...duplicatePrimary, id, path: path.join(approved, 'second') }]);
  await expect(listProjects()).rejects.toThrow(/catalog is invalid/);
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

it('keeps primary cwd authoritative when an additional folder loses permission', async () => {
  const relatedRoot = path.join(directory, 'related-approved');
  const related = path.join(relatedRoot, 'shared');
  await fs.mkdir(related, { recursive: true });
  const canonicalRelatedRoot = await validateNewRoot(relatedRoot, [{ name: 'work', path: approved }]);
  const canonicalRelated = path.join(canonicalRelatedRoot, 'shared');
  const primary = path.join(approved, 'first');
  const project = await addProject(primary);
  const session = await createSession({ title: 'Multi-folder project' });
  await assignSessionProject(session.id, project.id);
  await expect(addProjectFolder(project.id, related)).rejects.toThrow();
  await saveConfig({
    ...defaultConfig(),
    roots: [{ name: 'work', path: approved }, { name: 'related', path: canonicalRelatedRoot }]
  });

  const updated = await addProjectFolder(project.id, related);
  expect(updated).toMatchObject({ id: project.id, path: primary, additionalPaths: [canonicalRelated] });
  expect((await addProjectFolder(project.id, related)).additionalPaths).toEqual([canonicalRelated]);
  expect(await projectWorkspace(project.id)).toMatchObject({ real: primary, virtual: '/work/first' });
  expect(await projectWorkspace(project.id, related)).toMatchObject({ real: canonicalRelated, virtual: '/related/shared' });
  await expect(projectWorkspace(project.id, path.join(approved, 'second'))).rejects.toThrow(/does not belong/);
  expect(await getSessionProject(session.id)).toMatchObject({ real: primary, virtual: '/work/first' });

  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: approved }] });
  expect(await projectWorkspace(project.id)).toMatchObject({ real: primary, virtual: '/work/first' });
  await expect(projectWorkspace(project.id, related)).rejects.toThrow();
  const removed = await removeProjectFolder(project.id, canonicalRelated);
  expect(removed.additionalPaths).toBeUndefined();
  expect(await projectWorkspace(project.id)).toMatchObject({ real: primary, virtual: '/work/first' });
});

it('deduplicates canonical additional-folder aliases and detaches an unavailable folder', async () => {
  const primary = path.join(approved, 'first');
  const related = path.join(approved, 'related');
  const alias = path.join(approved, 'related-alias');
  await fs.mkdir(related);
  await fs.symlink(related, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const project = await addProject(primary);
  const other = await addProject(path.join(approved, 'second'));
  expect((await addProjectFolder(project.id, related)).additionalPaths).toEqual([related]);
  expect((await addProjectFolder(project.id, alias)).additionalPaths).toEqual([related]);
  await expect(addProject(related)).rejects.toThrow(/already belongs/);
  await expect(addProjectFolder(other.id, alias)).rejects.toThrow(/already belongs/);
  await expect(addProjectFolder(project.id, other.path)).rejects.toThrow(/already belongs/);
  if (process.platform === 'win32') {
    expect((await addProjectFolder(project.id, related.toUpperCase())).additionalPaths).toEqual([related]);
  }
  await fs.rename(related, path.join(approved, 'related-moved'));
  expect(await projectWorkspace(project.id)).toMatchObject({ real: primary, virtual: '/work/first' });
  await expect(projectWorkspace(project.id, related)).rejects.toThrow();
  await expect(removeProjectFolder(project.id, primary)).rejects.toThrow(/primary/);
  expect((await removeProjectFolder(project.id, related)).additionalPaths).toBeUndefined();
});
