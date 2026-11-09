import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app, dialog, type BrowserWindow } from 'electron';
import { usageCsv, usageDateKey } from '../../shared/usage.js';
import { logWarn } from '../logger.js';
import { dialogLabel, mainText } from '../main-texts.js';
import { usageOverview } from './usage.js';

export type UsageExportResult = { saved: false } | { saved: true; name: string };

/** Saves the Usage page's daily estimates, recent sends and latest limits where the person chooses. */
export async function exportUsageCsv(divisor: number, owner: BrowserWindow | null): Promise<UsageExportResult> {
  const now = Date.now();
  const options = {
    ...dialogLabel('Export usage as CSV'),
    defaultPath: path.join(app.getPath('downloads'), `chat-on-steroids-usage-${usageDateKey(new Date(now))}.csv`),
    filters: [{ name: mainText('CSV files'), extensions: ['csv'] }]
  };
  const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { saved: false };
  if (process.platform === 'linux') {
    // Electron 44's GTK chooser can ignore showOverwriteConfirmation. Own this confirmation
    // here rather than asking twice on backends that do support the native flag.
    const exists = await fs.lstat(result.filePath).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      logWarn(`Usage export not saved: ${error.code ?? 'file check failed'}`);
      throw error;
    });
    if (exists) {
      const confirmation = {
        type: 'warning' as const, title: mainText('Export usage as CSV'),
        message: mainText('Replace this CSV file?'), detail: path.basename(result.filePath),
        buttons: [mainText('Cancel'), mainText('Replace file')], defaultId: 0, cancelId: 0, noLink: true
      };
      const { response } = owner ? await dialog.showMessageBox(owner, confirmation) : await dialog.showMessageBox(confirmation);
      if (response !== 1) return { saved: false };
    }
  }
  // Read after the dialog, so the file holds the limits as they are when it is written.
  const csv = usageCsv(await usageOverview(), divisor, Date.now());
  // Write beside the chosen file and then replace it, so a failed write leaves an earlier export whole.
  const temporary = path.join(path.dirname(result.filePath), `.${path.basename(result.filePath)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, csv, 'utf8');
    await fs.rename(temporary, result.filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    // The code only: the message names the chosen path.
    logWarn(`Usage export not saved: ${(error as NodeJS.ErrnoException).code ?? 'write failed'}`);
    throw error;
  }
  return { saved: true, name: path.basename(result.filePath) };
}
