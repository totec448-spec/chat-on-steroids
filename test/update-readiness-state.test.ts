import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/main/config.js';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
});
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); });
const state = () => ({ config: defaultConfig(),
  update: { current: '2.1.34', latest: null, stage: 'idle', checkedAt: 1, error: null },
  bridge: { running: true, paired: true, present: true, extensionVersion: '2.1.34' },
  status: { state: 'connected', detail: '', surfaces: [{ id: 'core', connectorName: 'Core',
    optional: false, available: true, state: 'live', detail: '', tools: ['read'], lastRequestAt: 1, lastToolCallAt: 1 }] },
  connectorSchemas: { core: 'a' }, connectorRefresh: { core: { schemaId: 'a', state: 'current' } }
} as any);

it('reports readiness only from checked versions and current connector evidence', async () => {
  const { updateReadiness } = await import('../src/renderer/update-readiness-state.js');
  const ready = state();
  expect(updateReadiness(ready).map(row => row.status)).toEqual(['pass', 'pass', 'pass']);
  expect(updateReadiness(ready).find(row => row.id === 'app')!.detail).toContain(ready.update.current);
  expect(updateReadiness(ready).find(row => row.id === 'extension')!.detail).toContain(ready.update.current);
  for (const change of [
    (s: any) => { s.update.checkedAt = null; },
    (s: any) => { s.update.stage = 'failed'; },
    (s: any) => { s.update.latest = '2.0.3'; s.update.stage = 'ready'; },
    (s: any) => { s.bridge.present = false; },
    (s: any) => { s.bridge.paired = false; },
    (s: any) => { s.bridge.extensionVersion = null; },
    (s: any) => { s.bridge.extensionVersion = '2.0.1'; },
    (s: any) => { s.bridge.extensionVersion = '2.0.3'; },
    (s: any) => { s.status.state = 'offline'; },
    (s: any) => { s.status.surfaces[0].state = 'error'; },
    (s: any) => { s.status.surfaces[0].lastRequestAt = null; s.status.surfaces[0].proof = { requestAt: 1 }; },
    (s: any) => { s.connectorRefresh = {}; },
    (s: any) => { s.connectorRefresh.core.schemaId = 'old-schema'; },
    (s: any) => { s.connectorRefresh.core.state = 'refreshing'; },
    (s: any) => { s.status.surfaces = []; }
  ]) {
    const next = structuredClone(ready); change(next);
    expect(updateReadiness(next).some(row => row.status === 'fail' || row.status === 'not-run')).toBe(true);
  }
  const working = structuredClone(ready);
  working.connectorRefresh.core = { schemaId: 'a', state: 'unknown', responding: true };
  expect(updateReadiness(working).find(row => row.id === 'core')).toMatchObject({ status: 'pass', schemaUnchecked: true });
  const optionalOff = structuredClone(ready);
  optionalOff.status.surfaces.push({ ...ready.status.surfaces[0], id: 'desktop', optional: true, state: 'off', available: false });
  expect(updateReadiness(optionalOff).find(row => row.id === 'desktop')).toMatchObject({ status: 'skipped', detail: 'Not enabled' });
  const emptyPlugins = structuredClone(ready);
  emptyPlugins.status.surfaces.push({ ...ready.status.surfaces[0], id: 'plugins', optional: true, tools: [], lastRequestAt: null });
  emptyPlugins.connectorSchemas.plugins = 'empty-schema';
  emptyPlugins.connectorRefresh.plugins = { schemaId: 'empty-schema', state: 'pending' };
  expect(updateReadiness(emptyPlugins).find(row => row.id === 'plugins')).toMatchObject({ status: 'skipped', detail: 'No tools published' });
  emptyPlugins.status.surfaces.at(-1).tools = ['plugin_tool'];
  expect(updateReadiness(emptyPlugins).find(row => row.id === 'plugins')!.status).toBe('not-run');
  const emptyCore = structuredClone(ready); emptyCore.status.surfaces[0].tools = []; emptyCore.connectorRefresh = {};
  expect(updateReadiness(emptyCore).find(row => row.id === 'core')!.status).toBe('not-run');
  const { setLanguage } = await import('../src/renderer/i18n.js');
  const olderExtension = structuredClone(ready); olderExtension.bridge.extensionVersion = '2.0.1';
  expect(updateReadiness(olderExtension).find(row => row.id === 'extension')!.nextStep)
    .toBe('Let active chats finish, then reload the browser extension in your browser.');
  const missingExtension = structuredClone(ready); missingExtension.bridge.present = false;
  expect(updateReadiness(missingExtension).find(row => row.id === 'extension')!.nextStep)
    .toBe('Open ChatGPT with the browser extension enabled, then choose Review setup.');
  setLanguage('ja'); expect(updateReadiness(ready).find(row => row.id === 'app')!.detail).toContain('最新版です');
});

