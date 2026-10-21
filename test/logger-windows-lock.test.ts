import { afterEach, expect, it } from 'vitest';

// #1682 on Windows: another program (a log viewer, an antivirus scan) holds app.log open without
// delete sharing, so the rotation rename fails with EBUSY. Logging has to carry on and rotate later.
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { flushLogFile, initLogFile, logInfo, resetLoggerForTests } from '../src/main/logger.js';

afterEach(() => resetLoggerForTests());

it.skipIf(process.platform !== 'win32')('keeps logging while another program holds app.log open without delete sharing, then rotates', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-winlock-'));
  try {
  const file = path.join(dir, 'app.log');
  await fs.writeFile(file, 'x'.repeat(4 * 1024 * 1024));
  initLogFile(file);
  // A log viewer: the file open for reading and writing, but not shared for delete/rename.
  const holder = spawn('powershell', ['-NoProfile', '-Command',
    `$f=[System.IO.File]::Open('${file}','Open','ReadWrite','ReadWrite'); Write-Output locked; Start-Sleep -Seconds 6; $f.Close()`]);
  await new Promise<void>(resolve => holder.stdout.on('data', d => { if (String(d).includes('locked')) resolve(); }));
  let renameError = '';
  try { await fs.rename(file, `${file}.probe`); } catch (error) { renameError = String((error as Error).message); }
  expect(renameError).not.toBe('');
  logInfo('while a viewer holds the log');
  await flushLogFile();
  const during = await fs.readFile(file, 'utf8');
  expect(during).toContain('while a viewer holds the log');
  expect(during).toContain('log rotation failed');
  await new Promise<void>(resolve => holder.on('exit', () => resolve()));
  logInfo('after the viewer closed it');
  await flushLogFile();
  expect(await fs.readFile(`${file}.1`, 'utf8')).toContain('while a viewer holds the log');
  expect(await fs.readFile(file, 'utf8')).toContain('after the viewer closed it');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}, 20000);
