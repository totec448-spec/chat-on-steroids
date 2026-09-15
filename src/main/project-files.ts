import path from 'node:path';
import { getConfig } from './config.js';
import { listDirectoryLevel, readTextFile, statInfo } from './codex/read-backend.js';
import { getProject, projectWorkspace } from './projects.js';
import { rawPromises as fs } from './rawfs.js';
import { isContained, resolvePath, SandboxError } from './sandbox.js';
import type {
  ProjectDirectoryListing,
  ProjectFileKind,
  ProjectFileMutationResult,
  ProjectFilePreview,
  ProjectFileSaveResult
} from '../shared/project-files.js';

const MAX_DIRECTORY_ENTRIES = 500;
const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_IMAGE_PREVIEW_BYTES = 5 * 1024 * 1024;
const MAX_PDF_PREVIEW_BYTES = 20 * 1024 * 1024;

const IMAGE_MIME_BY_EXTENSION = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.avif', 'image/avif'],
  ['.ico', 'image/x-icon']
]);

export interface ProjectFileTarget {
  projectId: string;
  projectName: string;
  projectReal: string;
  projectVirtual: string;
  path: string;
  real: string;
  kind: ProjectFileKind;
}

function normaliseRelative(input: string): string {
  if (typeof input !== 'string' || input.length > 4096) throw new Error('Project path is invalid');
  if (input === '') return '';
  if (/^(?:[/\\]|[A-Za-z]:[\\/]|\\\\)/.test(input)) throw new Error('Project paths must be relative');
  const raw = input.split(/[\\/]/);
  if (raw.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('Project path contains an invalid segment');
  }
  return raw.join('/');
}

function leafName(input: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > 255) throw new Error('Name is invalid');
  if (input === '.' || input === '..' || /[\\/\0]/.test(input)) throw new Error('Name must be one file or folder name');
  return input;
}

function childPath(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

function parentPath(relative: string): string {
  const at = relative.lastIndexOf('/');
  return at < 0 ? '' : relative.slice(0, at);
}

function sameRealPath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function context(projectId: string): Promise<{
  projectName: string;
  real: string;
  virtual: string;
}> {
  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found');
  const workspace = await projectWorkspace(projectId);
  return { projectName: project.name, ...workspace };
}

/**
 * The explorer never follows a link as though it were another project folder. `resolvePath`
 * already prevents escapes from the approved root; this extra walk keeps Files scoped to the
 * explicit LocalProject even when a symlink/junction points to another approved sibling.
 */
async function assertNoLinkTraversal(projectReal: string, relative: string, allowMissingLeaf: boolean): Promise<void> {
  if (!relative) return;
  let current = projectReal;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]!);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Files does not follow symbolic links or junctions');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (allowMissingLeaf && index === parts.length - 1 && code === 'ENOENT') return;
      throw error;
    }
  }
}

async function resolveTarget(
  projectId: string,
  relativeInput: string,
  options: { allowMissing?: boolean; allowRoot?: boolean } = {}
): Promise<Omit<ProjectFileTarget, 'kind'>> {
  const relative = normaliseRelative(relativeInput);
  if (!relative && options.allowRoot === false) throw new Error('The project root cannot be changed');
  const project = await context(projectId);
  if (!relative) {
    return {
      projectId,
      projectName: project.projectName,
      projectReal: project.real,
      projectVirtual: project.virtual,
      path: '',
      real: project.real
    };
  }
  await assertNoLinkTraversal(project.real, relative, options.allowMissing === true);
  const resolved = await resolvePath(getConfig().roots, relative, {
    base: project.virtual,
    allowMissing: options.allowMissing === true
  });
  if (!isContained(project.real, resolved.real)) {
    throw new SandboxError('Path leaves the selected project folder');
  }
  return {
    projectId,
    projectName: project.projectName,
    projectReal: project.real,
    projectVirtual: project.virtual,
    path: relative,
    real: resolved.real
  };
}

async function kindOf(real: string): Promise<ProjectFileKind> {
  const stat = await fs.lstat(real);
  return stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
}

export async function projectFileTarget(
  projectId: string,
  relativePath: string,
  options: { allowRoot?: boolean; fileOnly?: boolean } = {}
): Promise<ProjectFileTarget> {
  const target = await resolveTarget(projectId, relativePath, { allowRoot: options.allowRoot ?? true });
  const kind = await kindOf(target.real);
  if (options.fileOnly && kind !== 'file') throw new Error('Choose a regular file');
  return { ...target, kind };
}