it('uses live macOS permission verdicts only for the enabled Desktop capabilities', async () => {
  const { updateReadiness } = await import('../src/renderer/update-readiness-state.js');
  const ready = state(); ready.platform = { family: 'macos', name: 'macOS', desktopAutomation: true };
  ready.config.readOnly = false; ready.config.capabilities.screen = ready.config.capabilities.control = true;
  ready.status.surfaces.push({ ...ready.status.surfaces[0], id: 'desktop', optional: true, tools: ['screen_capture'] });
  ready.connectorSchemas.desktop = 'desktop-a'; ready.connectorRefresh.desktop = { schemaId: 'desktop-a', state: 'current' };
  ready.desktopAccess = { screen: 'granted', accessibility: 'granted', checkedAt: 1, error: null };
  const desktop = (next: any) => updateReadiness(next).find(row => row.id === 'desktop')!;
  expect(desktop(ready).status).toBe('pass');
  const missing = structuredClone(ready); missing.desktopAccess.screen = missing.desktopAccess.accessibility = 'missing';
  expect(desktop(missing)).toMatchObject({ status: 'fail' });
  expect(desktop(missing).reason).toContain('Screen Recording: required');
  expect(desktop(missing).reason).toContain('Accessibility: required');
  expect(desktop(missing).nextStep).toContain('Choose Review setup to check macOS permissions');
  const unverified = structuredClone(ready); delete unverified.desktopAccess;
  expect(desktop(unverified)).toMatchObject({ status: 'not-run' });
  expect(desktop(unverified).reason).toContain('Screen Recording: unknown');
  const screenOnly = structuredClone(missing); screenOnly.config.readOnly = true;
  expect(desktop(screenOnly).status).toBe('fail');
  expect(desktop(screenOnly).reason).not.toContain('Accessibility: required');
  screenOnly.desktopAccess.screen = 'granted'; expect(desktop(screenOnly).status).toBe('pass');
  const controlOnly = structuredClone(missing); controlOnly.config.capabilities.screen = false;
  expect(desktop(controlOnly).status).toBe('fail'); expect(desktop(controlOnly).reason).not.toContain('Screen Recording: required');
  controlOnly.config.capabilities.control = false; expect(desktop(controlOnly).status).toBe('pass');
  const off = structuredClone(missing); off.status.surfaces[1].state = 'off'; expect(desktop(off).status).toBe('skipped');
  const windows = structuredClone(missing); windows.platform.family = 'windows'; expect(desktop(windows).status).toBe('pass');
  missing.connectorRefresh.desktop = { schemaId: 'desktop-a', state: 'failed', failure: 'inspection' };
  expect(desktop(missing).reason).toContain('Could not inspect the installed plugin');
  expect(desktop(missing).nextStep).toContain("Open this plugin's settings in ChatGPT");
  expect(desktop(missing).nextStep).toContain('check macOS permissions');
});

it('explains replacement and the launch location only for a confirmed manual macOS app update', async () => {
  const { updateReadiness } = await import('../src/renderer/update-readiness-state.js');
  const manual = state(); manual.platform = { family: 'macos', name: 'macOS', desktopAutomation: true };
  manual.update.latest = '99.0.0';
  const app = (next: any) => updateReadiness(next).find(row => row.id === 'app')!;
  expect(app(manual).detail).toContain('Install 99.0.0 manually');
  expect(app(manual).nextStep).toContain('fully quit Chat On Steroids'); expect(app(manual).nextStep).toContain('/Applications');
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('ja'); expect(app(manual).nextStep).toContain('完全に終了'); expect(app(manual).nextStep).toContain('/Applications');
  setLanguage('en');
  for (const change of [
    (s: any) => { s.platform.family = 'windows'; },
    (s: any) => { s.platform.family = 'linux'; },
    (s: any) => { s.update.latest = null; },
    (s: any) => { s.update.stage = 'checking'; },
    (s: any) => { s.update.stage = 'ready'; },
    (s: any) => { s.update.stage = 'failed'; s.update.error = 'Network unavailable'; }
  ]) {
    const other = structuredClone(manual); change(other); expect(app(other).nextStep ?? '').not.toContain('/Applications');
  }
  const failed = structuredClone(manual); failed.update.stage = 'failed'; expect(app(failed).nextStep).toContain('Choose Update all to retry');
});

it.each(['2.1.33', '2.1.34', '2.1.35', null])('guides extension %s in the correct version direction', async version => {
  const { updateReadiness } = await import('../src/renderer/update-readiness-state.js');
  const next = state(); next.bridge.extensionVersion = version;
  const row = updateReadiness(next).find(row => row.id === 'extension')!;
  if (version === '2.1.33') expect(row.nextStep).toContain('reload the browser extension');
  else if (version === '2.1.34') expect(row.nextStep).toBeUndefined();
  else if (version === '2.1.35') {
    expect(row.nextStep).not.toContain('reload');
    expect(row.nextStep).toContain('update the app');
    expect(row.status).toBe('not-run');
  } else expect(row.nextStep).toContain('Review setup');
});

it.each(['de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'pt-PT', 'ru', 'tr', 'vi', 'zh-CN', 'zh-TW'])('names the actual update action in the %s recovery guidance', async locale => {
  const { updateReadiness } = await import('../src/renderer/update-readiness-state.js');
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage(locale as Parameters<typeof setLanguage>[0]);
  const catalog = JSON.parse(readFileSync(`src/renderer/locales/${locale}.json`, 'utf8'));
  const next = state(); next.bridge.extensionVersion = '2.1.35';
  expect(updateReadiness(next).find(row => row.id === 'extension')!.nextStep).toContain(catalog['Update all']);
});

it('uses the Korean setup action exactly once in the connection recovery guidance', async () => {
  const { updateReadiness } = await import('../src/renderer/update-readiness-state.js');
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('ko'); const next = state(); next.status.state = 'auth-failed';
  const row = updateReadiness(next).find(row => row.id === 'core')!;
  expect(row.nextStep).toBe('연결 설정 확인에서 연결을 확인한 후 모두 업데이트를 선택하여 다시 시도하세요.');
});
