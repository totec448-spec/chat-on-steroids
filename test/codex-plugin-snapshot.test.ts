import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, removeTempDir } from './helpers.js';
import { defaultConfig, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initSkillsPath } from '../src/main/skills.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { prepareSessionPrompt } from '../src/main/session/prompt.js';
import { currentCoreInstructions } from '../src/main/mcp/instructions.js';
import { listSkillLibrary } from '../src/main/skill-library.js';
import type { CodexPluginRuntimeEntry } from '../src/shared/skills.js';

const runtime = vi.hoisted(() => vi.fn<(...args: string[]) => Promise<CodexPluginRuntimeEntry[]>>());
vi.mock('../src/main/codex-plugin-runtime.js', () => ({ listInstalledCodexPlugins: runtime }));

let directory: string;
beforeEach(async () => {
  directory = await makeTempDir('cos-plugin-snapshot-');
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'fixture', path: directory }] });
  await initSkillsPath(directory);
  vi.stubEnv('USERPROFILE', path.join(directory, 'home'));
  vi.stubEnv('HOME', path.join(directory, 'home'));
  vi.stubEnv('ProgramData', path.join(directory, 'admin'));
  vi.stubEnv('CODEX_HOME', path.join(directory, 'codex'));
  await fs.mkdir(path.join(directory, 'codex', 'plugins', 'cache'), { recursive: true });
  runtime.mockReset();
});
afterEach(async () => {
  vi.unstubAllEnvs(); resetSessionStoreForTests(); resetDurableForTests();
  await removeTempDir(directory);
});

it('prepares a real session prompt and MCP instructions without starting or waiting for a hanging plugin CLI', async () => {
  let release!: (entries: CodexPluginRuntimeEntry[]) => void;
  const held = new Promise<CodexPluginRuntimeEntry[]>(resolve => { release = resolve; });
  runtime.mockReturnValue(held);
  let prepared = false;
  const prompt = prepareSessionPrompt('Keep this ordinary task intact').then(value => { prepared = true; return value; });
  try {
    await vi.waitFor(() => expect(prepared).toBe(true), { timeout: 2_000 });
    expect(await prompt).toContain('Keep this ordinary task intact');
    expect(await currentCoreInstructions()).toContain('Skills');
    expect(runtime).not.toHaveBeenCalled();
  } finally {
    release([]);
    await prompt;
  }
});

async function installedPlugin(): Promise<CodexPluginRuntimeEntry[]> {
  const packageRoot = path.join(directory, 'codex/plugins/cache/team/review/1.0.0');
  await fs.mkdir(path.join(packageRoot, 'skills/audit'), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'plugin.json'), JSON.stringify({ name: 'review', version: '1.0.0' }));
  await fs.writeFile(path.join(packageRoot, 'skills/audit/SKILL.md'), '---\nname: Review\ndescription: Review source changes carefully.\n---\nReview instructions.');
  return [{ pluginId: 'review@team', pluginName: 'review', marketplaceName: 'team', version: '1.0.0',
    installed: true, enabled: true, source: { source: 'local' } }];
}

it('reads once during explicit inspection and serves the same snapshot to sends without launching the CLI again', async () => {
  runtime.mockResolvedValue(await installedPlugin());
  expect((await listSkillLibrary()).skills).toEqual([]);
  expect(runtime).not.toHaveBeenCalled();
  const inspected = await listSkillLibrary({ refreshCodexPlugins: true });
  expect(inspected.skills).toHaveLength(1);
  expect((await listSkillLibrary()).skills[0]!.id).toBe(inspected.skills[0]!.id);
  expect(await prepareSessionPrompt('Review this change')).toContain(inspected.skills[0]!.id);
  await listSkillLibrary({ refreshCodexPlugins: true });
  expect(runtime).toHaveBeenCalledTimes(1);
});

it('invalidates changed Codex config without a send-side refresh and coalesces explicit refreshes', async () => {
  runtime.mockResolvedValue(await installedPlugin());
  await listSkillLibrary({ refreshCodexPlugins: true });
  await fs.writeFile(path.join(directory, 'codex/config.toml'), '# plugins changed\n');
  expect((await listSkillLibrary()).skills).toEqual([]);
  expect(runtime).toHaveBeenCalledTimes(1);
  let release!: (entries: CodexPluginRuntimeEntry[]) => void;
  runtime.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const first = listSkillLibrary({ refreshCodexPlugins: true });
  const second = listSkillLibrary({ refreshCodexPlugins: true });
  try {
    await vi.waitFor(() => expect(runtime).toHaveBeenCalledTimes(2));
    expect((await listSkillLibrary()).skills).toEqual([]);
    expect(await prepareSessionPrompt('Continue independently')).toContain('Continue independently');
    expect(runtime).toHaveBeenCalledTimes(2);
  } finally { release([]); await Promise.all([first, second]); }
  expect(runtime).toHaveBeenCalledTimes(2);
});

