import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectorName, connectorNames, normalizeConnectorSuffix } from '../src/shared/connector-names.js';
import { defaultConfig, getConfig, initConfigPath, loadConfig, saveConfig } from '../src/main/config.js';
import { SURFACE_IDS, configuredConnectorName, liveConnectorName, surfaceDefinition } from '../src/main/mcp/surfaces.js';
import { noteAppSightings, noteServedRequest, resetConnectorIdentityForTests } from '../src/main/connector-identity.js';
import { makeTempDir, removeTempDir } from './helpers.js';

// One ChatGPT account on two computers needs two sets of connectors with different names. ChatGPT
// records every call under the exact name typed (measured 2026-10-04), so the suffix decides
// which computer's extension recognizes a call as its own.

describe('connector names', () => {
  it('keeps the plain names without a suffix', () => {
    expect(connectorNames()).toEqual({ core: 'Chat On Steroids Core', desktop: 'Chat On Steroids Desktop', plugins: 'Chat On Steroids Plugins' });
    expect(connectorNames('')).toEqual(connectorNames());
  });

  it('names this computer\'s set with its suffix in parentheses', () => {
    expect(connectorNames('Windows VM')).toEqual({
      core: 'Chat On Steroids Core (Windows VM)',
      desktop: 'Chat On Steroids Desktop (Windows VM)',
      plugins: 'Chat On Steroids Plugins (Windows VM)'
    });
    expect(connectorName('core', '  Büro   PC_2.0-a  ')).toBe('Chat On Steroids Core (Büro PC_2.0-a)');
  });

  it.each([
    ['parentheses', 'Win (VM)'], ['a slash', 'a/b'], ['quotes', '"Mac"'], ['an emoji', 'Mac 🖥'], ['too long', 'x'.repeat(33)],
    ['not a string', 42], ['null', null]
  ])('falls back to the plain names for %s', (_case, value) => {
    expect(normalizeConnectorSuffix(value)).toBe('');
    expect(connectorName('core', value)).toBe('Chat On Steroids Core');
  });
});

describe('the configured suffix', () => {
  let dir: string;
  beforeAll(async () => { dir = await makeTempDir('cos-connector-names-'); initConfigPath(dir); });
  afterAll(async () => { await removeTempDir(dir); });

  it('round-trips, and a damaged stored value keeps the plain names instead of failing the file', async () => {
    await saveConfig({ ...defaultConfig(), connectorSuffix: 'Windows' });
    expect((await loadConfig()).connectorSuffix).toBe('Windows');
    const stored = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ ...stored, connectorSuffix: 'Win/(VM)', readOnly: true }), 'utf8');
    const loaded = await loadConfig();
    expect(loaded.connectorSuffix).toBeUndefined();
    // The rest of the file still loads as written, not as a recovery default.
    expect(loaded.readOnly).toBe(true);
  });

  it('reaches every surface definition at once, without a restart', async () => {
    await saveConfig({ ...defaultConfig(), connectorSuffix: '' });
    await loadConfig();
    expect(SURFACE_IDS.map(id => surfaceDefinition(id).connectorName)).toEqual(Object.values(connectorNames()));
    await saveConfig({ ...getConfig(), connectorSuffix: 'Windows' });
    expect(SURFACE_IDS.map(id => surfaceDefinition(id).connectorName)).toEqual(Object.values(connectorNames('Windows')));
    // The plain definition table itself is never changed.
    await saveConfig({ ...getConfig(), connectorSuffix: '' });
    expect(surfaceDefinition('core').connectorName).toBe('Chat On Steroids Core');
  });
});

// 2026-10-11: ChatGPT keeps a renamed connector's app id. Once a served call proves the new name,
// model-facing text names the connector as ChatGPT shows it; what this app serves stays configured.
describe('a connector renamed in ChatGPT', () => {
  it('is named as ChatGPT shows it in model-facing text, while the configured name stays available', () => {
    resetConnectorIdentityForTests();
    const configured = configuredConnectorName('core');
    expect(surfaceDefinition('core').connectorName).toBe(configured);
    noteServedRequest('rename-proof', 'core');
    noteAppSightings([{ requestId: 'rename-proof', appId: 'asdk_app_x1', linkId: 'link_x1', appName: 'My tools' }]);
    expect(liveConnectorName('core')).toBe('My tools');
    expect(surfaceDefinition('core').connectorName).toBe('My tools');
    expect(configuredConnectorName('core')).toBe(configured);
    expect(surfaceDefinition('desktop').connectorName).toBe(configuredConnectorName('desktop'));
    resetConnectorIdentityForTests();
    expect(surfaceDefinition('core').connectorName).toBe(configured);
  });
});
