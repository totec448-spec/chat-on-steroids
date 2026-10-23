import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { logWarn } from './logger.js';

/**
 * Writes `text` to a file the person chose in a save dialog. A chosen symlink is written through to
 * the file it points at: renaming over it would swap the link for a plain file and leave its target
 * untouched. A link to nothing has no file to keep whole, so it stops the save. The text goes to a
 * temporary file beside the target and is then renamed over it, so a failed write keeps the old
 * file whole, and the new file keeps the old one's permissions, such as a script's execute bit.
 * `label` starts the log line of every refusal, which never holds the chosen path.
 */
export async function replaceFile(chosen: string, text: string, label: string): Promise<void> {
  const destination = await fs.lstat(chosen).then(
    entry => entry.isSymbolicLink() ? fs.realpath(chosen) : chosen,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return chosen;
      throw error;
    }
  ).catch((error: NodeJS.ErrnoException) => {
    logWarn(`${label}: refused, the chosen file could not be resolved (${error.code ?? 'unknown error'})`);
    throw error;
  });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  // Windows has no permission bits to keep. Only a missing file has none; any other stat error
  // stops the save before the old file is touched.
  const mode = process.platform === 'win32' ? undefined : await fs.stat(destination).then(
    stat => stat.mode & 0o7777,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      logWarn(`${label}: refused, the chosen file's permissions could not be read (${error.code ?? 'unknown error'})`);
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
    logWarn(`${label}: refused, the file could not be written or replaced (${(error as NodeJS.ErrnoException).code ?? 'unknown error'})`);
    // Best effort: on Windows an antivirus scan or indexer can hold the temporary file, and that
    // must not replace the error the caller needs to see.
    await fs.rm(temporary, { force: true }).catch((cleanup: NodeJS.ErrnoException) => {
      logWarn(`${label}: the temporary file beside the chosen file could not be removed (${cleanup.code ?? 'unknown error'})`);
    });
    throw error;
  }
}
