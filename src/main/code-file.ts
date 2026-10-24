import path from 'node:path';
import { app, dialog, type BrowserWindow } from 'electron';
import { replaceFile } from './replace-file.js';
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
  await replaceFile(result.filePath, text, 'code save');
  return { done: 'saved', name: path.basename(result.filePath) };
}
