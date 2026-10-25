import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, readDurable, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import { initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { chatgptProjectChoices, noteChatgptProjects, CHATGPT_PROJECT_CATALOG } from '../src/main/chatgpt-project-catalog.js';
import { addProject, createChatgptProjectFor, getProject, linkChatgptProject, listProjects, removeProject, unlinkChatgptProject } from '../src/main/projects.js';
import { validateNewRoot } from '../src/main/sandbox.js';
import { getLog } from '../src/main/logger.js';

const id = (digit: string) => `g-p-${digit.repeat(32)}`;
let directory: string, approved: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-chatgpt-link-'));
  approved = path.join(directory, 'approved');
  await fs.mkdir(path.join(approved, 'first'), { recursive: true });
  await fs.mkdir(path.join(approved, 'second'));
  approved = await validateNewRoot(approved, []);
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: approved }] });
});
afterEach(async () => { resetSessionStoreForTests(); resetDurableForTests(); await fs.rm(directory, { recursive: true, force: true }); });

it('keeps the Projects ChatGPT lists, in its order, with clean names and nothing invalid', async () => {
  expect(await chatgptProjectChoices()).toEqual([]);
  expect(await noteChatgptProjects([
    { id: id('a'), name: '  Kunden\u0000projekt  ' }, { id: id('b'), name: '🚀 Launch' }, { id: 'g-p-nope', name: 'Bad' },
    { id: id('a'), name: 'Duplicate' }, { id: id('c'), name: 'x'.repeat(300) }, { id: id('d'), name: '' }
  ], 1_000)).toBe(true);
  const choices = await chatgptProjectChoices(1_000);
  expect(choices.map(choice => [choice.id, choice.name])).toEqual([[id('a'), 'Kundenprojekt'], [id('b'), '🚀 Launch'], [id('c'), 'x'.repeat(120)]]);
  expect(choices.every(choice => choice.linkedTo === null)).toBe(true);
  // The same list again changes nothing; a Project that scrolled out of a later, shorter list stays.
  expect(await noteChatgptProjects([{ id: id('a'), name: 'Kundenprojekt' }, { id: id('b'), name: '🚀 Launch' }, { id: id('c'), name: 'x'.repeat(120) }], 2_000)).toBe(false);
  expect(await noteChatgptProjects([{ id: id('b'), name: 'Launch (renamed)' }], 3_000)).toBe(true);
  expect((await chatgptProjectChoices(3_000)).map(choice => [choice.id, choice.name])).toEqual([[id('b'), 'Launch (renamed)'], [id('a'), 'Kundenprojekt'], [id('c'), 'x'.repeat(120)]]);
  // Not seen for 30 days: gone from the choices; a damaged store reads as empty.
  expect((await chatgptProjectChoices(3_000 + 31 * 24 * 3_600_000)).map(choice => choice.id)).toEqual([]);
  await writeDurableNow(CHATGPT_PROJECT_CATALOG, { projects: 'broken' });
  expect(await chatgptProjectChoices()).toEqual([]);
  expect(await noteChatgptProjects(Array.from({ length: 400 }, (_, index) => ({ id: `g-p-${index.toString(16).padStart(32, '0')}`, name: `P${index}` })))).toBe(true);
  expect((await readDurable<{ projects: unknown[] }>(CHATGPT_PROJECT_CATALOG))!.projects).toHaveLength(200);
});

it('offers only the Projects of the workspace the browser is in now', async () => {
  // A person with a Team and a Personal workspace: ChatGPT opens a Project only in its own one.
  expect(await noteChatgptProjects([{ id: id('a'), name: 'Team project' }], 1_000, 'team-account-0001')).toBe(true);
  expect(await noteChatgptProjects([{ id: id('b'), name: 'Personal project' }], 2_000, null)).toBe(true);
  expect((await chatgptProjectChoices(2_000)).map(choice => choice.name)).toEqual(['Personal project']);
  // The same list from the same workspace changes nothing; back in the Team workspace, its own list.
  expect(await noteChatgptProjects([{ id: id('b'), name: 'Personal project' }], 2_500, null)).toBe(false);
  expect(await noteChatgptProjects([{ id: id('a'), name: 'Team project' }], 3_000, 'team-account-0001')).toBe(true);
  expect((await chatgptProjectChoices(3_000)).map(choice => choice.name)).toEqual(['Team project']);
  // A Project of the other workspace cannot be linked while the browser is in this one.
  await noteChatgptProjects([{ id: id('b'), name: 'Personal project' }], Date.now() - 1_000, null);
  await noteChatgptProjects([{ id: id('a'), name: 'Team project' }], Date.now(), 'team-account-0001');
  const project = await addProject(path.join(approved, 'first'), { chatgpt: 'later' });
  await expect(linkChatgptProject(project.id, id('b'))).rejects.toThrow(/not one ChatGPT lists/);
  expect((await linkChatgptProject(project.id, id('a'))).chatgpt).toMatchObject({ state: 'linked', id: id('a') });
  // Only a hash of the account id is kept, never the id itself; an odd value counts as no workspace.
  expect(JSON.stringify(await readDurable(CHATGPT_PROJECT_CATALOG))).not.toContain('team-account-0001');
  expect(await noteChatgptProjects([{ id: id('c'), name: 'Odd' }], Date.now(), 'x'.repeat(500))).toBe(true);
  expect((await chatgptProjectChoices()).map(choice => choice.name)).toEqual(['Odd', 'Personal project']);
});

