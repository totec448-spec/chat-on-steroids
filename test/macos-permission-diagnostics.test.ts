import { describe, expect, it } from 'vitest';
import { describeMacOSDesktopAccess } from '../src/main/diagnostics.js';

describe('macOS permission diagnostic evidence', () => {
  it('reports preflight success without claiming a capture or control operation was tested', () => {
    const checks = describeMacOSDesktopAccess({ screen: 'granted', accessibility: 'granted', checkedAt: 1, error: null }, { screen: true, control: true });
    expect(checks).toHaveLength(2);
    for (const check of checks) {
      expect(check).toMatchObject({ status: 'pass', ok: true });
      expect(check.detail).toContain('preflight passed');
      expect(check.detail).toContain('have not been tested');
    }
  });

  it('keeps missing and unknown distinct and points at the current installed app', () => {
    const checks = describeMacOSDesktopAccess({ screen: 'missing', accessibility: 'unknown', checkedAt: 1, error: 'backend unavailable' }, { screen: true, control: true });
    expect(checks[0]).toMatchObject({ status: 'fail', ok: false });
    expect(checks[0]!.detail).toContain('preflight did not pass');
    expect(checks[0]!.detail).toContain('this installed Chat On Steroids.app');
    expect(checks[1]).toMatchObject({ status: 'not-run', ok: null, detail: 'backend unavailable' });
    expect(describeMacOSDesktopAccess(null, { screen: false, control: false })).toEqual([]);
  });
});
