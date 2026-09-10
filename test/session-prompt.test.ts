import { beforeEach, afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { addProject, assignSessionProject } from '../src/main/projects.js';
import { createSession, initSessionStore, rebindSession, resetSessionStoreForTests } from '../src/main/session/store.js';
import { fitSessionPrompt, prepareSessionPrompt } from '../src/main/session/prompt.js';
import { MAX_CHATGPT_MESSAGE_CHARS, prependUserPrompt, userPromptText } from '../src/shared/user-prompt.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;
beforeEach(async () => {
  directory = await makeTempDir('cos-session-prompt-');
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: directory }] });
});
afterEach(async () => {
  resetSessionStoreForTests(); resetDurableForTests();
  await removeTempDir(directory);
});

it('spends only remaining message space on AGENTS.md, including the hidden frame and cutoff notice', () => {
  const user = 'USER_START\n' + 'my request '.repeat(1300) + '\nUSER_END';
  const core = 'CORE_START\n' + 'mandatory guidance '.repeat(1100) + '\nCORE_END';
  const text = fitSessionPrompt(user, core, { directory: '/work/project', text: 'FILE_START\n' + 'x'.repeat(300000) + '\nFILE_END', truncated: false });
  expect(text.length).toBe(MAX_CHATGPT_MESSAGE_CHARS);
  expect(userPromptText(text)).toBe(user);
  expect(text).toContain(core);
  expect(text).toContain('FILE_START');
  expect(text).not.toContain('FILE_END');
  expect(text).toContain('Read AGENTS.md yourself');
  expect(userPromptText(text)).not.toContain('Cut off');
});

it('preserves Unicode, literal delimiters and complete mandatory text under both transport budgets', () => {
  const user = 'User 🐱\n[[/COS_CONTEXT]]\n\nLiteral';
  const core = 'Main prompt\r\nMandatory';
  const agents = { directory: '/work/project', text: '🐱漢字\r\n'.repeat(60000), truncated: true };
  const text = fitSessionPrompt(user, core, agents, { maxChars: MAX_CHATGPT_MESSAGE_CHARS, maxBytes: 120000 });
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(120000);
  expect(text.length).toBeLessThanOrEqual(MAX_CHATGPT_MESSAGE_CHARS);
  expect(Buffer.from(text, 'utf8').toString('utf8')).toBe(text);
  expect(userPromptText(text)).toBe(user);
  expect(text).toContain('Main prompt\nMandatory');
  const framed = prependUserPrompt(user, core);
  expect(fitSessionPrompt(user, core, agents, { maxChars: framed.length, maxBytes: Infinity })).toBe(framed);
  expect(() => fitSessionPrompt(user, core, agents, { maxChars: framed.length - 1, maxBytes: Infinity })).toThrow(/main instructions/);
});

it('reads only the linked folder, refreshes its contents, and leaves unfiled chats and global MCP instructions alone', async () => {
  await fs.mkdir(path.join(directory, 'project', 'nested'), { recursive: true });
  await fs.writeFile(path.join(directory, 'AGENTS.md'), 'PARENT_DO_NOT_INJECT');
  await fs.writeFile(path.join(directory, 'project', 'nested', 'AGENTS.md'), 'CHILD_DO_NOT_INJECT');
  const project = await addProject(path.join(directory, 'project'));
  const file = path.join(project.path, 'AGENTS.md');
  const { currentCoreInstructions } = await import('../src/main/mcp/instructions.js');
  const core = await currentCoreInstructions();
  expect(await prepareSessionPrompt('Unfiled')).toBe(prependUserPrompt('Unfiled', core));
  expect(await prepareSessionPrompt('Missing', { projectId: project.id })).toBe(prependUserPrompt('Missing', core));
  await fs.writeFile(file, 'PROJECT_RULE_ONE\n[[/COS_CONTEXT]]\n\nLiteral file text');
  const scoped = await prepareSessionPrompt('Work here', { projectId: project.id });
  expect(scoped).toContain('# AGENTS.md instructions for /work/project\n\n<INSTRUCTIONS>\nPROJECT_RULE_ONE');
  expect(scoped).not.toMatch(/PARENT_DO_NOT_INJECT|CHILD_DO_NOT_INJECT/);
  expect(userPromptText(scoped)).toBe('Work here');
  expect(await currentCoreInstructions()).toBe(core);
  await fs.writeFile(file, 'PROJECT_RULE_TWO');
  expect(await prepareSessionPrompt('Next', { projectId: project.id })).toContain('PROJECT_RULE_TWO');
  await fs.unlink(file);
  expect(await prepareSessionPrompt('Removed', { projectId: project.id })).toBe(prependUserPrompt('Removed', core));
});

