import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, loadConfig, saveConfig } from '../src/main/config.js';
import { openInPreferredBrowser, preferredBrowserCandidates } from '../src/main/browser.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;
beforeAll(async () => { dir = await makeTempDir('clf-browser-choice-'); initConfigPath(dir); });
afterAll(async () => { await removeTempDir(dir); });

it('uses the persisted Edge choice for cold minimized discovery without an option override', async () => {
  const config = defaultConfig();
  await saveConfig({ ...config, ui: { ...config.ui, chatBrowser: 'edge' } });
  expect((await loadConfig()).ui.chatBrowser).toBe('edge');
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const powershell = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false, durationMs: 1 }));
  const launch = vi.fn();
  const opened = await openInPreferredBrowser('https://chatgpt.com/?cos-model-catalog=owned', {
    platform: 'win32', env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
    backgroundStartup: true, usable: () => true, powershell, launch
  });
  expect(opened).toBe(edge);
  expect(powershell).toHaveBeenCalledWith(expect.stringContaining(`-FilePath '${edge}'`), path.win32.dirname(edge), 10_000);
  expect(powershell).toHaveBeenCalledWith(expect.stringContaining('-WindowStyle Minimized'), expect.any(String), 10_000);
  expect(launch).not.toHaveBeenCalled();
});

it('migrates a config without a browser choice to Chrome without losing its other settings', async () => {
  const old = defaultConfig();
  delete old.ui.chatBrowser;
  old.ui.autoConnect = true;
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(old));
  expect((await loadConfig()).ui).toMatchObject({ chatBrowser: 'chrome', autoConnect: true });
});

it('finds Edge installations on each platform without mixing in Chrome', () => {
  expect(preferredBrowserCandidates('win32', { LOCALAPPDATA: 'C:\\Local', ProgramFiles: 'C:\\Apps', 'ProgramFiles(x86)': 'C:\\Apps86' }, undefined, 'edge'))
    .toEqual(['C:\\Local\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Apps\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Apps86\\Microsoft\\Edge\\Application\\msedge.exe']);
  const mac = preferredBrowserCandidates('darwin', {}, '/Users/example', 'edge');
  expect(mac).toContain('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  expect(mac).toContain('/Users/example/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  expect(mac.every(candidate => candidate.includes('Microsoft Edge'))).toBe(true);
  const linux = preferredBrowserCandidates('linux', { PATH: '/custom/bin:/usr/bin' }, '/home/example', 'edge');
  expect(linux).toContain('/custom/bin/microsoft-edge');
  expect(linux).toContain('/usr/bin/microsoft-edge-stable');
  expect(linux.every(candidate => !/chrome|chromium/.test(candidate))).toBe(true);
});

it('finds Brave installations on each platform without mixing in Chrome or Edge', () => {
  expect(preferredBrowserCandidates('win32', { LOCALAPPDATA: 'C:\\Local', ProgramFiles: 'C:\\Apps', 'ProgramFiles(x86)': 'C:\\Apps86' }, undefined, 'brave'))
    .toEqual(['C:\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'C:\\Apps\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'C:\\Apps86\\BraveSoftware\\Brave-Browser\\Application\\brave.exe']);
  const mac = preferredBrowserCandidates('darwin', {}, '/Users/example', 'brave');
  expect(mac).toContain('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
  expect(mac).toContain('/Users/example/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
  expect(mac.every(candidate => candidate.includes('Brave'))).toBe(true);
  const linux = preferredBrowserCandidates('linux', { PATH: '/custom/bin:/usr/bin' }, '/home/example', 'brave');
  expect(linux).toContain('/custom/bin/brave-browser');
  expect(linux).toContain('/usr/bin/brave-browser');
  expect(linux).toContain('/opt/brave.com/brave/brave-browser');
  expect(linux).toContain('/snap/bin/brave');
  expect(linux.every(candidate => !/chrome|chromium|edge/.test(candidate))).toBe(true);
});
