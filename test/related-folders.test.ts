import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { defaultConfig, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import { clearProjectNote, createSession, getSession, initSessionStore, rebindSession, resetSessionStoreForTests, setSessionOrigin } from '../src/main/session/store.js';
import { addProject, assignSessionProject, listProjects, relatedFolderContext, relatedFolderViews, setRelatedFolders } from '../src/main/projects.js';
import { fitSessionPrompt, prepareSessionPrompt, prepareSkillFollowup, relatedFoldersLine } from '../src/main/session/prompt.js';
import { validateNewRoot } from '../src/main/sandbox.js';

let directory: string, work: string, api: string, lib: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-related-'));
  for (const name of ['work/app', 'api', 'lib']) await fs.mkdir(path.join(directory, name), { recursive: true });
  work = await validateNewRoot(path.join(directory, 'work'), []);
  api = await validateNewRoot(path.join(directory, 'api'), []);
  lib = await validateNewRoot(path.join(directory, 'lib'), []);
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: work }, { name: 'api', path: api }, { name: 'lib', path: lib }] });
});
afterEach(async () => { resetSessionStoreForTests(); resetDurableForTests(); await fs.rm(directory, { recursive: true, force: true }); });

it('keeps only approved folders, each once and never the project\'s own, and tells ChatGPT their approved names (#1689)', async () => {
  const project = await addProject(path.join(work, 'app'));
  const workProject = await addProject(work);
  // The same folder twice, and once more written differently, is one related folder.
  const saved = await setRelatedFolders(project.id, [api, lib, api, path.join(api, '.')]);
  expect(saved.relatedFolders).toEqual([api, lib]);
  expect(await relatedFolderContext(project.id)).toEqual(['/api', '/lib']);
  // A project whose folder is an approved folder never lists itself.
  expect((await setRelatedFolders(workProject.id, [work, api])).relatedFolders).toEqual([api]);
  // Never a folder that is not approved: naming one here grants nothing.
  await expect(setRelatedFolders(project.id, [api, directory])).rejects.toThrow('Choose a related folder from your approved folders');
  expect((await listProjects()).find(row => row.id === project.id)?.relatedFolders).toEqual([api, lib]);
  // An empty list leaves no field behind.
  expect((await setRelatedFolders(project.id, [])).relatedFolders).toBeUndefined();
  expect(await relatedFolderContext(project.id)).toEqual([]);
  expect(await relatedFolderContext(null)).toEqual([]);
});

it('shows a folder whose approval was removed, or that is gone, as unavailable and leaves it out of what ChatGPT is told', async () => {
  const project = await addProject(path.join(work, 'app'));
  const saved = await setRelatedFolders(project.id, [api, lib]);
  await saveConfig({ ...getConfig(), roots: getConfig().roots.filter(root => root.name !== 'api') });
  await fs.rm(lib, { recursive: true });
  expect(await relatedFolderViews(saved)).toEqual([
    { path: api, name: null, virtual: null, available: false },
    { path: lib, name: 'lib', virtual: null, available: false }
  ]);
  expect(await relatedFolderContext(project.id)).toEqual([]);
  // The project itself is untouched: its own folder and chats work as before.
  expect((await listProjects()).find(row => row.id === project.id)?.path).toBe(project.path);
});

it('lets the person remove one of two unavailable folders, keeping the other, but never add an unapproved one (CodeRabbit on #2053)', async () => {
  const project = await addProject(path.join(work, 'app'));
  await setRelatedFolders(project.id, [api, lib]);
  await saveConfig({ ...getConfig(), roots: getConfig().roots.filter(root => root.name === 'work') });
  // Both lost their approval; removing one sends the other back as it was saved.
  expect((await setRelatedFolders(project.id, [lib])).relatedFolders).toEqual([lib]);
  // Still never a folder that was not already there.
  await expect(setRelatedFolders(project.id, [lib, api])).rejects.toThrow('Choose a related folder from your approved folders');
  expect((await setRelatedFolders(project.id, [])).relatedFolders).toBeUndefined();
});

it('opens a project chat with its related folders, and a sub-agent of it without them, worktree or not (CodeRabbit on #2053)', async () => {
  const project = await addProject(path.join(work, 'app'));
  await setRelatedFolders(project.id, [api]);
  const chat = await createSession({ title: 'Chat', conversationId: 'opening-conversation' });
  await assignSessionProject(chat.id, project.id);
  expect(await prepareSessionPrompt('Task', { sessionId: chat.id })).toContain('Related folders (other approved folders this work also uses): /api.');
  const worker = await prepareSessionPrompt('Task', { sessionId: chat.id, subAgent: true });
  expect(worker).toContain('Selected project directory: /work/app');
  expect(worker).not.toContain('Related folders');
});

it('reads a damaged related-folder list as none instead of failing the project catalog', async () => {
  const project = await addProject(path.join(work, 'app'));
  await writeDurableNow('projects', [{ ...project, relatedFolders: 'not a list' }]);
  expect(await listProjects()).toEqual([project]);
});

