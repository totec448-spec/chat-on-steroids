import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { defaultConfig, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { addProject } from '../src/main/projects.js';
import {
  createProjectEntry,
  listProjectDirectory,
  previewProjectFile,
  projectFileTarget,
  renameProjectEntry,
  saveProjectTextFile
} from '../src/main/project-files.js';
import { validateNewRoot } from '../src/main/sandbox.js';
import { ProjectFileWatchSet } from '../src/main/project-file-watcher.js';

let directory: string;
let approved: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-project-files-'));
  approved = path.join(directory, 'approved');
  await fs.mkdir(path.join(approved, 'project', 'src'), { recursive: true });
  await fs.mkdir(path.join(approved, 'sibling'));
  approved = await validateNewRoot(approved, []);
  initConfigPath(directory);
  initDurableStore(directory);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: approved }] });
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

it('lists exactly one project level at a time and previews bounded text', async () => {
  const projectPath = path.join(approved, 'project');
  await fs.writeFile(path.join(projectPath, 'README.md'), '# hello\nworld\n');
  await fs.writeFile(path.join(projectPath, 'src', 'main.ts'), 'export const value = 1;\n');
  const project = await addProject(projectPath);

  const root = await listProjectDirectory(project.id);
  expect(root.projectName).toBe('project');
  expect(root.entries.map(entry => [entry.path, entry.kind])).toEqual([
    ['src', 'directory'],
    ['README.md', 'file']
  ]);
  expect(root.entries.some(entry => entry.path === 'src/main.ts')).toBe(false);

  const nested = await listProjectDirectory(project.id, 'src');
  expect(nested.entries.map(entry => entry.path)).toEqual(['src/main.ts']);
  const preview = await previewProjectFile(project.id, 'README.md');
  expect(preview).toMatchObject({ path: 'README.md', binary: false, text: '# hello\nworld\n', truncated: false });

  await fs.writeFile(path.join(projectPath, 'large.txt'), 'x'.repeat(300 * 1024));
  const large = await previewProjectFile(project.id, 'large.txt');
  expect(large.text).toBeNull();
  expect(large.truncated).toBe(true);
  expect(large.note).toMatch(/too large/i);
});

it('reports binary files without decoding them into the renderer', async () => {
  const projectPath = path.join(approved, 'project');
  await fs.writeFile(path.join(projectPath, 'blob.bin'), Buffer.from([0, 1, 2, 3, 4]));
  const project = await addProject(projectPath);
  await expect(previewProjectFile(project.id, 'blob.bin')).resolves.toMatchObject({
    path: 'blob.bin',
    binary: true,
    text: null,
    truncated: false
  });
});

it('returns a bounded inline data URL for supported project images and leaves other binaries opaque', async () => {
  const projectPath = path.join(approved, 'project');
  const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: 'white' } }).png().toBuffer();
  await fs.writeFile(path.join(projectPath, 'preview.png'), png);
  await fs.writeFile(path.join(projectPath, 'opaque.bin'), Buffer.from([0, 1, 2, 3]));
  const project = await addProject(projectPath);

  const image = await previewProjectFile(project.id, 'preview.png');
  expect(image).toMatchObject({
    path: 'preview.png',
    binary: true,
    imageMimeType: 'image/png',
    truncated: false
  });
  expect(image.imageDataUrl).toMatch(/^data:image\/png;base64,/);
  expect(await sharp(Buffer.from(image.imageDataUrl!.split(',')[1]!, 'base64')).metadata()).toMatchObject({ width: 4, height: 4 });

  const opaque = await previewProjectFile(project.id, 'opaque.bin');
  expect(opaque.imageDataUrl).toBeUndefined();
  expect(opaque.imageMimeType).toBeUndefined();
});

it('returns bounded PDF bytes for the in-app viewer and rejects misleading .pdf files', async () => {
  const projectPath = path.join(approved, 'project');
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
  await fs.writeFile(path.join(projectPath, 'paper.pdf'), pdf);
  await fs.writeFile(path.join(projectPath, 'fake.pdf'), Buffer.from([0, 1, 2, 3, 4]));
  const project = await addProject(projectPath);

  const preview = await previewProjectFile(project.id, 'paper.pdf');
  expect(preview).toMatchObject({
    path: 'paper.pdf',
    binary: true,
    text: null,
    truncated: false,
    pdfDataBase64: pdf.toString('base64')
  });

  const fake = await previewProjectFile(project.id, 'fake.pdf');
  expect(fake.pdfDataBase64).toBeUndefined();
  expect(fake.note).toMatch(/PDF header/i);
});

