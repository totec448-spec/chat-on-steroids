import path from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import type { UsageOverview } from '../src/shared/usage.js';

const electron = vi.hoisted(() => ({
  dialog: { showSaveDialog: vi.fn() },
  app: { getPath: vi.fn(() => '/downloads') }
}));
const usage = vi.hoisted(() => ({ usageOverview: vi.fn() }));
const files = vi.hoisted(() => ({ writeFile: vi.fn(async () => undefined), rename: vi.fn(async () => undefined), rm: vi.fn(async () => undefined) }));
const logger = vi.hoisted(() => ({ logWarn: vi.fn() }));
vi.mock('electron', () => electron);
vi.mock('../src/main/logger.js', () => logger);
vi.mock('../src/main/session/usage.js', () => usage);
vi.mock('node:fs', () => ({ promises: files }));

const { exportUsageCsv } = await import('../src/main/session/usage-export.js');
const { usageCsv } = await import('../src/shared/usage.js');

const at = (day: number, hour = 0, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const overview: UsageOverview = {
  contextTokenCap: 256_000, tokens: 0, models: [], sessions: 2, projects: [],
  days: [
    { date: '2026-09-30', tokens: 1000.4, models: [] },
    { date: '2026-10-19', tokens: 250_000, models: [] }
  ],
  // Verified sends cover the seven local days ending today, 14 to 20 October.
  messages: { through: at(20, 12), days: [{ date: '2026-10-15', gpt56: 2, gpt6: 0 }, { date: '2026-10-19', gpt56: 4, gpt6: 3 }] },
  limits: [
    { model: 'gpt-6-pro', scope: 'model', remaining: 12, remainingPercent: null, resetAt: at(21, 9, 5), windowSeconds: 10800, observedAt: at(20, 11, 58) },
    { model: 'Codex', scope: 'codex', remaining: null, remainingPercent: 16.25, resetAt: null, windowSeconds: 604800, observedAt: at(20, 11, 58) }
  ]
};
const rows = (csv: string) => csv.replace(/^﻿/, '').split('\r\n');

beforeEach(() => {
  vi.clearAllMocks();
  usage.usageOverview.mockResolvedValue(overview);
});

it('saves daily estimated tokens, the last week of sends and the latest limits as CSV', async () => {
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/downloads/usage.csv' });
  await expect(exportUsageCsv(2, null)).resolves.toEqual({ saved: true, name: 'usage.csv' });
  expect(electron.dialog.showSaveDialog.mock.calls[0]![0]).toMatchObject({
    title: 'Export usage as CSV', message: 'Export usage as CSV',
    defaultPath: expect.stringMatching(/chat-on-steroids-usage-\d{4}-\d{2}-\d{2}\.csv$/),
    filters: [{ name: 'CSV files', extensions: ['csv'] }]
  });
  const [file, csv, encoding] = files.writeFile.mock.calls[0]! as unknown as [string, string, string];
  // The whole file goes beside the chosen one first, then replaces it.
  expect(file).toBe(path.join('/downloads', path.basename(file)));
  expect(path.basename(file)).toMatch(/^\.usage\.csv\.[0-9a-f-]{36}\.tmp$/);
  expect(encoding).toBe('utf8');
  expect(files.rename).toHaveBeenCalledWith(file, '/downloads/usage.csv');
  // Excel reads UTF-8 only with a byte-order mark; rows end in CRLF as RFC 4180 has it.
  expect(csv.startsWith('﻿Chat On Steroids usage export,')).toBe(true);
  const lines = rows(csv);
  expect(lines[1]).toMatch(/^Note,"Estimated tokens are this app's local estimate .*divided by 2\), not a provider invoice/);
  expect(lines.slice(3, 9)).toEqual([
    'Date,Estimated tokens,GPT-5.6 messages sent,GPT-6 messages sent',
    // Before the counted week there is no send count, which is not the same as none.
    '2026-09-30,1000,,',
    '2026-10-15,0,2,0',
    '2026-10-19,250000,4,3',
    '',
    'Limit,Kind,Remaining,Remaining percent,Window hours,Resets at,Read at'
  ]);
  expect(lines.slice(9)).toEqual([
    'gpt-6-pro,model,12,,3,2026-10-21 09:05,2026-10-20 11:58',
    'Codex,codex,,16.3,168,,2026-10-20 11:58',
    ''
  ]);
});

it('follows the page divisor, so the file shows the tokens the page shows', () => {
  const lines = rows(usageCsv(overview, 4, at(20)));
  expect([lines[4], lines[6]]).toEqual(['2026-09-30,500,,', '2026-10-19,125000,4,3']);
  expect(lines[1]).toContain('divided by 4)');
});

it('quotes commas and quotes, and keeps a spreadsheet from running a reported name as a formula', () => {
  const lines = rows(usageCsv({ ...overview, days: [], messages: { through: at(20, 12), days: [] }, limits: [
    { ...overview.limits[0]!, model: '=HYPERLINK("x"),1' }, { ...overview.limits[0]!, model: '-2+3' },
    // Some spreadsheets skip a leading line break and run what follows.
    { ...overview.limits[0]!, model: '\n=1+1' }
  ] }, 2, at(20)));
  expect(lines.slice(6, 9)).toEqual([
    `"'=HYPERLINK(""x""),1",model,12,,3,2026-10-21 09:05,2026-10-20 11:58`,
    `'-2+3,model,12,,3,2026-10-21 09:05,2026-10-20 11:58`,
    `"'\n=1+1",model,12,,3,2026-10-21 09:05,2026-10-20 11:58`
  ]);
});

it('writes nothing when the save dialog is cancelled', async () => {
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: true });
  await expect(exportUsageCsv(2, null)).resolves.toEqual({ saved: false });
  expect(files.writeFile).not.toHaveBeenCalled();
  expect(usage.usageOverview).not.toHaveBeenCalled();
});

// Writing the chosen file in place would empty an earlier export before the new one is whole.
it('leaves an earlier export whole when the write fails, and logs why without the path', async () => {
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/downloads/usage.csv' });
  files.writeFile.mockRejectedValueOnce(Object.assign(new Error("ENOSPC: no space left on device, open '/downloads/.usage.csv.tmp'"), { code: 'ENOSPC' }));
  await expect(exportUsageCsv(2, null)).rejects.toThrow('ENOSPC');
  const [file] = files.writeFile.mock.calls[0]! as unknown as [string];
  expect(file).not.toBe('/downloads/usage.csv');
  expect(files.rename).not.toHaveBeenCalled();
  expect(files.rm).toHaveBeenCalledWith(file, { force: true });
  expect(logger.logWarn).toHaveBeenCalledWith('Usage export not saved: ENOSPC');
});
