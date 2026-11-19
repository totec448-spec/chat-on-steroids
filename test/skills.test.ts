import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  importSkillFile,
  importSkillPackage,
  initSkillsPath,
  listSkills,
  listManagedSkills,
  managedSkillDirectory,
  readSkill,
  readSkillAtRevision,
  removeSkill,
  setManagedSkillEnabled,
  skillCatalogSnapshot,
  skillCatalogInstructions,
  skillsDirectory
} from '../src/main/skills.js';
import { MAX_SKILL_BYTES, MAX_SKILLS } from '../src/shared/skills.js';
import { defaultConfig, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { rawPromises as rawFs } from '../src/main/rawfs.js';
import { RECOMMENDED_SKILLS } from '../src/shared/recommended-skills.js';

let userData = '';
let sources = '';

beforeEach(async () => {
  userData = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cos-skills-')));
  sources = path.join(userData, 'sources');
  await fs.mkdir(sources);
  initConfigPath(userData);
  await saveConfig(defaultConfig());
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
  it('identifies only exact bundled COS recommendations without inventing GitHub sources', async () => {
    const builtin = RECOMMENDED_SKILLS.find(skill => skill.id === 'code-review')!;
    const folder = path.join(sources, 'code-review');
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'SKILL.md'), builtin.markdown);
    await importSkillPackage(folder);
    expect((await listManagedSkills())[0]).toMatchObject({ id: 'code-review', enabled: true, bundled: true, origin: null });
    const localOnly = await sourceFile('local.md', '# Local\n\nCustom');
    await importSkillFile(localOnly);
    expect((await listManagedSkills()).find(skill => skill.id === 'local')).toMatchObject({ bundled: false, origin: null });
  });
  it('persists disabled managed skills without editing contents, excluding both explicit and automatic selection', async () => {
    const source = await sourceFile('review.md', '# Review\n\nSafe steps.');
    await importSkillFile(source);
    const before = skillCatalogSnapshot();
    expect(before).toHaveLength(1);
    expect((await listManagedSkills())[0]).toMatchObject({ id: 'review', enabled: true, origin: null });
    const filename = path.join(userData, 'skills', 'review', 'SKILL.md');
    const original = await fs.readFile(filename);
    await setManagedSkillEnabled('review', false);
    expect((await listManagedSkills())[0]).toMatchObject({ id: 'review', enabled: false, origin: null });
    expect(await listSkills()).toEqual([]);
    expect(skillCatalogSnapshot()).toEqual([]);
    expect(skillCatalogInstructions()).not.toContain('"id":"review"');
    await expect(readSkill('review')).rejects.toThrow(/disabled/i);
    await expect(readSkillAtRevision('review', before[0]!.revision)).rejects.toThrow(/disabled/i);
    expect(await fs.readFile(filename)).toEqual(original);
    const statePath = path.join(userData, 'skills', '.disabled-skills.json');
    expect(JSON.parse(await fs.readFile(statePath, 'utf8'))).toEqual({ version: 1, disabled: ['review'] });
    // Simulate application restart: the disabled decision must not depend on
    // a cached renderer, package file edits or the previously published catalog.
    await initSkillsPath(userData);
    expect((await listManagedSkills())[0]).toMatchObject({ id: 'review', enabled: false });
    expect(skillCatalogSnapshot()).toEqual([]);
    await expect(setManagedSkillEnabled('../review', true)).rejects.toThrow(/skill id/i);
    await expect(setManagedSkillEnabled('missing', false)).rejects.toThrow(/no longer installed/i);
    await setManagedSkillEnabled('review', true);
    expect((await listManagedSkills())[0]).toMatchObject({ id: 'review', enabled: true });
    expect(await listSkills()).toHaveLength(1);
    expect((await readSkill('review')).text).toBe('# Review\n\nSafe steps.');
    expect(JSON.parse(await fs.readFile(statePath, 'utf8'))).toEqual({ version: 1, disabled: [] });
  });

  it('refuses an unsafe persisted state instead of silently re-enabling disabled Skills', async () => {
    const source = await sourceFile('review.md', '# Review');
    await importSkillFile(source);
    const stateFile = path.join(userData, 'skills', '.disabled-skills.json');
    await fs.writeFile(stateFile, JSON.stringify({ version: 1, disabled: ['../review'] }));
    await expect(initSkillsPath(userData)).rejects.toThrow(/enablement is invalid/i);
  });

  it('drops a disabled Skill from the published catalog even if the post-toggle scan fails', async () => {
    const source = await sourceFile('review.md', '# Review');
    await importSkillFile(source);
    const rename = rawFs.rename.bind(rawFs);
    const opendir = rawFs.opendir.bind(rawFs);
    let committed = false;
    const write = vi.spyOn(rawFs, 'rename').mockImplementation((async (from: Parameters<typeof rawFs.rename>[0], to: Parameters<typeof rawFs.rename>[1]) => {
      const result = await rename(from, to);
      if (String(to).endsWith('.disabled-skills.json')) committed = true;
      return result;
    }) as typeof rawFs.rename);
    const scan = vi.spyOn(rawFs, 'opendir').mockImplementation((async (...args: Parameters<typeof rawFs.opendir>) => {
      if (committed) throw new Error('scan-failed');
      return opendir(...args);
    }) as typeof rawFs.opendir);
    try {
      await expect(setManagedSkillEnabled('review', false)).rejects.toThrow('scan-failed');
      expect(skillCatalogSnapshot()).toEqual([]);
    } finally { write.mockRestore(); scan.mockRestore(); }
    expect((await listManagedSkills())[0]).toMatchObject({ id: 'review', enabled: false });
  });

  it('removes stale disabled state when a disabled package is uninstalled and reimported', async () => {
    const source = await sourceFile('review.md', '# Review\n\nMethod.');
    await importSkillFile(source);
    await setManagedSkillEnabled('review', false);
    await removeSkill('review', directory => fs.rename(directory, path.join(userData, 'trashed-review')));
    expect(JSON.parse(await fs.readFile(path.join(userData, 'skills', '.disabled-skills.json'), 'utf8')))
      .toEqual({ version: 1, disabled: [] });
    await importSkillFile(source);
    expect((await listManagedSkills())[0]).toMatchObject({ id: 'review', enabled: true });
    expect(await listSkills()).toHaveLength(1);
  });

  it('reconciles an orphaned disabled ID on import after removal was interrupted', async () => {
    const source = await sourceFile('review.md', '# Review');
    await importSkillFile(source);
    await setManagedSkillEnabled('review', false);
    const state = path.join(userData, 'skills', '.disabled-skills.json');
    await expect(removeSkill('review', async () => { throw new Error('trash failed'); })).rejects.toThrow('trash failed');
    expect((await listManagedSkills())[0]).toMatchObject({ id: 'review', enabled: false });
    expect(JSON.parse(await fs.readFile(state, 'utf8')).disabled).toEqual(['review']);

    // Simulate a crash after moving the folder to Trash, before clearing its toggle.
    await fs.rename(path.join(userData, 'skills', 'review'), path.join(userData, 'trashed-review'));
    await initSkillsPath(userData);
    expect(await listSkills()).toEqual([]);
    await importSkillFile(source);
    expect((await listManagedSkills())[0]).toMatchObject({ id: 'review', enabled: true });
    expect(JSON.parse(await fs.readFile(state, 'utf8')).disabled).toEqual([]);
  });

  it('recovers after Trash succeeds but writing the disabled-state file fails', async () => {
    const source = await sourceFile('review.md', '# Review');
    await importSkillFile(source);
    await setManagedSkillEnabled('review', false);
    const rename = rawFs.rename.bind(rawFs);
    const spy = vi.spyOn(rawFs, 'rename').mockImplementation((async (from: Parameters<typeof rawFs.rename>[0], to: Parameters<typeof rawFs.rename>[1]) => {
      if (String(from).includes('.skill-state-') && String(to).endsWith('.disabled-skills.json'))
        throw new Error('state-write-failed');
      return rename(from, to);
    }) as typeof rawFs.rename);
    try {
      await expect(removeSkill('review', directory => fs.rename(directory, path.join(userData, 'trashed-review'))))
        .rejects.toThrow('state-write-failed');
      expect(JSON.parse(await fs.readFile(path.join(userData, 'skills', '.disabled-skills.json'), 'utf8')).disabled).toEqual(['review']);
    } finally { spy.mockRestore(); }
    // A restart following the interrupted post-Trash state write must recover
    // the orphan, without requiring the old ID to be reimported first.
    await initSkillsPath(userData);
    expect(JSON.parse(await fs.readFile(path.join(userData, 'skills', '.disabled-skills.json'), 'utf8')).disabled).toEqual([]);
    await importSkillFile(source);
    expect((await listManagedSkills())[0]).toMatchObject({ id: 'review', enabled: true });
  });

  it('reconciles 128 orphaned disabled IDs before a count-bound toggle and import', async () => {
    const managed = path.join(userData, 'skills');
    const ids = Array.from({ length: MAX_SKILLS }, (_, index) => `old-${String(index).padStart(3, '0')}`);
    // Simulate a valid saturated disabled state from which Trash moved packages,
    // but writing the cleared state failed. The on-disk state is not corrupt.
    for (const id of ids) {
      const directory = path.join(managed, id);
      await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, 'SKILL.md'), `# ${id}\n\nOld skill.`);
    }
    await fs.writeFile(path.join(managed, '.disabled-skills.json'), JSON.stringify({ version: 1, disabled: ids }));
    await initSkillsPath(userData);
    for (const id of ids) await fs.rm(path.join(managed, id), { recursive: true });
    const review = await sourceFile('review.md', '# Review\n\nNew skill.');
    await importSkillFile(review);
    await setManagedSkillEnabled('review', false);
    expect(JSON.parse(await fs.readFile(path.join(managed, '.disabled-skills.json'), 'utf8')).disabled).toEqual(['review']);
    expect((await listManagedSkills())[0]).toMatchObject({ id: 'review', enabled: false });
    await initSkillsPath(userData);
    expect((await listManagedSkills())[0]).toMatchObject({ id: 'review', enabled: false });
  }, 30_000);

  it('starts empty and publishes only the managed path contract', async () => {
    expect(skillsDirectory()).toBe(path.join(userData, 'skills'));
    expect(await listSkills()).toEqual([]);
    const instructions = skillCatalogInstructions();
    expect(instructions).toContain('# Installed skills');
    expect(instructions).toContain(JSON.stringify(path.join(userData, 'skills')));
    expect(instructions).toContain('No skills are installed');
    expect(instructions).toContain('Install or maintain requested skills with the file and command tools.');
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
    expect(advertised).toContain(JSON.stringify({ id: summary.id, name: summary.name, description: summary.description }));
    expect(advertised).not.toContain(JSON.stringify(summary.path));
    expect(advertised).not.toContain('Use the entire file');
    expect(advertised).toContain(JSON.stringify(path.join(userData, 'skills')));
  });

  it('opens only an installed, valid managed Skill directory', async () => {
    const source = await sourceFile('review.md', '# Review\n\nMethod.');
    await importSkillFile(source);
    expect(await managedSkillDirectory('review')).toBe(path.join(userData, 'skills', 'review'));
    await expect(managedSkillDirectory('../sources')).rejects.toThrow(/skill id/i);
    await expect(managedSkillDirectory('missing')).rejects.toThrow(/not found/i);
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

  it.each(['>-', '|', '>+', '|-'])('publishes bounded YAML %s descriptions instead of body fallback', async scalar => {
    const text = [
      '\uFEFF---',
      'name: Code Review',
      `description: ${scalar}`,
      '  Review source code',
      '  for correctness and maintainability.',
      '...',
      '# A different body title',
      '',
      'BODY_ONLY_MUST_NOT_REPLACE_METADATA'
    ].join('\r\n');
    const source = await sourceFile('code-review.md', text);
    const summary = await importSkillFile(source);
    expect(summary).toMatchObject({
      id: 'code-review', name: 'Code Review',
      description: 'Review source code for correctness and maintainability.'
    });
    expect(skillCatalogInstructions()).toContain(JSON.stringify({ id: summary.id, name: summary.name, description: summary.description }));
    expect(skillCatalogInstructions()).not.toContain('BODY_ONLY_MUST_NOT_REPLACE_METADATA');
    // Rebuilding the published catalog uses the same parsed metadata. The text decoder
    // already strips a BOM; the stored source bytes still retain it and the original CRLF.
    await initSkillsPath(userData);
    expect(await listSkills()).toEqual([summary]);
    expect((await readSkill(summary.id)).text).toBe(text.replace(/^\uFEFF/, ''));
    expect(await fs.readFile(path.join(userData, 'skills', summary.id, 'SKILL.md'), 'utf8')).toBe(text);
  });

  it('keeps legacy fallback for invalid YAML rather than evaluating tags or adopting duplicate values', async () => {
    const source = await sourceFile('invalid.md', [
      '---', 'name: First', 'name: Second', 'description: !!js/function value', '---',
      '# Legacy title', '', 'Safe fallback prose.'
    ].join('\n'));
    expect(await importSkillFile(source)).toMatchObject({ name: 'Legacy title', description: 'Safe fallback prose.' });
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

  it('discovers a linked package only while its target belongs to an approved root', async () => {
    const approved = path.join(userData, 'approved');
    const packageDirectory = path.join(approved, 'shared-review');
    await fs.mkdir(path.join(packageDirectory, 'references'), { recursive: true });
    await fs.writeFile(path.join(packageDirectory, 'SKILL.md'), '# Shared review\n\nRead the linked package.');
    await fs.writeFile(path.join(packageDirectory, 'references', 'notes.md'), 'Package resource.');
    await fs.symlink(packageDirectory, path.join(userData, 'skills', 'shared-review'), process.platform === 'win32' ? 'junction' : 'dir');

    expect(await listSkills()).toEqual([]);
    const previous = getConfig();
    await saveConfig({ ...previous, roots: [{ name: 'approved', path: approved }] });
    try {
      expect(await listSkills()).toEqual([{
        id: 'shared-review',
        name: 'Shared review',
        description: 'Read the linked package.',
        path: '/skills/shared-review/SKILL.md'
      }]);
      expect((await readSkill('shared-review')).text).toContain('Read the linked package.');
      expect(await managedSkillDirectory('shared-review')).toBe(await fs.realpath(packageDirectory));
      const readDisabled = { ...getConfig(), capabilities: { ...getConfig().capabilities, read: false } };
      await saveConfig(readDisabled);
      expect(await listSkills()).toEqual([]);
      await expect(readSkill('shared-review')).rejects.toThrow(/not found/i);
      await expect(managedSkillDirectory('shared-review')).rejects.toThrow(/not found|approved/i);
      await saveConfig({ ...readDisabled, capabilities: { ...readDisabled.capabilities, read: true } });
      expect(await listSkills()).toHaveLength(1);
    } finally {
      await saveConfig(previous);
    }
    expect(await listSkills()).toEqual([]);
    await expect(readSkill('shared-review')).rejects.toThrow(/not found/i);
  });

  it('never opens an unapproved target when a linked package is retargeted mid-scan', async () => {
    const approved = path.join(userData, 'approved-race');
    const approvedPackage = path.join(approved, 'race-review');
    const unapprovedPackage = path.join(userData, 'unapproved-race', 'race-review');
    await fs.mkdir(approvedPackage, { recursive: true });
    await fs.mkdir(unapprovedPackage, { recursive: true });
    await fs.writeFile(path.join(approvedPackage, 'SKILL.md'), '# Approved race\n\nSAFE_TEXT');
    await fs.writeFile(path.join(unapprovedPackage, 'SKILL.md'), '# Unapproved race\n\nSECRET_TEXT');
    const link = path.join(userData, 'skills', 'race-review');
    await fs.symlink(approvedPackage, link, process.platform === 'win32' ? 'junction' : 'dir');
    const previous = getConfig();
    await saveConfig({ ...previous, roots: [{ name: 'approved-race', path: approved }] });

    const originalLstat = rawFs.lstat.bind(rawFs);
    const originalOpen = rawFs.open.bind(rawFs);
    const aliasFile = path.resolve(path.join(link, 'SKILL.md'));
    const maliciousFile = path.resolve(path.join(unapprovedPackage, 'SKILL.md'));
    const opened: string[] = [];
    let retargeted = false;
    const lstatSpy = vi.spyOn(rawFs, 'lstat').mockImplementation((async (target: Parameters<typeof rawFs.lstat>[0], ...args: unknown[]) => {
      const candidate = path.resolve(String(target));
      const same = process.platform === 'win32'
        ? candidate.toLowerCase() === aliasFile.toLowerCase()
        : candidate === aliasFile;
      if (!retargeted && same) {
        retargeted = true;
        await fs.unlink(link);
        await fs.symlink(unapprovedPackage, link, process.platform === 'win32' ? 'junction' : 'dir');
      }
      return (originalLstat as (...values: unknown[]) => ReturnType<typeof rawFs.lstat>)(target, ...args);
    }) as typeof rawFs.lstat);
    const openSpy = vi.spyOn(rawFs, 'open').mockImplementation((async (target: Parameters<typeof rawFs.open>[0], ...args: unknown[]) => {
      opened.push(path.resolve(String(target)));
      return (originalOpen as (...values: unknown[]) => ReturnType<typeof rawFs.open>)(target, ...args);
    }) as typeof rawFs.open);
    try {
      const outcome = await listSkills().then(skills => ({ skills }), (error: unknown) => ({ error }));
      // Never, on any platform: the unapproved target is not opened.
      expect(opened.some(file => process.platform === 'win32'
        ? file.toLowerCase() === maliciousFile.toLowerCase()
        : file === maliciousFile)).toBe(false);
      if (retargeted) {
        // The scan followed the link and saw it retargeted: it must refuse, not read through.
        expect('error' in outcome ? String(outcome.error) : '').toMatch(/managed Skills folder changed/i);
      } else {
        // The Windows arm64 release runner did not list the junction-linked package at all
        // (2.1.25 publish, twice, same image and Node as the passing 2.1.24 run). Then the race
        // cannot happen there; the package must simply be absent, never read through the link.
        expect('skills' in outcome ? outcome.skills.map(skill => skill.name) : []).not.toContain('race-review');
      }
    } finally {
      lstatSpy.mockRestore();
      openSpy.mockRestore();
      await saveConfig(previous);
    }
  });

  it('loads a 114-skill managed library without the legacy 64-skill ceiling', async () => {
    const root = path.join(userData, 'skills');
    for (let index = 0; index < 114; index++) {
      const id = `skill-${String(index).padStart(3, '0')}`;
      await fs.mkdir(path.join(root, id));
      await fs.writeFile(path.join(root, id, 'SKILL.md'), `# ${id}\n\nInstruction ${index}.`);
    }
    await expect(listSkills()).resolves.toHaveLength(114);
  });

  it('bounds connector Skill catalog instructions with 128 maximum-description skills', async () => {
    const root = path.join(userData, 'skills');
    const description = 'x'.repeat(240);
    for (let index = 0; index < MAX_SKILLS; index++) {
      const id = `skill-${String(index).padStart(3, '0')}`;
      await fs.mkdir(path.join(root, id));
      await fs.writeFile(path.join(root, id, 'SKILL.md'), `---\nname: ${id}\ndescription: ${description}\n---\n`);
    }
    await expect(listSkills()).resolves.toHaveLength(MAX_SKILLS);
    const instructions = skillCatalogInstructions();
    expect(instructions.length).toBeLessThan(8_000);
    expect(instructions).toMatch(/more skills are installed; read \/skills to list them\./);
  });

  it('rejects file and package imports beyond 128 with the translated limit key', async () => {
    const root = path.join(userData, 'skills');
    for (let index = 0; index < MAX_SKILLS; index++) {
      const id = `skill-${String(index).padStart(3, '0')}`;
      await fs.mkdir(path.join(root, id));
      await fs.writeFile(path.join(root, id, 'SKILL.md'), `# ${id}\n\nInstruction ${index}.`);
    }
    await expect(listSkills()).resolves.toHaveLength(MAX_SKILLS);

    const limitError = 'The Skills library supports at most 128 skills';
    const file = await sourceFile('overflow-file.md', '# Overflow file\n\nMust not be imported.');
    await expect(importSkillFile(file)).rejects.toThrow(limitError);

    const packageRoot = path.join(sources, 'overflow-package');
    await fs.mkdir(packageRoot);
    await fs.writeFile(path.join(packageRoot, 'SKILL.md'), [
      '---', 'name: Overflow Package', 'description: Must not be imported.', '---', '', 'Body.'
    ].join('\n'));
    await expect(importSkillPackage(packageRoot)).rejects.toThrow(limitError);
  });

  it('reserves disabled slots for damaged installed folders when importing either source type', async () => {
    const managed = path.join(userData, 'skills');
    const ids = Array.from({ length: MAX_SKILLS }, (_, index) => `reserved-${String(index).padStart(3, '0')}`);
    for (const id of ids) {
      const directory = path.join(managed, id);
      await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, 'SKILL.md'), `# ${id}\n\nInstructions.`);
    }
    await fs.writeFile(path.join(managed, '.disabled-skills.json'), JSON.stringify({ version: 1, disabled: ids }));
    await initSkillsPath(userData);
    // The directory still owns the disabled ID, although scan() ignores its
    // missing document. Reconciliation must NOT erase this installed slot.
    await fs.unlink(path.join(managed, ids[0]!, 'SKILL.md'));
    expect(await listManagedSkills()).toHaveLength(MAX_SKILLS - 1);
    const extraFile = await sourceFile('extra.md', '# Extra\n\nMust be refused.');
    await expect(importSkillFile(extraFile)).rejects.toThrow('The Skills library supports at most 128 skills');
    const extraPackage = path.join(sources, 'extra-package');
    await fs.mkdir(extraPackage);
    await fs.writeFile(path.join(extraPackage, 'SKILL.md'), '---\nname: Extra Package\ndescription: Must be refused.\n---\n\nInstructions.');
    await expect(importSkillPackage(extraPackage)).rejects.toThrow('The Skills library supports at most 128 skills');
    expect(JSON.parse(await fs.readFile(path.join(managed, '.disabled-skills.json'), 'utf8')).disabled).toEqual(ids);
    expect(await listManagedSkills()).toHaveLength(MAX_SKILLS - 1);
  }, 30_000);

  it('fails closed instead of silently omitting a valid over-cap skill', async () => {
    const root = path.join(userData, 'skills');
    for (let index = 0; index <= MAX_SKILLS; index++) {
      const id = `skill-${String(index).padStart(2, '0')}`;
      await fs.mkdir(path.join(root, id));
      await fs.writeFile(path.join(root, id, 'SKILL.md'), `# ${id}\n\nInstruction ${index}.`);
    }
    await expect(listSkills()).rejects.toThrow(/128 skills/i);
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
