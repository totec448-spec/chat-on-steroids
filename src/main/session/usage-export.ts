import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app, dialog, type BrowserWindow } from 'electron';
import { usageCsv, usageDateKey } from '../../shared/usage.js';
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
  // Read after the dialog, so the file holds the limits as they are when it is written.
  await fs.writeFile(result.filePath, usageCsv(await usageOverview(), divisor, Date.now()), 'utf8');
  return { saved: true, name: path.basename(result.filePath) };
}
