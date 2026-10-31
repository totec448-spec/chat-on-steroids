import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

const root = path.join(process.cwd(), 'extension');
const source = readFileSync(path.join(root, 'i18n.js'), 'utf8');
const catalog = (folder: string) => JSON.parse(readFileSync(path.join(root, '_locales', folder, 'messages.json'), 'utf8'));

/** i18n.js in an extension page whose Chrome is German, paired with an app set to `appLanguage`. */
async function load(appLanguage: string | undefined, protocol = 'chrome-extension:', missing: string[] = [], options: { workerLanguage?: string; storageHangs?: boolean } = {}) {
  const german = catalog('de');
  const listeners: Array<(changes: Record<string, { newValue: unknown }>, area: string) => void> = [];
  const stored: Record<string, unknown> = appLanguage ? { appLanguage } : {};
  const sent: unknown[] = [];
  const chrome = {
    i18n: {
      // As Chrome does: $1…$9 take the substitutions, given as one value or an array.
      getMessage: (key: string, values?: unknown) => String(german[key]?.message ?? '')
        .replace(/\$([1-9])/g, (token, index) => { const list = Array.isArray(values) ? values : values === undefined ? [] : [values]; return String(list[Number(index) - 1] ?? token); }),
      getUILanguage: () => 'de'
    },
    storage: {
      local: { get: () => options.storageHangs ? new Promise(() => undefined) : Promise.resolve({ ...stored }) },
      onChanged: { addListener: (listener: (typeof listeners)[number]) => listeners.push(listener) }
    },
    runtime: {
      getURL: (file: string) => file,
      sendMessage: async (message: { language?: string; current?: boolean }) => {
        sent.push(message);
        // The worker names the language it applied from the app's last status, or none yet.
        const language = message.current ? options.workerLanguage : message.language;
        if (!language) return { ok: false };
        return { ok: true, ...(message.current ? { language } : {}), messages: catalog(language === 'zh-CN' ? 'zh_CN' : language) };
      }
    }
  };
  const fetch = async (file: string) => {
    if (missing.some(folder => file.includes(`_locales/${folder}/`))) return { ok: false, json: async () => null };
    try { return { ok: true, json: async () => JSON.parse(readFileSync(path.join(root, file), 'utf8')) }; } catch { return { ok: false, json: async () => null }; }
  };
  const context: Record<string, unknown> = { chrome, fetch, setTimeout, clearTimeout, location: { protocol }, CustomEvent: class { constructor(public type: string) {} } };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  const api = context.CLF_I18N as { t: (key: string, fallback?: string, values?: unknown) => string; tn: (key: string, count: number, one: string, other: string, values?: unknown[]) => string; ready: Promise<void>; language: () => string | null };
  await api.ready;
  const change = async (language: string) => { for (const listener of listeners) listener({ appLanguage: { newValue: language } }, 'local'); await new Promise(resolve => setTimeout(resolve, 10)); };
  return { api, sent, change };
}

it('shows the app language rather than Chrome\'s, in pages and in content scripts', async () => {
  const page = await load('en');
  expect(page.api.t('content_app_did_not_answer', 'fallback')).toBe('The app did not answer.');
  const content = await load('en', 'https:');
  expect(content.api.t('content_app_did_not_answer', 'fallback')).toBe('The app did not answer.');
  expect(content.sent).toEqual([{ type: 'i18n_catalog', current: true }, { type: 'i18n_catalog', language: 'en' }]);
});

