import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, removeTempDir } from './helpers.js';
import { defaultConfig, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initSkillsPath, importSkillPackage, listSkills, removeDiscoveredSkill, removeSkill, setDiscoveredSkillEnabled, setManagedSkillEnabled } from '../src/main/skills.js';
import { listGlobalSkills, listSkillLibrary, readLibrarySkill, skillLibraryInstructions } from '../src/main/skill-library.js';
import type { LibrarySkill } from '../src/shared/skills.js';

let root: string, project: string;
const contents = (name: string, body = 'Keep all instructions.') => `---\nname: ${name}\ndescription: >-\n  Check the source\n  before editing.\n---\n${body}`;
async function write(file: string, text: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text);
}
async function interruptedStandaloneRemoval(original: string): Promise<{ stageRoot: string; staged: string }> {
  const name = path.basename(original);
  const stat = await fs.lstat(original);
  const stageRoot = path.join(path.dirname(original), `.cos-removing-${randomUUID()}`);
  const staged = path.join(stageRoot, name);
  await fs.mkdir(stageRoot);
  await fs.writeFile(path.join(stageRoot, '.cos-removal.json'), JSON.stringify({
    version: 1, name, kind: 'directory', identity: { dev: stat.dev, ino: stat.ino, size: stat.size }
  }));
  await fs.rename(original, staged);
  return { stageRoot, staged };
}
beforeEach(async () => {
  root = await makeTempDir('cos-skill-library-'); project = path.join(root, 'project');
  await fs.mkdir(project); await fs.mkdir(path.join(project, '.git'));
  vi.stubEnv('USERPROFILE', path.join(root, 'home')); vi.stubEnv('HOME', path.join(root, 'home'));
  vi.stubEnv('CODEX_HOME', path.join(root, 'codex')); vi.stubEnv('ProgramData', path.join(root, 'admin'));
  initConfigPath(root); await saveConfig({ ...defaultConfig(), roots: [{ name: 'workspace', path: root }] });
  await initSkillsPath(root);
});
afterEach(async () => { vi.unstubAllEnvs(); await removeTempDir(root); });

it('imports every resource and removes the whole package so it can be imported again', async () => {
  const source = path.join(root, 'sources', 'review');
  await write(path.join(source, 'SKILL.md'), contents('Review'));
  await write(path.join(source, 'references', 'notes.txt'), 'Resource bytes\r\n');
  await write(path.join(source, 'assets', 'binary.dat'), Buffer.from([0, 1, 255]));
  await write(path.join(source, 'agents', 'openai.yaml'), 'interface: { display_name: "Evidence review" }\npolicy: { allow_implicit_invocation: false }');
  await importSkillPackage(source);
  expect(await fs.readFile(path.join(root, 'skills/review/references/notes.txt'), 'utf8')).toBe('Resource bytes\r\n');
  const library = await listSkillLibrary({ projectPath: project });
  expect(library.skills[0]).toMatchObject({ id: 'review', managed: true, displayName: 'Evidence review', allowImplicitInvocation: false });
  expect(skillLibraryInstructions(library)).not.toContain('Evidence review');
  expect((await readLibrarySkill('review', { projectPath: project }, library)).text).toBe(contents('Review'));
  await removeSkill('review', directory => fs.rename(directory, path.join(root, 'removed-review')));
  expect(await listSkills()).toEqual([]);
  expect(await fs.readFile(path.join(root, 'removed-review/assets/binary.dat'))).toEqual(Buffer.from([0, 1, 255]));
  await expect(importSkillPackage(source)).resolves.toMatchObject({ id: 'review' });
});

it('keeps commands stable when another package with the same name appears or disappears', async () => {
  const filename = path.join(project, '.agents/skills/first/SKILL.md');
  await write(filename, contents('Review'));
  const before = await listSkillLibrary({ projectPath: project });
  expect(before.skills).toHaveLength(1);
  const command = before.skills[0]!.id;
  await write(path.join(project, '.codex/skills/second/SKILL.md'), contents('Review', 'Other instructions.'));
  const both = await listSkillLibrary({ projectPath: project });
  expect(new Set(both.skills.map(skill => skill.id)).size).toBe(2);
  expect(both.skills.find(skill => skill.path.endsWith('/first/SKILL.md'))!.id).toBe(command);
  expect((await readLibrarySkill(command, { projectPath: project })).text).toBe(contents('Review'));
  expect((await listSkillLibrary()).skills).toEqual([]);
});

