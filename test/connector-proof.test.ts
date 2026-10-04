import { afterAll, beforeAll, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import {
  connectorProof,
  connectorProofWritten,
  connectorTunnelKey,
  initConnectorProofPath,
  loadConnectorProof,
  noteConnectorUse,
  notePluginInstalled
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
