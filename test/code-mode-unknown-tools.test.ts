import { beforeEach, expect, it, vi } from 'vitest';

const tunnel = vi.hoisted(() => ({ tunnelId: 'core-id', desktopTunnelId: 'desktop-id', pluginsTunnelId: 'plugins-id' }));
vi.mock('../src/main/config.js', async original => {
  const real = await original<typeof import('../src/main/config.js')>();
  return { ...real, getConfig: () => ({ ...real.defaultConfig(), tunnel: { ...real.defaultConfig().tunnel, ...tunnel } }) };
});
const { unknownToolNote, unknownToolReferences } = await import('../src/main/mcp/code-mode-tool.js');

beforeEach(() => { Object.assign(tunnel, { tunnelId: 'core-id', desktopTunnelId: 'desktop-id', pluginsTunnelId: 'plugins-id' }); });

it('finds the tools a script uses that this connector lacks, dotted, optional or quoted', () => {
  const code = 'await tools.exec_command({cmd:"ls"}); await tools["view_image"]({}); await tools.update_plan?.({}); await tools.memory_read({}); text(ALL_TOOLS)';
  expect(unknownToolReferences(code, ['memory_read'])).toEqual(['exec_command', 'view_image', 'update_plan']);
  expect(unknownToolReferences('await tools.memory_read({})', ['memory_read'])).toEqual([]);
  // Checking for a tool is not calling it.
  expect(unknownToolReferences('text(typeof tools.exec_command); if (tools["view_image"]) {}', [])).toEqual([]);
});

it('names the connector a Core tool belongs to (#1287)', () => {
  const note = unknownToolNote('plugins', ['exec_command', 'made_up']);
  expect(note).toContain('tools.exec_command (a Chat On Steroids Core tool), tools.made_up');
  expect(note).toContain('which Chat On Steroids Plugins does not offer');
  expect(note).toContain('"not a function"');
  expect(note).not.toContain('Secure Tunnel ID');
});

it('says when the connector shares its Secure Tunnel ID with another (#1287)', () => {
  tunnel.pluginsTunnelId = 'core-id';
  const note = unknownToolNote('plugins', ['exec_command']);
  expect(note).toContain('Chat On Steroids Plugins shares its Secure Tunnel ID with Chat On Steroids Core');
  expect(note).toContain('Give each connector its own tunnel ID in Setup.');
  tunnel.pluginsTunnelId = '';
  expect(unknownToolNote('plugins', ['exec_command'])).not.toContain('Secure Tunnel ID');
});