it('deduplicates a managed package link against the same discovered SKILL.md', async () => {
  const source = path.join(project, '.agents/skills/review');
  await write(path.join(source, 'SKILL.md'), contents('Review'));
  await fs.symlink(source, path.join(root, 'skills', 'review'), process.platform === 'win32' ? 'junction' : 'dir');
  const library = await listSkillLibrary({ projectPath: project });
  expect(library.skills).toHaveLength(1);
  expect(library.skills[0]).toMatchObject({ id: 'review', managed: true, path: '/skills/review/SKILL.md' });
});

it('does not rediscover a disabled managed link under a new external Skill ID', async () => {
  const source = path.join(project, '.agents/skills/review');
  await write(path.join(source, 'SKILL.md'), contents('Review'));
  await fs.symlink(source, path.join(root, 'skills/review'), process.platform === 'win32' ? 'junction' : 'dir');
  expect((await listSkillLibrary({ projectPath: project })).skills.map(skill => skill.id)).toEqual(['review']);
  await setManagedSkillEnabled('review', false);
  const hidden = await listSkillLibrary({ projectPath: project });
  expect(hidden.skills).toEqual([]);
  expect((await listGlobalSkills()).find(skill => skill.id === 'review')?.enabled).toBe(false);
  await initSkillsPath(root);
  expect((await listSkillLibrary({ projectPath: project })).skills).toEqual([]);
  await setManagedSkillEnabled('review', true);
  expect((await listSkillLibrary({ projectPath: project })).skills.map(skill => skill.id)).toEqual(['review']);
});

it('honors layered config and both YAML policy styles while keeping package resources out of discovery', async () => {
  await write(path.join(project, '.agents/skills/review/SKILL.md'), contents('Review'));
  await write(path.join(project, '.agents/skills/review/references/example/SKILL.md'), contents('Example only'));
  await write(path.join(root, 'codex/skills/.system/default/SKILL.md'), contents('System skill'));
  await write(path.join(root, 'codex/config.toml'), '[skills]\ninclude_instructions = false\nbundled = { enabled = false }\n[[skills.config]]\nname = "Review"\nenabled = false');
  expect((await listSkillLibrary({ projectPath: project })).skills).toEqual([]);
  await write(path.join(project, '.codex/config.toml'), '[skills]\ninclude_instructions = true\nmax_context_tokens = 3_000\n[[skills.config]]\nname = "Review"\nenabled = true');
  const library = await listSkillLibrary({ projectPath: project });
  expect(library.includeInstructions).toBe(true); expect(library.maxContextTokens).toBe(3000);
  expect(library.skills.map(skill => skill.name)).toEqual(['Review']);
  expect(library.errors).toEqual([]);
});

