import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
const project = vi.hoisted(() => vi.fn());
vi.mock('../src/main/projects.js', () => ({ getSessionProject: project }));
const swarm = vi.hoisted(() => ({ running: false }));
vi.mock('../src/main/agents.js', async (original) => ({ ...(await original<typeof import('../src/main/agents.js')>()), swarmRunning: () => swarm.running }));
import { resolveCwd, resolveIn } from '../src/main/mcp/kernel.js';
import { emptyEvidence, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';
import { resetWorkspaces, setWorkspaceFor } from '../src/main/workspace.js';
import { defaultConfig } from '../src/main/config.js';
import { makeTempDir, removeTempDir, writeTree } from './helpers.js';
let base = '';
beforeAll(async () => { base = await makeTempDir(); await writeTree(base, { 'a/file.txt': 'a', 'b/file.txt': 'b' }); });
afterAll(async () => { await removeTempDir(base); });
beforeEach(() => { resetWorkspaces(); project.mockReset(); swarm.running = false; });
function run<T>(id: string, fn: () => T): T {
  const context: CallContext = { startedAt: Date.now(), transportKey: null, agent: 'prime', caller: { transportKey: null, requestId: null, conversationId: `chat-${id}`, sessionId: id }, outcome: null, evidence: emptyEvidence() };
  return runInCallContext(context, fn);
}
const roots = () => [{ name: 'work', path: base }];
it('initializes simultaneous Prime cwd from each exact durable session project', async () => {
  project.mockImplementation(async (id) => ({ virtual: `/work/${id}`, real: path.join(base, id) }));
  const [a, b] = await Promise.all(['a', 'b'].map(id => run(id, () => resolveCwd({ roots: roots(), caps: defaultConfig().capabilities, readOnly: false }, undefined))));
  expect(a?.virtual).toBe('/work/a'); expect(b?.virtual).toBe('/work/b');
  expect((await run('a', () => resolveIn(roots(), 'file.txt'))).real).toBe(path.join(base, 'a', 'file.txt'));
});
it('keeps the explicit project authoritative over learned cwd and revalidates it', async () => {
  project.mockResolvedValue({ virtual: '/work/a', real: path.join(base, 'a') });
  setWorkspaceFor('chat:chat-a', { virtual: '/work/b', real: path.join(base, 'b') });
  expect((await run('a', () => resolveIn(roots(), 'file.txt'))).virtual).toBe('/work/a/file.txt');
  project.mockRejectedValue(new Error('The session project is unavailable'));
  await expect(run('a', () => resolveIn(roots(), '/work/b/file.txt'))).rejects.toThrow('project is unavailable');
  await expect(run('a', () => resolveCwd({ roots: roots(), caps: defaultConfig().capabilities, readOnly: false }, undefined))).rejects.toThrow('project is unavailable');
});
it('retains the selected project after an absolute path learns a different directory', async () => {
  project.mockResolvedValue({ virtual: '/work/a', real: path.join(base, 'a') });
  await run('a', () => resolveIn(roots(), '/work/b/file.txt'));
  expect((await run('a', () => resolveIn(roots(), 'file.txt'))).real).toBe(path.join(base, 'a', 'file.txt'));
  expect((await run('a', () => resolveCwd({ roots: roots(), caps: defaultConfig().capabilities, readOnly: false }, undefined))).virtual).toBe('/work/a');
});
it('keeps learned cwd for unfiled chats and permits an explicit per-command workdir', async () => {
  project.mockResolvedValue(null);
  await run('a', () => resolveIn(roots(), '/work/b/file.txt'));
  expect((await run('a', () => resolveIn(roots(), 'file.txt'))).virtual).toBe('/work/b/file.txt');
  project.mockResolvedValue({ virtual: '/work/a', real: path.join(base, 'a') });
  expect((await run('a', () => resolveCwd({ roots: roots(), caps: defaultConfig().capabilities, readOnly: false }, '/work/b'))).virtual).toBe('/work/b');
  expect((await run('a', () => resolveIn(roots(), 'file.txt'))).virtual).toBe('/work/a/file.txt');
});
it('drops a learned cwd whose folder was deleted instead of failing the next command', async () => {
  project.mockResolvedValue(null);
  await writeTree(base, { 'gone/file.txt': 'g' });
  await run('a', () => resolveIn(roots(), '/work/gone/file.txt'));
  expect((await run('a', () => resolveCwd({ roots: roots(), caps: defaultConfig().capabilities, readOnly: false }, undefined))).virtual).toBe('/work/gone');
  await removeTempDir(path.join(base, 'gone'));
  const cwd = await run('a', () => resolveCwd({ roots: roots(), caps: defaultConfig().capabilities, readOnly: false }, undefined));
  expect(cwd).toMatchObject({ virtual: '/work', defaulted: true });
  // An explicit workdir afterwards is learned as the new cwd as usual.
  expect((await run('a', () => resolveCwd({ roots: roots(), caps: defaultConfig().capabilities, readOnly: false }, '/work/a'))).virtual).toBe('/work/a');
});
it('tells a multi-agent chat its learned cwd was deleted instead of guessing a folder', async () => {
  project.mockResolvedValue(null);
  await writeTree(base, { 'gone2/file.txt': 'g' });
  await run('w', () => resolveIn(roots(), '/work/gone2/file.txt'));
  await removeTempDir(path.join(base, 'gone2'));
  swarm.running = true;
  await expect(run('w', () => resolveCwd({ roots: roots(), caps: defaultConfig().capabilities, readOnly: false }, undefined)))
    .rejects.toThrow('WORKSPACE_REQUIRED: the folder this chat was working in (/work/gone2) no longer exists');
  // Once forgotten, the next call gets the ordinary refusal, and an explicit workdir works.
  await expect(run('w', () => resolveCwd({ roots: roots(), caps: defaultConfig().capabilities, readOnly: false }, undefined)))
    .rejects.toThrow('has no proven workspace');
  expect((await run('w', () => resolveCwd({ roots: roots(), caps: defaultConfig().capabilities, readOnly: false }, '/work/b'))).virtual).toBe('/work/b');
});
