import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MacOSDesktopAccessStatus } from '../src/shared/types.js';

/**
 * Live 2026-10-15: after an update, Desktop permissions were reported missing in Settings only;
 * the chat said nothing, and Settings told the person to grant what System Settings already
 * showed as granted. The chat now says so too, and a grant that an earlier version held offers
 * the repair instead.
 */
let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
});
afterEach(() => dom.window.close());

const state = (access: Partial<MacOSDesktopAccessStatus> | null, options: { family?: string; screen?: boolean; control?: boolean; readOnly?: boolean } = {}) => ({
  platform: { family: options.family ?? 'macos' },
  config: { capabilities: { screen: options.screen ?? true, control: options.control ?? true }, readOnly: options.readOnly ?? false },
  desktopAccess: access === null ? null : { screen: 'granted', accessibility: 'granted', checkedAt: 1, error: null, ...access }
}) as any;

it('offers the repair in the chat when a permission an earlier version held is missing', async () => {
  const { paintDesktopAccessNotice } = await import('../src/renderer/desktop-access-notice.js');
  const actions = { repair: vi.fn(), open: vi.fn() };
  const notice = document.getElementById('desktopAccessNotice')!;
  paintDesktopAccessNotice(state({ screen: 'missing', grantedBefore: { screen: true, accessibility: true } }), actions);
  expect(notice.hidden).toBe(false);
  expect(notice.textContent).toContain('macOS still shows it as allowed');
  const repair = document.getElementById('desktopAccessNoticeRepair') as HTMLButtonElement;
  expect(repair.hidden).toBe(false);
  repair.click();
  expect(actions.repair).toHaveBeenCalledOnce();
});

// Live 2026-10-16: the first version that remembers grants has no memory of the ones an earlier
// version held, so the case looks like "never given" although System Settings shows it allowed.
// Repair only resets this app's own entry and asks again, so it is offered either way.
it('offers Repair and Settings when no earlier grant is remembered', async () => {
  const { paintDesktopAccessNotice } = await import('../src/renderer/desktop-access-notice.js');
  const actions = { repair: vi.fn(), open: vi.fn() };
  paintDesktopAccessNotice(state({ accessibility: 'missing', grantedBefore: { screen: true, accessibility: false } }), actions);
  const notice = document.getElementById('desktopAccessNotice')!;
  expect(notice.hidden).toBe(false);
  expect(notice.textContent).toContain('has not given Chat On Steroids');
  expect((document.getElementById('desktopAccessNoticeRepair') as HTMLButtonElement).hidden).toBe(false);
  (document.getElementById('desktopAccessNoticeRepair') as HTMLButtonElement).click();
  expect(actions.repair).toHaveBeenCalledOnce();
  (document.getElementById('desktopAccessNoticeOpen') as HTMLButtonElement).click();
  expect(actions.open).toHaveBeenCalledOnce();
});

it('stays quiet when nothing needed is missing, or the answer is not known yet', async () => {
  const { desktopAccessProblem, paintDesktopAccessNotice } = await import('../src/renderer/desktop-access-notice.js');
  const notice = document.getElementById('desktopAccessNotice')!;
  const actions = { repair: vi.fn(), open: vi.fn() };
  for (const next of [
    state({}),
    state({ screen: 'unknown', accessibility: 'unknown' }),
    state({ screen: 'missing' }, { family: 'windows' }),
    state({ screen: 'missing', accessibility: 'missing' }, { screen: false, control: false }),
    // Read-only mode turns Control off, so Accessibility is not needed.
    state({ accessibility: 'missing', grantedBefore: { screen: false, accessibility: true } }, { readOnly: true }),
    state(null)
  ]) {
    notice.hidden = false;
    paintDesktopAccessNotice(next, actions);
    expect(notice.hidden).toBe(true);
  }
  expect(desktopAccessProblem(state({ screen: 'missing', accessibility: 'missing', grantedBefore: { screen: false, accessibility: true } }, { readOnly: true })))
    .toEqual({ screen: true, accessibility: false, missing: true, stale: false });
});
