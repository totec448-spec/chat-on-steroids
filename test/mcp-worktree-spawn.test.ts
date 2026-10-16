import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultConfig, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import * as agents from '../src/main/agents.js';
import { onSwarmPersistNow, resetAgentsForTests, snapshotSwarm } from '../src/main/agents.js';
import { emptyEvidence, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';
import { createRegistrar, type ToolContext, type ToolResult } from '../src/main/mcp/kernel.js';
import { registerCoreTools } from '../src/main/mcp/tools-core.js';
import { initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { resetWorkspaces, setWorkspaceFor } from '../src/main/workspace.js';
import * as worktrees from '../src/main/worktrees/index.js';
import { DEFAULT_CAPABILITIES } from '../src/shared/types.js';

describe('MCP worker spawn with automatic Git isolation', () => {
  const primeConversation = 'mcp-worktree-spawn-prime';
  let temp: string;
  let repository: string;

  function gitAt(cwd: string, ...args: string[]): void {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Git fixture failed: ${result.stderr}`);
  }

  function git(...args: string[]): void {
    gitAt(repository, ...args);
  }

  beforeAll(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-mcp-spawn-'));
    repository = path.join(temp, 'project');
    await fs.mkdir(repository);
    git('init');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    await fs.writeFile(path.join(repository, 'tracked.txt'), 'committed\n');
    git('add', 'tracked.txt');
    git('commit', '-m', 'baseline');
    initConfigPath(temp);
    initSessionStore(temp);
  });

  afterAll(async () => {
    resetAgentsForTests();
    resetSessionStoreForTests();
    vi.restoreAllMocks();
    await fs.rm(temp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    resetAgentsForTests();
    resetWorkspaces();
    vi.restoreAllMocks();
    await fs.writeFile(path.join(repository, 'tracked.txt'), 'committed\n');
    const defaults = defaultConfig();
    await saveConfig({
      ...defaults,
      roots: [{ name: 'approved', path: temp }],
      multiAgent: { ...defaults.multiAgent, enabled: true, autoWorktrees: true }
    });
    onSwarmPersistNow(async () => undefined);
  });

  function spawn(workers: Array<{ task: string }>): Promise<ToolResult> {
    const ctx: ToolContext = {
      roots: getConfig().roots,
      caps: { ...DEFAULT_CAPABILITIES, command: true, create: true, edit: true },
      readOnly: false,
      agentTools: true,
      sessionTools: false,
      exposedFinishTool: false
    };
    const registrar = createRegistrar(null, ctx, 'core');
    let handler: ((input: { action: 'spawn'; workers: Array<{ task: string }> }) => Promise<ToolResult>) | undefined;
    registrar.register = ((name, _config, callback) => {
      if (name === 'agents') handler = callback as typeof handler;
    }) as typeof registrar.register;
    registerCoreTools(registrar);
    if (!handler) throw new Error('agents tool missing');
    const call: CallContext = {
      startedAt: Date.now(),
      transportKey: null,
      agent: null,
      caller: { transportKey: null, requestId: null, conversationId: primeConversation, sessionId: null },
      outcome: null,
      evidence: emptyEvidence()
    };
    return runInCallContext(call, () => handler!({ action: 'spawn', workers }));
  }

  function selectedGitSource(): void {
    setWorkspaceFor(`chat:${primeConversation}`, { real: repository, virtual: '/approved/project' });
  }

  it('admits ordinary workers without a workspace despite autoWorktrees being enabled', async () => {
    const allocation = vi.spyOn(worktrees, 'allocWorkerWorkspace');
    const response = await spawn([{ task: 'Research without a local project' }]);

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ action: 'spawn', workers: [{ id: 'worker-1' }] });
    expect(response.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('without isolated Git worktrees') });
    expect(snapshotSwarm()?.agents.find(row => row.info.id === 'worker-1')?.info.managedWorktree).not.toBe(true);
    expect(allocation).not.toHaveBeenCalled();
  });

  // #1469: a project on a server has no checkout on this computer to branch from. Even when a
  // local folder of the same path happens to be a Git repository, workers share the server folder.
  it('lets workers in a server project share its folder instead of making a local worktree', async () => {
    const defaults = defaultConfig();
    // A server path is POSIX; on Windows a local folder cannot share its spelling.
    const serverPath = repository.startsWith('/') ? repository : '/srv/repository';
    await saveConfig({ ...defaults, roots: [{ name: 'approved', path: temp }, { name: 'server', path: `me@devbox:${serverPath}`, remote: { host: 'me@devbox', path: serverPath } }],
      multiAgent: { ...defaults.multiAgent, enabled: true, autoWorktrees: true } });
    setWorkspaceFor(`chat:${primeConversation}`, { real: serverPath, virtual: '/server' });
    const allocation = vi.spyOn(worktrees, 'allocWorkerWorkspace');
    const response = await spawn([{ task: 'Work in the server project' }]);
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    expect(response.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('share its folder') });
    expect(allocation).not.toHaveBeenCalled();
  });

  it('refuses to promote an orphaned managed worker to a new prime after broker eviction', async () => {
    // The exact session-origin/tombstone fence is resolved asynchronously at MCP admission.
    vi.spyOn(agents, 'managedWorkerIsolationRequired').mockResolvedValueOnce(true);
    const response = await spawn([{ task: 'Do not reopen a retired managed worker as prime' }]);
    expect(response.isError).toBe(true);
    expect(response.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('WORKTREE_OWNER_UNAVAILABLE') });
    expect(snapshotSwarm()).toBeNull();
  });

  it('tells the model to approve the folder above the repository when the repository itself is the approved folder', async () => {
    // Managed worktrees live beside the repository, inside an approved folder. Without one above it
    // the spawn is refused; the model needs that reason to tell the user what to change.
    const defaults = defaultConfig();
    await saveConfig({ ...defaults, roots: [{ name: 'approved', path: repository }], multiAgent: { ...defaults.multiAgent, enabled: true, autoWorktrees: true } });
    setWorkspaceFor(`chat:${primeConversation}`, { real: repository, virtual: '/approved' });

    const response = await spawn([{ task: 'Work in an isolated checkout' }]);
    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    expect(response.isError).toBe(true);
    expect(text).toContain('WORKTREE_STORAGE_UNAVAILABLE');
    expect(text).toContain('approve the folder that contains this repository');
    expect(text).toContain('Isolate new workers in Git worktrees');
    expect(text).not.toContain(temp);
    expect(snapshotSwarm()).toBeNull();
  });

  it('warns that dirty source changes are absent from committed-base worktrees', async () => {
    selectedGitSource();
    await fs.writeFile(path.join(repository, 'tracked.txt'), 'local uncommitted edit\n');
    const allocation = vi.spyOn(worktrees, 'allocWorkerWorkspace');

    const response = await spawn([{ task: 'Build from clean HEAD' }]);
    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const lease = await allocation.mock.results[0]?.value;
    expect(response.isError).not.toBe(true);
    expect(lease?.sourceDirty).toBe(true);
    expect((await fs.readFile(path.join(lease!.worktreePath, 'tracked.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('committed\n');
    expect(await fs.readFile(path.join(repository, 'tracked.txt'), 'utf8')).toBe('local uncommitted edit\n');
    expect(text).toMatch(/uncommitted changes/i);
    expect(text).toContain('were not copied');
    expect(allocation).toHaveBeenCalledWith(expect.objectContaining({ primeWorkspace: expect.objectContaining({ real: repository }) }));
    expect(snapshotSwarm()?.agents.find(row => row.info.id === 'worker-1')?.info.managedWorktree).toBe(true);
  });

  it.each(['revoked', 'renamed'] as const)('refuses worker admission when its approved root is %s while Git allocation is awaiting', async change => {
    selectedGitSource();
    const realAllocate = worktrees.allocWorkerWorkspace;
    let lease: Awaited<ReturnType<typeof realAllocate>> | undefined;
    const allocation = vi.spyOn(worktrees, 'allocWorkerWorkspace').mockImplementation(async input => {
      lease = await realAllocate(input);
      // Deterministically publish the Settings change while agents::spawn awaits this
      // allocation. The checkout exists, but its former approval must not reach the broker.
      await saveConfig({ ...getConfig(), roots: change === 'revoked' ? [] : [{ name: 'renamed', path: temp }] });
      return lease;
    });
    const bootstraps = vi.spyOn(agents, 'requestWorkerBootstraps');

    const response = await spawn([{ task: 'Must not start after losing root approval' }]);
    const message = response.content[0]?.type === 'text' ? response.content[0].text : '';
    expect(allocation).toHaveBeenCalledTimes(1);
    expect(lease?.newlyCreated).toBe(true);
    expect(response.isError).toBe(true);
    expect(message).toContain('WORKTREE_ROLLBACK_RETAINED');
    expect(message).not.toContain(temp);
    expect(snapshotSwarm()).toBeNull();
    expect(bootstraps).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(repository, 'tracked.txt'), 'utf8')).toBe('committed\n');
    expect((await fs.readFile(path.join(lease!.worktreePath, 'tracked.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('committed\n');
  });

  it('rechecks root approval after the asynchronous broker persistence barrier', async () => {
    selectedGitSource();
    const allocation = vi.spyOn(worktrees, 'allocWorkerWorkspace');
    const bootstraps = vi.spyOn(agents, 'requestWorkerBootstraps');
    const persistedSnapshots: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersistNow(async snapshot => {
      persistedSnapshots.push(snapshot);
      // The lease was already validated/marked before this awaited durability sink.
      await saveConfig({ ...getConfig(), roots: [] });
    });

    const response = await spawn([{ task: 'Must not be admitted after durable write revocation' }]);
    const lease = await allocation.mock.results[0]?.value;
    expect(allocation).toHaveBeenCalledTimes(1);
    expect(lease?.newlyCreated).toBe(true);
    expect(response.isError).toBe(true);
    expect(response.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('WORKTREE_ROLLBACK_RETAINED') });
    expect(snapshotSwarm()).toBeNull();
    expect(persistedSnapshots.length).toBeGreaterThanOrEqual(2);
    expect(persistedSnapshots[0]?.agents.some(row => row.info.id === 'worker-1')).toBe(true);
    expect(persistedSnapshots.at(-1)).toBeNull();
    expect(bootstraps).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(repository, 'tracked.txt'), 'utf8')).toBe('committed\n');
    expect((await fs.readFile(path.join(lease!.worktreePath, 'tracked.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('committed\n');
  });

  it('hides native retained paths and underlying native allocation errors after a partial failure', async () => {
    selectedGitSource();
    const nativePath = path.join(temp, 'private-managed-worktree');
    const realAllocate = worktrees.allocWorkerWorkspace;
    const allocation = vi.spyOn(worktrees, 'allocWorkerWorkspace')
      .mockImplementationOnce(input => realAllocate(input))
      .mockRejectedValueOnce(new Error(`Git failed inside ${nativePath}`));

    const response = await spawn([{ task: 'First' }, { task: 'Second' }]);
    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    expect(allocation).toHaveBeenCalledTimes(2);
    expect(response.isError).toBe(true);
    expect(text).toContain('WORKTREE_ROLLBACK_RETAINED');
    expect(text).toContain('local app logs');
    expect(text).not.toContain(nativePath);
    expect(text).not.toContain(temp);
    expect(text).not.toContain('Git failed inside');
    expect(snapshotSwarm()).toBeNull();
  });

  it('redacts native paths when the very first allocation finds an unsafe managed parent', async () => {
    const approved = path.join(temp, 'unsafe-root');
    const source = path.join(approved, 'project');
    await fs.mkdir(source, { recursive: true });
    gitAt(source, 'init');
    gitAt(source, 'config', 'user.email', 'test@example.com');
    gitAt(source, 'config', 'user.name', 'Test');
    await fs.writeFile(path.join(source, 'source.txt'), 'base\n');
    gitAt(source, 'add', 'source.txt');
    gitAt(source, 'commit', '-m', 'baseline');
    const unsafeNativePath = path.join(approved, '.chat-on-steroids-worktrees');
    await fs.writeFile(unsafeNativePath, 'personal file that blocks managed storage');
    await saveConfig({ ...getConfig(), roots: [{ name: 'approved', path: approved }] });
    setWorkspaceFor(`chat:${primeConversation}`, { real: source, virtual: '/approved/project' });

    const response = await spawn([{ task: 'Worktree allocation must fail safely' }]);
    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    expect(response.isError).toBe(true);
    expect(text).toContain('WORKTREE_STORAGE_UNSAFE');
    expect(text).not.toContain(unsafeNativePath);
    expect(text).not.toContain(approved);
    expect(await fs.readFile(unsafeNativePath, 'utf8')).toContain('personal file');
    expect(snapshotSwarm()).toBeNull();
  });
});
