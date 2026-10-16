import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

/**
 * 2026-10-15: the diagnostics report names the browser, counts ChatGPT tabs by state and says which
 * of ChatGPT's controls the extension still finds. Names, versions, counts and booleans only.
 */
const source = readFileSync('extension/background.js', 'utf8');
const start = source.indexOf('async function browserIdentity()');
const code = source.slice(start, source.indexOf('\n/** Snapshot sent only to the current paired bridge', start));

type Tab = { id: number; windowId: number; url: string; status?: string; discarded?: boolean; frozen?: boolean; groupId?: number; incognito?: boolean; lastAccessed?: number };
function environment(options: { tabs: Tab[]; browser?: unknown; navigator?: unknown; backgroundWindow?: number | null; reply?: (id: number) => unknown }) {
  const tabReply = vi.fn(async (id: number) => {
    const answer = options.reply ? options.reply(id) : { composer: true, sendArea: true, modelMenu: true, plusMenu: true, language: 'de-DE' };
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const context = vm.createContext({
    chrome: { tabs: { query: async () => options.tabs } },
    ...(options.browser ? { browser: options.browser } : {}),
    navigator: options.navigator ?? {},
    CHATGPT_TAB_URLS: ['https://chatgpt.com/*'],
    storedBackgroundWindow: async () => options.backgroundWindow ? { id: options.backgroundWindow } : null,
    tabReply
  });
  const run = vm.runInContext(`${code}\nenvironmentDiagnostics`, context) as () => Promise<unknown>;
  return { run, tabReply };
}

const tabs: Tab[] = [
  { id: 1, windowId: 5, url: 'https://chatgpt.com/c/a', status: 'complete', lastAccessed: 100 },
  { id: 2, windowId: 5, url: 'https://chatgpt.com/c/b', status: 'complete', discarded: true, lastAccessed: 900 },
  { id: 3, windowId: 9, url: 'https://chatgpt.com/c/c', status: 'complete', frozen: true, groupId: 4, lastAccessed: 800 },
  { id: 4, windowId: 9, url: 'https://chatgpt.com/c/d', status: 'loading', groupId: 4, lastAccessed: 700 },
  { id: 6, windowId: 5, url: 'https://chatgpt.com/c/e', status: 'complete', lastAccessed: 500 }
];

it('names Chrome-family browsers by their brand and counts ChatGPT tabs by state', async () => {
  const navigator = { userAgentData: { brands: [], getHighEntropyValues: async () => ({ fullVersionList: [
    { brand: 'Not)A;Brand', version: '99.0.0.0' }, { brand: 'Chromium', version: '154.0.7400.12' }, { brand: 'Google Chrome', version: '154.0.7400.12' }] }) } };
  const { run, tabReply } = environment({ tabs, navigator, backgroundWindow: 9 });
  expect(await run()).toEqual({
    browser: { name: 'Google Chrome', version: '154.0.7400.12' },
    tabs: { open: 5, discarded: 1, frozen: 1, loading: 1, grouped: 2, inBackgroundWindow: 2 },
    page: { composer: true, sendArea: true, modelMenu: true, plusMenu: true, language: 'de-DE' }
  });
  // The most recently used tab that is awake and loaded answers, not a discarded or frozen one.
  expect(tabReply).toHaveBeenCalledExactlyOnceWith(6, { type: 'clf-page-checks' });
});

it('names Firefox from its own browser info', async () => {
  const { run } = environment({ tabs: [], browser: { runtime: { getBrowserInfo: async () => ({ name: 'Firefox', version: '144.0' }) } } });
  expect(await run()).toEqual({ browser: { name: 'Firefox', version: '144.0' },
    tabs: { open: 0, discarded: 0, frozen: 0, loading: 0, grouped: 0, inBackgroundWindow: 0 }, page: null });
});

it('keeps only names, versions and booleans, whatever a page or the browser answers', async () => {
  const navigator = { userAgentData: { brands: [{ brand: 'Evil <b>Brand</b> with a very long name that goes on', version: '1' }] } };
  const { run } = environment({ tabs: [tabs[0]!], navigator,
    reply: () => ({ composer: 'yes', sendArea: true, modelMenu: 1, plusMenu: false, language: 'en', text: 'private chat text' }) });
  expect(await run()).toEqual({ browser: { name: 'unknown', version: null },
    tabs: { open: 1, discarded: 0, frozen: 0, loading: 0, grouped: 0, inBackgroundWindow: 0 },
    page: { composer: false, sendArea: true, modelMenu: false, plusMenu: false, language: 'en' } });
});

it('reports no page when no tab can answer', async () => {
  const { run } = environment({ tabs: [tabs[0]!], reply: () => new Error('no receiver') });
  expect((await run() as { page: unknown }).page).toBeNull();
});