it('creates and renames only regular entries below the explicit project root', async () => {
  const projectPath = path.join(approved, 'project');
  const project = await addProject(projectPath);

  await expect(createProjectEntry(project.id, '', 'notes', 'directory')).resolves.toEqual({
    projectId: project.id,
    path: 'notes',
    kind: 'directory'
  });
  await createProjectEntry(project.id, 'notes', 'todo.md', 'file');
  expect(await fs.readFile(path.join(projectPath, 'notes', 'todo.md'), 'utf8')).toBe('');
  await expect(createProjectEntry(project.id, 'notes', 'todo.md', 'file')).rejects.toThrow(/already exists/);

  const renamed = await renameProjectEntry(project.id, 'notes/todo.md', 'done.md');
  expect(renamed).toMatchObject({ path: 'notes/done.md', kind: 'file' });
  await expect(fs.stat(path.join(projectPath, 'notes', 'todo.md'))).rejects.toThrow();
  await expect(fs.stat(path.join(projectPath, 'notes', 'done.md'))).resolves.toBeTruthy();

  await createProjectEntry(project.id, 'notes', 'occupied.md', 'file');
  await expect(renameProjectEntry(project.id, 'notes/done.md', 'occupied.md')).rejects.toThrow(/already exists/);
  await expect(renameProjectEntry(project.id, '', 'renamed-root')).rejects.toThrow(/root/);
});

it('saves bounded text through the project sandbox and returns the new editor revision', async () => {
  const projectPath = path.join(approved, 'project');
  const file = path.join(projectPath, 'src', 'main.ts');
  await fs.writeFile(file, 'export const value = 1;\n');
  const project = await addProject(projectPath);
  const before = await previewProjectFile(project.id, 'src/main.ts');

  const saved = await saveProjectTextFile(
    project.id,
    'src/main.ts',
    'export const value = 2;\n',
    before.modifiedAt,
    before.bytes,
    before.revision!
  );

  expect(await fs.readFile(file, 'utf8')).toBe('export const value = 2;\n');
  expect(saved.preview).toMatchObject({
    path: 'src/main.ts',
    binary: false,
    text: 'export const value = 2;\n',
    truncated: false
  });
  expect(saved.preview.modifiedAt).not.toBe('');
});

it('refuses to overwrite a text file that changed after the editor preview was opened', async () => {
  const projectPath = path.join(approved, 'project');
  const file = path.join(projectPath, 'README.md');
  await fs.writeFile(file, 'first revision\n');
  const project = await addProject(projectPath);
  const before = await previewProjectFile(project.id, 'README.md');

  // Change both content and length so this remains deterministic on filesystems with coarse mtime.
  await fs.writeFile(file, 'external revision is different\n');
  await expect(saveProjectTextFile(
    project.id,
    'README.md',
    'editor revision\n',
    before.modifiedAt,
    before.bytes,
    before.revision!
  )).rejects.toThrow(/changed on disk/i);
  expect(await fs.readFile(file, 'utf8')).toBe('external revision is different\n');
});

it('keeps the original bytes when writing the replacement fails', async () => {
  const projectPath = path.join(approved, 'project');
  const file = path.join(projectPath, 'notes.txt');
  await fs.writeFile(file, 'original text\r\n');
  const project = await addProject(projectPath);
  const before = await previewProjectFile(project.id, 'notes.txt');
  const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[1] === 'r+' || args[1] === 'wx') {
      vi.spyOn(handle, 'writeFile').mockRejectedValue(Object.assign(new Error('Write failed'), { code: 'ENOSPC' }));
    }
    return handle;
  });
  await expect(saveProjectTextFile(project.id, 'notes.txt', 'replacement\r\n', before.modifiedAt, before.bytes, before.revision!)).rejects.toThrow('Write failed');
  expect(await fs.readFile(file, 'utf8')).toBe('original text\r\n');
  expect((await fs.readdir(projectPath)).filter(name => name.includes('.tmp'))).toEqual([]);
});

it('rejects traversal and links that leave the LocalProject even when the target stays approved', async () => {
  const projectPath = path.join(approved, 'project');
  const siblingPath = path.join(approved, 'sibling');
  await fs.writeFile(path.join(siblingPath, 'secret.txt'), 'sibling data');
  const project = await addProject(projectPath);

  await expect(listProjectDirectory(project.id, '../sibling')).rejects.toThrow(/invalid segment/);
  const link = path.join(projectPath, 'linked-sibling');
  await fs.symlink(siblingPath, link, process.platform === 'win32' ? 'junction' : 'dir');
  const root = await listProjectDirectory(project.id);
  expect(root.entries.find(entry => entry.name === 'linked-sibling')?.kind).toBe('other');
  await expect(listProjectDirectory(project.id, 'linked-sibling')).rejects.toThrow(/symbolic links|junctions/);
  await expect(projectFileTarget(project.id, 'linked-sibling/secret.txt')).rejects.toThrow(/symbolic links|junctions/);
});