it('reads the user\'s own Skill folders read-only without approving their homes', async () => {
  await write(path.join(root, 'home/.agents/skills/private/SKILL.md'), contents('Private'));
  await write(path.join(root, 'codex/plugins/cache/team-market/private-pack/1.0.0/plugin.json'), JSON.stringify({ name: 'private-pack', version: '1.0.0' }));
  await write(path.join(root, 'codex/plugins/cache/team-market/private-pack/1.0.0/skills/private/SKILL.md'), contents('Private plugin'));
  await saveConfig({ ...getConfig(), roots: [{ name: 'project', path: project }] });
  const location = path.join(project, '.agents/skills'); await fs.mkdir(location, { recursive: true });
  await fs.symlink(path.join(root, 'home/.agents/skills/private'), path.join(location, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const library = await listSkillLibrary({ projectPath: project }, { codexPlugins: async () => [] });
  // ~/.agents is not approved, yet its Skill is listed once, under the read-only /user-skills path;
  // the project's link to it lists nothing twice. A Codex plugin the runtime does not report stays out.
  expect(library.skills.map(skill => [skill.name, skill.path])).toEqual([['Private', '/user-skills/agents/skills/private/SKILL.md']]);
  expect((await readLibrarySkill(library.skills[0]!.id, { projectPath: project }, library)).text).toBe(contents('Private'));
  expect(library.roots.every(entry => !entry.path.includes('plugins/cache'))).toBe(true);
  expect(library.errors).toEqual([]);
  // Without the Read files permission nothing is discovered.
  await saveConfig({ ...getConfig(), capabilities: { ...getConfig().capabilities, read: false } });
  expect((await listSkillLibrary({}, { codexPlugins: async () => [] })).skills).toEqual([]);
});

it('shows existing global user Skills in the manager and persists their activation for agents', async () => {
  await write(path.join(root, 'home/.agents/skills/first/SKILL.md'), contents('First'));
  await write(path.join(root, 'home/.agents/skills/second/SKILL.md'), contents('Second'));
  await write(path.join(root, 'codex/skills/.system/default/SKILL.md'), contents('Bundled'));
  const initial = await listGlobalSkills();
  expect(initial.map(skill => skill.name)).toEqual(['First', 'Second']);
  expect(initial.every(skill => skill.managed === false && skill.source === 'user-agents' && skill.enabled)).toBe(true);
  const first = initial[0]!;
  const inspected = await listSkillLibrary({ includeDisabledExternal: true });
  await setDiscoveredSkillEnabled(first.id, false);
  expect((await listGlobalSkills()).find(skill => skill.id === first.id)?.enabled).toBe(false);
  expect((await listSkillLibrary()).skills.some(skill => skill.id === first.id)).toBe(false);
  await expect(readLibrarySkill(first.id, {}, inspected)).rejects.toThrow('disabled');
  expect(await fs.readFile(path.join(root, 'home/.agents/skills/first/SKILL.md'), 'utf8')).toBe(contents('First'));
  await initSkillsPath(root);
  expect((await listGlobalSkills()).find(skill => skill.id === first.id)?.enabled).toBe(false);
  await setDiscoveredSkillEnabled(first.id, true);
  expect((await listSkillLibrary()).skills.some(skill => skill.id === first.id)).toBe(true);
});

it('moves the complete user Skill package to Trash and clears its disabled state without affecting neighbors', async () => {
  const firstFolder = path.join(root, 'home/.agents/skills/first');
  const otherFolder = path.join(root, 'home/.agents/skills/other');
  await write(path.join(firstFolder, 'SKILL.md'), contents('First'));
  await write(path.join(firstFolder, 'references/notes.txt'), 'A reference');
  await write(path.join(firstFolder, 'scripts/run.cmd'), 'echo hello');
  await write(path.join(otherFolder, 'SKILL.md'), contents('Other'));
  const externalResource = path.join(root, 'external-resources');
  await write(path.join(externalResource, 'shared.txt'), 'Shared data survives');
  await fs.symlink(externalResource, path.join(firstFolder, 'linked-resources'), process.platform === 'win32' ? 'junction' : 'dir');
  const initial = await listGlobalSkills();
  expect(initial).toHaveLength(2);
  const first = initial.find(skill => skill.name === 'First')!;
  expect({ source: first.source, path: first.path }).toEqual({ source: 'user-agents', path: '/user-skills/agents/skills/first/SKILL.md' });
  expect(first.canRemove).toBe(true);
  await setDiscoveredSkillEnabled(first.id, false);
  const trash = path.join(root, 'mock-trash'); await fs.mkdir(trash);
  await removeDiscoveredSkill(first.id, first.source, first.path, folder => fs.rename(folder, path.join(trash, path.basename(folder))));
  await expect(fs.lstat(firstFolder)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(path.join(trash, 'first/references/notes.txt'), 'utf8')).toBe('A reference');
  expect(await fs.readFile(path.join(trash, 'first/scripts/run.cmd'), 'utf8')).toBe('echo hello');
  expect(await fs.readFile(path.join(otherFolder, 'SKILL.md'), 'utf8')).toBe(contents('Other'));
  expect(await fs.readFile(path.join(externalResource, 'shared.txt'), 'utf8')).toBe('Shared data survives');
  expect((await listGlobalSkills()).map(skill => skill.name)).toEqual(['Other']);
  await expect(fs.lstat(path.join(root, 'skills/.cos-disabled-skills.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await initSkillsPath(root);
  expect((await listGlobalSkills()).map(skill => skill.name)).toEqual(['Other']);
});

it('refuses stale IDs and linked user Skill folders without following or deleting their targets', async () => {
  const folder = path.join(root, 'home/.agents/skills/first');
  await write(path.join(folder, 'SKILL.md'), contents('First'));
  const first = (await listGlobalSkills())[0]!;
  const toTrash = async () => { throw new Error('Should not reach Trash'); };
  await expect(removeDiscoveredSkill('different--user-123456789abc', first.source, first.path, toTrash))
    .rejects.toThrow('package identity changed');
  await expect(removeDiscoveredSkill(first.id, first.source, '/user-skills/agents/skills/../SKILL.md', toTrash))
    .rejects.toThrow('Only standalone');
  expect(await fs.readFile(path.join(folder, 'SKILL.md'), 'utf8')).toBe(contents('First'));
  const outside = path.join(root, 'outside');
  await write(path.join(outside, 'SKILL.md'), contents('Outside'));
  const link = path.join(root, 'home/.agents/skills/linked');
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(removeDiscoveredSkill(first.id, first.source, '/user-skills/agents/skills/linked/SKILL.md', toTrash))
    .rejects.toThrow('linked or changed');
  expect(await fs.readFile(path.join(outside, 'SKILL.md'), 'utf8')).toBe(contents('Outside'));
});

it('restores a disabled user Skill when Trash fails, preserving its files and disabled state', async () => {
  const folder = path.join(root, 'home/.agents/skills/first');
  await write(path.join(folder, 'SKILL.md'), contents('First'));
  await write(path.join(folder, 'references/info.txt'), 'Keep this data');
  const first = (await listGlobalSkills())[0]!;
  await setDiscoveredSkillEnabled(first.id, false);
  await expect(removeDiscoveredSkill(first.id, first.source, first.path, async () => {
    throw new Error('Trash unavailable');
  })).rejects.toThrow('Trash unavailable');
  expect(await fs.readFile(path.join(folder, 'references/info.txt'), 'utf8')).toBe('Keep this data');
  expect((await listGlobalSkills())[0]!.enabled).toBe(false);
  await initSkillsPath(root);
  expect((await listGlobalSkills())[0]!.enabled).toBe(false);
  expect((await fs.readdir(path.dirname(folder))).sort()).toEqual(['first']);
});

it('trashes the validated folder and never a replacement created after staging', async () => {
  const folder = path.join(root, 'home/.agents/skills/first');
  await write(path.join(folder, 'SKILL.md'), contents('First'));
  const first = (await listGlobalSkills())[0]!;
  const trash = path.join(root, 'mock-trash'); await fs.mkdir(trash);
  await removeDiscoveredSkill(first.id, first.source, first.path, async staged => {
    await write(path.join(folder, 'SKILL.md'), contents('Replacement'));
    await fs.rename(staged, path.join(trash, path.basename(staged)));
  });
  expect(await fs.readFile(path.join(folder, 'SKILL.md'), 'utf8')).toBe(contents('Replacement'));
  expect(await fs.readFile(path.join(trash, 'first/SKILL.md'), 'utf8')).toBe(contents('First'));
});

it('restores crash-staged standalone Skills from direct agents, Codex, and Claude homes on startup', async () => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'claude'));
  const cases = [
    { directory: path.join(root, 'home/.agents/skills/agents-first'), name: 'AgentsFirst', source: 'user-agents' },
    { directory: path.join(root, 'codex/skills/codex-first'), name: 'CodexFirst', source: 'codex-home' },
    { directory: path.join(root, 'claude/skills/claude-first'), name: 'ClaudeFirst', source: 'claude-home' }
  ];
  const staged: string[] = [];
  for (const entry of cases) {
    await write(path.join(entry.directory, 'SKILL.md'), contents(entry.name));
    await write(path.join(entry.directory, 'references/note.txt'), `${entry.name} resource`);
    const crash = await interruptedStandaloneRemoval(entry.directory);
    staged.push(crash.stageRoot);
    await expect(fs.lstat(entry.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  }

  await initSkillsPath(root);
  for (let index = 0; index < cases.length; index++) {
    const entry = cases[index]!;
    expect(await fs.readFile(path.join(entry.directory, 'SKILL.md'), 'utf8')).toBe(contents(entry.name));
    expect(await fs.readFile(path.join(entry.directory, 'references/note.txt'), 'utf8')).toBe(`${entry.name} resource`);
    await expect(fs.lstat(staged[index]!)).rejects.toMatchObject({ code: 'ENOENT' });
  }
  const globals = await listGlobalSkills();
  for (const entry of cases) expect(globals).toContainEqual(expect.objectContaining({
    name: entry.name, source: entry.source, managed: false
  }));
});

it('leaves occupied and forged standalone recovery stages untouched', async () => {
  const userRoot = path.join(root, 'home/.agents/skills');
  const original = path.join(userRoot, 'existing');
  await write(path.join(original, 'SKILL.md'), contents('OldVersion'));
  const occupied = await interruptedStandaloneRemoval(original);
  await write(path.join(original, 'SKILL.md'), contents('Replacement'));
  const forgedOriginal = path.join(userRoot, 'forged');
  await write(path.join(forgedOriginal, 'SKILL.md'), contents('Forged'));
  const forged = await interruptedStandaloneRemoval(forgedOriginal);
  const forgedMarker = path.join(forged.stageRoot, '.cos-removal.json');
  const record = JSON.parse(await fs.readFile(forgedMarker, 'utf8')) as {
    version: number; name: string; kind: string; identity: { dev: number; ino: number; size: number };
  };
  record.identity.ino += 1_000_000; // Use a representable difference even for large Windows inode numbers.
  await fs.writeFile(forgedMarker, JSON.stringify(record));

  await initSkillsPath(root);
  expect(await fs.readFile(path.join(original, 'SKILL.md'), 'utf8')).toBe(contents('Replacement'));
  expect(await fs.readFile(path.join(occupied.staged, 'SKILL.md'), 'utf8')).toBe(contents('OldVersion'));
  expect(await fs.readFile(path.join(occupied.stageRoot, '.cos-removal.json'), 'utf8')).toContain('"name":"existing"');
  await expect(fs.lstat(forgedOriginal)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(path.join(forged.staged, 'SKILL.md'), 'utf8')).toBe(contents('Forged'));
  expect(await fs.readFile(forgedMarker, 'utf8')).toContain('"ino":');
  expect((await listGlobalSkills()).map(skill => skill.name)).toEqual(['Replacement']);
});

it('discovers enabled Codex plugin skills from only the active installed version and keeps command identity across upgrades', async () => {
  const codex = path.join(root, 'codex');
  const plugin = path.join(codex, 'plugins/cache/team-market/review-pack');
  await write(path.join(plugin, '1.2.0/plugin.json'), JSON.stringify({ name: 'review-pack', version: '1.2.0' }));
  await write(path.join(plugin, '1.2.0/skills/audit/SKILL.md'), contents('Audit', 'Old plugin instructions.'));
  await write(path.join(plugin, '1.10.0/.codex-plugin/plugin.json'), JSON.stringify({ name: 'review-pack', version: '1.10.0' }));
  await write(path.join(plugin, '1.10.0/skills/audit/SKILL.md'), contents('Audit', 'Current plugin instructions.'));

  let version = '1.10.0';
  const runtime = { codexPlugins: async () => [{
    pluginId: 'review-pack@team-market', pluginName: 'review-pack', marketplaceName: 'team-market', version,
    installed: true as const, enabled: true, source: { source: 'git' as const, url: 'https://example.invalid/review-pack.git', ref: 'main', sha: 'a'.repeat(40) }
  }] };
  const before = await listSkillLibrary({ projectPath: project, refreshCodexPlugins: true }, runtime);
  expect(before.skills).toHaveLength(1);
  expect(before.skills[0]).toMatchObject({
    name: 'Audit', source: 'codex-plugin', scope: 'user', managed: false,
    codexPlugin: {
      pluginId: 'review-pack@team-market', pluginName: 'review-pack', marketplaceName: 'team-market', version: '1.10.0', skillPath: 'audit',
      source: { source: 'git', url: 'https://example.invalid/review-pack.git', ref: 'main', sha: 'a'.repeat(40) }
    }
  });
  expect((await readLibrarySkill(before.skills[0]!.id, { projectPath: project }, before)).text).toBe(contents('Audit', 'Current plugin instructions.'));
  const command = before.skills[0]!.id;

  await write(path.join(plugin, '2.0.0/plugin.json'), JSON.stringify({ name: 'review-pack', version: '2.0.0' }));
  await write(path.join(plugin, '2.0.0/skills/audit/SKILL.md'), contents('Audit', 'Upgraded plugin instructions.'));
  version = '2.0.0';
  await write(path.join(codex, 'config.toml'), '# Plugin configuration changed\n');
  const after = await listSkillLibrary({ projectPath: project, refreshCodexPlugins: true }, runtime);
  expect(after.skills).toHaveLength(1);
  expect(after.skills[0]!.id).toBe(command);
  expect(after.skills[0]).toMatchObject({ codexPlugin: { version: '2.0.0' } });
  expect((await readLibrarySkill(command, { projectPath: project }, after)).text).toBe(contents('Audit', 'Upgraded plugin instructions.'));
});

it('prefers a local Codex plugin install and ignores disabled, unconfigured and mismatched plugin packages', async () => {
  const codex = path.join(root, 'codex');
  const cache = path.join(codex, 'plugins/cache/team-market');
  await write(path.join(cache, 'review-pack/9.0.0/plugin.json'), JSON.stringify({ name: 'review-pack', version: '9.0.0' }));
  await write(path.join(cache, 'review-pack/9.0.0/skills/review/SKILL.md'), contents('Review', 'Remote version.'));
  await write(path.join(cache, 'review-pack/local/plugin.json'), JSON.stringify({ name: 'review-pack', version: 'local' }));
  await write(path.join(cache, 'review-pack/local/skills/review/SKILL.md'), contents('Review', 'Local version.'));
  await write(path.join(cache, 'disabled-pack/1.0.0/plugin.json'), JSON.stringify({ name: 'disabled-pack', version: '1.0.0' }));
  await write(path.join(cache, 'disabled-pack/1.0.0/skills/disabled/SKILL.md'), contents('Disabled'));
  await write(path.join(cache, 'not-configured/1.0.0/plugin.json'), JSON.stringify({ name: 'not-configured', version: '1.0.0' }));
  await write(path.join(cache, 'not-configured/1.0.0/skills/hidden/SKILL.md'), contents('Hidden'));
  await write(path.join(cache, 'wrong-name/1.0.0/plugin.json'), JSON.stringify({ name: 'different-name', version: '1.0.0' }));
  await write(path.join(cache, 'wrong-name/1.0.0/skills/wrong/SKILL.md'), contents('Wrong'));
  const entry = (name: string, version: string, enabled: boolean) => ({
    pluginId: `${name}@team-market`, pluginName: name, marketplaceName: 'team-market', version,
    installed: true as const, enabled, source: { source: 'local' as const }
  });
  const library = await listSkillLibrary({ projectPath: project, refreshCodexPlugins: true }, { codexPlugins: async () => [
    entry('review-pack', 'local', true), entry('disabled-pack', '1.0.0', false), entry('wrong-name', '1.0.0', true)
  ] });
  expect(library.skills.map(skill => skill.name)).toEqual(['Review']);
  expect(library.skills[0]).toMatchObject({ source: 'codex-plugin', codexPlugin: { version: 'local' } });
  expect((await readLibrarySkill(library.skills[0]!.id, { projectPath: project }, library)).text).toBe(contents('Review', 'Local version.'));
  expect(library.errors.join(' ')).toMatch(/wrong-name|manifest/i);
});

it('rejects linked package resources without publishing a partial SKILL.md', async () => {
  const source = path.join(root, 'sources', 'linked');
  await write(path.join(source, 'SKILL.md'), contents('Linked'));
  await fs.mkdir(path.join(root, 'outside'));
  await fs.symlink(path.join(root, 'outside'), path.join(source, 'references'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(importSkillPackage(source)).rejects.toThrow(/links|linked/i);
  expect(await listSkills()).toEqual([]);
  await expect(fs.stat(path.join(root, 'skills/linked'))).rejects.toThrow();
});

it('discovers Skills from enabled Claude Code plugins and Claude\'s own Skills folders', async () => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'claude'));
  const claude = path.join(root, 'claude');
  const cache = path.join(claude, 'plugins/cache/team-market');
  const installed = (name: string, version: string, extra: Record<string, unknown> = {}) =>
    [{ scope: 'user', installPath: path.join(cache, name, version), version, ...extra }];
  await write(path.join(cache, 'review-pack/1.2.0/.claude-plugin/plugin.json'), JSON.stringify({ name: 'review-pack' }));
  await write(path.join(cache, 'review-pack/1.2.0/skills/audit/SKILL.md'), contents('Audit', 'Claude plugin instructions.'));
  await write(path.join(cache, 'off-pack/1.0.0/skills/off/SKILL.md'), contents('Off'));
  await write(path.join(cache, 'unlisted-pack/1.0.0/skills/unlisted/SKILL.md'), contents('Unlisted'));
  await write(path.join(cache, 'wrong-name/1.0.0/.claude-plugin/plugin.json'), JSON.stringify({ name: 'something-else' }));
  await write(path.join(cache, 'wrong-name/1.0.0/skills/wrong/SKILL.md'), contents('Wrong'));
  await write(path.join(root, 'elsewhere/escape/1.0.0/skills/escape/SKILL.md'), contents('Escape'));
  await write(path.join(cache, 'project-pack/1.0.0/skills/project-only/SKILL.md'), contents('ProjectOnly'));
  await write(path.join(claude, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
    'review-pack@team-market': installed('review-pack', '1.2.0'),
    'off-pack@team-market': installed('off-pack', '1.0.0'),
    'unlisted-pack@team-market': installed('unlisted-pack', '1.0.0'),
    'wrong-name@team-market': installed('wrong-name', '1.0.0'),
    'escape@team-market': [{ scope: 'user', installPath: path.join(root, 'elsewhere/escape/1.0.0'), version: '1.0.0' }],
    'project-pack@team-market': installed('project-pack', '1.0.0', { scope: 'project', projectPath: project })
  } }));
  await write(path.join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: {
    'review-pack@team-market': true, 'off-pack@team-market': false, 'wrong-name@team-market': true,
    'escape@team-market': true, 'project-pack@team-market': true
  } }));
  await write(path.join(claude, 'skills/personal/SKILL.md'), contents('Personal'));
  await write(path.join(project, '.claude/skills/repo-skill/SKILL.md'), contents('RepoSkill'));

  const library = await listSkillLibrary({ projectPath: project });
  const names = library.skills.map(skill => skill.name).sort();
  // A package manifest may name the plugin differently; Claude Code goes by the marketplace entry.
  expect(names).toEqual(['Audit', 'Personal', 'ProjectOnly', 'RepoSkill', 'Wrong']);
  const audit = library.skills.find(skill => skill.name === 'Audit')!;
  expect(audit).toMatchObject({ source: 'claude-plugin', scope: 'user', managed: false,
    claudePlugin: { pluginId: 'review-pack@team-market', pluginName: 'review-pack', marketplaceName: 'team-market', version: '1.2.0', skillPath: 'audit' } });
  expect(audit.id).toMatch(/^audit--claude-[0-9a-f]{12}$/);
  expect((await readLibrarySkill(audit.id, { projectPath: project }, library)).text).toBe(contents('Audit', 'Claude plugin instructions.'));
  expect(library.skills.find(skill => skill.name === 'Personal')).toMatchObject({ source: 'claude-home', scope: 'user' });
  expect(library.skills.find(skill => skill.name === 'RepoSkill')).toMatchObject({ source: 'project-claude', scope: 'repo' });
  expect(library.errors.join(' ')).toContain('escape@team-market');

  // A project's own settings can switch a plugin off, and a project-scoped install stays with its project.
  await write(path.join(project, '.claude/settings.local.json'), JSON.stringify({ enabledPlugins: { 'review-pack@team-market': false } }));
  expect((await listSkillLibrary({ projectPath: project })).skills.map(skill => skill.name)).not.toContain('Audit');
  expect((await listSkillLibrary()).skills.map(skill => skill.name).sort()).toEqual(['Audit', 'Personal', 'Wrong']);
  expect((await listGlobalSkills()).map(skill => skill.name)).toEqual(['Personal']);
});

