import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  importSkillFile,
  initSkills,
  isSafeSkillId,
  listSkills,
  MAX_SKILL_BYTES,
  MAX_SKILL_DIRECTORY_ENTRIES,
  readSkill,
  removeSkill,
  skillsDirectory,
} from '../src/main/skills.js';
import { DIR_LINK, makeTempDir, removeTempDir } from './helpers.js';

let root: string;

beforeEach(async () => {
  root = await makeTempDir('cos-skills-');
  await initSkills(root);
});

afterEach(async () => {
  await removeTempDir(root);
});

it('initializes an empty library with no builtin skills', async () => {
  expect(skillsDirectory()).toBe(path.join(root, 'skills'));
  expect(await fs.readdir(path.join(root, 'skills'))).toEqual([]);
  expect(await listSkills()).toEqual({ directory: path.join(root, 'skills'), skills: [], errors: [] });
});

it('imports, parses and rereads quoted and folded frontmatter without executing metadata', async () => {
  const source = path.join(root, 'selected.md');
  const text = [
    '---',
    'name: "Deploy Notes"',
    'description: >-',
    '  Safe guidance for',
    '  release checks.',
    'hook: $(Write-Output should-never-run)',
    '---',
    '# Instructions',
    'Run the checks described here.',
    '',
  ].join('\n');
  await fs.writeFile(source, text, 'utf8');

  expect(await importSkillFile(source)).toEqual({
    id: 'deploy-notes',
    name: 'Deploy Notes',
    description: 'Safe guidance for release checks.',
  });
  expect(await readSkill('deploy-notes')).toEqual({
    id: 'deploy-notes',
    name: 'Deploy Notes',
    description: 'Safe guidance for release checks.',
    text,
  });
  expect((await listSkills()).skills).toEqual([
    { id: 'deploy-notes', name: 'Deploy Notes', description: 'Safe guidance for release checks.' },
  ]);
});

it('accepts plain Markdown/text, persists source-name fallback, and keeps the selected text whole', async () => {
  const markdown = path.join(root, 'guide.md');
  await fs.writeFile(markdown, '# Better Guide\n\nDo this carefully.\n', 'utf8');
  expect(await importSkillFile(markdown)).toEqual({ id: 'better-guide', name: 'Better Guide', description: 'Do this carefully.' });
  expect((await readSkill('better-guide')).text).toBe('# Better Guide\n\nDo this carefully.\n');

  const plain = path.join(root, 'My Plain Skill.txt');
  const original = 'Use this exact instruction text.\nSecond line stays here.\n';
  await fs.writeFile(plain, original, 'utf8');
  expect(await importSkillFile(plain)).toEqual({
    id: 'my-plain-skill',
    name: 'My Plain Skill',
    description: 'Use this exact instruction text. Second line stays here.',
  });
  const installed = await readSkill('my-plain-skill');
  expect(installed.name).toBe('My Plain Skill');
  expect(installed.text).toContain(original);
  expect(installed.text.endsWith(original)).toBe(true);
});

