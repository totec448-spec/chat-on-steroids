import { afterAll, beforeAll, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import {
  connectorProof,
  connectorProofWritten,
  connectorTunnelKey,
  initConnectorProofPath,
  loadConnectorProof,
  noteConnectorUse,
  notePluginInstalled,
  notePluginMissing
} from '../src/main/connector-proof.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;
const TUNNEL_A = 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TUNNEL_B = 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

beforeAll(async () => {
  dir = await makeTempDir('clf-proof-');
  initConfigPath(dir);
  initConnectorProofPath(dir);
});
afterAll(async () => { await removeTempDir(dir); });

async function useTunnel(tunnelId: string): Promise<void> {
  const config = defaultConfig();
  await saveConfig({ ...config, tunnel: { ...config.tunnel, kind: 'openai', tunnelId } });
}

it('keeps the proof that ChatGPT used a connector across a restart', async () => {
  await useTunnel(TUNNEL_A);
  await loadConnectorProof();
  expect(connectorProof('core')).toBeNull();

  noteConnectorUse('core', 'tool', 1_000);
  await connectorProofWritten();
  // A restart: only what reached the disk is known.
  await loadConnectorProof();
  // Running a tool means ChatGPT reached the connector too.
  expect(connectorProof('core')).toEqual({ requestAt: 1_000, toolCallAt: 1_000, installedAt: null });
  expect(connectorProof('desktop')).toBeNull();
});

it('reports no proof for a tunnel the plugin was never used through', async () => {
  await useTunnel(TUNNEL_A);
  // An hour later: newer evidence than the file holds by more than its refresh interval.
  noteConnectorUse('core', 'request', 3_601_000);
  await connectorProofWritten();
  // A new tunnel is a new plugin to create in ChatGPT: yesterday's proof is about the old one.
  await useTunnel(TUNNEL_B);
  await loadConnectorProof();
  expect(connectorProof('core')).toBeNull();
  await useTunnel(TUNNEL_A);
  expect(connectorProof('core')?.requestAt).toBe(3_601_000);
});

it('keeps nothing for a tunnel whose address changes every run', () => {
  const config = defaultConfig();
  expect(connectorTunnelKey({ tunnel: { ...config.tunnel, kind: 'cloudflared' } }, 'core')).toBeNull();
  expect(connectorTunnelKey({ tunnel: { ...config.tunnel, kind: 'openai', tunnelId: '' } }, 'core')).toBeNull();
  expect(connectorTunnelKey({ tunnel: { ...config.tunnel, kind: 'openai', tunnelId: TUNNEL_A, desktopTunnelId: TUNNEL_B } }, 'desktop'))
    .toContain(TUNNEL_B);
});

it('keys the Plugins connector to its own tunnel, not Core\'s', () => {
  // Plugins runs on its own Secure Tunnel ID. Keyed to Core's, its proof would survive a change
  // of the Plugins tunnel and vanish with a change of Core's.
  const config = defaultConfig();
  const tunnel = { ...config.tunnel, kind: 'openai' as const, tunnelId: TUNNEL_A, pluginsTunnelId: TUNNEL_B };
  expect(connectorTunnelKey({ tunnel }, 'plugins')).toContain(TUNNEL_B);
  expect(connectorTunnelKey({ tunnel }, 'plugins')).not.toContain(TUNNEL_A);
  expect(connectorTunnelKey({ tunnel: { ...tunnel, pluginsTunnelId: '' } }, 'plugins')).toBeNull();
});

it('keeps ChatGPT listing the plugin as proof it exists, before any call', async () => {
  await useTunnel(TUNNEL_B);
  await loadConnectorProof();
  expect(connectorProof('core')).toBeNull();
  notePluginInstalled('core', 5_000);
  // Seen again later: existence is a fact, not a clock to move.
  notePluginInstalled('core', 9_000);
  await connectorProofWritten();
  await loadConnectorProof();
  expect(connectorProof('core')).toEqual({ requestAt: null, toolCallAt: null, installedAt: 5_000 });
});

it('takes the proof back when ChatGPT\'s plugins list no longer names Core, and only Core\'s', async () => {
  const TUNNEL_C = 'tunnel_cccccccccccccccccccccccccccccccc';
  const config = defaultConfig();
  await saveConfig({ ...config, tunnel: { ...config.tunnel, kind: 'openai', tunnelId: TUNNEL_C, desktopTunnelId: 'tunnel_dddddddddddddddddddddddddddddddd' } });
  await loadConnectorProof();
  noteConnectorUse('core', 'tool', 1_000);
  notePluginInstalled('core', 2_000);
  noteConnectorUse('desktop', 'request', 3_000);
  expect(connectorProof('core')).not.toBeNull();
  // Deleted or disconnected in ChatGPT: what earlier runs saw no longer holds.
  notePluginMissing('core');
  expect(connectorProof('core')).toBeNull();
  expect(connectorProof('desktop')).toEqual({ requestAt: 3_000, toolCallAt: null, installedAt: null });
  await connectorProofWritten();
  await loadConnectorProof();
  expect(connectorProof('core')).toBeNull();
  // Created again: listed once more, the proof comes back.
  notePluginInstalled('core', 4_000);
  expect(connectorProof('core')).toEqual({ requestAt: null, toolCallAt: null, installedAt: 4_000 });
});
