import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { load as loadYaml } from 'js-yaml';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { APP_DISPLAY_NAME } from '../src/shared/app-brand-name.js';
import { MAIN_TEXTS } from '../src/shared/main-texts.js';

const name = `${APP_DISPLAY_NAME} (dev)` as const;
const about = `About ${APP_DISPLAY_NAME} (dev)` as const;
const read = (file: string) => readFileSync(file, 'utf8');
const native = vi.hoisted(() => ({
  app: { isPackaged: false, setAboutPanelOptions: vi.fn(), setName: vi.fn(), getVersion: () => '2.1.55' },
  Menu: { getApplicationMenu: vi.fn(), buildFromTemplate: vi.fn((items: unknown[]) => ({ items })), setApplicationMenu: vi.fn() }
}));
vi.mock('electron', () => native);
let dom: JSDOM;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); native.app.isPackaged = false;
  vi.stubEnv('COS_DEV_BRAND', '');
  dom = new JSDOM(read('src/renderer/index.html'), { url: 'https://local.test/' });
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement'] as const) {
    vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key]);
  }
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); dom.window.close(); });

it.each(['en', 'ja', 'de', 'es', 'fr', 'ko', 'pt-BR', 'pt-PT', 'ru', 'tr', 'vi', 'zh-CN', 'zh-TW'] as const)('binds main-selected names through %s localization', async language => {
  const i18n = await import('../src/renderer/i18n.js');
  const { applyAppBrand } = await import('../src/renderer/app-brand.js');
  i18n.initLanguage();
  expect(document.title).toBe('');
  for (const displayName of [name, APP_DISPLAY_NAME] as const) {
    applyAppBrand(displayName); i18n.setLanguage(language);
    expect(document.title).toBe(displayName);
    expect(document.querySelector('.sidebar-brand strong')?.textContent).toBe(displayName);
    expect(document.querySelector('.chat-head .title')?.textContent).toContain(displayName);
    const { mainTexts } = await import('../src/renderer/main-texts.js');
    expect(mainTexts()[displayName]).toBe(displayName);
    expect(mainTexts()[about]).toBe(language === 'ja' ? `${name}について` : about);
  }
});

it('registers all display keys directly in Japanese and English', () => {
  for (const key of [name, APP_DISPLAY_NAME, about]) {
    expect(MAIN_TEXTS).toContain(key);
    for (const language of ['en', 'ja']) {
      const catalog = JSON.parse(read(`src/renderer/locales/${language}.json`));
      expect(Object.hasOwn(catalog, key)).toBe(true);
      expect(catalog[key]).toBe(key === about && language === 'ja' ? `${name}について` : key);
    }
  }
});

it.each([
  { packaged: false, override: '', development: true },
  { packaged: true, override: '', development: false },
  { packaged: true, override: '1', development: true },
  { packaged: true, override: '0', development: false }
])('selects native labels for packaged=$packaged override=$override', async ({ packaged, override, development }) => {
  native.app.isPackaged = packaged; vi.stubEnv('COS_DEV_BRAND', override);
  const otherMenu = { label: 'File' }, quit = { role: 'quit' };
  native.Menu.getApplicationMenu.mockReturnValue({ items: [{ label: 'Electron', submenu: { items: [{ role: 'about' }, quit] } }, otherMenu] });
  const { appBrand, refreshNativeBrand } = await import('../src/main/app-brand.js');
  const displayName = development ? name : APP_DISPLAY_NAME;
  expect(appBrand).toEqual({ development, displayName });
  const window = { isDestroyed: () => false, setTitle: vi.fn() };
  refreshNativeBrand(window as never);
  expect(native.app.setAboutPanelOptions).toHaveBeenCalledWith({ applicationName: displayName, applicationVersion: '2.1.55' });
  expect(window.setTitle).toHaveBeenCalledWith(displayName);
  expect(native.app.setName).not.toHaveBeenCalled();
  if (development && process.platform === 'darwin') {
    expect(native.Menu.setApplicationMenu).toHaveBeenCalledWith({ items: [
      { label: 'Electron', submenu: { items: [{ role: 'about', label: about }, quit] } }, otherMenu
    ] });
  } else expect(native.Menu.setApplicationMenu).not.toHaveBeenCalled();
});

it('preserves literal package identity and the production tooltip status', () => {
  const pkg = JSON.parse(read('package.json'));
  const builder = loadYaml(read('electron-builder.yml')) as Record<string, unknown>;
  expect(pkg.name).toBe('chat-on-steroids'); expect(pkg.productName).toBeUndefined();
  expect(builder.productName).toBe('Chat On Steroids'); expect(builder.appId).toBe('com.chatonsteroids.app');
  const main = read('src/main/index.ts');
  expect(main).toContain('tray.setToolTip(appBrand.development ? mainText(appBrand.displayName) : `Chat On Steroids — ${label}`)');
  expect(read('src/main/ipc.ts')).toContain('displayName: appBrand.displayName');
  expect(read('src/renderer/main.ts')).toContain('if (next.displayName) applyAppBrand(next.displayName)');
  expect(read('src/renderer/index.html')).not.toContain('(dev)');
  expect((main + read('src/main/app-brand.ts')).replace(/\/\/[^\n]*/g, '')).not.toMatch(/app\.setName\s*\(|app\.setPath\s*\(|app\.name\s*=/);
});