it('keeps a Claude plugin Skill\'s command across a plugin update', async () => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'claude'));
  const claude = path.join(root, 'claude');
  const cache = path.join(claude, 'plugins/cache/team-market/review-pack');
  const install = async (version: string, body: string) => {
    await write(path.join(cache, version, 'skills/audit/SKILL.md'), contents('Audit', body));
    await write(path.join(claude, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
      'review-pack@team-market': [{ scope: 'user', installPath: path.join(cache, version), version }] } }));
  };
  await write(path.join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'review-pack@team-market': true } }));
  await install('1.0.0', 'First.');
  const before = await listSkillLibrary();
  await install('2.0.0', 'Updated.');
  const after = await listSkillLibrary();
  expect(after.skills.map(skill => skill.id)).toEqual(before.skills.map(skill => skill.id));
  expect((await readLibrarySkill(before.skills[0]!.id, {}, after)).text).toBe(contents('Audit', 'Updated.'));
});

it('lists only the signed-in Claude account\'s synced Skills and stays quiet about links into ~/.agents/skills', async () => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
  const home = path.join(root, 'home'), claude = path.join(home, '.claude');
  const organization = '11111111-2222-3333-4444-555555555555', account = '66666666-7777-8888-9999-000000000000';
  await write(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: organization, accountUuid: account, emailAddress: 'x@example.invalid' } }));
  await write(path.join(claude, `skills/synced/${organization}_${account}/pdf/SKILL.md`), contents('Pdf'));
  await write(path.join(claude, 'skills/synced/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee_ffffffff-0000-1111-2222-333333333333/pdf/SKILL.md'), contents('OldAccountPdf'));
  await write(path.join(home, '.agents/skills/shared/SKILL.md'), contents('Shared'));
  await fs.symlink(path.join(home, '.agents/skills/shared'), path.join(claude, 'skills', 'shared'), process.platform === 'win32' ? 'junction' : 'dir');
  const library = await listSkillLibrary();
  expect(library.skills.map(skill => `${skill.name}:${skill.source}`).sort()).toEqual(['Pdf:claude-home', 'Shared:user-agents']);
  expect(library.errors).toEqual([]);
});