export async function listProjectDirectory(projectId: string, relativeDirectory = ''): Promise<ProjectDirectoryListing> {
  const target = await projectFileTarget(projectId, relativeDirectory, { allowRoot: true });
  if (target.kind !== 'directory') throw new Error('Choose a project folder');
  const listed = await listDirectoryLevel(target.real, target.path, MAX_DIRECTORY_ENTRIES, false);
  return {
    projectId,
    projectName: target.projectName,
    directory: target.path,
    entries: listed.entries.map(entry => ({
      name: entry.name,
      path: childPath(target.path, entry.name),
      kind: entry.type,
      bytes: entry.bytes
    })),
    truncated: listed.truncated
  };
}

export async function previewProjectFile(projectId: string, relativePath: string): Promise<ProjectFilePreview> {
  const target = await projectFileTarget(projectId, relativePath, { allowRoot: false, fileOnly: true });
  const info = await statInfo(target.real, target.path, { scanContent: true });
  if (info.type !== 'file') throw new Error('Choose a regular file');
  const extension = path.extname(target.real).toLowerCase();
  const imageMimeType = IMAGE_MIME_BY_EXTENSION.get(path.extname(target.real).toLowerCase());
  if (imageMimeType && info.bytes <= MAX_IMAGE_PREVIEW_BYTES) {
    // Re-check the opened file and cap the payload so a concurrent growth cannot turn a
    // small preview request into an unbounded allocation or IPC message.
    const handle = await fs.open(target.real, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('Choose a regular file');
      if (stat.size > MAX_IMAGE_PREVIEW_BYTES) {
        return {
          projectId,
          projectName: target.projectName,
          path: target.path,
          name: path.basename(target.real),
          bytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          binary: true,
          text: null,
          truncated: true,
          note: 'Image is too large for the bounded preview.'
        };
      }
      const buffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const data = offset === buffer.length ? buffer : buffer.subarray(0, offset);
      return {
        projectId,
        projectName: target.projectName,
        path: target.path,
        name: path.basename(target.real),
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        binary: true,
        text: null,
        imageMimeType,
        imageDataUrl: `data:${imageMimeType};base64,${data.toString('base64')}`,
        truncated: false
      };
    } finally {
      await handle.close();
    }
  }
  if (extension === '.pdf') {
    const handle = await fs.open(target.real, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('Choose a regular file');
      if (stat.size > MAX_PDF_PREVIEW_BYTES) {
        return {
          projectId,
          projectName: target.projectName,
          path: target.path,
          name: path.basename(target.real),
          bytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          binary: true,
          text: null,
          truncated: true,
          note: 'PDF is too large for the bounded in-app preview.'
        };
      }
      const buffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const data = offset === buffer.length ? buffer : buffer.subarray(0, offset);
      // Fail closed on a misleading .pdf extension instead of giving arbitrary binary bytes
      // to a document parser. PDF headers are normally at byte zero; tolerate a small prefix.
      if (!data.subarray(0, Math.min(1024, data.length)).includes(Buffer.from('%PDF-'))) {
        return {
          projectId,
          projectName: target.projectName,
          path: target.path,
          name: path.basename(target.real),
          bytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          binary: true,
          text: null,
          truncated: false,
          note: 'This .pdf file does not contain a PDF header.'
        };
      }
      return {
        projectId,
        projectName: target.projectName,
        path: target.path,
        name: path.basename(target.real),
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        binary: true,
        text: null,
        pdfDataBase64: data.toString('base64'),
        truncated: false
      };
    } finally {
      await handle.close();
    }
  }
  if (info.binary === true) {
    return {
      projectId,
      projectName: target.projectName,
      path: target.path,
      name: path.basename(target.real),
      bytes: info.bytes,
      modifiedAt: info.modified,
      binary: true,
      text: null,
      truncated: Boolean(imageMimeType && info.bytes > MAX_IMAGE_PREVIEW_BYTES),
      ...(imageMimeType && info.bytes > MAX_IMAGE_PREVIEW_BYTES
        ? { note: 'Image is too large for the bounded preview.' }
        : {})
    };
  }
  let read;
  try {
    read = await readTextFile(target.real, { maxBytes: MAX_PREVIEW_BYTES });
  } catch (error) {
    if (error instanceof Error && /Line \d+ is larger than max_bytes=/.test(error.message)) {
      return {
        projectId,
        projectName: target.projectName,
        path: target.path,
        name: path.basename(target.real),
        bytes: info.bytes,
        modifiedAt: info.modified,
        binary: false,
        text: null,
        truncated: true,
        note: 'This file contains a line that is too large for the bounded preview.'
      };
    }
    throw error;
  }
  return {
    projectId,
    projectName: target.projectName,
    path: target.path,
    name: path.basename(target.real),
    bytes: info.bytes,
    modifiedAt: info.modified,
    binary: false,
    text: read.text,
    truncated: read.truncated || read.hasMore
  };
}

