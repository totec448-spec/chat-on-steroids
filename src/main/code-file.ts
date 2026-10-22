import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { app, dialog, type BrowserWindow } from 'electron';
import { logWarn } from './logger.js';
import { dialogLabel, mainText } from './main-texts.js';

export type CodeFileResult = { done: 'saved'; name: string } | { done: 'cancelled' };

/**
 * Saves a code block of an answer where the person picks in the save dialog. `name` (a bare file
 * name the IPC handler validated) is only the dialog's suggestion in Downloads; the renderer never
 * names a path.
 */
export async function saveCodeFile(text: string, name: string, owner: BrowserWindow | null): Promise<CodeFileResult> {
  const options = {
    ...dialogLabel('Save code'),
    defaultPath: path.join(app.getPath('downloads'), name),
    filters: [{ name: mainText('Text files'), extensions: [path.extname(name).slice(1)] }]
  };
  const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { done: 'cancelled' };
  // A chosen symlink is written through to the file it points at: renaming over it would swap the link for a plain
  // file and leave its target untouched. A link to nothing has no file to keep whole, so it stops the save.
  const destination = await fs.lstat(result.filePath).then(
    entry => entry.isSymbolicLink() ? fs.realpath(result.filePath) : result.filePath,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return result.filePath;
      throw error;
    }
  ).catch((error: NodeJS.ErrnoException) => {
    logWarn(`code save: refused, the chosen file could not be resolved (${error.code ?? 'unknown error'})`);
    throw error;
  });
  // A file the person chose to replace stays whole until the new one is: write beside it, then rename over it.
  const temporary = `${destination}.${randomUUID()}.tmp`;
  // The new file keeps a replaced file's permissions, such as a script's execute bit; Windows has none to keep.
  // Only a missing file has none; any other stat error stops the save before the old file is touched.
  const mode = process.platform === 'win32' ? undefined : await fs.stat(destination).then(
    stat => stat.mode & 0o7777,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      logWarn(`code save: refused, the chosen file's permissions could not be read (${error.code ?? 'unknown error'})`);
      throw error;
    }
  );
  try {
    // Created with that mode, so a private file's new text is never readable to others; the chmod
    // then restores any bits the umask stripped, such as the execute bit.
    await fs.writeFile(temporary, text, { encoding: 'utf8', mode: mode ?? 0o666 });
    if (mode !== undefined) await fs.chmod(temporary, mode);
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    logWarn(`code save: refused, the file could not be written or replaced (${(error as NodeJS.ErrnoException).code ?? 'unknown error'})`);
    throw error;
  }
  return { done: 'saved', name: path.basename(result.filePath) };
}