it('refreshes directly from disk and refuses collisions instead of overwriting', async () => {
  const skillDir = path.join(root, 'skills', 'disk-skill');
  await fs.mkdir(skillDir);
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: Disk Skill\ndescription: Fresh from disk\n---\nBody\n');
  expect((await listSkills()).skills).toEqual([
    { id: 'disk-skill', name: 'Disk Skill', description: 'Fresh from disk' },
  ]);

  const source = path.join(root, 'Disk Skill.md');
  await fs.writeFile(source, '# Disk Skill\nreplacement');
  await expect(importSkillFile(source)).rejects.toThrow(/already exists/);
  expect((await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8'))).toContain('Fresh from disk');
});

it('reserves safe ids and rejects binary, invalid UTF-8 and oversized imports', async () => {
  expect(isSafeSkillId('good-skill')).toBe(true);
  expect(isSafeSkillId('prompt')).toBe(false);
  expect(isSafeSkillId('../escape')).toBe(false);
  expect(isSafeSkillId('CON')).toBe(false);

  const reserved = path.join(root, 'prompt.md');
  await fs.writeFile(reserved, '# prompt\n');
  await expect(importSkillFile(reserved)).rejects.toThrow(/safe skill id/);

  const binary = path.join(root, 'binary.md');
  await fs.writeFile(binary, Buffer.from([0x23, 0x20, 0x78, 0x0a, 0x00, 0x01]));
  await expect(importSkillFile(binary)).rejects.toThrow(/binary|control/);

  const invalidUtf8 = path.join(root, 'invalid.md');
  await fs.writeFile(invalidUtf8, Buffer.from([0x23, 0x20, 0x78, 0x0a, 0xc3, 0x28]));
  await expect(importSkillFile(invalidUtf8)).rejects.toThrow(/UTF-8/);

  const oversized = path.join(root, 'large.md');
  await fs.writeFile(oversized, Buffer.alloc(MAX_SKILL_BYTES + 1, 0x61));
  await expect(importSkillFile(oversized)).rejects.toThrow(/exceeds/);
});

it('reports malformed on-disk skills instead of silently losing them', async () => {
  const invalid = path.join(root, 'skills', 'Bad Name');
  const missing = path.join(root, 'skills', 'missing-file');
  const binary = path.join(root, 'skills', 'binary-skill');
  await fs.mkdir(invalid);
  await fs.mkdir(missing);
  await fs.mkdir(binary);
  await fs.writeFile(path.join(binary, 'SKILL.md'), Buffer.from([0x00, 0x01]));

  const library = await listSkills();
  expect(library.skills).toEqual([]);
  expect(library.errors.join('\n')).toMatch(/Bad Name/);
  expect(library.errors.join('\n')).toMatch(/missing SKILL\.md/);
  expect(library.errors.join('\n')).toMatch(/binary|control/);
});

it('rejects a skill directory link that escapes the managed library for list, read and remove', async () => {
  const outside = path.join(root, 'outside-skill');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'SKILL.md'), '# Outside\n');
  const linked = path.join(root, 'skills', 'linked-skill');
  await fs.symlink(outside, linked, DIR_LINK);

  expect((await listSkills()).errors.join('\n')).toMatch(/linked-skill.*unsafe/i);
  await expect(readSkill('linked-skill')).rejects.toThrow(/unsafe/);
  await expect(removeSkill('linked-skill')).rejects.toThrow(/unsafe/);
  expect(await fs.readFile(path.join(outside, 'SKILL.md'), 'utf8')).toBe('# Outside\n');
});

it('keeps the initialized directory path pinned but rejects a later root link replacement', async () => {
  const directory = path.join(root, 'skills');
  const original = path.join(root, 'skills-original');
  const replacement = path.join(root, 'replacement');
  await fs.rename(directory, original);
  await fs.mkdir(replacement);
  await fs.symlink(replacement, directory, DIR_LINK);

  expect(skillsDirectory()).toBe(directory);
  expect((await listSkills()).errors.join('\n')).toMatch(/directory is unsafe|changed on disk/i);
  await expect(readSkill('anything')).rejects.toThrow(/directory is unsafe|changed on disk/i);
});

it('removes only SKILL.md and preserves unexpected supporting files', async () => {
  const directory = path.join(root, 'skills', 'with-support');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'SKILL.md'), '# With Support\nMain text\n');
  await fs.writeFile(path.join(directory, 'notes.txt'), 'keep me');

  await removeSkill('with-support');
  await expect(fs.stat(path.join(directory, 'SKILL.md'))).rejects.toThrow();
  expect(await fs.readFile(path.join(directory, 'notes.txt'), 'utf8')).toBe('keep me');
  expect((await listSkills()).errors.join('\n')).toMatch(/with-support.*missing SKILL\.md/i);
});

it('bounds directory enumeration and reports that unscanned entries exist', async () => {
  const directory = path.join(root, 'skills');
  await Promise.all(
    Array.from({ length: MAX_SKILL_DIRECTORY_ENTRIES + 1 }, (_, index) =>
      fs.mkdir(path.join(directory, `entry-${String(index).padStart(4, '0')}`)),
    ),
  );
  const library = await listSkills();
  expect(library.skills).toEqual([]);
  expect(library.errors.join('\n')).toMatch(new RegExp(`more than ${MAX_SKILL_DIRECTORY_ENTRIES} entries`));
});
