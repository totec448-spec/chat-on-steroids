import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { app, dialog, type BrowserWindow } from 'electron';
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
  // A file the person chose to replace stays whole until the new one is: write beside it, then rename over it.
  const temporary = `${result.filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, text, 'utf8');
    await fs.rename(temporary, result.filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  return { done: 'saved', name: path.basename(result.filePath) };
}