it('keeps the original bytes when the final replacement cannot be renamed', async () => {
  const projectPath = path.join(approved, 'project');
  const file = path.join(projectPath, 'notes.txt');
  await fs.writeFile(file, '\uFEFForiginal\r\n');
  const project = await addProject(projectPath);
  const before = await previewProjectFile(project.id, 'notes.txt');
  expect(before.text).toBe('\uFEFForiginal\r\n');
  vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('Rename failed'), { code: 'EACCES' }));
  await expect(saveProjectTextFile(project.id, 'notes.txt', 'next\n', before.modifiedAt, before.bytes, before.revision!)).rejects.toThrow('Rename failed');
  expect(await fs.readFile(file, 'utf8')).toBe('\uFEFForiginal\r\n');
  expect((await fs.readdir(projectPath)).some(name => name.endsWith('.tmp'))).toBe(false);
});

it('refuses same-length edits even when the original timestamp is restored', async () => {
  const file = path.join(approved, 'project', 'notes.txt');
  await fs.writeFile(file, 'first');
  const project = await addProject(path.dirname(file));
  const before = await previewProjectFile(project.id, 'notes.txt');
  await fs.writeFile(file, 'other');
  await fs.utimes(file, new Date(before.modifiedAt), new Date(before.modifiedAt));
  await expect(saveProjectTextFile(project.id, 'notes.txt', 'mine', before.modifiedAt, before.bytes, before.revision!)).rejects.toThrow(/changed on disk/);
  expect(await fs.readFile(file, 'utf8')).toBe('other');
});

it('rechecks concurrent changes after staging', async () => {
  const projectPath = path.join(approved, 'project');
  const file = path.join(projectPath, 'notes.txt');
  await fs.writeFile(file, 'original');
  const project = await addProject(projectPath);
  const before = await previewProjectFile(project.id, 'notes.txt');
  const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[1] === 'wx') {
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, 'writeFile').mockImplementation(async (...writeArgs) => {
        await write(...writeArgs);
        await fs.writeFile(file, 'external');
      });
    }
    return handle;
  });
  await expect(saveProjectTextFile(project.id, 'notes.txt', 'replacement', before.modifiedAt, before.bytes, before.revision!)).rejects.toThrow(/changed on disk/);
  expect(await fs.readFile(file, 'utf8')).toBe('external');
  expect((await fs.readdir(projectPath)).some(name => name.endsWith('.tmp'))).toBe(false);
});

it('does not forward a malformed raster to the renderer', async () => {
  const file = path.join(approved, 'project', 'broken.png');
  await fs.writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const project = await addProject(path.dirname(file));
  const preview = await previewProjectFile(project.id, 'broken.png');
  expect(preview.imageDataUrl).toBeUndefined();
  expect(preview.note).toMatch(/preview unavailable/i);
});

it('refuses publication when folder access is revoked during staging', async () => {
  const projectPath = path.join(approved, 'project');
  const file = path.join(projectPath, 'notes.txt');
  await fs.writeFile(file, 'original');
  const project = await addProject(projectPath);
  const before = await previewProjectFile(project.id, 'notes.txt');
  const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[1] === 'wx') {
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, 'writeFile').mockImplementation(async (...writeArgs) => {
        await write(...writeArgs);
        await saveConfig({ ...getConfig(), roots: [] });
      });
    }
    return handle;
  });
  await expect(saveProjectTextFile(project.id, 'notes.txt', 'replacement', before.modifiedAt, before.bytes, before.revision!)).rejects.toThrow();
  expect(await fs.readFile(file, 'utf8')).toBe('original');
});

it('fails closed for unknown projects and never accepts an absolute renderer path', async () => {
  const project = await addProject(path.join(approved, 'project'));
  await expect(listProjectDirectory('00000000-0000-4000-8000-000000000000')).rejects.toThrow('Project not found');
  await expect(projectFileTarget(project.id, path.join(approved, 'project', 'src'))).rejects.toThrow(/relative/);
});

it('watches only requested project directories, debounces changes, and closes collapsed watches', async () => {
  vi.useFakeTimers();
  try {
    const projectPath = path.join(approved, 'project');
    const project = await addProject(projectPath);
    const records: Array<{ nativePath: string; fire: () => void; close: ReturnType<typeof vi.fn> }> = [];
    const changed: Array<{ projectId: string; directory: string }> = [];
    const watches = new ProjectFileWatchSet(event => changed.push(event), (nativePath, listener) => {
      const emitter = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> };
      emitter.close = vi.fn();
      records.push({ nativePath, fire: listener, close: emitter.close });
      return emitter as never;
    });

    await watches.sync(project.id, ['', 'src']);
    expect(records).toHaveLength(2);
    records[0]!.fire();
    records[0]!.fire();
    vi.advanceTimersByTime(179);
    expect(changed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(changed).toEqual([{ projectId: project.id, directory: '' }]);

    const nested = records.find(record => path.basename(record.nativePath) === 'src')!;
    await watches.sync(project.id, ['']);
    expect(nested.close).toHaveBeenCalledTimes(1);
    watches.close();
  } finally {
    vi.useRealTimers();
  }
});