it('shares the bounded Skills index across sources and writes each folder once', () => {
  // Measured on a real Mac (2026-10-05): 21 ~/.agents and 5 Codex Skills filled the index first,
  // and all 66 Claude Skills, plugin and synced, were left out.
  const skill = (source: LibrarySkill['source'], folder: string, name: string, implicit = true): LibrarySkill => ({
    id: `${name}--${source}`, name, description: `${name} does one careful thing well, with checks before and after every single step it takes.`,
    path: `${folder}/${name}/SKILL.md`, scope: source === 'managed' ? 'managed' : 'user', source, managed: source === 'managed', allowImplicitInvocation: implicit });
  const plugin = '/user-skills/claude/plugins/cache/claude-plugins-official/superpowers/6.4.1/skills';
  const synced = '/user-skills/claude/skills/synced/26cc62c5-fb37-4985-a89b-dfd98481eecc_94f9fd01-b3be-4e08-804b-418e3fd927f7';
  const skills = [
    skill('managed', '/skills', 'clear-writing'),
    ...Array.from({ length: 21 }, (_, index) => skill('user-agents', '/user-skills/agents/skills', `agents-${index}`)),
    ...Array.from({ length: 5 }, (_, index) => skill('codex-home', '/user-skills/codex/skills', `codex-${index}`)),
    ...Array.from({ length: 40 }, (_, index) => skill('claude-plugin', plugin, `plugin-${index}`)),
    ...Array.from({ length: 26 }, (_, index) => skill('claude-home', synced, `synced-${index}`)),
    skill('claude-plugin', plugin, 'hidden-helper', false)
  ];
  const text = skillLibraryInstructions({ skills, errors: [], roots: [], includeInstructions: true });
  const listed = skills.filter(entry => text.includes(`/${entry.id}`));
  expect(text.length).toBeLessThanOrEqual(2000 * 4 + 400);
  expect(listed.length).toBeGreaterThanOrEqual(45);
  for (const source of ['managed', 'user-agents', 'codex-home', 'claude-plugin', 'claude-home'] as const)
    expect(listed.some(entry => entry.source === source), source).toBe(true);
  expect(text).not.toContain('hidden-helper');
  // Long shared folders appear once, as a heading the rows complete.
  expect(text.split(plugin).length - 1).toBe(1);
  expect(text.split(synced).length - 1).toBe(1);
  expect(text).toContain(`${skills.length - 1 - listed.length} more Skills are installed`);
  expect(text).toMatch(/pick (?:any of )?them with \//);
});
