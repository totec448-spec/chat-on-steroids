import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  importSkillFile,
  initSkillsPath,
  listSkills,
  readSkill,
  skillCatalogInstructions,
  skillsDirectory
} from '../src/main/skills.js';
import { MAX_SKILL_BYTES, MAX_SKILLS } from '../src/shared/skills.js';

let userData = '';
let sources = '';

beforeEach(async () => {
  userData = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cos-skills-')));
  sources = path.join(userData, 'sources');
  await fs.mkdir(sources);
  await initSkillsPath(userData);
});

afterEach(async () => {
  if (userData) await fs.rm(userData, { recursive: true, force: true });
});

async function sourceFile(relative: string, contents: string | Buffer): Promise<string> {
  const filename = path.join(sources, relative);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, contents);
  return filename;
}

describe('managed Skills store', () => {
  it('starts empty and publishes only the managed path contract', async () => {
    expect(skillsDirectory()).toBe(path.join(userData, 'skills'));
    expect(await listSkills()).toEqual([]);
    const instructions = skillCatalogInstructions();
    expect(instructions).toContain('# Installed skills');
    expect(instructions).toContain(JSON.stringify(path.join(userData, 'skills')));
    expect(instructions).toContain('No skills are installed');
    expect(instructions).toContain('existing filesystem and command capabilities');
  });

  it('imports exact text exclusively and uses simple inert frontmatter metadata', async () => {
    const text = [
      '---',
      'name: Doubt Driven Development',
      'description: Challenge assumptions before implementing.',
      'license: MIT',
      '---',
      '# Fallback title',
      '',
      'Fallback description.',
      '',
      '## Procedure',
      'Use the entire file.'
    ].join('\r\n');
    const source = await sourceFile(path.join('doubt-driven-development', 'SKILL.md'), text);
    const summary = await importSkillFile(source);
    expect(summary).toEqual({
      id: 'doubt-driven-development',
      name: 'Doubt Driven Development',
      description: 'Challenge assumptions before implementing.',
      path: '/skills/doubt-driven-development/SKILL.md'
    });
    expect(await listSkills()).toEqual([summary]);
    expect(await readSkill(summary.id)).toEqual({ summary, text });
    expect(await fs.readFile(path.join(userData, 'skills', summary.id, 'SKILL.md'), 'utf8')).toBe(text);
    const advertised = skillCatalogInstructions();
    expect(advertised).toContain(JSON.stringify(summary));
    expect(advertised).not.toContain('Use the entire file');
    expect(advertised).toContain(JSON.stringify(path.join(userData, 'skills')));
  });

  it('falls back to heading and prose when relevant frontmatter is not simple scalar metadata', async () => {
    const source = await sourceFile('review.md', [
      '---',
      'name: [not, a, scalar]',
      'description: |',
      '  hidden multiline metadata',
      '---',
      '# Evidence Review',
      '',
      'Read the evidence before changing code.',
      'Keep exact ownership.'
    ].join('\n'));
    expect(await importSkillFile(source)).toEqual({
      id: 'review',
      name: 'Evidence Review',
      description: 'Read the evidence before changing code. Keep exact ownership.',
      path: '/skills/review/SKILL.md'
    });
  });

  it('derives a stable ID from a plain text filename and refuses duplicate publication', async () => {
    const one = await sourceFile('My useful skill.md', 'Plain instructions without a heading.\nContinue here.');
    const two = await sourceFile('my-useful-skill.md', '# Replacement\n\nMust not replace the first file.');
    expect((await importSkillFile(one)).id).toBe('my-useful-skill');
    await expect(importSkillFile(two)).rejects.toThrow(/already exists/i);
    expect(await listSkills()).toHaveLength(1);
    expect((await readSkill('my-useful-skill')).text).toBe('Plain instructions without a heading.\nContinue here.');
  });

  it('serializes concurrent imports so an ID is published exactly once', async () => {
    const source = await sourceFile('same.md', '# Same\n\nOne copy.');
    const results = await Promise.allSettled([importSkillFile(source), importSkillFile(source)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await listSkills()).toHaveLength(1);
    expect(await fs.readdir(path.join(userData, 'skills'))).toEqual(['same']);
  });

  it('rejects binary, NUL, oversized, invalid source and reserved IDs without residue', async () => {
    const binary = await sourceFile('binary.md', Buffer.from([0xff, 0xfe, 0xfd]));
    const nul = await sourceFile('zero.md', 'before\0after');
    const oversized = await sourceFile('large.md', Buffer.alloc(MAX_SKILL_BYTES + 1, 0x61));
    const tooManyCharacters = await sourceFile('characters.md', 'a'.repeat(96_001));
    const invalid = await sourceFile('...md', 'text');
    const prompt = await sourceFile('prompt.md', 'reserved alias');
    const windows = await sourceFile('con.md', 'reserved device');
    const windowsExt = await sourceFile('LPT1.notes.md', 'reserved device with extension');
    const folder = path.join(sources, 'folder.md');
    await fs.mkdir(folder);
    await expect(importSkillFile(binary)).rejects.toThrow(/UTF-8 text/i);
    await expect(importSkillFile(nul)).rejects.toThrow(/text/i);
    await expect(importSkillFile(oversized)).rejects.toThrow(/128,000 bytes/i);
    await expect(importSkillFile(tooManyCharacters)).rejects.toThrow(/96,000 characters/i);
    await expect(importSkillFile(invalid)).rejects.toThrow(/skill id/i);
    await expect(importSkillFile(prompt)).rejects.toThrow(/reserved/i);
    await expect(importSkillFile(windows)).rejects.toThrow(/reserved/i);
    await expect(importSkillFile(windowsExt)).rejects.toThrow(/reserved/i);
    await expect(importSkillFile(folder)).rejects.toThrow(/file/i);
    expect(await listSkills()).toEqual([]);
    expect(await fs.readdir(path.join(userData, 'skills'))).toEqual([]);
  });

  it('discovers complete direct files while ignoring links, temp files and unrelated layouts', async () => {
    const root = path.join(userData, 'skills');
    await fs.mkdir(path.join(root, 'external'));
    await fs.writeFile(path.join(root, 'external', 'SKILL.md'), '# External\n\nFound on the next scan.');
    await fs.writeFile(path.join(root, 'loose.md'), '# Loose');
    await fs.mkdir(path.join(root, '.import-stale'));
    await fs.mkdir(path.join(root, 'nested'));
    await fs.mkdir(path.join(root, 'nested', 'deeper'));
    await fs.writeFile(path.join(root, 'nested', 'deeper', 'SKILL.md'), '# Too deep');
    const outsideDirectory = path.join(sources, 'linked-source');
    await fs.mkdir(outsideDirectory);
    await fs.writeFile(path.join(outsideDirectory, 'SKILL.md'), '# Outside\n\nMust not follow a link.');
    await fs.symlink(outsideDirectory, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await listSkills()).toEqual([{
      id: 'external',
      name: 'External',
      description: 'Found on the next scan.',
      path: '/skills/external/SKILL.md'
    }]);
    await expect(readSkill('nested')).rejects.toThrow(/not found/i);
  });

  it('fails closed instead of silently omitting a valid 65th skill', async () => {
    const root = path.join(userData, 'skills');
    for (let index = 0; index <= MAX_SKILLS; index++) {
      const id = `skill-${String(index).padStart(2, '0')}`;
      await fs.mkdir(path.join(root, id));
      await fs.writeFile(path.join(root, id, 'SKILL.md'), `# ${id}\n\nInstruction ${index}.`);
    }
    await expect(listSkills()).rejects.toThrow(/64 skills/i);
  });

  it('bounds unrelated directory enumeration instead of scanning an arbitrary library', async () => {
    const root = path.join(userData, 'skills');
    await Promise.all(Array.from({ length: 257 }, (_, index) =>
      fs.writeFile(path.join(root, `.unrelated-${String(index).padStart(3, '0')}`), 'x')));
    await expect(listSkills()).rejects.toThrow(/too many entries/i);
  });

  it('rejects an app-managed root redirected through a symlink', async () => {
    const otherUserData = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-skills-link-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-skills-outside-'));
    try {
      await fs.symlink(outside, path.join(otherUserData, 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
      await expect(initSkillsPath(otherUserData)).rejects.toThrow(/managed skills folder/i);
    } finally {
      await initSkillsPath(userData);
      await fs.rm(otherUserData, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
