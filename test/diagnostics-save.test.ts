import { expect, it, vi } from 'vitest';

/**
 * 2.1.39 release round, Windows in German: the save dialog of the diagnostics report was titled
 * "Save diagnostics report" in English. It now uses the interface language, like the tray.
 */
const showSaveDialog = vi.fn(async () => ({ canceled: true, filePath: undefined }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/downloads' }, dialog: { showSaveDialog }, shell: {}, screen: {} }));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({ ui: { language: 'de' } }) }));
vi.mock('../src/main/main-texts.js', () => ({ mainText: (text: string) => `[${text}]` }));

const { saveDiagnosticsReport } = await import('../src/main/diagnostics-report.js');

it('titles the save dialog in the interface language', async () => {
  expect(await saveDiagnosticsReport('report', null)).toEqual({ saved: false });
  expect(showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({ title: '[Diagnostics report]' }));
});
