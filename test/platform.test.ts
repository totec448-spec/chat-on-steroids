import { describe, expect, it } from 'vitest';
import { defaultConfig, effectiveCapabilities } from '../src/main/config.js';
import { capabilitiesForPlatform, desktopAutomationSupported, hostPlatformInfo } from '../src/main/platform.js';
import { surfaceIsUseful } from '../src/main/mcp/surfaces.js';
import { serverInstructions } from '../src/main/mcp/instructions.js';
import { unifiedExecEnvForPlatform } from '../src/main/codex/unified-exec-constants.js';
import type { Capabilities } from '../src/shared/types.js';

const allCapabilities = (): Capabilities => ({
  browse: true,
  search: true,
  read: true,
  metadata: true,
  create: true,
  edit: true,
  move: true,
  deleteFile: true,
  command: true,
  screen: true,
  control: true,
  clipboardRead: true,
  clipboardWrite: true
});

describe('cross-platform product surface', () => {
  it.each(['darwin', 'linux'] as const)('keeps Core fully usable while omitting Desktop on %s', (platform) => {
    const config = defaultConfig(platform);
    expect(config.capabilities).toMatchObject({
      browse: true,
      search: true,
      read: true,
      metadata: true,
      create: true,
      edit: true,
      move: true,
      deleteFile: true,
      command: true,
      screen: false,
      control: false,
      clipboardRead: false,
      clipboardWrite: false
    });
    expect(surfaceIsUseful('core', config.capabilities, platform)).toBe(true);
    expect(surfaceIsUseful('desktop', allCapabilities(), platform)).toBe(false);
  });

  it('masks stored Windows Desktop grants at runtime without deleting the stored choices', () => {
    const stored = allCapabilities();
    const config = { ...defaultConfig('linux'), capabilities: stored };
    const live = effectiveCapabilities(config, 'linux');

    expect(live.screen).toBe(false);
    expect(live.control).toBe(false);
    expect(live.clipboardRead).toBe(false);
    expect(live.clipboardWrite).toBe(false);
    expect(live.command).toBe(true);
    expect(config.capabilities).toBe(stored);
    expect(config.capabilities.screen).toBe(true);
  });

  it('reports the host family and Desktop support explicitly', () => {
    expect(hostPlatformInfo('win32')).toEqual({ family: 'windows', name: 'Windows', desktopAutomation: true });
    expect(hostPlatformInfo('darwin')).toEqual({ family: 'macos', name: 'macOS', desktopAutomation: false });
    expect(hostPlatformInfo('linux')).toEqual({ family: 'linux', name: 'Linux', desktopAutomation: false });
    expect(desktopAutomationSupported('freebsd')).toBe(false);
    expect(capabilitiesForPlatform(allCapabilities(), 'win32')).toEqual(allCapabilities());
  });

  it.each(['darwin', 'linux'] as const)('teaches POSIX shell semantics instead of Windows guidance on %s', (platform) => {
    const instructions = serverInstructions(
      {
        roots: [],
        caps: allCapabilities(),
        readOnly: false,
        sessionTools: false,
        agentTools: false
      },
      'core',
      platform
    );

    expect(instructions).toContain(platform === 'darwin' ? 'Local macOS coding bridge' : 'Local Linux coding bridge');
    expect(instructions).toContain('normal POSIX shell');
    expect(instructions).not.toMatch(/PowerShell|Get-ChildItem|Windows desktop|Native Windows paths/);
    expect(instructions).not.toContain('Chat On Steroids Desktop');
  });

  it('retains the Windows-specific shell guidance on Windows', () => {
    const instructions = serverInstructions(
      { roots: [], caps: allCapabilities(), readOnly: false, sessionTools: false, agentTools: false },
      'core',
      'win32'
    );
    expect(instructions).toContain('Local Windows coding bridge');
    expect(instructions).toContain('PowerShell does not expand');
    expect(instructions).toContain('Chat On Steroids Desktop');
  });

  it('uses a UTF-8 locale name native to each POSIX host', () => {
    const environment = (platform: NodeJS.Platform) => new Map(unifiedExecEnvForPlatform(platform));
    expect(environment('linux').get('LC_ALL')).toBe('C.UTF-8');
    expect(environment('darwin').get('LC_ALL')).toBe('en_US.UTF-8');
  });
});