it('switches to a workspace whose sidebar lists no Projects, offering none of the previous workspace', async () => {
  // CodeRabbit on #1757: an empty report used to be dropped, so the previous workspace stayed current.
  expect(await noteChatgptProjects([{ id: id('a'), name: 'Team project' }], 1_000, 'team-account-0001')).toBe(true);
  expect((await chatgptProjectChoices(1_000)).map(choice => choice.name)).toEqual(['Team project']);
  expect(await noteChatgptProjects([], 2_000, null)).toBe(true);
  expect(await chatgptProjectChoices(2_000)).toEqual([]);
  const project = await addProject(path.join(approved, 'first'), { chatgpt: 'later' });
  await expect(linkChatgptProject(project.id, id('a'))).rejects.toThrow(/not one ChatGPT lists/);
  // The same empty report again changes nothing; back in the Team workspace, its Projects are there.
  expect(await noteChatgptProjects([], 2_500, null)).toBe(false);
  expect(await noteChatgptProjects([], 3_000, 'team-account-0001')).toBe(true);
  expect((await chatgptProjectChoices(3_000)).map(choice => choice.name)).toEqual(['Team project']);
  // A report whose rows are all invalid still says nothing about the workspace.
  expect(await noteChatgptProjects([{ id: 'g-p-bad', name: 'x' }], 4_000, null)).toBe(false);
  expect((await chatgptProjectChoices(4_000)).map(choice => choice.name)).toEqual(['Team project']);
});

it('links a project without a ChatGPT Project to one the person already has, one to one', async () => {
  await noteChatgptProjects([{ id: id('a'), name: 'Kunden' }, { id: id('b'), name: 'Other' }]);
  const first = await addProject(path.join(approved, 'first'), { chatgpt: 'later' });
  expect(first.chatgpt).toBeUndefined();
  const linked = await linkChatgptProject(first.id, id('a'));
  expect(linked.chatgpt).toMatchObject({ state: 'linked', id: id('a') });
  expect(await linkChatgptProject(first.id, id('a'))).toMatchObject({ chatgpt: { state: 'linked', id: id('a') } });
  const choices = await chatgptProjectChoices();
  expect(choices.find(choice => choice.id === id('a'))?.linkedTo).toEqual({ id: first.id, name: 'first' });
  // A ChatGPT Project belongs to one CoS project; an unknown id or a missing project is refused.
  const second = await addProject(path.join(approved, 'second'), { chatgpt: 'later' });
  await expect(linkChatgptProject(second.id, id('a'))).rejects.toThrow(/already linked to another project/);
  await expect(linkChatgptProject(second.id, id('9'))).rejects.toThrow(/not one ChatGPT lists/);
  await expect(linkChatgptProject('00000000-0000-4000-8000-000000000000', id('b'))).rejects.toThrow(/Project not found/);
  // Each refusal says why in the log, once.
  const refusals = getLog().map(entry => entry.message).filter(message => message.startsWith(`projects: project ${second.id}: link`));
  expect(refusals).toEqual([
    `projects: project ${second.id}: link to the ChatGPT Project ${id('a')} refused (already linked to another project)`,
    `projects: project ${second.id}: link to the ChatGPT Project ${id('9')} refused (not listed for this account)`
  ]);
  // A mistaken link can be changed to another listed Project (Haz on #1757).
  expect((await linkChatgptProject(first.id, id('b'))).chatgpt).toMatchObject({ state: 'linked', id: id('b') });
  expect((await linkChatgptProject(first.id, id('a'))).chatgpt).toMatchObject({ state: 'linked', id: id('a') });
  // Removing the CoS project frees its ChatGPT Project for another.
  await removeProject(first.id);
  expect((await linkChatgptProject(second.id, id('a'))).chatgpt).toMatchObject({ state: 'linked', id: id('a') });
});

