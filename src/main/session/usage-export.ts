import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app, dialog, type BrowserWindow } from 'electron';
import { usageCsv, usageDateKey } from '../../shared/usage.js';
import { logInfo, logWarn } from '../logger.js';
import { dialogLabel, mainText } from '../main-texts.js';
import { usageOverview } from './usage.js';

export type UsageExportResult = { saved: false } | { saved: true; name: string };

async function confirmReplacement(file: string, owner: BrowserWindow | null, mode: 'existing' | 'any' = 'existing'): Promise<boolean> {
  const confirmation = {
    type: 'warning' as const, title: mainText('Export usage as CSV'),
    message: mainText(mode === 'any' ? 'Save here and replace any existing file?' : 'Replace this CSV file?'), detail: path.basename(file),
    buttons: [mainText('Cancel'), mainText(mode === 'any' ? 'Save' : 'Replace file')], defaultId: 0, cancelId: 0, noLink: true
  };
  const { response } = owner ? await dialog.showMessageBox(owner, confirmation) : await dialog.showMessageBox(confirmation);
  return response === 1;
}

// These volumes remain usable: obtain replacement consent before atomic rename instead of
// copying into a visible destination, which could leave a partial CSV if interrupted.
const NO_HARD_LINKS = new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EXDEV', 'EMLINK']);

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
  let confirmed = process.platform !== 'linux';
  if (process.platform === 'linux') {
    // Electron 44's GTK chooser can ignore showOverwriteConfirmation. Own this confirmation
    // here rather than asking twice on backends that do support the native flag.
    const exists = await fs.lstat(result.filePath).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      logWarn(`Usage export not saved: ${error.code ?? 'file check failed'}`);
      throw error;
    });
    if (exists) {
      confirmed = await confirmReplacement(result.filePath, owner);
      if (!confirmed) return { saved: false };
    }
  }
  // Capture usage after path selection and any initial replacement question. This snapshot
  // stays whole even if publication needs another confirmation.
  const csv = usageCsv(await usageOverview(), divisor, Date.now());
  // Stage the whole CSV first. A new Linux destination must still be absent at publication,
  // not just at the earlier check; replacing an existing file always requires confirmation.
  const temporary = path.join(path.dirname(result.filePath), `.${path.basename(result.filePath)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, csv, 'utf8');
    if (confirmed) await fs.rename(temporary, result.filePath);
    else {
      try { await fs.link(temporary, result.filePath); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        const cannotLink = NO_HARD_LINKS.has(code);
        if (code !== 'EEXIST' && !cannotLink) throw error;
        logInfo(cannotLink
          ? 'Usage export: this location cannot publish without replacement; asking for permission'
          : 'Usage export: the destination appeared while preparing the CSV; asking before replacement');
        if (!await confirmReplacement(result.filePath, owner, cannotLink ? 'any' : 'existing')) return { saved: false };
        await fs.rename(temporary, result.filePath);
      }
    }
  } catch (error) {
    // The code only: the message names the chosen path.
    logWarn(`Usage export not saved: ${(error as NodeJS.ErrnoException).code ?? 'write failed'}`);
    throw error;
  } finally {
    await fs.rm(temporary, { force: true }).catch((error: NodeJS.ErrnoException) => {
      logWarn(`Usage export temporary file not removed: ${error.code ?? 'cleanup failed'}`);
    });
  }
  return { saved: true, name: path.basename(result.filePath) };
}
