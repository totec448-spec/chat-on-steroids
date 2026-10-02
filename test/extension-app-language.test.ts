import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { expect, it } from 'vitest';

const root = path.join(process.cwd(), 'extension');
const source = readFileSync(path.join(root, 'i18n.js'), 'utf8');
const catalog = (folder: string) => JSON.parse(readFileSync(path.join(root, '_locales', folder, 'messages.json'), 'utf8'));

/** i18n.js in an extension page whose Chrome is German, paired with an app set to `appLanguage`. */
async function load(appLanguage: string | undefined, protocol = 'chrome-extension:', missing: string[] = []) {
  const german = catalog('de');
  const listeners: Array<(changes: Record<string, { newValue: unknown }>, area: string) => void> = [];
  const stored: Record<string, unknown> = appLanguage ? { appLanguage } : {};
  const sent: unknown[] = [];
  const chrome = {
    i18n: { getMessage: (key: string) => german[key]?.message ?? '', getUILanguage: () => 'de' },
    storage: {
      local: { get: async () => ({ ...stored }) },
      onChanged: { addListener: (listener: (typeof listeners)[number]) => listeners.push(listener) }
    },
    runtime: {
      getURL: (file: string) => file,
      sendMessage: async (message: { language: string }) => {
        sent.push(message);
        return { ok: true, messages: catalog(message.language === 'zh-CN' ? 'zh_CN' : message.language) };
      }
    }
  };
  const fetch = async (file: string) => {
    if (missing.some(folder => file.includes(`_locales/${folder}/`))) return { ok: false, json: async () => null };
    try { return { ok: true, json: async () => JSON.parse(readFileSync(path.join(root, file), 'utf8')) }; } catch { return { ok: false, json: async () => null }; }
  };
  const context: Record<string, unknown> = { chrome, fetch, location: { protocol }, CustomEvent: class { constructor(public type: string) {} } };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  const api = context.CLF_I18N as { t: (key: string, fallback?: string, values?: unknown) => string; ready: Promise<void>; language: () => string | null };
  await api.ready;
  const change = async (language: string) => { for (const listener of listeners) listener({ appLanguage: { newValue: language } }, 'local'); await new Promise(resolve => setTimeout(resolve, 10)); };
  return { api, sent, change };
}

it('shows the app language rather than Chrome\'s, in pages and in content scripts', async () => {
  const page = await load('en');
  expect(page.api.t('content_app_did_not_answer', 'fallback')).toBe('The app did not answer.');
  const content = await load('en', 'https:');
  expect(content.api.t('content_app_did_not_answer', 'fallback')).toBe('The app did not answer.');
  expect(content.sent).toEqual([{ type: 'i18n_catalog', language: 'en' }]);
});

it('keeps Chrome\'s language until the app has named one, and follows a later change', async () => {
  const page = await load(undefined);
  expect(page.api.t('content_app_did_not_answer', 'fallback')).toBe('Die App hat nicht geantwortet.');
  await page.change('en');
  expect(page.api.language()).toBe('en');
  expect(page.api.t('content_app_did_not_answer', 'fallback')).toBe('The app did not answer.');
});

it('reads a language the extension has no catalog for yet as English, not as Chrome\'s', async () => {
  // Every shipped language has a catalog today, so the missing one is simulated: a language the app
  // adds before the extension has its translation.
  const page = await load('ko', 'chrome-extension:', ['ko']);
  expect(page.api.t('content_app_did_not_answer', 'fallback')).toBe('The app did not answer.');
});

it('fills $1 substitutions from the app catalog', async () => {
  const page = await load('en');
  const english = catalog('en');
  const key = Object.keys(english).find(name => english[name].message.includes('$1'))!;
  expect(page.api.t(key, 'fallback', ['VALUE'])).toBe(english[key].message.replace('$1', 'VALUE'));
});

const background = readFileSync(path.join(root, 'background.js'), 'utf8');
const followCode = background.slice(background.indexOf('const APP_LANGUAGE_KEY'), background.indexOf('let extensionReloadPending = false;'));

function follower(store: Record<string, unknown>) {
  const context = vm.createContext({
    RENDER_STREAM_KEY: 'renderStreamEnabled', SHOW_TIMES_KEY: 'showStreamTimes',
    chrome: { storage: { local: {
      get: async (keys: string[]) => Object.fromEntries(keys.filter(key => key in store).map(key => [key, store[key]])),
      set: async (value: Record<string, unknown>) => { Object.assign(store, value); }
    } } }
  });
  vm.runInContext(`${followCode}\nglobalThis.follow = followApp;`, context);
  return (data: unknown) => (context.follow as (data: unknown) => Promise<void>)(data);
}

it('takes the app language and gives a reinstalled extension its kept preferences back', async () => {
  const fresh: Record<string, unknown> = {};
  await follower(fresh)({ language: 'en', browserPreferences: { overwrite: false, durations: true } });
  expect(fresh).toEqual({ appLanguage: 'en', renderStreamEnabled: false, showStreamTimes: true });
});

it('never overwrites preferences the extension itself stored, nor takes an unknown language', async () => {
  const used: Record<string, unknown> = { showStreamTimes: false, appLanguage: 'de' };
  await follower(used)({ language: 'xx', browserPreferences: { overwrite: false, durations: true } });
  expect(used).toEqual({ showStreamTimes: false, appLanguage: 'de' });
});