it('tells open project chats the new list with the person\'s next message, once, and not sub-agents or other projects\' chats', async () => {
  const project = await addProject(path.join(work, 'app'));
  const other = await addProject(work);
  const open = await createSession({ title: 'Open', conversationId: 'open-conversation' });
  const worker = await createSession({ title: 'Worker', conversationId: 'worker-conversation' });
  const elsewhere = await createSession({ title: 'Elsewhere', conversationId: 'elsewhere-conversation' });
  const fresh = await createSession({ title: 'Not sent yet' });
  for (const session of [open, worker, fresh]) await assignSessionProject(session.id, project.id);
  await assignSessionProject(elsewhere.id, other.id);
  await setSessionOrigin(worker.id, { kind: 'worker', fromSessionId: open.id, agentId: 'worker-1', task: 'Check' }, 'Worker');
  expect((await getSession(worker.id))?.origin?.kind).toBe('worker');
  await setRelatedFolders(project.id, [api]);
  expect((await getSession(open.id))?.projectNotePending).toBe(true);
  expect((await getSession(worker.id))?.projectNotePending).toBeUndefined();
  expect((await getSession(elsewhere.id))?.projectNotePending).toBeUndefined();
  // A chat that has not started gets the list with its opening message anyway.
  expect((await getSession(fresh.id))?.projectNotePending).toBeUndefined();
  // Setting the same list again tells nobody anything new.
  await clearProjectNote(open.id);
  await setRelatedFolders(project.id, [api]);
  expect((await getSession(open.id))?.projectNotePending).toBeUndefined();
});

it('carries the project folder and its related folders as they are now in the note, never a removed one', async () => {
  const project = await addProject(path.join(work, 'app'));
  const chat = await createSession({ title: 'Chat', conversationId: 'chat-conversation' });
  await assignSessionProject(chat.id, project.id);
  await setRelatedFolders(project.id, [api, lib]);
  await saveConfig({ ...getConfig(), roots: getConfig().roots.filter(root => root.name !== 'lib') });
  const text = await prepareSkillFollowup('Fix the login form', 'Fix the login form', undefined, { sessionId: chat.id }, true);
  expect(text).toContain('Selected project directory: /work/app');
  expect(text).toContain('Related folders (other approved folders this work also uses): /api. Your working directory stays the project directory');
  expect(text).not.toContain('/lib');
  expect(text).not.toContain(api);
  // Without a note the message goes as written.
  expect(await prepareSkillFollowup('Next step', 'Next step', undefined, { sessionId: chat.id }, false)).toBe('Next step');
  // The last one removed: the note says none apply now, as earlier messages still name one (CodeRabbit on #2053).
  await setRelatedFolders(project.id, []);
  const none = await prepareSkillFollowup('Go on', 'Go on', undefined, { sessionId: chat.id }, true);
  expect(none).toContain('Related folders: none. A related folder named earlier in this chat no longer applies.');
  // A new chat's opening without related folders says nothing about them.
  expect(fitSessionPrompt('Task', 'CORE', { directory: '/work/app', text: '', truncated: false, related: [] })).not.toContain('Related folders');
});

it('puts the related folders right after the project directory, and nothing for a project without them', () => {
  const agents = { directory: '/work/app', text: 'Use pnpm.', truncated: false, related: ['/api', '/lib'] };
  const text = fitSessionPrompt('Task', 'CORE', agents);
  expect(text).toMatch(/Selected project directory: \/work\/app\n.*grants no additional filesystem permissions\.\nRelated folders \(other approved folders this work also uses\): \/api, \/lib\. Your working directory stays the project directory; read a related folder's own AGENTS\.md before you change files there\./);
  // Only the project's AGENTS.md is included.
  expect(text.match(/AGENTS\.md instructions for/g)).toHaveLength(1);
  expect(fitSessionPrompt('Task', 'CORE', { ...agents, related: [] })).not.toContain('Related folders');
  expect(relatedFoldersLine([])).toBe('');
  // A worker in its own worktree keeps only its worktree line.
  expect(fitSessionPrompt('Task', 'CORE', { ...agents, related: undefined }, undefined, [], '/work/.worktrees/w1')).not.toContain('Related folders');
});

it('after Compact & Resume, the person\'s next message tells the new chat its project folder again', async () => {
  const project = await addProject(path.join(work, 'app'));
  const chat = await createSession({ title: 'Chat', conversationId: 'a-conversation' });
  const loose = await createSession({ title: 'Loose', conversationId: 'loose-a' });
  await assignSessionProject(chat.id, project.id);
  await clearProjectNote(chat.id);
  expect(await rebindSession(chat.id, 'a-conversation', 'b-conversation', 'handoff-0001')).toBe(true);
  expect((await getSession(chat.id))?.projectNotePending).toBe(true);
  // A move that is not a resume, and a chat without a project, carry no note.
  await clearProjectNote(chat.id);
  expect(await rebindSession(chat.id, 'b-conversation', 'c-conversation')).toBe(true);
  expect((await getSession(chat.id))?.projectNotePending).toBeUndefined();
  expect(await rebindSession(loose.id, 'loose-a', 'loose-b', 'handoff-0002')).toBe(true);
  expect((await getSession(loose.id))?.projectNotePending).toBeUndefined();
});
