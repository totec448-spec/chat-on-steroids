import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';

const electron = vi.hoisted(() => ({
  app: { getPath: vi.fn() },
  dialog: { showSaveDialog: vi.fn(), showMessageBox: vi.fn() }
}));
const usage = vi.hoisted(() => ({ usageOverview: vi.fn() }));
vi.mock('electron', () => electron);
vi.mock('../src/main/session/usage.js', () => usage);
const { exportUsageCsv } = await import('../src/main/session/usage-export.js');

let directory: string, target: string;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal('process', { ...process, platform: 'linux' });
  directory = await makeTempDir('cos-csv-export-');
  target = path.join(directory, 'usage.csv');
  electron.app.getPath.mockReturnValue(directory);
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target });
  usage.usageOverview.mockResolvedValue({ days: [], messages: { through: Date.now(), days: [] }, limits: [] });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await removeTempDir(directory); });

it.each([0, 1])('requires confirmation for a file created after the initial destination check (response=%s)', async response => {
  usage.usageOverview.mockImplementationOnce(async () => {
    // The data read is after the destination check and before publication: another writer takes the name.
    await fs.writeFile(target, 'Created by another writer\n');
    return { days: [], messages: { through: Date.now(), days: [] }, limits: [] };
  });
  electron.dialog.showMessageBox.mockResolvedValue({ response });
  await expect(exportUsageCsv(2, null)).resolves.toMatchObject({ saved: response === 1 });
  expect(electron.dialog.showMessageBox).toHaveBeenCalledOnce();
  const content = await fs.readFile(target, 'utf8');
  if (response === 0) expect(content).toBe('Created by another writer\n');
  else expect(content).toMatch(/^﻿Chat On Steroids usage export,/);
  expect(await fs.readdir(directory)).toEqual(['usage.csv']);
});

it('publishes a new CSV without a replacement question or a leftover temporary file', async () => {
  await expect(exportUsageCsv(2, null)).resolves.toMatchObject({ saved: true });
  expect(electron.dialog.showMessageBox).not.toHaveBeenCalled();
  expect(await fs.readFile(target, 'utf8')).toMatch(/^﻿Chat On Steroids usage export,/);
  expect(await fs.readdir(directory)).toEqual(['usage.csv']);
});

it.each([0, 1])('leaves no partial destination when fallback publication is declined or interrupted (response=%s)', async response => {
  vi.spyOn(fs, 'link').mockRejectedValueOnce(Object.assign(new Error('no hard links'), { code: 'ENOTSUP' }));
  electron.dialog.showMessageBox.mockResolvedValue({ response });
  const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('interrupted publication'), { code: 'EIO' }));
  const exporting = exportUsageCsv(2, null);
  if (response === 0) {
    await expect(exporting).resolves.toEqual({ saved: false });
    expect(rename).not.toHaveBeenCalled();
  } else await expect(exporting).rejects.toThrow('interrupted publication');
  await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readdir(directory)).toEqual([]);
});

it('avoids interruptible copying and still saves on a volume without hard links after consent', async () => {
  vi.spyOn(fs, 'link').mockRejectedValueOnce(Object.assign(new Error('no hard links'), { code: 'ENOTSUP' }));
  const copy = vi.spyOn(fs, 'copyFile').mockImplementationOnce(async (_source, destination) => {
    await fs.writeFile(destination, 'Partial CSV');
    throw Object.assign(new Error('interrupted copy'), { code: 'EIO' });
  });
  electron.dialog.showMessageBox.mockResolvedValue({ response: 1 });
  await expect(exportUsageCsv(2, null)).resolves.toMatchObject({ saved: true });
  expect(copy).not.toHaveBeenCalled();
  expect(await fs.readFile(target, 'utf8')).toMatch(/^﻿Chat On Steroids usage export,/);
  expect(await fs.readdir(directory)).toEqual(['usage.csv']);
});
