import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, removeTempDir } from './helpers.js';
import { defaultConfig, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initSkillsPath, importSkillPackage, listSkills, removeSkill } from '../src/main/skills.js';
import { listSkillLibrary, readLibrarySkill, skillLibraryInstructions } from '../src/main/skill-library.js';

let root: string, project: string;
const contents = (name: string, body = 'Keep all instructions.') => `---\nname: ${name}\ndescription: >-\n  Check the source\n  before editing.\n---\n${body}`;
async function write(file: string, text: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text);
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

it('never discovers unapproved global files or follows a project package link out of scope', async () => {
  await write(path.join(root, 'home/.agents/skills/private/SKILL.md'), contents('Private'));
  await saveConfig({ ...getConfig(), roots: [{ name: 'project', path: project }] });
  const location = path.join(project, '.agents/skills'); await fs.mkdir(location, { recursive: true });
  await fs.symlink(path.join(root, 'home/.agents/skills/private'), path.join(location, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const library = await listSkillLibrary({ projectPath: project });
  expect(library.skills).toEqual([]);
  expect(library.errors.join(' ')).toContain('linked');
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