// CodeRabbit on #1940: a page whose storage read never answers still shows the app language, because
// it asks the worker which language it applied. The stored copy stays the fallback for a worker that
// has not heard from the app yet.
it('takes the worker\'s applied language when the page\'s storage read never answers', async () => {
  for (const protocol of ['chrome-extension:', 'https:']) {
    const page = await load(undefined, protocol, [], { workerLanguage: 'en', storageHangs: true });
    expect(page.api.language()).toBe('en');
    expect(page.api.t('content_app_did_not_answer', 'fallback')).toBe('The app did not answer.');
  }
  const unknown = await load('en', 'https:', [], {});
  expect(unknown.api.language()).toBe('en');
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

function follower(store: Record<string, unknown>, storage: { get?: (keys: string[]) => Promise<unknown>; set?: (value: Record<string, unknown>) => Promise<void> } = {}) {
  const writes: Array<Record<string, unknown>> = [];
  const context = vm.createContext({
    RENDER_STREAM_KEY: 'renderStreamEnabled', SHOW_TIMES_KEY: 'showStreamTimes', setTimeout, clearTimeout,
    chrome: { storage: { local: {
      get: storage.get ?? (async (keys: string[]) => Object.fromEntries(keys.filter(key => key in store).map(key => [key, store[key]]))),
      set: storage.set ?? (async (value: Record<string, unknown>) => { writes.push(value); Object.assign(store, value); })
    } } }
  });
  vm.runInContext(`${followCode}\nglobalThis.follow = followApp; globalThis.state = appLanguageState; globalThis.settled = followSettled;`, context);
  const follow = (data: unknown) => (context.follow as (data: unknown) => Promise<void>)(data);
  return Object.assign(follow, { writes, state: () => (context.state as () => unknown)(), settled: () => (context.settled as () => Promise<void>)() });
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

// 2026-10-30: the extension in the maintainer's Chrome never stored the app's language (no write in its
// storage in weeks, the same build stored it at once on the test machine) and showed Chrome's German until
// its worker was restarted. A storage read that never answers must not keep the app's language out.
it('takes the app language even when a storage read never answers, and says so in diagnostics', async () => {
  vi.useFakeTimers();
  try {
    const store: Record<string, unknown> = {};
    const follow = follower(store, { get: () => new Promise(() => undefined) });
    const done = follow({ language: 'en' });
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
    expect(store).toEqual({ appLanguage: 'en' });
    expect(follow.state()).toEqual({ applied: 'en', error: 'storage read did not answer within 5 s' });
  } finally { vi.useRealTimers(); }
});

it('writes the app language once per worker, not on every status, and again when it changes', async () => {
  const store: Record<string, unknown> = {};
  const follow = follower(store);
  await follow({ language: 'en' });
  await follow({ language: 'en' });
  await follow({ language: 'en' });
  expect(follow.writes).toEqual([{ appLanguage: 'en' }]);
  await follow({ language: 'de' });
  expect(follow.writes).toEqual([{ appLanguage: 'en' }, { appLanguage: 'de' }]);
  expect(follow.state()).toEqual({ applied: 'de', error: null });
});

it('applies statuses in order, so a slow older read cannot write its language last (CodeRabbit on #1940)', async () => {
  const store: Record<string, unknown> = {};
  let releaseFirst!: () => void;
  let reads = 0;
  const follow = follower(store, { get: async (keys: string[]) => {
    reads += 1;
    if (reads === 1) await new Promise<void>(resolve => { releaseFirst = resolve; });
    return Object.fromEntries(keys.filter(key => key in store).map(key => [key, store[key]]));
  } });
  const older = follow({ language: 'en' });
  const newer = follow({ language: 'de' });
  await new Promise(resolve => setTimeout(resolve, 10));
  releaseFirst();
  await Promise.all([older, newer]);
  expect(store).toEqual({ appLanguage: 'de' });
  expect(follow.writes).toEqual([{ appLanguage: 'en' }, { appLanguage: 'de' }]);
});

// CodeRabbit on #1940: statuses arrive faster than a slow read finishes. Only the newest waiting one
// runs next, so a burst cannot hold a newer language back behind a queue of reads.
it('keeps only the newest waiting status while one is applied', async () => {
  const store: Record<string, unknown> = {};
  let releaseFirst!: () => void;
  let reads = 0;
  const follow = follower(store, { get: async (keys: string[]) => {
    reads += 1;
    if (reads === 1) await new Promise<void>(resolve => { releaseFirst = resolve; });
    return Object.fromEntries(keys.filter(key => key in store).map(key => [key, store[key]]));
  } });
  const kept = { overwrite: false, durations: true };
  const runs = [follow({ language: 'en', browserPreferences: kept })];
  for (let i = 0; i < 20; i++) runs.push(follow({ language: 'en', browserPreferences: kept }));
  runs.push(follow({ language: 'de', browserPreferences: kept }));
  await new Promise(resolve => setTimeout(resolve, 10));
  releaseFirst();
  await Promise.all(runs);
  expect(reads).toBe(2);
  expect(store.appLanguage).toBe('de');
});

// CodeRabbit on #1940: a write that never answers is bounded like the read, so it neither blocks the
// statuses after it nor stays silent in diagnostics; and a snapshot can wait for an in-flight write.
it('gives up on a write that never answers, says so, and still applies the next status', async () => {
  vi.useFakeTimers();
  try {
    const store: Record<string, unknown> = {};
    let hang = true;
    const follow = follower(store, { set: value => hang ? new Promise(() => undefined) : (Object.assign(store, value), Promise.resolve()) });
    const first = follow({ language: 'en' });
    let settled = false;
    void (follow as any).settled().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await first;
    expect(settled).toBe(true);
    expect(follow.state()).toEqual({ applied: 'en', error: 'storage write did not answer within 5 s' });
    hang = false;
    await follow({ language: 'en' });
    expect(store).toEqual({ appLanguage: 'en' });
    expect(follow.state()).toEqual({ applied: 'en', error: null });
  } finally { vi.useRealTimers(); }
});

// CodeRabbit on #1940: a write that timed out can still land later. Until one is confirmed, the next
// status writes again, even for the language this worker applied before.
it('writes again after a timed-out write that lands late, even for the language applied before', async () => {
  vi.useFakeTimers();
  try {
    const store: Record<string, unknown> = {};
    let late: (() => void) | null = null;
    let slow = false;
    const follow = follower(store, { set: value => {
      if (!slow) { Object.assign(store, value); return Promise.resolve(); }
      return new Promise<void>(resolve => { late = () => { Object.assign(store, value); resolve(); }; });
    } });
    await follow({ language: 'de' });
    slow = true;
    const timedOut = follow({ language: 'en' });
    await vi.advanceTimersByTimeAsync(5_000);
    await timedOut;
    late!();
    expect(store.appLanguage).toBe('en');
    slow = false;
    await follow({ language: 'de' });
    expect(store.appLanguage).toBe('de');
    expect(follow.state()).toEqual({ applied: 'de', error: null });
  } finally { vi.useRealTimers(); }
});

// CodeRabbit on #1940: a status with kept preferences but no language does not confirm a language
// whose write failed, so the next status with that language still writes it.
it('keeps retrying a failed language write across a preferences-only status', async () => {
  const store: Record<string, unknown> = {};
  let refuse = true;
  const follow = follower(store, { set: async value => { if (refuse && 'appLanguage' in value) throw new Error('write refused'); Object.assign(store, value); } });
  await follow({ language: 'en' });
  refuse = false;
  await follow({ browserPreferences: { overwrite: false, durations: true } });
  expect(store.appLanguage).toBeUndefined();
  // Diagnostics keep saying why the language is unsaved.
  expect(follow.state()).toEqual({ applied: 'en', error: 'write refused' });
  await follow({ language: 'en' });
  expect(store.appLanguage).toBe('en');
});

it('keeps the language write\'s error when a later preferences-only write fails too', async () => {
  const store: Record<string, unknown> = {};
  const follow = follower(store, { set: async value => { throw new Error('appLanguage' in value ? 'language refused' : 'preferences refused'); } });
  await follow({ language: 'en' });
  await follow({ browserPreferences: { overwrite: false, durations: true } });
  expect(follow.state()).toEqual({ applied: 'en', error: 'language refused' });
  // With the language saved, a failing preferences write is the error to show.
  const saved: Record<string, unknown> = {};
  const other = follower(saved, { set: async value => { if (!('appLanguage' in value)) throw new Error('preferences refused'); Object.assign(saved, value); } });
  await other({ language: 'en' });
  await other({ browserPreferences: { overwrite: false, durations: true } });
  expect(other.state()).toEqual({ applied: 'en', error: 'preferences refused' });
});

it('keeps a refused write for diagnostics and tries again on the next status', async () => {
  const store: Record<string, unknown> = {};
  let refuse = true;
  const follow = follower(store, { set: async value => { if (refuse) throw new Error('QUOTA_BYTES quota exceeded'); Object.assign(store, value); } });
  await follow({ language: 'en' });
  expect(follow.state()).toEqual({ applied: 'en', error: 'QUOTA_BYTES quota exceeded' });
  refuse = false;
  await follow({ language: 'en' });
  expect(store).toEqual({ appLanguage: 'en' });
  expect(follow.state()).toEqual({ applied: 'en', error: null });
});

// Counts take the app language's plural form: Russian has three (1/21, 2–4, 5–20), and before
// tn every count read "$1 вызовов инструментов", wrong for 1, 2–4 and 21.
it('words a count in the app language\'s plural form, and in Chrome\'s before the app has named one', async () => {
  const ru = await load('ru');
  const calls = (count: number) => ru.api.tn('content_tool_calls_count', count, '$1 tool call', '$1 tool calls');
  expect([1, 2, 5, 21, 11].map(calls)).toEqual(['1 вызов инструмента', '2 вызова инструментов', '5 вызовов инструментов', '21 вызов инструмента', '11 вызовов инструментов']);
  const en = await load('en');
  expect([1, 3].map(count => en.api.tn('content_tool_calls_count', count, 'x', 'y'))).toEqual(['1 tool call', '3 tool calls']);
  // No app language yet: Chrome's German catalog and German plural rules.
  const chrome = await load(undefined);
  expect([1, 2].map(count => chrome.api.tn('content_tool_calls_count', count, 'x', 'y'))).toEqual(['1 Tool-Aufruf', '2 Tool-Aufrufe']);
  // A display value differs from the count that picks the form.
  expect(en.api.tn('content_tokens_from', 50_000, 'from $1 token', 'from $1 tokens', ['50k'])).toBe('from 50k tokens');
  expect(ru.api.tn('content_tool_calls_count', Number.NaN, 'x', 'y', ['?'])).toBe('? вызова инструментов');
});
