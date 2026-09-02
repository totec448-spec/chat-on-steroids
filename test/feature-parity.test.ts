import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/main/config.js';
import { surfaceDefinition, surfaceIsUseful } from '../src/main/mcp/surfaces.js';
import { browserExtensionRequired } from '../src/shared/types.js';

describe('portable browser-backed feature parity', () => {
  it.each(['win32', 'darwin', 'linux'] as const)(
    'keeps sessions, compaction, Goal and multi-agent policy platform-invariant on %s',
    (platform) => {
      const config = defaultConfig(platform);
      const windows = defaultConfig('win32');

      expect(surfaceIsUseful('core', config.capabilities, platform)).toBe(true);
      expect(config.sessions.record).toBe(true);
      expect(config.compaction.auto).toBe(true);
      expect(config.compaction.autoTokens).toBe(config.sessions.advisoryTokens);
      // Goal is intentionally off until the user opts in and supplies a key, but that policy is
      // identical on every host. Its only product dependency is recording, not Windows/Desktop.
      expect(config.goal).toEqual(windows.goal);
      expect(config.goal.enabled).toBe(false);
      expect(config.multiAgent).toEqual({
        enabled: true,
        maxWorkers: 2,
        allowUnattributedCalls: true,
        recoverAgentTabs: false
      });
      expect(browserExtensionRequired(config)).toBe(true);
    }
  );

  it('keeps the bridge required for either independently viable browser feature', () => {
    const config = defaultConfig('darwin');

    expect(
      browserExtensionRequired({
        sessions: { ...config.sessions, record: false },
        multiAgent: { ...config.multiAgent, enabled: true }
      })
    ).toBe(true);
    expect(
      browserExtensionRequired({
        sessions: { ...config.sessions, record: true },
        multiAgent: { ...config.multiAgent, enabled: false }
      })
    ).toBe(true);
    expect(
      browserExtensionRequired({
        sessions: { ...config.sessions, record: false },
        multiAgent: { ...config.multiAgent, enabled: false }
      })
    ).toBe(false);
  });

  it('ships the complete Core/browser product plus native Desktop automation on macOS', () => {
    // Model the oldest supported Desktop host explicitly. The real-host projection is
    // intentionally false on macOS 12.0-12.2, and this policy test must not depend on the
    // Darwin release of the machine running Vitest.
    const config = defaultConfig('darwin', '21.4.0');
    expect(surfaceDefinition('core').tools).toEqual([
      'read',
      'view_image',
      'find',
      'apply_patch',
      'exec_command',
      'write_stdin',
      'session',
      'agents'
    ]);
    expect(surfaceIsUseful('core', config.capabilities, 'darwin')).toBe(true);
    // Fresh macOS installs start the Desktop group off; the surface exists once it is switched on.
    expect(surfaceIsUseful('desktop', config.capabilities, 'darwin')).toBe(false);
    const switchedOn = { ...config.capabilities, screen: true, control: true };
    expect(surfaceIsUseful('desktop', switchedOn, 'darwin', '21.4.0')).toBe(true);

    const manifest = JSON.parse(
      readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8')
    ) as { host_permissions?: string[] };
    expect(manifest.host_permissions).toEqual(
      expect.arrayContaining([
        'https://chatgpt.com/*',
        'http://127.0.0.1:8765/*',
        'http://127.0.0.1:8766/*',
        'http://127.0.0.1:8767/*',
        'http://127.0.0.1:8768/*',
        'http://127.0.0.1:8769/*'
      ])
    );
  });
});
