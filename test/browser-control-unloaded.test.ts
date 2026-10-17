import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

// #1568: Chrome accepts a debugger on a discarded tab, then never answers Page.enable.
// Fixture shape after @hisero-mais's draft in #1569.
const source = readFileSync('extension/browser-control.js', 'utf8')
  .replace(/^import .*\n/, '').replace('export function ', 'function ');

type Listener = (tabId: number, change?: unknown) => void;

async function fixture(options: {
  status?: string; discarded?: boolean; write?: boolean; allowed?: boolean; owner?: string;
  protectedPage?: boolean; reload?: 'completes' | 'fails' | 'stalls' | 'closes';
} = {}) {
  const { status = 'unloaded', discarded = status === 'unloaded', write = true, allowed = true, owner,
    protectedPage = false, reload = 'completes' } = options;
  let tab: { id: number; url: string; title: string; status: string; discarded: boolean } | null =
    { id: 17, url: 'https://fixture.invalid/', title: 'Fixture', status, discarded };
  const calls: string[] = [];
  const updated = new Set<Listener>(), removed = new Set<Listener>();
  let saved = { cosBrowserControl: { browserId: randomUUID(), epoch: 'epoch', receipt: null,
    tabs: owner ? [{ tabId: 17, owner, lease: 'existing-lease' }] : [] as { tabId: number; owner: string; lease: string }[] } };
  const chrome = {
    storage: { session: { get: vi.fn(async () => saved), set: vi.fn(async (next: typeof saved) => { saved = next; }) } },
    permissions: { contains: vi.fn(async () => true) },
    tabs: {
      get: vi.fn(async () => { if (!tab) throw new Error('No tab with id: 17.'); return { ...tab }; }),
      reload: vi.fn(async (tabId: number) => {
        calls.push(`reload:${tabId}`);
        if (reload === 'fails') throw new Error('Cannot reload this tab');
        tab = { ...tab!, status: 'loading', discarded: false };
        setTimeout(() => {
          if (reload === 'stalls') return;
          if (reload === 'closes') { tab = null; removed.forEach(listener => listener(17)); return; }
          tab = { ...tab!, status: 'complete' };
          updated.forEach(listener => listener(17, { status: 'complete' }));
        }, 5);
      }),
      onUpdated: { addListener: (listener: Listener) => updated.add(listener), removeListener: (listener: Listener) => updated.delete(listener) },
      onRemoved: { addListener: (listener: Listener) => removed.add(listener), removeListener: (listener: Listener) => removed.delete(listener) }
    },
    scripting: { executeScript: vi.fn(async () => []) },
    debugger: {
      attach: vi.fn(async () => { calls.push('attach'); }),
      detach: vi.fn(async () => { calls.push('detach'); }),
      getTargets: vi.fn(async () => [{ tabId: 17, attached: true }]),
      sendCommand: vi.fn(async (_target: unknown, method: string) => {
        calls.push(method);
        if (method === 'Page.enable' && tab?.status === 'unloaded') return new Promise(() => undefined);
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', url: 'https://fixture.invalid/' } } };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
        if (method === 'Runtime.evaluate') return { result: { value: { ok: true } } };
        return {};
      })
    }
  };
  const create = runInNewContext(`${source};createBrowserControl`, {
    browserPage: () => ({ ok: true }), boundedBrowserValue: (value: unknown) => value, browserFramePoint: (value: unknown) => value,
    crypto: { randomUUID }, navigator: { userAgent: 'Chrome' }, setTimeout, clearTimeout, TextEncoder, URL
  });
  const transport = vi.fn(async (_path: string, init?: { body?: string }) => {
    const request = JSON.parse(init?.body || '{}');
    if (request.action === 'check') return { ok: true, data: { allowed } };
    return { ok: true, data: { epoch: 'epoch', policy: { read: true, write }, requests: [] } };
  });
  const control = create(chrome, transport, () => protectedPage);
  await control.pump();
  const command = (action: string, who = 'session:mine', expiresIn = 25_000) => ({ id: randomUUID(), epoch: 'epoch', owner: who,
    conversationId: null, tool: 'browser_tabs', args: { action, tabId: 17 }, expiresAt: Date.now() + expiresIn });
  return { chrome, control, command, calls, listeners: () => updated.size + removed.size, saved: () => saved.cosBrowserControl };
}

afterEach(() => vi.useRealTimers());

describe('attaching to a tab Chrome discarded (#1568)', () => {
  it.each([
    ['unloaded', { status: 'unloaded' }],
    ['marked discarded', { status: 'complete', discarded: true }]
  ])('restores the same %s tab before the debugger, then attaches and releases cleanly', async (_name, state) => {
    const { chrome, control, command, calls, listeners, saved } = await fixture(state);
    expect(await control.execute(command('attach'))).toMatchObject({ value: { attached: true } });
    expect(chrome.tabs.reload).toHaveBeenCalledExactlyOnceWith(17);
    expect(calls.indexOf('reload:17')).toBeLessThan(calls.indexOf('attach'));
    expect(calls.indexOf('attach')).toBeLessThan(calls.indexOf('Page.enable'));
    expect(listeners()).toBe(0);
    expect(await control.execute(command('release'))).toMatchObject({ value: { released: true } });
    expect(saved().tabs).toEqual([]);
  });

  it('never reloads a loaded tab', async () => {
    const { chrome, control, command } = await fixture({ status: 'complete' });
    expect(await control.execute(command('attach'))).toMatchObject({ value: { attached: true } });
    expect(chrome.tabs.reload).not.toHaveBeenCalled();
  });

  it.each([
    ['without write permission', { write: false }, /BROWSER_TAB_UNLOADED: .*write permission/],
    ['after permission was revoked', { allowed: false }, /BROWSER_PERMISSION_REVOKED/],
    ['for a tab another conversation owns', { owner: 'session:other' }, /BROWSER_TAB_OWNED/],
    ['for the tab running ChatGPT orchestration', { protectedPage: true }, /BROWSER_EXECUTOR_TAB/]
  ])('does not touch an unloaded tab %s', async (_name, options, refusal) => {
    const { chrome, control, command, saved } = await fixture(options);
    const before = saved().tabs;
    await expect(control.execute(command('attach'))).rejects.toThrow(refusal);
    expect(chrome.tabs.reload).not.toHaveBeenCalled();
    expect(chrome.debugger.attach).not.toHaveBeenCalled();
    expect(chrome.debugger.detach).not.toHaveBeenCalled();
    expect(saved().tabs).toEqual(before);
  });

  it.each([
    ['Chrome refuses the reload', 'fails', /BROWSER_TAB_UNLOADED: Chrome did not reload this tab/],
    ['the tab never finishes loading', 'stalls', /BROWSER_TAB_UNLOADED: .*did not finish loading/],
    ['the tab is closed while it loads', 'closes', /BROWSER_TAB_CLOSED/]
  ] as const)('fails plainly without a debugger or custody when %s', async (_name, reload, refusal) => {
    const { chrome, control, command, listeners, saved } = await fixture({ reload });
    // A short command: the restore wait is bounded by the command's own deadline.
    await expect(control.execute(command('attach', 'session:mine', 2_000))).rejects.toThrow(refusal);
    expect(chrome.debugger.attach).not.toHaveBeenCalled();
    expect(listeners()).toBe(0);
    expect(saved().tabs).toEqual([]);
  });
});
