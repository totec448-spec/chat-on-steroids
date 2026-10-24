/**
 * Canonical config.json files written by the app's own config module, through the same
 * schema parse and persist path a Settings save uses. The harvest setup captures each write.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const { defaultConfig, getConfig, initConfigPath, loadConfig, saveConfig } = await import('../../../../src/main/config.js');
const { defaultAppearance } = await import('../../../../src/shared/appearance.js');
const { makeTempDir, removeTempDir } = await import('../../../../test/helpers.js');

let dir: string;
beforeAll(async () => { dir = await makeTempDir('cos-types-config-'); });
afterAll(async () => { await removeTempDir(dir); });

it.each(['win32', 'darwin', 'linux'] as const)('writes the %s first-launch config', async (platform) => {
  const folder = path.join(dir, platform);
  initConfigPath(folder);
  const saved = await saveConfig(defaultConfig(platform));
  expect(saved.roots).toEqual([]);
});

it('writes the conservative recovery config for an unreadable file', async () => {
  const folder = path.join(dir, 'recovered');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'config.json'), '{"roots": 7}', 'utf8');
  initConfigPath(folder);
  const recovered = await loadConfig();
  expect(recovered.readOnly).toBe(true);
  await saveConfig(getConfig());
});

it('writes a config that sets every optional field', async () => {
  const folder = path.join(dir, 'full');
  initConfigPath(folder);
  const base = defaultConfig('win32');
  await saveConfig({
    ...base,
    connectorSuffix: 'Windows',
    setupProfiles: [{ id: 'work', name: 'Work', tunnelId: 'tunnel_0123456789abcdef0123456789abcdef', desktopTunnelId: '', pluginsTunnelId: '' }],
    roots: [{ name: 'project', path: path.join(folder, 'project') }],
    readOnly: true,
    commandAllowlist: { enabled: true, mode: 'deny', rules: ['git status', 'npm test *'] },
    tunnel: { profileId: 'default', profileName: 'Home', profileEpoch: 3, kind: 'openai', tunnelId: 'tunnel_fedcba9876543210fedcba9876543210', desktopTunnelId: 'tunnel_00000000000000000000000000000001', pluginsTunnelId: '', binaryPath: '' },
    ui: {
      ...base.ui, defaultChatModel: 'gpt-6', defaultChatReasoning: 'xhigh', browserOnly: true, backgroundPlacement: 'group',
      browserBridgePort: 8767, tabsToKeepOpen: 4, finishTool: true, planBackend: 'api', finishAction: 'goal', finishLeadMinutes: 4,
      developerMode: true, playfulStatus: true, language: 'pt-BR', lastSeenVersion: '2.1.35',
      browserPreferences: { overwrite: false, durations: true }, cosBrowserTrayHint: true, chatBrowser: 'brave', theme: 'light',
      appearance: { ...defaultAppearance(), font: 'mono', fontSize: 15 }
    },
    compaction: { ...base.compaction, handoffLength: 'short' },
    multiAgent: { ...base.multiAgent, defaultModel: 'gpt-6', defaultReasoning: '', globalMaxWorkers: 6 },
    goal: { ...base.goal, enabled: true, mode: 'loop', backend: 'api', provider: { kind: 'custom', baseUrl: 'http://localhost:11434/v1' }, reasoning: 'high', impulseMinutes: 15 },
    mcp: { instructions: 'Prefer small patches.' },
    controlApi: { enabled: true, allowActions: true }
  });
});