export async function createProjectEntry(
  projectId: string,
  relativeDirectory: string,
  nameInput: string,
  kind: 'file' | 'directory'
): Promise<ProjectFileMutationResult> {
  const directory = await projectFileTarget(projectId, relativeDirectory, { allowRoot: true });
  if (directory.kind !== 'directory') throw new Error('Choose a project folder');
  const name = leafName(nameInput);
  const relative = childPath(directory.path, name);
  const target = await resolveTarget(projectId, relative, { allowMissing: true, allowRoot: false });
  try {
    await fs.lstat(target.real);
    throw new Error('A file or folder with that name already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (kind === 'directory') await fs.mkdir(target.real);
  else {
    const handle = await fs.open(target.real, 'wx');
    await handle.close();
  }
  return { projectId, path: relative, kind };
}

export async function renameProjectEntry(
  projectId: string,
  relativePath: string,
  nameInput: string
): Promise<ProjectFileMutationResult> {
  const source = await projectFileTarget(projectId, relativePath, { allowRoot: false });
  if (source.kind !== 'file' && source.kind !== 'directory') throw new Error('Only regular files and folders can be renamed');
  const name = leafName(nameInput);
  const relative = childPath(parentPath(source.path), name);
  if (relative === source.path) return { projectId, path: source.path, kind: source.kind };
  const destination = await resolveTarget(projectId, relative, { allowMissing: true, allowRoot: false });
  const lexicalDestination = path.join(path.dirname(source.real), name);
  if (!isContained(source.projectReal, lexicalDestination)) throw new SandboxError('Path leaves the selected project folder');
  if (!sameRealPath(source.real, lexicalDestination)) {
    try {
      await fs.lstat(lexicalDestination);
      throw new Error('A file or folder with that name already exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  // The sandbox resolution above validates the new spelling even when a Windows case-only
  // rename resolves back to the existing file identity. Use the sibling spelling for rename so
  // the requested case is not lost to realpath canonicalisation.
  void destination;
  await fs.rename(source.real, lexicalDestination);
  return { projectId, path: relative, kind: source.kind };
}

/**
 * Saves one bounded textual project file through an already-open file handle.
 *
 * `expectedModifiedAt` + `expectedBytes` are the preview revision the editor started from.
 * If another process, tool call, or agent changed the file since then we fail closed rather
 * than silently overwriting it. The renderer never supplies a native path.
 */
export async function saveProjectTextFile(
  projectId: string,
  relativePath: string,
  text: string,
  expectedModifiedAt: string,
  expectedBytes: number
): Promise<ProjectFileSaveResult> {
  const encodedBytes = Buffer.byteLength(text, 'utf8');
  if (encodedBytes > MAX_PREVIEW_BYTES) {
    throw new Error(`Edited files must be ${MAX_PREVIEW_BYTES} bytes or smaller`);
  }
  const target = await projectFileTarget(projectId, relativePath, { allowRoot: false, fileOnly: true });
  const info = await statInfo(target.real, target.path, { scanContent: true });
  if (info.type !== 'file') throw new Error('Choose a regular file');
  if (info.binary === true) throw new Error('Binary files cannot be edited here');
  if (info.bytes > MAX_PREVIEW_BYTES) throw new Error('This file is too large for the editor');
  if (info.modified !== expectedModifiedAt || info.bytes !== expectedBytes) {
    throw new Error('File changed on disk. Reload it before saving your edits.');
  }

  // Open the exact project-scoped file and verify the optimistic revision again on the handle.
  // Writing through the handle also avoids a path re-resolution race between the check and write.
  const handle = await fs.open(target.real, 'r+');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Choose a regular file');
    // `statInfo` intentionally truncates native sub-millisecond timestamps to match the
    // Codex filesystem contract. Compare the handle using that same representation.
    if (stat.size !== expectedBytes || Math.trunc(stat.mtimeMs) !== Date.parse(expectedModifiedAt)) {
      throw new Error('File changed on disk. Reload it before saving your edits.');
    }
    await handle.truncate(0);
    await handle.writeFile(text, { encoding: 'utf8' });
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { preview: await previewProjectFile(projectId, relativePath) };
}