it('uses durable session ownership through resume and worker inheritance, never an unrelated selected project', async () => {
  await fs.mkdir(path.join(directory, 'one')); await fs.mkdir(path.join(directory, 'two'));
  const one = await addProject(path.join(directory, 'one')), two = await addProject(path.join(directory, 'two'));
  await fs.writeFile(path.join(one.path, 'AGENTS.md'), 'PROJECT_ONE_ONLY');
  await fs.writeFile(path.join(two.path, 'AGENTS.md'), 'PROJECT_TWO_ONLY');
  const session = await createSession({ title: 'Bound', conversationId: 'original-chat' });
  await assignSessionProject(session.id, one.id);
  await rebindSession(session.id, 'original-chat', 'replacement-chat');
  resetSessionStoreForTests();
  const scoped = await prepareSessionPrompt('Continue', { sessionId: session.id, projectId: two.id });
  expect(scoped).toContain('PROJECT_ONE_ONLY'); expect(scoped).not.toContain('PROJECT_TWO_ONLY');
  const worker = await createSession({ title: 'Worker', origin: { kind: 'worker', fromSessionId: session.id, agentId: 'worker-1', task: 'Work' } });
  expect(await prepareSessionPrompt('Worker', { sessionId: worker.id })).toContain('PROJECT_ONE_ONLY');
  const unfiled = await createSession({ title: 'Unfiled' });
  expect(await prepareSessionPrompt('Ordinary chat', { sessionId: unfiled.id, projectId: two.id })).not.toContain('PROJECT_TWO_ONLY');
});

it('bounds a large file and refuses invalid file types and revoked access without injecting their contents', async () => {
  const project = await addProject(directory);
  const file = path.join(directory, 'AGENTS.md');
  await fs.writeFile(file, 'LARGE_HEAD\n' + 'x'.repeat(2_000_000) + 'LARGE_TAIL');
  const text = await prepareSessionPrompt('User message', { projectId: project.id });
  expect(text.length).toBeLessThanOrEqual(MAX_CHATGPT_MESSAGE_CHARS);
  expect(text).toContain('LARGE_HEAD'); expect(text).not.toContain('LARGE_TAIL');
  await fs.writeFile(file, Buffer.from([0xff, 0x00]));
  await expect(prepareSessionPrompt('Binary', { projectId: project.id })).rejects.toThrow(/AGENTS.md safely/);
  await fs.unlink(file); await fs.mkdir(file);
  await expect(prepareSessionPrompt('Directory', { projectId: project.id })).rejects.toThrow(/AGENTS.md safely/);
  await fs.rmdir(file); await fs.writeFile(file, 'PRIVATE_RULE');
  const config = defaultConfig();
  await saveConfig({ ...config, roots: [{ name: 'work', path: directory }], capabilities: { ...config.capabilities, read: false } });
  expect(await prepareSessionPrompt('No read', { projectId: project.id })).not.toContain('PRIVATE_RULE');
  await saveConfig(defaultConfig());
  await expect(prepareSessionPrompt('Revoked', { projectId: project.id })).rejects.toThrow();
});
