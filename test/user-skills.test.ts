import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, removeTempDir } from './helpers.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { resolveIn } from '../src/main/mcp/kernel.js';
import { SandboxError } from '../src/main/sandbox.js';

let root: string, home: string;
const write = async (file: string, text = 'x'): Promise<void> => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
const link = (target: string, at: string) => fs.symlink(target, at, process.platform === 'win32' ? 'junction' : 'dir');
const roots = () => [{ name: 'project', path: path.join(root, 'project') }];

beforeEach(async () => {
  root = await fs.realpath(await makeTempDir('cos-user-skills-'));
  home = path.join(root, 'home');
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('CLAUDE_CONFIG_DIR', ''); vi.stubEnv('CODEX_HOME', '');
  await fs.mkdir(path.join(root, 'project'), { recursive: true });
  initConfigPath(root); await saveConfig({ ...defaultConfig(), roots: roots() });
  await write(path.join(home, '.claude/skills/review/SKILL.md'), '---\nname: Review\n---\nRead the diff.');
  await write(path.join(home, '.claude/skills/review/references/checklist.md'), 'Checklist');
  await write(path.join(home, '.claude/plugins/cache/market/pack/1.0.0/skills/audit/SKILL.md'), 'Audit');
  await write(path.join(home, '.claude/plugins/cache/market/pack/1.0.0/hooks/hooks.json'), '{}');
  await write(path.join(home, '.claude/plugins/installed_plugins.json'), '{}');
  await write(path.join(home, '.claude/settings.json'), '{"secret":true}');
  await write(path.join(home, '.codex/auth.json'), '{"token":"t"}');
  await write(path.join(home, '.agents/skills/shared/SKILL.md'), 'Shared');
  await write(path.join(root, 'outside/notes.txt'), 'outside');
});
afterEach(async () => { vi.unstubAllEnvs(); await removeTempDir(root); });

it('serves only Skill trees under /user-skills, only to read tools', async () => {
  const skill = await resolveIn(roots(), '/user-skills/claude/skills/review/SKILL.md', { access: 'read' });
  expect(skill).toMatchObject({ real: path.join(home, '.claude/skills/review/SKILL.md'), virtual: '/user-skills/claude/skills/review/SKILL.md' });
  expect((await resolveIn(roots(), '/user-skills/claude/skills/review/references/checklist.md', { access: 'read' })).virtual)
    .toBe('/user-skills/claude/skills/review/references/checklist.md');
  expect((await resolveIn(roots(), '/user-skills/claude/plugins/cache/market/pack/1.0.0/skills/audit/SKILL.md', { access: 'read' })).real)
    .toBe(path.join(home, '.claude/plugins/cache/market/pack/1.0.0/skills/audit/SKILL.md'));
  expect((await resolveIn(roots(), '/user-skills/agents/skills', { access: 'read' })).real).toBe(path.join(home, '.agents/skills'));

  // Writes, patches and command folders never reach it.
  await expect(resolveIn(roots(), '/user-skills/claude/skills/review/SKILL.md')).rejects.toThrow(/read-only Skill folder/);
  await expect(resolveIn(roots(), '/user-skills/claude/skills/new', { allowMissing: true })).rejects.toThrow(/read-only Skill folder/);

  // Nothing else in those homes: settings, credentials, plugin hooks and lists, other names, climbing out.
  for (const denied of [
    '/user-skills/claude/settings.json', '/user-skills/codex/auth.json', '/user-skills/claude/plugins/installed_plugins.json',
    '/user-skills/claude/plugins/cache/market/pack/1.0.0/hooks/hooks.json', '/user-skills/claude', '/user-skills',
    '/user-skills/claude/skills/../settings.json', '/user-skills/home/.claude/skills', '/user-skills/claude/skills/missing/SKILL.md'
  ]) await expect(resolveIn(roots(), denied, { access: 'read' }), denied).rejects.toBeInstanceOf(SandboxError);
});

it('follows a link only into another Skill tree', async () => {
  // Claude Code users often link ~/.claude/skills/<name> to ~/.agents/skills/<name>.
  await link(path.join(home, '.agents/skills/shared'), path.join(home, '.claude/skills/shared'));
  expect(await resolveIn(roots(), '/user-skills/claude/skills/shared/SKILL.md', { access: 'read' }))
    .toMatchObject({ real: path.join(home, '.agents/skills/shared/SKILL.md'), virtual: '/user-skills/agents/skills/shared/SKILL.md' });
  // A link back into the home or anywhere else is refused.
  await link(path.join(home, '.claude'), path.join(home, '.claude/skills/home'));
  await link(path.join(root, 'outside'), path.join(home, '.claude/skills/outside'));
  await expect(resolveIn(roots(), '/user-skills/claude/skills/home/settings.json', { access: 'read' })).rejects.toThrow(/leaves the Skill folders/);
  await expect(resolveIn(roots(), '/user-skills/claude/skills/outside/notes.txt', { access: 'read' })).rejects.toThrow(/leaves the Skill folders/);
});