it('keeps a cached plugin read-only without an approved Codex home, but never without Read files or under another home', async () => {
  runtime.mockResolvedValue(await installedPlugin());
  expect((await listSkillLibrary({ refreshCodexPlugins: true })).skills).toHaveLength(1);
  const permitted = getConfig();
  // The Codex home is the user's own Skill area: unapproved, its plugin Skill is served read-only.
  await fs.mkdir(path.join(directory, 'unrelated'));
  await saveConfig({ ...permitted, roots: [{ name: 'limited', path: path.join(directory, 'unrelated') }] });
  const unapproved = (await listSkillLibrary({ refreshCodexPlugins: true })).skills;
  expect(unapproved).toHaveLength(1);
  expect(unapproved[0]!.path).toMatch(/^\/user-skills\/codex\/plugins\/cache\/.+\/skills\/.+\/SKILL\.md$/);
  const calls = runtime.mock.calls.length;
  // Without the Read files permission nothing is listed, and the Codex CLI is not started.
  await saveConfig({ ...permitted, capabilities: { ...permitted.capabilities, read: false } });
  expect((await listSkillLibrary({ refreshCodexPlugins: true })).skills).toEqual([]);
  expect(runtime).toHaveBeenCalledTimes(calls);
  // Another Codex home never shows this one's plugin.
  await saveConfig(permitted);
  vi.stubEnv('CODEX_HOME', path.join(directory, 'other-codex'));
  await fs.mkdir(path.join(directory, 'other-codex/plugins/cache'), { recursive: true });
  expect((await listSkillLibrary()).skills).toEqual([]);
  expect(runtime).toHaveBeenCalledTimes(calls);
});

it.each(['configuration', 'home'] as const)('does not publish an old plugin selection when Codex %s changes during explicit refresh', async change => {
  const entries = await installedPlugin();
  let release!: (value: CodexPluginRuntimeEntry[]) => void;
  runtime.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const inspection = listSkillLibrary({ refreshCodexPlugins: true });
  try {
    await vi.waitFor(() => expect(runtime).toHaveBeenCalledTimes(1));
    if (change === 'configuration') {
      await fs.writeFile(path.join(directory, 'codex/config.toml'), '[[skills.config]]\nname = "Review"\nenabled = false\n');
    } else {
      const nextHome = path.join(directory, 'next-codex');
      await fs.mkdir(path.join(nextHome, 'plugins/cache'), { recursive: true });
      vi.stubEnv('CODEX_HOME', nextHome);
    }
    release(entries);
    expect((await inspection).skills).toEqual([]);
    expect(runtime).toHaveBeenCalledTimes(1);
  } finally {
    release?.([]);
    await inspection;
  }
});

it('invalidates changed plugin-cache metadata without making the send start a refresh', async () => {
  runtime.mockResolvedValue(await installedPlugin());
  expect((await listSkillLibrary({ refreshCodexPlugins: true })).skills).toHaveLength(1);
  const cache = path.join(directory, 'codex/plugins/cache');
  const stat = await fs.stat(cache);
  await fs.utimes(cache, stat.atime, new Date(stat.mtimeMs + 2_000));
  expect((await listSkillLibrary()).skills).toEqual([]);
  expect(runtime).toHaveBeenCalledTimes(1);
  runtime.mockResolvedValue([]);
  expect((await listSkillLibrary({ refreshCodexPlugins: true })).skills).toEqual([]);
  expect(runtime).toHaveBeenCalledTimes(2);
});

it('reports a failed inspection but only retries it on a later explicit inspection', async () => {
  runtime.mockRejectedValueOnce(new Error('synthetic runtime unavailable')).mockResolvedValue([]);
  expect((await listSkillLibrary({ refreshCodexPlugins: true })).errors.join(' ')).toContain('synthetic runtime unavailable');
  expect((await listSkillLibrary()).skills).toEqual([]);
  expect(runtime).toHaveBeenCalledTimes(1);
  await listSkillLibrary({ refreshCodexPlugins: true });
  expect(runtime).toHaveBeenCalledTimes(2);
});

it('bounds simultaneous snapshot contexts and does not start a ninth CLI while all eight are pending', async () => {
  const releases: Array<(entries: CodexPluginRuntimeEntry[]) => void> = [];
  const pending: Array<ReturnType<typeof listSkillLibrary>> = [];
  runtime.mockImplementation(() => new Promise(resolve => { releases.push(resolve); }));
  try {
    for (let index = 0; index < 8; index++) {
      const home = path.join(directory, `codex-${index}`);
      await fs.mkdir(path.join(home, 'plugins/cache'), { recursive: true });
      vi.stubEnv('CODEX_HOME', home);
      pending.push(listSkillLibrary({ refreshCodexPlugins: true }));
      await vi.waitFor(() => expect(runtime).toHaveBeenCalledTimes(index + 1));
    }
    const extra = path.join(directory, 'codex-overflow');
    await fs.mkdir(path.join(extra, 'plugins/cache'), { recursive: true });
    vi.stubEnv('CODEX_HOME', extra);
    expect((await listSkillLibrary({ refreshCodexPlugins: true })).errors.join(' ')).toContain('refresh capacity reached');
    expect((await listSkillLibrary()).skills).toEqual([]);
    expect(runtime).toHaveBeenCalledTimes(8);
  } finally {
    releases.forEach(release => release([]));
    await Promise.all(pending);
  }
});
