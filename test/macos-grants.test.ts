import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { MACOS_BUNDLE_ID, noteMacOSGrants, repairMacOSPermissions, resetMacOSPermissions } from '../src/main/computer/macos-grants.js';
import { makeTempDir, removeTempDir } from './helpers.js';

/**
 * Live 2026-10-15: after installing an unsigned build, Settings reported Screen Recording and
 * Accessibility missing while System Settings still showed both switched on. macOS ties these
 * grants to the code signature, and an ad-hoc signed update is a new app to it. The app remembers
 * that a permission was granted once, so it can say what happened and repair it.
 */
let directory = '';
beforeEach(async () => { resetDurableForTests(); directory = await makeTempDir(); initDurableStore(directory); });
afterEach(async () => { resetDurableForTests(); await removeTempDir(directory); });

it('remembers each permission once it was granted, across restarts', async () => {
  expect(await noteMacOSGrants({ screen: 'missing', accessibility: 'missing' })).toEqual({ screen: false, accessibility: false });
  expect(await noteMacOSGrants({ screen: 'granted', accessibility: 'unknown' })).toEqual({ screen: true, accessibility: false });
  resetDurableForTests(); initDurableStore(directory);
  expect(await noteMacOSGrants({ screen: 'missing', accessibility: 'granted' })).toEqual({ screen: true, accessibility: true });
  expect(await noteMacOSGrants({ screen: 'missing', accessibility: 'missing' })).toEqual({ screen: true, accessibility: true });
});

it('resets only the named permissions, for this app only', async () => {
  const run = vi.fn(async () => undefined);
  await resetMacOSPermissions(['accessibility'], run);
  expect(run.mock.calls).toEqual([['/usr/bin/tccutil', ['reset', 'Accessibility', MACOS_BUNDLE_ID]]]);
  run.mockClear();
  await resetMacOSPermissions(['screen', 'accessibility'], run);
  expect(run.mock.calls).toEqual([
    ['/usr/bin/tccutil', ['reset', 'ScreenCapture', MACOS_BUNDLE_ID]],
    ['/usr/bin/tccutil', ['reset', 'Accessibility', MACOS_BUNDLE_ID]]
  ]);
});

it('names the bundle the packaged app is built with', () => {
  const builder = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');
  expect(builder.split(/\r?\n/)).toContain(`appId: ${MACOS_BUNDLE_ID}`);
});

it('repairs only what is missing: resets it, then makes macOS ask for exactly that again', async () => {
  const steps: string[] = [];
  const deps = {
    reset: async (permissions: readonly string[]) => { steps.push(`reset ${permissions.join('+')}`); },
    requestScreen: async () => { steps.push('ask screen'); },
    refresh: async (options: { promptAccessibility: boolean }) => { steps.push(`refresh prompt=${options.promptAccessibility}`); }
  };
  expect(await repairMacOSPermissions({ screen: 'missing', accessibility: 'granted' }, deps)).toEqual(['screen']);
  expect(steps).toEqual(['reset screen', 'ask screen', 'refresh prompt=false']);
  steps.length = 0;
  expect(await repairMacOSPermissions({ screen: 'missing', accessibility: 'missing' }, deps)).toEqual(['screen', 'accessibility']);
  expect(steps).toEqual(['reset screen+accessibility', 'ask screen', 'refresh prompt=true']);
  steps.length = 0;
  // Nothing missing, or nothing known: nothing is reset.
  expect(await repairMacOSPermissions({ screen: 'granted', accessibility: 'unknown' }, deps)).toEqual([]);
  expect(steps).toEqual(['refresh prompt=false']);
});

it('tells a diagnostics reader that a missing permission was granted to an earlier version', async () => {
  const { describeMacOSDesktopAccess } = await import('../src/main/diagnostics.js');
  const checks = describeMacOSDesktopAccess(
    { screen: 'missing', accessibility: 'missing', checkedAt: 1, error: null, grantedBefore: { screen: true, accessibility: false } },
    { screen: true, control: true }
  );
  expect(checks.map(check => [check.name, check.status])).toEqual([['macOS Screen Recording', 'fail'], ['macOS Accessibility', 'fail']]);
  expect(checks[0]!.detail).toContain('granted to an earlier version');
  expect(checks[1]!.detail).not.toContain('earlier version');
});