it('never links over a ChatGPT Project being created, and can create one later instead', async () => {
  await noteChatgptProjects([{ id: id('a'), name: 'Kunden' }]);
  const created = await addProject(path.join(approved, 'first'));
  expect(created.chatgpt).toMatchObject({ state: 'requested' });
  await expect(linkChatgptProject(created.id, id('a'))).rejects.toThrow(/being created/);
  expect(getLog().some(entry => entry.message === `projects: project ${created.id}: link to the ChatGPT Project ${id('a')} refused (its ChatGPT Project is being created)`)).toBe(true);
  const later = await addProject(path.join(approved, 'second'), { chatgpt: 'later' });
  const requested = await createChatgptProjectFor(later.id);
  expect(requested.chatgpt).toMatchObject({ state: 'requested' });
  // Asking twice does not start a second creation.
  expect((await createChatgptProjectFor(later.id)).chatgpt).toEqual(requested.chatgpt);
  // A failed creation may be replaced by linking an existing Project.
  const rows = await listProjects();
  await writeDurableNow('projects', rows.map(row => row.id === later.id
    ? { ...row, chatgpt: { state: 'failed', requestId: (requested.chatgpt as { requestId: string }).requestId, error: 'gone', updatedAt: 1 } } : row));
  expect((await linkChatgptProject(later.id, id('a'))).chatgpt).toMatchObject({ state: 'linked', id: id('a') });
  expect((await getProject(later.id))?.chatgpt).toMatchObject({ state: 'linked' });
});

it('unlinks a ChatGPT Project without touching it, and starts a new one in place of a linked one only when asked', async () => {
  await noteChatgptProjects([{ id: id('a'), name: 'Kunden' }]);
  const project = await addProject(path.join(approved, 'first'), { chatgpt: 'later' });
  await linkChatgptProject(project.id, id('a'));
  // Asking for a new Project without replace keeps the link, as before.
  expect((await createChatgptProjectFor(project.id)).chatgpt).toMatchObject({ state: 'linked', id: id('a') });
  // Unlinking frees it for another project; nothing in ChatGPT changes, so it is listed as before.
  expect((await unlinkChatgptProject(project.id)).chatgpt).toBeUndefined();
  expect((await chatgptProjectChoices()).find(choice => choice.id === id('a'))?.linkedTo).toBeNull();
  expect((await getProject(project.id))?.chatgpt).toBeUndefined();
  // Unlinking what is not linked is a no-op, never an error.
  expect((await unlinkChatgptProject(project.id)).chatgpt).toBeUndefined();
  await linkChatgptProject(project.id, id('a'));
  expect((await createChatgptProjectFor(project.id, { replace: true })).chatgpt).toMatchObject({ state: 'requested' });
  // While a new one is being created, neither unlinking nor relinking may race it.
  await expect(unlinkChatgptProject(project.id)).rejects.toThrow(/being created/);
  await expect(linkChatgptProject(project.id, id('a'))).rejects.toThrow(/being created/);
});

it('never replaces a catalog it could not read, but rebuilds one that is damaged', async () => {
  expect(await noteChatgptProjects([{ id: id('a'), name: 'Kept' }, { id: id('b'), name: 'Also kept' }], 1_000)).toBe(true);
  const file = path.join(directory, 'state', `${CHATGPT_PROJECT_CATALOG}.json`);
  const saved = await fs.readFile(file, 'utf8');
  // Unreadable for a moment (a lock, a permission hiccup): the shorter report must not replace it.
  // Injected, not by permissions: Windows cannot take read access away with chmod.
  const original = fs.readFile;
  const failing = vi.spyOn(fs, 'readFile').mockImplementation(((target: unknown, ...rest: unknown[]) =>
    String(target) === file ? Promise.reject(Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }))
      : (original as (...args: unknown[]) => Promise<unknown>)(target, ...rest)) as typeof fs.readFile);
  try {
    await expect(noteChatgptProjects([{ id: id('c'), name: 'New' }], 2_000)).rejects.toThrow();
  } finally { failing.mockRestore(); }
  expect(await fs.readFile(file, 'utf8')).toBe(saved);
  // A null row or other damage in an otherwise good file is skipped, not fatal.
  await writeDurableNow(CHATGPT_PROJECT_CATALOG, { version: 1, current: '', projects: [null, 7, { id: id('a'), name: 'Kept', seenAt: 1_000, space: '' }] });
  expect((await chatgptProjectChoices(1_500)).map(choice => choice.name)).toEqual(['Kept']);
  expect(await noteChatgptProjects([{ id: id('c'), name: 'New' }], 2_000)).toBe(true);
  expect((await chatgptProjectChoices(2_000)).map(choice => choice.name)).toEqual(['New', 'Kept']);
  // A file that is not JSON at all is a damaged cache: the next report starts it again.
  await fs.writeFile(file, '{not json');
  expect(await noteChatgptProjects([{ id: id('d'), name: 'Fresh' }], 3_000)).toBe(true);
  expect((await chatgptProjectChoices(3_000)).map(choice => choice.name)).toEqual(['Fresh']);
});
