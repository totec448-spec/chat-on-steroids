import { describe, expect, it } from 'vitest';
import { parseMacOSCodeIdentity } from '../src/main/computer/macos-access.js';
import { describeMacOSDesktopAccess } from '../src/main/diagnostics.js';
import type { MacOSDesktopAccessStatus } from '../src/shared/types.js';

const adhoc = (identifier: string, executable: string) => parseMacOSCodeIdentity(
  `Identifier=${identifier}\nflags=0x20002(adhoc,linker-signed)\nSignature=adhoc\nTeamIdentifier=not set\nCDHash=0123456789abcdef`,
  executable
);

describe('macOS Desktop TCC identity guidance', () => {
  it('classifies content-bound ad-hoc identities without inventing a team', () => {
    expect(adhoc('macos-desktop-helper', '/tmp/macos-desktop-helper')).toEqual({
      executable: 'macos-desktop-helper',
      identifier: 'macos-desktop-helper',
      teamIdentifier: null,
      signingMode: 'adhoc',
      cdhash: '0123456789abcdef'
    });
  });

  it('recognises a trust-bearing signing identity', () => {
    const identity = parseMacOSCodeIdentity(
      'Identifier=com.chatonsteroids.app\nSignature size=9000\nAuthority=Chat On Steroids Development\nTeamIdentifier=LOCALTEAM\nCDHash=fedcba9876543210',
      '/Applications/Chat On Steroids.app/Contents/MacOS/Chat On Steroids'
    );
    expect(identity.signingMode).toBe('signed');
    expect(identity.teamIdentifier).toBe('LOCALTEAM');
    expect(identity.cdhash).toBe('fedcba9876543210');
  });

  it('explains why an enabled row can be stale for the current helper', () => {
    const access: MacOSDesktopAccessStatus = {
      screen: 'granted',
      accessibility: 'missing',
      parentPermissions: { screen: 'granted', accessibility: 'missing' },
      backendPermissions: { screen: 'granted', accessibility: 'missing' },
      parent: adhoc('Electron', '/tmp/Chat On Steroids'),
      backend: adhoc('macos-desktop-addon', '/tmp/macos-desktop-addon.node'),
      rebuildMayInvalidateAuthorization: true,
      checkedAt: 1,
      error: null
    };
    const checks = describeMacOSDesktopAccess(access, { screen: true, control: true });
    expect(checks.map((check) => [check.name, check.status])).toEqual([
      ['macOS Screen Recording', 'pass'],
      ['macOS Accessibility', 'fail']
    ]);
    expect(checks[1]?.detail).toContain('enabled System Settings row attached to an older binary');
    expect(checks[1]?.detail).toContain('parent Electron (adhoc, cdhash');
    expect(checks[1]?.detail).toContain('backend macos-desktop-addon (adhoc, cdhash');
    expect(checks[1]?.detail).toContain('cdhash 0123456789ab');
  });

  it('does not invent an Accessibility requirement for screenshot-only use', () => {
    const access: MacOSDesktopAccessStatus = {
      screen: 'granted',
      accessibility: 'missing',
      parentPermissions: { screen: 'granted', accessibility: 'missing' },
      backendPermissions: { screen: 'granted', accessibility: 'missing' },
      parent: adhoc('Electron', '/tmp/Chat On Steroids'),
      backend: adhoc('macos-desktop-addon', '/tmp/macos-desktop-addon.node'),
      rebuildMayInvalidateAuthorization: true,
      checkedAt: 1,
      error: null
    };
    expect(describeMacOSDesktopAccess(access, { screen: true, control: false })).toHaveLength(1);
  });
});
