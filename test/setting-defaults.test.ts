import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { defaultConfig } from '../src/main/config.js';
import { changedSettings, paintSettingDefaults } from '../src/renderer/setting-defaults.js';
import type { Config } from '../src/shared/types.js';

let dom: JSDOM | undefined;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); });

/** The real Settings markup, with each control showing `config` as the page's apply() would. */
function page() {
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('Event', dom.window.Event);
  const doc = dom.window.document;
  const control = <T extends HTMLElement>(id: string) => doc.getElementById(id) as T;
  const row = (id: string) => control(id).closest<HTMLElement>('.setting')!;
  const reset = (id: string) => [...(control(id).closest('.setting')?.children ?? [])].find(child => child.classList.contains('setting-reset')) as HTMLButtonElement | undefined;
  const offered = (id: string) => reset(id) !== undefined && !reset(id)!.hidden;
  return { doc, control, row, reset, offered };
}

const fresh = (): Config => defaultConfig('win32');
const withUi = (ui: Partial<Config['ui']>): Config => ({ ...fresh(), ui: { ...fresh().ui, ...ui } });

it('marks nothing and offers no reset on a fresh install', () => {
  const view = page();
  expect(changedSettings(fresh(), fresh())).toEqual([]);
  paintSettingDefaults(fresh(), fresh(), view.doc);
  expect(view.doc.querySelectorAll('.setting.is-changed')).toHaveLength(0);
  expect([...view.doc.querySelectorAll<HTMLElement>('.setting-reset')].filter(button => !button.hidden)).toHaveLength(0);
});

it('marks both changed settings and resets only the one asked, through its own change', () => {
  const view = page();
  const config = withUi({ followOutput: false, keepAwake: true, keepScreenAwake: true });
  const follow = view.control<HTMLInputElement>('followOutput');
  const awake = view.control<HTMLSelectElement>('keepAwake');
  follow.checked = false;
  awake.value = 'screen';
  paintSettingDefaults(config, fresh(), view.doc);
  expect(changedSettings(config, fresh())).toEqual(['followOutput', 'keepAwake']);
  expect(view.row('followOutput').classList.contains('is-changed')).toBe(true);
  expect(view.row('keepAwake').classList.contains('is-changed')).toBe(true);
  expect(view.offered('followOutput') && view.offered('keepAwake')).toBe(true);
  expect(view.row('playfulStatus').classList.contains('is-changed')).toBe(false);

  const saved = vi.fn<(id: string) => void>();
  view.doc.addEventListener('change', event => saved((event.target as HTMLElement).id));
  // The reset sits in the row's <label>: the click must not also flip the switch back.
  view.reset('followOutput')!.click();
  expect(follow.checked).toBe(true);
  expect(awake.value).toBe('screen');
  expect(saved.mock.calls).toEqual([['followOutput']]);

  // The save lands and the page repaints from it: only the reset row loses its mark.
  paintSettingDefaults({ ...config, ui: { ...config.ui, followOutput: true } }, fresh(), view.doc);
  expect(view.row('followOutput').classList.contains('is-changed')).toBe(false);
  expect(view.offered('followOutput')).toBe(false);
  expect(view.row('keepAwake').classList.contains('is-changed')).toBe(true);

  view.reset('keepAwake')!.click();
  expect(awake.value).toBe('computer');
  expect(saved.mock.calls).toEqual([['followOutput'], ['keepAwake']]);
});

it('measures an older config against the fresh-install default and says so', () => {
  const view = page();
  // Configs from before automatic plugin refresh read Off; a new install starts On.
  const older = withUi({ autoRefreshPlugins: false, autoContinue: false });
  paintSettingDefaults(older, fresh(), view.doc);
  expect(changedSettings(older, fresh())).toEqual(['autoContinue', 'autoRefreshPlugins']);
  expect(view.reset('autoRefreshPlugins')!.title).toBe('Reset to the default for new installs');
  // Both resets show at once, so each names the setting it resets.
  expect(view.reset('autoRefreshPlugins')!.getAttribute('aria-label')).toBe('Reset Automatic plugin refresh to the default for new installs');
  expect(view.reset('autoContinue')!.getAttribute('aria-label')).toBe('Reset Automatically recover unfinished answers to the default for new installs');
  view.reset('autoRefreshPlugins')!.click();
  expect(view.control<HTMLInputElement>('autoRefreshPlugins').checked).toBe(true);
});

it('never offers paths, tunnel IDs or the language, and no reset on a control the page switched off', () => {
  const view = page();
  const base = fresh();
  const personal: Config = { ...base, tunnel: { ...base.tunnel, tunnelId: 'tunnel-placeholder', binaryPath: 'C:\\Users\\you\\tunnel.exe' },
    ui: { ...base.ui, language: 'de', browserBridgePort: 8767 } };
  expect(changedSettings(personal, base)).toEqual(['browserBridgePort']);
  const port = view.control<HTMLSelectElement>('browserBridgePort');
  port.disabled = true;
  paintSettingDefaults(personal, base, view.doc);
  expect(view.reset('tunnelId')).toBeUndefined();
  expect(view.row('uiLanguage').classList.contains('is-changed')).toBe(false);
  expect(view.row('browserBridgePort').classList.contains('is-changed')).toBe(true);
  expect(view.offered('browserBridgePort')).toBe(false);
});

it('marks the privacy, accessibility and Stop settings added since, each against its own default', () => {
  const view = page();
  // Hide secrets starts On; the other three start Off.
  const config = withUi({ secretsShield: false, announceTurns: true, finishHoldOnStop: true, rotateStopFallback: true });
  paintSettingDefaults(config, fresh(), view.doc);
  expect(changedSettings(config, fresh())).toEqual(['secretsShield', 'announceTurns', 'rotateStopFallback', 'finishHoldOnStop']);
  for (const id of ['secretsShield', 'announceTurns', 'rotateStopFallback', 'finishHoldOnStop']) expect(view.offered(id)).toBe(true);
  view.reset('secretsShield')!.click();
  expect(view.control<HTMLInputElement>('secretsShield').checked).toBe(true);
  view.reset('announceTurns')!.click();
  expect(view.control<HTMLInputElement>('announceTurns').checked).toBe(false);
});

it('keeps the keyboard on the row when the reset it was on goes away', () => {
  const view = page();
  const config = withUi({ followOutput: false });
  paintSettingDefaults(config, fresh(), view.doc);
  const button = view.reset('followOutput')!;
  button.focus();
  expect(view.doc.activeElement).toBe(button);
  paintSettingDefaults(fresh(), fresh(), view.doc);
  expect(button.hidden).toBe(true);
  expect(view.doc.activeElement).toBe(view.control('followOutput'));
});

it('puts the reset before its control in the DOM, so Tab and reading order match what is drawn', () => {
  const view = page();
  paintSettingDefaults(withUi({ followOutput: false, keepAwake: false }), fresh(), view.doc);
  for (const id of ['followOutput', 'keepAwake']) {
    const row = view.row(id);
    const children = [...row.children];
    expect(children.indexOf(view.reset(id)!)).toBe(children.indexOf(view.control(id)) - 1);
    expect(children.indexOf(row.querySelector('.setting-text')!)).toBeLessThan(children.indexOf(view.reset(id)!));
    // The row's <label> still names the control, not the button that now comes first.
    expect((row as HTMLLabelElement).control).toBe(view.control(id));
  }
  // A repaint keeps it there rather than adding a second button.
  paintSettingDefaults(withUi({ followOutput: false }), fresh(), view.doc);
  expect(view.row('followOutput').querySelectorAll('.setting-reset')).toHaveLength(1);
});
