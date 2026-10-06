import { beforeEach, afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { bindBrowserInputProject, claimBrowserInput, enqueueInput, listInputs, resetInputForTests } from '../src/main/session/input.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import { createSession, getSession, initSessionStore, rebindSession, resetSessionStoreForTests, setSessionOrigin } from '../src/main/session/store.js';
import { addProject, assignSessionProject, getSessionProject, inheritSessionProject, linkChatGptProject, listProjects, projectWorkspace, removeProject, setProjectColor, unlinkChatGptProject, verifyChatGptProjectLink } from '../src/main/projects.js';
import { syncChatGptProjectLink } from '../src/main/project-sync.js';
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

it('links one stable ChatGPT Project identity without changing local workspace authority', async () => {
  const local = await addProject(path.join(approved, 'first'));
  const other = await addProject(path.join(approved, 'second'));
  const session = await createSession({ title: 'Project chat', conversationId: 'project-chat-current' });
  await assignSessionProject(session.id, local.id);
  const remote = 'g-p-11111111222233334444555555555555';
  const replacement = 'g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  const linked = await linkChatGptProject(local.id, remote.toUpperCase(), 1000);
  expect(linked).toEqual({
    ...local,
    remote: { provider: 'chatgpt', projectId: remote, linkedAt: 1000, lastObservedAt: 1000 }
  });
  expect(await projectWorkspace(local.id)).toMatchObject({ real: local.path, virtual: '/work/first' });
  expect((await getSession(session.id))?.projectId).toBe(local.id);

  const older = await linkChatGptProject(local.id, remote, 900);
  expect(older.remote).toEqual(linked.remote);
  await expect(linkChatGptProject(other.id, remote, 1100)).rejects.toThrow(/already linked/i);
  await expect(linkChatGptProject(local.id, replacement, 1100)).rejects.toThrow(/another ChatGPT Project/i);
  await expect(linkChatGptProject(local.id, 'g-p-not-a-project', 1100)).rejects.toThrow(/ChatGPT Project id/i);

  const verified = await verifyChatGptProjectLink(local.id, remote, 1200);
  expect(verified.remote).toEqual({ provider: 'chatgpt', projectId: remote, linkedAt: 1000, lastObservedAt: 1200 });
  await expect(verifyChatGptProjectLink(local.id, replacement, 1300)).rejects.toThrow(/does not match/i);

  const unlinked = await unlinkChatGptProject(local.id);
  expect(unlinked).toEqual(local);
  expect(await projectWorkspace(local.id)).toMatchObject({ real: local.path, virtual: '/work/first' });
  expect((await getSession(session.id))?.projectId).toBe(local.id);
});

it('refuses a durable catalog that maps one ChatGPT Project identity to two local projects', async () => {
  const one = await addProject(path.join(approved, 'first'));
  const two = await addProject(path.join(approved, 'second'));
  const remote = {
    provider: 'chatgpt' as const,
    projectId: 'g-p-11111111222233334444555555555555',
    linkedAt: 1000,
    lastObservedAt: 1000
  };
  await writeDurableNow('projects', [{ ...one, remote }, { ...two, remote }]);
  resetDurableForTests(); initDurableStore(directory);
  await expect(listProjects()).rejects.toThrow('Project catalog is invalid');
});

it('links only from the selected exact session already owned by the local project and rechecks after browser observation', async () => {
  const local = await addProject(path.join(approved, 'first'));
  const other = await addProject(path.join(approved, 'second'));
  const session = await createSession({ title: 'Exact source', conversationId: 'project-source-chat' });
  await assignSessionProject(session.id, local.id);
  const remote = 'g-p-11111111222233334444555555555555';

  expect(await syncChatGptProjectLink(local.id, session.id, 'link', async conversationId => ({
    ok: true, projectId: remote, observedAt: 1000, conversationId
  }))).toMatchObject({ remote: { projectId: remote } });
  await expect(syncChatGptProjectLink(other.id, session.id, 'link', async () => ({
    ok: true, projectId: remote, observedAt: 1100
  }))).rejects.toThrow(/already belongs to another local project/i);

  await expect(syncChatGptProjectLink(local.id, session.id, 'verify', async () => {
    expect(await rebindSession(session.id, 'project-source-chat', 'project-source-replacement')).toBe(true);
    return { ok: true, projectId: remote, observedAt: 1200 };
  })).rejects.toThrow(/changed while ChatGPT Project was being observed/i);
});

it('rejects a stale Project observation when the same session leaves A and returns to A', async () => {
  const local = await addProject(path.join(approved, 'first'));
  const session = await createSession({ title: 'ABA source', conversationId: 'project-aba-source' });
  await assignSessionProject(session.id, local.id);
  const remote = 'g-p-11111111222233334444555555555555';

  await expect(syncChatGptProjectLink(local.id, session.id, 'link', async () => {
    expect(await rebindSession(session.id, 'project-aba-source', 'project-aba-middle')).toBe(true);
    expect(await rebindSession(session.id, 'project-aba-middle', 'project-aba-source')).toBe(true);
    return { ok: true, projectId: remote, observedAt: 1000 };
  })).rejects.toThrow(/changed while ChatGPT Project was being observed/i);

  expect((await getSession(session.id))?.conversationId).toBe('project-aba-source');
  expect((await listProjects()).find(project => project.id === local.id)?.remote).toBeUndefined();
});

it('holds the session mutation fence through Project observation publication', async () => {
  const local = await addProject(path.join(approved, 'first'));
  const session = await createSession({ title: 'Publication source', conversationId: 'project-publish-source' });
  await assignSessionProject(session.id, local.id);
  const remote = 'g-p-11111111222233334444555555555555';
  let entered!: () => void, release!: () => void;
  const publicationEntered = new Promise<void>(resolve => { entered = resolve; });
  const publicationRelease = new Promise<void>(resolve => { release = resolve; });

  const syncing = syncChatGptProjectLink(
    local.id,
    session.id,
    'link',
    async () => ({ ok: true, projectId: remote, observedAt: 1000 }),
    async (action, projectId, remoteProjectId, observedAt) => {
      expect(action).toBe('link');
      entered();
      await publicationRelease;
      return linkChatGptProject(projectId, remoteProjectId, observedAt);
    }
  );
  await publicationEntered;

  let moved = false;
  const moving = rebindSession(session.id, 'project-publish-source', 'project-publish-replacement')
    .then(result => { moved = result; return result; });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(moved).toBe(false);

  release();
  await expect(syncing).resolves.toMatchObject({ remote: { projectId: remote } });
  await expect(moving).resolves.toBe(true);
  expect((await getSession(session.id))?.conversationId).toBe('project-publish-replacement');
});

it('keeps a remote link with an ungrouped project until that exact project is restored and unlinked', async () => {
  const local = await addProject(path.join(approved, 'first'));
  const other = await addProject(path.join(approved, 'second'));
  const remote = 'g-p-11111111222233334444555555555555';
  await linkChatGptProject(local.id, remote, 1000);

  await removeProject(local.id);
  expect(await listProjects()).toContainEqual(expect.objectContaining({
    id: local.id, ungrouped: true, remote: expect.objectContaining({ projectId: remote })
  }));
  await expect(linkChatGptProject(other.id, remote, 1100)).rejects.toThrow(/already linked/i);

  const restored = await addProject(local.path);
  expect(restored).toMatchObject({ id: local.id, remote: { projectId: remote } });
  await unlinkChatGptProject(local.id);
  await expect(linkChatGptProject(other.id, remote, 1200)).resolves.toMatchObject({
    id: other.id, remote: { projectId: remote }
  });
});

it('refuses a late Project observation after the local Project was removed from the sidebar', async () => {
  const local = await addProject(path.join(approved, 'first'));
  const session = await createSession({ title: 'Removed while observing', conversationId: 'project-removal-race' });
  await assignSessionProject(session.id, local.id);
  const remote = 'g-p-11111111222233334444555555555555';

  await expect(syncChatGptProjectLink(local.id, session.id, 'link', async () => {
    await removeProject(local.id);
    return { ok: true, projectId: remote, observedAt: 1000 };
  })).rejects.toThrow(/no longer on the sidebar/i);
  expect((await listProjects()).find(row => row.id === local.id)?.remote).toBeUndefined();
});
